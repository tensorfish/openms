import { expect, test } from "bun:test";
import { OnlineProxy } from "../tools/dev-online.js";
import { PROTOCOL } from "../../shared/protocol.js";

const CLOSE_TEST_TIMEOUT_MS = 5000;

function waitForEvent(target, name) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      target.removeEventListener(name, handleEvent);
      reject(new Error(`Timed out waiting for WebSocket ${name}`));
    }, CLOSE_TEST_TIMEOUT_MS);
    function handleEvent(event) {
      clearTimeout(timer);
      target.removeEventListener(name, handleEvent);
      resolve(event);
    }
    target.addEventListener(name, handleEvent, { once: true });
  });
}

function waitWithin(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Timed out waiting for ${label}`)),
        CLOSE_TEST_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

function relayFixture() {
  const records = [];
  const proxy = new OnlineProxy({}, null, (event, fields) =>
    records.push({ event, fields }),
  );
  const clientCloses = [];
  const upstreamCloses = [];
  const relay = {
    client: { close: (...args) => clientCloses.push(args) },
    upstream: { close: (...args) => upstreamCloses.push(args) },
    pending: [],
    closed: false,
    timer: null,
    sent: 0,
    received: 0,
  };
  proxy.relays.add(relay);
  return { proxy, relay, records, clientCloses, upstreamCloses };
}

test("browser close code and reason are forwarded to upstream", () => {
  const { proxy, relay, records, clientCloses, upstreamCloses } =
    relayFixture();
  proxy.close({ data: relay }, 1000, "USER_LOGOUT");

  expect(upstreamCloses).toEqual([[1000, "USER_LOGOUT"]]);
  expect(clientCloses).toEqual([]);
  expect(relay.closed).toBe(true);
  expect(proxy.relays.size).toBe(0);
  expect(records[0].fields).toMatchObject({
    code: 1000,
    reason: "BROWSER_CLOSED",
    source: "browser",
  });
});

test("upstream close reaches browser with bounded UTF-8 reason", () => {
  const { proxy, relay, records, clientCloses, upstreamCloses } =
    relayFixture();
  proxy.upstreamClosed(relay, {
    code: 1012,
    reason: `${"🙂".repeat(40)}TOKEN=hidden`,
  });

  expect(clientCloses).toHaveLength(1);
  expect(clientCloses[0][0]).toBe(1012);
  expect(
    new TextEncoder().encode(clientCloses[0][1]).byteLength,
  ).toBeLessThanOrEqual(123);
  expect(clientCloses[0][1]).not.toContain("TOKEN");
  expect(upstreamCloses).toEqual([]);
  expect(records[0].fields).toMatchObject({
    code: 1012,
    reason: "UPSTREAM_CLOSED",
    source: "upstream",
  });
  expect(JSON.stringify(records)).not.toContain("TOKEN");
});

test("reserved close codes are mapped to a valid relay failure code", () => {
  const { proxy, relay, clientCloses, upstreamCloses } = relayFixture();
  proxy.close({ data: relay }, 1006, "transport lost");

  expect(upstreamCloses).toEqual([[1011, "BROWSER_CLOSED"]]);
  expect(clientCloses).toEqual([]);
});

function loopbackUpstream() {
  const closeWaiters = [];
  let upstreamOpenCount = 0;
  let signalFirstOpen;
  const firstOpen = new Promise((resolve) => {
    signalFirstOpen = resolve;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (
        new URL(request.url).pathname !== "/api/v1/play" ||
        request.headers.get("sec-websocket-protocol") !== PROTOCOL.SUBPROTOCOL
      ) {
        return new Response("Forbidden", { status: 403 });
      }
      if (
        server.upgrade(request, {
          headers: { "Sec-WebSocket-Protocol": PROTOCOL.SUBPROTOCOL },
        })
      ) {
        return;
      }
      return new Response("Upgrade refused", { status: 400 });
    },
    websocket: {
      open(socket) {
        upstreamOpenCount++;
        if (upstreamOpenCount === 1) signalFirstOpen();
        else setTimeout(() => socket.close(1012, "RESYNC_REQUIRED"), 0);
      },
      close(_socket, code, reason) {
        const resolve = closeWaiters.shift();
        resolve?.({ code, reason });
      },
    },
  });
  return {
    server,
    firstOpen,
    waitForClose() {
      return new Promise((resolve) => {
        closeWaiters.push(resolve);
      });
    },
  };
}

function loopbackProxy(upstream, logs) {
  const proxy = new OnlineProxy(
    { upstream: `http://127.0.0.1:${upstream.port}` },
    null,
    (event, fields) => logs.push({ event, fields }),
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: proxy.fetch.bind(proxy),
    websocket: proxy.handlers,
  });
  return { proxy, server };
}

function loopbackClient(server, clients) {
  const origin = `http://127.0.0.1:${server.port}`;
  const client = new WebSocket(`ws://127.0.0.1:${server.port}/api/v1/play`, {
    protocols: [PROTOCOL.SUBPROTOCOL],
    headers: { Origin: origin },
  });
  clients.push(client);
  return client;
}

test("Bun loopback relay preserves close code and reason end to end", async () => {
  const upstream = loopbackUpstream();
  const proxyLogs = [];
  const { server: proxyServer } = loopbackProxy(upstream.server, proxyLogs);
  const clients = [];

  try {
    const firstClient = loopbackClient(proxyServer, clients);
    await waitForEvent(firstClient, "open");
    await upstream.firstOpen;
    const firstUpstreamClose = upstream.waitForClose();
    firstClient.close(1000, "STALE_FIELD");
    await expect(
      waitWithin(firstUpstreamClose, "upstream close"),
    ).resolves.toEqual({
      code: 1000,
      reason: "STALE_FIELD",
    });

    const secondClient = loopbackClient(proxyServer, clients);
    await waitForEvent(secondClient, "open");
    const secondClientClose = await waitWithin(
      waitForEvent(secondClient, "close"),
      "client close",
    );
    expect(secondClientClose.code).toBe(1012);
    expect(secondClientClose.reason).toBe("RESYNC_REQUIRED");
    const closeLogs = proxyLogs.filter(
      ({ event }) => event === "socket.closed",
    );
    expect(closeLogs.map(({ fields }) => fields.reason)).toContain(
      "STALE_FIELD",
    );
    expect(closeLogs.map(({ fields }) => fields.reason)).toContain(
      "RESYNC_REQUIRED",
    );
  } finally {
    for (const client of clients) {
      if (client.readyState < WebSocket.CLOSING) client.close();
    }
    await waitWithin(
      Promise.all([proxyServer.stop(true), upstream.server.stop(true)]),
      "fixture server shutdown",
    );
  }
});
