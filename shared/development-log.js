const MAX_FIELDS = 32;
const MAX_TEXT = 200;
const FIELDS = new Set([
  "phase",
  "method",
  "path",
  "status",
  "code",
  "ms",
  "role",
  "account",
  "character",
  "map",
  "instance",
  "players",
  "mobs",
  "npcs",
  "source",
  "rules",
  "assets",
  "origin",
  "upstream",
  "hostname",
  "port",
  "outputs",
  "modules",
  "sent",
  "received",
  "bytes",
  "reason",
  "operation",
  "action",
  "tick",
  "fieldTick",
  "startedTick",
  "steps",
  "ready",
  "state",
  "inputAgeTicks",
  "heartbeatAgeMs",
  "position",
  "velocity",
  "elapsedMs",
  "deviations",
  "absurd",
  "allowedPosition",
  "allowedVelocity",
]);

/** UTC wall time identifies a log record across processes; elapsed clocks remain monotonic. */
export function logPrefix(scope, timestamp = Date.now()) {
  return `[${new Date(timestamp).toISOString()}] [${scope}]`;
}

/** Bounded process stdout; callers supply scalar metadata, never bodies or credentials. */
export function createDevelopmentLog(scope, options = {}) {
  const {
    enabled = true,
    write = console.log,
    clock = performance.now.bind(performance),
    wallClock = Date.now,
  } = options;
  const started = clock();
  return (event, fields = {}) => {
    if (!enabled) return;
    const entries = Object.entries(fields);
    if (entries.length > MAX_FIELDS) {
      throw new Error("Development log field budget exceeded");
    }
    const safe = {};
    for (const [key, value] of entries) {
      if (!FIELDS.has(key) || value === undefined || value === null) continue;
      if (typeof value === "string") safe[key] = value.slice(0, MAX_TEXT);
      else if (typeof value === "boolean" || Number.isFinite(value)) {
        safe[key] = value;
      }
    }
    write(
      `${logPrefix(`${scope} +${(clock() - started).toFixed(1)}ms`, wallClock())} ${event} ${JSON.stringify(safe)}`,
    );
  };
}

/** Log real startup work at both boundaries, preserving the original failure. */
export async function logStage(log, event, work) {
  const started = performance.now();
  log(event, { phase: "start" });
  try {
    const result = await work();
    log(event, {
      phase: "complete",
      ms: Math.round(performance.now() - started),
    });
    return result;
  } catch (error) {
    log(event, {
      phase: "failed",
      code: error.code ?? error.name,
      ms: Math.round(performance.now() - started),
    });
    throw error;
  }
}
