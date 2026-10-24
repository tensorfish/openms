import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOnlineBrowser } from "./browser-build.js";
import { PROTOCOL } from "../../shared/protocol.js";
import { createStaticResources } from "./static-resources.js";
import { clientEnvironment } from "./environment.js";
import {
  createDevelopmentLog,
  logStage,
  logPrefix,
} from "../../shared/development-log.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_BACKLOG = 1024 * 1024;
const MAX_PENDING_FRAMES = 8;
const MAX_RELAYS = 128;
const MAX_CLOSE_REASON_BYTES = 123;
const CLOSE_CODE_FORBIDDEN = new Set([1004, 1005, 1006]);
const SAFE_CLOSE_REASONS = new Set([
  "CLIENT_ERROR",
  "CONNECTION_LOST",
  "HEARTBEAT_TIMEOUT",
  "NOT_ALLOWED",
  "PROTOCOL_ERROR",
  "RESYNC_REQUIRED",
  "SERVER_BUSY",
  "SESSION_EXPIRED",
  "SESSION_REPLACED",
  "SIGNED_OUT",
  "STALE_CONNECTION",
  "STALE_FIELD",
  "TRANSITION_FAILED",
  "UNAUTHENTICATED",
  "INVALID_MESSAGE",
]);

function validCloseCode(code) {
  return (
    Number.isInteger(code) &&
    ((code >= 1000 && code <= 1014 && !CLOSE_CODE_FORBIDDEN.has(code)) ||
      (code >= 3000 && code <= 4999))
  );
}

function boundedCloseReason(reason) {
  if (typeof reason !== "string") return "";
  const encoder = new TextEncoder();
  let result = "";
  let bytes = 0;
  for (const character of reason) {
    const point = character.codePointAt(0);
    if (point < 32 || point === 127) continue;
    const size = encoder.encode(character).byteLength;
    if (bytes + size > MAX_CLOSE_REASON_BYTES) break;
    result += character;
    bytes += size;
  }
  return result;
}

function safeCloseReason(reason, source) {
  if (SAFE_CLOSE_REASONS.has(reason)) return reason;
  if (source === "browser") return "BROWSER_CLOSED";
  if (source === "upstream") return "UPSTREAM_CLOSED";
  return "RELAY_STOPPED";
}

function closeDetails(code, reason, source) {
  if (!validCloseCode(code)) {
    const fallback =
      source === "upstream"
        ? "UPSTREAM_CLOSED"
        : source === "browser"
          ? "BROWSER_CLOSED"
          : "RELAY_STOPPED";
    return { code: 1011, reason: fallback };
  }
  const bounded = boundedCloseReason(reason);
  return {
    code,
    reason: bounded || (source === "relay" ? "Online connection closed" : ""),
  };
}

function configuration(options) {
  const hostname =
    options.hostname ?? clientEnvironment.ONLINE_HOST ?? "127.0.0.1";
  if (typeof hostname !== "string" || !hostname.trim()) {
    throw new Error("ONLINE_HOST must be a non-empty hostname or IP address");
  }
  const port = Number(options.port ?? clientEnvironment.ONLINE_PORT ?? 3102);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("ONLINE_PORT must be in 1..65535");
  }
  const upstream = upstreamOrigin(
    options.upstream ??
      clientEnvironment.OPENMS_SERVER_URL ??
      "http://127.0.0.1:3200",
  );
  return { hostname, port, upstream, production: options.production === true };
}

function upstreamOrigin(value) {
  const upstream = new URL(value);
  if (
    upstream.protocol !== "http:" ||
    upstream.pathname !== "/" ||
    upstream.search ||
    upstream.hash ||
    upstream.username ||
    upstream.password
  ) {
    throw new Error("Development API upstream must be an exact HTTP origin");
  }
  return upstream.origin;
}

/** Same-origin relay changes transport routing only; the upstream remains sole authority. */
export class OnlineProxy {
  constructor(config, resources, log, network = null) {
    this.network = network;
    this.resources = resources;
    this.config = config;
    this.log = log;
    this.relays = new Set();
    this.handlers = {
      maxPayloadLength: PROTOCOL.MAX_MESSAGE_BYTES,
      backpressureLimit: MAX_BACKLOG,
      closeOnBackpressureLimit: true,
      idleTimeout: 35,
      perMessageDeflate: false,
      open: this.open.bind(this),
      message: this.message.bind(this),
      close: this.close.bind(this),
    };
  }

  async fetch(request, server) {
    const started = performance.now();
    const path = new URL(request.url).pathname;
    const response = await this.handle(request, server);
    if (
      path.startsWith("/api/") ||
      path === "/" ||
      path === "/generated/catalog.json" ||
      path.startsWith("/generated/maps/") ||
      response?.status >= 400
    ) {
      this.log("http", {
        method: request.method,
        path,
        status: response?.status ?? 101,
        ms: Math.round(performance.now() - started),
      });
    }
    return response;
  }

  async handle(request, server) {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/api/v1/play") return this.upgrade(request, server);
      await this.network?.http();
      if (url.pathname.startsWith("/api/")) {
        const upstream = new URL(
          url.pathname + url.search,
          this.config.upstream,
        );
        const headers = new Headers(request.headers);
        headers.delete("host");
        return await fetch(upstream, {
          method: request.method,
          headers,
          body: ["GET", "HEAD"].includes(request.method)
            ? undefined
            : request.body,
          redirect: "manual",
          signal: AbortSignal.timeout(15_000),
        });
      }
      return await this.resources.fetch(request);
    } catch (error) {
      this.log("upstream.error", {
        code: error.code ?? error.name,
        upstream: this.config.upstream,
      });
      console.error(
        logPrefix("client"),
        "Online client request failed:",
        error.message,
      );
      return Response.json(
        { code: "SERVER_BUSY" },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  upgrade(request, server) {
    if (this.relays.size >= MAX_RELAYS) {
      return new Response("Busy", { status: 503 });
    }
    const origin = request.headers.get("origin");
    const requestUrl = new URL(request.url);
    if (
      requestUrl.protocol !== "http:" ||
      !this.acceptsOrigin(origin, requestUrl) ||
      requestUrl.search ||
      request.headers.get("sec-websocket-protocol") !== PROTOCOL.SUBPROTOCOL
    ) {
      return new Response("Forbidden", { status: 403 });
    }
    const cookie = request.headers.get("cookie") ?? "";
    if (cookie.length > 4096) {
      return new Response("Invalid cookie", { status: 400 });
    }
    const relay = {
      client: null,
      upstream: null,
      pending: [],
      closed: false,
      timer: null,
      sent: 0,
      received: 0,
    };
    const url = this.config.upstream.replace(/^http:/, "ws:") + "/api/v1/play";
    relay.upstream = new WebSocket(url, {
      protocols: [PROTOCOL.SUBPROTOCOL],
      headers: { Origin: origin, Cookie: cookie },
    });
    relay.upstream.binaryType = "arraybuffer";
    relay.upstream.onopen = () => this.flush(relay);
    relay.upstream.onmessage = (event) => this.receive(relay, event.data);
    relay.upstream.onclose = (event) => this.upstreamClosed(relay, event);
    relay.upstream.onerror = () => this.upstreamError(relay);
    relay.timer = setTimeout(
      () => this.stop(relay, { operation: "upstream timeout" }),
      5000,
    );
    this.relays.add(relay);
    if (
      server.upgrade(request, {
        data: relay,
        headers: { "Sec-WebSocket-Protocol": PROTOCOL.SUBPROTOCOL },
      })
    ) {
      return;
    }
    this.stop(relay);
    return new Response("Upgrade refused", { status: 400 });
  }

  /** TLS termination must preserve the public Host; backend admission still checks Origin. */
  acceptsOrigin(origin, requestUrl) {
    return (
      origin === requestUrl.origin ||
      (this.config.production && origin === `https://${requestUrl.host}`)
    );
  }

  upstreamClosed(relay, event) {
    this.stop(relay, {
      operation: "upstream closed",
      code: event.code,
      reason: event.reason,
      source: "upstream",
    });
  }

  upstreamError(relay) {
    this.stop(relay, {
      operation: "upstream error",
      reason: "UPSTREAM_ERROR",
      source: "upstream",
    });
  }

  open(socket) {
    socket.data.client = socket;
    this.log("socket.open", { upstream: this.config.upstream });
    if (socket.data.closed) socket.close(1011, "Upstream unavailable");
  }

  message(socket, data) {
    const relay = socket.data;
    relay.sent++;
    if (relay.closed || typeof data !== "string") return this.stop(relay);
    if (this.network) {
      this.network.enqueue(relay, "up", data, () =>
        this.sendUpstream(relay, data),
      );
    } else this.sendUpstream(relay, data);
  }

  sendUpstream(relay, data) {
    if (relay.closed) return;
    if (relay.upstream.bufferedAmount > MAX_BACKLOG) return this.stop(relay);
    if (relay.upstream.readyState === WebSocket.OPEN) relay.upstream.send(data);
    else if (relay.pending.length < MAX_PENDING_FRAMES) {
      relay.pending.push(data);
    } else this.stop(relay);
  }

  flush(relay) {
    clearTimeout(relay.timer);
    if (relay.closed) return;
    this.log("socket.upstream-ready", { upstream: this.config.upstream });
    for (const frame of relay.pending) relay.upstream.send(frame);
    relay.pending.length = 0;
  }

  receive(relay, data) {
    relay.received++;
    if (
      relay.closed ||
      !relay.client ||
      typeof data !== "string" ||
      Buffer.byteLength(data) > 64 * 1024
    ) {
      return this.stop(relay);
    }
    if (this.network) {
      this.network.enqueue(relay, "down", data, () =>
        this.sendDownstream(relay, data),
      );
    } else this.sendDownstream(relay, data);
  }

  sendDownstream(relay, data) {
    if (relay.closed) return;
    if (relay.client.getBufferedAmount() > MAX_BACKLOG) return this.stop(relay);
    if (relay.client.send(data) === 0) this.stop(relay);
  }

  closePeers(relay, details, source) {
    if (source !== "browser") {
      relay.client?.close(details.code, details.reason);
    }
    if (source === "upstream") return;
    if (source === "browser") {
      relay.upstream?.close(details.code, details.reason);
    } else relay.upstream?.close();
  }

  stop(relay, options = {}) {
    if (relay.closed) return;
    const { operation, code = 1011, reason = "", source = "relay" } = options;
    const details = closeDetails(code, reason, source);
    relay.closed = true;
    this.log("socket.closed", {
      operation,
      reason: safeCloseReason(reason, source),
      code: details.code,
      source,
      sent: relay.sent,
      received: relay.received,
    });
    clearTimeout(relay.timer);
    this.network?.close(relay);
    this.closePeers(relay, details, source);
    relay.pending.length = 0;
    this.relays.delete(relay);
  }

  close(socket, code, reason) {
    this.stop(socket.data, {
      operation: "browser closed",
      code,
      reason,
      source: "browser",
    });
  }
}

export async function startOnlineDevServer(options = {}) {
  const config = configuration(options);
  const started = performance.now();
  const log = options.log ?? createDevelopmentLog("client");
  log(config.production ? "production.start" : "development.start", config);
  const identity = await logStage(log, "browser.build", () =>
    buildOnlineBrowser({
      development: !config.production,
      progress:
        options.progress ??
        ((message) => console.log(logPrefix("client"), message)),
    }),
  );
  const resources = createStaticResources({
    root: ROOT,
    html: identity.html,
    siteRoot: identity.deployment?.directory,
  });
  log("browser.identity", {
    source: identity.sourceBuildId,
    rules: identity.rulesHash,
    assets: identity.assetBuildId,
    outputs: identity.outputs?.length,
  });
  const proxy = new OnlineProxy(config, resources, log, options.network);
  const server = Bun.serve({
    hostname: config.hostname,
    port: config.port,
    maxRequestBodySize: 16 * 1024,
    fetch: proxy.fetch.bind(proxy),
    websocket: proxy.handlers,
  });
  console.log(
    logPrefix("client"),
    `openms.dev online client ready at ${server.url} (${(performance.now() - started).toFixed(1)}ms); ${config.production ? "production, no sidebar" : "development"}; API ${config.upstream}`,
  );
  return {
    server,
    identity,
    disconnect() {
      for (const relay of proxy.relays) {
        proxy.stop(relay, { operation: "fixture disconnect" });
      }
    },
    close() {
      log("shutdown", { phase: "start" });
      for (const relay of proxy.relays) proxy.stop(relay);
      server.stop(true);
      log("shutdown", { phase: "complete" });
    },
  };
}

if (import.meta.main) {
  const runtime = await startOnlineDevServer();
  process.once("SIGINT", runtime.close);
  process.once("SIGTERM", runtime.close);
}
