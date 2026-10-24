import { expect, test } from "bun:test";
import { GameplayGateway } from "../src/gateway.js";
import { OnlineWorld } from "../src/world.js";
import { transitionActor } from "../src/field-transition.js";
import { createProfile } from "../../client/src/profile/profile-validation.js";
import { decodeClient } from "../../shared/protocol.js";
import { createLifecycle } from "../src/index.js";

function fixture() {
  const persisted = [];
  const released = [];
  const database = {
    async checkpoint(actor) {
      persisted.push(structuredClone(actor.profile));
    },
    async releaseLease(actor) {
      released.push(actor.id);
    },
  };
  const world = new OnlineWorld({
    content: { items: {} },
    database,
    publish() {},
  });
  const gateway = new GameplayGateway({
    config: {},
    auth: {},
    database,
    world,
  });
  const session = { id: "session", accountId: "account", revoked: false };
  const field = {
    epoch: "source",
    characters: new Map(),
    mobs: [],
    npcs: new Map(),
    drops: new Map(),
    reactors: { records: [] },
    manifest: {},
  };
  const actor = {
    id: "character",
    accountId: session.accountId,
    sessionId: session.id,
    session,
    field,
    state: "active",
    portalUntil: 0,
    pending: false,
    profile: {
      ...createProfile({ mapId: "100000000", x: 0, y: 0, facing: 1 }),
      hp: 100,
      maxHP: 100,
      baseMaxHP: 100,
      mp: 20,
      equipment: [],
    },
    simulation: fixtureSimulation(),
  };
  field.characters.set(actor.id, actor);
  world.actors.set(actor.id, actor);
  gateway.accounts.set(actor.accountId, actor);
  gateway.characters.set(actor.id, actor);
  return { actor, field, gateway, world, session, persisted, released };
}

test("fatal simulation tick stops admission and completes orderly cleanup", async () => {
  const probe = fixture();
  const calls = [];
  const server = {
    stop(force) {
      calls.push(["server", force]);
    },
  };
  let worldClosed = false;
  probe.world.step = () => {
    throw new Error("fatal simulation fault");
  };
  probe.world.close = async () => {
    worldClosed = true;
  };
  probe.gateway.database.close = async () => calls.push(["database"]);
  const lifecycle = createLifecycle({
    server,
    world: probe.world,
    gateway: probe.gateway,
    database: probe.gateway.database,
    log() {},
  });

  lifecycle.tick();
  expect(calls).toContainEqual(["server", true]);
  await lifecycle.close();
  await lifecycle.close();

  expect(worldClosed).toBe(true);
  expect(probe.released).toEqual([probe.actor.id]);
  expect(probe.gateway.accounts.size).toBe(0);
  expect(probe.gateway.characters.size).toBe(0);
  expect(probe.world.actors.size).toBe(0);
  expect(calls.filter(([kind]) => kind === "database")).toHaveLength(1);
  expect(calls.filter(([kind]) => kind === "server")).toHaveLength(1);
});

test("shutdown continues world and database cleanup after gateway retirement fails", async () => {
  const calls = [];
  const failure = new Error("retirement failed");
  const lifecycle = createLifecycle({
    server: {
      stop() {
        calls.push("server");
      },
    },
    gateway: {
      sockets: new Set(),
      close: async () => {
        calls.push("gateway");
        throw failure;
      },
    },
    world: {
      step() {},
      close: async () => calls.push("world"),
    },
    database: { close: async () => calls.push("database") },
    log() {},
  });

  const firstClose = lifecycle.close();
  expect(lifecycle.close()).toBe(firstClose);
  await expect(firstClose).rejects.toBe(failure);
  expect(calls).toEqual(["gateway", "server", "world", "database"]);
});

test("a fatal tick still drains joins when a socket close throws", async () => {
  const probe = joiningFixture("world");
  const joining = probe.gateway.hello(probe.socket, {}).catch((error) => error);
  await probe.entered.promise;
  const failure = new Error("socket close failed");
  probe.gateway.publications.close = () => {
    throw failure;
  };
  probe.world.step = () => {
    throw new Error("fatal simulation fault");
  };
  const lifecycle = createLifecycle({
    server: { stop() {} },
    world: probe.world,
    gateway: probe.gateway,
    database: probe.database,
    log() {},
  });
  expect(() => lifecycle.tick()).not.toThrow();
  expect(probe.gateway.stopping).toBe(true);
  expect(probe.calls).toEqual(["lease"]);
  const closing = lifecycle.close().catch((error) => error);
  probe.gate.resolve();
  expect((await joining).code).toBe("SERVER_BUSY");
  expect(await closing).toBe(failure);
  expect(probe.released).toEqual([probe.actor.id]);
  expect(probe.gateway.characters.size).toBe(0);
  expect(probe.calls).toEqual(["lease", "world", "database"]);
});

test("gateway shutdown retires every actor after an earlier checkpoint fails", async () => {
  const probe = fixture();
  const second = {
    ...probe.actor,
    id: "second-character",
    accountId: "second-account",
    sessionId: "second-session",
    profile: structuredClone(probe.actor.profile),
    simulation: fixtureSimulation(),
  };
  probe.field.characters.set(second.id, second);
  probe.world.actors.set(second.id, second);
  probe.gateway.accounts.set(second.accountId, second);
  probe.gateway.characters.set(second.id, second);
  const failure = new Error("first checkpoint failed");
  probe.gateway.database.checkpoint = async (actor) => {
    if (actor.id === probe.actor.id) throw failure;
  };

  await expect(probe.gateway.close()).rejects.toBe(failure);

  expect(probe.released).toEqual([probe.actor.id, second.id]);
  expect(probe.gateway.accounts.size).toBe(0);
  expect(probe.gateway.characters.size).toBe(0);
  expect(probe.world.actors.size).toBe(0);
});

function joiningFixture(stage) {
  const probe = fixture();
  probe.gateway.accounts.clear();
  probe.gateway.characters.clear();
  probe.world.actors.clear();
  probe.field.characters.clear();
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const calls = [];
  probe.gateway.auth.consumeTicket = () => probe.actor.id;
  probe.gateway.auth.active = () => true;
  probe.database = probe.gateway.database;
  probe.database.acquireLease = async () => {
    calls.push("lease");
    if (stage === "lease") {
      entered.resolve();
      await gate.promise;
    }
    return probe.actor;
  };
  probe.world.join = async (actor) => {
    if (stage !== "lease") {
      entered.resolve();
      await gate.promise;
    }
    if (stage === "failed-world") throw new Error("join failed");
    probe.world.actors.set(actor.id, actor);
    probe.field.characters.set(actor.id, actor);
  };
  probe.world.close = async () => calls.push("world");
  probe.database.close = async () => calls.push("database");
  const socket = {
    data: { session: probe.session, closed: false },
    send: () => 1,
    close() {},
  };
  probe.gateway.sockets.add(socket);
  return { ...probe, socket, entered, gate, calls };
}

for (const stage of [
  "lease",
  "world",
  "failed-world",
  "socket-close",
  "listener-stop",
]) {
  test(`shutdown settles an admitted ${stage} join before closing the world and database`, async () => {
    const probe = joiningFixture(stage);
    const failure = ["socket-close", "listener-stop"].includes(stage)
      ? new Error(`${stage} failed`)
      : null;
    if (stage === "socket-close") {
      probe.gateway.publications.close = () => {
        throw failure;
      };
    }
    const joining = probe.gateway
      .hello(probe.socket, {})
      .catch((error) => error);
    await probe.entered.promise;
    const lifecycle = createLifecycle({
      server: {
        stop() {
          if (stage === "listener-stop") throw failure;
        },
      },
      world: probe.world,
      gateway: probe.gateway,
      database: probe.database,
      log() {},
    });
    const closing = lifecycle.close().then(
      () => null,
      (error) => error,
    );
    await Promise.resolve();
    expect(probe.gateway.stopping).toBe(true);
    expect(probe.calls).toEqual(["lease"]);
    expect(probe.gateway.admissions.size).toBe(1);
    probe.gate.resolve();
    const result = await joining;
    expect(result.code ?? result.message).toBe(
      stage === "failed-world" ? "join failed" : "SERVER_BUSY",
    );
    expect(await closing).toBe(failure);
    expect(probe.socket.data.actor).toBeUndefined();
    expect(probe.released).toEqual([probe.actor.id]);
    expect(probe.persisted).toHaveLength(stage === "failed-world" ? 0 : 1);
    expect(probe.gateway.admissions.size).toBe(0);
    expect(probe.gateway.joining.size).toBe(0);
    expect(probe.gateway.accounts.size).toBe(0);
    expect(probe.gateway.characters.size).toBe(0);
    expect(probe.world.actors.size).toBe(0);
    expect(probe.calls).toEqual(["lease", "world", "database"]);
  });
}

test("shutdown refuses newly queued socket admission without acquiring another lease", async () => {
  const probe = joiningFixture("world");
  await probe.gateway.close();
  expect(() => probe.gateway.upgrade({}, {}, "loopback")).toThrow(
    "SERVER_BUSY",
  );
  await expect(probe.gateway.hello(probe.socket, {})).rejects.toThrow(
    "SERVER_BUSY",
  );
  await expect(
    probe.gateway.obtainActor(probe.socket, probe.actor.id, null),
  ).rejects.toThrow("SERVER_BUSY");
  const lateSocket = { data: {}, send: () => 1, close() {} };
  probe.gateway.open(lateSocket);
  expect(lateSocket.data.closed).toBe(true);
  expect(probe.gateway.sockets.size).toBe(0);
  expect(probe.calls).toEqual([]);
});

test("pending admission retains the connection capacity reservation after its socket closes", async () => {
  const probe = joiningFixture("world");
  probe.gateway.config.maxConnections = 1;
  const joining = probe.gateway.obtainActor(probe.socket, probe.actor.id, null);
  await probe.entered.promise;
  probe.gateway.sockets.delete(probe.socket);
  await expect(
    probe.gateway.obtainActor(probe.socket, "another-character", null),
  ).rejects.toThrow("SERVER_BUSY");
  expect(probe.calls).toEqual(["lease"]);
  const closing = probe.gateway.close();
  probe.gate.resolve();
  await joining;
  await closing;
  expect(probe.released).toEqual([probe.actor.id]);
  expect(probe.gateway.admissions.size).toBe(0);
});

function fixtureSimulation() {
  return {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    facing: 1,
    action: "stand1",
    effectiveSettings: { gravityAcc: 2000, gravity: 1, fallSpeed: 670 },
  };
}

test("logout removes combat lookup while peer presence remains until its transition settles", async () => {
  const probe = fixture();
  expect(probe.world.nearby(probe.actor, probe.actor.id, "player", 100)).toBe(
    probe.actor,
  );
  const destination = Promise.withResolvers();
  probe.world.fieldFor = () => destination.promise;
  probe.actor.pending = true;
  const transfer = transitionActor(
    probe.world,
    probe.actor,
    { mapId: 100000001 },
    {},
  );
  const settled = transfer
    .catch((error) => error.code)
    .finally(() => {
      probe.actor.pending = false;
      probe.world.participants.signalIdle();
    });
  probe.session.revoked = true;
  const logout = probe.gateway.logout(probe.session);
  expect(probe.world.entities(probe.actor).map((entity) => entity.id)).toEqual([
    probe.actor.id,
  ]);
  expect(() =>
    probe.world.nearby(probe.actor, probe.actor.id, "player", 100),
  ).toThrow("NOT_FOUND");
  expect(probe.released).toEqual([]);
  destination.resolve({ characters: new Map() });
  expect(await settled).toBe("SESSION_EXPIRED");
  await logout;
  expect(probe.actor.state).toBe("retired");
  expect(probe.field.characters.has(probe.actor.id)).toBe(false);
  expect(probe.gateway.accounts.has(probe.actor.accountId)).toBe(false);
  expect(probe.persisted[0].hp).toBe(100);
  expect(probe.released).toEqual([probe.actor.id]);
});

test("transfer drains only its known old field and baselines before destination ready", () => {
  const { gateway, actor, world } = fixture();
  // This admission fixture has no database/native presentation. Observe readiness
  // publication without running unrelated social/profile preparation.
  world.participants.publish = async () => {};
  actor.field.epoch = "destination";
  const data = {
    actor,
    ready: false,
    baselines: new Map([["new", 8]]),
    transfer: { sourceEpoch: "source", baselines: new Map([["old", 4]]) },
  };
  actor.eventSeq = 8;
  expect(
    gateway.admitField(data, { type: "input", fieldEpoch: "source" }),
  ).toBe(false);
  expect(
    gateway.admitField(
      data,
      decodeClient(
        JSON.stringify({
          v: 1,
          type: "ack",
          connectionEpoch: "connection",
          seq: 1,
          snapshotId: "old",
          eventSeq: 4,
        }),
      ),
    ),
  ).toBe(false);
  expect(
    gateway.drainsTransfer(data, {
      type: "ack",
      snapshotId: "new",
      eventSeq: 8,
    }),
  ).toBe(false);
  for (const eventSeq of [3, 9]) {
    expect(
      gateway.drainsTransfer(data, {
        type: "ack",
        snapshotId: "old",
        eventSeq,
      }),
    ).toBe(false);
  }
  expect(() =>
    gateway.admitField(data, {
      type: "ack",
      fieldEpoch: "source",
      snapshotId: "invented",
      eventSeq: 4,
    }),
  ).toThrow();
  gateway.ready({ data }, { snapshotId: "new" });
  expect(() =>
    gateway.admitField(data, { type: "input", fieldEpoch: "source" }),
  ).toThrow();
});

test("transient socket close retains authoritative presence for reconnect", () => {
  const { gateway, actor, world } = fixture();
  const socket = { data: { actor } };
  actor.connection = socket;
  gateway.closed(socket);
  expect(world.actors.get(actor.id)).toBe(actor);
  expect(actor.field.characters.get(actor.id)).toBe(actor);
  expect(actor.disconnectedAt).toBeGreaterThan(0);
});

test("dead logout checkpoints authored return-map arrival and restored HP before releasing", async () => {
  const probe = fixture();
  probe.actor.profile.hp = 0;
  probe.actor.profile.maxHP = 100;
  probe.field.manifest = {
    id: "100000000",
    physics: { map: { returnMap: 101000000 } },
  };
  probe.world.content.map = async () => ({
    id: "101000000",
    physics: { portals: [{ id: 0, x: 125, y: 300 }] },
  });
  probe.session.revoked = true;
  await probe.gateway.logout(probe.session);
  expect(probe.persisted[0].hp).toBe(50);
  expect(probe.persisted[0].location).toEqual({
    mapId: "101000000",
    x: 125,
    y: 290,
    facing: 1,
  });
  expect(probe.released).toEqual([probe.actor.id]);
});

test("a checkpoint failure retires only its lease holder and the shared field remains reusable", async () => {
  const f = fixture();
  const error = Object.assign(new Error("temporary persistence failure"), {
    code: "SERVER_BUSY",
  });
  const save = f.world.database.checkpoint;
  let attempts = 0;
  f.world.database.checkpoint = async (actor) => {
    if (++attempts === 1) throw error;
    return save(actor);
  };
  f.world.now = 10000;
  f.actor.lastCheckpoint = 0;
  f.actor.runtimeDirty = true;
  f.actor.disconnectedAt = null;
  f.actor.leaseRenewAt = 10000;
  const peer = { ...f.actor, id: "peer", accountId: "peer-account" };
  f.field.characters.set(peer.id, peer);
  f.world.fields.set("public:100000000", f.field);
  f.world.checkpoint(f.actor);
  await f.world.participants.waitIdle(f.actor);
  expect(f.actor.deliveryError).toBe(error);
  expect(f.actor.runtimeDirty).toBe(true);
  expect(f.field.fault).toBeUndefined();
  expect(peer.deliveryError).toBeUndefined();
  f.gateway.auth.active = () => true;
  f.gateway.maintainActor(f.actor, 10000);
  await f.actor.retirement;
  expect(attempts).toBe(2);
  expect(f.released).toEqual([f.actor.id]);
  expect(f.field.characters.has(peer.id)).toBe(true);
  expect(await f.world.fieldFor(100000000)).toBe(f.field);
  let ticks = 0;
  f.world.tickField = () => {
    ticks++;
  };
  f.world.debt = 0;
  f.field.paused = false;
  f.world.step(1000);
  f.world.step(1030);
  expect(ticks).toBe(1);
});

test("a watchdog kick completes retirement and releases the character instead of leaving it busy", async () => {
  const probe = fixture();
  const { actor, gateway, world } = probe;
  gateway.auth.active = () => true;
  actor.disconnectedAt = null;
  actor.leaseRenewAt = 10000;
  const pending = Promise.withResolvers();
  const checkpoint = gateway.database.checkpoint;
  gateway.database.checkpoint = async (current) => {
    await pending.promise;
    await checkpoint(current);
  };
  world.faultMotion(actor, { position: 200, velocity: 0, elapsedMs: 30 });
  expect(actor.retiring).toBe(true);
  gateway.maintainActor(actor, 10000);
  expect(actor.retirement).toBeInstanceOf(Promise);
  const retirement = actor.retirement;
  gateway.maintainActor(actor, 10001);
  expect(actor.retirement).toBe(retirement);
  expect(probe.released).toEqual([]);
  pending.resolve();
  await retirement;
  expect(probe.persisted).toHaveLength(1);
  expect(probe.released).toEqual([actor.id]);
  expect(gateway.accounts.has(actor.accountId)).toBe(false);
  expect(gateway.characters.has(actor.id)).toBe(false);
  expect(world.actors.has(actor.id)).toBe(false);
  expect(probe.field.characters.has(actor.id)).toBe(false);
});
