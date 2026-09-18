import { migrateDatabase } from "../../tools/migrate.js";
import { SQL } from "bun";
import { acquireBrowser } from "../../client/tools/browser-acquisition.js";
import { loadEnvironment } from "../../shared/environment.js";
import { serverConfig } from "../src/config.js";
import { loadContent } from "../src/content.js";
import { openDatabase } from "../src/database.js";
import { startServer } from "../src/index.js";
import { startOnlineDevServer } from "../../client/tools/dev-online.js";
import { startStudioServer } from "../../studio/tools/dev.js";
import { measureStage } from "../../client/tools/native-evidence.js";

/** Disposable database and listeners; never reset the configured development database. */
export async function isolatedOnlineCheck(options) {
  const settings = {
    studio: false,
    productionClient: false,
    network: null,
    timings: {},
    databaseUrl: null,
    serverPort: 3297,
    clientPort: 3197,
    browserOptions: {},
    signal: null,
    log: null,
    onCleanup: null,
    ...options,
  };
  checkPorts(settings.serverPort, settings.clientPort, settings.studio);
  const environment = { ...loadEnvironment("server") };
  if (settings.databaseUrl !== null) {
    environment.DATABASE_URL = settings.databaseUrl;
  }
  const owner = createOwner(environment.DATABASE_URL);
  const name = owner.name;
  try {
    await owner.admin.unsafe(`CREATE DATABASE "${name}"`);
    owner.created = true;
    const config = fixtureConfig(environment, name, settings);
    const content = await startFixture(owner, config, settings);
    const restart = async () => {
      await owner.runtime.close();
      owner.runtime = await startServer({
        config,
        content,
        log: fixtureLog(settings, "server"),
      });
    };
    return await settings.run({
      browser: owner.browser,
      url: config.origin,
      studioUrl: config.studioOrigin,
      output: settings.output,
      restart,
      network: settings.network,
      disconnect: () => owner.client.disconnect(),
      fixture: {
        database: name,
        serverPort: settings.serverPort,
        clientPort: settings.clientPort,
      },
    });
  } finally {
    await measureStage(settings.timings, "fixtureTeardown", () =>
      release(owner),
    );
    settings.onCleanup?.();
  }
}

function createOwner(databaseUrl) {
  return {
    admin: new SQL(databaseUrl, { max: 1, connectionTimeout: 10 }),
    name: `openms_check_${crypto.randomUUID().replaceAll("-", "")}`,
    created: false,
    runtime: null,
    client: null,
    studio: null,
    browser: null,
    database: null,
  };
}

async function startFixture(owner, config, settings) {
  const { timings, signal } = settings;
  signal?.throwIfAborted();
  const { content, database } = await measureStage(
    timings,
    "databaseAndContent",
    () => prepareDatabase(config.databaseUrl),
  );
  owner.database = database;
  await measureStage(timings, "seed", () => settings.seed(database, content));
  signal?.throwIfAborted();
  owner.runtime = await measureStage(timings, "serverStartup", () =>
    startServer({
      config,
      content,
      database,
      log: fixtureLog(settings, "server"),
    }),
  );
  await measureStage(timings, "frontendStartup", () =>
    startFrontends(owner, config, settings),
  );
  signal?.throwIfAborted();
  owner.browser = await measureStage(timings, "browserAcquisition", () =>
    launchBrowser(settings.browserOptions),
  );
  signal?.throwIfAborted();
  return content;
}

function checkPorts(serverPort, clientPort, studio) {
  const ports = studio
    ? [serverPort, clientPort, 3198]
    : [serverPort, clientPort];
  if (
    new Set(ports).size !== ports.length ||
    ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)
  ) {
    throw new Error("Isolated listeners require distinct ports in 1..65535");
  }
}

function fixtureConfig(environment, name, { studio, serverPort, clientPort }) {
  const url = new URL(environment.DATABASE_URL);
  url.pathname = `/${name}`;
  return serverConfig({
    ...environment,
    DATABASE_URL: url.href,
    OPENMS_MODE: "development",
    OPENMS_HOST: "127.0.0.1",
    OPENMS_PORT: String(serverPort),
    OPENMS_ORIGIN: `http://127.0.0.1:${clientPort}`,
    OPENMS_STUDIO_ORIGIN: studio ? "http://127.0.0.1:3198" : "",
  });
}

async function prepareDatabase(url) {
  await migrateDatabase({ databaseUrl: url });
  const content = await loadContent();
  const database = await openDatabase({ url, items: content.items });
  return { content, database };
}

function fixtureLog(settings, component) {
  return settings.log ? settings.log.bind(null, component) : undefined;
}

async function startFrontends(owner, config, settings) {
  owner.client = await startOnlineDevServer({
    hostname: "127.0.0.1",
    port: Number(new URL(config.origin).port),
    upstream: `http://127.0.0.1:${config.port}`,
    production: settings.productionClient,
    network: settings.network,
    log: fixtureLog(settings, "client"),
  });
  if (config.studioOrigin) {
    owner.studio = await startStudioServer({
      hostname: "127.0.0.1",
      port: 3198,
      upstream: `http://127.0.0.1:${config.port}`,
      clientUrl: config.origin,
      contentRoot: config.contentRoot,
    });
  }
}

async function release(owner) {
  const results = await Promise.allSettled([
    closeResource("browser", () => owner.browser?.close()),
    closeResource("client", () => owner.client?.close()),
    closeResource("studio", () => owner.studio?.close()),
    closeResource(
      "runtime",
      () => (owner.runtime ? owner.runtime.close() : owner.database?.close()),
      () => ({
        worldClosed: owner.runtime?.world.closed,
        pendingRequests: owner.runtime?.server.pendingRequests,
        pendingWebSockets: owner.runtime?.server.pendingWebSockets,
      }),
    ),
  ]);
  try {
    if (owner.created) {
      await owner.admin.unsafe(`DROP DATABASE "${owner.name}" WITH (FORCE)`);
    }
  } finally {
    await owner.admin.close();
  }
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}

/** A failed fixture must still drop its disposable database and exit within a bound. */
async function closeResource(label, close, diagnostic = () => null) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `Online fixture ${label} cleanup timed out: ${JSON.stringify(diagnostic())}`,
        ),
      );
    }, 10000);
  });
  try {
    await Promise.race([close(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function launchBrowser(options) {
  if (options.browser || options.browserWSEndpoint) {
    throw new Error(
      "The isolated fixture must own its browser; pass chrome/headed options only",
    );
  }
  return (await acquireBrowser(options)).browser;
}
