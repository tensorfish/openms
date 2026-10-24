import { createHash, randomUUID } from "node:crypto";
import { logPrefix } from "../../shared/development-log.js";
import {
  PROTOCOL,
  plausiblePositionPx,
  protocolError,
  MOTION_PLAUSIBILITY,
} from "../../shared/protocol.js";
import {
  createHeldInput,
  assignHeldInput,
  captureMotion,
} from "../../shared/motion.js";
import { collectPeerMoves } from "./peer-move-stream.js";
import { createSimulation } from "../../client/src/physics/simulation.js";
import { nearestSavedArrival } from "../../client/src/world/field-arrival.js";
import { npcRectangle } from "../../client/src/world/life-geometry-numeric.js";
import { prepareNpcAmbient, advanceNpcs } from "./field-npcs.js";
import { executeAction } from "./actions.js";
import { operationFor } from "./action-rules.js";
import { rebuildActorEffects, expireActorEffects } from "./action-character.js";
import {
  createFieldMobs,
  prepareActorCombat,
  prepareActorPoses,
  advanceCombat,
  beginAttack,
  serverRandom,
} from "./field-combat.js";
import {
  actorEntity,
  lifeEntity,
  dropEntity,
  snapshotParts,
} from "./field-views.js";
import {
  advanceDrops,
  createFieldDrop,
  MAX_FIELD_DROPS,
} from "./field-drops.js";
import {
  transitionActor,
  automaticPortalCandidate,
  markAutomaticPortalAttempt,
  travelParticipants,
  prepareLogout,
  bindActorField,
} from "./field-transition.js";
import { developActor, prepareMonsterSpawns } from "./field-development.js";
import {
  castSkill,
  prepareActorSkills,
  settleActorSkills,
  disposeActorSkills,
  releaseSkill,
} from "./field-skills.js";
import { sweepInteractions, releaseInteractions } from "./interactions.js";
import { advanceMarketSchedule } from "./market-schedule.js";
import { advanceTransports } from "./transport-schedule.js";
import { updatePlayerMovement } from "../../client/src/physics/skill-movement.js";
import { projectCharacterStats } from "../../client/src/character/character-stats.js";
import { Participants } from "./participants.js";
import { retireIdleField, touchField } from "./field-retirement.js";
import { advanceQuestSchedule } from "./quest-schedule.js";
import { prepareSocial, destroySocial } from "./social-presentation.js";
import { openStorage } from "./interaction-storage.js";
import { openPortalNpc } from "./interaction-npc.js";
import { refreshPickupConditions } from "./drop-conditions.js";
import {
  prepareActorWorldActions,
  beforeWorldPhysics,
  clearActorSeat,
} from "./field-world-actions.js";
import {
  createFieldReactors,
  advanceReactors,
  reactorEntities,
  canStrikeReactor,
  strikeReactor,
  settleFieldReactors,
  destroyFieldReactors,
} from "./field-reactors.js";
import { releaseMotionDiverts, takeMotionDiverts } from "./field-diverts.js";
import { serverOwnsPosition, combatMotionOwner } from "./motion-authority.js";
import {
  enqueueMovement,
  advanceMovementStream,
  movementStreamView,
} from "./movement-stream.js";
import { MotionWatchdog } from "./watchdog.js";
import { DamageWatchdog } from "./damage-watchdog.js";
import { resetAttackInput } from "./attack-input.js";

const MAX_FIELDS = 128;
const MAX_ACTORS = 128;
const MAX_DEBT_MS = 5000;
/** Bounded client-rolled damage evidence per actor before and during an attack. */
const MAX_HIT_REPORTS = 32;
const MAX_HIT_REPORT_AGE_TICKS = 300;
const NEUTRAL = Object.freeze({
  horizontal: 0,
  vertical: 0,
  jump: false,
  attack: false,
});
const CANCEL_SKILLS = Object.freeze({ kind: "skill.cancel" });

function prepareNpcs(manifest, randomUint) {
  const npcs = new Map();
  for (const record of manifest.life.placements) {
    if (record.kind !== "npc" || record.authored.hide) continue;
    const template = manifest.life.templates[record.template];
    if (!template || template.kind !== "npc") {
      throw protocolError("CONTENT_MISMATCH");
    }
    const id = randomUUID();
    npcs.set(id, {
      id,
      templateId: Number(template.originalId),
      template,
      record,
      x: record.authored.x,
      y: record.authored.y,
      facing: record.authored.f ? -1 : 1,
      action: template.defaultAction,
      ambient: prepareNpcAmbient(template, randomUint),
      npcSpeech: null,
      rectangle: npcRectangle(template.info),
    });
  }
  return npcs;
}

/** Discrepancy between a reported motion and the state it is compared against.
 *  Returns null for non-finite reports, which are refused without a watchdog verdict. */
function motionExcess(state, motion, allowedPosition) {
  const excess = {
    position: Math.hypot(motion.x - state.x, motion.y - state.y),
    velocity: Math.hypot(motion.vx - state.vx, motion.vy - state.vy),
    allowedPosition,
    allowedVelocity: MOTION_PLAUSIBILITY.velocityPxPerSecond,
  };
  if (!Number.isFinite(excess.position) || !Number.isFinite(excess.velocity)) {
    return null;
  }
  return excess;
}

/** A resume may only be judged against a live, finite, non-seated actor. */
function resumableResume(actor, motion) {
  if (!motion || !actor.simulation || !actor.field) return false;
  if (actor.profile.hp <= 0 || actor.simulation.seat !== null) return false;
  return (
    Number.isFinite(motion.x) &&
    Number.isFinite(motion.y) &&
    Number.isFinite(motion.vx) &&
    Number.isFinite(motion.vy)
  );
}

function inputAgeTicks(actor, tick) {
  if (
    !Number.isSafeInteger(actor.lastInputTick) ||
    !Number.isSafeInteger(tick)
  ) {
    return undefined;
  }
  return Math.max(0, tick - actor.lastInputTick);
}

function heartbeatAgeMs(actor) {
  const pongAt = actor.connection?.data?.pongAt;
  if (!Number.isFinite(pongAt)) return undefined;
  return Math.max(0, Date.now() - pongAt);
}

function movementExpiryDetails(actor) {
  const tick = actor.field?.tick;
  return {
    character: actor.id,
    map: actor.field?.mapId,
    fieldTick: tick,
    startedTick: actor.movementStream?.startedTick,
    steps: actor.movementStream?.steps,
    ready: actor.connection?.data?.ready ?? null,
    state: actor.state,
    inputAgeTicks: inputAgeTicks(actor, tick),
    heartbeatAgeMs: heartbeatAgeMs(actor),
  };
}

function activationOperation(actor) {
  return {
    operationId: randomUUID(),
    digest: createHash("sha256")
      .update(`quest.activate:${actor.playSession}`)
      .digest("hex"),
    expectedRevision: actor.revision,
    domain: "character",
    kind: "quest.activate",
    fieldEpoch: actor.field.epoch,
  };
}

/** One process owns field clocks. No packet or socket lifetime advances world time. */
export class OnlineWorld {
  constructor({
    content,
    database,
    publish,
    development = false,
    watchdogEnabled = false,
    combatWatchdogEnabled = true,
    log = null,
  }) {
    this.content = content;
    this.database = database;
    this.publish = publish;
    this.development = development;
    this.log = log;
    this.actors = new Map();
    this.fields = new Map();
    this.fieldLoads = new Map();
    this.participants = new Participants(this);
    this.familyRates = true;
    this.now = Date.now();
    this.lastNow = null;
    this.debt = -PROTOCOL.TICK_MS * PROTOCOL.INPUT_BUFFER_TICKS;
    this.overloaded = false;
    this.closed = false;
    this.nextUint32 = serverRandom();
    this.random = () => this.nextUint32() / 0x100000000;
    this.watchdog = new MotionWatchdog({
      enabled: watchdogEnabled,
      log: this.log,
    });
    this.damageWatchdog = new DamageWatchdog({
      enabled: combatWatchdogEnabled,
      log: this.log,
    });
  }

  async fieldFor(mapId, realm = "public", retain = false) {
    const key = `${realm}:${Number(mapId)}`;
    if (this.fields.has(key)) {
      return touchField(this, key, this.fields.get(key), retain);
    }
    if (this.fieldLoads.has(key)) {
      return touchField(this, key, await this.fieldLoads.get(key), retain);
    }
    if (this.fields.size + this.fieldLoads.size >= MAX_FIELDS) {
      if (!retireIdleField(this)) throw protocolError("SERVER_BUSY");
    }
    const pending = this.createField(mapId, realm, key);
    this.fieldLoads.set(key, pending);
    try {
      return touchField(this, key, await pending, retain);
    } finally {
      this.fieldLoads.delete(key);
    }
  }

  async createField(mapId, realm, key) {
    const manifest = await this.content.map(mapId);
    const arrival = nearestSavedArrival(manifest, { x: 0, y: 0, facing: 1 });
    const simulation = createSimulation(manifest.physics, arrival);
    const mobs = createFieldMobs(manifest, simulation);
    const field = {
      id: randomUUID(),
      mapId: Number(manifest.id),
      epoch: randomUUID(),
      realm,
      manifest,
      physics: manifest.physics,
      geometry: simulation.geometry,
      tick: 0,
      characters: new Map(),
      mobs,
      npcs: prepareNpcs(manifest, () => this.nextUint32()),
      drops: new Map(),
      dropReservations: 0,
      developmentSpawns: 0,
      paused: false,
      fault: null,
      published: new Set(),
    };
    await createFieldReactors(this, field);
    if (
      field.mobs.length +
        field.npcs.size +
        field.reactors.records.length +
        MAX_ACTORS +
        MAX_FIELD_DROPS >
      2048
    ) {
      destroyFieldReactors(field);
      throw protocolError("SERVER_BUSY");
    }
    this.fields.set(key, field);
    this.log?.("field.ready", {
      map: field.mapId,
      instance: field.id,
      mobs: field.mobs.length,
      npcs: field.npcs.size,
    });
    return field;
  }

  assertJoiningSession(actor) {
    if (
      actor.session?.revoked ||
      actor.session?.expiresAt <= Date.now() ||
      actor.retiring
    ) {
      throw protocolError("SESSION_EXPIRED");
    }
  }

  async join(actor) {
    if (this.closed || this.overloaded || this.actors.size >= MAX_ACTORS) {
      throw protocolError("SERVER_BUSY");
    }
    if (this.actors.has(actor.id)) throw protocolError("CHARACTER_BUSY");
    // Roles grant commands, not separate world instances. All ordinary map
    // entrants share the same field, as in Cosmic MapleMap.addPlayer.
    actor.realm = "public";
    const field = await this.fieldFor(
      actor.profile.location.mapId,
      actor.realm,
      true,
    );
    try {
      return await this.joinField(actor, field);
    } finally {
      field.entryReservations--;
    }
  }

  async joinField(actor, field) {
    this.assertJoiningSession(actor);
    if (field.characters.size + (field.travelReservations ?? 0) >= MAX_ACTORS) {
      throw protocolError("SERVER_BUSY");
    }
    this.prepareEntry(actor, field);
    await prepareActorPoses(this, actor);
    prepareActorCombat(this, actor);
    rebuildActorEffects(actor, this);
    await prepareActorSkills(this, actor);
    await prepareActorWorldActions(this, actor);
    await this.database.bindField(actor, {
      instanceId: field.id,
      fieldEpoch: field.epoch,
      mapId: field.mapId,
    });
    this.assertJoiningSession(actor);
    this.actors.set(actor.id, actor);
    field.characters.set(actor.id, actor);
    if (actor.profile.settings.questTracker.auto) {
      const activation = await this.participants.commit(
        actor,
        activationOperation(actor),
        [actor.id],
        () => ({}),
      );
      if (activation.status !== "committed") {
        throw protocolError(activation.code);
      }
      if (actor.deliveryError) throw actor.deliveryError;
    }
    await prepareSocial(actor, this);
    this.assertJoiningSession(actor);
    this.invalidateField(field);
    this.log?.("field.join", {
      account: actor.accountId,
      character: actor.id,
      role: actor.role,
      map: field.mapId,
      instance: field.id,
      players: field.characters.size,
    });
    return actor;
  }

  prepareEntry(actor, field) {
    actor.arrival = nearestSavedArrival(field.manifest, actor.profile.location);
    actor.simulation = createSimulation(field.physics, actor.arrival);
    bindActorField(actor, field);
    actor.input = createHeldInput();
    actor.inputQueue = new Map();
    resetAttackInput(actor);
    actor.inputSeq = 0;
    actor.ackInputSeq = null;
    actor.state = "preparing";
    actor.pending = false;
    actor.pendingOperation = null;
    actor.pendingOwner = null;
    actor.questTrackerExclusions = new Set();
    actor.developmentReceipts = new Map();
    actor.playSession ??= randomUUID();
    actor.portalUntil = 0;
    actor.lastCheckpoint = this.now;
    actor.admission = "OK";
  }

  /** Resume reports are diagnostics only. Reconnection never grants client position. */
  adoptResumedMotion(actor, motion) {
    if (!resumableResume(actor, motion)) return;
    const elapsedMs =
      Math.max(0, actor.field.tick - actor.lastAdoptedTick) * PROTOCOL.TICK_MS;
    const excess = motionExcess(
      actor.simulation,
      motion,
      plausiblePositionPx(elapsedMs),
    );
    if (!excess) return;
    const verdict = this.watchdog.review(actor.id, actor.field.tick, excess);
    if (verdict.decision === "fault") {
      this.faultMotion(actor, { ...excess, elapsedMs, verdict });
      throw protocolError("NOT_ALLOWED");
    }
    actor.lastAdoptedTick = actor.field.tick;
  }

  leave(actor) {
    actor.state = "retired";
    releaseInteractions(actor, this);
    clearActorSeat(actor);
    releaseMotionDiverts(actor);
    this.watchdog.forget(actor.id);
    destroySocial(actor);
    if (actor.skills) disposeActorSkills(actor, true);
    actor.field?.characters.delete(actor.id);
    this.actors.delete(actor.id);
    this.neutralize(actor);
    this.participants.signalIdle();
    if (actor.field) this.invalidateField(actor.field);
    this.log?.("field.leave", {
      character: actor.id,
      map: actor.field?.mapId,
      players: actor.field?.characters.size,
    });
  }

  neutralize(actor) {
    if (!actor.input) return;
    assignHeldInput(actor.input, NEUTRAL);
    actor.input.jumpPressed = false;
    actor.input.attackPressed = false;
    actor.inputQueue.clear();
    resetAttackInput(actor);
    if (actor.skills) releaseSkill(this, actor, CANCEL_SKILLS);
  }

  input(actor, message) {
    if (
      this.closed ||
      this.overloaded ||
      actor.state !== "active" ||
      actor.field.fault
    ) {
      throw protocolError("SERVER_BUSY");
    }
    if (message.fieldEpoch !== actor.field.epoch) {
      throw protocolError("STALE_FIELD");
    }
    if (message.inputSeq <= actor.inputSeq) {
      throw protocolError("INVALID_MESSAGE");
    }
    actor.inputSeq = message.inputSeq;
    enqueueMovement(actor, message);
  }

  /** Retain bounded diagnostic lines keyed to an attack. Only a matching server
   *  resolution consumes them; reported values never change combat outcomes. */
  recordHits(actor, message) {
    if (this.closed || actor.state !== "active" || !actor.field) {
      throw protocolError("NOT_ALLOWED");
    }
    const identity = message.feedbackId ?? message.inputSeq;
    if (identity === null || identity === undefined) {
      throw protocolError("INVALID_MESSAGE");
    }
    const reports = (actor.hitReports ??= new Map());
    const lines = new Map();
    for (const hit of message.hits) {
      lines.set(`${hit.targetId}:${hit.line}`, {
        damage: hit.damage,
        critical: hit.critical,
      });
    }
    reports.set(String(identity), {
      skillId: message.skillId,
      tick: actor.field.tick,
      lines,
    });
    while (reports.size > MAX_HIT_REPORTS) {
      reports.delete(reports.keys().next().value);
    }
  }

  /** Consume one reported line for the attack identity the authority is resolving now. */
  takeReportedDamage(actor, identity, targetId, hit) {
    if (identity === null || identity === undefined) return null;
    const key = String(identity);
    const report = actor.hitReports?.get(key);
    if (!report) return null;
    if (
      actor.field.tick - report.tick > MAX_HIT_REPORT_AGE_TICKS ||
      report.skillId !== hit.skillId
    ) {
      actor.hitReports.delete(key);
      return null;
    }
    const lineKey = `${targetId}:${hit.line}`;
    const entry = report.lines.get(lineKey);
    if (!entry) return null;
    report.lines.delete(lineKey);
    if (!report.lines.size) actor.hitReports.delete(key);
    return entry;
  }

  async command(actor, message) {
    // executeAction performs receipt lookup BEFORE lifecycle/revision/field admission.
    return await executeAction(actor, message, this);
  }

  develop(actor, request) {
    return developActor(this, actor, request);
  }

  step(now) {
    if (this.closed) return;
    if (
      !Number.isFinite(now) ||
      (this.lastNow !== null && now < this.lastNow)
    ) {
      throw new Error("World clock must be monotonic");
    }
    this.now = Date.now();
    sweepInteractions(this);
    advanceMarketSchedule(this);
    advanceTransports(this);
    if (this.lastNow === null) {
      this.lastNow = now;
      return;
    }
    this.debt += now - this.lastNow;
    this.lastNow = now;
    this.overloaded = this.debt > MAX_DEBT_MS;
    for (
      let count = 0;
      count < PROTOCOL.MAX_CATCH_UP && this.debt >= PROTOCOL.TICK_MS;
      count++
    ) {
      this.debt -= PROTOCOL.TICK_MS;
      for (const field of this.fields.values()) {
        if (!field.paused && !field.fault) this.tickField(field);
      }
    }
  }

  tickField(field) {
    if (!Number.isSafeInteger(field.tick + 1)) {
      throw protocolError("SERVER_BUSY");
    }
    field.tick++;
    for (const actor of field.characters.values()) {
      this.moveActorIsolated(actor);
    }
    advanceCombat(this, field);
    advanceDrops(this, field);
    advanceReactors(this, field, PROTOCOL.TICK_MS);
    advanceNpcs(this, field);
    for (const actor of field.characters.values()) {
      if (actor.state !== "active" || actor.retiring) continue;
      this.publish(actor, {
        type: "motion",
        fieldEpoch: field.epoch,
        ...movementStreamView(actor),
        ackInputSeq: actor.ackInputSeq,
        motion: captureMotion(actor.simulation),
        paused: field.paused,
        authoritative: serverOwnsPosition(actor, actor.simulation),
        combat: combatMotionOwner(actor),
        diverts: takeMotionDiverts(actor, field),
      });
      if (field.tick % 3 === 0) this.publishEntities(actor);
      this.automaticPortal(actor);
      this.checkpoint(actor);
    }
    this.publishPeerMotions(field);
  }

  moveActor(actor) {
    if (actor.state !== "active" || actor.retiring || actor.deliveryError) {
      return;
    }
    if (actor.state !== "active" || actor.profile.hp <= 0) {
      this.neutralize(actor);
    }
    if (actor.skillField.hasPendingIncoming) return;
    advanceQuestSchedule(this, actor);
    if (expireActorEffects(actor, this)) {
      this.publish(actor, { type: "snapshot-request" });
    }
    beforeWorldPhysics(this, actor);
    refreshPickupConditions(actor);
    actor.simulation.movementLocked =
      actor.profile.hp <= 0 || actor.skillField.blocksMovement;
    projectCharacterStats(actor.profile, actor.statHooks, actor.stats);
    updatePlayerMovement(
      actor.simulation,
      actor.profile.equipment,
      this.content.items,
      actor.skills.derived(),
    );
    const previous = actor.simulation.action;
    advanceMovementStream(this, actor);
    if (previous !== actor.simulation.action) {
      actor.actionStartTick = actor.field.tick;
    }
    actor.profile.location.x = actor.simulation.x;
    actor.profile.location.y = actor.simulation.y;
    actor.profile.location.facing = actor.simulation.facing;
  }

  /**
   * One client's protocol fault (for example more queued attack edges than the bound) ends
   * that client's connection, never the shared simulation. Errors without a protocol code
   * are server faults and still propagate to the lifecycle, which suspends the world.
   */
  moveActorIsolated(actor) {
    try {
      this.moveActor(actor);
    } catch (error) {
      if (typeof error?.code !== "string") throw error;
      this.rejectActor(actor, error.code);
    }
  }

  /** Close one connection for its own protocol fault; the character may reconnect. */
  rejectActor(actor, code) {
    this.neutralize(actor);
    this.log?.("actor.rejected", {
      character: actor.id,
      map: actor.field?.mapId,
      code,
    });
    this.publish(actor, { type: "closing", code, retryAfterMs: 0 });
    actor.connection?.close(1008, code);
  }

  /** Exhausted movement time is a recoverable connection failure, not cheat evidence. */
  expireMovement(actor) {
    this.log?.("movement.expired", movementExpiryDetails(actor));
    this.neutralize(actor);
    this.publish(actor, {
      type: "closing",
      code: "RESYNC_REQUIRED",
      retryAfterMs: 0,
    });
    actor.connection?.close(1012, "RESYNC_REQUIRED");
  }

  /** Optional abuse enforcement; server motion and client correction are independent. */
  faultMotion(actor, detail) {
    if (actor.retiring) return;
    actor.retiring = true;
    actor.admission = "NOT_ALLOWED";
    this.neutralize(actor);
    this.log?.("motion.fault", {
      character: actor.id,
      map: actor.field?.mapId,
      position: Math.trunc(detail.position),
      velocity: Math.trunc(detail.velocity),
      elapsedMs: detail.elapsedMs,
      deviations: detail.verdict?.score ?? 0,
    });
    this.publish(actor, {
      type: "closing",
      code: "NOT_ALLOWED",
      retryAfterMs: 0,
    });
    actor.connection?.close(1011, "NOT_ALLOWED");
  }

  checkpoint(actor) {
    if (
      actor.retiring ||
      actor.deliveryError ||
      actor.state !== "active" ||
      actor.pending ||
      actor.skillTask ||
      actor.skillField?.hasPendingIncoming ||
      this.participants.producedPending(actor.id) ||
      this.now - actor.lastCheckpoint < 1000
    ) {
      return;
    }
    actor.lastCheckpoint = this.now;
    actor.pending = true;
    actor.pendingOperation = null;
    actor.pendingOwner = null;
    const dirty = actor.runtimeDirty;
    actor.runtimeDirty = false;
    actor.checkpointTask = this.database
      .checkpoint(actor)
      .then(() => {
        if (dirty) return this.participants.deliver([actor.id]);
      })
      .catch((error) => {
        actor.runtimeDirty ||= dirty;
        // Quarantine this lease holder; gateway maintenance drains and checkpoints it
        // once more before release. A persistence failure must not poison a shared field.
        actor.deliveryError = error;
        this.neutralize(actor);
        this.log?.("checkpoint.failed", {
          character: actor.id,
          code: error.code ?? null,
          message: error.message,
          cause: error.cause?.errno ?? error.cause?.code ?? null,
        });
        this.publish(actor, {
          type: "closing",
          code: "SERVER_BUSY",
          retryAfterMs: 1000,
        });
        actor.connection?.close(1011, "SERVER_BUSY");
      })
      .finally(() => {
        actor.pending = false;
        actor.checkpointTask = null;
        this.participants.signalIdle();
      });
  }

  automaticPortal(actor) {
    if (
      actor.retiring ||
      actor.deliveryError ||
      this.participants.busy(actor)
    ) {
      return;
    }
    const portal = automaticPortalCandidate(actor);
    if (!portal) return;
    markAutomaticPortalAttempt(actor, portal);
    const message = {
      fieldEpoch: actor.field.epoch,
      operationId: randomUUID(),
      expectedRevision: actor.revision,
      action: { kind: "portal.enter", portalId: portal.id },
    };
    actor.pending = true;
    actor.pendingOperation = message.operationId;
    actor.pendingOwner = actor.id;
    this.transition(actor, { portalId: portal.id }, operationFor(message))
      .catch((error) => {
        actor.admission = error.code ?? "TRANSITION_FAILED";
        actor.portalUntil = this.now + 500;
      })
      .finally(() => {
        actor.pending = false;
        actor.pendingOperation = null;
        actor.pendingOwner = null;
        this.participants.signalIdle();
      });
  }

  entities(actor) {
    const result = [];
    for (const peer of actor.field.characters.values()) {
      result.push(actorEntity(peer));
    }
    for (const mob of actor.field.mobs) {
      if (mob.visible) result.push(lifeEntity(mob, "mob"));
    }
    for (const npc of actor.field.npcs.values()) {
      result.push(lifeEntity(npc, "npc"));
    }
    for (const drop of actor.field.drops.values()) {
      result.push(dropEntity(drop));
    }
    result.push(...reactorEntities(actor.field));
    return result;
  }

  /** NPC identity is field-owned; the original client applies no invented reach gate. */
  npc(actor, id) {
    const npc = actor.field.npcs.get(id);
    if (!npc) throw protocolError("NOT_FOUND");
    return npc;
  }

  nearby(actor, id, kind, maxDistance) {
    const field = actor.field;
    const target =
      kind === "player"
        ? field.characters.get(id)
        : kind === "npc"
          ? field.npcs.get(id)
          : kind === "drop"
            ? field.drops.get(id)
            : field.mobs.find((mob) => mob.id === id);
    // Retiring players remain visible while pending work settles, but cannot be targeted.
    if (!target || (kind === "player" && target.retiring)) {
      throw protocolError("NOT_FOUND");
    }
    const position = target.simulation ?? target.position ?? target;
    const dx = actor.simulation.x - position.x,
      dy = actor.simulation.y - position.y;
    if (dx * dx + dy * dy > maxDistance * maxDistance) {
      throw protocolError("NOT_IN_RANGE");
    }
    return target;
  }

  publishEntities(actor) {
    this.publish(actor, {
      type: "entities-request",
      entities: this.entities(actor),
    });
  }

  /** Adapt native path replay to every tick's server-simulated motion for the other
   *  actors in its field. It is not part of the ordered/acked publication sequence, so a
   *  slow round trip cannot throttle how often peers move on screen -- the ack-gated
   *  `state` frame remains for membership, appearance and removal only. */
  publishPeerMotions(field) {
    const actors = this.activeActors(field);
    if (actors.length < 2) return;
    const changed = collectPeerMoves(actors, field);
    if (!changed.length) return;
    for (const actor of actors) {
      const entries = [];
      for (const entry of changed) {
        if (entry.id !== actor.id) entries.push(entry);
      }
      if (!entries.length) continue;
      this.publish(actor, {
        type: "peers",
        fieldEpoch: field.epoch,
        tick: field.tick,
        entries,
      });
    }
  }

  activeActors(field) {
    const result = [];
    for (const actor of field.characters.values()) {
      if (actor.state === "active" && !actor.retiring && !actor.deliveryError) {
        result.push(actor);
      }
    }
    return result;
  }

  invalidateField(field) {
    for (const actor of field.characters.values()) {
      this.publish(actor, { type: "snapshot-request" });
    }
  }
  broadcast(field, message) {
    for (const actor of field.characters.values()) this.publish(actor, message);
  }
  snapshot(actor) {
    return snapshotParts(this, actor);
  }
  prepareLogout(actor) {
    if (actor.skills) disposeActorSkills(actor, true);
    rebuildActorEffects(actor, this);
    return prepareLogout(this, actor);
  }
  deliveryFailed(actor, error) {
    if (actor.deliveryError) return;
    actor.deliveryError = error;
    console.error(
      logPrefix("server"),
      "Committed character delivery failed:",
      actor.id,
      error.message,
    );
    actor.connection?.close(1011, "SERVER_BUSY");
  }
  attack(actor) {
    return beginAttack(this, actor);
  }
  transition(actor, destination, operation) {
    return transitionActor(this, actor, destination, operation);
  }
  clearActorSeat(actor) {
    clearActorSeat(actor);
  }
  travelParticipants(actor, message, spec) {
    return travelParticipants(this, actor, message, spec);
  }
  openStorage(actor, lease, npcTemplateId) {
    return openStorage(actor, this, lease, npcTemplateId);
  }
  openPortalNpc(actor, portal) {
    return openPortalNpc(actor, portal, this);
  }
  canStrikeReactor(actor, geometry) {
    return canStrikeReactor(this, actor, geometry);
  }
  strikeReactor(actor, geometry) {
    return strikeReactor(this, actor, geometry);
  }
  useSkillDoor(actor, operation) {
    actor.skillDoorOperation = operation;
    actor.skillDoorTravel = null;
    try {
      if (!actor.skills.worldController.useDoor()) {
        throw protocolError("NOT_ALLOWED");
      }
      return actor.skillDoorTravel;
    } finally {
      actor.skillDoorOperation = null;
      actor.skillDoorTravel = null;
    }
  }
  async travelSkillDoor(actor, destination) {
    if (!actor.skillDoorOperation) throw protocolError("NOT_ALLOWED");
    const travel = this.transition(
      actor,
      destination,
      actor.skillDoorOperation,
    );
    actor.skillDoorTravel = travel;
    const receipt = await travel;
    if (receipt.status !== "committed") throw protocolError(receipt.code);
    return true;
  }
  createDrop(actor, request) {
    return createFieldDrop(this, actor, request);
  }
  async spawnMonster(actor, templateId, count = 1) {
    const mobs = await prepareMonsterSpawns(this, actor, templateId, count);
    actor.field.mobs.push(...mobs);
    actor.field.developmentSpawns += mobs.length;
    this.invalidateField(actor.field);
    return mobs;
  }

  async cast(actor, action, operation) {
    return await castSkill(this, actor, action, operation);
  }

  async close() {
    await this.marketTask;
    for (const actor of this.actors.values()) {
      actor.retiring = true;
      actor.settling = true;
      this.neutralize(actor);
    }
    await Promise.all(
      [...this.actors.values()].map((actor) => settleActorSkills(actor)),
    );
    await Promise.all(
      [...this.fields.values()].map((field) => settleFieldReactors(field)),
    );
    this.closed = true;
    for (const actor of this.actors.values()) this.leave(actor);
    for (const field of this.fields.values()) destroyFieldReactors(field);
    this.fields.clear();
  }
}
