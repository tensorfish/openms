import { createHitboxState, updateHitboxes } from "../physics/hitboxes.js";
import { applyExternalImpulse } from "../physics/simulation.js";
import { placeBody } from "../world/life-geometry-numeric.js";
import { OfflineMobRenderer } from "./offline-mob-renderer.js";
import { PassiveRecovery } from "../character/passive-recovery.js";
import {
  knockbackChance,
  knockbackRoll,
  OFFLINE_ORDINARY_RECOIL_PERCENT,
} from "./combat-knockback.js";
import { isEquipped, isRechargeable } from "../items/inventory-model.js";
import { SkillAttack } from "../skills/skill-attack.js";
import { AranInput } from "../skills/aran-input.js";
import {
  hasMobStatus,
  hasMobBuffs,
  clearMobBuffs,
  MOB_STATUS,
} from "./mob-skill-status.js";
import { SkillDefenses } from "../skills/skill-defenses.js";
import { SkillDiseases } from "../skills/skill-diseases.js";
import {
  createCharacterStats,
  projectCharacterStats,
} from "../character/character-stats.js";
import { PhysicalDamage, physicalTargetError } from "./physical-damage.js";
import {
  createWeaponUse,
  selectWeaponUse,
  selectAmmunition,
  projectileRange,
  projectileTargetDistance,
  validateWeaponCombat,
  weaponActionDuration,
  weaponActionAnimationMs,
  weaponActionRelease,
} from "./weapon-usage.js";
import {
  createMobs,
  stepMob,
  damageMob,
  overlaps,
  rectangleState,
  setMobAction,
  MOB_POLICY,
} from "./offline-mobs.js";
import { mobFlipped } from "./mob-movement-metadata.js";
import {
  awardExperience,
  experienceRequired,
  PROGRESSION_POLICY,
} from "../character/offline-progression.js";
import { REVIVAL_POLICY } from "../character/revival.js";
const MAX_ATTACK_TARGETS = 6;
const MAX_PROJECTILES = 16;

export const COMBAT_POLICY = Object.freeze({
  authority: "offline-local-policy",
  fixedTickMs: 30,
  playerDamage:
    "modern shared weapon/stat/mastery range, skill and critical multipliers, percentage DEF and level advantage; see combat-formulas.md",
  incomingDamage:
    "modern linear monster ATT, unified defense with level-adjusted caps and DEX/LUK dodge",
  impact:
    "native00406abd authored release boundary; ranged flight trunc(distance*1.5)ms, first fixed tick at/after impact",
  attackMP: 0,
  regeneration: "native independent HP/MP timers; see passive-recovery.js",
  random:
    "outgoing seven-word and incoming four-word uint32 windows plus admitted magnitude draw; native modulo10000000 samples, separate recoil modulo100; no native seed parity",
  playerRecoil:
    "offline ordinary mob recoil90%; native skill resistance and no-direction precede local roll90..99 damage-only outcomes",
  respawn: REVIVAL_POLICY,
});

/** Original 009581a9 outcome / 00930b27 local-avatar update, not damage policy. */
export const PLAYER_HIT = Object.freeze({
  timerMs: 1500,
  tickMs: 30,
  alertMs: 5000, // User+56c; 0095923f, 0092edb2, Avatar004522a6.
  horizontalImpulse: 270,
  verticalImpulse: -270,
  noDirection: 0x7fffffff,
  normalTint: 0xffffff,
  hitTint: 0x808080,
});

/** Directional merge through the shared kernel entry point. `hooks.onExternalImpulse`
 *  lets an authority publish the exact divert it applied; offline it is absent. */
function applyHitImpulse(simulation, hit, onExternalImpulse = null) {
  applyExternalImpulse(
    simulation,
    (hit.direction < 0 ? -1 : 1) * PLAYER_HIT.horizontalImpulse,
    PLAYER_HIT.verticalImpulse,
    onExternalImpulse
      ? (sim, vx, vy) => onExternalImpulse(sim, vx, vy, hit)
      : null,
  );
}

/** All authority lives here and in plain mob records, never in a Pixi entity. */
export class OfflineField {
  constructor(scene, store, hooks = {}) {
    this.scene = scene;
    this.store = store;
    this.hooks = hooks;
    this.random = hooks.random ?? Math.random;
    if (typeof this.random !== "function") {
      throw new Error("Missing combat RNG");
    }
    this.simulation = scene.simulation;
    this.combat = scene.actor.avatar?.combat;
    validateWeaponCombat(this.combat ?? null);
    this.mobs = hooks.mobs ?? createMobs(scene.manifest.life, this.simulation);
    this.byId = new Map(this.mobs.map((mob) => [mob.id, mob]));
    this.renderer =
      hooks.renderer === undefined
        ? new OfflineMobRenderer(scene, this.mobs)
        : hooks.renderer;
    this.hitboxes = createHitboxState();
    this.receiverContext = {};
    this.attackBody = rectangleState();
    this.initializeCombatState();
    this.skillCombat = new SkillAttack(this);
    // Authoritative fields set this from the acting connection's measured latency before
    // admitting an attack; the offline field leaves it at zero.
    this.lagToleranceTicks = 0;
    this.aranInput = new AranInput(this);
    this.skillDefenses = new SkillDefenses(this);
    this.worldSkillView = Object.freeze({ mobs: this.mobs });
    this.recovery = new PassiveRecovery(
      this.simulation,
      store,
      hooks,
      scene.manifest.physics.map,
    );
    this.wasAttack = false;
    this.destroyed = false;
    this.prepared = false;
    this.diseases = new SkillDiseases(this);
    this.hypnotizeHit = {
      skillId: 5221009,
      skillLine: true,
      line: 0,
      critical: false,
      knockbackChance: 0,
      roll: 0,
    };
    this.lastStatus = "offline-local-policy";
    this.lastDamage = 0;
    this.deathAction = scene.actor.actions.has("dead") ? "dead" : null;
    this.simulation.movementLocked = this.blocksMovement;
    scene.offlineField = this;
  }

  initializeCombatState() {
    this.phase = this.store.profile.hp > 0 ? "idle" : "dead";
    this.attackTargets = new Array(MAX_ATTACK_TARGETS).fill(null);
    this.targetDistances = new Float64Array(MAX_ATTACK_TARGETS);
    this.weaponUse = createWeaponUse();
    this.useContext = {
      crouching: false,
      job: 0,
      ammunition: null,
      closeTarget: false,
      randomWord: 0,
      items: this.hooks.items,
    };
    this.projectiles = Array.from(
      { length: MAX_PROJECTILES },
      createProjectile,
    );
    this.attackReleaseMs = 0;
    this.attackSkill = null;
    this.attackInfo = null;
    this.attackOnHit = null;
    this.impactStats = createCharacterStats();
    this.receiverStats = createCharacterStats();
    this.incomingOptions = {
      magic: false,
      standardPDD: this.scene.manifest.combat.standardPDD,
      attackPADamage: null,
    };
    this.defenseContext = { magic: false, contact: false, outcome: null };
    this.damageGenerator = new PhysicalDamage(
      this.random,
      this.hooks.nextUint32 ?? null,
    );
    this.damageLines = new Float64Array(MAX_ATTACK_TARGETS);
    this.damageCritical = new Uint8Array(MAX_ATTACK_TARGETS);
    this.phaseMs = 0;
    this.attack = null;
    this.attackName = null;
    this.attackDurationMs = 0;
    this.attackSpeed = null;
    this.attackFired = false;
    this.hitTimerMs = 0;
    this.alertTimerMs = 0;
    this.alertPosture = false;
    this.blinkCounter = 0;
    this.blinkTint = PLAYER_HIT.normalTint;
    this.lastKnockback = "none";
    this.lastKnockbackRoll = -1;
    this.lastLandingSequence = this.simulation.landing.sequence;
    this.mobHit = { skillId: 0, knockbackChance: 0, roll: 0 };
    this.localHit = {
      amount: 0,
      hpDamage: 0,
      direction: 0,
      locallyInitiated: true,
      source: null,
      attackAction: null,
      element: 0,
    };
  }

  get dead() {
    return this.phase === "dead";
  }
  get blocksMovement() {
    return this.phase !== "idle";
  }
  get playback() {
    return this.phase === "idle" ? "loop" : "once";
  }
  get action() {
    if (
      this.phase === "attack" ||
      this.phase === "cast" ||
      this.phase === "hold"
    ) {
      return this.attackName;
    }
    if (this.dead) return this.deathAction;
    return this.alerting ? "alert" : null;
  }

  /** 00936d99: only the grounded idle selector substitutes encoded8 for4.
   * Walking, crouching, airborne motion, climbing and seats keep their posture. */
  get alerting() {
    const action = this.simulation.action;
    return (
      this.phase === "idle" &&
      this.simulation.state === "ground" &&
      !this.simulation.seat &&
      this.alertPosture &&
      (action === "stand1" || action === "stand2")
    );
  }

  async prepare(signal) {
    try {
      await this.renderer.prepare(signal);
      this.prepared = true;
      this.renderer.synchronize();
      return this;
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  /** Called exactly once after each executed original 30-ms physics quantum. */
  step(ms, input) {
    if (
      this.destroyed ||
      !this.prepared ||
      this.store.profileTransactionPending
    ) {
      return;
    }
    if (ms !== COMBAT_POLICY.fixedTickMs) {
      throw new Error("OfflineField requires one fixed 30-ms tick");
    }
    const attackEdge = !!input.attack && !this.wasAttack;
    this.wasAttack = !!input.attack;
    this.phaseMs += ms;
    updateHitboxes(this.hitboxes, this.simulation, this.receiverContext);
    for (const mob of this.mobs) {
      stepMob(
        mob,
        ms,
        this.dead ? null : this.targetFor(mob),
        this.hooks.onSkillDamageLine,
      );
    }
    this.stepProjectiles(ms);
    this.skillCombat.step(ms);
    this.diseases.step(ms);
    this.receiveFallLanding();
    this.stepPlayer(attackEdge, input);
    if (!this.dead) {
      for (const mob of this.mobs) this.stepMobAttack(mob);
      this.contactDamage();
    }
    this.advanceAlert();
    this.advanceHitPresentation();
    if (this.recovery.step(ms, this.action ?? this.simulation.action)) {
      this.changed();
    }
    this.simulation.movementLocked = this.blocksMovement;
    this.renderer.synchronize();
  }

  stepPlayer(attackEdge, input) {
    if (this.dead) {
      this.aranInput.clear();
      return;
    }
    const canStart = this.phase === "idle";
    const aran = this.aranInput.enabled();
    this.aranInput.input(COMBAT_POLICY.fixedTickMs, input);
    this.advancePlayerPhase();
    if (!canStart) return;
    if (aran) this.aranInput.advance();
    else if (attackEdge) this.beginAttack();
  }

  /** Finish the current action without admitting another attack on its final tick. */
  advancePlayerPhase() {
    if (this.phase === "attack") {
      if (!this.attackFired && this.phaseMs >= this.attackReleaseMs) {
        this.playerImpact();
      }
    }
    if (
      (this.phase === "attack" || this.phase === "cast") &&
      this.phaseMs >= this.attackDurationMs
    ) {
      this.phase = "idle";
      if (this.attackSkill && this.skillCombat.beginFinal()) return;
    }
  }

  beginAttack(prepared = false) {
    this.hooks.interruptChakra?.();
    const admissionError = this.basicAttackError();
    if (admissionError) {
      this.lastStatus = admissionError;
      return;
    }
    this.skillCombat.attackSequence++;
    if (!prepared) {
      this.prepareWeaponUse(this.store.profile);
      if (this.weaponUse.ranged) this.probeMeleeTarget();
    }
    const visualError = this.weaponUse.ranged
      ? this.hooks.projectileAdmissionError?.(1)
      : null;
    if (visualError) {
      this.lastStatus = visualError;
      return;
    }
    const name = this.weaponUse.action;
    this.attack = this.combat.attacks[name];
    this.attackSkill = null;
    this.attackInfo = null;
    this.attackOnHit = null;
    this.startPose(name, "attack");
    this.consumeAmmunition();
    this.lastStatus = this.weaponUse.ranged
      ? "local projectile attack"
      : "local melee attack";
    if (!this.weaponUse.ranged) {
      this.hooks.onAttack?.(this.combat.equipment.sfx);
    }
  }

  basicAttackError() {
    if (!this.combat || !isEquipped(this.store.profile, this.combat.weaponId)) {
      return "attack unavailable: original base weapon not equipped";
    }
    if (this.simulation.state === "ladder") {
      return "attack unavailable while climbing";
    }
    return null;
  }

  prepareWeaponUse(profile, quantity = 1) {
    const context = this.useContext;
    context.crouching = this.simulation.crouching;
    context.job = profile.job;
    context.randomWord = this.damageGenerator.next();
    const temporary = this.hooks.derivedStats?.();
    context.ammunition = selectAmmunition(
      profile,
      this.hooks.items,
      this.combat.weaponId,
      quantity * (temporary?.shadowPartner ? 2 : 1),
    );
    context.unlimitedAmmunition = !!(
      temporary?.soulArrow || temporary?.shadowStars
    );
    context.closeTarget = false;
    selectWeaponUse(this.combat, context, this.weaponUse);
  }

  /**0094e256 probes the chosen melee row, with forward reach clamped to65. */
  probeMeleeTarget() {
    const context = this.useContext;
    context.closeTarget = true;
    selectWeaponUse(this.combat, context, this.weaponUse);
    const rectangle = this.combat.attacks[this.weaponUse.action].rectangle;
    placeBody(
      this.attackBody,
      rectangle,
      this.simulation,
      this.simulation.facing > 0,
    );
    if (this.simulation.facing > 0) {
      this.attackBody.right = Math.min(
        this.attackBody.right,
        this.simulation.x + 65,
      );
    } else {
      this.attackBody.left = Math.max(
        this.attackBody.left,
        this.simulation.x - 65,
      );
    }
    context.closeTarget =
      this.selectAttackTargets(1) > 0 ||
      this.hooks.canStrike?.(this.attackBody, this.simulation.facing, 0) ===
        true;
    selectWeaponUse(this.combat, context, this.weaponUse);
  }

  /** Rechargeable rounds retain an empty stack; arrows remove their depleted instance. */
  consumeAmmunition() {
    const ammunition = this.weaponUse.ammunition;
    if (!ammunition) return;
    const temporary = this.hooks.derivedStats?.();
    if (temporary?.soulArrow || temporary?.shadowStars) return;
    ammunition.count -= temporary?.shadowPartner ? 2 : 1;
    if (!ammunition.count && !isRechargeable(ammunition.id)) {
      const inventory = this.store.profile.inventory;
      inventory.splice(inventory.indexOf(ammunition), 1);
    }
    this.changed();
  }

  prepareCombatReplacement(combat, actor) {
    validateWeaponCombat(combat);
    return this.skillCombat.prepareActor(actor, combat);
  }

  replaceCombat(
    combat,
    prepared = this.prepareCombatReplacement(combat, this.scene.actor),
  ) {
    this.aranInput.clear();
    this.combat = combat;
    this.skillCombat.prepared = prepared;
    if (this.phase === "attack") this.phase = "idle";
    this.attack = null;
    this.attackSkill = null;
    this.attackOnHit = null;
    this.simulation.movementLocked = this.blocksMovement;
  }

  skillCastError() {
    if (
      !this.prepared ||
      this.destroyed ||
      this.dead ||
      this.store.profileTransactionPending
    ) {
      return "Character/field is unavailable";
    }
    if (this.phase !== "idle") return "Another character action is active";
    if (this.simulation.state === "ladder") {
      return "Active skill rope/ladder pose controller is unavailable";
    }
    return null;
  }

  skillAttackError(skill, info) {
    if (!this.combat || !isEquipped(this.store.profile, this.combat.weaponId)) {
      return "Original base weapon is not equipped";
    }
    return (
      this.diseases.admissionError(skill) ?? this.skillCombat.error(skill, info)
    );
  }

  prepareSkillCombat(skill, info, rank, external = false) {
    if (external) this.skillCombat.prepareExternal(skill, info, rank);
    else this.skillCombat.prepare(skill, info, rank);
  }

  beginSkillAttack(skill, info, onHit, chargeMs = -1) {
    this.skillCombat.begin(skill, info, onHit, chargeMs);
    this.lastStatus = "original skill attack admitted";
  }

  beginTargetSkill(skill, info, onHit, controller) {
    this.skillCombat.begin(skill, info, onHit);
    this.skillCombat.targetController = controller;
  }

  hasCurableDebuff(purge = false) {
    return this.diseases.hasCurable(purge);
  }
  cureDebuffs(purge = false) {
    return this.diseases.cure(purge);
  }

  skillDispelError(info) {
    if (this.diseases.hasCurable()) return null;
    this.dispelRectangle(info);
    for (const mob of this.mobs) {
      if (
        mob.alive &&
        overlaps(this.skillCombat.body, mob.body) &&
        hasMobBuffs(mob)
      ) {
        return null;
      }
    }
    return "There is no removable status in Dispel's original area";
  }

  dispelRectangle(info) {
    const origin = this.simulation,
      box = this.skillCombat.body;
    box.left = origin.x + info.lt.x;
    box.right = origin.x + info.rb.x;
    box.top = origin.y + info.lt.y;
    box.bottom = origin.y + info.rb.y;
    box.active = true;
  }

  dispelSkill(info, cureSelf = true) {
    this.dispelRectangle(info);
    if (
      cureSelf &&
      this.damageGenerator.next() % 100 < Number(info.prop ?? 100)
    ) {
      this.diseases.cure();
    }
    for (const mob of this.mobs) {
      if (
        !mob.alive ||
        !overlaps(this.skillCombat.body, mob.body) ||
        !hasMobBuffs(mob)
      ) {
        continue;
      }
      if (this.damageGenerator.next() % 100 < Number(info.prop ?? 100)) {
        clearMobBuffs(mob);
      }
    }
  }

  externalSkillImpact(skill, info, origin) {
    return this.skillCombat.external(skill, info, origin);
  }

  worldSkills() {
    return this.worldSkillView;
  }

  skillStateError(skill, info) {
    return this.skillCombat.stateError(skill, info);
  }

  skillStateCast(skill) {
    this.skillCombat.consumeState(skill);
  }

  beginSkillPose(action) {
    this.attackSkill = null;
    this.attackInfo = null;
    this.attackOnHit = null;
    this.startPose(action, "cast");
    this.lastStatus = "learned self-buff pose";
  }

  startPose(name, phase) {
    this.attackName = name;
    const actor = this.scene.actor.actions.get(name);
    this.attackSpeed = phase === "attack" ? this.effectiveAttackSpeed() : null;
    this.attackDurationMs =
      this.attackSpeed === null
        ? actor.duration
        : weaponActionDuration(actor, this.attackSpeed);
    this.attackReleaseMs = weaponActionRelease(actor, this.attackDurationMs);
    this.attackFired = false;
    this.phase = phase;
    this.phaseMs = 0;
    // Admitted ordinary/skill actions reach0092edb2 or an explicit5000 write.
    this.alertTimerMs = PLAYER_HIT.alertMs;
    this.simulation.movementLocked = true;
  }

  /** Native00765066: Double Stab -2, then Booster and Speed Infusion, clamp2..10. */
  effectiveAttackSpeed() {
    const temporary = this.hooks.derivedStats?.();
    //00955b10..00955b3c: magic uses6 + Booster, never weapon speed/Speed Infusion.
    if (this.isMagicAttack()) {
      return Math.max(2, Math.min(10, 6 + (temporary?.booster ?? 0)));
    }
    const skillDelta = this.attackSkill?.id === 4001334 ? -2 : 0;
    return Math.max(
      2,
      Math.min(
        10,
        this.combat.equipment.attackSpeed +
          skillDelta +
          (temporary?.booster ?? 0) +
          (temporary?.speedInfusion ?? 0),
      ),
    );
  }

  isMagicAttack() {
    const spec = this.attackSkill && this.skillCombat.active?.spec;
    return (
      !!spec && (spec.kind === "magic" || spec.magic || spec.kind === "heal")
    );
  }

  get attackAnimationMs() {
    if (this.attackSpeed === null) return this.phaseMs;
    const actor = this.scene.actor.actions.get(this.attackName);
    return weaponActionAnimationMs(actor, this.attackSpeed, this.phaseMs);
  }

  /** Explicit development edits may change mortality without inventing a received hit. */
  synchronizeProfile() {
    const dead = this.store.profile.hp === 0;
    if (dead === this.dead) return;
    this.phase = dead ? "dead" : "idle";
    this.aranInput.clear();
    this.phaseMs = 0;
    this.hitTimerMs = 0;
    this.alertTimerMs = 0;
    this.alertPosture = false;
    this.blinkTint = PLAYER_HIT.normalTint;
    this.attackSkill = null;
    this.attackInfo = null;
    this.attackOnHit = null;
    this.simulation.movementLocked = this.blocksMovement;
  }

  playerImpact() {
    this.attackFired = true;
    if (this.attackSkill) {
      this.skillCombat.impact();
      return;
    }
    if (this.weaponUse.ranged) {
      this.launchProjectile();
      return;
    }
    const sim = this.simulation;
    placeBody(this.attackBody, this.attack.rectangle, sim, sim.facing > 0);
    const reactorHit = this.hooks.onStrike?.(this.attackBody, sim.facing, 0);
    const count = this.selectAttackTargets(this.attackInfo?.mobCount ?? 1);
    if (!count) {
      this.lastStatus = reactorHit
        ? "local reactor hit"
        : "local impact: no eligible original body";
      return;
    }
    this.generateDamageLines(count);
    // Match optional client telemetry to this server-resolved attack.
    this.mobHit.reportId = this.feedbackId ?? this.feedbackInputSeq ?? null;
    for (let index = 0; index < count; index++) {
      this.mobHit.critical = !!this.damageCritical[index];
      this.damageTarget(this.attackTargets[index], this.damageLines[index]);
    }
  }

  /**009537d5/006789ed: widening ray acquisition, then flight to the target body. */
  launchProjectile() {
    //00954323→0092fb41 queues original tGlove/Attack at the release timestamp.
    this.hooks.onAttack?.(this.combat.equipment.sfx);
    const sim = this.simulation;
    const range = projectileRange(
      this.combat.weaponType,
      this.store.profile.job,
      this.hooks,
    );
    this.attackBody.left = sim.x + (sim.facing > 0 ? 65 : -range);
    this.attackBody.right = sim.x + (sim.facing > 0 ? range : -65);
    this.attackBody.top = sim.y - 28;
    this.attackBody.bottom = sim.y - 27;
    const target = this.projectileTarget(range);
    const count = target ? 1 : 0;
    if (target) this.attackTargets[0] = target;
    if (count) this.generateDamageLines(count);
    const shot = this.prepareProjectile(target, range);
    shot.damage = count ? this.damageLines[0] : 0;
    shot.hit.critical = count > 0 && !!this.damageCritical[0];
    this.hooks.onProjectile?.(shot);
    shot.hit.knockbackChance = this.mobHit.knockbackChance;
  }

  /** Acquire a pooled ordinary shot and initialize its target-body flight. */
  prepareProjectile(target, range) {
    const sim = this.simulation;
    let shot = null;
    for (const candidate of this.projectiles) {
      if (!candidate.active) {
        shot = candidate;
        break;
      }
    }
    if (!shot) throw new Error("Ordinary projectile pool exhausted");
    shot.active = true;
    shot.age = 0;
    shot.projectileId = this.weaponUse.projectileId;
    shot.x = sim.x + sim.facing * 65;
    shot.y = sim.y - 28;
    shot.endX = target
      ? (target.body.left + target.body.right) / 2
      : sim.x + sim.facing * range;
    shot.endY = target ? (target.body.top + target.body.bottom) / 2 : shot.y;
    shot.facing = sim.facing;
    shot.duration = Math.max(
      1,
      Math.trunc(Math.hypot(shot.endX - shot.x, shot.endY - shot.y) * 1.5),
    );
    shot.target = target;
    shot.generation = target?.deaths ?? 0;
    return shot;
  }

  projectileTarget(range) {
    let target = null,
      nearest = Infinity;
    for (const mob of this.mobs) {
      if (!this.canAttackMob(mob)) continue;
      const distance = projectileTargetDistance(
        mob.body,
        this.simulation,
        range,
        65,
      );
      if (distance >= nearest) continue;
      target = mob;
      nearest = distance;
    }
    return target;
  }

  stepProjectiles(ms) {
    for (const shot of this.projectiles) {
      if (!shot.active) continue;
      shot.age += ms;
      if (shot.age < shot.duration) continue;
      shot.active = false;
      if (shot.target?.alive && shot.target.deaths === shot.generation) {
        this.damageTarget(shot.target, shot.damage, shot.hit, shot.facing);
      }
      shot.target = null;
    }
  }

  generateDamageLines(count) {
    projectCharacterStats(
      this.store.profile,
      this.hooks,
      this.impactStats,
      this.hooks.derivedStats?.(),
    );
    this.skillCombat.enhanceStats(this.impactStats);
    this.mobHit.skillId = this.attackSkill?.id ?? 0;
    this.mobHit.knockbackChance = knockbackChance(
      this.hooks.items[this.impactStats.weaponId]?.info.knockback ?? 0,
    );
    // 00950921 generates every target before its separate per-line recoil pass.
    for (let index = 0; index < count; index++) {
      this.damageLines[index] = this.skillCombat.basicDamage(
        this.impactStats,
        this.attackTargets[index],
        this.weaponUse,
      );
      this.damageCritical[index] = this.skillCombat.damage.critical ? 1 : 0;
    }
    if (count) {
      this.hooks.onEventAttack?.(
        null,
        this.attackTargets[0],
        this.skillCombat.attackSequence,
      );
    }
  }

  damageTarget(
    target,
    generated,
    hit = this.mobHit,
    facing = this.simulation.facing,
  ) {
    // Offline HP authority: a negative proposed line must never heal the target.
    const amount = Math.min(target.hp, Math.max(0, generated));
    hit.roll = this.damageGenerator.next() % 100;
    const showdown = hasMobStatus(target, "showdown")
      ? target.skillStatus.values[MOB_STATUS.showdown]
      : 0;
    const beforeHP = target.hp;
    const killed = damageMob(target, amount, facing, hit);
    hit.hpDamage = beforeHP - target.hp;
    this.recordMobDamage(target, hit.hpDamage);
    if (hit.skillLine && this.hooks.onSkillDamageLine) {
      this.hooks.onSkillDamageLine(target, Math.max(0, generated), hit);
    } else {
      // Display the generated line, not the HP-capped accounting value, so a hit
      // larger than the target's remaining HP does not look like a flat number.
      this.hooks.onMobHit?.(target, Math.max(0, generated), hit);
    }
    if (amount > 0 && hit.skillId === 0) {
      this.skillCombat.basicHit(target, amount);
    }
    this.lastStatus = killed
      ? "local mob killed; WZ EXP awarded"
      : amount > 0
        ? "local mob hit"
        : "combat MISS";
    if (killed) this.onKill(target, showdown);
  }

  recordMobDamage(target, amount) {
    this.hooks.onMobDamage?.(target, amount);
  }

  /** Bounded nearest-first insertion into reusable target slots; stable ties keep field order. */
  selectAttackTargets(limit) {
    let count = 0;
    for (const mob of this.mobs) {
      if (!this.canAttackMob(mob) || !overlaps(this.attackBody, mob.body)) {
        continue;
      }
      const distance = Math.abs(mob.x - this.simulation.x);
      if (count === limit && distance >= this.targetDistances[count - 1]) {
        continue;
      }
      let index = Math.min(count, limit - 1);
      while (index > 0 && distance < this.targetDistances[index - 1]) {
        this.attackTargets[index] = this.attackTargets[index - 1];
        this.targetDistances[index] = this.targetDistances[index - 1];
        index--;
      }
      this.attackTargets[index] = mob;
      this.targetDistances[index] = distance;
      if (count < limit) count++;
    }
    return count;
  }

  canAttackMob(mob) {
    return (
      mob.alive &&
      mob.active &&
      !mob.fault &&
      !physicalTargetError(mob.template.info) &&
      !mob.template.info.invincible &&
      (!mob.selectedSkills.length ||
        mob.selectedSkills.includes(this.attackSkill?.id ?? 0))
    );
  }

  killExperience(mob, showdown = 0) {
    const rate = this.hooks.experienceRate?.() ?? 1;
    if (!Number.isFinite(rate) || rate < 1 || rate > 2) {
      throw new Error("Invalid admitted family EXP rate");
    }
    const holySymbol = this.hooks.derivedStats?.().holySymbol ?? 0;
    const curse = this.diseases.has(124) ? 0.5 : 1;
    return Math.trunc(
      (mob.template.info.exp ?? 0) *
        rate *
        (1 + holySymbol / 500) *
        (1 + showdown / 100) *
        curse,
    );
  }

  onKill(mob, showdown = 0) {
    mob.killDropRate = 1 + showdown / 100;
    const exp = this.killExperience(mob, showdown);
    const levels = awardExperience(this.store.profile, exp, {
      growth: this.hooks.growth?.(),
      items: this.hooks.items,
      random: this.random,
    });
    this.hooks.onKill?.(mob.templateId, mob);
    this.hooks.onExperience?.(exp, levels);
    if (levels > 0) this.hooks.onEffect?.("LevelUp");
    this.changed();
  }

  mobAttackAllowed(mob) {
    // Mob.wz:9300018 and the other passive tutorial templates author notAttack=1.
    if (
      !mob.alive ||
      !mob.active ||
      mob.fault ||
      mob.state === "hit" ||
      mob.template.info.notAttack === 1
    ) {
      return false;
    }
    return !(
      hasMobStatus(mob, "doom") ||
      hasMobStatus(mob, "stun") ||
      hasMobStatus(mob, "freeze") ||
      hasMobStatus(mob, "seal")
    );
  }

  stepMobAttack(mob) {
    if (!this.mobAttackAllowed(mob)) return;
    if (mob.state === "attack") {
      this.mobImpact(mob);
      return;
    }
    if (mob.cooldownMs > 0) return;
    for (let offset = 0; offset < mob.attacks.length; offset++) {
      const index = (mob.attackIndex + offset) % mob.attacks.length;
      const attack = mob.attacks[index];
      if (!attack.supported || (attack.properties.conMP ?? 0) > mob.mp) {
        continue;
      }
      placeBody(mob.attackBody, attack.rectangle, mob, mobFlipped(mob));
      if (!this.targetOverlap(mob.attackBody, this.targetFor(mob))) continue;
      this.beginMobAttack(mob, attack, index);
      return;
    }
  }

  /** Fire the pending original area once at its authored delay. */
  mobImpact(mob) {
    const attack = mob.pendingAttack;
    if (
      !attack ||
      mob.attackFired ||
      mob.stateMs < attack.properties.attackAfter
    ) {
      return;
    }
    mob.attackFired = true;
    placeBody(mob.attackBody, attack.rectangle, mob, mobFlipped(mob));
    if (this.targetOverlap(mob.attackBody, this.targetFor(mob))) {
      this.proposeMobHit(mob, attack.properties.magic === 1, attack.action);
    }
  }

  beginMobAttack(mob, attack, index) {
    mob.state = "attack";
    mob.stateMs = 0;
    mob.actionMs = 0;
    mob.pendingAttack = attack;
    mob.attackFired = false;
    mob.attackIndex = (index + 1) % mob.attacks.length;
    mob.mp -= attack.properties.conMP ?? 0;
    mob.cooldownMs = MOB_POLICY.attackCooldownMs;
    setMobAction(mob, attack.action);
    this.hooks.onMobAttack?.(mob);
  }

  contactDamage() {
    for (const mob of this.mobs) {
      if (
        mob.template.info.notAttack !== 1 &&
        mob.template.info.bodyAttack === 1 &&
        this.targetOverlap(mob.sweptBody, this.targetFor(mob))
      ) {
        if (this.proposeMobHit(mob, false)) return;
      }
    }
  }

  targetFor(mob) {
    if (hasMobStatus(mob, "inert")) {
      return this.hooks.skillTargetController?.().targetFor(mob) ?? null;
    }
    return this.hooks.targetFor?.(mob, this.simulation) ?? this.simulation;
  }

  targetOverlap(rectangle, target) {
    if (!target) return false;
    if (target === this.simulation) {
      return overlaps(rectangle, this.hitboxes.body);
    }
    return (
      rectangle.active &&
      target.x >= rectangle.left &&
      target.x <= rectangle.right &&
      target.y >= rectangle.top &&
      target.y <= rectangle.bottom
    );
  }

  /** Recovered ordinary incoming calculation; geometry-derived side is local authority. */
  proposeMobHit(mob, magic, attackAction = null) {
    if (hasMobStatus(mob, "inert")) {
      return this.hypnotizedImpact(mob, attackAction);
    }
    return this.commitHitOutcome(this.prepareMobHit(mob, magic, attackAction));
  }

  /** Original admission and damage, with controller effects deferred until its owner commits. */
  prepareMobHit(mob, magic, attackAction = null, profile = this.store.profile) {
    const outcome = this.prepareMobHitAdmission(
      mob,
      magic,
      attackAction,
      profile,
    );
    return outcome.admitted
      ? this.prepareHitOutcome(outcome.hit, profile, outcome)
      : outcome;
  }

  prepareMobHitAdmission(
    mob,
    magic,
    attackAction = null,
    profile = this.store.profile,
  ) {
    const outcome = this.createMobHitOutcome(mob, magic, attackAction, profile);
    const { hit } = outcome;
    if (
      !this.canReceiveMobHit(mob, attackAction, outcome) ||
      this.rejectsHit(hit)
    ) {
      return outcome;
    }
    if (!this.admitIncomingHit(hit, mob, magic, outcome)) return outcome;
    hit.direction = this.simulation.x >= mob.x ? 1 : -1;
    outcome.admitted =
      !this.rejectsHit(hit) &&
      !(outcome.rejectContact && attackAction === null);
    return outcome;
  }

  createMobHitOutcome(mob, magic, attackAction, profile) {
    const hit = {
      ...this.localHit,
      source: mob,
      attackAction,
      element:
        magic && attackAction !== null
          ? (mob.pendingAttack?.properties.elemAttr ?? 0)
          : 0,
    };
    return {
      hit,
      effects: [],
      accepted: false,
      consumed: false,
      profile,
      publishIncoming: true,
    };
  }

  canReceiveMobHit(mob, attackAction, outcome = null) {
    if (this.hooks.interceptContact?.(mob, attackAction, outcome)) return false;
    if (this.targetFor(mob) !== this.simulation) return false;
    return !this.hooks.protects?.(this.simulation.x, this.simulation.y);
  }

  publishIncomingHit(hit, outcome) {
    const mob = hit.source;
    const target = this.hooks.resolveIncomingSource
      ? this.hooks.resolveIncomingSource(mob)
      : mob;
    this.hooks.onEventDamage?.();
    if (hit.attackAction === null && target) {
      this.skillCombat.energyTouch(target);
    }
    this.skillDefenses.flushReflection(outcome);
    const properties = mob.pendingAttack?.properties;
    if (hit.amount > 0 && properties?.disease) {
      this.diseases.apply(properties.disease, properties.level ?? 1);
    }
  }

  hypnotizedImpact(mob, action) {
    return this.commitHitOutcome(this.prepareHypnotizedImpact(mob, action));
  }

  prepareHypnotizedImpact(mob, action) {
    const outcome = { effects: [], accepted: false, consumed: false };
    const controller = this.hooks.skillTargetController?.();
    const target = controller?.targetFor(mob);
    if (!target) return outcome;
    const generation = target.deaths;
    const amount = controller.attack(
      mob,
      target,
      action ? mob.pendingAttack : null,
      outcome,
    );
    if (amount === null) return outcome;
    outcome.effects.push(() => {
      if (target.deaths === generation && target.alive && target.active) {
        this.damageTarget(target, amount, this.hypnotizeHit, mob.facing);
      }
    });
    outcome.intercepted = true;
    return outcome;
  }

  admitIncomingHit(hit, mob, magic, outcome = null) {
    const info = mob.skillStatus.projected;
    if (
      !this.prepareIncomingOptions(
        mob,
        mob.pendingAttack,
        magic,
        hit.attackAction,
      )
    ) {
      return false;
    }
    const error = physicalTargetError(info);
    if (error) {
      this.lastStatus = `mob incoming damage unavailable: ${error}`;
      return false;
    }
    projectCharacterStats(
      outcome?.profile ?? this.store.profile,
      this.hooks,
      this.receiverStats,
      this.hooks.derivedStats?.() ?? null,
    );
    this.skillCombat.enhanceStats(this.receiverStats);
    hit.amount = this.damageGenerator.receive(
      this.receiverStats,
      info,
      this.incomingOptions,
    );
    const context = this.defenseContext;
    context.magic = magic;
    context.contact = hit.attackAction === null;
    context.outcome = outcome;
    hit.amount = this.skillDefenses.reduce(hit.amount, mob, context);
    context.outcome = null;
    return true;
  }

  prepareIncomingOptions(mob, attack, magic, action) {
    const info = mob.skillStatus.projected;
    this.incomingOptions.magic = magic;
    const authored =
      action === null ? null : (attack?.properties.PADamage ?? null);
    //007930ec..101 adds the mob's attack adjustment to either base or action PAD.
    this.incomingOptions.attackPADamage =
      authored === null
        ? null
        : Math.max(0, authored + info.PADamage - mob.template.info.PADamage);
    const base = magic
      ? info.MADamage
      : (this.incomingOptions.attackPADamage ?? info.PADamage);
    if (Number.isSafeInteger(base) && base >= 0) return true;
    this.lastStatus = "mob damage unavailable: original stat missing";
    return false;
  }

  /** Consume before callbacks: rejected or throwing outcomes cannot be replayed.
   * Native009cbb9f uses the ordinary local hit boundary with no mob attacker. */
  receiveFallLanding() {
    const landing = this.simulation.landing;
    if (landing.sequence === this.lastLandingSequence) return false;
    this.lastLandingSequence = landing.sequence;
    if (landing.amount <= 0) return false;
    const hit = this.localHit;
    hit.source = null;
    hit.attackAction = null;
    hit.element = 0;
    hit.amount = landing.amount;
    hit.direction = landing.facing;
    return this.tryReceiveHit(hit);
  }

  /** One outcome boundary for contact/authored attacks and already-authorized hits.
   * 009581a9 bypasses timer/death in authorized mode. Its separate status/action
   * deadlines are not equivalent to every ordinary attack being invulnerable. */
  tryReceiveHit(hit) {
    return this.commitHitOutcome(
      this.prepareHitOutcome(hit, this.store.profile),
    );
  }

  prepareHitOutcome(
    hit,
    profile,
    outcome = { hit, effects: [], accepted: false, consumed: false, profile },
  ) {
    validatePlayerHit(hit);
    if (
      this.rejectsHit(hit) ||
      (outcome.rejectContact && hit.attackAction === null)
    ) {
      return outcome;
    }
    outcome.impulse ??= this.prepareHitImpulse(hit);
    this.applyHitDamage(hit, profile, outcome);
    outcome.accepted = true;
    return outcome;
  }

  /** One-use publication consumes neither currency nor another random word. */
  commitHitOutcome(outcome) {
    if (!outcome || outcome.consumed) return false;
    outcome.consumed = true;
    for (const effect of outcome.effects) effect();
    if (!outcome.accepted) return outcome.intercepted ?? false;
    const { hit, impulse } = outcome;
    const profile = this.store.profile;
    this.applyHitPresentation(hit, impulse);
    const killed = profile.hp === 0 && !this.dead;
    if (killed) {
      this.phase = "dead";
      this.phaseMs = 0;
    }
    this.projectHitState(hit);
    this.changed();
    this.hooks.onPlayerHit?.(hit, this.simulation);
    if (killed) this.hooks.onPlayerDeath?.();
    if (outcome.publishIncoming) this.publishIncomingHit(hit, outcome);
    return true;
  }

  applyHitPresentation(hit, impulse) {
    this.receiveHitImpulse(hit, impulse);
    this.lastDamage = hit.amount;
    this.hitTimerMs = hit.amount > 0 ? PLAYER_HIT.timerMs : -PLAYER_HIT.timerMs;
    if (hit.amount > 0) {
      this.hooks.interruptChakra?.();
      this.scene.actor.setExpression("hit", PLAYER_HIT.timerMs);
      this.alertTimerMs = PLAYER_HIT.alertMs;
    }
  }

  /** 00959321..382 computes absorption first, then element-qualified item defense. */
  applyHitDamage(hit, profile, outcome) {
    const mp = profile.mp,
      meso = profile.meso;
    const guarded = this.skillDefenses.absorbMeso(
      Math.max(0, hit.amount),
      profile,
      outcome,
    );
    let hpDamage =
      guarded > 0
        ? (this.hooks.absorbDamage?.(guarded, profile, outcome) ?? guarded)
        : 0;
    if (
      !Number.isSafeInteger(hpDamage) ||
      hpDamage < 0 ||
      hpDamage > Math.max(0, hit.amount)
    ) {
      throw new Error("Invalid absorbed damage outcome");
    }
    const defended = this.skillDefenses.itemDefense(hit.amount, hit.element);
    hpDamage = Math.max(0, hpDamage - (hit.amount - defended));
    hit.amount = defended;
    if (hit.amount > 0) profile.hp = Math.max(0, profile.hp - hpDamage);
    hit.hpDamage = hpDamage;
    hit.mpDamage = mp - profile.mp;
    hit.mesoDamage = meso - profile.meso;
  }

  /** Damage and protection still commit when the native impulse is refused. */
  prepareHitImpulse(hit) {
    const impulse = {
      roll: -1,
      kind: "nonpositive-damage",
      direction: hit.direction,
    };
    if (hit.amount <= 0) return impulse;
    const stance = knockbackChance(
      Math.max(
        this.hooks.derivedStats?.().stance ?? 0,
        this.skillCombat.energyStance(),
      ),
    );
    impulse.roll = knockbackRoll(this.damageGenerator.next());
    if (impulse.roll < stance) impulse.kind = "stance";
    else if (hit.direction === PLAYER_HIT.noDirection) {
      impulse.kind = "no-direction";
    } else if (hit.source && impulse.roll >= OFFLINE_ORDINARY_RECOIL_PERCENT) {
      impulse.kind = "offline-recoil-resistance";
    } else impulse.kind = "ordinary";
    return impulse;
  }

  receiveHitImpulse(hit, impulse = this.prepareHitImpulse(hit)) {
    this.lastKnockbackRoll = impulse.roll;
    this.lastKnockback = impulse.kind;
    if (impulse.kind === "ordinary") {
      // Climbing characters take damage but do NOT get knocked off ladders/ropes.
      // The ladder state explicitly freezes horizontal motion; applying an impulse
      // would tear the player off the climb animation.  Damage still applies above.
      if (this.simulation.state !== "ladder") {
        applyHitImpulse(
          this.simulation,
          { ...hit, direction: impulse.direction },
          this.hooks.onExternalImpulse ?? null,
        );
      }
    }
  }

  projectHitState(hit) {
    if (hit.amount <= 0 || this.dead) this.blinkTint = PLAYER_HIT.normalTint;
    this.simulation.movementLocked = this.blocksMovement;
    this.lastStatus = this.dead
      ? "player dead; original revival confirmation required"
      : "player hit outcome admitted";
  }

  rejectsHit(hit) {
    if (this.destroyed) return true;
    if (hit.locallyInitiated && (this.hitTimerMs !== 0 || this.dead)) {
      return true;
    }
    const source = hit.source;
    if (
      source &&
      hit.attackAction === null &&
      !this.skillDefenses.contactAllowed(source)
    ) {
      return true;
    }
    return !!source && (!source.alive || !source.active || !!source.fault);
  }

  /** 00930b27 decrements before tint selection, once on the existing actor clock.
   * The persistent blink phase is not restarted by another admitted outcome. */
  advanceHitPresentation() {
    if (this.hitTimerMs > 0) {
      this.hitTimerMs = Math.max(0, this.hitTimerMs - PLAYER_HIT.tickMs);
    } else if (this.hitTimerMs < 0) {
      this.hitTimerMs = Math.min(0, this.hitTimerMs + PLAYER_HIT.tickMs);
    }
    this.blinkTint = PLAYER_HIT.normalTint;
    if (!this.dead && this.hitTimerMs > 0) {
      this.blinkCounter = (this.blinkCounter + 1) >>> 0;
      if ((this.blinkCounter & 3) < 2) this.blinkTint = PLAYER_HIT.hitTint;
    }
  }

  /** Resolve the movement action before Avatar004522a6 and recovery00a02e34.
   * Hits only write the timer; the next idle selector chooses alert artwork.
   * The countdown clamps on negative crossing:5000 lasts167 original30-ms ticks. */
  advanceAlert() {
    const action = this.simulation.action;
    this.alertPosture =
      this.alertTimerMs > 0 && (action === "stand1" || action === "stand2");
    if (this.alertTimerMs <= 0) return;
    this.alertTimerMs -= PLAYER_HIT.tickMs;
    if (this.alertTimerMs < 0) {
      this.alertTimerMs = 0;
      this.alertPosture = false;
    }
  }

  changed() {
    this.store.markDirty();
    this.hooks.onChange?.();
  }

  updateDemand() {
    if (!this.destroyed) this.renderer.updateDemand();
  }

  /** Explicit development publication uses the same combat and presentation owners. */
  addDevelopmentMob(mob) {
    if (this.destroyed || this.mobs.length >= 4096 || this.byId.has(mob.id)) {
      throw new Error("Development monster publication is unavailable");
    }
    this.mobs.push(mob);
    this.byId.set(mob.id, mob);
    try {
      this.renderer.instantiateDemand();
    } catch (error) {
      this.renderer.remove(mob);
      this.mobs.pop();
      this.byId.delete(mob.id);
      throw error;
    }
  }

  snapshot() {
    return structuredClone({
      authority: COMBAT_POLICY.authority,
      policy: COMBAT_POLICY,
      playerHit: PLAYER_HIT,
      mobPolicy: MOB_POLICY,
      progressionPolicy: PROGRESSION_POLICY,
      prepared: this.prepared,
      destroyed: this.destroyed,
      phase: this.phase,
      action: this.action,
      playback: this.playback,
      attackTiming: {
        phaseMs: this.phaseMs,
        durationMs: this.attackDurationMs,
        releaseMs: this.attackReleaseMs,
        fired: this.attackFired,
        speed: this.attackSpeed,
      },
      projectiles: this.projectiles
        .filter((shot) => shot.active)
        .map(snapshotProjectile),
      dead: this.dead,
      blocksMovement: this.blocksMovement,
      status: this.lastStatus,
      hitTimerMs: this.hitTimerMs,
      alertTimerMs: this.alertTimerMs,
      alerting: this.alerting,
      recovery: this.recovery.snapshot(),
      landing: { ...this.simulation.landing },
      blinkTint: this.blinkTint,
      lastDamage: this.lastDamage,
      lastKnockback: this.lastKnockback,
      lastKnockbackRoll: this.lastKnockbackRoll,
      impactStats: this.impactStats,
      receiverStats: this.receiverStats,
      physicalEvasion: {
        chance: this.damageGenerator.lastEvasionChance,
        evaded: this.damageGenerator.lastEvaded,
        samples: Array.from(this.damageGenerator.incomingSamples),
      },
      physicalDamage: {
        generated: this.damageGenerator.lastGenerated,
        outcome: this.damageGenerator.lastOutcome,
        cursor: this.damageGenerator.cursor,
        samples: Array.from(this.damageGenerator.samples),
      },
      player: {
        ...this.store.profile,
        nextLevelExp: experienceRequired(this.store.profile.level),
      },
      capabilities: this.scene.manifest.combat.capabilities,
      residency: { pending: this.renderer.pending, error: this.renderer.error },
      mobs: this.mobs.map(snapshotMob),
    });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.aranInput.clear();
    this.hitTimerMs = 0;
    this.alertTimerMs = 0;
    this.alertPosture = false;
    this.blinkTint = PLAYER_HIT.normalTint;
    this.renderer.destroy();
    this.skillCombat.clear();
    if (this.scene.offlineField === this) this.scene.offlineField = null;
    this.simulation.movementLocked = false;
  }
}

/** Signed original integer outcome; authorized mode must be explicitly selected. */
function validatePlayerHit(hit) {
  if (
    !hit ||
    !Number.isSafeInteger(hit.amount) ||
    hit.amount < -0x80000000 ||
    hit.amount > 0x7fffffff ||
    !Number.isSafeInteger(hit.direction) ||
    hit.direction < -0x80000000 ||
    hit.direction > 0x7fffffff ||
    typeof hit.locallyInitiated !== "boolean"
  ) {
    throw new Error("Invalid player hit outcome");
  }
}

/** Each fixed-tick projectile owns its damage and on-hit state until arrival. */
function createProjectile() {
  return {
    active: false,
    age: 0,
    duration: 0,
    projectileId: 0,
    x: 0,
    y: 0,
    endX: 0,
    endY: 0,
    facing: 1,
    target: null,
    generation: 0,
    damage: 0,
    hit: { skillId: 0, knockbackChance: 0, roll: 0 },
  };
}

/** Demand-only observation never exposes a live target or changes projectile ownership. */
function snapshotProjectile(shot) {
  return {
    id: shot.projectileId,
    elapsedMs: shot.age,
    durationMs: shot.duration,
    x: shot.x,
    y: shot.y,
    endX: shot.endX,
    endY: shot.endY,
    targetId: shot.target?.id ?? null,
    skillId: shot.hit.skillId,
  };
}

function snapshotMob(mob) {
  return {
    id: mob.id,
    templateId: mob.templateId,
    x: mob.x,
    y: mob.y,
    previousX: mob.previousX,
    previousY: mob.previousY,
    facing: mob.facing,
    footholdId: mob.foothold?.id ?? 0,
    hp: mob.hp,
    maxHP: mob.maxHP,
    mp: mob.mp,
    opacity: mob.opacity,
    spawnMs: mob.spawnMs,
    maxMP: mob.maxMP,
    alive: mob.alive,
    visible: mob.visible,
    active: mob.active,
    state: mob.state,
    movement: mob.movement,
    movementType: mob.movementType,
    flight: mob.flight
      ? {
          vx: mob.flight.vx,
          vy: mob.flight.vy,
          goalX: mob.flight.goalX,
          goalY: mob.flight.goalY,
          speedLimit: mob.flight.speedLimit,
          swimming: mob.flight.swimming,
        }
      : null,
    action: mob.action,
    frame: mob.frame,
    actionMs: mob.actionMs,
    body: { ...mob.body },
    sweptBody: { ...mob.sweptBody },
    deaths: mob.deaths,
    respawnMs: mob.respawnMs,
    lastDamage: mob.lastDamage,
    lastReaction: mob.lastReaction,
    hitRemainingMs: mob.hitRemainingMs,
    knockbackMs: mob.knockbackMs,
    knockbackSpeed: mob.knockbackSpeed,
    resident: !!mob.presentation,
    authored: mob.record.authored,
    selectedSkills: mob.selectedSkills,
    attacks: mob.attacks,
    fault: mob.fault,
    physicalDamageError: physicalTargetError(mob.template.info),
    authority: COMBAT_POLICY.authority,
  };
}
