import { mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { createProfile } from "../../client/src/profile/profile-validation.js";
import { nearestSavedArrival } from "../../client/src/world/field-arrival.js";
import {
  generatePlan,
  validatePlan,
} from "../../client/tools/scenarios/playtest-plan.js";
import { playtestOptions, HELP } from "./playtest-options.js";

const ROOT = resolve(import.meta.dir, "../..");
const MAX_PLAN_BYTES = 64 * 1024;

async function readPlan(options) {
  if (!options.plan) return generatePlan(options.seed, options.steps);
  const file = Bun.file(options.plan);
  if (file.size > MAX_PLAN_BYTES) throw new Error("Plan exceeds 64 KiB");
  const text = await file.text();
  if (Buffer.byteLength(text) > MAX_PLAN_BYTES) {
    throw new Error("Plan exceeds 64 KiB");
  }
  return validatePlan(JSON.parse(text));
}

/** Reports cannot overwrite prior evidence or land among tracked project files. */
async function prepareOutput(output) {
  const path = relative(ROOT, output);
  const inRepository = !path.startsWith("..") && !isAbsolute(path);
  if (
    inRepository &&
    !path.startsWith(`artifacts${process.platform === "win32" ? "\\" : "/"}`)
  ) {
    throw new Error(
      "Output inside the repository must be under ignored artifacts/",
    );
  }
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output); // EEXIST deliberately refuses to replace an earlier run.
}

/** One ordinary player in a disposable database; no developer powers during the drive. */
async function seed(database, content) {
  const manifest = await content.map(100000000);
  const account = await database.createAccount({
    name: "playtester",
    passwordHash: await Bun.password.hash("password"),
    role: "player",
  });
  const profile = createProfile({
    mapId: manifest.id,
    ...nearestSavedArrival(manifest, { x: 1540, y: 334, facing: 1 }),
  });
  profile.name = "Playtester";
  profile.settings.BGM.mute = true;
  await database.createCharacter(account.id, profile);
}

async function execute(options, plan, report, signal) {
  const { isolatedOnlineCheck } = await import("./isolated-online-check.js");
  const { runOnlinePlaytest } =
    await import("../../client/tools/scenarios/online-playtest.js");
  await isolatedOnlineCheck({
    seed,
    output: options.output,
    databaseUrl: options.databaseUrl,
    serverPort: options.serverPort,
    clientPort: options.clientPort,
    browserOptions: options.browserOptions,
    signal,
    timings: report.timings,
    onCleanup: () => {
      report.cleanup = {
        status: "complete",
        databaseRemoved: true,
        ownedListenersAndBrowserClosed: true,
      };
    },
    log: (component, event, details) => {
      if (report.serviceEvents.length === 128) report.serviceEvents.shift();
      report.serviceEvents.push({
        at: new Date().toISOString(),
        component,
        event,
        details,
      });
    },
    run: async (fixture) => {
      await runOnlinePlaytest({ ...fixture, plan, signal }, report);
      report.phase = "cleanup";
      return report;
    },
  });
}

export async function runPlaytest(options) {
  const plan = await readPlan(options);
  await prepareOutput(options.output);
  await Bun.write(
    join(options.output, "plan.json"),
    JSON.stringify(plan, null, 2) + "\n",
  );
  const report = {
    schemaVersion: 1,
    status: "running",
    phase: "fixture",
    seed: options.plan ? null : options.seed,
    scope:
      "Henesys beginner: entry, movement, character windows, map chat, reconnect and native Quit/sign-in",
    trace: [],
    pageErrors: [],
    serviceEvents: [],
    timings: {},
    cleanup: { status: "not-confirmed" },
  };
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("Playtest interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    await execute(options, plan, report, controller.signal);
  } catch (error) {
    report.status = "blocked";
    report.infrastructureFailure = {
      phase: report.phase,
      message: String(error.message).replaceAll(
        options.databaseUrl,
        "[database URL]",
      ),
    };
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    await Bun.write(
      join(options.output, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
  }
  return report;
}

if (import.meta.main) {
  try {
    const options = playtestOptions(process.argv.slice(2));
    if (options.help) console.log(HELP);
    else {
      const report = await runPlaytest(options);
      console.log(
        JSON.stringify({
          status: report.status,
          output: options.output,
          actions: report.trace.length,
          failure:
            report.failure?.message ?? report.infrastructureFailure?.message,
        }),
      );
      process.exitCode = { pass: 0, candidate: 1, blocked: 2 }[report.status];
    }
  } catch (error) {
    console.error(`playtest: ${error.message}`);
    process.exitCode = 2;
  }
}
