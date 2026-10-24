import { expect, test } from "bun:test";
import { loadContent } from "../src/content.js";
import {
  createSimulation,
  applyExternalImpulse,
} from "../../client/src/physics/simulation.js";
import {
  createHeldInput,
  assignHeldInput,
  captureMotion,
  restoreMotion,
  stepMotion,
} from "../../shared/motion.js";
import {
  advanceMovementStream,
  movementStreamView,
} from "../src/movement-stream.js";
import { prepareMotionDiverts } from "../src/field-diverts.js";
import { takeAttackInput } from "../src/attack-input.js";
import { OnlineWorld } from "../src/world.js";

const content = await loadContent();
const physics = (await content.map("100000000")).physics;

function fixture(fieldPhysics = physics) {
  const simulation = createSimulation(fieldPhysics, { x: 80, y: 274 });
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
    inputSeq: 0,
    ackInputSeq: 0,
    actionStartTick: 0,
  };
  const faults = [];
  const world = {
    faultMotion(_actor, detail) {
      faults.push(detail);
    },
  };
  const client = createSimulation(fieldPhysics, { x: 80, y: 274 });
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

test("underwater movement remains proven and acknowledged when rapid basic attacks exceed combat capacity", async () => {
  const water = (await content.map("230040400")).physics;
  const probe = fixture(water);
  const closes = [];
  probe.actor.connection = {
    data: { ready: true },
    close: (code, reason) => closes.push({ code, reason }),
  };
  movementStreamView(probe.actor);
  for (let tick = 0; tick < 40; tick++) {
    const packet = report(probe, { attack: tick % 4 === 0, horizontal: 0 });
    OnlineWorld.prototype.input.call(probe.world, probe.actor, packet);
    advance(probe);
  }
  expect(probe.actor.attackEdges).toHaveLength(8);
  expect(probe.actor.attackAdmission).toBe("COOLDOWN");
  expect(probe.actor.ackInputSeq).toBe(40);
  expect(probe.actor.movementStream.steps).toBe(40);
  expect(probe.actor.inputQueue.size).toBe(0);
  expect(probe.actor.simulation.x).toBe(probe.client.x);
  expect(probe.actor.simulation.y).toBe(probe.client.y);
  expect(probe.faults).toEqual([]);
  expect(probe.actor.state).toBe("active");
  expect(probe.actor.retiring).not.toBe(true);
  expect(closes).toEqual([]);
  const consumed = [];
  for (let edge = 0; edge < 8; edge++) {
    expect(takeAttackInput(probe.actor)).toBe(true);
    consumed.push(probe.actor.combatInputSeq);
  }
  expect(consumed).toEqual([1, 5, 9, 13, 17, 21, 25, 29]);
  expect(takeAttackInput(probe.actor)).toBe(false);
  expect(probe.actor.attackEdges).toEqual([]);
  OnlineWorld.prototype.input.call(
    probe.world,
    probe.actor,
    report(probe, { attack: true, horizontal: 0 }),
  );
  advance(probe, 2);
  expect(probe.actor.ackInputSeq).toBe(41);
  expect(takeAttackInput(probe.actor)).toBe(true);
  expect(probe.actor.combatInputSeq).toBe(41);
  expect(takeAttackInput(probe.actor)).toBe(false);
  expect(closes).toEqual([]);
});

function report(probe, controls = {}) {
  const sample = {
    fieldEpoch: "field",
    inputSeq: ++probe.seq,
    targetTick: ++probe.tick,
    motionEpoch: probe.actor.movementStream.epoch,
    motionConfig: probe.actor.movementStream.configurations.at(-1).version,
    movementLocked: false,
    horizontal: 1,
    vertical: 0,
    jump: false,
    attack: false,
    impulses: [],
    ...controls,
  };
  assignHeldInput(probe.held, sample);
  for (const impulse of sample.impulses) {
    const grant = probe.actor.movementStream.grants.find(
      (entry) => entry.id === impulse.id || entry.skillId === impulse.skillId,
    );
    applyExternalImpulse(probe.client, grant.vx, grant.vy);
  }
  stepMotion(probe.client, probe.held);
  const { x, y, vx, vy } = probe.client;
  sample.motion = { x, y, vx, vy };
  return sample;
}
function advance(probe, count = 1) {
  for (let i = 0; i < count; i++) {
    probe.actor.field.tick++;
    advanceMovementStream(probe.world, probe.actor);
  }
}
