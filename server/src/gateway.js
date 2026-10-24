import { resetMovementStream } from "./movement-stream.js";
import {
  PROTOCOL,
  decodeClient,
  protocolError,
} from "../../shared/protocol.js";
import { opaqueId, RateLimit } from "./auth.js";
import { logPrefix } from "../../shared/development-log.js";
import { Publications } from "./publication.js";
import { currentInteractionRevision } from "./interactions.js";
import { settleTransitionReady } from "./field-transition.js";
import { settleActorSkills, disposeActorSkills } from "./field-skills.js";

const HELLO_TIMEOUT_MS = 5000;
const PING_INTERVAL_MS = 15_000;
const PONG_TIMEOUT_MS = 30_000;
const LEASE_RENEW_MS = 15_000;
const MAX_PREAUTH_PER_ACCOUNT = 2;
const RETIRE_WAIT_ATTEMPTS = 3000;
const RETIRE_WAIT_MS = 10;

/** A lease cannot rotate while skill effects or their durable rewards are settling. */
function pendingSkillWork(actor, world) {
  return (
    actor.skillTask ||
    actor.skillField?.hasPendingIncoming ||
    actor.skillField?.rewardJobs.size ||
    actor.skillDrops?.pickpocketPlan ||
    world.participants.producedPending(actor.id)
  );
}

/** Socket/session epochs fence admission; PostgreSQL separately fences all writes. */
export class GameplayGateway {
  constructor({ config, auth, database, world }) {
    this.config = config;
    this.auth = auth;
    this.database = database;
    this.world = world;
    this.publications = new Publications(world);
    this.sockets = new Set();
    this.accounts = new Map();
    this.characters = new Map();
    this.joining = new Set();
    this.admissions = new Set();
    this.stopping = false;
    this.lastPrune = 0;
    this.auth.onRevoke = this.revoke.bind(this);
    this.handlers = {
      maxPayloadLength: PROTOCOL.MAX_MESSAGE_BYTES,
      backpressureLimit: 1024 * 1024,
      closeOnBackpressureLimit: true,
      idleTimeout: 35,
      perMessageDeflate: false,
      open: this.open.bind(this),
      message: this.message.bind(this),
      close: this.closed.bind(this),
      drain: this.drain.bind(this),
    };
  }

  /** Unique connected characters across all fields; grace-period actors are offline. */
  onlinePlayerCount() {
    let count = 0;
    // Character admission bounds this map by the world's actor capacity.
    for (const actor of this.characters.values()) {
      if (
        actor.connection &&
        !actor.connection.data.closed &&
        !actor.retiring
      ) {
        count++;
      }
    }
    return count;
  }

  upgrade(request, server, address) {
    if (this.stopping) throw protocolError("SERVER_BUSY");
    this.auth.origin(request);
    const session = this.auth.session(request);
    if (
      new URL(request.url).search ||
      request.headers.get("sec-websocket-protocol") !== PROTOCOL.SUBPROTOCOL
    ) {
      throw protocolError("PROTOCOL_MISMATCH");
    }
    if (this.sockets.size >= this.config.maxConnections) {
      throw protocolError("SERVER_BUSY");
    }
    let unauthenticated = 0;
    for (const socket of this.sockets) {
      if (
        socket.data.session.accountId === session.accountId &&
        !socket.data.actor
      ) {
        unauthenticated++;
      }
    }
    if (unauthenticated >= MAX_PREAUTH_PER_ACCOUNT) {
      throw protocolError("RATE_LIMITED");
    }
    const data = {
      session,
      address,
      epoch: opaqueId(),
      actor: null,
      closed: false,
      createdAt: Date.now(),
      helloPending: false,
      ready: false,
      sequence: 0,
      // Allow two seconds of normally paced input to arrive together after a
      // network stall. The sustained limit and field queue remain bounded.
      inputRate: new RateLimit(40, 80),
      commandRate: new RateLimit(12, 12),
      controlRate: new RateLimit(64, 128),
      devRate: new RateLimit(2, 4),
      baselines: new Map(),
      ackSnapshotId: null,
      ackEventSeq: 0,
      commandWork: 0,
      resyncAt: 0,
      pingAt: Date.now(),
      nonce: null,
      pongAt: Date.now(),
      pingMonotonic: null,
      roundTripMs: null,
      // A ping reports the preceding probe's RTT. Send three follow-ups so the
      // client's median has three measurements and rejects one loading stall.
      // Two measurements select the slower one until the 15-second heartbeat.
      warmupPings: 3,
    };
    if (
      !server.upgrade(request, {
        data,
        headers: { "Sec-WebSocket-Protocol": PROTOCOL.SUBPROTOCOL },
      })
    ) {
      throw protocolError("INVALID_MESSAGE");
    }
  }

  open(socket) {
    if (this.stopping) {
      this.publications.close(socket, "SERVER_BUSY");
      return;
    }
    this.sockets.add(socket);
    this.world.log?.("socket.open", {
      account: socket.data.session.accountId,
      role: socket.data.session.role,
    });
  }

  message(socket, bytes) {
    if (socket.data.closed) return;
    if (this.stopping) {
      this.publications.close(socket, "SERVER_BUSY");
      return;
    }
    try {
      if (!this.auth.active(socket.data.session)) {
        throw protocolError("SESSION_EXPIRED");
      }
      if (typeof bytes !== "string") throw protocolError("INVALID_MESSAGE");
      const message = decodeClient(bytes);
      if (!socket.data.actor) {
        if (message.type !== "hello" || socket.data.helloPending) {
          throw protocolError("INVALID_MESSAGE");
        }
        socket.data.helloPending = true;
        this.hello(socket, message).catch((error) => this.fail(socket, error));
        return;
      }
      if (this.admit(socket, message) !== false) this.dispatch(socket, message);
    } catch (error) {
      this.fail(socket, error);
    }
  }

  async hello(socket, message) {
    if (this.stopping || this.activation?.busy) {
      throw protocolError("SERVER_BUSY");
    }
    const session = socket.data.session;
    const characterId = this.auth.consumeTicket(session, message.ticket);
    if (!sameWorldIdentity(message, this.world.content)) {
      throw protocolError("CONTENT_MISMATCH");
    }
    if (this.joining.has(session.accountId)) {
      throw protocolError("CHARACTER_BUSY");
    }
    this.joining.add(session.accountId);
    try {
      const actor = await this.obtainActor(socket, characterId, message.resume);
      if (this.stopping) throw protocolError("SERVER_BUSY");
      if (socket.data.closed || !this.auth.active(session)) {
        if (!actor.connection) actor.disconnectedAt = Date.now();
        throw protocolError("SESSION_EXPIRED");
      }
      this.attach(socket, actor);
      this.welcome(socket, Boolean(message.resume));
      this.publications.snapshot(actor);
      this.ping(socket, Date.now());
      this.world.log?.("socket.attached", {
        character: actor.id,
        map: actor.field.mapId,
        instance: actor.field.id,
        status: message.resume ? "resumed" : "joined",
      });
    } finally {
      this.joining.delete(session.accountId);
    }
  }

  obtainActor(socket, characterId, resume) {
    if (this.stopping || this.admissions.size >= this.config.maxConnections) {
      return Promise.reject(protocolError("SERVER_BUSY"));
    }
    const task = this.acquireActor(socket, characterId, resume);
    this.admissions.add(task);
    const settled = () => this.admissions.delete(task);
    void task.then(settled, settled);
    return task;
  }

  async acquireActor(socket, characterId, resume) {
    const session = socket.data.session;
    const existing = this.accounts.get(session.accountId);
    if (existing) {
      return this.resumeActor(socket, existing, characterId, resume);
    }
    const actor = await this.database.acquireLease(
      session.accountId,
      characterId,
    );
    if (!actor) throw protocolError("NOT_FOUND");
    actor.role = session.role;
    actor.sessionId = session.id;
    actor.session = session;
    actor.playSession = opaqueId();
    actor.eventSeq = 0;
    actor.leaseRenewAt = Date.now();
    actor.disconnectedAt = Date.now();
    try {
      await this.world.join(actor);
      this.accounts.set(session.accountId, actor);
      this.characters.set(actor.id, actor);
      return actor;
    } catch (error) {
      try {
        if (session.revoked) {
          await this.world.prepareLogout(actor);
          await this.database.checkpoint(actor);
        }
      } finally {
        try {
          await this.database.releaseLease(actor);
        } finally {
          this.world.leave(actor);
        }
      }
      throw error;
    }
  }

  /** A resume must present the same live play session on the same account socket. */
  admitsResume(socket, actor, characterId, resume) {
    return !(
      !resume ||
      actor.id !== characterId ||
      resume.playSession !== actor.playSession ||
      actor.sessionId !== socket.data.session.id
    );
  }

  async resumeActor(socket, actor, characterId, resume) {
    if (!this.admitsResume(socket, actor, characterId, resume)) {
      throw protocolError("CHARACTER_BUSY");
    }
    if (
      actor.deliveryError ||
      actor.pending ||
      actor.retiring ||
      actor.renewing ||
      pendingSkillWork(actor, this.world)
    ) {
      throw protocolError("SERVER_BUSY");
    }
    if (resume.lastEventSeq > actor.eventSeq) {
      throw protocolError("INVALID_MESSAGE");
    }
    // The client owns its own position across the gap; adopt it before the snapshot
    // describes the field, so nothing snaps the player back on reconnect.
    this.world.adoptResumedMotion(actor, resume.motion ?? null);
    if (actor.connection) {
      this.publications.close(actor.connection, "STALE_CONNECTION");
    }
    actor.pending = true;
    actor.pendingOperation = null;
    actor.pendingOwner = null;
    try {
      await this.database.rotateLease(actor);
    } finally {
      actor.pending = false;
      this.world.participants.signalIdle();
    }
    return actor;
  }

  attach(socket, actor) {
    actor.connection = socket;
    actor.disconnectedAt = null;
    socket.data.actor = actor;
    socket.data.ready = false;
  }

  welcome(socket, resumed) {
    const actor = socket.data.actor;
    this.publications.send(socket, {
      type: "welcome",
      playSession: actor.playSession,
      fieldEpoch: actor.field.epoch,
      rulesHash: this.world.content.rulesHash,
      assetBuildId: this.world.content.assetBuildId,
      ...(this.world.content.worldContent
        ? { worldContentHash: this.world.content.worldContent.sha256 }
        : {}),
      serverTime: Date.now(),
      tickMs: PROTOCOL.TICK_MS,
      inputLeadTicks: PROTOCOL.INPUT_LEAD_TICKS,
      inputBufferTicks: PROTOCOL.INPUT_BUFFER_TICKS,
      resume: resumed ? "continued" : "snapshot",
      limits: {
        inputPerSecond: 40,
        commandPerSecond: 12,
        maxMessageBytes: PROTOCOL.MAX_MESSAGE_BYTES,
      },
    });
  }

  admit(socket, message) {
    const data = socket.data;
    if (
      message.type === "hello" ||
      message.connectionEpoch !== data.epoch ||
      data.actor.connection !== socket
    ) {
      throw protocolError("STALE_CONNECTION");
    }
    if (message.seq !== data.sequence + 1) {
      throw protocolError("INVALID_MESSAGE");
    }
    data.sequence = message.seq;
    if (
      !["input", "command"].includes(message.type) &&
      !data.controlRate.take()
    ) {
      throw protocolError("RATE_LIMITED");
    }
    return this.admitField(data, message);
  }

  drainsTransfer(data, message) {
    const transfer = data.transfer;
    if (!transfer) return false;
    // ACK has no fieldEpoch on the wire. Its known snapshot ID scopes it to
    // the retired source; old ACKs can arrive after commit or rollback.
    if (message.type !== "ack") {
      if (message.fieldEpoch !== transfer.sourceEpoch) return false;
      if (message.type === "input") return true;
    }
    const cursor = transfer.baselines.get(message.snapshotId);
    if (cursor === undefined) return false;
    if (message.type === "ready") return true;
    return (
      message.type === "ack" &&
      message.eventSeq >= cursor &&
      message.eventSeq <= data.actor.eventSeq
    );
  }

  admitField(data, message) {
    if (this.drainsTransfer(data, message)) return false;
    if (
      message.type !== "command" &&
      message.fieldEpoch !== undefined &&
      message.fieldEpoch !== data.actor.field.epoch
    ) {
      throw protocolError("STALE_FIELD");
    }
    if (
      !data.ready &&
      (message.type === "input" ||
        message.type === "combat.hits" ||
        (message.type === "command" && !data.transfer))
    ) {
      throw protocolError("NOT_ALLOWED");
    }
  }

  dispatch(socket, message) {
    switch (message.type) {
      case "input":
        return this.input(socket, message);
      case "combat.hits":
        return this.world.recordHits(socket.data.actor, message);
      case "command":
        return this.command(socket, message);
      case "ready":
        return this.ready(socket, message);
      case "transition-ready":
        return settleTransitionReady(this.world, socket.data.actor, message);
      case "ack":
        return this.publications.acknowledge(socket, message);
      case "resync":
        return this.resync(socket);
      case "pong":
        return this.pong(socket, message);
      default:
        throw protocolError("INVALID_MESSAGE");
    }
  }

  input(socket, message) {
    if (!socket.data.inputRate.take()) throw protocolError("RATE_LIMITED");
    this.world.input(socket.data.actor, message);
  }

  command(socket, message) {
    const physical =
      message.action.kind === "skill.release" ||
      message.action.kind === "skill.cancel";
    const rate = physical ? socket.data.controlRate : socket.data.commandRate;
    if (!rate.take()) throw protocolError("RATE_LIMITED");
    if (socket.data.commandWork >= 32) throw protocolError("SERVER_BUSY");
    socket.data.commandWork++;
    const actor = socket.data.actor;
    const started = performance.now();
    this.world
      .command(actor, message)
      .then((receipt) => {
        this.logCommand(actor, message, receipt, started);
        this.publications.publish(actor, {
          type: "result",
          operationId: message.operationId,
          status: receipt.status,
          code: receipt.code,
          domainRevision: receipt.domainRevision,
          transactionId: receipt.transactionId ?? null,
          value: receipt.value,
        });
      })
      .catch((error) => {
        this.logCommand(
          actor,
          message,
          { status: "rejected", code: error.code ?? "SERVER_BUSY" },
          started,
        );
        this.publications.publish(actor, {
          type: "result",
          operationId: message.operationId,
          status: "rejected",
          code: error.code ?? "SERVER_BUSY",
          domainRevision: currentInteractionRevision(
            actor,
            message.action,
            this.world,
          ),
          transactionId: null,
        });
      })
      .finally(() => {
        socket.data.commandWork--;
      });
  }

  logCommand(actor, message, receipt, started) {
    this.world.log?.("action.result", {
      character: actor.id,
      map: actor.field.mapId,
      operation: message.operationId,
      action: message.action.kind,
      status: receipt.status,
      code: receipt.code,
      ms: Math.round(performance.now() - started),
    });
  }

  ready(socket, message) {
    if (!socket.data.baselines.has(message.snapshotId)) {
      throw protocolError("INVALID_MESSAGE");
    }
    const becameReady = !socket.data.ready;
    socket.data.ready = true;
    socket.data.ackSnapshotId = message.snapshotId;
    socket.data.transfer = null;
    if (socket.data.actor.state === "preparing") {
      socket.data.actor.state = "active";
    }
    if (becameReady) {
      this.world.participants
        .publish([socket.data.actor.id])
        .catch((error) => this.fail(socket, error));
    }
  }

  resync(socket) {
    if (Date.now() - socket.data.resyncAt < 5000) {
      throw protocolError("RATE_LIMITED");
    }
    socket.data.resyncAt = Date.now();
    resetMovementStream(socket.data.actor);
    this.publications.snapshot(socket.data.actor);
  }

  pong(socket, message) {
    if (!socket.data.nonce || message.nonce !== socket.data.nonce) {
      throw protocolError("INVALID_MESSAGE");
    }
    socket.data.nonce = null;
    socket.data.pongAt = Date.now();
    socket.data.roundTripMs = Math.min(
      30_000,
      Math.max(0, Math.round(performance.now() - socket.data.pingMonotonic)),
    );
    if (socket.data.warmupPings > 0) {
      socket.data.warmupPings--;
      this.ping(socket, Date.now());
    }
  }

  fail(socket, error) {
    this.publications.close(socket, error.code ?? "SERVER_BUSY");
    if (!error.code) {
      console.error(
        logPrefix("server"),
        "Online gateway failure:",
        error.message,
      );
    }
  }

  closed(socket, code, reason) {
    this.world.log?.("socket.closed", {
      character: socket.data.actor?.id,
      code,
      reason,
    });
    socket.data.closed = true;
    this.sockets.delete(socket);
    const actor = socket.data.actor;
    if (actor?.connection !== socket) return;
    actor.connection = null;
    actor.disconnectedAt = Date.now();
    actor.transition?.ready?.(false);
    this.world.neutralize(actor);
  }

  drain(socket) {
    if (this.stopping) return;
    if (socket.data.needsSnapshot && socket.data.actor && !socket.data.closed) {
      socket.data.needsSnapshot = false;
      this.publications.publish(socket.data.actor, {
        type: "snapshot-request",
      });
    }
  }

  revoke(session) {
    for (const socket of this.sockets) {
      if (socket.data.session === session) {
        this.publications.close(socket, "SESSION_EXPIRED");
      }
    }
  }

  async logout(session) {
    const actor = this.accounts.get(session.accountId);
    if (actor?.sessionId === session.id) {
      await this.retire(actor);
    }
    // Admission can still be acquiring a lease or loading content when revoked.
    for (let attempt = 0; attempt < RETIRE_WAIT_ATTEMPTS; attempt++) {
      if (!this.joining.has(session.accountId)) break;
      await Bun.sleep(RETIRE_WAIT_MS);
    }
    if (this.joining.has(session.accountId)) throw protocolError("SERVER_BUSY");
  }

  maintain(now) {
    if (now - this.lastPrune < 1000) return;
    this.lastPrune = now;
    this.auth.prune();
    for (const socket of this.sockets) this.heartbeat(socket, now);
    for (const actor of this.characters.values()) {
      this.maintainActor(actor, now);
    }
  }

  heartbeat(socket, now) {
    if (!socket.data.actor && now - socket.data.createdAt > HELLO_TIMEOUT_MS) {
      return this.publications.close(socket, "UNAUTHENTICATED");
    }
    if (now - socket.data.pongAt > PONG_TIMEOUT_MS) {
      return this.publications.close(socket, "SESSION_EXPIRED");
    }
    if (
      !socket.data.actor ||
      now - socket.data.pingAt < PING_INTERVAL_MS ||
      socket.data.nonce
    ) {
      return;
    }
    this.ping(socket, now);
  }

  /** Calibrate on entry; later heartbeats retain their ordinary interval. */
  ping(socket, now) {
    socket.data.nonce = opaqueId();
    socket.data.pingAt = now;
    socket.data.pingMonotonic = performance.now();
    this.publications.send(socket, {
      type: "ping",
      nonce: socket.data.nonce,
      serverTime: now,
      roundTripMs: socket.data.roundTripMs,
    });
  }

  maintainActor(actor, now) {
    if (
      !actor.retirement &&
      (actor.retiring ||
        !this.auth.active(actor.session) ||
        (actor.deliveryError && !actor.pending) ||
        (actor.disconnectedAt !== null &&
          now - actor.disconnectedAt >= this.config.reconnectMs))
    ) {
      this.retire(actor).catch((error) =>
        console.error(
          logPrefix("server"),
          "Character retirement failed:",
          error.message,
        ),
      );
    }
    if (actor.retiring && !actor.settling) return;
    if (!actor.renewing && now - actor.leaseRenewAt >= LEASE_RENEW_MS) {
      actor.renewing = true;
      this.database
        .renewLease(actor)
        .then(() => {
          actor.leaseRenewAt = Date.now();
        })
        .catch((error) => {
          if (actor.connection) this.fail(actor.connection, error);
          this.retire(actor).catch((failure) =>
            console.error(
              logPrefix("server"),
              "Character retirement failed:",
              failure.message,
            ),
          );
        })
        .finally(() => {
          actor.renewing = false;
          this.world.participants.signalIdle();
        });
    }
  }

  retire(actor) {
    if (actor.retirement) return actor.retirement;
    actor.retiring = true;
    actor.settling = true;
    actor.state = "retiring";
    this.world.neutralize(actor);
    actor.transition?.ready?.(false);
    if (actor.skills) disposeActorSkills(actor);
    actor.retirement = this.finishRetirement(actor);
    return actor.retirement;
  }

  async finishRetirement(actor) {
    let failure;
    try {
      await settleActorSkills(actor);
    } catch (error) {
      failure = error;
    }
    actor.settling = false;
    try {
      await this.world.participants.waitIdle(actor);
      actor.pending = true;
      actor.pendingOperation = null;
      actor.pendingOwner = null;
      await this.world.prepareLogout(actor);
      await this.database.checkpoint(actor);
    } finally {
      try {
        await this.database.releaseLease(actor);
      } finally {
        actor.pending = false;
        this.world.leave(actor);
        this.accounts.delete(actor.accountId);
        this.characters.delete(actor.id);
        this.world.participants
          .publish([actor.id])
          .catch((error) =>
            console.error(
              logPrefix("server"),
              "Character departure publication failed:",
              error.message,
            ),
          );
      }
    }
    if (failure) throw failure;
  }

  async close() {
    this.stopping = true;
    let failure;
    for (const socket of this.sockets) {
      try {
        this.publications.close(socket, "SERVER_BUSY");
      } catch (error) {
        failure ??= error;
      }
    }
    // Admission is fenced before this fixed, connection-bounded snapshot. A join
    // may still install its leased actor; keep the world and database alive until
    // it settles, then include that actor in the ordinary retirement drain.
    await Promise.allSettled([...this.admissions]);
    for (const actor of [...this.characters.values()]) {
      try {
        await this.retire(actor);
      } catch (error) {
        failure ??= error;
      }
    }
    this.sockets.clear();
    if (failure) throw failure;
  }
}
import { sameWorldIdentity } from "../../shared/world-content.js";
