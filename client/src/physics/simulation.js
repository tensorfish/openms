import {
  detachGround,
  MAX_COORDINATE,
  prepareSegments,
  projectGround,
} from "./geometry.js";
import { airContacts, dropTarget, groundContacts } from "./contacts.js";
import { airVelocity, floatVelocity, groundVelocity } from "./dynamics.js";
import {
  captureLadder,
  climb,
  prepareLadders,
  releaseLadder,
} from "./ladders.js";
import {
  createDiagnostics,
  prepareBlocked,
  prepareSettings,
} from "./settings.js";
import { prepareWaterAreas, updateEnvironment } from "./environment.js";
import { prepareBounds } from "./bounds.js";

/** Catch-up bound is browser policy; original 009b195f returns the30ms quantum. */
const MAX_CATCH_UP = 8;
const QUANTUM_MS = 30;
const SECONDS = QUANTUM_MS / 1000;
/** Provisional offline held-key cadence; 009b1d3d proves impulses, not repeat timing. */
const HELD_BUOYANT_JUMP_MS = 300;
const INPUT_KEYS = [
  "left",
  "right",
  "up",
  "down",
  "jump",
  "attack",
  "jumpPressed",
];

/** Bounded collision scratch is allocated once, never while resolving contacts. */
function createContactScratch() {
  return {
    previousX: 0,
    previousY: 0,
    x: 0,
    y: 0,
    fraction: 0,
    segment: null,
    first: null,
    last: null,
    pendingAir: false,
    remainingMs: 0,
    entryX: 0,
    entryY: 0,
    entryVx: 0,
    entryVy: 0,
  };
}

/** Reject invalid source coordinates before clamping to the map bounds. */
function validateSpawn(spawn) {
  if (!Number.isFinite(spawn.x) || !Number.isFinite(spawn.y)) {
    throw new Error("Nonfinite simulation spawn");
  }
  if (
    Math.abs(spawn.x) > MAX_COORDINATE ||
    Math.abs(spawn.y) > MAX_COORDINATE
  ) {
    throw new Error("Simulation spawn exceeds supported coordinate range");
  }
}

/** 009cbeb8/009cbb9f: preallocated terminal-speed quanta and one landing outcome.
 * 00b3eaf0=600000;00b3e3b0=1/30. FieldLimit0x100000 suppresses falling damage. */
function createLandingState(map, settings) {
  return {
    terminalTicks: 0,
    thresholdTicks: Math.trunc(600000 / settings.fallSpeed / 30),
    forbidden: ((map.fieldLimit ?? 0) & 0x100000) !== 0,
    sequence: 0,
    amount: 0,
    facing: 1,
  };
}

/** Retain unmodified force coefficients for noncompounding skill updates. */
function createEffectiveSettings(world) {
  const settings = prepareSettings(world);
  settings.baseForceScale = settings.forceScale;
  settings.baseFriction = settings.friction;
  settings.baseDrag = settings.drag;
  return settings;
}

function createWorldMovement() {
  return { wingsX: 0, form: null, equipmentFs: 1, equipmentSwim: 100 };
}

/** Validate contract physics metadata and allocate all reusable state before play.
 * Coordinates are original world pixels at the avatar's feet. */
export function createSimulation(world, spawn) {
  validateSpawn(spawn);
  const effectiveSettings = createEffectiveSettings(world);
  const geometry = prepareSegments(world.footholds);
  if (geometry.segments.length === 0) {
    throw new Error("Map has no playable foothold geometry");
  }
  const ladders = prepareLadders(world.ladders);
  const bounds = prepareBounds(geometry.segments, world.map);
  const x = Math.max(bounds.left, Math.min(bounds.right, spawn.x));
  const y = Math.max(bounds.top, Math.min(bounds.bottom, spawn.y));
  const sim = {
    x,
    y,
    vx: 0,
    vy: 0,
    previousX: x,
    previousY: y,
    state: "air",
    facing: 1,
    action: "jump",
    crouching: false,
    footholdId: 0,
    ladderId: 0,
    foothold: null,
    ladder: null,
    seat: null,
    position: 0,
    speed: 0,
    contactLayer: 7,
    contactGroup: 0,
    spaceGroup: geometry.spaceGroup,
    horizontalInput: 0,
    verticalInput: 0,
    worldMovement: createWorldMovement(),
    fieldLimit: world.map.fieldLimit ?? 0,
    contactScratch: createContactScratch(),
    landing: createLandingState(world.map, effectiveSettings),
    ignoredFootholdId: 0,
    geometry,
    ladders,
    bounds,
    accumulatorMs: 0,
    accumulatorError: 0,
    groundJumpSequence: 0,
    jumpRepeatMs: 0,
    movementLocked: false,
    advancing: false,
    movementMode: "air",
    baseMode: world.map.swim ? "swim" : world.map.fly ? "fly" : "air",
    waterAreas: prepareWaterAreas(world.map),
    effectiveSettings,
    blocked: prepareBlocked(world),
    diagnostics: createDiagnostics(),
  };
  updateEnvironment(sim);
  sim.state = sim.movementMode;
  updateAction(sim);
  return sim;
}

/** Same-map travel preserves the simulation identity and sole fixed clock.
 * Clear contacts/velocity, not gameplay locks, diagnostic history or elapsed backlog. */
export function relocateSimulation(sim, arrival) {
  if (
    !Number.isFinite(arrival.x) ||
    !Number.isFinite(arrival.y) ||
    Math.abs(arrival.x) > MAX_COORDINATE ||
    Math.abs(arrival.y) > MAX_COORDINATE
  ) {
    throw new Error("Invalid simulation relocation");
  }
  // Presentation discontinuity identity; never an input or a physics coefficient.
  sim.relocationSequence = ((sim.relocationSequence ?? 0) + 1) >>> 0;
  sim.x = Math.max(sim.bounds.left, Math.min(sim.bounds.right, arrival.x));
  sim.y = Math.max(sim.bounds.top, Math.min(sim.bounds.bottom, arrival.y));
  sim.previousX = sim.x;
  sim.previousY = sim.y;
  sim.vx = 0;
  sim.vy = 0;
  sim.seat = null;
  sim.foothold = null;
  sim.footholdId = 0;
  sim.ladder = null;
  sim.ladderId = 0;
  sim.position = 0;
  sim.speed = 0;
  sim.contactLayer = 7;
  sim.contactGroup = 0;
  // Relocation clears actor contacts, not the current field's group selection.
  sim.spaceGroup = sim.geometry.spaceGroup;
  sim.horizontalInput = 0;
  sim.ignoredFootholdId = 0;
  sim.crouching = false;
  sim.jumpRepeatMs = 0;
  sim.landing.terminalTicks = 0;
  sim.landing.amount = 0;
  sim.contactScratch.pendingAir = false;
  sim.contactScratch.segment = null;
  sim.contactScratch.first = null;
  sim.contactScratch.last = null;
  updateEnvironment(sim);
  sim.state = sim.movementMode;
  updateAction(sim);
  return sim;
}

/** Local acceptance of an authored map seat; the immutable point is borrowed.
 * 00536517 supplies its original position. Leaving resumes normal collision. */
export function setSimulationSeat(sim, seat) {
  if (seat !== null) {
    validateSpawn(seat);
    if (sim.state !== "ground") {
      throw new Error("A map seat requires ground contact");
    }
    sim.seat = seat;
    sim.x = seat.x;
    sim.y = seat.y;
    sim.previousX = seat.x;
    sim.previousY = seat.y;
    sim.vx = 0;
    sim.vy = 0;
    sim.speed = 0;
    sim.horizontalInput = 0;
    sim.crouching = false;
    sim.action = "sit";
    return;
  }
  if (!sim.seat) return;
  sim.seat = null;
  detachGround(sim);
  updateAction(sim);
}

/** Original 007a6353: detach contact, enter air, merge requested px/s components.
 *  Grounded motion starts from zero; airborne motion keeps stronger aligned speed.
 *  Clearing the separate browser ladder reference maps the same air transition.
 *  `onBeforeImpulse(sim, vx, vy)` runs with the pre-merge state still intact and must
 *  not mutate it: an authority uses it to publish the exact divert it is about to
 *  apply, so it receives the same simulation and vector that are merged here.
 *  This single entry point is the only place an external impulse is merged, so the
 *  replayed client segment and the authoritative segment share one implementation. */
export function applyExternalImpulse(sim, vx, vy, onBeforeImpulse = null) {
  if (!Number.isFinite(vx) || !Number.isFinite(vy)) {
    throw new Error("Invalid external motion impulse");
  }
  // Climbing characters never get knocked off ladders/ropes by external impulses
  // (mob body contact, authored hit knockback, skill rushes).  Applying an impulse
  // here would tear sim.ladder away from the climb animation mid-climb.  The
  // caller is responsible for damage/flash/fear separately — this gate only
  // protects the climb state from motion disturbance.
  if (sim.state === "ladder") return;
  if (onBeforeImpulse !== null) onBeforeImpulse(sim, vx, vy);
  sim.seat = null;
  if (sim.state === "ground") {
    sim.vx = 0;
    sim.vy = 0;
  }
  detachGround(sim);
  sim.ladder = null;
  sim.ladderId = 0;
  sim.crouching = false;
  sim.vx = mergeImpulse(sim.vx, vx);
  sim.vy = mergeImpulse(sim.vy, vy);
  updateAction(sim);
}

/** 007a6353 comparisons: opposing velocity adds, never blindly overwrites. */
function mergeImpulse(current, requested) {
  if (requested < 0 && current > requested) {
    return Math.max(requested, requested + current);
  }
  if (requested > 0 && current < requested) {
    return Math.min(requested, requested + current);
  }
  return current;
}

/** Mutate reusable state/input; retain overload backlog for subsequent calls.
 * onStep receives each executed quantum, never RAF elapsed; reentry is forbidden.
 * Held-key repeat scheduling is local policy, distinct from the immediate edge. */
export function advanceSimulation(sim, input, elapsedMs, onStep) {
  validateInput(input, elapsedMs);
  if (onStep !== undefined && typeof onStep !== "function") {
    throw new Error("Simulation step consumer must be a function");
  }
  if (sim.advancing) throw new Error("Simulation advance cannot reenter");
  if (sim.diagnostics.fault) return sim;
  const adjusted = elapsedMs - sim.accumulatorError;
  const elapsed = sim.accumulatorMs + adjusted;
  if (!Number.isFinite(elapsed) || elapsed > Number.MAX_SAFE_INTEGER) {
    throw new Error("Simulation elapsed time exceeds exact millisecond range");
  }
  sim.accumulatorError = elapsed - sim.accumulatorMs - adjusted;
  sim.accumulatorMs = elapsed;
  sim.advancing = true;
  try {
    for (
      let steps = 0;
      steps < MAX_CATCH_UP && sim.accumulatorMs >= QUANTUM_MS;
      steps++
    ) {
      step(sim, input);
      sim.accumulatorMs -= QUANTUM_MS;
      sim.diagnostics.ticks++;
      sim.diagnostics.simulatedMs += QUANTUM_MS;
      if (sim.diagnostics.fault) break;
      if (onStep) onStep(QUANTUM_MS);
    }
  } finally {
    sim.advancing = false;
    sim.diagnostics.backlogMs = sim.accumulatorMs;
    sim.diagnostics.overload = sim.accumulatorMs >= QUANTUM_MS;
    if (sim.diagnostics.overload) sim.diagnostics.overloadCount++;
  }
  return sim;
}

function validateInput(input, elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new Error(
      "Simulation elapsed milliseconds must be finite and nonnegative",
    );
  }
  for (const key of INPUT_KEYS) {
    if (typeof input[key] !== "boolean") {
      throw new Error("Simulation input must contain booleans");
    }
  }
}

function step(sim, input) {
  sim.previousX = sim.x;
  sim.previousY = sim.y;
  const landing = sim.landing;
  landing.amount = 0;
  landing.terminalTicks =
    sim.vy >= sim.effectiveSettings.fallSpeed ? landing.terminalTicks + 1 : 0;
  if (sim.seat) return;
  updateEnvironment(sim);
  const horizontal = sim.movementLocked
    ? 0
    : Number(input.right) - Number(input.left);
  sim.horizontalInput = horizontal;
  const vertical = sim.movementLocked
    ? 0
    : Number(input.down) - Number(input.up);
  if (horizontal !== 0) sim.facing = horizontal;
  sim.verticalInput = vertical;
  sim.crouching =
    !sim.movementLocked &&
    sim.state === "ground" &&
    input.down &&
    horizontal === 0;
  scheduleJump(sim, input, horizontal);
  if (sim.state === "ladder") climb(sim, vertical);
  else integrate(sim, sim.crouching ? 0 : horizontal, vertical);
  captureLadder(sim, vertical);
  updateAction(sim);
  if (!Number.isFinite(sim.x + sim.y + sim.vx + sim.vy)) {
    sim.diagnostics.fault = "nonfinite-motion";
  }
}

function integrate(sim, direction, vertical) {
  if (sim.foothold) {
    const previous = sim.speed;
    const startPosition = sim.position;
    sim.speed = groundVelocity(sim, direction, SECONDS);
    sim.position += (previous + sim.speed) * SECONDS * 0.5;
    groundContacts(sim, SECONDS, startPosition, previous);
    if (sim.contactScratch.pendingAir) {
      airContacts(sim, SECONDS, sim.vx, sim.vy);
    }
  } else {
    const vx = sim.vx;
    const vy = sim.vy;
    sim.state = sim.movementMode;
    if (sim.state === "air") airVelocity(sim, direction, SECONDS);
    else floatVelocity(sim, direction, vertical, SECONDS);
    // 009b2d18: descending Wings velocity = rank.x * global jumpSpeed /1000.
    if (
      !(sim.fieldLimit & 2) &&
      sim.worldMovement.wingsX > 0 &&
      vy > 0 &&
      sim.state === "air"
    ) {
      sim.vy =
        (sim.worldMovement.wingsX * sim.effectiveSettings.baseJumpSpeed) / 1000;
    }
    sim.x += (vx + sim.vx) * SECONDS * 0.5;
    sim.y += (vy + sim.vy) * SECONDS * 0.5;
    airContacts(sim, SECONDS, vx, vy);
  }
}

/** Held ground/ladder requests retry when permissible; buoyant repeats wait 300 ms.
 * Ordinary airborne edges are consumed immediately, never buffered for landing. */
function scheduleJump(sim, input, direction) {
  const pressed = input.jumpPressed;
  input.jumpPressed = false;
  sim.jumpRepeatMs = Math.max(0, sim.jumpRepeatMs - QUANTUM_MS);
  if (!input.jump) sim.jumpRepeatMs = 0;
  // 0094c3e4: the independent JUMP bit blocks even unboosted jumps.
  if (sim.fieldLimit & 1) return;
  if (sim.movementLocked || (!pressed && !input.jump)) return;
  const buoyant =
    !sim.foothold && sim.state !== "ladder" && sim.movementMode !== "air";
  if (!pressed && buoyant && sim.jumpRepeatMs > 0) return;
  if (buoyant) sim.jumpRepeatMs = HELD_BUOYANT_JUMP_MS;
  acceptJump(sim, input, direction);
}

function acceptJump(sim, input, direction) {
  if (sim.state === "ladder") {
    if (direction === 0) return;
    releaseLadder(sim);
    sim.vx = direction * sim.effectiveSettings.walkSpeed * 1.3;
    const scale = sim.movementMode === "air" ? 0.5 : 0.3;
    sim.vy = -sim.effectiveSettings.jumpSpeed * scale;
    return;
  }
  if (!sim.foothold) {
    floatJump(sim, direction);
    return;
  }
  if (input.down) {
    beginDrop(sim);
    return;
  }
  projectGround(sim);
  const speed = sim.effectiveSettings.walkSpeed;
  if (direction * sim.vx < speed * 0.8) sim.vx += direction * speed * 0.8;
  if (direction * sim.vx > speed) sim.vx = direction * speed;
  sim.y = Math.floor(sim.y - 1);
  const scale = sim.movementMode === "air" ? 1 : 0.7;
  sim.vy = -sim.effectiveSettings.jumpSpeed * scale;
  sim.crouching = false;
  // Accepted normal ground jumps notify presentation without changing integration.
  if (sim.movementMode === "air") {
    sim.groundJumpSequence = (sim.groundJumpSequence + 1) >>> 0;
  }
  detachGround(sim);
}

/** 009b1d3d: repeated buoyant jumps; fly impulse has its own WZ reduction. */
function floatJump(sim, direction) {
  const g = sim.effectiveSettings;
  if (sim.movementMode === "swim") sim.vy = -g.swimSpeed * 5;
  if (sim.movementMode === "fly") {
    sim.vy = -g.flyJumpDec * g.flySpeed * 5;
    if (direction !== 0) sim.vx *= 2;
  }
}

function beginDrop(sim) {
  // 0094c4f8 checks the field's independent no-downward-jump bit.
  if (sim.fieldLimit & 0x20000 || sim.foothold.properties.forbidFallDown) {
    return;
  }
  const target = dropTarget(sim);
  if (!target) return;
  sim.ignoredFootholdId = sim.foothold.id;
  sim.y = Math.floor(sim.y - 1);
  sim.vx = 0;
  // Original 009b1c51 / 00b3e3a0, not a tuned browser impulse.
  sim.vy = -0.35355339 * sim.effectiveSettings.jumpSpeed;
  sim.crouching = false;
  sim.groundJumpSequence = (sim.groundJumpSequence + 1) >>> 0;
  detachGround(sim);
}

function updateAction(sim) {
  if (sim.seat) {
    sim.action = "sit";
    return;
  }
  if (sim.state === "ladder") {
    sim.action = sim.ladder.ladder ? "ladder" : "rope";
  } else if (sim.state === "swim" || sim.state === "fly") sim.action = "fly";
  else if (sim.state !== "ground") sim.action = "jump";
  else if (sim.crouching) sim.action = "prone";
  // 00950555 → 00936d99 selects grounded walk from horizontal intent, not
  // collision-resolved speed; an idle sliding avatar likewise keeps its idle pose.
  else sim.action = sim.horizontalInput === 0 ? "stand1" : "walk1";
}

/** Allocate only on explicit inspection, never from the fixed-step loop. */
export function snapshotSimulation(sim) {
  return {
    x: sim.x,
    y: sim.y,
    vx: sim.vx,
    vy: sim.vy,
    state: sim.state,
    previousX: sim.previousX,
    previousY: sim.previousY,
    accumulatorMs: sim.accumulatorMs,
    footholdId: sim.footholdId,
    ladderId: sim.ladderId,
    seat: sim.seat ? { ...sim.seat } : null,
    ignoredFootholdId: sim.ignoredFootholdId,
    contactLayer: sim.contactLayer,
    contactGroup: sim.contactGroup,
    spaceGroup: sim.spaceGroup,
    bounds: { ...sim.bounds },
    facing: sim.facing,
    action: sim.action,
    crouching: sim.crouching,
    movementLocked: sim.movementLocked,
    jumpRepeatMs: sim.jumpRepeatMs,
    movementMode: sim.movementMode,
    effectiveSettings: { ...sim.effectiveSettings },
    blocked: [...sim.blocked],
    diagnostics: {
      ...sim.diagnostics,
      policies: [...sim.diagnostics.policies],
    },
  };
}
