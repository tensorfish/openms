import { test, expect } from "bun:test";
import {
  canonicalAction,
  decodeClient,
  decodeServer,
  PROTOCOL,
} from "../../shared/protocol.js";
import { OnlineTransport } from "../src/online/transport.js";
import { createDefaultBindings } from "../src/input/keymap.js";

function transition(phase, fieldEpoch, eventSeq) {
  return decodeServer(
    JSON.stringify({
      v: 1,
      type: "transition",
      connectionEpoch: "connection",
      serverTick: 20,
      eventSeq,
      transitionId: "travel",
      phase,
      sourceEpoch: "source",
      destination: {
        instanceId: "instance",
        mapId: 100000000,
        fieldEpoch,
        spawn: { x: 0, y: 0 },
      },
      requiredContent: [],
      deadline: 1000,
      code: "OK",
    }),
  );
}

function connected() {
  const sent = [];
  const transport = new OnlineTransport({
    onCommand: (fields) => expect(Object.isFrozen(fields)).toBe(true),
  });
  const socket = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send(text) {
      sent.push(JSON.parse(text));
    },
    close() {
      this.readyState = WebSocket.CLOSED;
    },
  };
  Object.assign(transport, {
    socket,
    status: "active",
    connectionEpoch: "connection",
    expectedFieldEpoch: "source",
    baselineId: "source_snapshot",
    lastEventSeq: 1,
    limits: { maxMessageBytes: 65536 },
  });
  return { transport, sent };
}

test("a same-field baseline refresh preserves active input while recovery still blocks it", async () => {
  const { transport, sent } = connected();
  const statuses = [];
  const prepared = Promise.withResolvers();
  const model = {
    snapshotId: "peer_joined",
    eventSeq: 2,
    serverTick: 3,
    fieldEpoch: "source",
    field: { fieldEpoch: "source" },
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
  transport.model = { fieldEpoch: "source" };
  transport.baselines.add = () => model;
  transport.callbacks.onStatus = (value) => statuses.push(value.status);
  transport.callbacks.onSnapshot = () => prepared.promise;
  try {
    const install = transport.installPart(
      { fieldEpoch: "source" },
      0,
      transport.generation,
    );
    expect(transport.status).toBe("active");
    expect(statuses).toEqual([]);
    prepared.resolve();
    await install;
    expect(statuses).toEqual(["active"]);
    expect(
      sent.map((message) => decodeClient(JSON.stringify(message)).type),
    ).toEqual(["ack", "ready"]);
    expect(transport.model.snapshotId).toBe("peer_joined");
    transport.status = "synchronizing";
    transport.baselineId = null;
    statuses.length = 0;
    await transport.installPart(
      { fieldEpoch: "source" },
      0,
      transport.generation,
    );
    expect(statuses).toEqual(["synchronizing", "active"]);
  } finally {
    transport.close();
  }
});

test("a complete keyboard preference passes client and server command admission", async () => {
  const { transport, sent } = connected();
  try {
    const keyBindings = createDefaultBindings();
    keyBindings.keys[30] = { type: 4, id: 0 };
    const action = { kind: "key-bindings.save", keyBindings };
    const pending = transport.command(action);
    const command = decodeClient(JSON.stringify(sent[0]));
    // Server receipt identity uses the same domain admission as the client sender.
    expect(JSON.parse(canonicalAction(command.action))).toEqual({
      domain: "character",
      action,
    });
    const receipt = {
      operationId: command.operationId,
      status: "committed",
      code: "OK",
      domainRevision: 1,
      transactionId: "binding_commit",
    };
    transport.result(receipt);
    await pending;
  } finally {
    transport.close();
  }
});

function timing(fieldEpoch, serverTick) {
  return {
    connectionEpoch: "connection",
    fieldEpoch,
    serverTick,
    paused: false,
  };
}

function input(targetTick) {
  return {
    targetTick,
    motionEpoch: 1,
    motionConfig: 1,
    movementLocked: false,
    impulses: [],
    motion: { x: 0, y: 0, vx: 0, vy: 0 },
    horizontal: 1,
    vertical: 0,
    jump: false,
    attack: false,
  };
}

// Returning to the same field retires its old baseline just like inter-map travel.
for (const [phase, destination] of [
  ["committed", "source"],
  ["committed", "destination"],
  ["aborted", "source"],
]) {
  test(`${phase} travel to ${destination} does not acknowledge a retired source baseline`, async () => {
    const { transport, sent } = connected();
    try {
      await transport.accept(transition("prepare", destination, 2), 100, 0, 0);
      expect(sent).toHaveLength(1);
      expect(sent[0].snapshotId).toBe("source_snapshot");
      await transport.accept(transition(phase, destination, 3), 100, 0, 0);
      expect(sent).toHaveLength(1);
      expect(transport.snapshot().status).toBe("synchronizing");
      expect(transport.snapshot().connectionEpoch).toBe("connection");
      expect(
        transport.sendInput({
          targetTick: 21,
          horizontal: 1,
          vertical: 0,
          jump: false,
          attack: false,
        }),
      ).toBeNull();
      await expect(
        transport.command({ kind: "revive.request", method: "return" }),
      ).rejects.toThrow("NOT_ACTIVE");
    } finally {
      transport.close();
    }
  });
}

test("prepare still admits source events and rejects premature destination or unrelated epochs", async () => {
  const { transport } = connected();
  const event = (fieldEpoch, eventSeq) =>
    decodeServer(
      JSON.stringify({
        v: 1,
        type: "event",
        connectionEpoch: "connection",
        serverTick: 20,
        eventSeq,
        fieldEpoch,
        event: { kind: "world.portal", actorId: "traveler" },
      }),
    );
  try {
    await transport.accept(transition("prepare", "destination", 2), 100, 0, 0);
    await transport.accept(event("source", 3), 100, 0, 0);
    expect(transport.lastEventSeq).toBe(3);
    for (const epoch of ["destination", "unrelated"]) {
      await expect(
        transport.accept(event(epoch, 4), 100, 0, 0),
      ).rejects.toThrow("STALE_FIELD");
    }
    expect(transport.lastEventSeq).toBe(3);
  } finally {
    transport.close();
  }
});

test("neutral lifecycle events clear held controls without inventing a movement step", () => {
  const { transport, sent } = connected();
  let clears = 0;
  transport.callbacks.onClearInput = () => clears++;
  try {
    transport.timing(timing("source", 13), performance.now() - 1000, 300);
    for (let event = 0; event < 16; event++) transport.neutral();
    expect(sent).toEqual([]);
    expect(clears).toBe(16);
    expect(transport.sendInput(input(14))).toBe(1);
    expect(sent[0]).toMatchObject({
      type: "input",
      fieldEpoch: "source",
      targetTick: 14,
    });
  } finally {
    transport.close();
  }
});

test("committed travel cannot use source timing or an unscoped heartbeat for destination input", async () => {
  const { transport, sent } = connected();
  try {
    transport.timing(timing("source", 100000), 0, 300);
    await transport.accept(transition("prepare", "destination", 2), 100, 0, 0);
    await transport.accept(
      transition("committed", "destination", 3),
      100,
      0,
      0,
    );
    // Baseline installation may activate the transport before destination motion.
    transport.setStatus("active");
    transport.neutral();
    transport.receive({
      data: JSON.stringify({
        v: 1,
        type: "ping",
        connectionEpoch: "connection",
        serverTick: 100001,
        nonce: "heartbeat",
        serverTime: 1000,
        roundTripMs: 300,
      }),
    });
    transport.neutral();
    expect(sent.filter((message) => message.type === "input")).toEqual([]);
    transport.timing(timing("destination", 13), performance.now(), 300);
    transport.sendInput(input(14));
    const inputs = sent.filter((message) => message.type === "input");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      fieldEpoch: "destination",
    });
    expect(inputs[0].targetTick).toBe(14);
  } finally {
    transport.close();
  }
});

test("a slow hello does not require network RTT before ordinary input can be sent", () => {
  const { transport, sent } = connected();
  try {
    const hash = "a".repeat(64);
    transport.connectionEpoch = null;
    transport.config = { rulesHash: hash, assetBuildId: hash };
    transport.welcome(
      {
        ...timing("source", 13),
        playSession: "play",
        rulesHash: hash,
        assetBuildId: hash,
        serverTime: 2500,
        tickMs: PROTOCOL.TICK_MS,
        inputLeadTicks: PROTOCOL.INPUT_LEAD_TICKS,
        inputBufferTicks: PROTOCOL.INPUT_BUFFER_TICKS,
        limits: {
          commandPerSecond: 12,
          inputPerSecond: 40,
          maxMessageBytes: PROTOCOL.MAX_MESSAGE_BYTES,
        },
      },
      2500,
    );
    transport.setStatus("active");
    expect(transport.sendInput(input(14))).toBe(1);
    expect(sent[0]).toMatchObject({ targetTick: 14, horizontal: 1 });
  } finally {
    transport.close();
  }
});

test("logout exposes sign-in only after HTTP revocation settles", async () => {
  const { transport } = connected();
  const statuses = [];
  transport.callbacks.onStatus = (value) => statuses.push(value);
  transport.config = { csrfToken: "session-csrf" };
  const gate = Promise.withResolvers();
  const response = Response.json({ code: "OK" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => gate.promise;
  let revocation;
  try {
    revocation = transport.revoke();
    // The authority closes the socket before its durable logout response.
    transport.disconnected("SESSION_EXPIRED");
    expect(transport.snapshot().status).toBe("signing-out");
    expect(statuses.some((value) => value.status === "disconnected")).toBe(
      false,
    );
    gate.resolve(response);
    await revocation;
    expect(
      statuses
        .filter((value) => value.status === "disconnected")
        .map((value) => value.code),
    ).toEqual(["SIGNED_OUT"]);
  } finally {
    gate.resolve(response);
    await revocation;
    globalThis.fetch = originalFetch;
    transport.close();
  }
});

test("a rejected logout releases sign-in and preserves the authority error", async () => {
  const { transport } = connected();
  const statuses = [];
  transport.callbacks.onStatus = (value) => statuses.push(value);
  transport.config = { csrfToken: "session-csrf" };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ code: "NOT_ALLOWED" }, { status: 403 });
  try {
    await expect(transport.revoke()).rejects.toThrow("NOT_ALLOWED");
    expect(statuses.at(-1)).toMatchObject({
      status: "disconnected",
      code: "NOT_ALLOWED",
    });
  } finally {
    globalThis.fetch = originalFetch;
    transport.close();
  }
});

test("creation roll responses require a real id and valid integer totals", async () => {
  const { transport } = connected();
  transport.config = { csrfToken: "session-csrf" };
  const originalFetch = globalThis.fetch;
  const legal = { rollId: "issued-roll", str: 7, dex: 6, int: 8, luk: 4 };
  try {
    for (const patch of [
      { rollId: null },
      { rollId: 123 },
      { str: 999 },
      { int: "8" },
    ]) {
      globalThis.fetch = async () => Response.json({ ...legal, ...patch });
      await expect(transport.rollCharacterStats()).rejects.toThrow(
        "INVALID_MESSAGE",
      );
    }
    globalThis.fetch = async () => Response.json(legal);
    const roll = await transport.rollCharacterStats();
    expect(roll).toEqual(legal);
    expect(Object.isFrozen(roll)).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
    transport.close();
  }
});

test("same-domain intentions bind successive confirmed revisions while their IDs remain stable", async () => {
  const { transport, sent } = connected();
  transport.limits.commandPerSecond = 12;
  try {
    const first = transport.command({
      kind: "inventory.move",
      itemId: "item",
      quantity: 1,
      to: { tab: "use", slot: 2 },
    });
    const second = transport.command({
      kind: "inventory.move",
      itemId: "item",
      quantity: 1,
      to: { tab: "use", slot: 3 },
    });
    expect(sent).toHaveLength(1);
    transport.nextCommandAt = 0;
    transport.result({
      operationId: first.operationId,
      status: "committed",
      domainRevision: 7,
    });
    expect(sent).toHaveLength(2);
    expect(sent[1].operationId).toBe(second.operationId);
    expect(sent[1].expectedRevision).toBe(7);
    const pending = transport.pending.get(second.operationId);
    pending.unknown = true;
    transport.nextCommandAt = 0;
    transport.revisions.inventory = 99;
    const recovered = transport.recover(second.operationId);
    expect(sent[2].expectedRevision).toBe(7);
    expect(sent[2].operationId).toBe(second.operationId);
    transport.result({
      operationId: second.operationId,
      status: "committed",
      domainRevision: 8,
    });
    expect((await recovered).domainRevision).toBe(8);
    await Promise.all([first, second]);
    expect((await transport.recover(second.operationId)).domainRevision).toBe(
      8,
    );
  } finally {
    transport.close();
  }
});

test("refused parents cancel dependent intentions without sending them", async () => {
  const { transport, sent } = connected();
  try {
    const action = {
      kind: "inventory.move",
      itemId: "item",
      quantity: 1,
      to: { tab: "use", slot: 2 },
    };
    const first = transport.command(action);
    const second = transport.command({
      ...action,
      to: { tab: "use", slot: 3 },
    });
    transport.nextCommandAt = 0;
    transport.result({
      operationId: first.operationId,
      status: "rejected",
      code: "NOT_ALLOWED",
      domainRevision: 0,
    });
    expect((await second).status).toBe("rejected");
    expect(sent).toHaveLength(1);
    await first;
  } finally {
    transport.close();
  }
});

test("unstarted casts expire, while release bypasses a blocked character queue", async () => {
  const { transport, sent } = connected();
  transport.limits.commandPerSecond = 12;
  try {
    const first = transport.command({ kind: "skill.cast", skillId: 1001004 });
    const second = transport.command({ kind: "skill.cast", skillId: 1001004 });
    const pending = transport.pending.get(second.operationId);
    pending.queuedAt = performance.now() - 2001;
    const release = transport.command({
      kind: "skill.release",
      skillId: 2001004,
    });
    expect(sent.map((entry) => entry.action.kind)).toEqual([
      "skill.cast",
      "skill.release",
    ]);
    transport.nextCommandAt = 0;
    transport.recoverPending();
    expect((await second).code).toBe("COOLDOWN");
    transport.result({
      operationId: release.operationId,
      status: "committed",
      domainRevision: 0,
    });
    transport.result({
      operationId: first.operationId,
      status: "committed",
      domainRevision: 1,
    });
    await Promise.all([first, release]);
  } finally {
    transport.close();
  }
});

test("backpressure retains each input edge and a field transition discards the old journal", () => {
  const { transport, sent } = connected();
  try {
    transport.socket.bufferedAmount = 200000;
    transport.timing(timing("source", 13), performance.now(), 0);
    expect(transport.sendInput({ ...input(14), attack: true })).toBe(1);
    expect(transport.sendInput({ ...input(15), attack: false })).toBe(2);
    expect(sent).toHaveLength(0);
    transport.socket.bufferedAmount = 0;
    transport.flushInputs();
    expect(sent.map((entry) => [entry.inputSeq, entry.attack])).toEqual([
      [1, true],
      [2, false],
    ]);
    transport.socket.bufferedAmount = 200000;
    transport.sendInput(input(16));
    transport.transition(transition("prepare", "destination", 2));
    expect(transport.inputJournal.count).toBe(0);
  } finally {
    transport.close();
  }
});

test("release preserves its cast's send order while bypassing unrelated character work", async () => {
  const { transport, sent } = connected();
  transport.limits.commandPerSecond = 12;
  try {
    const first = transport.command({
      kind: "skills.allocate",
      skillId: 1001004,
      amount: 1,
    });
    const cast = transport.command({ kind: "skill.cast", skillId: 2121001 });
    const release = transport.command({
      kind: "skill.release",
      skillId: 2121001,
    });
    expect(sent).toHaveLength(1);
    transport.nextCommandAt = 0;
    transport.result({
      operationId: first.operationId,
      status: "committed",
      domainRevision: 1,
    });
    expect(sent.map((entry) => entry.action.kind)).toEqual([
      "skills.allocate",
      "skill.cast",
      "skill.release",
    ]);
    transport.result({
      operationId: release.operationId,
      status: "committed",
      domainRevision: 1,
    });
    transport.result({
      operationId: cast.operationId,
      status: "committed",
      domainRevision: 2,
    });
    await Promise.all([first, cast, release]);
  } finally {
    transport.close();
  }
});
