import {
  decodeClient,
  decodeServer,
  decodeJson,
  actionDomain,
  actionEphemeral,
  PROTOCOL,
} from "../../../shared/protocol.js";
import { MultipartAssembly } from "./transport-assembly.js";
import { freezeView, applyEntityChanges } from "./read-model.js";
import { ServerClock } from "./transport-clock.js";
import { validStartingStats } from "../../../shared/starting-stats.js";
import { resource } from "../rendering/stream-validation.js";
import { sameWorldIdentity } from "../../../shared/world-content.js";
import { InputJournal } from "./input-journal.js";
import { TransportPresentation } from "./transport-presentation.js";
import { TransportRecovery } from "./transport-recovery.js";

const HTTP_BYTES = 1024 * 1024;
const HTTP_TIMEOUT_MS = 10000;
const COMMAND_TIMEOUT_MS = 10000;
const HEARTBEAT_TIMEOUT_MS = 35000;
const RESYNC_INTERVAL_MS = 5000;
const MAX_QUEUE = 256;
const MAX_QUEUE_BYTES = 1024 * 1024;
const SEND_SOFT_BYTES = 256 * 1024;
const MAX_PENDING = 32;
const MAX_REPORTED_HITS = 32;
const INPUT_DRAIN_LIMIT = 4;
const INPUT_BURST = 40;
const MAX_PENDING_BYTES = 64 * 1024;
const GAMEPLAY_QUEUE_MS = 2000;
const ENTRY_BASELINE_AGE_MS = (PROTOCOL.INPUT_HISTORY * PROTOCOL.TICK_MS) / 2;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const encoder = new TextEncoder();

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/** The bootstrap document is closed: hashes, both CSRF tokens and the development flag. */
function validConfig(config) {
  return (
    config.v === 1 &&
    HASH.test(config.assetBuildId) &&
    HASH.test(config.rulesHash) &&
    HASH.test(config.catalogHash) &&
    typeof config.csrfToken === "string" &&
    typeof config.loginToken === "string" &&
    typeof config.development === "boolean"
  );
}

function requestHeaders(body, headers) {
  const merged = headers ?? {};
  if (body) merged["Content-Type"] = "application/json";
  return merged;
}

async function request(path, method = "GET", body, headers = null) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    headers: requestHeaders(body, headers),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (Number(response.headers.get("content-length")) > HTTP_BYTES) {
    throw failure("HTTP_BYTE_LIMIT");
  }
  const reader = response.body?.getReader();
  if (!reader) throw failure("EMPTY_HTTP_RESPONSE");
  const chunks = [];
  let length = 0;
  for (let count = 0; count < 4096; count++) {
    const chunk = await reader.read();
    if (chunk.done) {
      return decodeResponse(chunks, length, response.status, body?.operationId);
    }
    length += chunk.value.byteLength;
    if (length > HTTP_BYTES) break;
    chunks.push(chunk.value);
  }
  await reader.cancel();
  throw failure("HTTP_BYTE_LIMIT");
}

function decodeResponse(chunks, length, status, operationId) {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const value = decodeJson(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    { maxBytes: HTTP_BYTES, maxDepth: 16, maxNodes: 32768 },
  );
  const receipt =
    operationId &&
    value.operationId === operationId &&
    value.status === "rejected";
  if ((status < 200 || status >= 300) && !receipt) {
    const error = failure(
      typeof value.code === "string" ? value.code : "HTTP_REJECTED",
    );
    error.httpStatus = status;
    throw error;
  }
  return value;
}

/** Cookie-authenticated same-origin transport. All retained game state is observation-only. */
export class OnlineTransport {
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    this.initializeLifecycle();
    this.config = null;
    this.status = "disconnected";
    this.retryAfterMs = null;
    this.model = null;
    this.field = null;
    this.self = null;
    this.inventory = null;
    this.progress = null;
    this.revisions = {
      character: 0,
      inventory: 0,
      social: 0,
      conversation: 0,
      trade: 0,
      invitation: 0,
    };
    this.conversationId = null;
    this.characterId = null;
    this.characters = [];
    this.connectionEpoch = null;
    this.playSession = null;
    // Installed by the browser entry: reports the locally presented motion a resume
    // handshake should offer, or null when no simulation is installed.
    this.resumeMotion = null;
    this.serverTick = 0;
    this.lastEventSeq = 0;
    this.seq = 0;
    this.inputSeq = 0;
    this.initializeInputs();
    this.socket = null;
    this.pending = new Map();
    this.completed = new Map();

    this.pendingTravel = 0;
    this.queue = [];
    this.queueBytes = 0;
    this.deferred = [];
    this.deferredBytes = 0;
    this.draining = false;
    this.recovery = new TransportRecovery(this);
    this.baselines = new MultipartAssembly();
    this.shops = new MultipartAssembly();
    this.clock = new ServerClock();
    this.renderer = new TransportPresentation(this);
    this.presentationRetries = 0;
    this.lastMessageAt = 0;
    this.lastResyncAt = -Infinity;
    this.checkTimer = setInterval(this.check.bind(this), 250);
    this.blurHandler = this.neutral.bind(this);
    this.visibilityHandler = this.visibility.bind(this);
    globalThis.addEventListener?.("blur", this.blurHandler);
    globalThis.document?.addEventListener(
      "visibilitychange",
      this.visibilityHandler,
    );
  }

  initializeLifecycle() {
    this.closed = false;
    this.revoking = false;
    this.generation = 0;
    this.intentGeneration = 0;
    this.closingCode = null;
    this.lastFailure = null;
    this.transitionPhase = null;
    this.unresolvedReceipts = new Map();
  }

  async initialize(intent = null) {
    const config = await request("/api/v1/config");
    if (intent !== null) this.checkConnectIntent(intent);
    this.verifyCompiledIdentity(config);
    if (!validConfig(config)) throw failure("INVALID_CONFIG");
    if (config.worldContent) resource(config.worldContent);
    if (
      this.config &&
      (this.config.assetBuildId !== config.assetBuildId ||
        this.config.rulesHash !== config.rulesHash ||
        this.config.catalogHash !== config.catalogHash ||
        this.config.worldContent?.sha256 !== config.worldContent?.sha256)
    ) {
      throw failure("CONTENT_MISMATCH");
    }
    this.config = freezeView(config);
    return this.config;
  }

  verifyCompiledIdentity(config) {
    if (
      config.rulesHash !== import.meta.OPENMS_RULES_HASH ||
      config.assetBuildId !== import.meta.OPENMS_ASSET_BUILD_ID ||
      config.catalogHash !== import.meta.OPENMS_CATALOG_HASH
    ) {
      throw failure("CONTENT_MISMATCH");
    }
  }

  /** Submit a challenge-bound CSRF token once; a rejected proof may already be consumed. */
  async admitSession(path, { name, password, proof }) {
    return request(path, "POST", {
      name,
      password,
      csrfToken: proof.csrfToken,
      challengeId: proof.challengeId,
      nonce: proof.nonce,
    });
  }

  async login({ name, password, proof }) {
    const session = await this.admitSession("/api/v1/session", {
      name,
      password,
      proof,
    });
    this.adoptSession(session);
    return this.listCharacters();
  }

  /** Registration is proof-of-work gated like sign in; success signs the browser in. */
  async register({ name, password, proof }) {
    const session = await this.admitSession("/api/v1/accounts", {
      name,
      password,
      proof,
    });
    this.adoptSession(session);
    return this.listCharacters();
  }

  adoptSession(session) {
    if (
      typeof session.csrfToken !== "string" ||
      !["player", "developer"].includes(session.role) ||
      !Number.isSafeInteger(session.expiresAt)
    ) {
      throw failure("INVALID_SESSION");
    }
    this.recovery.cancel();
    this.intentGeneration++;
    this.unresolvedReceipts.clear();
    if (this.socket) this.disconnected("SESSION_REPLACED");
    this.config = freezeView({ ...this.config, ...session });
  }

  /** One bounded hashcash challenge per credential attempt. */
  async challenge() {
    const result = await request("/api/v1/challenge");
    if (
      typeof result.challengeId !== "string" ||
      typeof result.loginToken !== "string" ||
      !Number.isSafeInteger(result.bits) ||
      !Number.isSafeInteger(result.expiresAt)
    ) {
      throw failure("INVALID_CHALLENGE");
    }
    return freezeView(result);
  }

  /** Roll on the server; malformed responses cannot become a creation draft. */
  async rollCharacterStats() {
    const roll = await request("/api/v1/character-roll", "POST", {
      csrfToken: this.config.csrfToken,
    });
    if (
      !roll ||
      typeof roll.rollId !== "string" ||
      !ID.test(roll.rollId) ||
      !validStartingStats(roll)
    ) {
      throw failure("INVALID_MESSAGE");
    }
    return freezeView(roll);
  }

  /** Register one account-owned character with admitted stats, original look and starter gear. */
  async createCharacter(payload) {
    const result = await request("/api/v1/characters", "POST", {
      csrfToken: this.config.csrfToken,
      ...payload,
    });
    const character = result?.character;
    if (
      !character ||
      !ID.test(character.id) ||
      typeof character.name !== "string" ||
      !Number.isSafeInteger(character.level) ||
      !Number.isSafeInteger(character.job)
    ) {
      throw failure("INVALID_CHARACTER");
    }
    await this.listCharacters();
    return character;
  }

  /** Sign out the browser session; the account form owns the returned state. */
  async revoke() {
    if (!this.config || typeof this.config.csrfToken !== "string") return;
    this.recovery.cancel();
    this.intentGeneration++;
    this.revoking = true;
    let reason = "SIGNED_OUT";
    try {
      this.setStatus("signing-out");
      await request("/api/v1/session", "DELETE", null, {
        "x-csrf-token": this.config.csrfToken,
      });
      this.config = null;
      this.characters = [];
      this.characterId = null;
      this.playSession = null;
      this.model =
        this.field =
        this.self =
        this.inventory =
        this.progress =
          null;
      for (const pending of this.pending.values()) {
        const unknown = freezeView({
          status: "unknown",
          operationId: pending.fields.operationId,
        });
        pending.resolve(unknown);
        pending.recoverResolve?.(unknown);
      }
      this.pending.clear();
      this.unresolvedReceipts.clear();
      this.pendingTravel = 0;
      this.closingCode = null;
    } catch (error) {
      reason = error.code ?? "SIGN_OUT_FAILED";
      throw error;
    } finally {
      this.revoking = false;
      this.disconnected(reason);
    }
  }

  async listCharacters(intent = null) {
    const result = await request("/api/v1/characters");
    if (intent !== null) this.checkConnectIntent(intent);
    if (!Array.isArray(result.characters) || result.characters.length > 64) {
      throw failure("INVALID_CHARACTERS");
    }
    const ids = new Set();
    for (const character of result.characters) {
      if (
        !ID.test(character.id) ||
        ids.has(character.id) ||
        typeof character.name !== "string" ||
        !Number.isSafeInteger(character.level) ||
        !Number.isSafeInteger(character.job)
      ) {
        throw failure("INVALID_CHARACTERS");
      }
      ids.add(character.id);
    }
    this.characters = freezeView(result.characters);
    return this.characters;
  }

  /** Soft deletion on the server; the account's remaining characters come back fresh. */
  async deleteCharacter(characterId) {
    if (typeof characterId !== "string" || !ID.test(characterId)) {
      throw failure("INVALID_CHARACTER");
    }
    await request(`/api/v1/characters/${characterId}`, "DELETE", null, {
      "x-csrf-token": this.config.csrfToken,
    });
    return this.listCharacters();
  }

  /** Credentials are proof-of-work gated in login()/register(); entry needs only a character. */
  async connect({ characterId } = {}, recovery = null) {
    if (this.closed) throw failure("TRANSPORT_CLOSED");
    if (this.socket || this.status === "connecting") {
      throw failure("ALREADY_CONNECTED");
    }
    if (!recovery) this.recovery.cancel();
    const intent = ++this.intentGeneration;
    try {
      await this.initialize(intent);
      this.checkConnectIntent(intent, recovery);
      await this.listCharacters(intent);
      this.checkConnectIntent(intent, recovery);
      this.selectCharacter(characterId);
      return await this.open(intent);
    } catch (error) {
      if (!this.socket && intent === this.intentGeneration) {
        this.setStatus("disconnected", error.code ?? error.message);
      }
      throw error;
    }
  }

  checkConnectIntent(intent, recovery = null) {
    if (
      this.closed ||
      this.revoking ||
      intent !== this.intentGeneration ||
      (recovery && !this.recovery.owns(recovery))
    ) {
      throw failure("CANCELLED");
    }
  }

  selectCharacter(characterId) {
    const selected = characterId ?? this.characterId ?? this.characters[0]?.id;
    if (!this.characters.some((character) => character.id === selected)) {
      throw failure("CHARACTER_NOT_OWNED");
    }
    if (
      this.characterId &&
      this.characterId !== selected &&
      this.pending.size
    ) {
      throw failure("UNRESOLVED_OPERATIONS");
    }
    if (this.characterId !== selected) {
      this.unresolvedReceipts.clear();
      if (this.recovery.pending) {
        this.recovery.cancel();
        this.intentGeneration++;
      }
      this.playSession = null;
      this.lastEventSeq = 0;
      for (const domain of Object.keys(this.revisions)) {
        this.revisions[domain] = 0;
      }
    }
    this.characterId = selected;
  }

  async reconnect() {
    if (!this.characterId) throw failure("NO_CHARACTER");
    this.disconnect();
    return this.connect({ characterId: this.characterId });
  }

  async open(intent = this.intentGeneration) {
    const generation = ++this.generation;
    this.setStatus("connecting");
    const { ticket } = await request("/api/v1/play-ticket", "POST", {
      characterId: this.characterId,
      csrfToken: this.config.csrfToken,
    });
    this.checkConnectIntent(intent);
    if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw failure("INVALID_TICKET");
    if (generation !== this.generation || this.closed) {
      throw failure("CANCELLED");
    }
    const url = new URL("/api/v1/play", globalThis.location.href);
    if (
      url.protocol !== "https:" &&
      !(
        this.config.development &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )
    ) {
      throw failure("TLS_REQUIRED");
    }
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    this.resetConnection();
    const socket = new WebSocket(url, PROTOCOL.SUBPROTOCOL);
    this.socket = socket;
    this.lastMessageAt = performance.now();
    return new Promise((resolve, reject) => {
      this.openWaiter = {
        resolve,
        reject,
        deadline: performance.now() + HTTP_TIMEOUT_MS,
      };
      socket.addEventListener(
        "open",
        this.sendHello.bind(this, socket, ticket),
      );
      socket.addEventListener("message", (event) => {
        if (this.socket === socket) this.receive(event);
      });
      socket.addEventListener("close", (event) => {
        if (this.socket === socket) {
          this.disconnected(
            event.code === 1012 && event.reason === "RESYNC_REQUIRED"
              ? event.reason
              : "CONNECTION_LOST",
            { stage: "socket-close", closeCode: event.code },
          );
        }
      });
      socket.addEventListener("error", () => {
        if (this.socket === socket) this.fail(failure("SOCKET_ERROR"));
      });
    });
  }

  sendHello(socket, ticket) {
    if (this.socket !== socket) return;
    if (socket.protocol !== PROTOCOL.SUBPROTOCOL) {
      return this.fail(failure("PROTOCOL_MISMATCH"));
    }
    const hello = {
      v: 1,
      type: "hello",
      ticket,
      rulesHash: this.config.rulesHash,
      assetBuildId: this.config.assetBuildId,
      ...(this.config.worldContent
        ? { worldContentHash: this.config.worldContent.sha256 }
        : {}),
    };
    if (this.playSession) {
      const motion = this.resumeMotion?.() ?? null;
      hello.resume = {
        playSession: this.playSession,
        lastEventSeq: this.lastEventSeq,
        ...(motion ? { motion } : {}),
      };
    }
    try {
      socket.send(JSON.stringify(decodeClient(JSON.stringify(hello))));
    } catch (error) {
      this.fail(error, "hello");
    }
  }

  resetConnection() {
    this.inputJournal.clear();
    this.renderer.clear();
    this.presentationRecovery = false;
    this.presentationReady = false;
    this.presentationRetries = 0;
    this.seq = 0;
    this.lastInputTick = -1;
    this.nextCommandAt = 0;
    this.lastNeutralInputSeq = null;
    this.connectionEpoch = null;
    this.baselineId = null;
    this.baselines.clear();
    this.shops.clear();
    this.queue.length = 0;
    this.deferred.length = 0;
    this.deferredBytes = 0;
    this.queueBytes = 0;
    this.resyncing = false;
    this.expectedFieldEpoch = null;
    this.transitionPhase = null;
    this.clock.reset();
    this.lastResyncAt = -Infinity;
  }

  receive(event) {
    try {
      if (typeof event.data !== "string") throw failure("INVALID_MESSAGE");
      const bytes = encoder.encode(event.data).byteLength;
      const message = decodeServer(event.data);
      this.lastMessageAt = performance.now();
      const receivedAt = this.lastMessageAt;
      // A refused connection closes before any welcome; keep the server's code and hint.
      if (message.type === "closing") {
        this.closingCode = message.code;
        this.retryAfterMs = message.retryAfterMs;
      }
      if (message.type === "ping") {
        if (message.connectionEpoch !== this.connectionEpoch) {
          throw failure("STALE_CONNECTION");
        }
        this.send("pong", { nonce: message.nonce });
        this.timing(message, receivedAt, message.roundTripMs);
        return;
      }
      if (
        this.queue.length + this.deferred.length >= MAX_QUEUE ||
        this.queueBytes + this.deferredBytes + bytes > MAX_QUEUE_BYTES
      ) {
        throw failure("RECEIVE_BACKPRESSURE");
      }
      this.queue.push({ message, bytes, receivedAt });
      this.queueBytes += bytes;
      if (!this.draining) void this.drain();
    } catch (error) {
      this.fail(error, "receive");
    }
  }

  async drain() {
    this.draining = true;
    const generation = this.generation;
    try {
      for (let count = 0; count < MAX_QUEUE && this.queue.length; count++) {
        const entry = this.queue.shift();
        this.queueBytes -= entry.bytes;
        await this.accept(
          entry.message,
          entry.bytes,
          generation,
          entry.receivedAt,
        );
        if (generation !== this.generation) break;
      }
    } catch (error) {
      if (generation === this.generation) this.fail(error, "drain");
    } finally {
      this.draining = false;
    }
    if (this.queue.length && this.socket) queueMicrotask(this.drain.bind(this));
  }

  async accept(message, bytes, generation, receivedAt) {
    if (message.type === "welcome") return this.welcome(message, receivedAt);
    // A refused connection closes before any welcome; keep the server's own code and hint.
    if (message.type === "closing") {
      this.retryAfterMs = message.retryAfterMs;
      throw failure(message.code);
    }
    if (
      !this.connectionEpoch ||
      message.connectionEpoch !== this.connectionEpoch
    ) {
      throw failure("STALE_CONNECTION");
    }
    if (message.type === "snapshot") {
      this.installPart(message, bytes, generation);
      return;
    }
    if (this.baselines.pending) {
      // Peer motion is display-only and meaningless before a baseline installs; unlike the
      // local checkpoint it must not accumulate in the deferred buffer.
      if (message.type === "peers") return;
      this.deferred.push({ message, bytes, receivedAt });
      this.deferredBytes += bytes;
      return;
    }
    if (message.type === "motion") return this.motion(message, receivedAt);
    if (message.type === "peers") return this.peers(message);
    if (!this.admitPublication(message)) return;
    this.publishOrdered(message, bytes);
  }

  publishOrdered(message, bytes) {
    this.lastEventSeq = message.eventSeq;
    this.serverTick = Math.max(this.serverTick, message.serverTick);
    if (message.type === "state") this.state(message);
    else if (message.type === "event") this.event(message, bytes);
    else if (message.type === "result") this.result(message);
    else if (message.type === "transition") this.transition(message);
    this.ack();
  }

  motion(message, receivedAt) {
    if (message.fieldEpoch !== this.expectedFieldEpoch || this.resyncing) {
      return;
    }
    this.serverTick = Math.max(this.serverTick, message.serverTick);
    this.timing(message, receivedAt);
    const observed = freezeView(message);
    if (
      this.status === "active" &&
      this.renderer.fieldEpoch === message.fieldEpoch
    ) {
      // The installed simulation remains usable during same-field artwork refresh.
      // Retire prediction history and apply impulses without waiting for textures.
      this.callbacks.onMotion?.(observed);
    } else this.renderer.push("motion", observed);
  }

  /** The native move packet: an ordered-by-arrival, unacknowledged peer sample stream.
   *  It never gates the acked publication sequence and carries no durable state. */
  peers(message) {
    if (message.fieldEpoch !== this.expectedFieldEpoch || this.resyncing) {
      return;
    }
    this.serverTick = Math.max(this.serverTick, message.serverTick);
    const observed = freezeView(message);
    if (
      this.status === "active" &&
      this.renderer.fieldEpoch === message.fieldEpoch
    ) {
      this.callbacks.onPeers?.(observed);
    } else this.renderer.push("peers", observed);
  }

  /** Admit an ordered publication against the fully installed baseline, never partial parts. */
  admitPublication(message) {
    if (!this.baselineId || this.resyncing) return false;
    if (message.eventSeq !== this.lastEventSeq + 1) {
      this.resync("gap");
      return false;
    }
    if (
      (message.type === "state" || message.type === "event") &&
      message.fieldEpoch !== this.expectedFieldEpoch
    ) {
      throw failure("STALE_FIELD");
    }
    if (
      message.type === "state" &&
      message.baseSnapshotId !== this.baselineId
    ) {
      this.resync("baseline");
      return false;
    }
    return true;
  }

  welcome(message, receivedAt) {
    if (
      this.connectionEpoch ||
      !sameWorldIdentity(message, this.config) ||
      message.tickMs !== PROTOCOL.TICK_MS ||
      message.inputLeadTicks !== PROTOCOL.INPUT_LEAD_TICKS ||
      message.inputBufferTicks !== PROTOCOL.INPUT_BUFFER_TICKS
    ) {
      throw failure("CONTENT_MISMATCH");
    }
    if (
      message.limits.commandPerSecond < 1 ||
      message.limits.inputPerSecond < 1 ||
      message.limits.maxMessageBytes < 1
    ) {
      throw failure("INVALID_LIMITS");
    }
    this.connectionEpoch = message.connectionEpoch;
    if (this.playSession !== message.playSession) {
      this.inputSeq = 0;
      this.lastEventSeq = 0;
    }
    this.playSession = message.playSession;
    this.expectedFieldEpoch = message.fieldEpoch;
    this.serverTick = message.serverTick;
    this.limits = message.limits;
    if (this.openWaiter) {
      this.openWaiter.deadline = receivedAt + HTTP_TIMEOUT_MS;
    }
    // Hello includes lease acquisition and map loading, not just network latency.
    this.timing(message, receivedAt);
    this.setStatus("synchronizing");
  }

  timing(message, receivedAt, roundTripMs = null) {
    const timing = this.clock.observe({
      connectionEpoch: message.connectionEpoch,
      fieldEpoch: message.fieldEpoch,
      serverTick: message.serverTick,
      serverTime: message.serverTime,
      paused: message.paused ?? this.clock.paused,
      receivedAt,
      roundTripMs,
    });
    this.callbacks.onTiming?.(timing);
  }

  installPart(message, bytes, generation) {
    if (message.fieldEpoch !== this.expectedFieldEpoch) {
      throw failure("STALE_FIELD");
    }
    const model = this.baselines.add(message, bytes, performance.now());
    if (!model) return;
    if (this.baselineId && model.eventSeq <= this.lastEventSeq) {
      throw failure("STALE_SNAPSHOT");
    }
    // Joining peers and committed actions refresh this field's baseline. Keep
    // physical holds and native windows alive while replacing that state.
    // Initial entry, travel and explicit recovery still gate gameplay.
    if (
      this.status !== "active" ||
      this.model?.fieldEpoch !== model.fieldEpoch
    ) {
      this.setStatus("synchronizing");
    }
    const frozen = freezeView(model);
    if (generation !== this.generation) return;
    this.publishModel(frozen);
    this.restoreInteractionRevisions(frozen);
    this.releaseRetiredTravel();
    this.baselineId = model.snapshotId;
    this.baselineReceivedAt = performance.now();
    this.lastEventSeq = model.eventSeq;
    this.serverTick = model.serverTick;
    this.resyncing = false;
    this.ack();
    // Connection/snapshot reception succeeded. Asset preparation has its own bound.
    if (this.openWaiter) this.openWaiter.deadline = Infinity;
    this.presentationReady = true;
    this.renderer.push("snapshot", frozen);
    if (this.deferred.length) {
      this.queue.unshift(...this.deferred);
      this.queueBytes += this.deferredBytes;
      this.deferred.length = 0;
      this.deferredBytes = 0;
    }
    return this.renderer.task;
  }

  presentationIdle() {
    if (!this.socket || this.presentationRecovery || this.resyncing) return;
    if (
      !this.presentationReady ||
      this.renderer.fieldEpoch !== this.expectedFieldEpoch
    ) {
      return;
    }
    if (
      this.status !== "active" &&
      performance.now() - this.baselineReceivedAt > ENTRY_BASELINE_AGE_MS
    ) {
      // Assets may outlive the prediction history. Refresh the now-prepared scene
      // before allowing input, so recovery cannot clear the first held key.
      this.refreshPresentationBaseline();
      return;
    }
    this.presentationReady = false;
    this.send("ready", {
      fieldEpoch: this.expectedFieldEpoch,
      snapshotId: this.baselineId,
    });
    this.setStatus("active");
    this.openWaiter?.resolve(this.model);
    this.openWaiter = null;
    this.recoverPending();
  }

  /** A failed renderer requests authoritative replacement without discarding the socket. */
  presentationFailed(error) {
    this.callbacks.onPresentationError?.(error);
    this.presentationRecovery = true;
    this.presentationReady = false;
    this.setStatus("synchronizing", "PRESENTATION_FAILED");
    if (this.presentationRetries >= 3) {
      this.openWaiter?.reject(failure("PRESENTATION_FAILED"));
      this.openWaiter = null;
    }
  }

  refreshPresentationBaseline() {
    if (this.presentationRetries >= 3) {
      this.presentationFailed(failure("STALE_PRESENTATION_BASELINE"));
      return;
    }
    this.presentationRecovery = true;
    this.recoverPresentation(performance.now());
  }

  recoverPresentation(now) {
    if (!this.presentationRecovery || !this.socket || this.renderer.active) {
      return;
    }
    if (
      this.presentationRetries >= 3 ||
      now - this.lastResyncAt < RESYNC_INTERVAL_MS
    ) {
      return;
    }
    this.presentationRetries++;
    this.presentationRecovery = false;
    this.resync("baseline");
  }

  publishModel(model) {
    this.model = model;
    this.field = model.field;
    this.self = model.self;
    this.inventory = model.inventory;
    this.progress = model.progress;
    this.presentation = model.presentation;
    for (const domain of ["character", "inventory", "social"]) {
      this.revisions[domain] = Math.max(
        this.revisions[domain],
        model.revisions[domain],
      );
    }
  }

  /** Full snapshots restore live leases without rerunning their scripts or mutating state. */
  restoreInteractionRevisions(model) {
    for (const domain of ["conversation", "trade", "invitation"]) {
      this.revisions[domain] = model.revisions[domain];
    }
    const conversation = model.presentation.interactions.find(
      (event) =>
        event.kind === "dialogue" ||
        event.kind === "shop" ||
        event.kind === "storage",
    );
    this.conversationId =
      conversation?.conversationId ??
      conversation?.shopSession ??
      conversation?.storageSession ??
      null;
  }

  state(message) {
    this.publishModel(applyEntityChanges(this.model, message));
    this.baselineId = message.snapshotId;
    this.renderer.push("state", freezeView(message));
  }

  event(message, bytes) {
    let observed = message;
    if (message.event.kind === "shop") {
      const shop = this.shops.add(message, bytes, performance.now(), true);
      if (!shop) return;
      observed = { ...message, event: shop };
    }
    const event = observed.event;
    this.observeConversation(event);
    if (event.kind === "trade") {
      this.revisions.trade = event.revision;
      this.revisions.invitation = event.revision;
    }
    this.renderer.push("event", freezeView(observed));
  }

  observeConversation(event) {
    switch (event.kind) {
      case "dialogue":
        this.conversationId = event.conversationId;
        this.revisions.conversation = event.step;
        break;
      case "shop":
        this.conversationId = event.shopSession;
        this.revisions.conversation = event.revision;
        break;
      case "storage":
        this.conversationId = event.storageSession;
        break;
      case "storage.closed":
        if (this.conversationId === event.storageSession) {
          this.conversationId = null;
          this.revisions.conversation = 0;
        }
        break;
      case "dialogue.closed":
        if (this.shops.pending?.identity === event.conversationId) {
          this.shops.clear();
        }
        if (this.conversationId === event.conversationId) {
          this.conversationId = null;
          this.revisions.conversation = 0;
        }
        break;
    }
  }

  result(message) {
    if (this.unresolvedReceipts.delete(message.operationId)) {
      this.rememberResult(message);
    }
    const pending = this.pending.get(message.operationId);
    if (pending) {
      this.rememberResult(message);
      this.pending.delete(message.operationId);
      if (pending.travel) this.pendingTravel--;
      if (pending.domain) {
        this.revisions[pending.domain] = Math.max(
          this.revisions[pending.domain],
          message.domainRevision,
        );
      }
      pending.resolve(freezeView(message));
      pending.recoverResolve?.(message);
    }
    for (const entry of this.pending.values()) {
      if (entry.predecessor === message.operationId) {
        entry.parentResult = message;
      }
    }
    this.renderer.push("event", freezeView(message));
    if (this.status === "active") this.recoverPending();
  }

  transition(message) {
    if (message.sourceEpoch !== this.expectedFieldEpoch) {
      throw failure("STALE_FIELD");
    }
    this.transitionPhase = message.phase;
    if (message.phase === "prepare") {
      this.inputJournal.clear();
      this.setStatus("transitioning");
      this.shops.clear();
      const deadline =
        performance.now() +
        PROTOCOL.ASSET_PREPARATION_TIMEOUT_MS +
        COMMAND_TIMEOUT_MS;
      for (const pending of this.pending.values()) {
        if (pending.fields.fieldEpoch === message.sourceEpoch) {
          pending.deadline = Math.max(pending.deadline, deadline);
        }
      }
    }
    if (message.phase === "committed") {
      if (!message.destination) throw failure("INVALID_TRANSITION");
      this.expectedFieldEpoch = message.destination.fieldEpoch;
      this.inputJournal.clear();
      this.clock.resetField();
      this.callbacks.onTiming?.(this.clock.snapshot());
      this.lastInputTick = -1;
      this.serverTick = 0;
      this.baselines.clear();
      // The destination has not installed a baseline yet; never ack its transition
      // using a source-field snapshot that the server has already retired.
      this.baselineId = null;
      this.setStatus("synchronizing");
    }
    if (message.phase === "aborted") {
      // Rollback retires source baselines too. Wait for the replacement snapshot
      // before acknowledging publications or admitting movement again.
      this.baselines.clear();
      this.baselineId = null;
      this.setStatus("synchronizing");
    }
    this.renderer.push("transition", freezeView(message));
  }
  sendTransitionReady(
    transitionId,
    accepted,
    fieldEpoch = this.expectedFieldEpoch,
  ) {
    if (
      this.status !== "transitioning" ||
      fieldEpoch !== this.expectedFieldEpoch
    ) {
      throw failure("STALE_FIELD");
    }
    return this.send("transition-ready", {
      fieldEpoch,
      transitionId,
      accepted,
    });
  }

  send(type, fields) {
    if (
      !this.socket ||
      this.socket.readyState !== WebSocket.OPEN ||
      !this.connectionEpoch
    ) {
      throw failure("NOT_CONNECTED");
    }
    if (this.socket.bufferedAmount > SEND_SOFT_BYTES) {
      this.fail(failure("SEND_BACKPRESSURE"));
      throw failure("SEND_BACKPRESSURE");
    }
    if (!Number.isSafeInteger(this.seq + 1)) {
      throw failure("SEQUENCE_EXHAUSTED");
    }
    const message = {
      v: 1,
      type,
      connectionEpoch: this.connectionEpoch,
      seq: this.seq + 1,
      ...fields,
    };
    const text = JSON.stringify(message);
    decodeClient(text);
    if (encoder.encode(text).byteLength > this.limits.maxMessageBytes) {
      throw failure("MESSAGE_BYTE_LIMIT");
    }
    this.socket.send(text);
    this.seq++;
    return message;
  }

  sendInput(sample) {
    if (this.status !== "active") return null;
    if (
      !sample ||
      Object.keys(sample).some(
        (key) =>
          ![
            "targetTick",
            "motionEpoch",
            "motionConfig",
            "movementLocked",
            "impulses",
            "horizontal",
            "vertical",
            "jump",
            "attack",
            "motion",
          ].includes(key),
      )
    ) {
      throw failure("INVALID_INPUT");
    }
    if (!Number.isSafeInteger(this.inputSeq + 1)) {
      throw failure("SEQUENCE_EXHAUSTED");
    }
    if (!this.inputJournal.push(sample, this.inputSeq + 1)) {
      this.resync("prediction-overflow");
      return null;
    }
    this.inputSeq++;
    this.lastInputTick = sample.targetTick;
    this.flushInputs();
    return this.inputSeq;
  }

  initializeInputs() {
    this.inputJournal = new InputJournal();
    this.lastInputTick = -1;
    this.inputTokens = INPUT_BURST;
    this.inputRefillAt = performance.now();
  }

  inputWindow(clock) {
    const now = performance.now();
    const rate = this.limits.inputPerSecond ?? INPUT_BURST;
    this.inputTokens = Math.min(
      INPUT_BURST,
      this.inputTokens + ((now - this.inputRefillAt) * rate) / 1000,
    );
    this.inputRefillAt = now;
    return clock.arrivalTick(now) + PROTOCOL.INPUT_LEAD_TICKS;
  }

  inputReady(clock) {
    return !(
      this.status !== "active" ||
      !clock.ready ||
      clock.paused ||
      clock.connectionEpoch !== this.connectionEpoch ||
      clock.fieldEpoch !== this.expectedFieldEpoch
    );
  }

  /** Pace buffered input without changing its identity or its original target tick. */
  flushInputs() {
    if (this.recoverClosedSocket()) return;
    const clock = this.clock;
    if (!this.inputReady(clock)) return;
    this.inputWindow(clock);
    for (let count = 0; count < INPUT_DRAIN_LIMIT; count++) {
      const sample = this.inputJournal.first();
      if (
        !sample ||
        this.inputTokens < 1 ||
        !this.socket ||
        this.socket.bufferedAmount > SEND_SOFT_BYTES / 2
      ) {
        return;
      }
      this.send("input", {
        fieldEpoch: this.expectedFieldEpoch,
        inputSeq: sample.inputSeq,
        targetTick: sample.targetTick,
        motionEpoch: sample.motionEpoch,
        motionConfig: sample.motionConfig,
        movementLocked: sample.movementLocked,
        impulses: sample.impulses,
        horizontal: sample.horizontal,
        vertical: sample.vertical,
        jump: sample.jump,
        attack: sample.attack,
        ...(sample.motion ? { motion: sample.motion } : {}),
      });
      this.recovery.input();
      this.inputTokens--;
      this.inputJournal.shift();
    }
  }

  /** Send provisional damage telemetry keyed to its attack without awaiting a reply.
   *  An empty or unready report is dropped; it never determines server damage. */
  reportHits(report) {
    if (this.status !== "active" || !report?.hits?.length) return null;
    const hits = report.hits.slice(0, MAX_REPORTED_HITS);
    if (!hits.length) return null;
    return this.send("combat.hits", {
      fieldEpoch: this.expectedFieldEpoch,
      feedbackId: report.feedbackId ?? null,
      inputSeq: report.inputSeq ?? null,
      skillId: Number(report.skillId) || 0,
      hits,
    });
  }

  command(action, expectedRevision) {
    if (this.status !== "active") return Promise.reject(failure("NOT_ACTIVE"));
    if (this.pending.size >= MAX_PENDING) {
      return Promise.reject(failure("PENDING_OPERATION_LIMIT"));
    }
    const domain = actionDomain(action);
    const operationId = crypto.randomUUID();
    const fields = {
      fieldEpoch: this.expectedFieldEpoch,
      operationId,
      expectedRevision: expectedRevision ?? this.revisions[domain],
      action: structuredClone(action),
    };
    let queue;
    try {
      queue = this.commandCapacity(fields, domain);
      decodeClient(
        JSON.stringify({
          v: 1,
          type: "command",
          connectionEpoch: this.connectionEpoch,
          seq: this.seq + 1,
          ...fields,
        }),
      );
    } catch (error) {
      return Promise.reject(error);
    }
    const travel =
      action.kind === "portal.enter" ||
      action.kind === "content.enter" ||
      action.kind === "revive.request" ||
      action.kind === "skill.door";
    const promise = new Promise((resolve) => {
      this.pending.set(operationId, {
        fields,
        domain,
        travel,
        resolve,
        deadline: performance.now() + (travel ? 25000 : COMMAND_TIMEOUT_MS),
        unknown: false,
        sentEpoch: null,
        playSession: this.playSession,
        durable: !actionEphemeral(action),
        ...queue,
        parentResult: null,
        explicitRevision: expectedRevision !== undefined,
        bound: false,
        queuedAt: performance.now(),
      });
    });
    if (travel) this.pendingTravel++;
    promise.operationId = operationId;
    this.callbacks.onCommand?.(freezeView(structuredClone(fields)));
    this.sendPending(this.pending.get(operationId));
    return promise;
  }

  commandCapacity(fields, domain) {
    const bytes = encoder.encode(JSON.stringify(fields)).byteLength;
    let totalBytes = bytes;
    let predecessor = null;
    let controlAfter = null;
    for (const entry of this.pending.values()) {
      totalBytes += entry.bytes ?? 0;
      if (this.controlsCast(fields.action, entry.fields.action)) {
        controlAfter = entry.fields.operationId;
      }
      if (
        entry.domain === domain &&
        !entry.development &&
        !this.skillControl(entry.fields.action)
      ) {
        predecessor = entry.fields.operationId;
      }
    }
    if (totalBytes > MAX_PENDING_BYTES) {
      throw failure("PENDING_OPERATION_LIMIT");
    }
    return {
      bytes,
      controlAfter,
      predecessor: this.skillControl(fields.action) ? null : predecessor,
    };
  }

  controlsCast(control, cast) {
    return (
      this.skillControl(control) &&
      cast.kind === "skill.cast" &&
      cast.skillId === control.skillId
    );
  }

  skillControl(action) {
    return action.kind === "skill.release" || action.kind === "skill.cancel";
  }

  sendPending(pending) {
    if (!pending.durable && pending.playSession !== this.playSession) return;
    if (pending.development) {
      void this.sendDevelopment(pending);
      return;
    }
    if (this.recoverClosedSocket()) return;
    const cast = this.pending.get(pending.controlAfter);
    if (cast && cast.sentEpoch !== this.connectionEpoch) return;
    const now = performance.now();
    if (!this.skillControl(pending.fields.action) && now < this.nextCommandAt) {
      return;
    }
    if (!this.preparePending(pending, now)) return;
    try {
      this.send("command", pending.fields);
      pending.sentEpoch = this.connectionEpoch;
      if (!this.skillControl(pending.fields.action)) {
        this.nextCommandAt = now + 1000 / this.limits.commandPerSecond;
      }
    } catch (error) {
      this.fail(error, "command");
    }
  }

  recoverPending() {
    for (const pending of this.pending.values()) {
      // Input flushing or an earlier send can begin recovery during this pass.
      if (this.status !== "active") return;
      if (pending.sentEpoch !== this.connectionEpoch) this.sendPending(pending);
    }
  }

  /** A new actor cannot replay a mixed durable/tutorial portal safely. Its full
   * baseline releases presentation reservations, while the receipt stays unknown. */
  releaseRetiredTravel() {
    for (const [operationId, pending] of this.pending) {
      if (
        pending.durable ||
        pending.fields.action.kind !== "portal.enter" ||
        pending.playSession === this.playSession
      ) {
        continue;
      }
      const outcome = freezeView({
        type: "operation",
        operationId,
        status: "unknown",
        code: "OPERATION_EXPIRED",
      });
      const retained = Object.freeze({
        fields: freezeView(structuredClone(pending.fields)),
        result: outcome,
      });
      this.unresolvedReceipts.set(operationId, retained);
      if (this.unresolvedReceipts.size > MAX_PENDING) {
        this.unresolvedReceipts.delete(
          this.unresolvedReceipts.keys().next().value,
        );
      }
      this.rememberResult(outcome);
      this.pending.delete(operationId);
      if (pending.travel) this.pendingTravel--;
      pending.resolve(outcome);
      pending.recoverResolve?.(outcome);
      this.rejectRetiredDependents(operationId);
    }
  }

  /** These child intentions never left the browser and depended on an unknown turn. */
  rejectRetiredDependents(operationId) {
    for (const pending of this.pending.values()) {
      if (!pending.bound && pending.predecessor === operationId) {
        this.rejectUnsent(pending, "OPERATION_EXPIRED");
      }
    }
  }

  /** Bind a local intention to a revision once, just before its first transmission.
   * Retries keep the exact original envelope; unknown predecessors remain unresolved. */
  preparePending(pending, now) {
    if (pending.bound) return true;

    let code = null;
    if (pending.parentResult?.status === "rejected") code = "NOT_ALLOWED";
    if (pending.fields.fieldEpoch !== this.expectedFieldEpoch) {
      code = "STALE_FIELD";
    }
    if (
      pending.fields.action.kind === "skill.cast" &&
      now - pending.queuedAt > GAMEPLAY_QUEUE_MS
    ) {
      code = "COOLDOWN";
    }
    if (code) {
      this.rejectUnsent(pending, code);
      return false;
    }
    if (pending.predecessor && !pending.parentResult) return false;
    if (!pending.explicitRevision) {
      pending.fields.expectedRevision = this.revisions[pending.domain];
    }
    pending.bound = true;
    return true;
  }

  rejectUnsent(pending, code) {
    const result = freezeView({
      type: "operation",
      operationId: pending.fields.operationId,
      status: "rejected",
      code,
      domainRevision: this.revisions[pending.domain],
      transactionId: null,
    });
    this.rememberResult(result);
    this.pending.delete(result.operationId);
    if (pending.travel) this.pendingTravel--;
    pending.resolve(result);
    pending.recoverResolve?.(result);
    for (const entry of this.pending.values()) {
      if (entry.predecessor === result.operationId) entry.parentResult = result;
    }
  }

  rememberResult(result) {
    this.completed.set(result.operationId, result);
    if (this.completed.size > MAX_PENDING) {
      this.completed.delete(this.completed.keys().next().value);
    }
  }

  recover(operationId) {
    if (this.completed.has(operationId)) {
      return Promise.resolve(this.completed.get(operationId));
    }
    const pending = this.pending.get(operationId);
    if (!pending) return Promise.reject(failure("OPERATION_NOT_PENDING"));
    if (!pending.recovery) {
      pending.recovery = new Promise((resolve) => {
        pending.recoverResolve = resolve;
      });
      if (pending.unknown) {
        pending.sentEpoch = null;
        if (this.status === "active") this.sendPending(pending);
      }
    }
    return pending.recovery;
  }

  develop(action) {
    if (
      this.status !== "active" ||
      !this.config.development ||
      this.config.role !== "developer"
    ) {
      return Promise.reject(failure("NOT_ALLOWED"));
    }
    if (this.pending.size >= MAX_PENDING) {
      return Promise.reject(failure("PENDING_OPERATION_LIMIT"));
    }
    const operationId = crypto.randomUUID();
    const promise = new Promise((resolve) => {
      this.pending.set(operationId, {
        fields: { operationId, action: structuredClone(action) },
        development: true,
        durable: true,
        playSession: this.playSession,
        resolve,
        deadline: performance.now() + COMMAND_TIMEOUT_MS,
        unknown: false,
        sentEpoch: null,
        inFlight: false,
      });
    });
    promise.operationId = operationId;
    this.callbacks.onCommand?.(
      freezeView(this.pending.get(operationId).fields),
    );
    this.sendPending(this.pending.get(operationId));
    return promise;
  }

  async sendDevelopment(pending) {
    if (pending.inFlight) return;
    pending.inFlight = true;
    pending.sentEpoch = this.connectionEpoch;
    try {
      const result = await request("/api/v1/development", "POST", {
        csrfToken: this.config.csrfToken,
        connectionEpoch: this.connectionEpoch,
        ...pending.fields,
      });
      if (
        !["committed", "rejected"].includes(result.status) ||
        result.operationId !== pending.fields.operationId
      ) {
        throw failure("INVALID_DEVELOPMENT_RECEIPT");
      }
      this.pending.delete(result.operationId);
      const observed = freezeView(result);
      pending.resolve(observed);
      pending.recoverResolve?.(observed);
      this.callbacks.onEvent?.(observed);
    } catch (error) {
      if (
        !pending.unknown &&
        error.httpStatus >= 400 &&
        error.httpStatus < 500
      ) {
        this.rejectDevelopment(pending, error.code);
        return;
      }
      pending.unknown = true;
      pending.resolve(
        freezeView({
          status: "unknown",
          operationId: pending.fields.operationId,
        }),
      );
      this.callbacks.onStatus?.({
        ...this.snapshot(),
        code: error.code ?? "OPERATION_UNKNOWN",
        operationId: pending.fields.operationId,
      });
    } finally {
      pending.inFlight = false;
    }
  }

  rejectDevelopment(pending, code) {
    const result = freezeView({
      status: "rejected",
      code,
      operationId: pending.fields.operationId,
    });
    this.pending.delete(pending.fields.operationId);
    pending.resolve(result);
    pending.recoverResolve?.(result);
    this.callbacks.onEvent?.(result);
  }

  ack() {
    if (this.baselineId && this.lastEventSeq > 0) {
      this.send("ack", {
        eventSeq: this.lastEventSeq,
        snapshotId: this.baselineId,
      });
    }
  }

  resync(reason = "prediction-overflow") {
    if (this.recoverClosedSocket()) return;
    if (
      !this.connectionEpoch ||
      !this.lastEventSeq ||
      performance.now() - this.lastResyncAt < RESYNC_INTERVAL_MS
    ) {
      return;
    }
    this.lastResyncAt = performance.now();
    this.resyncing = true;
    this.setStatus("synchronizing", "RESYNC_REQUIRED");
    this.send("resync", {
      fieldEpoch: this.expectedFieldEpoch,
      lastEventSeq: this.lastEventSeq,
      reason,
    });
  }

  /** Native close state can precede its queued event after a frozen page wakes. */
  recoverClosedSocket() {
    if (
      !this.socket ||
      this.socket.readyState < WebSocket.CLOSING ||
      !this.characterId ||
      !this.playSession ||
      !this.model ||
      !this.config ||
      this.closed ||
      this.revoking
    ) {
      return false;
    }
    this.disconnected("CONNECTION_LOST");
    return true;
  }

  neutral() {
    // Every input now proves a complete local quantum. Visibility/blur clears the
    // native held state; no synthetic, unstepped packet may consume a path tick.
    this.callbacks.onClearInput?.();
  }

  visibility() {
    if (globalThis.document?.hidden) this.neutral();
    else this.recovery.advance();
  }

  check() {
    const now = performance.now();
    try {
      this.recovery.advance(now);
      this.baselines.check(now);
      this.shops.check(now);
      this.recoverPresentation(now);
      if (!this.renderer.task) this.presentationIdle();
      if (this.openWaiter && now > this.openWaiter.deadline) {
        throw failure("CONNECT_TIMEOUT");
      }
      if (this.socket && now - this.lastMessageAt > HEARTBEAT_TIMEOUT_MS) {
        throw failure("HEARTBEAT_TIMEOUT");
      }
      if (this.status === "active") {
        this.flushInputs();
        this.recoverPending();
      }
      for (const [operationId, pending] of this.pending) {
        if (!pending.unknown && now > pending.deadline) {
          pending.unknown = true;
          pending.resolve(
            freezeView({ type: "operation", operationId, status: "unknown" }),
          );
          this.callbacks.onStatus?.({
            ...this.snapshot(),
            code: "OPERATION_UNKNOWN",
            operationId,
          });
        }
      }
    } catch (error) {
      this.fail(error, "check");
    }
  }

  setStatus(status, code) {
    if (status === "active" && this.recovery.pending) this.recovery.ready();
    this.status = this.revoking
      ? "signing-out"
      : this.recovery.pending
        ? "recovering"
        : status;
    this.callbacks.onStatus?.({ ...this.snapshot(), code });
  }

  fail(error, stage = "transport") {
    this.disconnected(error.code ?? error.message ?? "PROTOCOL_ERROR", {
      stage,
      error,
    });
  }

  disconnected(code, context = null) {
    // A closing frame is authoritative for why this connection ended.
    const reason = this.closingCode ?? code;
    const diagnostic = this.disconnectionFailure(reason, context);
    this.closingCode = null;
    const socket = this.socket;
    this.socket = null;
    this.generation++;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      // Close reasons are bounded and sanitized; the full failure remains local.
      const label = /^[A-Z_]{1,80}$/.test(reason) ? reason : "CLIENT_ERROR";
      socket.close(1000, label);
    }
    this.openWaiter?.reject(failure(reason));
    this.openWaiter = null;
    this.resetConnection();
    const recover =
      !this.closed && !this.revoking && this.recovery.lost(reason);
    this.retainDisconnection(diagnostic, recover);
    this.setStatus(
      recover ? "recovering" : "disconnected",
      this.recovery.failureCode ?? reason,
    );
    this.reportTerminalDisconnection(diagnostic, recover, context);
  }

  retainDisconnection(diagnostic, recover) {
    if (!diagnostic) return;
    diagnostic.code = this.recovery.failureCode ?? diagnostic.code;
    diagnostic.recovery = recover;
    this.lastFailure = Object.freeze(diagnostic);
  }

  reportTerminalDisconnection(diagnostic, recover, context) {
    if (diagnostic && !recover) {
      this.callbacks.onTransportError?.(
        context?.error ?? failure(diagnostic.code),
      );
    }
  }

  /** One credential-free diagnostic survives connection reset and bounded event history. */
  disconnectionFailure(code, context) {
    if (
      this.closed ||
      this.revoking ||
      ["DISCONNECTED", "SIGNED_OUT", "SESSION_REPLACED"].includes(code)
    ) {
      return null;
    }
    return {
      code: /^[A-Z_]{1,80}$/.test(code) ? code : "CLIENT_ERROR",
      at: Date.now(),
      mapId: this.field?.mapId ?? null,
      fieldEpoch: this.expectedFieldEpoch,
      phase: this.transitionPhase ?? this.status,
      stage: context?.stage ?? "transport",
      closeCode: context?.closeCode ?? null,
      serverTick: this.serverTick,
      lastEventSeq: this.lastEventSeq,
    };
  }

  disconnect() {
    this.recovery.cancel();
    this.intentGeneration++;
    this.neutral();
    this.disconnected("DISCONNECTED");
  }

  close() {
    this.disconnect();
    this.closed = true;
    clearInterval(this.checkTimer);
    globalThis.removeEventListener?.("blur", this.blurHandler);
    globalThis.document?.removeEventListener(
      "visibilitychange",
      this.visibilityHandler,
    );
    for (const [operationId, pending] of this.pending) {
      const unknown = freezeView({ status: "unknown", operationId });
      pending.resolve(unknown);
      pending.recoverResolve?.(unknown);
    }
  }

  snapshot() {
    return Object.freeze({
      status: this.status,
      characterId: this.characterId,
      connectionEpoch: this.connectionEpoch,
      serverTick: this.serverTick,
      lastEventSeq: this.lastEventSeq,
      inputSeq: this.inputSeq,
      timing: this.clock.snapshot(),
      pendingOperations: this.pending.size,
      unresolvedOperations: this.unresolvedReceipts.size,
      queuedMessages: this.queue.length + this.deferred.length,
      queuedBytes: this.queueBytes + this.deferredBytes,
      presentationMessages: this.renderer.queue.length,
      presentationBytes: this.renderer.bytes,
      bufferedBytes: this.socket?.bufferedAmount ?? 0,
      lastFailure: this.lastFailure,
    });
  }
}
