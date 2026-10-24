import { expect, test } from "bun:test";
import { OnlineTransport } from "../src/online/transport.js";
import { createProfile } from "../src/profile/profile-validation.js";
import { advanceSimulation } from "../src/physics/simulation.js";
import { decodeClient } from "../../shared/protocol.js";
import { loadContent } from "../../server/src/content.js";
import { OnlineWorld } from "../../server/src/world.js";
import { Publications } from "../../server/src/publication.js";
import {
  transitionActor,
  settleTransitionReady,
} from "../../server/src/field-transition.js";
import { disposeActorSkills } from "../../server/src/field-skills.js";

const content = await loadContent();

async function until(predicate) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("Portal fixture did not settle");
}

function installTransactions(world, actor) {
  world.participants.commit = async (_owner, operation, _ids, mutate) => {
    const draft = structuredClone(actor.profile);
    const result = await mutate(new Map([[actor.id, draft]]));
    actor.profile = draft;
    actor.revision++;
    return {
      status: "committed",
      code: "OK",
      domainRevision: actor.revision,
      transactionId: operation.operationId,
      ...result,
    };
  };
}

function link(probe) {
  const { actor, transport, publications, world, frames, commands } = probe;
  const socket = {
    data: {
      actor,
      epoch: "connection",
      ready: false,
      closed: false,
      ackEventSeq: 0,
      baselines: new Map(),
    },
    getBufferedAmount: () => 0,
    close(code, reason) {
      throw new Error(`Server closed: ${code} ${reason}`);
    },
    send(text) {
      frames.push(JSON.parse(text));
      transport.receive({ data: text });
      return text.length;
    },
  };
  actor.connection = socket;
  transport.socket = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    close() {
      this.readyState = WebSocket.CLOSED;
    },
    send(text) {
      const message = decodeClient(text);
      if (message.type === "ack") publications.acknowledge(socket, message);
      if (message.type === "ready") {
        expect(socket.data.baselines.has(message.snapshotId)).toBe(true);
        socket.data.ready = true;
        socket.data.ackSnapshotId = message.snapshotId;
        if (actor.state === "preparing") actor.state = "active";
      }
      if (message.type === "transition-ready") {
        settleTransitionReady(world, actor, message);
      }
      if (message.type === "command") commands.push(message);
    },
  };
}

function traveler(source) {
  const profile = createProfile({
    mapId: source.manifest.id,
    x: 0,
    y: 0,
    facing: 1,
  });
  profile.settings.questTracker.auto = false;
  profile.onlineState = { effects: [], cooldowns: {} };
  return {
    id: crypto.randomUUID(),
    accountId: crypto.randomUUID(),
    profile,
    revision: 0,
    inventoryRevision: 0,
    socialRevision: 0,
    session: { expiresAt: Date.now() + 60000 },
  };
}

function stagedTransport(gate, installs) {
  const failures = [];
  const transport = new OnlineTransport({
    onStatus: ({ status, code }) => {
      if (status === "disconnected") failures.push(code);
    },
    onSnapshot: async (snapshot) => {
      installs.push(snapshot.field.mapId);
      if (snapshot.field.mapId === 100000003) await gate.promise;
    },
    onTransition: (message) => {
      if (message.phase === "prepare") {
        transport.sendTransitionReady(
          message.transitionId,
          true,
          message.sourceEpoch,
        );
      }
    },
  });
  transport.failures = failures;
  return transport;
}

async function fixture(prepareProfile = null) {
  const frames = [],
    commands = [],
    installs = [];
  const gate = Promise.withResolvers();
  const transport = stagedTransport(gate, installs);
  const world = new OnlineWorld({
    content,
    database: {
      bindField: async () => {},
      validate() {},
      searchParticipants: async () => [],
    },
    publish: (actor, record) => publications.publish(actor, record),
  });
  const publications = new Publications(world);
  const source = await world.fieldFor(100000002);
  const actor = traveler(source);
  prepareProfile?.(actor.profile);
  Object.assign(transport, {
    status: "synchronizing",
    connectionEpoch: "connection",
    expectedFieldEpoch: source.epoch,
    lastMessageAt: performance.now(),
    limits: { maxMessageBytes: 16384, commandPerSecond: 12 },
  });
  const probe = {
    frames,
    commands,
    installs,
    gate,
    actor,
    transport,
    publications,
    world,
  };
  installTransactions(world, actor);
  link(probe);
  await world.join(actor);
  transport.playSession = actor.playSession;
  transport.characterId = actor.id;
  await until(
    () =>
      transport.status === "active" &&
      !transport.renderer.task &&
      !transport.draining,
  );
  return probe;
}

function firePoison(profile) {
  Object.assign(profile, { job: 212, level: 120, baseMaxMP: 2000, mp: 2000 });
  profile.skills[2121005] = {
    level: 1,
    masterLevel: 30,
    expiresAt: null,
  };
  profile.skills[2121003] = { level: 5, masterLevel: 30, expiresAt: null };
}

async function castIfrit(world, actor) {
  for (
    let tick = 0;
    tick < 120 && actor.simulation.state !== "ground";
    tick++
  ) {
    advanceSimulation(actor.simulation, actor.input, 30);
  }
  expect(actor.simulation.state).toBe("ground");
  await world.cast(
    actor,
    { skillId: 2121005 },
    { operationId: crypto.randomUUID(), fieldEpoch: actor.field.epoch },
  );
  expect(actor.skills.worldController.active(2121005)).toBe(true);
}

async function observer(probe) {
  const { actor: owner, world, publications } = probe;
  const actor = traveler(owner.field);
  const transport = stagedTransport(Promise.withResolvers(), []);
  Object.assign(transport, {
    status: "synchronizing",
    connectionEpoch: "connection",
    expectedFieldEpoch: owner.field.epoch,
    limits: { maxMessageBytes: 16384, commandPerSecond: 12 },
  });
  const frames = [];
  link({ actor, transport, publications, world, frames, commands: [] });
  await world.join(actor);
  transport.playSession = actor.playSession;
  await until(() => transport.status === "active" && !transport.draining);
  return { actor, transport, frames };
}

function expectCommitBeforeDestination(frames, epoch) {
  const commit = frames.findIndex((frame) => frame.phase === "committed");
  const destination = frames.findIndex((frame) => frame.fieldEpoch === epoch);
  expect(commit).toBeGreaterThanOrEqual(0);
  expect(destination).toBeGreaterThan(commit);
}

test("a retained Ifrit reaches the destination baseline without events preceding commit", async () => {
  const probe = await fixture(firePoison);
  const { world, actor, transport, frames, gate } = probe;
  try {
    await castIfrit(world, actor);
    await until(() => !transport.draining);
    expect(actor.skills.worldController.active(2121005)).toBe(true);
    const start = frames.length;
    await transitionActor(
      world,
      actor,
      { mapId: 100000003, portal: 0 },
      { operationId: crypto.randomUUID() },
    );
    await until(() => !transport.draining);
    expectCommitBeforeDestination(frames.slice(start), actor.field.epoch);
    expect(transport.failures).toEqual([]);
    gate.resolve();
    await until(() => transport.status === "active");
    expect(actor.skills.worldController.active(2121005)).toBe(true);
    expect(transport.model.self.entity.skillVisuals.length).toBeGreaterThan(0);
    const skill = { ...content.catalog.ui.skills[2121005], id: 2121005 };
    const voice = actor.skills.resources.sound(skill, "Use", true);
    world.publish(actor, { type: "snapshot-request" });
    await until(() => !transport.draining && !transport.renderer.task);
    expect(transport.model.self.entity.skillVoices).toContainEqual({
      voiceId: voice.id,
      skillId: 2121005,
      leaf: "Use",
    });
    expect(transport.failures).toEqual([]);
  } finally {
    gate.resolve();
    transport.close();
    disposeActorSkills(actor, true);
  }
});

test("travel retires an active looping skill voice without publishing its destination before commit", async () => {
  const probe = await fixture();
  const { world, actor, transport, frames, gate } = probe;
  const peer = await observer(probe);
  const source = actor.field;
  try {
    const skill = { ...content.catalog.ui.skills[2001004], id: 2001004 };
    const voice = actor.skills.resources.sound(skill, "Use", true);
    expect(voice).not.toBeNull();
    await until(() => !transport.draining);
    const start = frames.length;
    await transitionActor(
      world,
      actor,
      { mapId: 100000003, portal: 0 },
      { operationId: crypto.randomUUID() },
    );
    await until(() => !transport.draining);
    expectCommitBeforeDestination(frames.slice(start), actor.field.epoch);
    await until(() => !peer.transport.draining);
    expect(
      peer.frames.find(
        (frame) => frame.event?.voiceId === voice.id && frame.event.stopped,
      ),
    ).toMatchObject({ fieldEpoch: source.epoch });
    expect(transport.failures).toEqual([]);
    gate.resolve();
    await until(() => transport.status === "active");
    expect(transport.model.field.mapId).toBe(100000003);
    expect(transport.model.self.entity.skillVoices).toEqual([]);
    expect(peer.transport.failures).toEqual([]);
  } finally {
    gate.resolve();
    transport.close();
    disposeActorSkills(actor, true);
    peer.transport.close();
    disposeActorSkills(peer.actor, true);
  }
});

test("a failed durable travel discards destination skill initialization and keeps the source summon", async () => {
  const probe = await fixture(firePoison);
  const { world, actor, transport, frames, gate } = probe;
  try {
    await castIfrit(world, actor);
    await until(() => !transport.draining);
    const source = actor.field;
    const target = await world.fieldFor(100000003);
    const broadcasts = [];
    const broadcast = world.broadcast.bind(world);
    world.broadcast = (field, message) => {
      if (field === target) broadcasts.push(message);
      broadcast(field, message);
    };
    world.participants.commit = async (_owner, _operation, _ids, mutate) => {
      await mutate(new Map([[actor.id, structuredClone(actor.profile)]]));
      throw new Error("Durable travel refused");
    };
    await expect(
      transitionActor(
        world,
        actor,
        { mapId: target.mapId, portal: 0 },
        { operationId: crypto.randomUUID() },
      ),
    ).rejects.toThrow("Durable travel refused");
    await until(() => transport.status === "active" && !transport.draining);
    expect(broadcasts).toEqual([]);
    expect(actor.field).toBe(source);
    expect(actor.skills.worldController.active(2121005)).toBe(true);
    expect(transport.model.self.entity.skillVisuals.length).toBeGreaterThan(0);
    expect(frames.some((frame) => frame.phase === "aborted")).toBe(true);
    expect(transport.failures).toEqual([]);
  } finally {
    gate.resolve();
    transport.close();
    disposeActorSkills(actor, true);
  }
});
