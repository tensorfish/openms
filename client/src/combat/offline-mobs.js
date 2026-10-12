import {
  overlaps,
  placeBody,
  rectangleState,
  sweepBody,
} from "../world/life-geometry-numeric.js";
import { knockbackChance } from "./combat-knockback.js";
import { MOB_HIT } from "./mob-hit.js";
import { mobFlipped, mobMovementMetadata } from "./mob-movement-metadata.js";
import {
  createMobFlight,
  moveMobFlightRecoil,
  resetMobFlight,
  stepMobFlight,
  stepMobFlightClock,
} from "./offline-mob-flight.js";
import {
  createMobSkillStatus,
  clearMobSkillStatus,
  stepMobSkillStatus,
  mobSkillMovementScale,
  hasMobStatus,
} from "./mob-skill-status.js";

export const MOB_POLICY = Object.freeze({
  authority: "offline-local-policy",
  // Aligned with MapleNecrocer Mob.cs line 149: MoveSpeed = (1 + speed/100) * 2 px/frame
  // At 60 fps this gives (1+0/100)*2*60 = 120 px/s when WZ speed is 0.
  walkPixelsPerSecondAtSpeedZero: 120,
  respawnMs: 10000,
  attackCooldownMs: 2400,
  recoveryMs: 5000,
  maxTransitions: 32,
  specialMovement:
    "stationary: original controller0 or unavailable ground contact",
  flightRoaming:
    "native controller3 waypoints, forces, speed and bounds; deterministic local seeds and single-player aggro admission",
  mobTime: "preserved, not interpreted as respawn seconds",
});
/** 00663070..0066313e: new-spawn mode-2 alpha0→255 over800ms.
 * Existing-enter mode-1 is opaque; death alpha belongs to the WZ die frames. */
export const MOB_APPEARANCE = Object.freeze({ spawnMs: 800 });
/** 0066bb1a/009bbdfd: ordinary hit velocity, braking force and base ability mass.
 *  Re-exported so the authority and the attacker's local prediction share one source. */
export { MOB_HIT } from "./mob-hit.js";
/** Aggro lifetime: 5s after last hit, matching MapleStory's short mob focus window.
 *  First hit sets ticks=ceil(5000/5000/2^1)=1 tick → full 5s of chase.  Each
 *  additional hit refreshes the lifetime; the exponential decay makes repeat
 *  hits more impactful than single-chip damage. */
export const MOB_AGGRO = Object.freeze({
  updateMs: 5000,
  damageLifetimeMs: 5000,
});
/** Mob jump physics — EXACTLY matched to MapleNecrocer JumperSprite.DoMove().
 *
 *  MapleNecrocer uses per-frame Euler integration (fixed ~60 fps):
 *    VelocityY = -JumpHeight      ← initial velocity (misnamed! it's velocity, not height)
 *    Y += VelocityY               (add px/frame directly to Y, no Δt multiply)
 *    VelocityY += JumpSpeed       ← gravity acceleration, per-frame
 *
 *  Converting to OpenMS's SECONDS-based variable-timestep model:
 *    MapleNecrocer's VelocityY (px/frame) → OpenMS vy = VelocityY × 60 (px/s)
 *    MapleNecrocer's acceleration (px/frame²) → OpenMS gravity = accel × 60² (px/s²)
 *
 *  With MapleNecrocer's Mob.cs values (line 192-193):
 *    JumpHeight (misnamed, initial vel) = 9  →  jumpSpeed = -9 × 60 = -540 px/s
 *    JumpSpeed (gravity per frame)       = 0.6 →  gravity   = 0.6 × 3600 = 2160 px/s²
 *    MaxFallSpeed                        = 8   →  terminal vel = 8 × 60 = 480 px/s
 *
 *  Frame-by-frame trace (MapleNecrocer):
 *    Frame 1: vy=-9, Y-=9,     vy+=0.6 → -8.4
 *    Frame 2: vy=-8.4, Y-=8.4, vy+=0.6 → -7.8
 *    ...
 *    Frame 15: vy=-0.6, Y-=0.6, vy+=0.6 → 0 → still jsJumping (check is vy>0)
 *    Frame 16: vy=0, Y+=0,     vy+=0.6 → 0.6 → jsFalling
 *    Ascent sum: -9 + -8.4 + ... + -0.6 = -72 px total height gained
 *
 *  OpenMS validation: v₀²/(2a) = 540²/(2×2160) = 291600/4320 = 67.5 px. Close enough
 *  (discrepancy because MapleNecrocer does Y update BEFORE velocity update each frame). */
export const MOB_JUMP = Object.freeze({
  /** Gravity in px/s². Positive accelerates downward (y grows downward). */
  gravity: 2160,
  /** Jump launch velocity in px/s (negative = upward). MapleNecrocer's JumpHeight field
   *  is a misnomer — it is actually the initial upward velocity in px/frame. */
  jumpSpeed: -540,
  /** Minimum foothold edge gap tolerated when landing (px). */
  landingTolerance: 8,
  /** AI decision interval random ranges (ms).
   *  MapleNecrocer rolls a decision chance every frame (~16ms), so decisions happen
   *  roughly every 800ms on average.  We batch via a timer but keep the same cadence. */
  idleMinMs: 400,
  idleRangeMs: 800, // 400..1200
  walkMinMs: 800,
  walkRangeMs: 1600, // 800..2400
  /** Probability thresholds — roll 0..99 each decision.
   *  MapleNecrocer's per-frame roll (~1% move, 0.5% stand, 0.5% jump per frame)
   *  means move dominates the overall behaviour. */
  jumpChanceRoll: 10, // 0..9 jumps (10%)
  walkChanceRoll: 60, // 10..59 walks (50%) — after jump branch
});
const MAX_MOBS = 4096;
const MAX_ACTIONS = 128;
const MAX_FRAMES = 1024;

// Life geometry is shared with the browser's own presentation; the authority half of this
// module must not be the only home for a rectangle test the online graph is allowed to use.
export { overlaps, rectangleState };

/** Compile original frame delays once; unknown timing remains frozen.
 *  Mob move actions receive a ping-pong frame expansion so the authored
 *  forward-sway cycle (0→1→2→3→0) becomes a natural back-and-forth sway
 *  (0→1→2→3→2→1→0). This eliminates the hard snap at the end of a linear
 *  loop and makes per-frame origin shifts (body offset animation in Mob.wz)
 *  look like smooth walking motion rather than sprite jitter. */
export function compileActions(template) {
  const actions = Object.create(null);
  const entries = Object.entries(template.actions);
  validateMobInfo(template.info);
  if (entries.length > MAX_ACTIONS) throw new Error("Mob action limit");
  for (const [name, source] of entries) {
    if (!source.frames.length || source.frames.length > MAX_FRAMES) {
      throw new Error("Mob frame limit");
    }
    // Ping-pong expand mob move actions with ≥3 frames:
    // [f0, f1, f2, f3] → [f0, f1, f2, f3, f2, f1, f0]  (2n−1 entries)
    // Full symmetric loop so end→start wraps seamlessly at f0.
    // stand/hit/die keep their natural linear loop — they don't sway.
    // We intentionally do NOT gate on source.timingKnown: that flag reports
    // whether frame delays are trustworthy, not whether the artwork was authored
    // as a forward-only loop.  MapleStory mob move actions *all* look like a
    // forward-only sway in the WZ data (zigzag flag is rarely honoured), so we
    // always synthesize the back-and-forth loop for ≥3-frame mob move actions.
    const isPingPong =
      template.kind === "mob" &&
      name === "move" &&
      source.frames.length > 2;
    const frames = isPingPong
      ? expandPingPong(source.frames)
      : source.frames;
    const ends = new Float64Array(frames.length);
    let duration = 0;
    for (let index = 0; index < frames.length; index++) {
      const delay = frames[index].delayMs;
      validateBody(frames[index].body);
      if (source.timingKnown && (!Number.isFinite(delay) || delay <= 0)) {
        throw new Error("Invalid mob delay");
      }
      duration += source.timingKnown ? delay : 0;
      ends[index] = duration;
    }
    actions[name] = { ends, duration, frames };
  }
  return actions;
}

function expandPingPong(frames) {
  const n = frames.length;
  const out = new Array(2 * n - 1);
  for (let i = 0; i < n; i++) out[i] = frames[i];
  for (let i = 1; i < n; i++) out[n + i - 1] = frames[n - 1 - i];
  return out;
}

function validateBody(body) {
  if (!body) return;
  if (
    ![body.left, body.top, body.right, body.bottom].every(Number.isFinite) ||
    body.left > body.right ||
    body.top > body.bottom
  ) {
    throw new Error("Invalid original mob body");
  }
}

function validateMobInfo(info) {
  for (const key of [
    "maxHP",
    "maxMP",
    "PADamage",
    "PDDamage",
    "PDRate",
    "MDRate",
    "MADamage",
    "level",
    "acc",
    "eva",
    "exp",
    "pushed",
    "hpRecovery",
    "mpRecovery",
  ]) {
    if (
      info[key] !== undefined &&
      (!Number.isSafeInteger(info[key]) || info[key] < 0)
    ) {
      throw new Error("Invalid original mob statistic");
    }
  }
  if (
    info.speed !== undefined &&
    (!Number.isSafeInteger(info.speed) || Math.abs(info.speed) > 1000000)
  ) {
    throw new Error("Invalid original mob speed");
  }
}

/** Stable state exists for every authored mob, including explicitly inactive records. */
export function createMobs(life, simulation) {
  if (
    !life ||
    !Array.isArray(life.placements) ||
    life.placements.length > MAX_MOBS
  ) {
    throw new Error("Invalid offline mob placements");
  }
  const definitions = new Map();
  const mobs = [];
  const ids = new Set();
  for (const record of life.placements) {
    if (record.kind !== "mob") continue;
    if (![record.authored.x, record.authored.y].every(Number.isSafeInteger)) {
      throw new Error("Invalid mob origin");
    }
    if (ids.has(record.id)) throw new Error("Duplicate local mob identity");
    ids.add(record.id);
    const template = life.templates[record.template];
    if (!template || template.kind !== "mob") {
      throw new Error("Missing mob template");
    }
    if (!definitions.has(record.template)) {
      definitions.set(
        record.template,
        normalizeMobTemplate(template, compileActions(template)),
      );
    }
    mobs.push(
      createMob(record, template, definitions.get(record.template), simulation),
    );
  }
  return mobs;
}

/** Normalize inputs already checked by compileActions/validateMobInfo, before play. */
function normalizeMobTemplate(template, actions) {
  const info = template.info;
  const maxHP = info.maxHP ?? 0;
  const maxMP = info.maxMP ?? 0;
  const movement = mobMovementMetadata(info, actions);
  return {
    actions,
    movementType: movement.type,
    flySpeedPercent: movement.flySpeedPercent,
    canJump: movement.canJump,
    maxHP,
    maxMP,
    defaultAction:
      movement.type === 3
        ? "fly"
        : (template.defaultAction ?? Object.keys(actions)[0] ?? null),
    selectedSkills: template.combat?.allowedSkills ?? [],
    attacks: template.combat?.attacks ?? [],
    speed:
      (MOB_POLICY.walkPixelsPerSecondAtSpeedZero *
        Math.max(0, 100 + (info.speed ?? 0))) /
      100,
  };
}

/** Controller3 is airborne even when its authored placement names a foothold. */
function mobContact(authored, definition, geometry) {
  const foothold = geometry.byId.get(authored.fh) ?? null;
  if (definition.movementType === 3) {
    return { foothold: null, movement: "flying-patrol" };
  }
  const ground =
    foothold &&
    foothold.dx > 0 &&
    Number.isFinite(authored.rx0) &&
    Number.isFinite(authored.rx1) &&
    authored.rx0 <= authored.rx1;
  const movement =
    ground && definition.movementType > 0
      ? "ground-patrol"
      : "stationary-special";
  return { foothold, movement };
}

/** Preserve admission precedence: artwork, positive HP, then authored gates. */
function mobInactiveReason(record, template, definition) {
  if (!definition.defaultAction) return "unavailable-original-artwork";
  if (!definition.maxHP) return "unavailable-positive-original-maxHP";
  const authored = record.authored;
  if (
    authored.hide === 1 ||
    !!authored.limitedname ||
    template.info.inactive === 1
  ) {
    return "inactive-authored-gate";
  }
  return null;
}

/** Ground patrol starts on its original segment; special movement stays authored. */
function mobSpawn(authored, contact) {
  const { foothold, movement } = contact;
  let x = authored.x;
  let y = authored.y;
  if (movement === "ground-patrol") {
    x = Math.max(foothold.x1, Math.min(foothold.x2, x));
    y = groundY(foothold, x);
  }
  const facing = authored.f === 0 ? 1 : -1;
  return {
    x,
    y,
    previousX: x,
    previousY: y,
    facing,
    spawnFacing: facing,
    foothold,
    spawnFoothold: foothold,
    spawnX: x,
    spawnY: y,
    movement,
  };
}

/** Allocate every mutable timer and geometry scratch record before play. */
function mobInitialState(definition, inactiveReason) {
  const active = !inactiveReason;
  // Compute body width from the default action's first frame — used for
  // distance-based recoil: walk back bodyWidth*2 px when blocked at edge.
  const defaultBody =
    definition.actions[definition.defaultAction]?.frames[0]?.body;
  const bodyWidth = defaultBody
    ? defaultBody.right - defaultBody.left
    : 32; // safe fallback
  return {
    hp: definition.maxHP,
    mp: definition.maxMP,
    alive: active,
    visible: active,
    active,
    state: inactiveReason ?? "idle",
    inactiveReason,
    action: definition.defaultAction,
    actionMs: 0,
    frame: 0,
    stateMs: 0,
    respawnMs: 0,
    spawnMs: MOB_APPEARANCE.spawnMs,
    opacity: 1,
    cooldownMs: MOB_POLICY.attackCooldownMs,
    recoveryMs: 0,
    hitRemainingMs: 0,
    knockbackMs: 0,
    knockbackSpeed: 0,
    knockbackFacing: 0,
    knockbackDeceleration: MOB_HIT.deceleration,
    lastReaction: "none",
    aggro: {
      damageInstances: 0,
      expireStreak: 0,
      ticksRemaining: 0,
      updateMs: 0,
    },
    pendingAttack: null,
    attackFired: false,
    attackIndex: 0,
    body: rectangleState(),
    sweptBody: rectangleState(),
    attackBody: rectangleState(),
    delta: { x: 0, y: 0 },
    deaths: 0,
    lastDamage: 0,
    // Local-player attack timestamp: 0066b05e; expiry gate 006675a8/006689e3.
    nameRemainingMs: 0,
    nameLabel: null,
    presentation: null,
    fault: null,
    // Jump / airborne physics fields. All ground mobs start on the ground;
    // gravity and landing only activate when `onGround` flips false.
    vy: 0,
    onGround: true,
    /** Mob body width in px (from default action first frame). */
    bodyWidth,
    /** Countdown until next idle AI decision (ms). 0 = decide now. */
    jumpDecisionMs: 0,
    /** Countdown until next aggro behaviour roll (ms).  Aggro mobs also
     *  randomize stand/jump/chase instead of mindlessly chasing nonstop. */
    aggroDecisionMs: 0,
    /** Pixels remaining of edge recoil walk — walk back bodyWidth*2 px when
     *  blocked, then resume pursuit.  Distance-based so fast/slow mobs both
     *  get proportional recoil. */
    recoilPx: 0,
  };
}

function createMob(record, template, definition, simulation) {
  const contact = mobContact(record.authored, definition, simulation.geometry);
  const inactiveReason = mobInactiveReason(record, template, definition);
  const mob = {
    id: record.id,
    templateId: Number(template.originalId),
    record,
    template,
    ...definition,
    ...mobSpawn(record.authored, contact),
    ...mobInitialState(definition, inactiveReason),
    skillStatus: createMobSkillStatus(template.info),
    flight: createMobFlight(record, definition, simulation),
    // Access to all foothold segments so stepAirborneMob.FindBelow can pick
    // up any platform directly below the mob — not just the takeoff fh.
    _segments: simulation.geometry.segments,
  };
  updateMobBody(mob);
  return mob;
}

function groundY(segment, x) {
  return segment.y1 + ((x - segment.x1) * segment.dy) / segment.dx;
}

export function setMobAction(mob, name) {
  if (!mob.actions[name]) name = mob.defaultAction;
  if (mob.action === name) return;
  mob.action = name;
  mob.actionMs = 0;
  mob.frame = 0;
}

function advanceMobAction(mob, ms) {
  const action = mob.actions[mob.action];
  mob.actionMs += ms;
  if (!action.duration) {
    mob.frame = 0;
    return;
  }
  const once =
    !mob.alive ||
    mob.state === "spawning" ||
    mob.state === "hit" ||
    mob.state === "attack";
  const elapsed = once
    ? Math.min(action.duration - 0.001, mob.actionMs)
    : mob.actionMs % action.duration;
  for (let index = 0; index < action.ends.length; index++) {
    if (elapsed < action.ends[index]) {
      mob.frame = index;
      return;
    }
  }
}

export function updateMobBody(mob) {
  const local = mob.alive
    ? mob.actions[mob.action]?.frames[mob.frame]?.body
    : null;
  placeBody(mob.body, local, mob, mobFlipped(mob));
  mob.delta.x = mob.previousX - mob.x;
  mob.delta.y = mob.previousY - mob.y;
  sweepBody(mob.sweptBody, mob.body, mob.delta);
}

/** Preserve state offscreen; artwork residency never gates simulation. */
export function stepMob(mob, ms, target = null, onDamage = null) {
  mob.previousX = mob.x;
  mob.previousY = mob.y;
  if (!mob.active || mob.fault) return;
  mob.stateMs += ms;
  mob.nameRemainingMs = Math.max(0, mob.nameRemainingMs - ms);
  if (mob.spawnMs < MOB_APPEARANCE.spawnMs) {
    mob.spawnMs = Math.min(MOB_APPEARANCE.spawnMs, mob.spawnMs + ms);
    mob.opacity =
      Math.trunc((255 * mob.spawnMs) / MOB_APPEARANCE.spawnMs) / 255;
  }
  if (!mob.alive) {
    stepDeadMob(mob, ms);
    return;
  }
  stepMobSkillStatus(mob, ms, onDamage);
  mob.hitRemainingMs = Math.max(0, mob.hitRemainingMs - ms);
  stepMobAggro(mob, ms, target);
  mob.cooldownMs = Math.max(0, mob.cooldownMs - ms);
  finishMobPose(mob);
  stepMobMotion(mob, ms, target);
  if (mob.flight) stepMobFlightClock(mob.flight, ms);
  recoverMob(mob, ms);
  advanceMobAction(mob, ms);
  updateMobBody(mob);
}

function finishMobPose(mob) {
  if (
    mob.state === "spawning" &&
    mob.actions[mob.action].duration > 0 &&
    mob.stateMs >= mob.actions[mob.action].duration
  ) {
    mob.state = "idle";
  }
  if (mob.state === "hit" && mob.stateMs >= mob.actions[mob.action].duration) {
    mob.state = "idle";
  }
  if (
    mob.state === "attack" &&
    mob.stateMs >=
      Math.max(
        mob.actions[mob.action].duration,
        mob.pendingAttack.properties.attackAfter + 30,
      )
  ) {
    mob.state = "idle";
    mob.pendingAttack = null;
  }
}

/** Forced skill motion follows the admitted ground/free-flight controller. */
export function displaceMobSkill(mob, distance) {
  if (
    !mob.alive ||
    mob.movement === "stationary-special" ||
    mob.template.info.boss ||
    !Number.isFinite(distance)
  ) {
    return false;
  }
  moveMobRecoil(mob, distance);
  mob.pendingAttack = null;
  mob.attackFired = true;
  mob.state = "idle";
  setMobAction(mob, mob.flight ? "fly" : "stand");
  updateMobBody(mob);
  return true;
}

// ── Idle AI decision + jump physics (mirrors sdlms mob_logic_system) ────────────

/** Kick off a mob jump from the ground. Records the current horizontal
 *  patrol velocity so airborne flight can preserve it without touching aggro. */
function startMobJump(mob) {
  mob.vy = MOB_JUMP.jumpSpeed;
  mob.onGround = false;
  if (mob.actions.jump) setMobAction(mob, "jump");
  // Schedule immediate re-decision on landing — sdlms sets next_action_time = 0.
  mob.jumpDecisionMs = 0;
}

/** Find the foothold segment directly below (x, y) — faithfully mirrors
 *  MapleNecrocer Footholds.FindBelow() (L72..119).
 *
 *  OpenMS and MapleStory share the screen-y-down coordinate convention
 *  (larger y = lower on screen).  "Below" therefore means groundY >= y
 *  (the ground surface is at or below the mob's current y).
 *
 *  Iterates every segment whose x1..x2 contains x, computes its ground
 *  height at that x, and picks the one whose groundY >= y and is closest
 *  to y (smallest groundY among all qualifying candidates).  Returns
 *  { segment, groundY } or null if nothing catchable exists below.
 *
 *  No group/layer filtering — same as MapleNecrocer, which also picks up
 *  any segment that geometrically satisfies the condition.  Segments on
 *  different Z planes naturally have disjoint X ranges on valid maps. */
function findFootholdBelow(segments, x, y) {
  let best = null;
  for (const seg of segments) {
    if (seg.dx <= 0) continue; // skip vertical walls
    if (x < seg.x1 || x > seg.x2) continue;
    const gy = groundY(seg, x);
    // Ground must be at or below mob y (i.e. catch the fall).
    if (gy >= y - MOB_JUMP.landingTolerance) {
      if (!best || gy < best.groundY) best = { segment: seg, groundY: gy };
    }
  }
  return best;
}

/** Advance airborne physics — now faithfully mirrors MapleNecrocer's
 *  mob airborne behaviour instead of clamping everything to the takeoff
 *  foothold.
 *
 *  Three changes vs. the previous clamped version:
 *
 *  1. Horizontal motion is no longer clamped to fh.x1..fh.x2.  Only the
 *     authored patrol range rx0..rx1 gates it.  Otherwise the mob is
 *     physically incapable of leaving the foothold it jumped from — which
 *     is exactly the bug that prevented landing on adjacent platforms.
 *
 *  2. Aggro-chasing mobs glide toward the target during the jump.  The old
 *     code froze glideVx entirely when aggro was active, so chasing mobs
 *     leapt straight up/down and never closed distance horizontally.
 *
 *  3. Landing detection queries every segment via FindBelow instead of
 *     only the takeoff foothold.  This lets a mob land on an adjacent
 *     platform — exactly what MapleNecrocer does when it jumps between
 *     two footholds whose X ranges touch or overlap slightly.
 *
 *  Airtime and initial vy/gravity are unchanged from the current values
 *  (jumpSpeed -540 px/s, gravity 2160 px/s², ~0.5s airtime, ~67px peak). */
function stepAirborneMob(mob, ms, target) {
  const seconds = ms / 1000;
  mob.vy += MOB_JUMP.gravity * seconds;
  const previousY = mob.y;

  const authored = mob.record.authored;

  // Horizontal glide direction — patrol keeps facing, aggro steers at target.
  let glideVx = 0;
  if (target) {
    const dir = Math.sign(target.x - mob.x);
    if (dir !== 0) glideVx = dir * mob.speed;
  } else if (mob.movement === "ground-patrol") {
    glideVx = mob.facing * mob.speed;
  }
  // Keep facing in sync with glide direction — if aggro target flipped or
  // the mob started the jump in idle mode and only got aggro mid-air, we'd
  // otherwise end up with "face forward, body gliding backward".
  if (glideVx !== 0) mob.facing = Math.sign(glideVx);
  // Only clamp to authored patrol range — NOT takeoff foothold.
  let nx = mob.x + glideVx * seconds;
  nx = Math.max(authored.rx0, Math.min(authored.rx1, nx));

  mob.x = nx;
  mob.y = mob.y + mob.vy * seconds;

  // Landing detection: only on descent, FindBelow across ALL segments.
  if (mob.vy >= 0 && mob.y >= previousY) {
    const below = findFootholdBelow(mob._segments ?? [], mob.x, mob.y);
    if (below && mob.y >= below.groundY - MOB_JUMP.landingTolerance) {
      const seg = below.segment;
      mob.x = Math.max(seg.x1, Math.min(seg.x2, mob.x));
      mob.y = below.groundY;
      mob.foothold = seg; // ← can land on a DIFFERENT foothold
      mob.onGround = true;
      mob.vy = 0;
      if (mob.actions.move && glideVx !== 0) setMobAction(mob, "move");
      else setMobAction(mob, mob.actions.stand ? "stand" : mob.defaultAction);
      return;
    }
  }
}

/** Roll one idle AI decision for a ground mob with no aggro.
 *  Mirrors sdlms run_ai_decide: 18% jump, 42% patrol, 40% stand. */
function decideIdleMobAction(mob) {
  const roll = Math.floor(Math.random() * 100);
  const authored = mob.record.authored;

  // Jump branch — aligned with MapleNecrocer: per-frame ~0.5% jump roll means
  // roughly every 800ms.  10% chance per timer decision is close enough.
  if (mob.canJump && mob.actions.jump && roll < MOB_JUMP.jumpChanceRoll) {
    startMobJump(mob);
    // Short post-jump cooldown — jumps are only ~1s of airtime with the new
    // low-gravity physics, so we can re-decide quickly after landing.
    mob.jumpDecisionMs =
      MOB_JUMP.walkMinMs + Math.random() * MOB_JUMP.walkRangeMs;
    return;
  }

  // Patrol (walk) branch — 42%, requires ground-patrol movement + speed > 0.
  if (
    mob.movement === "ground-patrol" &&
    mob.speed > 0 &&
    mob.actions.move &&
    roll < MOB_JUMP.jumpChanceRoll + MOB_JUMP.walkChanceRoll
  ) {
    // Direction choice: favour turning around at range edges, else 50/50.
    let goRight;
    const margin = 6;
    if (mob.x <= authored.rx0 + margin) goRight = true;
    else if (mob.x >= authored.rx1 - margin) goRight = false;
    else goRight = Math.random() < 0.5;
    mob.facing = goRight ? 1 : -1;
    setMobAction(mob, "move");
    mob.jumpDecisionMs =
      MOB_JUMP.walkMinMs + Math.random() * MOB_JUMP.walkRangeMs;
    return;
  }

  // Stand (idle) fallback.
  if (mob.actions.stand) setMobAction(mob, "stand");
  else if (mob.defaultAction) setMobAction(mob, mob.defaultAction);
  mob.jumpDecisionMs =
    MOB_JUMP.idleMinMs + Math.random() * MOB_JUMP.idleRangeMs;
}

function stepMobMotion(mob, ms, target) {
  const movementScale = mobSkillMovementScale(mob);
  if (movementScale === 0) {
    if (hasMobStatus(mob, "freeze")) return;
    setMobAction(mob, mob.flight ? "fly" : "stand");
    return;
  }
  if (mob.knockbackMs > 0) {
    const seconds = Math.min(ms, mob.knockbackMs) / 1000;
    const before = mob.knockbackSpeed;
    mob.knockbackSpeed = Math.max(
      0,
      before - mob.knockbackDeceleration * seconds,
    );
    moveMobRecoil(
      mob,
      mob.knockbackFacing * ((before + mob.knockbackSpeed) / 2) * seconds,
    );
    mob.knockbackMs = Math.max(0, mob.knockbackMs - ms);
    return;
  }
  if (mob.state !== "idle") return;
  // Jump / airborne branch — runs before flight and ground-patrol so a mob
  // that leapt mid-patrol keeps its gravity until landing.
  if (!mob.flight && !mob.onGround) {
    stepAirborneMob(mob, ms, target);
    return;
  }
  if (mob.flight) {
    stepMobFlight(mob, ms, target, movementScale);
    setMobAction(mob, "fly");
    return;
  }
  stepGroundMob(mob, ms, target, movementScale);
}

function stepGroundMob(mob, ms, target, movementScale) {
  // Aggro path — mob has the target in sights.  We randomize behaviour every
  // 500–1000ms so the mob doesn't mindlessly chase nonstop: mostly chase,
  // occasionally stand or jump (if it can).  This mirrors MapleNecrocer's
  // per-frame Random.Next(200) roll which picks 50/100/150/199 for left/right/stand/jump.
  if (mob.movement === "ground-patrol" && mob.speed > 0) {
    if (mob.aggro.damageInstances > 0 || hasMobStatus(mob, "inert")) {
      // Recoil by distance — walk back bodyWidth*2 px from the edge, then retry.
      // Distance-based so both fast and slow mobs get proportional recoil.
      if (mob.recoilPx > 0) {
        const step = (mob.speed * ms * movementScale) / 1000;
        const dist = Math.min(step, mob.recoilPx);
        moveMob(mob, mob.facing * dist);
        mob.recoilPx -= dist;
        setMobAction(mob, "move");
        return;
      }

      mob.aggroDecisionMs = Math.max(0, mob.aggroDecisionMs - ms);
      if (mob.aggroDecisionMs === 0) {
        const roll = Math.floor(Math.random() * 100);
        if (mob.canJump && mob.actions.jump && roll < 10 && mob.onGround) {
          // 10% chance: jump toward the target
          startMobJump(mob);
          mob.facing = target ? Math.sign(target.x - mob.x) || mob.facing : mob.facing;
        } else if (roll < 30) {
          // 20% chance: just stand there a moment
          setMobAction(mob, "stand");
        }
        // else: default — chase toward target (handled below or by chaseMob call)
        mob.aggroDecisionMs = 500 + Math.random() * 500; // 500..1000ms next roll
      }

      // If we're standing (randomly), don't move this tick
      if (mob.action !== "stand") {
        chaseMob(mob, ms * movementScale, target);
      }
      return;
    }
  }

  // Idle AI scheduler: only runs when the mob is free of aggro/inert.
  mob.jumpDecisionMs = Math.max(0, mob.jumpDecisionMs - ms);
  if (mob.jumpDecisionMs === 0) {
    decideIdleMobAction(mob);
    // decideIdleMobAction schedules the next decision AND may launch a jump.
    // If it did jump, onGround is now false and stepMobMotion will take the
    // airborne branch next tick. Either way we're done here this tick.
    return;
  }

  // Physics execution between decisions — RESPECT the current action, don't
  // blindly overwrite a stand decision with patrol motion every tick.
  // Only the patrol ("move") action should execute horizontal movement.
  // Anything else (stand, jump, hit) stays put until the next decision.
  if (
    mob.action === "move" &&
    mob.movement === "ground-patrol" &&
    mob.speed > 0
  ) {
    const authored = mob.record.authored;
    if (mob.x <= authored.rx0) mob.facing = 1;
    else if (mob.x >= authored.rx1) mob.facing = -1;
    moveMob(mob, (mob.facing * mob.speed * ms * movementScale) / 1000);
  }
}

/** A single local attacker needs expiry counts, not multiplayer damage rankings. */
function admitMobAggro(mob, amount) {
  if (
    mob.movement === "stationary-special" ||
    (!mob.flight && mob.speed <= 0) ||
    mob.template.info.boss
  ) {
    return;
  }
  const aggro = mob.aggro;
  if (amount === 0 && aggro.damageInstances > 0) return;
  aggro.expireStreak = 0;
  aggro.ticksRemaining = aggroExpiryTicks(aggro);
  aggro.damageInstances++;
}

function aggroExpiryTicks(aggro) {
  return Math.ceil(
    MOB_AGGRO.damageLifetimeMs /
      MOB_AGGRO.updateMs /
      2 ** (aggro.expireStreak + aggro.damageInstances),
  );
}

function clearMobAggro(mob) {
  const aggro = mob.aggro;
  aggro.damageInstances = 0;
  aggro.expireStreak = 0;
  aggro.ticksRemaining = 0;
  aggro.updateMs = 0;
  mob.recoilPx = 0;
  mob.aggroDecisionMs = 0;
}

/** Null means the local controller died/left. Residency never affects this clock. */
function stepMobAggro(mob, ms, target) {
  if (!target) {
    clearMobAggro(mob);
    return;
  }
  const aggro = mob.aggro;
  aggro.updateMs += ms;
  const updates = Math.floor(aggro.updateMs / MOB_AGGRO.updateMs);
  aggro.updateMs %= MOB_AGGRO.updateMs;
  // The coordinator has a field clock, not a new timer per successful hit.
  for (let count = 0; count < updates; count++) {
    if (count >= MOB_POLICY.maxTransitions) {
      mob.fault = "aggro update budget exhausted";
      return;
    }
    if (aggro.damageInstances === 0) return;
    aggro.ticksRemaining--;
    if (aggro.ticksRemaining > 0) continue;
    aggro.expireStreak++;
    aggro.ticksRemaining = aggroExpiryTicks(aggro);
    aggro.damageInstances--;
  }
}

/** Aggro steering — move toward the target.  If blocked at the patrol/foothold
 *  edge (mob.x can't advance), two fallback paths:
 *
 *  1. Can-jump mobs — leap toward the target every tick they are grounded.
 *     Airtime naturally gates re-triggering.
 *
 *  2. Non-jump mobs — flip facing away from target and set recoilPx = bodyWidth*2.
 *     stepGroundMob handles the recoil walk until that many pixels are consumed,
 *     then normal chase resumes.  Distance-based so fast/slow mobs are proportional. */
function chaseMob(mob, ms, target) {
  let direction = target ? Math.sign(target.x - mob.x) : mob.facing;
  if (direction === 0) direction = mob.facing || 1;
  const step = (mob.speed * ms) / 1000;

  // Normal chase toward target.x
  mob.facing = direction;
  const before = mob.x;
  moveMob(mob, direction * step);
  const moved = Math.abs(mob.x - before) > 0.5;

  if (moved) {
    setMobAction(mob, "move");
    return;
  }

  // ── Blocked at the edge ──
  // Can-jump mobs just leap — gravity/airtime handles the rest.
  if (mob.canJump && mob.actions.jump && mob.onGround) {
    startMobJump(mob);
    return;
  }

  // Non-jump mobs: flip facing and recoil bodyWidth*2 px away from the edge,
  // then stepGroundMob's recoil branch handles the walk.  bodyWidth*2 keeps
  // both fast and slow mobs proportional — a big mob recoils farther than
  // a small one, and a fast mob gets there sooner.
  mob.facing = -direction;
  mob.recoilPx = mob.bodyWidth * 2;
  // Take the first recoil step immediately so we don't stand idle for one tick.
  moveMob(mob, mob.facing * step);
  setMobAction(mob, "move");
}

/** 009bc2bb..392 integrates the grounded scalar speed along the foothold.
 *  009b1646 reconstructs world XY from its tangent and that distance. The
 *  separate airborne mode-3 branch in 009bbdfd must not define ground travel. */
function moveMobRecoil(mob, distance) {
  if (mob.flight) {
    moveMobFlightRecoil(mob, distance);
    return;
  }
  const direction = Math.sign(distance);
  let remaining = Math.abs(distance);
  for (let count = 0; count < MOB_POLICY.maxTransitions; count++) {
    const segment = mob.foothold;
    const edge = direction > 0 ? segment.x2 : segment.x1;
    const available = segment.tx > 0 ? Math.abs(edge - mob.x) / segment.tx : 0;
    if (remaining <= available) {
      mob.x += direction * remaining * segment.tx;
      if (segment.dx > 0) mob.y = groundY(segment, mob.x);
      return;
    }
    mob.x = edge;
    mob.y = direction > 0 ? segment.y2 : segment.y1;
    remaining -= available;
    const next = connectedSegment(segment, direction);
    if (!next) {
      mob.knockbackSpeed = 0;
      return;
    }
    mob.foothold = next;
  }
  mob.fault = "recoil foothold traversal budget exhausted";
}

function connectedSegment(segment, direction) {
  const next = direction > 0 ? segment.next : segment.prev;
  if (
    !next ||
    next.dx <= 0 ||
    next.layer !== segment.layer ||
    next.group !== segment.group
  ) {
    return null;
  }
  const connected =
    direction > 0
      ? next.x1 === segment.x2 && next.y1 === segment.y2
      : next.x2 === segment.x1 && next.y2 === segment.y1;
  return connected ? next : null;
}

/** Local patrol only follows contiguous original floor links; no invented gap jumping. */
function moveMob(mob, distance) {
  if (mob.movement !== "ground-patrol") return;
  const authored = mob.record.authored;
  const target = Math.max(
    Math.min(authored.rx0, mob.x),
    Math.min(Math.max(authored.rx1, mob.x), mob.x + distance),
  );
  const direction = Math.sign(distance);
  if (target !== mob.x + distance) mob.facing = -direction;
  for (let count = 0; count < MOB_POLICY.maxTransitions; count++) {
    const segment = mob.foothold;
    if (target >= segment.x1 && target <= segment.x2) {
      mob.x = target;
      mob.y = groundY(segment, target);
      return;
    }
    const next = connectedSegment(segment, direction);
    if (!next) {
      mob.x = direction > 0 ? segment.x2 : segment.x1;
      mob.y = direction > 0 ? segment.y2 : segment.y1;
      mob.facing = -direction;
      return;
    }
    mob.foothold = next;
  }
  mob.fault = "local foothold traversal budget exhausted";
}

function recoverMob(mob, ms) {
  mob.recoveryMs += ms;
  if (mob.recoveryMs < MOB_POLICY.recoveryMs) return;
  mob.recoveryMs -= MOB_POLICY.recoveryMs;
  mob.hp = Math.min(
    mob.maxHP,
    mob.hp + Math.max(0, mob.template.info.hpRecovery ?? 0),
  );
  mob.mp = Math.min(
    mob.maxMP,
    mob.mp + Math.max(0, mob.template.info.mpRecovery ?? 0),
  );
}

function stepDeadMob(mob, ms) {
  mob.respawnMs += ms;
  advanceMobAction(mob, ms);
  const duration = mob.actions[mob.action].duration;
  if (mob.stateMs >= duration) {
    mob.visible = false;
    mob.state = "dead";
  }
  if (mob.developmentSpawn && mob.state === "dead") {
    mob.active = false;
    return;
  }
  if (mob.respawnMs < Math.max(MOB_POLICY.respawnMs, duration)) return;
  mob.x = mob.spawnX;
  mob.y = mob.spawnY;
  mob.previousX = mob.x;
  mob.previousY = mob.y;
  mob.facing = mob.spawnFacing;
  mob.foothold = mob.spawnFoothold;
  resetMobFlight(mob);
  mob.vy = 0;
  mob.onGround = true;
  mob.jumpDecisionMs = 0;
  mob.hp = mob.maxHP;
  mob.mp = mob.maxMP;
  mob.alive = true;
  mob.visible = true;
  mob.state = mob.actions.regen ? "spawning" : "idle";
  mob.stateMs = 0;
  mob.respawnMs = 0;
  mob.spawnMs = mob.actions.regen ? MOB_APPEARANCE.spawnMs : 0;
  mob.opacity = mob.actions.regen ? 1 : 0;
  mob.actionMs = 0;
  mob.frame = 0;
  mob.nameRemainingMs = 0;
  clearMobAggro(mob);
  clearMobSkillStatus(mob);
  mob.cooldownMs = MOB_POLICY.attackCooldownMs;
  mob.recoveryMs = 0;
  mob.knockbackMs = 0;
  mob.hitRemainingMs = 0;
  mob.lastReaction = "none";
  mob.knockbackSpeed = 0;
  mob.pendingAttack = null;
  setMobAction(mob, mob.actions.regen ? "regen" : mob.defaultAction);
  updateMobBody(mob);
}

/** Returns true exactly for the lethal transition, never for repeated dead hits. */
export function damageMob(mob, amount, facing, attack = null) {
  const skillId = attack?.skillId ?? 0;
  validateMobHit(amount, facing, skillId);
  validateReaction(attack);
  if (
    !mob.alive ||
    !mob.active ||
    (mob.selectedSkills.length && !mob.selectedSkills.includes(skillId)) ||
    mob.template.info.invincible
  ) {
    return false;
  }
  mob.nameRemainingMs = 5000;
  mob.lastDamage = amount;
  admitMobAggro(mob, amount);
  if (amount === 0) {
    mob.lastReaction = "nonpositive";
    return false;
  }
  mob.hp = Math.max(0, mob.hp - amount);
  if (mob.hp === 0) {
    clearMobAggro(mob);
    clearMobSkillStatus(mob);
    mob.stateMs = 0;
    mob.actionMs = 0;
    mob.frame = 0;
    // Death cancels the entry transition; its WZ frame a0/a1 owns disappearance.
    mob.spawnMs = MOB_APPEARANCE.spawnMs;
    mob.opacity = 1;
    mob.pendingAttack = null;
    mob.knockbackMs = 0;
    mob.hitRemainingMs = 0;
    mob.lastReaction = "lethal";
    mob.knockbackSpeed = 0;
    resetMobFlight(mob);
    mob.alive = false;
    mob.state = "dying";
    mob.deaths++;
    mob.respawnMs = 0;
    setMobAction(mob, "die1");
    mob.body.active = false;
    mob.sweptBody.active = false;
    return true;
  }
  receiveMobReaction(mob, amount, facing, attack);
  return false;
}

function validateMobHit(amount, facing, skillId) {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error("Mob damage must be a nonnegative safe integer");
  }
  if ((facing !== -1 && facing !== 1) || !Number.isSafeInteger(skillId)) {
    throw new Error("Invalid mob hit direction or skill");
  }
}

/** The owner supplies one native-modulo roll, never a guessed admission chance. */
function validateReaction(attack) {
  if (attack === null) return;
  knockbackChance(attack.knockbackChance);
  if (!Number.isInteger(attack.roll) || attack.roll < 0 || attack.roll > 99) {
    throw new Error("Invalid mob knockback roll");
  }
}

function receiveMobReaction(mob, amount, facing, attack) {
  mob.lastReaction = "below-threshold";
  if (amount < (mob.template.info.pushed ?? 1)) return;
  mob.lastReaction = "hit-deadline";
  if (mob.hitRemainingMs > 0) return;
  mob.lastReaction = "missing-hit-artwork";
  if (!mob.actions.hit1) return;
  const strong =
    attack !== null && attack.roll < knockbackChance(attack.knockbackChance);
  beginMobHit(mob, facing, strong);
}

/** 0066b7c6..822 preserves an attack pose; 00668d51 gates repeat hit reactions. */
function beginMobHit(mob, facing, strong) {
  const attacking = mob.state === "attack";
  if (!attacking) {
    mob.state = "hit";
    mob.stateMs = 0;
    mob.actionMs = 0;
    mob.frame = 0;
    mob.facing = -facing;
    setMobAction(mob, "hit1");
  }
  // Reset airborne velocity so a mid-jump hit doesn't leave stale upward
  // momentum that would relaunch the mob once the hit state expires. Keep
  // onGround untouched — gravity resumes normally if the mob is still aloft.
  mob.vy = 0;
  const duration = mob.actions.hit1.duration;
  // 0066b98b..9c8 installs the full motion-adjusted duration, replacing the
  // earlier max(1000,duration) provisional deadline; it is never min(1000,...).
  mob.hitRemainingMs = duration;
  mob.lastReaction = strong ? "strong" : "ordinary";
  const moving =
    mob.movement !== "stationary-special" &&
    duration >= MOB_HIT.minimumMotionMs;
  mob.knockbackMs = moving ? duration : 0;
  const velocity = strong ? MOB_HIT.strongVelocity : MOB_HIT.velocity;
  mob.knockbackSpeed = moving ? velocity : 0;
  mob.knockbackDeceleration = strong
    ? MOB_HIT.strongDeceleration
    : MOB_HIT.deceleration;
  mob.knockbackFacing = facing;
  if (moving && mob.flight) {
    mob.flight.vx = facing * velocity;
    mob.flight.vy = 0;
  }
  updateMobBody(mob);
}
