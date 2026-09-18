import { setTimeout as delay } from "node:timers/promises";
import { clickLabel, focusCanvas } from "./native.js";
import { closeConsole, replace } from "./online-ui-repairs.js";
import { ready, reconnect } from "./online-latency.js";
import { WINDOWS } from "./playtest-plan.js";
import { drivePlaytestChat } from "./playtest-chat.js";
import { assertion } from "../native-evidence.js";

/** Detached observation only; never call agent.act, development endpoints or setters. */
export function observePlaytest(page) {
  return page.evaluate(() => {
    const state = window.maple?.snapshot();
    const model = window.mapleOnline?.observation();
    if (!state || !model) return null;
    return {
      sourceBuildId: state.sourceBuildId,
      assetBuildId: state.buildId,
      status: state.online.status,
      epoch: state.online.connectionEpoch,
      characterId: state.online.characterId,
      map: model.field?.mapId,
      x: model.self?.entity.position.x,
      y: model.self?.entity.position.y,
      localX: state.simulation?.x,
      localY: state.simulation?.y,
      hp: model.self?.hp,
      meso: model.inventory?.mesos,
      loading: state.loading,
      error: state.lastError,
      windows: Array.from(document.querySelectorAll(".maple-ui-panel"))
        .filter((node) => node.getBoundingClientRect().width > 0)
        .map((node) => node.getAttribute("aria-label")),
    };
  });
}

export async function enterPlaytest(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForFunction(
    () => {
      const state = window.maple?.snapshot();
      return (
        state?.login?.artwork &&
        !state.delivery.startup &&
        !state.delivery.visible
      );
    },
    { timeout: 120000 },
  );
  await closeConsole(page);
  await signInPlaytest(page);
}

async function signInPlaytest(page) {
  await page.waitForSelector('.online-login [name="name"]', { visible: true });
  await replace(page, '.online-login [name="name"]', "playtester");
  await replace(page, '.online-login [name="password"]', "password");
  await page.click(".online-login-submit");
  await page.waitForFunction(() => {
    const login = window.maple.snapshot().login;
    return login.stage === "characters" && !login.transition.active;
  });
  await page.click(".online-login-enter");
  await ready(page);
}

async function relogin(page) {
  await focusCanvas(page);
  await clickLabel(page, "GameMenu");
  await clickLabel(page, "Quit", '.maple-ui-panel[aria-label="GameMenu"]');
  await clickLabel(page, "OK", '.maple-ui-panel[aria-label="NativePrompt"]');
  await page.waitForSelector('.online-login [name="name"]', { visible: true });
  const signedOut = await observePlaytest(page);
  // Read-only request proves native Quit revoked the server session.
  const authenticationStatus = await page.evaluate(async () => {
    const response = await fetch("/api/v1/characters", {
      signal: AbortSignal.timeout(5000),
    });
    return response.status;
  });
  assertion(
    authenticationStatus === 401,
    "Quit retained an authenticated session",
  );
  await signInPlaytest(page);
  return { signedOut, authenticationStatus };
}

async function move(page, action, signal) {
  await focusCanvas(page);
  const key = action.direction === "left" ? "ArrowLeft" : "ArrowRight";
  await page.keyboard.down(key);
  try {
    if (action.type === "jump") await page.keyboard.press("Alt");
    await delay(action.type === "jump" ? 200 : action.milliseconds, null, {
      signal,
    });
    return await observePlaytest(page);
  } finally {
    await page.keyboard.up(key);
  }
}

async function windowCycle(page, action) {
  const binding = WINDOWS[action.name];
  await focusCanvas(page);
  if (action.entry === "keyboard") await page.keyboard.press(binding.key);
  else await clickLabel(page, binding.label);
  const selector = `.maple-ui-panel[aria-label="${action.name}"]`;
  await page.waitForSelector(selector, { visible: true });
  const opened = await observePlaytest(page);
  if (action.close === "shortcut") await page.keyboard.press(binding.key);
  else if (action.close === "escape") await page.keyboard.press("Escape");
  else await clickLabel(page, `Close ${action.name}`, selector);
  await page.waitForSelector(selector, { hidden: true });
  return opened;
}

/** One native action at a time; every held key is released even when a drive fails. */
export async function drivePlaytestAction(page, action, signal) {
  signal?.throwIfAborted();
  let during = null;
  if (action.type === "walk" || action.type === "jump") {
    during = await move(page, action, signal);
  } else if (action.type === "window") during = await windowCycle(page, action);
  else if (action.type === "reconnect") await reconnect(page);
  else if (action.type === "relogin") during = await relogin(page);
  else if (action.type === "chat") {
    during = await drivePlaytestChat(page, action, signal);
  } else throw new Error(`Unsupported action: ${action.type}`);
  await ready(page);
  await delay(250, null, { signal });
  return during;
}
