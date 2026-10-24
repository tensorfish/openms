import { serverConfig } from "./config.js";
import { loadContent } from "./content.js";
import { openDatabase } from "./database.js";
import { OnlineWorld } from "./world.js";
import { SessionAuthority } from "./auth.js";
import { GameplayGateway } from "./gateway.js";
import { OnlineHttp } from "./http.js";
import { createContentService } from "./content-authoring.js";
import { ContentHttp, CONTENT_REQUEST_BYTES } from "./content-http.js";
import { loadWorldContent, WorldActivation } from "./world-content.js";
import { rotateDefaultAccountPasswords } from "./production-accounts.js";
import { createServerLog } from "./logging.js";
import { logStage, logPrefix } from "../../shared/development-log.js";

/** One owned field process; TLS terminates at the configured same-origin reverse proxy. */
export async function startServer(options = {}) {
  const started = performance.now();
  const config = options.config ?? serverConfig();
  const log = options.log ?? createServerLog(config.development);
  const original =
    options.content ??
    (await logStage(log, "content.load", () =>
      loadContent({ root: config.contentRoot }),
    ));
  if (
    config.expectedRulesHash &&
    config.expectedRulesHash !== original.rulesHash
  ) {
    throw new Error("Verified server rules do not match OPENMS_RULES_HASH");
  }
  const database =
    options.database ??
    (await logStage(log, "database.connect-and-check-schema", () =>
      openDatabase({ url: config.databaseUrl, items: original.items }),
    ));
  const auth = new SessionAuthority(config, database);
  const { content, contentHttp, activation } = await prepareServices(
    database,
    original,
    auth,
    config,
  );
  const world = new OnlineWorld({
    content,
    database,
    development: config.development,
    watchdogEnabled: config.watchdogEnabled,
    combatWatchdogEnabled: config.combatWatchdogEnabled,
    log,
    publish: (actor, record) => gateway.publications.publish(actor, record),
  });
  const gateway = new GameplayGateway({ config, auth, database, world });
  activation.bind(world, gateway);
  const http = new OnlineHttp({
    config,
    content,
    auth,
    gateway,
    log,
    contentHttp,
  });
  const server = await listen({ config, http, gateway, database });
  const lifecycle = createLifecycle({ server, world, gateway, database, log });
  logReady(log, { config, content, server, started });
  return {
    server,
    world,
    gateway,
    auth,
    database,
    content,
    config,
    close: lifecycle.close,
  };
}

function logReady(log, { config, content, server, started }) {
  log("listener.ready", {
    origin: config.origin,
    hostname: config.hostname,
    port: server.port,
  });
  console.log(
    logPrefix("server"),
    `openms.dev authoritative server ready at ${server.url} (${(performance.now() - started).toFixed(1)}ms)`,
  );
  console.log(
    logPrefix("server"),
    `Rules ${content.rulesHash}; assets ${content.assetBuildId}; ${config.development ? "development" : "production"}; motion watchdog ${config.watchdogEnabled ? "enabled" : "disabled"}; combat watchdog ${config.combatWatchdogEnabled ? "enabled" : "disabled"}`,
  );
}

/** Persist startup account/content changes before exposing any HTTP or game session. */
async function prepareServices(database, original, auth, config) {
  try {
    if (!config.development) await rotateDefaultAccountPasswords(database);
    const service = createContentService(database, original);
    await service.initialize(original.catalog);
    const content = await loadWorldContent(database, original);
    const activation = new WorldActivation({ database, content, service });
    return {
      content,
      activation,
      contentHttp: new ContentHttp({ service, auth, activation }),
    };
  } catch (error) {
    await database.close();
    throw error;
  }
}

async function listen({ config, http, gateway, database }) {
  try {
    return Bun.serve({
      hostname: config.hostname,
      port: config.port,
      maxRequestBodySize: CONTENT_REQUEST_BYTES,
      idleTimeout: 10,
      fetch: http.fetch.bind(http),
      websocket: gateway.handlers,
    });
  } catch (error) {
    await database.close();
    throw error;
  }
}

export function createLifecycle({ server, world, gateway, database, log }) {
  let stopped = false;
  let closing = null;
  const timer = setInterval(tick, 10);
  function tick() {
    if (stopped) return;
    try {
      world.step(performance.now());
      gateway.maintain(Date.now());
    } catch (error) {
      stopped = true;
      clearInterval(timer);
      console.error(
        logPrefix("server"),
        "Authoritative simulation suspended:",
        error.stack ?? error.message,
      );
      log("simulation.suspended", { code: error.code ?? error.name });
      close().catch((failure) => {
        console.error(
          logPrefix("server"),
          "Server shutdown failed:",
          failure.message,
        );
      });
    }
  }
  async function finish() {
    log("shutdown", { phase: "start" });
    stopped = true;
    clearInterval(timer);
    const failure = await closeResources({
      server,
      gateway,
      world,
      database,
    });
    log("shutdown", { phase: "complete" });
    if (failure) throw failure;
  }
  function close() {
    closing ??= finish();
    return closing;
  }
  return { close, tick };
}

async function closeResources({ server, gateway, world, database }) {
  // Fence admission synchronously and retain gateway cleanup while stopping the
  // listener. Attach its error handler before either owner can finish shutdown.
  const gatewayClosing = gateway.close().then(
    () => null,
    (error) => error,
  );
  let failure;
  try {
    await server.stop(true);
  } catch (error) {
    failure = error;
  }
  const gatewayFailure = await gatewayClosing;
  failure ??= gatewayFailure;
  try {
    await world.close();
  } catch (error) {
    failure ??= error;
  }
  try {
    await database.close();
  } catch (error) {
    failure ??= error;
  }
  return failure;
}

if (import.meta.main) {
  const runtime = await startServer();
  async function shutdown() {
    try {
      await runtime.close();
    } catch (error) {
      console.error(
        logPrefix("server"),
        "Server shutdown failed:",
        error.message,
      );
      process.exitCode = 1;
    }
  }
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
