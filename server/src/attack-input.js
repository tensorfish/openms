import { PROTOCOL } from "../../shared/protocol.js";

const MAX_EDGES = 8;
const MAX_AGE_TICKS = Math.ceil(2000 / PROTOCOL.TICK_MS);

export function resetAttackInput(actor) {
  actor.attackEdges = [];
  actor.receivedAttack = false;
  actor.combatInputSeq = null;
  actor.attackAdmission = null;
  // Retire diagnostic hit reports with their attack and field lifetime.
  actor.hitReports?.clear();
}

/** Movement admission is independent of this bounded, ephemeral combat queue.
 * Return whether this press was retained; animation/transaction backpressure is cooldown. */
export function retainAttackInput(actor, sample) {
  const pressed = sample.attack && !actor.receivedAttack;
  actor.receivedAttack = sample.attack;
  if (!pressed) return false;
  const tick = actor.field.tick;
  if (
    sample.targetTick < tick - MAX_AGE_TICKS ||
    sample.targetTick > tick + PROTOCOL.INPUT_LEAD_TICKS
  ) {
    return false;
  }
  expireAttackInput(actor);
  if (actor.attackEdges.length >= MAX_EDGES) {
    actor.attackAdmission = "COOLDOWN";
    return false;
  }
  actor.attackEdges.push({
    inputSeq: sample.inputSeq,
    tick: Math.max(tick + 1, sample.targetTick),
    expires: sample.targetTick + MAX_AGE_TICKS,
  });
  actor.attackAdmission = null;
  return true;
}

function expireAttackInput(actor) {
  for (let count = 0; count < MAX_EDGES; count++) {
    if (
      !actor.attackEdges[0] ||
      actor.attackEdges[0].expires >= actor.field.tick
    ) {
      break;
    }
    actor.attackEdges.shift();
  }
}

/** Consume each press once, even when its release arrived in the same network burst. */
export function takeAttackInput(actor, ready = true) {
  actor.combatInputSeq = null;
  expireAttackInput(actor);
  if (!ready) return false;
  const edge = actor.attackEdges[0];
  if (!edge || edge.tick > actor.field.tick) return false;
  actor.attackEdges.shift();
  if (edge.expires < actor.field.tick) return false;
  actor.combatInputSeq = edge.inputSeq;
  return true;
}
