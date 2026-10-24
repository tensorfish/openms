import { expect, test } from "bun:test";
import { Publications } from "../src/publication.js";
import { actorEntity } from "../src/field-views.js";
import {
  PROTOCOL,
  decodeServer,
  snapshotPartSchema,
} from "../../shared/protocol.js";
import { validate } from "../../shared/schema.js";
import { loadContent } from "../src/content.js";
import { createSimulation } from "../../client/src/physics/simulation.js";
import { captureMotion } from "../../shared/motion.js";

const content = await loadContent();
const physics = (await content.map(content.catalog.defaultMap)).physics;

function fixture() {
  const sent = [];
  const actor = {
    field: { epoch: "field", tick: 123 },
    state: "active",
    eventSeq: 0,
  };
  const socket = {
    data: {
      actor,
      epoch: "connection",
      ready: true,
      ackSnapshotId: "old",
      baselines: new Map(),
    },
    getBufferedAmount: () => 0,
    send(text) {
      sent.push(text);
      return text.length;
    },
  };
  actor.connection = socket;
  const entities = Array.from({ length: 100 }, (_, index) =>
    actorEntity({
      id: crypto.randomUUID(),
      actionStartTick: 0,
      simulation: createSimulation(physics, { x: index, y: 0, facing: 1 }),
      profile: {
        hp: 50,
        name: "界".repeat(32),
        gender: 0,
        appearance: { skin: 0, face: 20000, hair: 30000 },
        equipment: Array.from({ length: 12 }, (_, slot) => ({
          slot: -slot - 1,
          id: 1002000,
        })),
      },
    }),
  );
  const views = [{ kind: "entities", entities }];
  return {
    actor,
    socket,
    sent,
    entities,
    views,
    publications: new Publications({ snapshot: () => views }),
  };
}

test("valid crowded field snapshots split by UTF-8 wire bytes without losing entities", () => {
  const f = fixture();
  expect(validate(f.views[0], snapshotPartSchema)).toBe(f.views[0]);
  expect(Buffer.byteLength(JSON.stringify(f.views[0]))).toBeGreaterThan(65536);
  const frames = f.publications.snapshotFrames(f.actor, f.views, "snapshot", 1);
  expect(frames.length).toBeGreaterThan(1);
  const decoded = frames.map((frame) => {
    const text = JSON.stringify(f.publications.envelope(f.socket, frame));
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(65536);
    return decodeServer(text);
  });
  expect(decoded.flatMap((frame) => frame.view.entities)).toEqual(f.entities);
  expect(decoded.map((frame) => frame.part)).toEqual(
    decoded.map((_, index) => index),
  );
  expect(decoded.every((frame) => frame.parts === decoded.length)).toBe(true);
});

test("published chair seat remains a closed wire record", () => {
  const entity = actorEntity({
    id: crypto.randomUUID(),
    actionStartTick: 0,
    simulation: {
      ...createSimulation(physics, { x: 10, y: 20, facing: 1 }),
      action: "sit",
      seat: { id: 3010000, x: 10, y: 20 },
    },
    profile: {
      hp: 50,
      name: "chair",
      gender: 0,
      appearance: { skin: 0, face: 20000, hair: 30000 },
      equipment: [],
    },
  });
  expect(
    validate({ kind: "entities", entities: [entity] }, snapshotPartSchema),
  ).toEqual({ kind: "entities", entities: [entity] });
});

test("committed chair receipts decode as published inventory results", () => {
  const message = {
    v: 1,
    type: "result",
    connectionEpoch: "connection",
    serverTick: 33,
    eventSeq: 12,
    operationId: crypto.randomUUID(),
    status: "committed",
    code: "OK",
    domainRevision: 4,
    transactionId: crypto.randomUUID(),
    value: { kind: "chair.toggle", templateId: 3010000 },
  };
  expect(decodeServer(JSON.stringify(message))).toEqual(message);
});

test("oversized entity deltas fall back before advancing the baseline or sending partial state", () => {
  const f = fixture();
  f.publications.motion = () => {};
  f.publications.entities(f.actor, f.entities);
  expect(f.sent.length).toBeGreaterThan(1);
  expect(
    f.sent.map(decodeServer).every((frame) => frame.type === "snapshot"),
  ).toBe(true);
  expect(f.actor.eventSeq).toBe(1);
  expect(f.socket.data.baselines.size).toBe(1);
  expect(f.socket.data.knownEntities.size).toBe(100);
});

test("the immediate post-snapshot motion checkpoint is a complete wire record", () => {
  const simulation = createSimulation(physics, {
    x: 0,
    y: 0,
    facing: 1,
  });
  const sent = [];
  const actor = {
    field: { epoch: "field", tick: 123, paused: false },
    state: "active",
    eventSeq: 0,
    ackInputSeq: 4,
    inputQueue: new Map(),
    simulation,
    connection: {
      data: { epoch: "connection", closed: false },
      getBufferedAmount: () => 0,
      send(text) {
        sent.push(text);
        return text.length;
      },
    },
  };
  new Publications({}).motion(actor);
  expect(sent).toHaveLength(1);
  const frame = decodeServer(sent[0]);
  expect(frame.type).toBe("motion");
  // Server-issued checkpoints carry no external impulse, but the closed record still
  // requires the divert array the movement contract added.
  expect(frame.diverts).toEqual([]);
  expect(frame.motion).toEqual(captureMotion(simulation));
});

test("a cross-field baseline starts one readiness deadline that same-field refreshes cannot extend", () => {
  const actor = {
    field: { epoch: "destination", tick: 8 },
    state: "active",
    eventSeq: 0,
  };
  const socket = {
    data: {
      actor,
      epoch: "connection",
      closed: false,
      ready: true,
      snapshotEpoch: "source",
      readyDeadlineAt: null,
      baselines: new Map([["old", 1]]),
    },
    getBufferedAmount: () => 0,
    send: () => 1,
  };
  actor.connection = socket;
  const publications = new Publications({
    snapshot: () => [{ kind: "entities", entities: [] }],
  });
  publications.motion = () => {};

  publications.snapshot(actor);
  const deadline = socket.data.readyDeadlineAt;
  expect(socket.data.ready).toBe(false);
  expect(deadline).toBeGreaterThan(Date.now());
  expect(deadline).toBeLessThanOrEqual(
    Date.now() + PROTOCOL.ASSET_PREPARATION_TIMEOUT_MS,
  );

  publications.snapshot(actor);
  expect(socket.data.readyDeadlineAt).toBe(deadline);
});

test("an indivisible oversized view and excessive aggregate snapshot remain explicit errors", () => {
  const f = fixture();
  const huge = { kind: "native-presentation", data: "x".repeat(65536) };
  expect(() =>
    f.publications.snapshotFrames(f.actor, [huge], "snapshot", 1),
  ).toThrow("SERVER_BUSY");
  const views = Array(64).fill({
    kind: "native-presentation",
    data: "x".repeat(20000),
  });
  expect(() =>
    f.publications.snapshotFrames(f.actor, views, "snapshot", 1),
  ).toThrow("SERVER_BUSY");
});
