import { expect, test } from "bun:test";
import { OnlineTransport } from "../src/online/transport.js";
import { decodeClient, decodeServer, PROTOCOL } from "../../shared/protocol.js";

function configuration() {
  return {
    v: 1,
    rulesHash: "a".repeat(64),
    assetBuildId: "b".repeat(64),
    catalogHash: "c".repeat(64),
    csrfToken: "csrf",
    loginToken: "login",
    development: true,
  };
}

function resumedBaseline(session) {
  return {
    snapshotId: "baseline",
    eventSeq: session === "play" ? 43 : 1,
    serverTick: 100,
    fieldEpoch: "field",
    field: { fieldEpoch: "field" },
    revisions: {
      character: 0,
      inventory: 0,
      social: 0,
      conversation: 0,
      trade: 0,
      invitation: 0,
    },
    presentation: { interactions: [] },
  };
}

function restoreSocket(probe, socket) {
  const t = probe.transport;
  const cursor = t.lastEventSeq;
  const continued = t.playSession === probe.session;
  const config = configuration();
  const message = decodeServer(
    JSON.stringify({
      v: 1,
      type: "welcome",
      connectionEpoch: "new-connection",
      serverTick: 100,
      playSession: probe.session,
      fieldEpoch: "field",
      rulesHash: config.rulesHash,
      assetBuildId: config.assetBuildId,
      serverTime: Date.now(),
      tickMs: PROTOCOL.TICK_MS,
      inputLeadTicks: PROTOCOL.INPUT_LEAD_TICKS,
      inputBufferTicks: PROTOCOL.INPUT_BUFFER_TICKS,
      resume: probe.session === "play" ? "continued" : "snapshot",
      limits: {
        commandPerSecond: 12,
        inputPerSecond: 40,
        maxMessageBytes: 16384,
      },
    }),
  );
  t.welcome(message, performance.now());
  expect(t.lastEventSeq).toBe(continued ? cursor : 0);
  t.baselines.add = () => resumedBaseline(probe.session);
  void t.installPart({ fieldEpoch: "field" }, 0, t.generation);
  probe.sockets.push(socket);
}

function socketClass(probe) {
  return class extends EventTarget {
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(_url, protocol) {
      super();
      this.protocol = protocol;
      this.readyState = 0;
      this.bufferedAmount = 0;
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      });
    }
    send(text) {
      const message = decodeClient(text);
      probe.sent.push(message);
      if (message.type === "hello") {
        queueMicrotask(() => restoreSocket(probe, this));
      }
    }
    close() {
      this.readyState = 3;
    }
    expire() {
      this.readyState = 3;
      const event = Object.assign(new Event("close"), {
        code: 1012,
        reason: "RESYNC_REQUIRED",
      });
      this.dispatchEvent(event);
    }
  };
}

function recoveryProbe() {
  const statuses = [],
    paths = [],
    sent = [],
    sockets = [];
  const transport = new OnlineTransport({
    onStatus: (value) => statuses.push(value),
  });
  transport.verifyCompiledIdentity = () => {};
  Object.assign(transport, {
    characterId: "character",
    playSession: "play",
    lastEventSeq: 42,
    model: { fieldEpoch: "field" },
    config: configuration(),
    status: "active",
    connectionEpoch: "old-connection",
    expectedFieldEpoch: "field",
    limits: { maxMessageBytes: 16384, commandPerSecond: 12 },
    socket: {
      readyState: 1,
      close() {},
      send(text) {
        sent.push(decodeClient(text));
      },
    },
  });
  return {
    transport,
    statuses,
    paths,
    sent,
    sockets,
    session: "play",
    roster: [{ id: "character", name: "Player", level: 1, job: 0 }],
  };
}

async function withRecovery(run) {
  const previous = {
    document: globalThis.document,
    fetch: globalThis.fetch,
    WebSocket: globalThis.WebSocket,
    location: globalThis.location,
  };
  globalThis.document = Object.assign(new EventTarget(), { hidden: false });
  globalThis.location = new URL("http://localhost/");
  const probe = recoveryProbe();
  globalThis.WebSocket = socketClass(probe);
  globalThis.fetch = async (path) => {
    probe.paths.push(path);
    if (path === "/api/v1/config") return Response.json(configuration());
    if (path === "/api/v1/characters") {
      return Response.json({ characters: probe.roster });
    }
    return Response.json({ ticket: "x".repeat(43) });
  };
  try {
    await run(probe);
  } finally {
    probe.transport.close();
    Object.assign(globalThis, previous);
  }
}

async function recover(probe) {
  probe.transport.disconnected("RESYNC_REQUIRED");
  probe.transport.recovery.advance();
  await probe.transport.recovery.task;
}

test("movement expiry waits in the retained field while hidden and resumes the same character on visibility", async () => {
  const previous = globalThis.document;
  const page = Object.assign(new EventTarget(), { hidden: true });
  globalThis.document = page;
  const statuses = [];
  const transport = new OnlineTransport({
    onStatus: (value) => statuses.push(value.status),
  });
  let resumed;
  Object.assign(transport, {
    characterId: "character",
    playSession: "play",
    lastEventSeq: 42,
    model: { fieldEpoch: "field" },
    config: { csrfToken: "csrf" },
    status: "active",
    connectionEpoch: "connection",
    socket: { readyState: WebSocket.OPEN, close() {} },
  });
  transport.connect = async ({ characterId }) => {
    resumed = {
      characterId,
      playSession: transport.playSession,
      lastEventSeq: transport.lastEventSeq,
    };
    transport.setStatus("active");
  };
  try {
    transport.disconnected("RESYNC_REQUIRED");
    expect(transport.status).toBe("recovering");
    transport.check();
    expect(resumed).toBeUndefined();
    expect(statuses).not.toContain("disconnected");
    page.hidden = false;
    page.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    expect(resumed).toEqual({
      characterId: "character",
      playSession: "play",
      lastEventSeq: 42,
    });
    expect(transport.status).toBe("active");
  } finally {
    transport.close();
    globalThis.document = previous;
  }
});

for (const session of ["play", "fresh-play"]) {
  test(`automatic recovery uses the normal HTTP/socket handshake and ${session} baseline without credentials`, async () => {
    await withRecovery(async (probe) => {
      probe.session = session;
      const pending = probe.transport.command({
        kind: "revive.request",
        method: "return",
      });
      await recover(probe);
      expect(probe.transport.status).toBe("active");
      expect(probe.paths).toEqual([
        "/api/v1/config",
        "/api/v1/characters",
        "/api/v1/play-ticket",
      ]);
      const hello = probe.sent.find((entry) => entry.type === "hello");
      expect(hello.resume).toEqual({ playSession: "play", lastEventSeq: 42 });
      expect(probe.transport.playSession).toBe(session);
      expect(probe.transport.lastEventSeq).toBe(session === "play" ? 43 : 1);
      expect(probe.transport.pending.has(pending.operationId)).toBe(true);
      expect(
        probe.sent
          .filter((entry) => entry.type === "command")
          .map((entry) => entry.operationId),
      ).toEqual([pending.operationId, pending.operationId]);
      expect(
        probe.statuses.some((entry) => entry.status === "disconnected"),
      ).toBe(false);
      probe.sockets[0].expire();
      expect(probe.transport.status).toBe("recovering");
    });
  });
}

test("permanent session failure stops recovery and reports the account-session error", async () => {
  await withRecovery(async (probe) => {
    globalThis.fetch = async () =>
      Response.json({ code: "SESSION_EXPIRED" }, { status: 401 });
    await recover(probe);
    expect(probe.transport.status).toBe("disconnected");
    expect(probe.statuses.at(-1).code).toBe("SESSION_EXPIRED");
    expect(probe.transport.recovery.pending).toBeNull();
    expect(probe.sockets).toHaveLength(0);
  });
});

test("a removed character cannot be replaced by a different roster character", async () => {
  await withRecovery(async (probe) => {
    probe.roster = [{ id: "other", name: "Other", level: 1, job: 0 }];
    await recover(probe);
    expect(probe.statuses.at(-1).code).toBe("CHARACTER_NOT_OWNED");
    expect(probe.sockets).toHaveLength(0);
    expect(probe.transport.characterId).toBe("character");
  });
});

test("explicit disconnect fences a delayed recovery configuration response", async () => {
  await withRecovery(async (probe) => {
    const gate = Promise.withResolvers();
    globalThis.fetch = () => gate.promise;
    probe.transport.disconnected("RESYNC_REQUIRED");
    probe.transport.recovery.advance();
    const task = probe.transport.recovery.task;
    probe.transport.disconnect();
    gate.resolve(Response.json(configuration()));
    await task;
    expect(probe.transport.status).toBe("disconnected");
    expect(probe.sockets).toHaveLength(0);
  });
});

test("fresh login fences recovery and cannot have its session token overwritten by stale HTTP", async () => {
  await withRecovery(async (probe) => {
    const gate = Promise.withResolvers();
    globalThis.fetch = () => gate.promise;
    probe.transport.disconnected("RESYNC_REQUIRED");
    probe.transport.recovery.advance();
    const task = probe.transport.recovery.task;
    probe.transport.adoptSession({
      csrfToken: "fresh-csrf",
      role: "player",
      expiresAt: Date.now() + 10000,
    });
    gate.resolve(Response.json(configuration()));
    await task;
    expect(probe.transport.config.csrfToken).toBe("fresh-csrf");
    expect(probe.transport.recovery.pending).toBeNull();
    expect(probe.sockets).toHaveLength(0);
  });
});

test("repeated expiry without sustained movement has a finite retry budget", async () => {
  await withRecovery(async (probe) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      probe.transport.disconnected("RESYNC_REQUIRED");
      probe.transport.recovery.pending.nextAt = 0;
      probe.transport.recovery.advance();
      await probe.transport.recovery.task;
      expect(probe.transport.status).toBe("active");
    }
    probe.transport.disconnected("RESYNC_REQUIRED");
    expect(probe.statuses.at(-1).code).toBe("RECOVERY_EXHAUSTED");
    expect(probe.transport.recovery.pending).toBeNull();
    expect(probe.sockets).toHaveLength(3);
  });
});

test("successful input resets recovery attempts only after ten continuous seconds", async () => {
  await withRecovery(async (probe) => {
    probe.transport.recovery.attempts = 2;
    for (let index = 0; index < 10; index++) {
      probe.transport.recovery.input(index * 1000);
    }
    expect(probe.transport.recovery.attempts).toBe(2);
    probe.transport.recovery.input(10000);
    expect(probe.transport.recovery.attempts).toBe(0);
  });
});

test("logout cancels an outstanding resume before revoking the account session", async () => {
  await withRecovery(async (probe) => {
    const gate = Promise.withResolvers();
    globalThis.fetch = (_path, options) =>
      options.method === "DELETE"
        ? Promise.resolve(Response.json({ code: "OK" }))
        : gate.promise;
    probe.transport.disconnected("RESYNC_REQUIRED");
    probe.transport.recovery.advance();
    const task = probe.transport.recovery.task;
    await probe.transport.revoke();
    gate.resolve(Response.json(configuration()));
    await task;
    expect(probe.transport.config).toBeNull();
    expect(probe.transport.characterId).toBeNull();
    expect(probe.statuses.at(-1).code).toBe("SIGNED_OUT");
    expect(probe.sockets).toHaveLength(0);
  });
});

test("foreground recovery has a bounded deadline and does not retry a permanent protocol error", async () => {
  await withRecovery(async (probe) => {
    probe.transport.disconnected("RESYNC_REQUIRED");
    probe.transport.recovery.pending.deadline = performance.now() - 1;
    probe.transport.recovery.advance();
    expect(probe.statuses.at(-1).code).toBe("RECOVERY_TIMEOUT");
    expect(probe.paths).toEqual([]);
    probe.transport.disconnected("CONTENT_MISMATCH");
    probe.transport.check();
    expect(probe.transport.status).toBe("disconnected");
    expect(probe.paths).toEqual([]);
  });
});

test("no selected character or a closed transport cannot start automatic recovery", async () => {
  await withRecovery(async (probe) => {
    probe.transport.characterId = null;
    probe.transport.disconnected("RESYNC_REQUIRED");
    probe.transport.check();
    expect(probe.transport.status).toBe("disconnected");
    probe.transport.characterId = "character";
    probe.transport.close();
    probe.transport.disconnected("RESYNC_REQUIRED");
    probe.transport.check();
    expect(probe.paths).toEqual([]);
  });
});

for (const boundary of ["resync", "input"]) {
  test(`${boundary} recovers a native socket closed before its close callback runs`, async () => {
    await withRecovery(async (probe) => {
      const t = probe.transport;
      t.timing(
        {
          connectionEpoch: "old-connection",
          fieldEpoch: "field",
          serverTick: 100,
          paused: false,
        },
        performance.now(),
        0,
      );
      t.inputJournal.push(
        {
          targetTick: 101,
          motionEpoch: 1,
          motionConfig: 1,
          movementLocked: false,
          impulses: [],
          horizontal: 0,
          vertical: 0,
          jump: false,
          attack: false,
          motion: { x: 0, y: 0, vx: 0, vy: 0 },
        },
        1,
      );
      // Browser native state changes before the queued JavaScript close event.
      t.socket.readyState = WebSocket.CLOSED;
      expect(() =>
        boundary === "resync"
          ? t.resync("prediction-overflow")
          : t.flushInputs(),
      ).not.toThrow();
      expect(t.status).toBe("recovering");
      expect(t.socket).toBeNull();
      expect(probe.sent).toEqual([]);
      t.check();
      await t.recovery.task;
      expect(t.status).toBe("active");
      expect(
        probe.statuses.some((entry) => entry.status === "disconnected"),
      ).toBe(false);
    });
  });
}

test("closed-socket recovery does not hide unauthenticated sends or invalid protocol messages", async () => {
  await withRecovery(async (probe) => {
    const t = probe.transport;
    expect(() => t.resync("unsupported-reason")).toThrow("INVALID_MESSAGE");
    t.lastResyncAt = -Infinity;
    t.playSession = null;
    t.socket.readyState = WebSocket.CLOSED;
    expect(() => t.resync("prediction-overflow")).toThrow("NOT_CONNECTED");
    expect(t.recovery.pending).toBeNull();
  });
});

for (const boundary of ["check", "command"]) {
  test(`${boundary} retains a pending command when native socket closure precedes its callback`, async () => {
    await withRecovery(async (probe) => {
      const t = probe.transport;
      const reported = [];
      t.callbacks.onTransportError = (error) => reported.push(error);
      t.lastMessageAt = performance.now();
      const action = { kind: "revive.request", method: "return" };
      let issued;
      if (boundary === "check") issued = t.command(action);
      t.socket.readyState = WebSocket.CLOSED;
      if (boundary === "command") issued = t.command(action);
      else t.check();
      const pending = t.pending.get(issued.operationId);
      const fields = structuredClone(pending.fields);
      expect(t.status).toBe("recovering");
      expect(t.recovery.pending).not.toBeNull();
      expect(t.socket).toBeNull();
      expect(reported).toEqual([]);
      expect(probe.sent).toHaveLength(boundary === "check" ? 1 : 0);
      t.check();
      await t.recovery.task;
      expect(t.status).toBe("active");
      expect(t.pending.get(issued.operationId)).toBe(pending);
      expect(pending.fields).toEqual(fields);
      const commands = probe.sent.filter((entry) => entry.type === "command");
      expect(commands).toHaveLength(boundary === "check" ? 2 : 1);
      expect(commands.at(-1)).toMatchObject(fields);
      expect(
        probe.statuses.some((entry) => entry.status === "disconnected"),
      ).toBe(false);
      expect(reported).toEqual([]);
    });
  });
}

test("pending-send recovery preserves strict invalid-command and unauthenticated failures", async () => {
  await withRecovery(async (probe) => {
    const t = probe.transport;
    t.socket.readyState = WebSocket.CLOSED;
    expect(() =>
      t.command({ kind: "revive.request", method: "unsupported" }),
    ).toThrow("INVALID_MESSAGE");
    expect(t.pending.size).toBe(0);
    expect(t.recovery.pending).toBeNull();
    t.playSession = null;
    t.command({ kind: "revive.request", method: "return" });
    expect(t.status).toBe("disconnected");
    expect(t.snapshot().lastFailure.code).toBe("NOT_CONNECTED");
    expect(t.recovery.pending).toBeNull();
    expect(probe.sent).toEqual([]);
  });
});

test("terminal transport failures retain bounded map/phase evidence after teardown and reach the error log", async () => {
  await withRecovery(async (probe) => {
    const t = probe.transport;
    t.field = { mapId: 100000003 };
    t.transitionPhase = "committed";
    t.config.csrfToken = "private-csrf";
    t.playSession = "private-play-session";
    const reported = [];
    t.callbacks.onTransportError = (error) => reported.push(error);
    const error = Object.assign(new Error("bad protocol record"), {
      code: "INVALID_MESSAGE",
    });
    t.fail(error, "receive");
    expect(t.snapshot().lastFailure).toMatchObject({
      code: "INVALID_MESSAGE",
      mapId: 100000003,
      fieldEpoch: "field",
      phase: "committed",
      stage: "receive",
      recovery: false,
    });
    expect(t.snapshot().lastFailure.at).toBeGreaterThan(0);
    expect(t.connectionEpoch).toBeNull();
    expect(reported).toEqual([error]);
    expect(JSON.stringify(t.snapshot().lastFailure)).not.toContain(
      "private-csrf",
    );
    expect(JSON.stringify(t.snapshot().lastFailure)).not.toContain(
      "private-play-session",
    );
    const retained = t.snapshot().lastFailure;
    t.disconnect();
    expect(t.snapshot().lastFailure).toEqual(retained);
    expect(reported).toHaveLength(1);
  });
});

test("a recoverable close retains its cause without reporting a terminal error", async () => {
  await withRecovery(async (probe) => {
    const reported = [];
    probe.transport.callbacks.onTransportError = (error) =>
      reported.push(error);
    probe.transport.disconnected("CONNECTION_LOST", {
      stage: "socket-close",
      closeCode: 1005,
    });
    expect(probe.transport.snapshot().lastFailure).toMatchObject({
      code: "CONNECTION_LOST",
      closeCode: 1005,
      recovery: true,
    });
    expect(reported).toEqual([]);
  });
});

test("a lost portal releases its reservation after a fresh baseline without replaying an ambiguous script", async () => {
  await withRecovery(async (probe) => {
    const t = probe.transport;
    const issued = t.command({ kind: "portal.enter", portalId: 1 });
    const original = probe.sent.at(-1);
    const old = t.pending.get(issued.operationId);
    // Preserve the metadata held by clients that lost this portal before the fix.
    old.durable = false;
    old.deadline = performance.now() - 1;
    t.lastMessageAt = performance.now();
    t.check();
    expect((await issued).status).toBe("unknown");
    const recovered = t.recover(issued.operationId);
    probe.session = "fresh-play";
    await recover(probe);
    expect(t.status).toBe("active");
    expect(t.pendingTravel).toBe(0);
    expect(t.pending.has(issued.operationId)).toBe(false);
    const retained = t.unresolvedReceipts.get(issued.operationId);
    expect(retained.fields.operationId).toBe(original.operationId);
    expect(retained.fields.fieldEpoch).toBe(original.fieldEpoch);
    expect(retained.fields.expectedRevision).toBe(original.expectedRevision);
    expect(retained.fields.action).toEqual(original.action);
    expect(probe.sent.filter((entry) => entry.type === "command")).toHaveLength(
      1,
    );
    expect((await recovered).status).toBe("unknown");
    expect((await t.recover(issued.operationId)).status).toBe("unknown");
    expect(t.snapshot().unresolvedOperations).toBe(1);
    const next = t.command({ kind: "portal.enter", portalId: 2 });
    expect(t.pending.get(next.operationId).predecessor).toBeNull();
    expect(t.pendingTravel).toBe(1);
    expect(probe.sent.at(-1)).toMatchObject({
      type: "command",
      operationId: next.operationId,
    });
    expect(t.pending.get(next.operationId).fields.expectedRevision).toBe(
      t.revisions.character,
    );
  });
});

test("a continued play session keeps its recoverable portal receipt and reservation", async () => {
  await withRecovery(async (probe) => {
    const t = probe.transport;
    const portal = t.command({ kind: "portal.enter", portalId: 1 });
    await recover(probe);
    expect(t.pendingTravel).toBe(1);
    expect(t.pending.has(portal.operationId)).toBe(true);
    expect(t.unresolvedReceipts.size).toBe(0);
    expect(
      probe.sent
        .filter((entry) => entry.type === "command")
        .map((entry) => entry.operationId),
    ).toEqual([portal.operationId, portal.operationId]);
  });
});

test("a fresh play session preserves exact durable inventory recovery", async () => {
  await withRecovery(async (probe) => {
    const t = probe.transport;
    const paid = t.command({
      kind: "inventory.move",
      itemId: "owned-item",
      quantity: 1,
      to: { tab: "use", slot: 2 },
    });
    const fields = structuredClone(t.pending.get(paid.operationId).fields);
    probe.session = "fresh-play";
    await recover(probe);
    expect(t.pending.has(paid.operationId)).toBe(true);
    expect(t.unresolvedReceipts.size).toBe(0);
    expect(t.pending.get(paid.operationId).fields).toEqual(fields);
    expect(
      probe.sent
        .filter((entry) => entry.type === "command")
        .map((entry) => entry.operationId),
    ).toEqual([paid.operationId, paid.operationId]);
  });
});

test("never-sent child intentions of a retired portal are refused without replaying either operation", async () => {
  await withRecovery(async (probe) => {
    const t = probe.transport;
    const portal = t.command({ kind: "portal.enter", portalId: 1 });
    const child = t.command({ kind: "revive.request", method: "return" });
    expect(t.pending.get(child.operationId).bound).toBe(false);
    expect(t.pending.get(child.operationId).predecessor).toBe(
      portal.operationId,
    );
    probe.session = "fresh-play";
    await recover(probe);
    expect((await portal).status).toBe("unknown");
    expect(await child).toMatchObject({
      status: "rejected",
      code: "OPERATION_EXPIRED",
    });
    expect(probe.sent.filter((entry) => entry.type === "command")).toHaveLength(
      1,
    );
    expect(t.pendingTravel).toBe(0);
    expect(t.pending.size).toBe(0);
  });
});
