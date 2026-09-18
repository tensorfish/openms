import { join } from "node:path";
import { createHash } from "node:crypto";
import { createEvidence, failureDetails } from "../native-evidence.js";
import { onlineIdentity } from "./online-lifecycle.js";
import {
  enterPlaytest,
  observePlaytest,
  drivePlaytestAction,
} from "./playtest-actions.js";
import { observationProblem } from "./playtest-plan.js";

function requireState(state, identity) {
  const problem = observationProblem(state, identity);
  if (problem) throw Object.assign(new Error(problem), { code: problem });
}

/** Doctor checks current source/catalog identity before native input or after surprises. */
export async function playtestDoctor(url) {
  const origin = new URL(url);
  if (
    origin.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  ) {
    throw new Error("Doctor requires an exact loopback HTTP origin");
  }
  return onlineIdentity(origin.href, [], {
    signal: AbortSignal.timeout(30000),
  });
}

async function drivePlan(page, options, report) {
  for (let index = 0; index < options.plan.actions.length; index++) {
    options.signal?.throwIfAborted();
    const action = options.plan.actions[index];
    const step = { index, action, before: await observePlaytest(page) };
    report.trace.push(step);
    requireState(step.before, report.identity);
    const started = performance.now();
    step.during = await drivePlaytestAction(page, action, options.signal);
    step.after = await observePlaytest(page);
    step.durationMs = performance.now() - started;
    requireState(step.after, report.identity);
    if (
      ["reconnect", "relogin"].includes(action.type) &&
      (step.before.epoch === step.after.epoch ||
        step.before.characterId !== step.after.characterId ||
        step.before.map !== step.after.map ||
        step.before.meso !== step.after.meso)
    ) {
      throw Object.assign(
        new Error(
          "Session recovery changed character/map/mesos or retained the old connection",
        ),
        { code: "session-state" },
      );
    }
    if (report.pageErrors.length) {
      throw Object.assign(new Error("Browser script error"), {
        code: "page-error",
      });
    }
    step.status = "pass";
  }
}

async function captureFailure({ page, evidence, report, options }, error) {
  report.status =
    options.signal?.aborted || error.code === "build-changed"
      ? "blocked"
      : "candidate";
  report.failure = {
    ...failureDetails(error),
    actionIndex: report.trace.at(-1)?.index ?? null,
  };
  report.failure.fingerprint = createHash("sha256")
    .update(
      `${error.code ?? error.name}:${error.message}:${report.trace.at(-1)?.action.type ?? "entry"}`,
    )
    .digest("hex");
  report.failure.observation = await observePlaytest(page).catch((failure) => ({
    error: failure.message,
  }));
  report.failure.files = await evidence.failure();
  report.doctorAfterFailure = await playtestDoctor(options.url).then(
    (identity) => ({ status: "ready", identity }),
    (failure) => ({ status: "blocked", message: failure.message }),
  );
  if (
    report.doctorAfterFailure.status === "blocked" ||
    report.doctorAfterFailure.identity.sourceBuildId !==
      report.identity?.sourceBuildId
  ) {
    report.status = "blocked";
  }
}

/** Borrow only the owned fixture browser; close this run's context and retain evidence. */
export async function runOnlinePlaytest(options, report) {
  const context = await options.browser.createBrowserContext();
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  await page.setViewport({ width: 1280, height: 800 });
  const evidence = await createEvidence(page, options.output);
  const onError = (error) => {
    if (report.pageErrors.length < 32) report.pageErrors.push(String(error));
  };
  page.on("pageerror", onError);
  try {
    report.fixture = options.fixture;
    report.identity = await playtestDoctor(options.url);
    report.phase = "entry";
    await enterPlaytest(page, options.url);
    report.entry = await observePlaytest(page);
    requireState(report.entry, report.identity);
    report.phase = "actions";
    await drivePlan(page, options, report);
    const identity = await playtestDoctor(options.url);
    if (identity.sourceBuildId !== report.identity.sourceBuildId) {
      throw Object.assign(new Error("Source changed during playtest"), {
        code: "build-changed",
      });
    }
    await page.screenshot({ path: join(options.output, "final.png") });
    report.status = "pass";
  } catch (error) {
    await captureFailure({ page, evidence, report, options }, error);
  } finally {
    report.events = evidence.events;
    page.off("pageerror", onError);
    try {
      await evidence.close();
    } finally {
      await context.close();
    }
  }
  return report;
}
