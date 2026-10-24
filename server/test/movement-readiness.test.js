import { expect, test } from "bun:test";
import { loadContent } from "../src/content.js";
import { createSimulation } from "../../client/src/physics/simulation.js";
import {
  createHeldInput,
  captureMotion,
  restoreMotion,
} from "../../shared/motion.js";
import {
  advanceMovementStream,
  movementStreamView,
} from "../src/movement-stream.js";
import { prepareMotionDiverts } from "../src/field-diverts.js";
import { PROTOCOL } from "../../shared/protocol.js";
import { GameplayGateway } from "../src/gateway.js";

const content = await loadContent();
const physics = (await content.map("100000000")).physics;

function fixture() {
  const simulation = createSimulation(physics, { x: 80, y: 274 });
  const actor = {
    id: "walker",
    state: "active",
    profile: { hp: 100 },
    simulation,
    field: { epoch: "field", tick: 100 },
    input: createHeldInput(),
    inputQueue: new Map(),
    attackEdges: [],
    receivedAttack: false,
    ackInputSeq: 0,
    actionStartTick: 0,
  };
  const faults = [];
  const world = {
    faultMotion(_actor, detail) {
      faults.push(detail);
    },
  };
  const client = createSimulation(physics, { x: 80, y: 274 });
  restoreMotion(client, captureMotion(simulation));
  prepareMotionDiverts(actor, actor.field);
  movementStreamView(actor);
  return {
    actor,
    client,
    world,
    faults,
    held: createHeldInput(),
    tick: 100,
    seq: 0,
  };
}

function advance(probe, count = 1) {
  for (let i = 0; i < count; i++) {
    probe.actor.field.tick++;
    advanceMovementStream(probe.world, probe.actor);
  }
}

test("destination readiness pauses movement expiry, then starts a fresh bounded stream", () => {
  const probe = fixture();
  const socket = {
    data: {
      actor: probe.actor,
      ready: false,
      baselines: new Map([["snapshot", 1]]),
    },
  };
  probe.actor.connection = socket;
  movementStreamView(probe.actor);
  let recoveries = 0;
  probe.world.expireMovement = () => recoveries++;
  const previousEpoch = probe.actor.movementStream.epoch;
  advance(probe, PROTOCOL.INPUT_HISTORY + 1);
  expect(recoveries).toBe(0);
  expect(probe.actor.movementStream.expired).toBe(false);

  probe.world.participants = { publish: async () => {} };
  let motionUpdates = 0;
  const gateway = {
    world: probe.world,
    publications: { motion: () => motionUpdates++ },
  };
  GameplayGateway.prototype.ready.call(gateway, socket, {
    snapshotId: "snapshot",
  });
  expect(socket.data.ready).toBe(true);
  expect(socket.data.readyDeadlineAt).toBeNull();
  expect(probe.actor.movementStream.epoch).toBe(previousEpoch + 1);
  expect(probe.actor.movementStream.startedTick).toBe(probe.actor.field.tick);
  expect(motionUpdates).toBe(1);

  advance(probe, PROTOCOL.INPUT_HISTORY + 1);
  expect(recoveries).toBe(1);
});

test("a connection that never completes presentation readiness hits the shared timeout", () => {
  const closed = [];
  const deadline = 100 + PROTOCOL.ASSET_PREPARATION_TIMEOUT_MS;
  const socket = {
    data: {
      actor: {},
      ready: false,
      readyDeadlineAt: deadline,
    },
  };
  const gateway = {
    publications: {
      close(_socket, code, retryAfterMs) {
        closed.push({ code, retryAfterMs });
      },
    },
  };

  GameplayGateway.prototype.heartbeat.call(gateway, socket, deadline);

  expect(closed).toEqual([{ code: "TRANSITION_FAILED", retryAfterMs: 0 }]);
});

test("actor attachment starts a fresh presentation deadline after server preparation", () => {
  const probe = fixture();
  const socket = { data: { readyDeadlineAt: 1 } };
  const before = Date.now();

  GameplayGateway.prototype.attach.call({}, socket, probe.actor);

  expect(socket.data.ready).toBe(false);
  expect(socket.data.readyDeadlineAt).toBeGreaterThanOrEqual(
    before + PROTOCOL.ASSET_PREPARATION_TIMEOUT_MS,
  );
  expect(socket.data.readyDeadlineAt).toBeLessThanOrEqual(
    Date.now() + PROTOCOL.ASSET_PREPARATION_TIMEOUT_MS,
  );
});
