import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { assertion, failureDetails, measureStage } from "../native-evidence.js";
import { onlineIdentity } from "./online-lifecycle.js";
import { participant, focusGame } from "./online-ui-repairs.js";
import { login } from "./online-recycling-scrolls.js";

const CAPACITY = 1600;
const pause = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Observe the rendered local character, not just the movement kernel. */
function sampleFrames() {
  const probe = { rows: [], running: true, overflow: false };
  window.__walkMotionProbe = probe;
  function sample(time) {
    if (!probe.running) return;
    if (probe.rows.length >= 1600) {
      probe.overflow = true;
      return;
    }
    const state = window.maple.snapshot();
    probe.rows.push({
      time,
      x: state.presentation.x,
      y: state.presentation.y,
      kernelX: state.simulation.x,
      kernelY: state.simulation.y,
      previousX: state.simulation.previousX,
      previousY: state.simulation.previousY,
      vx: state.simulation.vx,
      vy: state.simulation.vy,
      state: state.simulation.state,
      ...state.prediction,
    });
    requestAnimationFrame(sample);
  }
  requestAnimationFrame(sample);
}

async function hold(page, key, network, stall = false) {
  const started = await page.evaluate(() => performance.now());
  await page.keyboard.down(key);
  await pause(1500);
  if (stall) network.stall(1500);
  await pause(2500);
  await page.keyboard.up(key);
  const ended = await page.evaluate(() => performance.now());
  await pause(400);
  return { key, started, ended, stall };
}

function analyze(rows, hold) {
  const direction = hold.key === "ArrowRight" ? 1 : -1;
  let backwards = 0,
    stalls = 0,
    maximumBackstep = 0,
    frames = 0;
  let longestPauseMs = 0,
    pauseMs = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i],
      previous = rows[i - 1];
    if (previous.time < hold.started + 400 || row.time > hold.ended) continue;
    const delta = direction * (row.x - previous.x);
    frames++;
    if (delta < -0.1) backwards++;
    maximumBackstep = Math.max(maximumBackstep, -delta);
    if (Math.abs(delta) < 0.02) {
      stalls++;
      pauseMs += row.time - previous.time;
      longestPauseMs = Math.max(longestPauseMs, pauseMs);
    } else pauseMs = 0;
  }
  return {
    ...hold,
    frames,
    backwards,
    stalls,
    maximumBackstep,
    longestPauseMs,
  };
}

/** A safe town floor isolates walking from mob hits, attacks and wall collisions. */
export async function runWalkMotion({
  browser,
  url,
  output,
  network,
  roundTripMs,
  baseline,
  scope = "walk",
}) {
  await mkdir(output, { recursive: true });
  const report = {
    status: "running",
    roundTripMs,
    baseline,
    scope,
    timings: {},
    results: [],
    errors: [],
    holds: [],
    wire: [],
  };
  const contexts = [];
  const pages = [];
  try {
    report.identity = await measureStage(report.timings, "identity", () =>
      onlineIdentity(url),
    );
    const page = await participant(browser, contexts, pages, report);
    await measureStage(report.timings, "readiness", () =>
      login(page, url, "motion"),
    );
    await prepareWalk(page, network, report);
    await page.evaluate(sampleFrames);
    await measureStage(report.timings, "walks", () =>
      scope === "landing"
        ? jumps(page, network, report)
        : walks(page, network, report),
    );
    await collectMotion(page, report, { output, url });
    if (!baseline) verify(report);
    report.status = "pass";
  } catch (error) {
    report.status = "fail";
    report.failure = failureDetails(error);
  } finally {
    await measureStage(report.timings, "teardown", async () => {
      for (const context of contexts) await context.close();
    });
    await Bun.write(
      join(output, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
  }
  return report;
}

async function collectMotion(page, report, { output, url }) {
  const probe = await page.evaluate(() => {
    window.__walkMotionProbe.running = false;
    return window.__walkMotionProbe;
  });
  await Bun.write(join(output, "frames.json"), JSON.stringify(probe.rows));
  report.analysis =
    report.scope === "walk"
      ? report.holds.map((entry) => analyze(probe.rows, entry))
      : [];
  report.recovery = recovery(probe.rows);
  report.contact = analyzeContact(probe.rows);
  assertion(!probe.overflow, "Movement sampler exhausted");
  assertion(report.errors.length === 0, "Browser errors");
  assertion(
    (await page.evaluate(() => window.maple.snapshot().sourceBuildId)) ===
      report.identity.sourceBuildId &&
      (await onlineIdentity(url)).source === report.identity.source,
    "Movement check source identity changed",
  );
}

async function prepareWalk(page, network, report) {
  await focusGame(page);
  network.roundTripMs = report.roundTripMs;
  await measureStage(report.timings, "latencyWarmup", async () => {
    if (report.roundTripMs) {
      await page.waitForFunction(
        (rtt) => window.mapleOnline.snapshot().timing.roundTripMs >= rtt - 50,
        { timeout: 45000 },
        report.roundTripMs,
      );
    }
    await pause(report.roundTripMs + 500);
  });
  const wire = await page.createCDPSession();
  await wire.send("Network.enable");
  wire.on("Network.webSocketFrameReceived", ({ response }) => {
    const message = JSON.parse(response.payloadData);
    if (message.type === "motion" && report.wire.length < CAPACITY) {
      report.wire.push(message);
    }
  });
}

async function walks(page, network, report) {
  report.holds.push(await hold(page, "ArrowRight", network));
  report.holds.push(await hold(page, "ArrowLeft", network));
  report.holds.push(await hold(page, "ArrowRight", network, true));
  await pause(report.roundTripMs + 1600);
}

/** Ordinary jump input with delayed landings and one stalled airborne interval. */
async function jumps(page, network, report) {
  for (const key of [null, null, "ArrowRight", "ArrowLeft", null, null]) {
    if (key) await page.keyboard.down(key);
    await page.keyboard.down("Space");
    await pause(90);
    await page.keyboard.up("Space");
    await pause(150);
    if (report.holds.length === 4) network.stall(1500);
    await pause(450);
    if (key) await page.keyboard.up(key);
    report.holds.push({ key, jump: true });
    await pause(1900);
  }
  await pause(report.roundTripMs + 1600);
}

/** The fixture stays on the original flat town floor; allow one landing quantum. */
function analyzeContact(rows) {
  let floatingFrames = 0,
    maximumGap = 0,
    airborneFrames = 0;
  for (const row of rows) {
    if (row.state === "air") airborneFrames++;
    if (
      row.state !== "ground" ||
      Math.abs(row.kernelY - row.previousY) > 0.001
    ) {
      continue;
    }
    const gap = Math.abs(row.y - row.kernelY);
    maximumGap = Math.max(maximumGap, gap);
    if (gap > 0.01) floatingFrames++;
  }
  return { floatingFrames, maximumGap, airborneFrames };
}

function verify(report) {
  for (const walk of report.scope === "walk" ? report.analysis : []) {
    assertion(walk.frames >= 80, "Insufficient steady walking frames");
    assertion(walk.maximumBackstep < 1, "Held walking visibly moves backward");
    assertion(walk.longestPauseMs < 100, "Held walking visibly pauses");
  }
  if (report.scope === "landing") {
    assertion(
      report.contact.airborneFrames >= 80,
      "Insufficient native jump frames",
    );
    assertion(
      report.contact.floatingFrames === 0,
      "Landed character floats off its floor",
    );
  }
  assertion(
    report.recovery.notReady === 0,
    "Movement prediction became unavailable",
  );
  assertion(report.recovery.overflows === 0, "Movement history overflowed");
  assertion(
    report.recovery.error < 1,
    "Rendered movement did not settle onto trusted state",
  );
}

function recovery(rows) {
  const last = rows.at(-1);
  return {
    notReady: rows.filter((row) => !row.ready).length,
    overflows: last.overflows - rows[0].overflows,
    error: Math.hypot(last.x - last.kernelX, last.y - last.kernelY),
  };
}
