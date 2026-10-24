import { PROTOCOL, protocolError } from "../../shared/protocol.js";
import { movementStreamView } from "./movement-stream.js";
import { captureMotion } from "../../shared/motion.js";
import { opaqueId } from "./auth.js";
import { serverOwnsPosition, combatMotionOwner } from "./motion-authority.js";
import {
  frameBytes,
  paginateViews,
  MAX_FRAME_BYTES,
  MAX_SNAPSHOT_PARTS,
} from "./publication-frames.js";

const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const MAX_BASELINES = 64;
const SOFT_BACKLOG_BYTES = 256 * 1024;
const HARD_BACKLOG_BYTES = 1024 * 1024;

/** Each play session owns its own contiguous event sequence; nothing leaks global traffic. */
export class Publications {
  constructor(world) {
    this.world = world;
  }

  envelope(socket, record) {
    return {
      v: PROTOCOL.VERSION,
      ...record,
      connectionEpoch: socket.data.epoch,
      serverTick: socket.data.actor?.field?.tick ?? 0,
    };
  }

  send(socket, record) {
    if (socket.data.closed) return false;
    const text = JSON.stringify(this.envelope(socket, record));
    if (Buffer.byteLength(text) > MAX_FRAME_BYTES) {
      throw protocolError("SERVER_BUSY");
    }
    if (socket.getBufferedAmount() > HARD_BACKLOG_BYTES) {
      this.close(socket, "RESYNC_REQUIRED");
      return false;
    }
    const sent = socket.send(text);
    if (sent === 0) {
      socket.close(1011, "RESYNC_REQUIRED");
      return false;
    }
    // -1 has already been enqueued by Bun. Never resend that frame.
    return true;
  }

  close(socket, code, retryAfterMs = 1000) {
    if (socket.data.closed) return;
    this.world.log?.("socket.closing", {
      character: socket.data.actor?.id,
      code,
    });
    const record = this.envelope(socket, {
      type: "closing",
      code,
      retryAfterMs,
    });
    socket.send(JSON.stringify(record));
    socket.data.closed = true;
    socket.close(1008, code);
  }

  nextEvent(actor) {
    if (
      !Number.isSafeInteger(actor.eventSeq ?? 0) ||
      actor.eventSeq >= Number.MAX_SAFE_INTEGER
    ) {
      throw protocolError("SERVER_BUSY");
    }
    actor.eventSeq = (actor.eventSeq ?? 0) + 1;
    return actor.eventSeq;
  }

  motion(actor) {
    if (!actor.simulation || !actor.field) return;
    this.send(actor.connection, {
      type: "motion",
      fieldEpoch: actor.field.epoch,
      paused: actor.field.paused,
      ...movementStreamView(actor),
      ackInputSeq: actor.ackInputSeq ?? null,
      motion: captureMotion(actor.simulation),
      // The browser owns its ordinary XY; only server-owned state repositions it.
      authoritative: serverOwnsPosition(actor, actor.simulation),
      combat: combatMotionOwner(actor),
      // This immediate post-snapshot checkpoint applies no external impulse, but the
      // wire record requires the bounded divert array on every motion frame.
      diverts: [],
    });
  }

  snapshot(actor) {
    const socket = actor.connection;
    if (!socket || socket.data.closed || actor.state === "transitioning") {
      return;
    }
    const views = this.world.snapshot(actor);
    if (
      !Array.isArray(views) ||
      views.length < 1 ||
      views.length > MAX_SNAPSHOT_PARTS
    ) {
      throw protocolError("SERVER_BUSY");
    }
    const snapshotId = opaqueId();
    const eventSeq = this.nextEvent(actor);
    const frames = this.snapshotFrames(actor, views, snapshotId, eventSeq);
    if (socket.data.snapshotEpoch !== actor.field.epoch) {
      socket.data.baselines.clear();
      socket.data.ackSnapshotId = null;
      socket.data.snapshotEpoch = actor.field.epoch;
      socket.data.ready = false;
      socket.data.readyDeadlineAt =
        Date.now() + PROTOCOL.ASSET_PREPARATION_TIMEOUT_MS;
    }
    this.offer(socket, snapshotId, eventSeq);
    socket.data.offeredSnapshotId = snapshotId;
    socket.data.pendingStateId = snapshotId;
    this.trackSnapshotEntities(socket, views);
    for (const frame of frames) {
      if (!this.send(socket, frame)) return;
    }
    this.motion(actor);
  }

  trackSnapshotEntities(socket, views) {
    socket.data.knownEntities = new Set();
    for (const view of views) {
      if (view.kind === "entities") {
        for (const entity of view.entities) {
          socket.data.knownEntities.add(entity.id);
        }
      }
    }
  }

  snapshotFrames(actor, views, snapshotId, eventSeq) {
    const base = {
      type: "snapshot",
      snapshotId,
      fieldEpoch: actor.field.epoch,
      eventSeq,
      ackInputSeq: actor.ackInputSeq ?? null,
    };
    // Budget with the largest legal part counters, including recipient-specific metadata.
    views = paginateViews(views, (view) =>
      this.envelope(actor.connection, {
        ...base,
        part: MAX_SNAPSHOT_PARTS - 1,
        parts: MAX_SNAPSHOT_PARTS,
        view,
      }),
    );
    const frames = [];
    let total = 0;
    for (let part = 0; part < views.length; part++) {
      const frame = {
        type: "snapshot",
        snapshotId,
        fieldEpoch: actor.field.epoch,
        eventSeq,
        ackInputSeq: actor.ackInputSeq ?? null,
        part,
        parts: views.length,
        view: views[part],
      };
      const bytes = Buffer.byteLength(
        JSON.stringify(this.envelope(actor.connection, frame)),
      );
      total += bytes;
      if (bytes > MAX_FRAME_BYTES || total > MAX_SNAPSHOT_BYTES) {
        throw protocolError("SERVER_BUSY");
      }
      frames.push(frame);
    }
    return frames;
  }

  offer(socket, id, cursor) {
    if (socket.data.baselines.size >= MAX_BASELINES) {
      throw protocolError("RESYNC_REQUIRED");
    }
    socket.data.baselines.set(id, cursor);
  }

  acknowledge(socket, message) {
    const cursor = socket.data.baselines.get(message.snapshotId);
    if (
      cursor === undefined ||
      message.eventSeq < cursor ||
      message.eventSeq > socket.data.actor.eventSeq
    ) {
      throw protocolError("INVALID_MESSAGE");
    }
    if (message.eventSeq < socket.data.ackEventSeq) {
      throw protocolError("INVALID_MESSAGE");
    }
    socket.data.ackEventSeq = message.eventSeq;
    socket.data.ackSnapshotId = message.snapshotId;
    if (socket.data.pendingStateId === message.snapshotId) {
      socket.data.pendingStateId = null;
    }
    for (const [id, sequence] of socket.data.baselines) {
      if (sequence < cursor) socket.data.baselines.delete(id);
    }
  }

  state(actor, record) {
    const socket = actor.connection;
    if (
      !socket.data.ready ||
      !socket.data.ackSnapshotId ||
      socket.data.pendingStateId
    ) {
      return false;
    }
    if (socket.getBufferedAmount() > SOFT_BACKLOG_BYTES) {
      socket.data.needsSnapshot = true;
      return;
    }
    const snapshotId = opaqueId();
    const eventSeq = (actor.eventSeq ?? 0) + 1;
    const frame = {
      ...record,
      type: "state",
      snapshotId,
      baseSnapshotId: socket.data.ackSnapshotId,
      fieldEpoch: actor.field.epoch,
      ackInputSeq: actor.ackInputSeq ?? null,
      eventSeq,
    };
    if (frameBytes(this.envelope(socket, frame)) > MAX_FRAME_BYTES) {
      this.snapshot(actor);
      return false;
    }
    this.nextEvent(actor);
    this.offer(socket, snapshotId, eventSeq);
    socket.data.pendingStateId = snapshotId;
    this.send(socket, frame);
    return true;
  }

  entities(actor, entities) {
    const socket = actor.connection;
    if (!socket.data.ready || socket.data.pendingStateId) return;
    const current = new Set();
    const changes = [];
    for (const entity of entities) {
      current.add(entity.id);
      changes.push({ kind: "upsert", entity });
    }
    for (const id of socket.data.knownEntities ?? []) {
      if (!current.has(id)) changes.push({ kind: "remove", entityId: id });
    }
    if (changes.length > PROTOCOL.MAX_ENTITY_CHANGES) {
      this.snapshot(actor);
      return;
    }
    if (this.state(actor, { changes })) socket.data.knownEntities = current;
  }

  publish(actor, record) {
    const socket = actor.connection;
    if (!socket || socket.data.closed) return;
    try {
      if (record.type === "snapshot-request") this.snapshot(actor);
      else if (record.type === "state") this.state(actor, record);
      else if (record.type === "entities-request") {
        this.entities(actor, record.entities);
      } else if (["event", "transition", "result"].includes(record.type)) {
        this.send(socket, { ...record, eventSeq: this.nextEvent(actor) });
      } else this.send(socket, record);
    } catch (error) {
      this.close(socket, error.code ?? "SERVER_BUSY");
    }
  }
}
