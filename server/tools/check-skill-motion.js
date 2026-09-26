import { join } from "node:path";
import { parseFlags } from "../../client/tools/source-options.js";
import { createProfile } from "../../client/src/profile/profile-validation.js";
import { isolatedOnlineCheck } from "./isolated-online-check.js";
import { runSkillMotion } from "../../client/tools/scenarios/online-skill-motion.js";
import { runWalkMotion } from "../../client/tools/scenarios/online-walk-motion.js";
import { DelayedTraffic } from "../../client/tools/scenarios/delayed-traffic.js";

/** Disposable learned Flash Jump fixture; all casts use the native keyboard. */
async function seed(database, scope) {
  const account = await database.createAccount({
    name: "motion",
    passwordHash: await Bun.password.hash("password"),
    role: "player",
  });
  const profile = createProfile({
    mapId: "100000000",
    x: scope === "skills" ? 0 : 80,
    y: scope === "skills" ? 0 : 274,
    facing: 1,
  });
  profile.name = "Motion";
  profile.job = 411;
  profile.level = 100;
  profile.maxMP = 1000;
  profile.baseMaxMP = 1000;
  profile.mp = 1000;
  profile.skills[4111006] = { level: 20, masterLevel: 0, expiresAt: null };
  profile.skills[4111005] = { level: 5, masterLevel: 0, expiresAt: null };
  profile.keyBindings.keys[32] = { type: 1, id: 4111006 };
  profile.keyBindings.keys[57] = { type: 5, id: 53 };
  await database.createCharacter(account.id, profile);
}

if (import.meta.main) {
  const flags = parseFlags(process.argv.slice(2), {
    output: { type: "string" },
    help: { type: "boolean" },
    scope: { type: "string" },
    "round-trip-ms": { type: "string" },
    baseline: { type: "boolean" },
  });
  if (flags.help) {
    console.log(
      "bun server/tools/check-skill-motion.js [--output DIR] [--scope skills|walk|landing] [--round-trip-ms 0..2000] [--baseline]",
    );
  } else {
    const scope = flags.scope ?? "skills";
    const roundTripMs = Number(flags["round-trip-ms"] ?? 0);
    if (!["skills", "walk", "landing"].includes(scope)) {
      throw new Error("Unknown motion scope");
    }
    if (
      !Number.isInteger(roundTripMs) ||
      roundTripMs < 0 ||
      roundTripMs > 2000
    ) {
      throw new Error("Invalid round-trip latency");
    }
    const timings = {};
    const output = flags.output ?? "/tmp/openms-skill-motion";
    const report = await isolatedOnlineCheck({
      seed: (database) => seed(database, scope),
      run: (options) =>
        scope !== "skills"
          ? runWalkMotion({
              ...options,
              scope,
              roundTripMs,
              baseline: Boolean(flags.baseline),
            })
          : runSkillMotion(options),
      network: new DelayedTraffic(roundTripMs),
      timings,
      output,
    });
    report.fixtureTimings = timings;
    await Bun.write(
      join(output, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(
      JSON.stringify({
        status: report.status,
        analysis: report.analysis,
        failure: report.failure,
      }),
    );
    process.exitCode = report.status === "pass" ? 0 : 1;
  }
}
