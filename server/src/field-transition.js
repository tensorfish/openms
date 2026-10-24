import { resetAttackInput } from "./attack-input.js";
import { randomUUID } from "node:crypto";
import { protocolError } from "../../shared/schema.js";
import {
  createSimulation,
  relocateSimulation,
} from "../../client/src/physics/simulation.js";
import {
  arrivalPosition,
  nearestSavedArrival,
} from "../../client/src/world/field-arrival.js";
import {
  PortalTravelGate,
  portalRouteStatus,
  marketPortalKind,
  scriptedPortalKind,
  resolveMarketTravel,
  selectMarketReturnPortal,
} from "../../client/src/world/portal-system.js";
import {
  portalEntryContains,
  portalRectangleContains,
} from "../../client/src/world/portal-presentation.js";
import {
  admitTutorialPortal,
  tutorialPortalKind,
  tutorialNpcOffered,
  resolveTutorialPortal,
} from "../../client/src/npc/npc-script-portals.js";
import {
  revivalMap,
  REVIVAL_POLICY,
} from "../../client/src/character/revival.js";
import { fieldReference } from "./field-views.js";
import {
  prepareSkillTravel,
  bindSkillTravel,
  releaseSkillTravel,
} from "./field-skills.js";
import { releaseInteractions } from "./interactions.js";
import { prepareMotionDiverts } from "./field-diverts.js";
import {
  bindActorWorldActions,
  clearActorSeat,
  prepareActorWorldActionField,
} from "./field-world-actions.js";
import { interactionReceipt } from "./interaction-common.js";
import { operationFor } from "./action-rules.js";
import { publishTravelPreview } from "./field-travel-preview.js";
import { scriptedPortalTravel } from "./field-portal-scripts.js";
import { PROTOCOL } from "../../shared/protocol.js";

const TRAVEL_TIMEOUT_MS = PROTOCOL.ASSET_PREPARATION_TIMEOUT_MS;
const AUTOMATIC_TYPES = new Set([3, 9, 12, 13]);

function rawPortal(actor, portal) {
  return actor.field.manifest.physics.map.$portalProperties?.[portal.id] ?? {};
}

/** The same original half-open integer-feet geometry is used by both client and authority. */
export function portalContact(actor, portal) {
  if (AUTOMATIC_TYPES.has(portal.type)) {
    const raw = rawPortal(actor, portal);
    return portalRectangleContains(
      portal,
      actor.simulation,
      Math.trunc((raw.hRange ?? 100) / 2),
      Math.trunc((raw.vRange ?? 100) / 2),
    );
  }
  return (
    Boolean(actor.simulation.footholdId) &&
    portalEntryContains(portal, actor.simulation)
  );
}

function admittedPortal(actor, id) {
  const portal = actor.field.manifest.physics.portals.find(
    (entry) => entry.id === id,
  );
  if (!portal) throw protocolError("NOT_FOUND");
  if (!portalContact(actor, portal)) throw protocolError("NOT_IN_RANGE");
  if (
    actor.profile.hp <= 0 ||
    actor.attackState?.active ||
    actor.simulation.movementLocked ||
    actor.tradeId ||
    actor.conversation
  ) {
    throw protocolError("NOT_ALLOWED");
  }
  const raw = rawPortal(actor, portal);
  // A sentinel script's own compiled program decides its admission and route.
  const unsupported = scriptedPortalKind(portal, raw)
    ? null
    : portalRouteStatus(portal, raw);
  if (unsupported) {
    actor.admission = `unsupported-content: ${unsupported}`;
    throw protocolError("REQUIREMENTS_NOT_MET");
  }
  return portal;
}

function portalDestination(actor, portal) {
  const raw = rawPortal(actor, portal);
  if (marketPortalKind(portal, raw)) {
    const route = resolveMarketTravel(
      { script: raw.script, sourceMapId: actor.field.manifest.id },
      actor.profile,
    );
    return { ...route, market: true, sound: true, packet: true };
  }
  return {
    mapId: portal.targetMap,
    portal: portal.targetName,
    sound: portal.type !== 4 && portal.type !== 5,
    packet:
      portal.type === 4 ||
      portal.type === 5 ||
      portal.targetMap !== actor.field.mapId,
  };
}

function destinationRequest(actor, destination, portal) {
  if (portal) return portalDestination(actor, portal);
  if (destination.revive !== undefined) {
    if (actor.profile.hp > 0) throw protocolError("NOT_ALLOWED");
    if (destination.revive !== "return") {
      actor.admission =
        "unsupported-content: revive consumable controller unavailable";
      throw protocolError("REQUIREMENTS_NOT_MET");
    }
    return {
      mapId: revivalMap(actor.field.manifest),
      portal: 0,
      revive: true,
      packet: true,
    };
  }
  return { ...destination, packet: true };
}

function destinationArrival(world, actor, target, request) {
  if (request.portal?.marketReturn) {
    return arrivalPosition(
      target.manifest,
      selectMarketReturnPortal(target.physics, world.random),
    );
  }
  if (request.portal !== undefined) {
    return arrivalPosition(target.manifest, request.portal);
  }
  if (!request.randomSpawn) {
    return nearestSavedArrival(
      target.manifest,
      request.x === undefined
        ? actor.profile.location
        : {
            x: request.x,
            y: request.y,
            facing: request.facing ?? actor.simulation.facing,
          },
    );
  }
  const eligible = target.manifest.physics.portals.filter(
    (portal) =>
      (portal.type === 0 || portal.type === 1) &&
      portal.targetMap === 999999999,
  );
  if (!eligible.length) throw protocolError("CONTENT_MISMATCH");
  return arrivalPosition(
    target.manifest,
    eligible[Math.floor(world.random() * eligible.length)].id,
  );
}

function travelGate(world, actor) {
  actor.portalGate ??= new PortalTravelGate(() => world.now);
  return actor.portalGate;
}

function beginTransition(world, actor, request) {
  if (
    actor.state !== "active" ||
    actor.field.characters.get(actor.id) !== actor
  ) {
    throw protocolError("STALE_FIELD");
  }
  const gate = travelGate(world, actor);
  const token = gate.tryBegin(request.packet);
  if (!token) throw protocolError("COOLDOWN");
  const transition = {
    request,
    token,
    source: actor.field,
    transitionId: randomUUID(),
    deadline: Date.now() + TRAVEL_TIMEOUT_MS,
    departure: { x: actor.simulation.x, y: actor.simulation.y },
    facing: actor.simulation.facing,
    targetReserved: false,
    ready: null,
    readyConnection: null,
    timer: null,
  };
  actor.transition = transition;
  actor.state = "transitioning";
  actor.simulation.movementLocked = true;
  const data = actor.connection?.data;
  if (data) {
    transition.sourceReadiness = {
      connection: actor.connection,
      ready: data.ready,
      readyDeadlineAt: data.readyDeadlineAt,
      transfer: data.transfer,
    };
    data.transfer = {
      sourceEpoch: actor.field.epoch,
      baselines: new Map(data.baselines),
    };
    data.ready = false;
  }
  world.neutralize(actor);
  return transition;
}

function assertTransition(actor, transition) {
  if (
    actor.retiring ||
    !actor.session ||
    actor.session.revoked ||
    actor.session.expiresAt <= Date.now()
  ) {
    throw protocolError("SESSION_EXPIRED");
  }
  if (
    actor.transition !== transition ||
    actor.field !== transition.source ||
    actor.state !== "transitioning" ||
    Date.now() > transition.deadline
  ) {
    throw protocolError("STALE_FIELD");
  }
  if (
    transition.readyConnection &&
    actor.connection !== transition.readyConnection
  ) {
    throw protocolError("SESSION_EXPIRED");
  }
}

function prepareTransition(world, actor, transition, target) {
  assertTransition(actor, transition);
  if (target !== transition.source) {
    if (target.characters.size + (target.travelReservations ?? 0) >= 128) {
      throw protocolError("SERVER_BUSY");
    }
    target.travelReservations = (target.travelReservations ?? 0) + 1;
    transition.targetReserved = true;
  }
  transition.target = target;
  transition.arrival = destinationArrival(
    world,
    actor,
    target,
    transition.request,
  );
  transition.simulation = transition.request.packet
    ? createSimulation(target.physics, transition.arrival)
    : null;
  transition.worldActions = transition.request.packet
    ? prepareActorWorldActionField(actor, target.manifest)
    : null;
  transition.reference = {
    instanceId: target.id,
    mapId: target.mapId,
    fieldEpoch: target.epoch,
    spawn: { x: transition.arrival.x, y: transition.arrival.y },
  };
}

/** A separate transition-ready packet is legal while the initiating action owns actor.pending. */
export function settleTransitionReady(world, actor, message) {
  const transition = actor.transition;
  if (
    !transition ||
    transition.transitionId !== message.transitionId ||
    transition.source.epoch !== message.fieldEpoch ||
    !transition.ready ||
    actor.connection !== transition.readyConnection
  ) {
    throw protocolError("STALE_FIELD");
  }
  assertTransition(actor, transition);
  transition.ready(message.accepted);
  transition.ready = null;
}

async function awaitDestination(world, actor, transition) {
  if (!transition.request.packet) return;
  if (!actor.connection) throw protocolError("SESSION_EXPIRED");
  transition.readyConnection = actor.connection;
  const ready = new Promise((resolve) => {
    transition.ready = resolve;
    transition.timer = setTimeout(
      () => resolve(false),
      Math.max(1, transition.deadline - Date.now()),
    );
  });
  publishTravelPreview(world, actor, transition);
  const accepted = await ready;
  clearTimeout(transition.timer);
  transition.timer = null;
  transition.ready = null;
  if (!accepted) throw protocolError("TRANSITION_FAILED");
  assertTransition(actor, transition);
}

function applyArrival(draft, transition) {
  const { target, arrival, request } = transition;
  draft.location = {
    mapId: target.manifest.id,
    x: arrival.x,
    y: arrival.y,
    facing: request.packet ? 1 : transition.facing,
  };
  if (request.market) draft.savedLocations.FREE_MARKET = request.savedLocation;
  if (request.revive) {
    draft.hp = Math.min(draft.maxHP, REVIVAL_POLICY.restoredHP);
  }
}

function commitTransition(world, actor, transition, operation) {
  const membership = {
    instanceId: transition.target.id,
    fieldEpoch: transition.target.epoch,
  };
  const scoped = { ...operation, membership };
  const mutate = async (drafts) => {
    assertTransition(actor, transition);
    const draft = drafts.get(actor.id);
    const outcome = operation.mutate
      ? await operation.mutate(operation.ids ? drafts : draft)
      : {};
    assertTransition(actor, transition);
    applyArrival(draft, transition);
    if (transition.request.packet) {
      transition.skillCandidate = await prepareSkillTravel(world, actor, {
        field: transition.target,
        simulation: transition.simulation,
        profile: draft,
      });
      scoped.runtimePrepared = actor.id;
      assertTransition(actor, transition);
    }
    return {
      ...outcome,
      value: outcome?.value ?? {
        kind: "world.travel",
        destination: transition.reference,
      },
    };
  };
  return world.participants.commit(
    actor,
    scoped,
    operation.ids ?? [actor.id],
    mutate,
  );
}

/** Field ticks start at zero per field, so every per-actor value read against
 *  `actor.field.tick` or field identity is bound here on field entry and packet travel. */
export function bindActorField(actor, field) {
  actor.field = field;
  actor.lastInputTick = field.tick;
  actor.lastAdoptedTick = field.tick;
  actor.actionStartTick = field.tick;
  prepareMotionDiverts(actor, field);
}

function bindTransition(world, actor, transition) {
  const { source, target, arrival, simulation, request } = transition;
  releaseInteractions(actor, world);
  clearActorSeat(actor);
  actor.arrival = arrival;
  if (!request.packet) {
    relocateSimulation(actor.simulation, arrival);
  } else {
    source.characters.delete(actor.id);
    actor.simulation = simulation;
    bindActorField(actor, target);
    target.characters.set(actor.id, actor);
    bindSkillTravel(actor, transition.skillCandidate);
    bindActorWorldActions(actor, transition.worldActions);
  }
  actor.state = "active";
  actor.inputQueue.clear();
  resetAttackInput(actor);
  actor.simulation.movementLocked = actor.profile.hp <= 0;
  if (!request.packet) restoreSourceReadiness(actor, transition);
}

function publishTransition(world, actor, transition) {
  const { source, target, request, transitionId, deadline } = transition;
  if (request.packet) {
    resetReadiness(actor);
    world.publish(actor, {
      type: "transition",
      transitionId,
      phase: "committed",
      sourceEpoch: source.epoch,
      destination: fieldReference(actor),
      requiredContent: [],
      deadline,
      code: "OK",
    });
    // Binding restores inherited visuals/voices before this packet; its first
    // destination baseline carries that state without pre-commit publications.
    actor.skills.resources.enablePublication();
  } else {
    world.broadcast(source, {
      type: "event",
      fieldEpoch: source.epoch,
      event: {
        kind: "world.teleport",
        actorId: actor.id,
        source: transition.departure,
        destination: transition.reference.spawn,
        impactTick: source.tick,
        recoveryMs: 600,
      },
    });
  }
  // Cross-map audio accompanies prepare; a destination event can precede its baseline.
  if (request.sound && !request.packet) {
    world.publish(actor, {
      type: "event",
      fieldEpoch: target.epoch,
      event: { kind: "world.portal", actorId: actor.id },
    });
  }
  world.invalidateField(source);
  if (target !== source) world.invalidateField(target);
}

function restoreSourceReadiness(actor, transition) {
  const previous = transition.sourceReadiness;
  if (!previous || actor.connection !== previous.connection) return;
  actor.connection.data.ready = previous.ready;
  actor.connection.data.readyDeadlineAt = previous.readyDeadlineAt;
  actor.connection.data.transfer = previous.transfer;
}

function rollbackTransition(world, actor, transition) {
  if (actor.retiring || actor.session?.revoked) return;
  actor.state = "active";
  actor.simulation.movementLocked = actor.profile.hp <= 0;
  if (!transition.request.packet) restoreSourceReadiness(actor, transition);
  if (transition.request.packet) {
    world.publish(actor, {
      type: "transition",
      transitionId: transition.transitionId,
      phase: "aborted",
      sourceEpoch: transition.source.epoch,
      destination: null,
      requiredContent: [],
      deadline: transition.deadline,
      code: "TRANSITION_FAILED",
    });
    resetReadiness(actor);
  }
  world.publish(actor, { type: "snapshot-request" });
}

function resetReadiness(actor) {
  const data = actor.connection?.data;
  if (!data) return;
  data.baselines.clear();
  data.ackSnapshotId = null;
  data.ready = false;
  data.readyDeadlineAt = Date.now() + PROTOCOL.ASSET_PREPARATION_TIMEOUT_MS;
}

async function tutorialPortal(world, actor, portal) {
  const record = actor.field.manifest.portalPresentation.records.find(
    (entry) => entry.portalId === portal.id,
  );
  const program = admitTutorialPortal(record?.tutorialProgram);
  if (program.script !== tutorialPortalKind(portal, rawPortal(actor, portal))) {
    throw protocolError("CONTENT_MISMATCH");
  }
  const gate = travelGate(world, actor);
  if (gate.blockedScripts.has(program.script)) {
    return interactionReceipt(actor.revision);
  }
  const token = gate.tryBegin(true);
  if (!token) throw protocolError("COOLDOWN");
  let committed = false;
  try {
    if (tutorialNpcOffered(program)) await world.openPortalNpc(actor, portal);
    const path = resolveTutorialPortal(program, actor.profile);
    if (path) {
      world.publish(actor, {
        type: "event",
        fieldEpoch: actor.field.epoch,
        event: { kind: "world.tutorial", path },
      });
    }
    gate.blockedScripts.add(program.script);
    committed = true;
    return interactionReceipt(actor.revision);
  } finally {
    gate.complete(token, committed ? "committed" : "failed");
  }
}

/** Internal trusted destination only; gameplay intent never carries a map/XY. */
export async function transitionActor(world, actor, destination, operation) {
  let portal =
    destination.portalId === undefined
      ? null
      : admittedPortal(actor, destination.portalId);
  if (portal && tutorialPortalKind(portal, rawPortal(actor, portal))) {
    return tutorialPortal(world, actor, portal);
  }
  if (portal && scriptedPortalKind(portal, rawPortal(actor, portal))) {
    const scripted = await scriptedPortalTravel(
      world,
      actor,
      portal,
      operation,
    );
    // GenericPortal: a script that does not warp leaves the character in place.
    if (!scripted) return interactionReceipt(actor.revision);
    ({ destination, operation } = scripted);
    portal = null;
  }
  const request = destinationRequest(actor, destination, portal);
  const transition = beginTransition(world, actor, request);
  let committed = false;
  try {
    const target = await world.fieldFor(request.mapId, actor.realm, true);
    try {
      prepareTransition(world, actor, transition, target);
    } finally {
      target.entryReservations--;
    }
    // Client downloads precede row locks. The transaction revalidates admission,
    // effects and destination against fresh durable state after preparation.
    await awaitDestination(world, actor, transition);
    const receipt = await commitTransition(world, actor, transition, operation);
    if (receipt.status !== "committed") return receipt;
    bindTransition(world, actor, transition);
    committed = true;
    publishTransition(world, actor, transition);
    return receipt;
  } finally {
    clearTimeout(transition.timer);
    releaseSkillTravel(transition.skillCandidate);
    if (transition.targetReserved) transition.target.travelReservations--;
    if (!committed) rollbackTransition(world, actor, transition);
    travelGate(world, actor).complete(
      transition.token,
      committed ? "committed" : "failed",
    );
    actor.portalUntil = travelGate(world, actor).lastRequestMs + 500;
    if (actor.transition === transition) actor.transition = null;
  }
}

/** Only the traveling actor receives destination DB membership; cohort mutations commit together. */
export function travelParticipants(world, actor, message, spec) {
  return transitionActor(world, actor, spec.destination, {
    ...operationFor(message),
    ids: spec.ids,
    mutate: spec.mutate,
  });
}

/** Reverse authored order determines the one automatic overlap that owns reentry. */
function contactedAutomaticPortal(actor) {
  const portals = actor.field.manifest.physics.portals;
  for (let index = portals.length - 1; index >= 0; index--) {
    const portal = portals[index];
    if (AUTOMATIC_TYPES.has(portal.type) && portalContact(actor, portal)) {
      return portal;
    }
  }
  return null;
}

function automaticPortalReady(actor, portal) {
  const gate = actor.portalGate;
  if (!gate) return true;
  const now = gate.now();
  const packet = portal.type !== 3 || portal.targetMap !== actor.field.mapId;
  return !(packet ? now - gate.lastRequestMs < 500 : now < gate.sameMapUntilMs);
}

/** Attempted failed automatic overlap requires physical reentry. */
export function automaticPortalCandidate(actor) {
  const selected = contactedAutomaticPortal(actor);
  if (!selected) actor.automaticPortalAttempt = null;
  if (
    !selected ||
    actor.automaticPortalAttempt === selected ||
    actor.portalGate?.active ||
    actor.attackState?.active ||
    actor.simulation.movementLocked
  ) {
    return null;
  }
  return automaticPortalReady(actor, selected) ? selected : null;
}
export function markAutomaticPortalAttempt(actor, portal) {
  actor.automaticPortalAttempt = portal;
}

/** Detached logout uses ordinary return-map/portal policy before its fenced checkpoint. */
export async function prepareLogout(world, actor) {
  actor.transition?.ready?.(false);
  if (actor.profile.hp > 0) return;
  const source =
    actor.field?.manifest?.id === actor.profile.location.mapId
      ? actor.field.manifest
      : await world.content.map(actor.profile.location.mapId);
  const manifest = await world.content.map(revivalMap(source));
  const arrival = destinationArrival(world, actor, { manifest }, { portal: 0 });
  actor.profile.location = {
    mapId: manifest.id,
    x: arrival.x,
    y: arrival.y,
    facing: 1,
  };
  actor.profile.hp = Math.min(actor.profile.maxHP, REVIVAL_POLICY.restoredHP);
}
