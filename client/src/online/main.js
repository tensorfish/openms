import { Application } from "pixi.js";
import { logPrefix } from "../../../shared/development-log.js";
import { Network } from "../rendering/stream-network.js";
import { AtlasStore } from "../rendering/stream-atlas.js";
import {
  initializeBrowserSurface,
  resizeBrowserSurface,
} from "../rendering/browser-surface.js";
import {
  catalog as validateCatalog,
  manifest as validateManifest,
  finite,
  LIMITS,
} from "../rendering/stream-validation.js";
import { createSimulation, snapshotSimulation } from "../physics/simulation.js";
import { createPlayerInput } from "../input/player-input.js";
import { createPlayerActions } from "../input/player-actions.js";
import { createDebugOverlay } from "../development/debug-overlay.js";
import { HitboxInspector } from "../development/hitbox-inspector.js";
import { OnlineTransport } from "./transport.js";
import { OnlinePrediction } from "./prediction.js";
import { OnlineScene } from "./scene.js";
import { OnlineUI } from "./ui.js";
import { OnlineInspection } from "./inspection.js";
import { OnlineLogin } from "./login.js";
import {
  OnlineLoading,
  STARTUP_CONNECTION_FAILURE_MESSAGE,
} from "./loading.js";
import { prepareLoginStartup } from "./login-startup.js";
import { preloadStartupAssets } from "./startup-preload.js";
import { prepareStartupPack } from "./startup-pack.js";
import { setProjectPing } from "../browser/project-ping.js";
import { NativeOperationRefusal } from "./native-source.js";
import { portalEntryContains } from "../world/portal-presentation.js";
import { applyWorldContent } from "../../../shared/world-content.js";
import { CommunityMaps } from "./community-maps.js";
import { RegionDownloads } from "./region-downloads.js";

const app = new Application();
const controller = new AbortController();
const viewport = document.querySelector("#viewport");
const loading = new OnlineLoading(viewport, controller.signal);
const network = new Network(undefined, loading);
const services = { network, atlases: null };
const hitboxInspector = new HitboxInspector(network);
const neutral = Object.freeze({
  left: false,
  right: false,
  up: false,
  down: false,
  jump: false,
  attack: false,
});
let catalog = null;
let startupPreload = null;
let regionDownloads = null;
let communityMaps = null;
let current = null;
let ui = null;
let login = null;
let inspection = null;
let input = null;
let boundBindings = null;
let actions = null;
let overlay = null;
let observer = null;
let previousTime = 0;
let frame = 0;
let clock = null;
let demand = null;
let inspectionTimer = null;
let generation = 0;
let installing = false;
let refreshing = false;
let releasePending = false;
let destroyed = false;
let debug = false;
let lastError = null;
const transport = new OnlineTransport({
  onSnapshot: install,
  onState: state,
  onMotion: motion,
  onClearInput: clearInput,
  onPeers: peers,
  onTiming: timing,
  onEvent: event,
  onTransition: transition,
  onStatus: status,
  onCommand: recordCommand,
  onPresentationError: report,
  onTransportError: report,
});
const prediction = new OnlinePrediction({
  onInput: sendInput,
  onResync: resync,
  onGroundJump: () => ui?.audio.playSound("Game", "Jump").catch(report),
  onMovementLock: (message, predictedLock) =>
    ui.localCombat.movementLock(message, predictedLock),
});
// A resumed session offers diagnostic motion; the server retains position authority
// across the reconnect gap and returns a checkpoint for reconciliation.
transport.resumeMotion = () => prediction.resumeMotion();

function reportCause(error) {
  // The user-facing line stays sanitized; the underlying cause stays in the console log.
  if (error?.cause) {
    console.error(
      logPrefix("client"),
      "Online failure cause:",
      error.cause?.stack ?? error.cause,
    );
  }
}

function report(error) {
  if (error?.name === "AbortError" || destroyed) return;
  if (error instanceof NativeOperationRefusal) {
    ui?.ui.status(error.message);
    return;
  }
  reportCause(error);
  lastError = error instanceof Error ? error.message : String(error);
  document.querySelector("#ui-status").textContent = lastError;
  if (ui) ui.ui.recordError(error);
  else document.querySelector("#error").value = lastError;
  inspection?.record("error", { message: lastError, code: error?.code });
}

function recordCommand(value) {
  inspection?.record("command", value);
}

function sendInput(sample) {
  const sequence = transport.sendInput(sample);
  if (sequence) ui?.localCombat.input(sample, sequence);
  return sequence;
}
function resync(reason) {
  transport.resync(reason);
}
function intent(action) {
  const pending = transport.command(action);
  pending.catch(report);
  return pending;
}
function clearInput() {
  input?.clear();
}
function isFieldBlocked() {
  return (
    destroyed ||
    (installing && !refreshing) ||
    transport.status !== "active" ||
    Boolean(ui?.transitions.blocksInput)
  );
}
function isBlocked() {
  return (
    isFieldBlocked() ||
    Boolean(ui?.ui.blocksGameplay()) ||
    loading.downloads.dialog.open
  );
}

function status(value) {
  communityMaps?.update(value.status);
  if (destroyed) return;
  if (value.code === "SIGNED_OUT") releaseField();
  login?.status(value);
  ui?.status(value);
  if (value.status === "recovering") {
    document.querySelector("#ui-status").textContent =
      "Connection interrupted. Restoring your character…";
  }
  inspection?.status(value);
  // Connection teardown resets the clock, so a stale round trip clears itself.
  setProjectPing(value.timing.roundTripMs);
  if (value.status !== "active") clearInput();
}

/** A field owns its atlases only while its connection is live. Returning to the
 * login surface hands the residency budget back before login artwork is loaded,
 * and the next admitted snapshot rebuilds the field. A commit in flight defers
 * the release so a torn-down candidate can never be installed afterwards. */
function releaseField() {
  if (installing) {
    releasePending = true;
    return;
  }
  current?.destroy();
  current = null;
  releasePending = false;
  prediction.clear();
  input?.setBindings(null);
  boundBindings = null;
  ui?.ui.setScene(null);
  ui?.audio.setScene(null);
}
function motion(message) {
  try {
    prediction.observe(message);
  } catch (error) {
    report(error);
    transport.resync("prediction-overflow");
  }
}
/** The un-gated peer move stream: display-only, never admitted into the local kernel. */
function peers(message) {
  try {
    current?.peers(message);
  } catch (error) {
    report(error);
  }
}
function timing(value) {
  prediction.timing(value);
  setProjectPing(value.roundTripMs);
}
function event(message) {
  inspection?.event(message);
  Promise.all([ui?.event(message), current?.event(message)]).catch(report);
}
function transition(message) {
  clearInput();
  inspection?.record("transition", message);
  ui?.transitions.transition(message).catch(report);
}
function state(message) {
  const owner = current;
  owner
    ?.changes(message)
    .then(() => {
      if (owner === current) return ui.observeEntities(transport.model);
    })
    .catch((error) => failedScene(error, owner));
}
function failedScene(error, owner = current) {
  if (owner !== current || error?.name === "AbortError" || destroyed) return;
  report(error);
  transport.presentationFailed(error);
}

/** Profile refreshes retain the active clock; entry, travel and recovery reinitialize it. */
function retainsMotion(snapshot) {
  return (
    current?.fieldEpoch === snapshot.fieldEpoch &&
    current.selfId === snapshot.self.entity.id &&
    prediction.ready &&
    prediction.connectionEpoch === transport.connectionEpoch &&
    transport.status === "active"
  );
}

async function refreshScene(snapshot, retainMotion, signal) {
  await current.queue;
  signal?.throwIfAborted();
  await current.replace(snapshot, retainMotion);
  signal?.throwIfAborted();
  if (!retainMotion) installPrediction(current, snapshot);
  await publishNative(snapshot);
}

/** Stage the authoritative field before replacing any visible field or native-window owner. */
async function install(snapshot, signal = controller.signal) {
  const token = ++generation;
  const retainMotion = retainsMotion(snapshot);
  installing = true;
  refreshing = retainMotion;
  try {
    const staged = await ui.transitions.take(snapshot);
    if (!staged && refreshesInstalledField(snapshot)) {
      await refreshScene(snapshot, retainMotion, signal);
      return;
    }
    clearInput();
    const candidate = staged ?? (await prepareScene(snapshot, signal));
    if (expiredInstallation(token, signal)) {
      candidate.destroy();
      throw new DOMException("Scene replacement superseded", "AbortError");
    }
    const previous = current;
    current = candidate;
    installPrediction(candidate, snapshot);
    app.stage.addChildAt(candidate.scene.container, 0);
    try {
      await publishNative(snapshot);
      signal.throwIfAborted();
      ui.transitions.installed(snapshot.fieldEpoch);
      previous?.destroy();
    } catch (error) {
      current = previous;
      candidate.destroy();
      throw error;
    }
    resize();
    app.canvas.focus();
    regionDownloads?.select(snapshot.field.mapId);
  } finally {
    if (token === generation) {
      installing = false;
      refreshing = false;
    }
    if (releasePending && !installing) releaseField();
  }
}

function expiredInstallation(token, signal) {
  return token !== generation || destroyed || signal.aborted;
}

function refreshesInstalledField(snapshot) {
  return (
    current?.fieldEpoch === snapshot.fieldEpoch &&
    current.scene.failures.size === 0
  );
}

async function prepareScene(snapshot, signal) {
  const descriptor =
    catalog.maps[String(snapshot.field.mapId).padStart(9, "0")];
  if (!descriptor) throw new Error("Server field is not in this asset catalog");
  const changingMap =
    current?.scene.manifest.id !==
    String(snapshot.field.mapId).padStart(9, "0");
  const owner = changingMap
    ? loading.beginMap(
        descriptor,
        catalog.mapNames[Number(snapshot.field.mapId)],
      )
    : null;
  try {
    return await loadScene(snapshot, descriptor, owner, signal);
  } finally {
    if (owner) loading.endMap(owner);
  }
}

async function loadScene(snapshot, descriptor, loadingOwner, signal) {
  const manifest = validateManifest(
    await network.json(descriptor, signal ?? controller.signal),
  );
  loading.includeMap(loadingOwner, manifest);
  const candidate = new OnlineScene({
    app,
    manifest,
    services,
    catalog,
    viewport: app.screen,
    intent,
  });
  const cancel = () => candidate.controller.abort(signal.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    signal?.throwIfAborted();
    await candidate.prepare(snapshot);
    return candidate;
  } catch (error) {
    candidate.destroy();
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

function installPrediction(candidate, snapshot) {
  // Preserve the pose the player was already seeing across a field swap; the predictor
  // glides onto the authoritative arrival instead of stepping visibly backwards.
  const presented = prediction.simulation ? { x: 0, y: 0 } : null;
  if (presented) prediction.interpolate(performance.now(), presented);
  prediction.install(
    createSimulation(
      candidate.scene.manifest.physics,
      snapshot.self.entity.position,
    ),
    snapshot.serverTick,
  );
  candidate.syncPrediction(prediction);
  if (presented) prediction.seedCorrection(presented.x, presented.y);
}

async function publishNative(snapshot) {
  await ui.update(snapshot);
  if (boundBindings !== ui.bindings) {
    input.setBindings(ui.bindings);
    boundBindings = ui.bindings;
  }
  inspection?.update(snapshot);
  await current?.setNativePresentation(ui.quests);
}

/** Native portal intent uses the original contact rectangle; the server admits the transition. */
function portal() {
  if (!current || isBlocked() || transport.pendingTravel) return;
  const self = prediction.simulation;
  if (!self?.foothold || self.movementLocked) {
    return;
  }
  if (ui.skillVisuals.enterDoor()) return;
  const selected = entryPortal(
    current.scene.manifest.physics.portals ?? [],
    self,
  );
  if (selected) intent({ kind: "portal.enter", portalId: Number(selected.id) });
}

/** Original reverse-authored first match; automatic portal intent remains server-owned. */
function entryPortal(portals, position) {
  for (let index = portals.length - 1; index >= 0; index--) {
    const portal = portals[index];
    if (
      portal.type !== 0 &&
      portal.type !== 6 &&
      portalEntryContains(portal, position)
    ) {
      return portal;
    }
  }
  return null;
}

/** Every caller uses the same bounded fixed-step clock, independent of frame cadence. */
function advance(now = performance.now()) {
  if (destroyed || transport.status !== "active") return;
  if (document.hidden) {
    prediction.lastStepAt = now;
    return;
  }
  try {
    if (input.state.upPressed && !isBlocked()) portal();
    const steps = prediction.advance(now, isBlocked() ? neutral : input.state);
    if (steps) input.afterTick();
  } catch (error) {
    failedScene(error);
  }
}
function draw() {
  if (destroyed) return;
  // RAF's timestamp predates its callbacks. Network processing can delay this
  // callback until the fixed timer has already advanced past that timestamp.
  const now = performance.now();
  // A frame can precede the 4 ms timer at a quantum boundary. Finish due fixed
  // steps before sampling, rather than drawing one stale, clamped interpolation.
  advance(now);
  const elapsed = previousTime ? Math.min(now - previousTime, 100) : 0;
  previousTime = now;
  try {
    current?.draw(now, elapsed, prediction, transport.status === "active");
    ui?.draw(elapsed);
    login?.draw(elapsed);
    if (current) current.scene.hitboxPreview = hitboxInspector.context;
    overlay?.update(current?.scene, debug);
    app.renderer.render(app.stage);
  } catch (error) {
    failedScene(error);
  }
  frame = requestAnimationFrame(draw);
}
function updateDemand() {
  current?.scene.updateDemand();
  if (current?.scene.lastError) {
    const error = new Error(current.scene.lastError);
    current.scene.lastError = null;
    failedScene(error);
  }
}
function inspect() {
  inspection?.update(transport.model);
}
function resize() {
  if (destroyed) return;
  resizeBrowserSurface(app, viewport);
  current?.resize(app.screen.width, app.screen.height);
  ui?.resize(app.screen.width, app.screen.height);
  login?.resize(app.screen.width, app.screen.height);
}

/** Inspection clones are sampled outside rendering; none can be committed as character state. */
function snapshot() {
  const scene = current?.scene;
  return {
    schemaVersion: 2,
    sourceBuildId: import.meta.MAPLE_SOURCE_ID,
    buildId: catalog?.buildId ?? null,
    login: login?.snapshot() ?? null,
    maps: catalog ? Object.keys(catalog.maps) : [],
    ...snapshotField(scene),
    ...snapshotSession(),
    simulation: prediction.simulation
      ? snapshotSimulation(prediction.simulation)
      : null,
    ...snapshotUI(),
    localSkillFeedback: ui?.skillVisuals.local.snapshot() ?? [],
    streaming: {
      ...network.snapshot(),
      ...services.atlases?.snapshot(),
      limits: LIMITS,
    },
    online: transport.snapshot(),
    prediction: prediction.snapshot(),
    delivery: loading.snapshot(),
    startupPreload,
  };
}

function snapshotField(scene) {
  return {
    currentMap: scene?.manifest.id ?? null,
    debug,
    follow: current?.follow ?? true,
    loading:
      (installing && !refreshing) || transport.status === "synchronizing",
    lastError,
    camera: scene ? { ...scene.camera } : null,
    pendingLoads: scene?.pendingLoads ?? 0,
    ...current?.inspectionSnapshot(),
    // Shared scene controls read the entity-id array contract; the count is entityCount.
    entities: entityIds(),
  };
}

function entityIds() {
  return (transport.model?.entities ?? []).map((entity) => entity.id);
}

function snapshotSession() {
  return {
    localCombat: ui?.localCombat.snapshot() ?? null,
    regionDownloads: regionDownloads?.snapshot() ?? null,
    paused: transport.model?.presentation?.paused ?? prediction.paused,
    input: input ? { ...input.state } : null,
  };
}

function snapshotUI() {
  return {
    profile: ui?.store?.profile ?? null,
    ui: ui?.ui.snapshot() ?? null,
    audio: ui?.audio.snapshot() ?? null,
    skillVisuals: ui?.skillVisuals.snapshot() ?? [],
    hitboxReference: hitboxInspector.selected,
    hitboxes: overlay?.snapshot() ?? null,
  };
}

function entityById(id) {
  const entity = current?.scene.byId.get(id);
  if (!entity) throw new Error("Entity is not resident in the current field");
  return entity;
}
async function setDebug(value) {
  debug = Boolean(value);
  if (debug) await hitboxInspector.load(catalog?.hitboxes);
  else hitboxInspector.controller?.abort();
}
function setGeometryReference(id) {
  hitboxInspector.select(id);
}
function setAction(id, action) {
  const entity = entityById(id);
  if (entity.kind === "character" || entity.kind === "mob") {
    throw new Error("Online live actor poses belong to server observations");
  }
  entity.setAction(action);
}
function setVisible(id, value) {
  entityById(id).container.visible = Boolean(value);
}
function setLayer(id, z) {
  finite(z);
  entityById(id).container.zIndex = z;
  current.scene.refreshEntities();
}

async function loadCatalog() {
  const value = validateCatalog(
    await network.catalog(controller.signal, transport.config.catalogHash),
  );
  if (value.buildId !== transport.config.assetBuildId) {
    throw new Error("Server asset build mismatch");
  }
  if (!transport.config.worldContent) return value;
  const overlay = await network.json(
    transport.config.worldContent,
    controller.signal,
  );
  return validateCatalog(applyWorldContent(value, overlay));
}

function initializeInterfaces() {
  input = createPlayerInput(app.canvas);
  loading.downloads.onOpen = clearInput;
  loading.downloads.onClose = () => app.canvas.focus();
  loading.downloads.onToggle = () => regionDownloads?.toggle();
  ui = new OnlineUI(app, services, transport, {
    scene: () => current,
    loading,
    prediction,
    clearInput,
    keyDown: input.keyDown,
    inputGeneration: () => input.generation,
    focusGame: () => app.canvas.focus(),
    intent,
    report,
    isBlocked,
    isFieldBlocked,
    tap: input.tap,
    portal,
  });
  actions = createPlayerActions({
    input,
    getSystems: () => ui,
    canvas: app.canvas,
  });
  login = new OnlineLogin({
    app,
    services,
    transport,
    audio: ui.audio,
    hooks: { report, releaseField },
  });
  if (import.meta.OPENMS_DEVELOPMENT !== false) initializeInspection();
}

function initializeInspection() {
  inspection = new OnlineInspection({
    transport,
    prediction,
    hooks: {
      scene: () => current,
      systems: () => ui,
      catalog: () => catalog,
      login: () => login,
      snapshot,
      api,
      report,
      input,
      canvas: app.canvas,
      clearInput,
      dispatch: actions.dispatch,
      actions,
    },
  });
  inspection.prepare();
  api.agent = inspection.agent.api;
  api.dev = inspection.dev;
  overlay = createDebugOverlay(
    app,
    document.querySelector("#geometry-readout"),
  );
}

/**
 * A required login-page resource (catalog, UI bundle or login artwork) failed to
 * prepare. Transient failures before this phase (browser surface, server
 * bootstrap) keep their existing report-only path.
 */
function loginResourceFailure(error) {
  report(error);
  login?.destroy();
  login = null;
}

/** Catalog, shared UI bundles and login artwork, in their required order. */
async function prepareLoginPage() {
  network.startupPack = await prepareStartupPack(
    network,
    import.meta.OPENMS_STARTUP_PACK,
    transport.config.catalogHash,
    controller.signal,
  );
  catalog = await loadCatalog();
  loading.decoration.loadCatalog(catalog, network);
  startupPreload = await preloadStartupAssets(
    catalog,
    network,
    controller.signal,
  );
  communityMaps = new CommunityMaps(catalog, {
    intent,
    clearInput,
    signal: controller.signal,
  });
  await ui.prepare(catalog, controller.signal);
  startPresentation();
  await login.prepare(catalog, controller.signal);
  regionDownloads = new RegionDownloads(
    catalog,
    network,
    loading,
    controller.signal,
  );
  void regionDownloads.start();
}

async function initialize() {
  loading.beginStartup();
  try {
    await initializeBrowserSurface(app, viewport);
    if (destroyed) throw new DOMException("Client closed", "AbortError");
    services.atlases = new AtlasStore(app.renderer, network);
    initializeInterfaces();
    await transport.initialize();
    const ready = await prepareLoginStartup({
      prepare: prepareLoginPage,
      loading,
      onFailure: loginResourceFailure,
    });
    if (ready) {
      loading.ready();
      status(transport.snapshot());
    }
  } catch (error) {
    // Bootstrap failures own the same page; a live marquee must never hide a dead start.
    if (error?.name !== "AbortError" && !destroyed && !loading.failure) {
      loading.failStartup(STARTUP_CONNECTION_FAILURE_MESSAGE);
    }
    throw error;
  }
}

function startPresentation() {
  observer = new ResizeObserver(resize);
  observer.observe(viewport);
  resize();
  window.addEventListener("pagehide", leaving, { signal: controller.signal });
  window.addEventListener("error", browserError, { signal: controller.signal });
  window.addEventListener("unhandledrejection", browserRejection, {
    signal: controller.signal,
  });
  // Both this timer and drawing drain the same fixed clock. Poll within a quantum
  // so input need not wait for a rendered frame; interpolation retains tick phase.
  clock = setInterval(advance, 4);
  demand = setInterval(updateDemand, 200);
  if (inspection) inspectionTimer = setInterval(inspect, 500);
  frame = requestAnimationFrame(draw);
}
function browserError(event) {
  report(event.error ?? new Error(event.message));
}
function browserRejection(event) {
  report(event.reason);
}
function leaving() {
  shutdown().catch(report);
}
async function shutdown() {
  if (destroyed) return;
  destroyed = true;
  generation++;
  controller.abort();
  cancelAnimationFrame(frame);
  clearInterval(clock);
  clearInterval(demand);
  clearInterval(inspectionTimer);
  observer?.disconnect();
  transport.close();
  input?.destroy();
  inspection?.destroy();
  login?.destroy();
  current?.destroy();
  prediction.clear();
  hitboxInspector.destroy();
  overlay?.destroy();
  await ui?.destroy();
  services.atlases?.destroy();
  app.destroy(true, { children: true });
}

const api = {
  ready: null,
  snapshot,
  destroy: shutdown,
  setDebug,
  setGeometryReference,
  setAction,
  setVisible,
  setLayer,
  mapName: (id) =>
    catalog?.mapNames[Number(id)] ?? "Original map name unavailable",
  monsterCatalog: () => (catalog ? Object.values(catalog.monsters ?? {}) : []),
  onKeyConfig: () => ui.activateBinding("KeyConfig"),
  onError: report,
  setFollow: (value) => current?.setFollow(Boolean(value)),
  setCamera(x, y) {
    finite(x);
    finite(y);
    if (!current) throw new Error("No map loaded");
    current.setCamera(x, y);
  },
  captureAudio: (seconds) => ui.audio.capturePCM(seconds),
};
window.maple = api;
window.mapleOnline = Object.freeze({
  snapshot: () =>
    Object.freeze({
      ...transport.snapshot(),
      prediction: prediction.snapshot(),
    }),
  observation: () => transport.model,
  command: intent,
  reconnect: () => transport.reconnect(),
  project: (x, y) => current?.project(x, y) ?? null,
});
api.ready = initialize();
api.ready.catch(report);
