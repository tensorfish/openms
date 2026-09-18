import { resolve } from "node:path";
import { parseFlags } from "../../client/tools/source-options.js";

const ROOT = resolve(import.meta.dir, "../..");
export const HELP = `Usage: bun run playtest [--seed N] [--steps N] [--plan FILE] [--output DIR]
  [--chrome PATH] [--headed] [--database-url URL] [--server-port N] [--client-port N]
Defaults: seed=1; steps=12 (4..32); output=artifacts/playtest/<unique run>;
database-url=postgres://openms:openms_local_only@127.0.0.1:55432/openms;
server-port=3297; client-port=3197. Pass --chrome outside the macOS default.
--plan replays a version-1 data-only action file; cannot combine with --seed/--steps.
Owns a disposable database and browser. Reuses converted assets. Run serially per checkout.
Reports pass, candidate or blocked; exit codes 0, 1 or 2. No issue is posted automatically.`;

function integer(value, name, min, max) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    throw new Error(`--${name} must be an integer in ${min}..${max}`);
  }
  return result;
}

export function playtestOptions(args) {
  const values = parseFlags(args, {
    seed: { type: "string" },
    steps: { type: "string" },
    plan: { type: "string" },
    output: { type: "string" },
    chrome: { type: "string" },
    headed: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
    "database-url": {
      type: "string",
      default: "postgres://openms:openms_local_only@127.0.0.1:55432/openms",
    },
    "server-port": { type: "string", default: "3297" },
    "client-port": { type: "string", default: "3197" },
  });
  if (values.help) return { help: true };
  if (values.plan && (values.seed || values.steps)) {
    throw new Error("--plan cannot be combined with --seed or --steps");
  }
  const database = localDatabase(values["database-url"]);
  const serverPort = integer(values["server-port"], "server-port", 1, 65535);
  const clientPort = integer(values["client-port"], "client-port", 1, 65535);
  if (serverPort === clientPort) {
    throw new Error("Server and client ports must differ");
  }
  return resolvedOptions(values, { database, serverPort, clientPort });
}

function localDatabase(value) {
  const database = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(database.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(database.hostname) ||
    database.pathname.length < 2
  ) {
    throw new Error(
      "--database-url must name a local PostgreSQL database with CREATE DATABASE permission",
    );
  }
  return database;
}

function resolvedOptions(values, { database, serverPort, clientPort }) {
  return {
    seed: integer(values.seed ?? "1", "seed", 1, 0xffffffff),
    steps: integer(values.steps ?? "12", "steps", 4, 32),
    plan: values.plan ? resolve(values.plan) : null,
    output: resolve(
      values.output ?? resolve(ROOT, "artifacts/playtest", crypto.randomUUID()),
    ),
    browserOptions: {
      ...(values.chrome ? { chrome: resolve(values.chrome) } : {}),
      headed: values.headed,
    },
    databaseUrl: database.href,
    serverPort,
    clientPort,
  };
}
