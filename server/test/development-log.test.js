import { expect, test } from "bun:test";
import {
  createDevelopmentLog,
  logStage,
  logPrefix,
} from "../../shared/development-log.js";
import { OnlineHttp } from "../src/http.js";
import { admitDeveloper } from "../src/field-development.js";
import { SessionAuthority } from "../src/auth.js";
import { GameplayGateway } from "../src/gateway.js";
import { createServerLog } from "../src/logging.js";

function logger(enabled = true) {
  const lines = [];
  const log = createDevelopmentLog("probe", {
    enabled,
    write: (line) => lines.push(line),
    clock: () => 10,
  });
  return { log, lines };
}

test("log prefixes include UTC date, time, milliseconds and process scope", () => {
  const time = Date.parse("2026-09-16T00:30:45.123+10:00");
  expect(logPrefix("client", time)).toBe("[2026-09-15T14:30:45.123Z] [client]");
  expect(logPrefix("server", time)).toBe("[2026-09-15T14:30:45.123Z] [server]");
});

test("wall-clock adjustments do not change elapsed log timings", () => {
  const lines = [];
  let elapsed = 10;
  let wall = Date.parse("2026-09-15T23:59:59.999Z");
  const log = createDevelopmentLog("server", {
    write: (line) => lines.push(line),
    clock: () => elapsed,
    wallClock: () => wall,
  });
  elapsed += 5;
  log("before-midnight");
  wall += 1;
  elapsed += 5;
  log("after-midnight");
  wall -= 1000;
  elapsed += 5;
  log("clock-adjusted");
  expect(lines).toEqual([
    "[2026-09-15T23:59:59.999Z] [server +5.0ms] before-midnight {}",
    "[2026-09-16T00:00:00.000Z] [server +10.0ms] after-midnight {}",
    "[2026-09-15T23:59:59.000Z] [server +15.0ms] clock-adjusted {}",
  ]);
});

test("development logs allow bounded metadata, excluding credentials and payloads", () => {
  const { log, lines } = logger();
  log("http", {
    method: "POST",
    status: 200,
    path: "a".repeat(250),
    reason: "one\ntwo",
    password: "secret",
    cookie: "secret",
    ticket: "secret",
    body: { secret: true },
  });
  expect(lines).toHaveLength(1);
  expect(lines[0]).not.toContain("secret");
  expect(lines[0].split("\n")).toHaveLength(1);
  const fields = JSON.parse(lines[0].slice(lines[0].indexOf("{")));
  expect(fields.path).toHaveLength(200);
  expect(fields.status).toBe(200);
  const quiet = logger(false);
  quiet.log("http", { status: 200 });
  expect(quiet.lines).toEqual([]);
});

test("production records server and peer socket closure while routine traffic stays quiet", () => {
  const lines = [];
  const log = createServerLog(false, { write: (line) => lines.push(line) });
  const gateway = new GameplayGateway({
    config: {},
    auth: {},
    world: { log },
  });
  const socket = {
    data: { epoch: "connection", actor: null, closed: false },
    send: () => 1,
    close: () => {},
  };
  log("http", { path: "/api/v1/config", status: 200 });
  log("action.result", { action: "attack", status: "OK" });
  gateway.publications.close(socket, "RATE_LIMITED");
  gateway.closed(socket, 1008, "RATE_LIMITED");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain('socket.closing {"code":"RATE_LIMITED"}');
  expect(lines[1]).toContain(
    'socket.closed {"code":1008,"reason":"RATE_LIMITED"}',
  );
});

test("production motion diagnostics preserve numeric evidence and exclude payloads", () => {
  const lines = [];
  const log = createServerLog(false, { write: (line) => lines.push(line) });
  log("watchdog.fault", {
    character: "actor",
    tick: 42,
    deviations: 6,
    position: 80,
    velocity: 120,
    allowedPosition: 32,
    absurd: false,
    password: "secret",
    cookie: "secret",
    body: { secret: true },
  });
  expect(lines).toHaveLength(1);
  expect(lines[0]).not.toContain("secret");
  const fields = JSON.parse(lines[0].slice(lines[0].indexOf("{")));
  expect(fields).toEqual({
    character: "actor",
    tick: 42,
    deviations: 6,
    position: 80,
    velocity: 120,
    allowedPosition: 32,
    absurd: false,
  });
});

test("production movement expiry retains bounded readiness and clock evidence", () => {
  const lines = [];
  const log = createServerLog(false, { write: (line) => lines.push(line) });
  log("movement.expired", {
    character: "actor",
    map: 922020300,
    fieldTick: 129,
    startedTick: 0,
    steps: 0,
    ready: true,
    state: "active",
    inputAgeTicks: 129,
    heartbeatAgeMs: 450,
    password: "secret",
  });
  log("private.event", { character: "actor" });

  expect(lines).toHaveLength(1);
  expect(lines[0]).not.toContain("secret");
  const fields = JSON.parse(lines[0].slice(lines[0].indexOf("{")));
  expect(fields).toEqual({
    character: "actor",
    map: 922020300,
    fieldTick: 129,
    startedTick: 0,
    steps: 0,
    ready: true,
    state: "active",
    inputAgeTicks: 129,
    heartbeatAgeMs: 450,
  });
});

test("development server logging retains routine events", () => {
  const lines = [];
  const log = createServerLog(true, { write: (line) => lines.push(line) });
  log("http", { path: "/api/v1/config", status: 200 });
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('http {"path":"/api/v1/config","status":200}');
});

test("stage failure logs its outcome and preserves the actual exception", async () => {
  const { log, lines } = logger();
  const failure = Object.assign(new Error("private details"), {
    code: "NOT_ALLOWED",
  });
  await expect(
    logStage(log, "startup", async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain('"phase":"failed"');
  expect(lines[1]).toContain("NOT_ALLOWED");
  expect(lines[1]).not.toContain("private details");
});

test("HTTP stdout includes actual status and excludes query contents", async () => {
  const { log, lines } = logger();
  const http = new OnlineHttp({
    config: {},
    auth: {},
    gateway: { database: {} },
    log,
  });
  const reply = await http.fetch(
    new Request("http://localhost/api/v1/config?token=private"),
    {},
  );
  expect(reply.status).toBe(400);
  expect(await reply.json()).toEqual({ code: "INVALID_MESSAGE" });
  expect(lines.at(-1)).toContain('"status":400');
  expect(lines.join("\n")).not.toContain("private");
});

test("origin rejection logs its reason and browser origin without login secrets", async () => {
  const { log, lines } = logger();
  const config = { origin: "http://127.0.0.1:3102" };
  const http = new OnlineHttp({
    config,
    auth: new SessionAuthority(config, null),
    gateway: { database: null },
    log,
  });
  const reply = await http.fetch(
    new Request("http://127.0.0.1:3200/api/v1/session", {
      method: "POST",
      headers: {
        Origin: "http://localhost:9999",
        "Content-Type": "application/json",
        Cookie: "openms_login=private-cookie",
      },
      body: JSON.stringify({
        name: "private-name",
        password: "private-password",
      }),
    }),
    { requestIP: () => ({ address: "127.0.0.1" }) },
  );
  expect(reply.status).toBe(403);
  expect(await reply.json()).toEqual({ code: "NOT_ALLOWED" });
  expect(lines[0]).toContain('"reason":"origin-mismatch"');
  expect(lines[0]).toContain('"origin":"http://localhost:9999"');
  expect(lines.join("\n")).not.toContain("private");
});

test("shared-map developers retain commands without granting them to players", () => {
  const actor = {
    id: "developer",
    role: "developer",
    realm: "public",
    state: "active",
    field: { characters: new Map() },
  };
  actor.field.characters.set(actor.id, actor);
  expect(() => admitDeveloper({ development: true }, actor)).not.toThrow();
  expect(() => admitDeveloper({ development: false }, actor)).toThrow(
    "NOT_ALLOWED",
  );
  actor.role = "player";
  expect(() => admitDeveloper({ development: true }, actor)).toThrow(
    "NOT_ALLOWED",
  );
  actor.role = "developer";
  actor.field.characters.clear();
  expect(() => admitDeveloper({ development: true }, actor)).toThrow(
    "STALE_FIELD",
  );
});
