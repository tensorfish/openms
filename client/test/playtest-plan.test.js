import { expect, test } from "bun:test";
import {
  generatePlan,
  validatePlan,
  observationProblem,
} from "../tools/scenarios/playtest-plan.js";
import { playtestOptions } from "../../server/tools/playtest-options.js";

test("replays the same seed and retains required baseline actions", () => {
  const first = generatePlan(42, 12);
  expect(first).toEqual(generatePlan(42, 12));
  expect(first).not.toEqual(generatePlan(43, 12));
  expect(first.actions).toHaveLength(12);
  expect(first.actions.at(-1).type).toBe("reconnect");
  expect(validatePlan(JSON.parse(JSON.stringify(first)))).toEqual(first);
});

test("refuses code, arbitrary selectors and excessive held inputs", () => {
  for (const action of [
    { type: "evaluate", script: "window.maple.dev" },
    { type: "reconnect", url: "https://example.com" },
    { type: "window", name: "Item", entry: "hud", selector: "body" },
    { type: "walk", direction: "right", milliseconds: 1501 },
    { type: "walk", direction: "up", milliseconds: 200 },
  ]) {
    expect(() => validatePlan({ version: 1, actions: [action] })).toThrow();
  }
  expect(() => generatePlan(1, 33)).toThrow();
  expect(() => validatePlan({ version: 1, actions: [] })).toThrow();
});

test("observations distinguish game faults, unreadiness and changed builds", () => {
  const identity = { sourceBuildId: "source", assetBuildId: "assets" };
  const state = {
    ...identity,
    status: "active",
    loading: false,
    x: 0,
    y: 0,
    hp: 50,
  };
  expect(observationProblem(state, identity)).toBeNull();
  expect(observationProblem({ ...state, x: NaN }, identity)).toBe(
    "invalid-position",
  );
  expect(observationProblem({ ...state, hp: -1 }, identity)).toBe("invalid-hp");
  expect(
    observationProblem({ ...state, sourceBuildId: "other" }, identity),
  ).toBe("build-changed");
  expect(observationProblem({ ...state, error: "broken" }, identity)).toBe(
    "runtime-error",
  );
  expect(observationProblem({ ...state, loading: true }, identity)).toBe(
    "not-ready",
  );
});

test("admits native chat, session cycles and bounded window dismissal methods", () => {
  const actions = [
    { type: "chat", text: "i e s k typing stays in chat", mode: "send" },
    { type: "chat", text: "x".repeat(70), mode: "cancel" },
    { type: "relogin" },
    { type: "window", name: "Item", entry: "hud", close: "escape" },
    { type: "window", name: "Skill", entry: "keyboard", close: "shortcut" },
  ];
  expect(validatePlan({ version: 1, actions }).actions).toEqual(actions);
  for (const action of [
    { type: "chat", text: "x".repeat(71), mode: "send" },
    { type: "chat", text: "", mode: "send" },
    { type: "chat", text: "hello\nworld", mode: "send" },
    { type: "chat", text: "/whisper Player hello", mode: "send" },
    { type: "chat", text: " hello ", mode: "send" },
    { type: "chat", text: "hello", mode: "script" },
    { type: "relogin", account: "someone-else" },
    { type: "window", name: "Item", entry: "hud", close: "evaluate" },
  ]) {
    expect(() => validatePlan({ version: 1, actions: [action] })).toThrow();
  }
});

test("rejects ambiguous plans, unsafe database targets and colliding ports", () => {
  for (const args of [
    ["--seed", "1", "--seed", "2"],
    ["--plan", "plan.json", "--steps", "4"],
    ["--server-port", "3197"],
    ["--unknown"],
    ["--chrome"],
    ["--database-url", "postgres://user:pass@example.com/game"],
  ]) {
    expect(() => playtestOptions(args)).toThrow();
  }
  expect(playtestOptions(["--seed", "42"]).seed).toBe(42);
  expect(playtestOptions(["--help"])).toEqual({ help: true });
});
