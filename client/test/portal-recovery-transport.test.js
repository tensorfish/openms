import { expect, test } from "bun:test";
import { OnlineTransport } from "../src/online/transport.js";
import { createProfile } from "../src/profile/profile-validation.js";
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
  const transport = new OnlineTransport({
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

test("portal receipt, actual destination snapshots and motion remain ordered while map presentation waits", async () => {
  const probe = await fixture();
  const { world, actor, transport, frames, gate, publications } = probe;
  const start = frames.length;
  try {
    const portal = actor.field.physics.portals.find(
      (row) => row.targetMap === 100000003,
    );
    expect(portal).toBeDefined();
    const outcome = transport.command({
      kind: "portal.enter",
      portalId: portal.id,
    });
    const command = probe.commands.at(-1);
    // Isolated transaction fixture starts at the admitted portal boundary. Real
    // transition/preview/publication/assembly code owns every subsequent packet.
    const receipt = await transitionActor(
      world,
      actor,
      { mapId: portal.targetMap, portal: portal.targetName },
      { operationId: command.operationId },
    );
    await world.participants.reconcile(actor, receipt);
    publications.publish(actor, {
      type: "result",
      operationId: command.operationId,
      status: receipt.status,
      code: receipt.code,
      domainRevision: receipt.domainRevision,
      transactionId: receipt.transactionId,
      value: receipt.value,
    });
    await until(() => !transport.pending.has(command.operationId));
    expect((await outcome).status).toBe("committed");
    expect(actor.field.mobs).toHaveLength(18);
    expect(transport.model.field.mapId).toBe(100000003);
    expect(transport.status).toBe("synchronizing");
    gate.resolve();
    await until(
      () => transport.status === "active" && !transport.renderer.task,
    );
    expect(transport.snapshot().lastFailure).toBeNull();
    expect(frames.slice(start).map((frame) => frame.type)).toContain("result");
    expect(
      frames
        .slice(start)
        .filter((frame) => frame.type === "transition")
        .map((frame) => frame.phase),
    ).toEqual(["prepare", "committed"]);
    expect(probe.installs.at(-1)).toBe(100000003);
  } finally {
    gate.resolve();
    transport.close();
    disposeActorSkills(actor, true);
  }
});
