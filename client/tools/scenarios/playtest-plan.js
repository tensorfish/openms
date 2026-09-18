import { CHAT_LIMIT } from "../../src/social/chat-rules.js";

export const MAX_ACTIONS = 32;
export const WINDOWS = Object.freeze({
  Item: { key: "i", label: "Item Inventory (I)" },
  Equip: { key: "e", label: "Equipment Window (E)" },
  Stat: { key: "s", label: "Ability Window (S)" },
  Skill: { key: "k", label: "Skill Window (K)" },
});

/** Closed data-only commands: no JavaScript, arbitrary keys, URLs or selectors. */
export function validatePlan(plan) {
  if (
    !plan ||
    plan.version !== 1 ||
    !Array.isArray(plan.actions) ||
    plan.actions.length < 1 ||
    plan.actions.length > MAX_ACTIONS
  ) {
    throw new Error(`Plan requires version 1 and 1..${MAX_ACTIONS} actions`);
  }
  for (const action of plan.actions) validateAction(action);
  return { version: 1, actions: plan.actions.map((action) => ({ ...action })) };
}

function validateAction(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    throw new Error("Each action must be an object");
  }
  const fields = {
    walk: ["type", "direction", "milliseconds"],
    jump: ["type", "direction"],
    window: ["type", "name", "entry", "close"],
    reconnect: ["type"],
    relogin: ["type"],
    chat: ["type", "text", "mode"],
  };
  if (
    !Object.hasOwn(fields, action.type) ||
    Object.keys(action).some((key) => !fields[action.type].includes(key))
  ) {
    throw new Error("Unknown playtest action or action field");
  }
  if (["walk", "jump"].includes(action.type)) validateMovement(action);
  if (action.type === "window") validateWindow(action);
  if (action.type === "chat") validateChat(action);
}

function validateWindow(action) {
  if (
    !Object.hasOwn(WINDOWS, action.name) ||
    !["keyboard", "hud"].includes(action.entry) ||
    (action.close !== undefined &&
      !["button", "shortcut", "escape"].includes(action.close))
  ) {
    throw new Error(
      "Window requires Item/Equip/Stat/Skill, keyboard/hud entry and button/shortcut/escape close",
    );
  }
}

function validateChat(action) {
  if (
    typeof action.text !== "string" ||
    action.text.length > CHAT_LIMIT ||
    !/^[\x20-\x7e]+$/.test(action.text) ||
    action.text !== action.text.trim() ||
    action.text.startsWith("/") ||
    !["send", "cancel"].includes(action.mode)
  ) {
    throw new Error(
      `Chat requires 1..${CHAT_LIMIT} printable ASCII characters without commands or surrounding spaces, and send/cancel mode`,
    );
  }
}

function validateMovement(action) {
  if (
    ["walk", "jump"].includes(action.type) &&
    !["left", "right"].includes(action.direction)
  ) {
    throw new Error("Movement direction must be left or right");
  }
  if (
    action.type === "walk" &&
    (!Number.isInteger(action.milliseconds) ||
      action.milliseconds < 100 ||
      action.milliseconds > 1500)
  ) {
    throw new Error("Walk duration must be 100..1500 milliseconds");
  }
}

/** Seed selects actions, not deterministic world timing. Persist the plan for replay. */
export function generatePlan(seed, count) {
  if (
    !Number.isInteger(seed) ||
    seed < 1 ||
    seed > 0xffffffff ||
    !Number.isInteger(count) ||
    count < 4 ||
    count > MAX_ACTIONS
  ) {
    throw new Error(
      `Seed must be 1..4294967295; steps must be 4..${MAX_ACTIONS}`,
    );
  }
  let state = seed >>> 0;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
  const actions = [
    { type: "walk", direction: "right", milliseconds: 400 },
    { type: "jump", direction: "right" },
    { type: "window", name: "Item", entry: "keyboard" },
  ];
  for (let index = actions.length; index < count - 1; index++) {
    actions.push(randomAction(random));
  }
  actions.push({ type: "reconnect" });
  return validatePlan({ version: 1, actions });
}

function randomAction(random) {
  const choice = Math.floor(random() * 4);
  const direction = random() < 0.5 ? "left" : "right";
  if (choice === 0) {
    return {
      type: "walk",
      direction,
      milliseconds: 200 + Math.floor(random() * 6) * 100,
    };
  }
  if (choice === 1) return { type: "jump", direction };
  const names = Object.keys(WINDOWS);
  if (choice === 2) {
    return {
      type: "window",
      name: names[Math.floor(random() * names.length)],
      entry: random() < 0.5 ? "keyboard" : "hud",
    };
  }
  return { type: "reconnect" };
}

/** Diagnose observed behavior only. No movement assertion at walls or map edges. */
export function observationProblem(state, identity) {
  if (!state || state.status !== "active" || state.loading) return "not-ready";
  if (state.error) return "runtime-error";
  if (
    state.sourceBuildId !== identity.sourceBuildId ||
    state.assetBuildId !== identity.assetBuildId
  ) {
    return "build-changed";
  }
  if (!Number.isFinite(state.x) || !Number.isFinite(state.y)) {
    return "invalid-position";
  }
  if (!Number.isFinite(state.hp) || state.hp < 0) return "invalid-hp";
  return null;
}
