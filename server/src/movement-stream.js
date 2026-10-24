import {
  settleDisconnectedMovement,
  advanceDisconnectedMovement,
} from "./movement-clock.js";
import { PROTOCOL, protocolError } from "../../shared/protocol.js";
import { applyMovementSettings } from "../../shared/movement-settings.js";
import {
  updateMovementConfiguration,
  movementConfiguration,
} from "./movement-configurations.js";
import {
  assignHeldInput,
  captureMotion,
  restoreMotion,
  stepMotion,
} from "../../shared/motion.js";
import { serverOwnsPosition } from "./motion-authority.js";
import { retainAttackInput } from "./attack-input.js";
import {
  applyMovementImpulses,
  awaitingMovementImpulse,
} from "./movement-impulses.js";
import { recordPeerMove } from "./peer-move-stream.js";

const POSITION_KEYS = ["x", "y", "vx", "vy", "footholdId", "ladderId"];
/** Numeric tolerance only; not a per-packet speed or terrain allowance. */
const EPSILON = 0.000001;

/** Only trusted lifecycle/actions/ability changes can establish a new trajectory. */
export function resetMovementStream(actor) {
  const previous = actor.movementStream;
  actor.movementStream = {
    epoch: (previous?.epoch ?? 0) + 1,
    tick: actor.field.tick,
    startedTick: actor.field.tick,
    steps: 0,
    grants: [],
    configurations: [],
    impulseSequence: 0,
    restoreImpulse: false,
    expired: false,
    connection: actor.connection,
    field: actor.field,
    owned: serverOwnsPosition(actor, actor.simulation),
    relocation: actor.simulation.relocationSequence ?? 0,
    checkpoint: captureMotion(actor.simulation),
  };
  actor.inputQueue.clear();
  updateMovementConfiguration(actor);
}

function changedMotion(actor, stream) {
  if (stream.owned) return false;
  const sim = actor.simulation;
  const state = stream.checkpoint;
  for (const key of POSITION_KEYS) {
    if (sim[key] !== state[key]) return true;
  }
  return false;
}

/** Only undo the temporary merge belonging to this field and position generation. */
function restoreAnnouncedImpulse(actor, stream) {
  if (
    stream?.restoreImpulse &&
    stream.field === actor.field &&
    stream.relocation === (actor.simulation.relocationSequence ?? 0) &&
    stream.owned === serverOwnsPosition(actor, actor.simulation)
  ) {
    const configuration = updateMovementConfiguration(actor);
    // The combat callback runs before merging its vector. Preserve the last
    // accepted path until the client names the exact step consuming that grant.
    restoreMotion(actor.simulation, stream.checkpoint);
    applyMovementSettings(actor.simulation, configuration);
    stream.restoreImpulse = false;
  }
}

/** Called after server actions, before admission/publication. Delay never resets this. */
export function synchronizeMovementStream(actor) {
  const stream = actor.movementStream;
  restoreAnnouncedImpulse(actor, stream);
  settleDisconnectedMovement(actor, stream);
  if (
    !stream ||
    stream.connection !== actor.connection ||
    stream.field !== actor.field ||
    stream.owned !== serverOwnsPosition(actor, actor.simulation) ||
    stream.relocation !== (actor.simulation.relocationSequence ?? 0) ||
    changedMotion(actor, stream)
  ) {
    resetMovementStream(actor);
  }
  updateMovementConfiguration(actor);
  return actor.movementStream;
}

/** Arrival time is not the movement deadline. Every complete step stays ordered. */
export function enqueueMovement(actor, message) {
  const stream = synchronizeMovementStream(actor);
  if (message.motionEpoch !== stream.epoch) return;
  if (stream.owned) {
    assignHeldInput(actor.input, message);
    actor.ackInputSeq = message.inputSeq;
    return;
  }
  if (actor.inputQueue.size >= PROTOCOL.INPUT_HISTORY) {
    throw protocolError("RATE_LIMITED");
  }
  const next = stream.tick + actor.inputQueue.size + 1;
  if (message.targetTick !== next || !message.motion) {
    throw protocolError("INVALID_MESSAGE");
  }
  message.receivedTick = actor.field.tick;
  actor.inputQueue.set(message.targetTick, message);
}

function matchesEndpoint(sim, motion) {
  return (
    Math.abs(sim.x - motion.x) <= EPSILON &&
    Math.abs(sim.y - motion.y) <= EPSILON &&
    Math.abs(sim.vx - motion.vx) <= EPSILON &&
    Math.abs(sim.vy - motion.vy) <= EPSILON
  );
}

/** Shared physics proves speed, jump/ladder eligibility and every terrain contact.
 * No reported coordinate, velocity, contact or ability is installed into authority. */
function acceptStep(world, actor, sample) {
  const stream = actor.movementStream;
  const sim = actor.simulation;
  const configuration = movementConfiguration(actor, sample.motionConfig);
  if (!configuration || !applyMovementImpulses(actor, sample.impulses)) {
    restoreMotion(sim, stream.checkpoint);
    world.faultMotion(actor, { position: 0, velocity: 0, elapsedMs: 0 });
    return false;
  }
  applyMovementSettings(sim, configuration);
  assignHeldInput(actor.input, sample);
  // Local action animation may restrict movement before its command is admitted.
  // Restriction cannot grant movement; forced server actions use a separate epoch.
  sim.movementLocked = sample.movementLocked;
  stepMotion(sim, actor.input);
  if (!matchesEndpoint(sim, sample.motion)) {
    const position = Math.hypot(
      sim.x - sample.motion.x,
      sim.y - sample.motion.y,
    );
    const velocity = Math.hypot(
      sim.vx - sample.motion.vx,
      sim.vy - sample.motion.vy,
    );
    restoreMotion(sim, stream.checkpoint);
    world.faultMotion(actor, {
      position,
      velocity,
      elapsedMs: PROTOCOL.TICK_MS,
    });
    return false;
  }
  actor.currentInputSeq = sample.inputSeq;
  actor.ackInputSeq = sample.inputSeq;
  actor.lastInputTick = actor.field.tick;
  actor.lastAdoptedTick = actor.field.tick;
  retainAttackInput(actor, { ...sample, targetTick: actor.field.tick });
  stream.tick = sample.targetTick;
  stream.steps++;
  if (stream.checkpoint.action !== sim.action) {
    actor.actionStartTick = actor.field.tick;
  }
  stream.checkpoint = captureMotion(sim);
  recordPeerMove(actor, actor.field);
  return true;
}

/** World time supplies credit, never client timestamps. A burst catches up at most four
 * steps per world tick; withholding reports cannot buy faster-than-elapsed movement. */
export function advanceMovementStream(world, actor) {
  const stream = synchronizeMovementStream(actor);
  if (stream.owned) {
    stepMotion(actor.simulation, actor.input);
    return;
  }
  if (actor.connection === null) {
    advanceDisconnectedMovement(actor);
    return;
  }
  if (!movementReady(actor)) return;
  if (!movementClockAvailable(world, actor)) return;
  const available = actor.field.tick - stream.startedTick;
  for (let count = 0; count < PROTOCOL.MAX_CATCH_UP; count++) {
    if (stream.steps >= available) break;
    const sample = actor.inputQueue.get(stream.tick + 1);
    if (!sample || sample.inputSeq > (actor.movementBarrier ?? Infinity)) break;
    if (awaitingMovementImpulse(actor, sample)) break;
    actor.inputQueue.delete(sample.targetTick);
    const accepted = acceptStep(world, actor, sample);
    applyMovementSettings(actor.simulation, stream.configurations.at(-1));
    if (!accepted) break;
  }
  actor.input.jumpPressed = false;
  actor.input.attackPressed = false;
}

function movementReady(actor) {
  return actor.connection?.data?.ready !== false;
}

/** A slow or stopped client clock is bounded too. Network exhaustion requests
 * recovery, not a cheating verdict or an indefinitely suspended shared-world actor. */
function movementClockAvailable(world, actor) {
  const stream = actor.movementStream;
  if (stream.expired) return false;
  if (
    actor.field.tick - stream.startedTick - stream.steps <=
    PROTOCOL.INPUT_HISTORY
  ) {
    return true;
  }
  stream.expired = true;
  world.expireMovement(actor);
  return false;
}

/** Small wire identity shared by baseline and ordinary acknowledgement frames. */
export function movementStreamView(actor) {
  const stream = synchronizeMovementStream(actor);
  return {
    motionEpoch: stream.epoch,
    motionTick: stream.tick,
    motionConfig: stream.configurations.at(-1).version,
  };
}
