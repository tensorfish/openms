import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { clickLabel, focusCanvas, openConsoleSection } from "./native.js";
import { sourceIdentity } from "../browser-build.js";

const TIMEOUT = 120000;
const DESTINATION = "100010000";
const TOWN = "100000000";
const MAX_ERRORS = 32;
const LOADER = '[aria-label="Loading game files"]';
const REVIVE = '[aria-label="Revive in the nearest town"]';

function check(report, name, pass, details = {}) {
  report.checks.push({ name, pass, details });
  if (!pass) throw new Error(name);
}

function observation(page) {
  return page.evaluate(() => {
    const state = window.maple.snapshot();
    const model = window.mapleOnline.observation();
    return {
      sourceBuildId: state.sourceBuildId,
      assetBuildId: state.buildId,
      status: state.online.status,
      connectionEpoch: state.online.connectionEpoch,
      characterId: state.online.characterId,
      mapId: model?.field.mapId ?? null,
      hp: model?.self.hp ?? null,
      position: model?.self.entity.position ?? null,
      loading: state.loading,
      lastError: state.lastError,
      errorLog: document.querySelector("#error")?.value.slice(0, 32768) ?? "",
    };
  });
}

async function ready(page, mapId = null) {
  await page.waitForFunction(
    (id) => {
      const state = window.maple?.snapshot();
      const model = window.mapleOnline?.observation();
      return (
        state?.online.status === "active" &&
        !state.loading &&
        (id === null || model?.field.mapId === Number(id))
      );
    },
    { timeout: TIMEOUT },
    mapId,
  );
}

async function signIn(page, credentials) {
  await page.waitForFunction(
    () => document.querySelector("#delivery-startup")?.hidden,
    { timeout: TIMEOUT },
  );
  await page.waitForSelector('.online-login [name="name"]', {
    visible: true,
    timeout: TIMEOUT,
  });
  await replaceInput(page, '.online-login [name="name"]', credentials.account);
  await replaceInput(
    page,
    '.online-login [name="password"]',
    credentials.password,
  );
  await page.click(".online-login-submit");
  await page.waitForFunction(
    () => {
      const error = window.maple.snapshot().lastError;
      if (error) throw new Error(error);
      const button = document.querySelector(".online-login-enter");
      return button && !button.closest("[hidden]") && !button.disabled;
    },
    { timeout: TIMEOUT },
  );
  await page.click(".online-login-enter");
  await ready(page);
}

async function replaceInput(page, selector, value) {
  await page.click(selector);
  const length = await page.$eval(selector, (element) => element.value.length);
  if (length > 256) {
    throw new Error("Native input exceeds its 256-character bound");
  }
  // Native deletion on both sides works without platform-specific select-all chords.
  for (let index = 0; index < length; index++) {
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Delete");
  }
  await page.type(selector, value);
  const matches = await page.$eval(
    selector,
    (element, expected) => element.value === expected,
    value,
  );
  if (!matches) {
    const state = await page.$eval(selector, (element) => ({
      active: document.activeElement === element,
      focusedTag: document.activeElement?.tagName,
      disabled: element.matches(":disabled"),
      length: element.value.length,
      value: element.type === "password" ? null : element.value,
    }));
    throw new Error(
      `Native ${selector} replacement failed: ${JSON.stringify(state)}`,
    );
  }
}

/** Explicit GM fixture setup through the authenticated development authority, not earned damage. */
async function setup(page, action) {
  const result = await page.evaluate(async (value) => {
    const configResponse = await fetch("/api/v1/config");
    if (!configResponse.ok) {
      throw new Error(`Configuration HTTP ${configResponse.status}`);
    }
    const config = await configResponse.json();
    const response = await fetch("/api/v1/development", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        csrfToken: config.csrfToken,
        connectionEpoch: window.mapleOnline.snapshot().connectionEpoch,
        operationId: crypto.randomUUID(),
        action: value,
      }),
    });
    const receipt = await response.json();
    if (!response.ok) {
      throw new Error(`Development HTTP ${response.status}: ${receipt.code}`);
    }
    return receipt;
  }, action);
  if (result.status !== "committed") {
    throw new Error(`Development setup: ${result.status}`);
  }
  await ready(page);
}

async function selectDestination(page) {
  if (await page.$eval("#gm-console", (element) => element.hidden)) {
    await page.click("#console-toggle");
  }
  await openConsoleSection(page, "world");
  if (!(await page.$eval("#map-selection", (element) => element.open))) {
    await page.click("#map-selection summary");
  }
  await page.waitForFunction(
    () => !document.querySelector("#map-search").matches(":disabled"),
    { timeout: TIMEOUT },
  );
  await replaceInput(page, "#map-search", DESTINATION);
  await page.waitForFunction(
    (id) => {
      const options = document.querySelector("#map").options;
      return options.length === 1 && options[0].value === id;
    },
    { timeout: TIMEOUT },
    DESTINATION,
  );
  await page.select("#map", DESTINATION);
}

/** Hold one real destination request until the screenshot; never throttle the decoration itself. */
async function coldTravel(page, tools) {
  await selectDestination(page);
  const before = await observation(page);
  let held = null;
  const onRequest = (request) => {
    if (
      request.url() === new URL(tools.descriptor.url, tools.url).href &&
      !held
    ) {
      held = request;
    } else {
      request.continue().catch((error) => {
        if (tools.errors.length < MAX_ERRORS) tools.errors.push(String(error));
      });
    }
  };
  await page.setCacheEnabled(false);
  await page.setRequestInterception(true);
  page.on("request", onRequest);
  try {
    await focusCanvas(page);
    await page.keyboard.down("ArrowRight");
    await page.click("#map-go");
    await page.waitForSelector(`${LOADER}:not([hidden])`, {
      visible: true,
      timeout: TIMEOUT,
    });
    await page.waitForFunction(
      (selector) => {
        const image = document.querySelector(`${selector} img`);
        return image?.complete && image.naturalWidth > 0;
      },
      { timeout: TIMEOUT },
      LOADER,
    );
    await page.screenshot({
      path: join(tools.output, "uncached-destination.png"),
    });
    check(
      tools.report,
      "Uncached destination uses the original mushroom loading screen",
      Boolean(held),
    );
  } finally {
    page.off("request", onRequest);
    if (held) await held.continue();
    await page.setRequestInterception(false);
    await page.keyboard.up("ArrowRight");
  }
  await ready(page, DESTINATION);
  const after = await observation(page);
  check(
    tools.report,
    "Native map Go retains the authenticated connection",
    before.connectionEpoch === after.connectionEpoch,
    { before, after },
  );
  await page.screenshot({ path: join(tools.output, "world-destination.png") });
  await inspectWorldControls(page, tools);
}

async function resumeMovement(page, tools) {
  const before = await observation(page);
  await focusCanvas(page);
  try {
    await page.keyboard.down("ArrowRight");
    await page.waitForFunction(
      (x) => {
        const model = window.mapleOnline.observation();
        return Math.abs(model.self.entity.position.x - x) > 2;
      },
      { timeout: 8000 },
      before.position.x,
    );
  } finally {
    await page.keyboard.up("ArrowRight");
  }
  const after = await observation(page);
  check(
    tools.report,
    "Destination accepts native movement on the same connection",
    after.status === "active" &&
      after.connectionEpoch === before.connectionEpoch,
    { before, after },
  );
}

async function inspectWorldControls(page, tools) {
  const controls = await page.evaluate(() => ({
    map: document.querySelector("#map-selection").closest("section").id,
    spawn: document.querySelector("#mob-spawn-section").closest("section").id,
    sections: Array.from(
      document.querySelector("#console-section").options,
      (option) => option.value,
    ),
  }));
  check(
    tools.report,
    "Map and monster controls belong to World without a redundant Field section",
    controls.map === "console-world" &&
      controls.spawn === "console-world" &&
      !controls.sections.includes("field"),
    controls,
  );
}

async function deathFixture(page) {
  await setup(page, { kind: "profile", patch: { hp: 0 } });
  await page.waitForSelector(REVIVE, { visible: true, timeout: TIMEOUT });
}

async function revive(page, tools) {
  await deathFixture(page);
  const before = await observation(page);
  await page.click(REVIVE);
  await ready(page, TOWN);
  await page.waitForFunction(
    () => window.mapleOnline.observation().self.hp > 0,
    { timeout: TIMEOUT },
  );
  const after = await observation(page);
  check(
    tools.report,
    "Native revival OK returns alive to the authored town on the same connection",
    before.hp === 0 &&
      after.hp > 0 &&
      before.connectionEpoch === after.connectionEpoch,
    { before, after },
  );
  await page.screenshot({ path: join(tools.output, "revived-town.png") });
}

async function nativeQuit(page, tools) {
  await focusCanvas(page);
  await clickLabel(page, "GameMenu");
  await clickLabel(page, "Quit", '.maple-ui-panel[aria-label="GameMenu"]');
  await clickLabel(page, "OK", '.maple-ui-panel[aria-label="NativePrompt"]');
  await page.waitForSelector('.online-login [name="name"]', {
    visible: true,
    timeout: TIMEOUT,
  });
  const authenticated = await page.evaluate(async () => {
    const response = await fetch("/api/v1/characters");
    return response.status;
  });
  check(
    tools.report,
    "Native Quit revokes the session instead of retaining a disconnected actor",
    authenticated === 401,
    { status: authenticated },
  );
  await signIn(page, tools);
  check(
    tools.report,
    "Immediate sign-in after Quit reacquires the character",
    (await observation(page)).status === "active",
  );
}

async function deadLogout(page, tools) {
  await selectDestination(page);
  await page.click("#map-go");
  await ready(page, DESTINATION);
  await deathFixture(page);
  const before = await observation(page);
  // Reload leaves the dead actor in reconnect grace; the login tool's Sign out retires it.
  await page.reload({ waitUntil: "domcontentloaded", timeout: TIMEOUT });
  if (await page.$eval("#gm-console", (node) => node.hidden)) {
    await page.click("#console-toggle");
  }
  await openConsoleSection(page, "world");
  await page.waitForSelector(".online-login-signout", {
    visible: true,
    timeout: TIMEOUT,
  });
  await page.click(".online-login-signout");
  await signIn(page, tools);
  const after = await observation(page);
  check(
    tools.report,
    "Dead logout durably revives in town without pressing revival OK",
    before.hp === 0 &&
      after.hp > 0 &&
      after.mapId === Number(TOWN) &&
      before.characterId === after.characterId,
    { before, after },
  );
  await page.screenshot({ path: join(tools.output, "dead-logout-return.png") });
}

/** Shared online replay gate: served bytes and the compiled online source identity. */
export async function onlineIdentity(
  url,
  mapIds = [],
  { development = true, signal = undefined } = {},
) {
  const response = await fetch(new URL("/generated/catalog.json", url), {
    signal,
  });
  if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  const local = await Bun.file(
    resolve(import.meta.dir, "../../public/generated/catalog.json"),
  ).arrayBuffer();
  if (digest(bytes) !== digest(Buffer.from(local))) {
    throw new Error("Served catalog differs from workspace");
  }
  const catalog = JSON.parse(bytes.toString("utf8"));
  const maps = {};
  for (const id of mapIds) {
    if (!catalog.maps[id]) {
      throw new Error(`Validation map ${id} is not packaged`);
    }
    maps[id] = catalog.maps[id];
  }
  const configResponse = await fetch(new URL("/api/v1/config", url), {
    signal,
  });
  if (!configResponse.ok) {
    throw new Error(`Configuration HTTP ${configResponse.status}`);
  }
  const config = await configResponse.json();
  const source = await sourceIdentity();
  const sourceBuildId = digest(
    `${source}\0online\0${development}\0${config.rulesHash}\0${digest(bytes)}`,
  );
  return {
    source,
    sourceBuildId,
    rulesHash: config.rulesHash,
    catalogHash: digest(bytes),
    assetBuildId: catalog.buildId,
    maps,
  };
}

/** Fresh isolated context; borrows the caller's browser. GM-set vitals are labeled setup. */
export async function runOnlineLifecycle({
  browser,
  url,
  output,
  account,
  password,
}) {
  await mkdir(output, { recursive: true });
  const started = performance.now();
  const identity = await onlineIdentity(url, [DESTINATION, TOWN]);
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const errors = [];
  const wire = await observeSocketClosures(page);
  const report = {
    schemaVersion: 1,
    identity,
    setup:
      "Dedicated development account; HP edits are GM fixtures, not earned damage.",
    checks: [],
    timings: {},
    socketClosures: wire.closures,
  };
  const tools = {
    url,
    output,
    account,
    password,
    errors,
    report,
    descriptor: identity.maps[DESTINATION],
  };
  page.on("pageerror", (error) => {
    if (errors.length < MAX_ERRORS) errors.push(String(error));
  });
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  try {
    await exerciseLifecycle(page, tools, started);
  } catch (error) {
    report.status = "fail";
    report.error = { message: error.message, stack: error.stack };
    report.state = await observation(page).catch((failure) => ({
      error: failure.message,
    }));
    await page.screenshot({ path: join(output, "failure.png") });
  } finally {
    report.errors = errors;
    report.timings.totalMs = performance.now() - started;
    await wire.session.detach();
    await context.close();
    await Bun.write(
      join(output, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
  }
  return report;
}

async function exerciseLifecycle(page, tools, started) {
  const { url, report, errors } = tools;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
  await signIn(page, tools);
  report.before = await observation(page);
  check(
    report,
    "Served online source matches current workspace",
    report.before.sourceBuildId === report.identity.sourceBuildId,
  );
  report.timings.loginMs = performance.now() - started;
  await setup(page, {
    kind: "profile",
    patch: { baseMaxHP: 30000, hp: 30000 },
  });
  await coldTravel(page, tools);
  await resumeMovement(page, tools);
  await revive(page, tools);
  await nativeQuit(page, tools);
  await deadLogout(page, tools);
  report.after = await observation(page);
  check(
    report,
    "Source and catalog identities stay fixed throughout lifecycle verification",
    report.before.sourceBuildId === report.after.sourceBuildId &&
      report.after.assetBuildId === report.identity.assetBuildId &&
      (await sourceIdentity()) === report.identity.source,
  );
  check(
    report,
    "No client runtime or page-script errors",
    errors.length === 0 && !report.before.lastError && !report.after.lastError,
    { errors, before: report.before.lastError, after: report.after.lastError },
  );
  report.status = "pass";
}

async function observeSocketClosures(page) {
  const session = await page.createCDPSession();
  await session.send("Network.enable");
  await session.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  const closures = [];
  session.on("Network.webSocketFrameReceived", ({ response }) => {
    if (response.opcode !== 1) return;
    const message = JSON.parse(response.payloadData);
    if (message.type === "closing" && closures.length < MAX_ERRORS) {
      closures.push({ code: message.code, retryAfterMs: message.retryAfterMs });
    }
  });
  return { session, closures };
}
