import { Graphics } from "pixi.js";
import { FieldTransition } from "../rendering/field-transition.js";
import { manifest as validateManifest } from "../rendering/stream-validation.js";
import { OnlineScene } from "./scene.js";
import { animationId } from "../../../shared/motion-schema.js";

const MAX_PREVIEW_ENTITIES = 2048;
const MAX_PREVIEW_BYTES = 1024 * 1024;
const encoder = new TextEncoder();

/** Existing native 600ms leave/reveal controller; no world or durable state is predicted here. */
export class NativeTransitions {
  constructor(owner) {
    this.owner = owner;
    this.fade = new FieldTransition();
    this.overlay = new Graphics();
    this.overlay.eventMode = "none";
    this.overlay.visible = false;
    this.owner.app.stage.addChild(this.overlay);
    this.sequence = 0;
    this.active = null;
    this.width = 0;
    this.height = 0;
  }
  get blocksInput() {
    return this.fade.blocksInput;
  }
  async transition(message) {
    if (message.phase === "prepare") {
      if (this.active?.message.transitionId !== message.transitionId) {
        return this.prepare(message);
      }
      try {
        this.acceptPart(this.active, message);
      } catch (error) {
        this.fail();
        this.owner.transport.sendTransitionReady(
          message.transitionId,
          false,
          message.sourceEpoch,
        );
        throw error;
      }
      return;
    }
    if (this.active?.message.transitionId !== message.transitionId) return;
    if (message.phase === "aborted") this.fail();
    else this.active.committed = true;
  }
  async prepare(message) {
    this.cancel();
    const source = this.owner.hooks.scene();
    const generation = ++this.sequence;
    const partsReady = Promise.withResolvers();
    const active = {
      message,
      generation,
      candidate: null,
      controller: new AbortController(),
      committed: false,
      parts: [],
      count: 0,
      entities: 0,
      bytes: 0,
      partsReady,
    };
    this.active = active;
    try {
      if (!source || source.fieldEpoch !== message.sourceEpoch) {
        throw new Error("Transition source no longer visible");
      }
      if (!message.preparation) {
        throw new Error("Transition asset preview missing");
      }
      active.parts = new Array(message.preparation.parts).fill(null);
      const boundary = this.fade.begin(generation);
      if (message.portalSound) {
        this.owner.audio
          .playSound("Game", "Portal")
          .catch((error) => this.owner.report(error));
      }
      this.acceptPart(active, message);
      const preparation = await partsReady.promise;
      if (!preparation || this.active !== active) return;
      const candidate = await this.stage(
        message,
        active.controller.signal,
        preparation,
      );
      await this.confirmCandidate(active, candidate, boundary, source);
    } catch (error) {
      if (this.active !== active) return;
      this.fail();
      this.owner.transport.sendTransitionReady(
        message.transitionId,
        false,
        message.sourceEpoch,
      );
      this.owner.report(error);
    }
  }
  async confirmCandidate(active, candidate, boundary, source) {
    if (this.active !== active) {
      candidate.destroy();
      return;
    }
    active.candidate = candidate;
    if (!(await boundary.covered) || this.active !== active) return;
    if (source !== this.owner.hooks.scene()) {
      throw new Error("Transition source changed during preparation");
    }
    this.owner.transport.sendTransitionReady(
      active.message.transitionId,
      true,
      active.message.sourceEpoch,
    );
  }
  async stage(message, signal, preparation) {
    const changingMap =
      this.owner.state.field.mapId !== message.destination.mapId;
    const descriptor =
      this.owner.catalog.maps[
        String(message.destination.mapId).padStart(9, "0")
      ];
    if (!descriptor) throw new Error("Transition map descriptor is missing");
    const owner = changingMap
      ? this.owner.hooks.loading.beginMap(
          descriptor,
          this.owner.catalog.mapNames[Number(message.destination.mapId)],
        )
      : null;
    try {
      return await this.loadScene(message, signal, preparation, owner);
    } finally {
      if (owner) this.owner.hooks.loading.endMap(owner);
    }
  }
  async loadScene(message, signal, preparation, loadingOwner) {
    const descriptor =
      this.owner.catalog.maps[
        String(message.destination.mapId).padStart(9, "0")
      ];
    if (!descriptor || !message.requiredContent.includes(descriptor.sha256)) {
      throw new Error("Transition content identity mismatch");
    }
    const manifest = validateManifest(
      await this.owner.services.network.json(descriptor, signal),
    );
    this.owner.hooks.loading.includeMap(loadingOwner, manifest);
    signal.throwIfAborted();
    const candidate = new OnlineScene({
      app: this.owner.app,
      manifest,
      services: this.owner.services,
      catalog: this.owner.catalog,
      viewport: this.owner.app.screen,
      intent: (action) => this.owner.request(action),
    });
    const cancel = () => candidate.destroy();
    signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      const snapshot = this.preparationSnapshot(message, preparation);
      await candidate.prepare(snapshot);
      await candidate.setNativePresentation(this.owner.quests);
      signal.throwIfAborted();
      return candidate;
    } catch (error) {
      candidate.destroy();
      throw error;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
  /** The staged self is artwork-only. Main never installs it into prediction or the transport model. */
  preparationSnapshot(message, preparation) {
    const source = this.owner.state;
    const self = preparation.entities.find(
      (entity) => entity.id === source.self.entity.id,
    );
    if (!self || self.kind !== "player") {
      throw new Error("Transition traveler artwork is missing");
    }
    return {
      ...source,
      field: message.destination,
      fieldEpoch: message.destination.fieldEpoch,
      serverTick: preparation.serverTick,
      entities: preparation.entities,
      self: {
        ...source.self,
        entity: {
          ...self,
          position: message.destination.spawn,
          velocity: { x: 0, y: 0 },
          foothold: null,
          action: animationId("stand1"),
          actionStartTick: 0,
          seat: null,
        },
      },
    };
  }
  /** Called by Main.install instead of loading a second scene after durable commit. */
  async take(snapshot) {
    const active = this.active;
    if (
      !active ||
      !active.committed ||
      active.message.destination.fieldEpoch !== snapshot.fieldEpoch
    ) {
      return null;
    }
    const candidate = active.candidate;
    if (!candidate) {
      throw new Error("Committed transition lost its prepared scene");
    }
    await candidate.replace(snapshot);
    active.candidate = null;
    return candidate;
  }
  /** Main calls only after installing the genuine snapshot and native owners. Input resumes during reveal. */
  installed(fieldEpoch) {
    const active = this.active;
    if (!active || active.message.destination.fieldEpoch !== fieldEpoch) return;
    if (active.candidate) {
      throw new Error("Transition scene was not transferred to Main");
    }
    this.fade.reveal(active.generation);
    this.active = null;
  }
  acceptPart(active, message) {
    const part = message.preparation;
    const first = active.message;
    if (
      !part ||
      part.parts !== active.parts.length ||
      active.parts[part.part] ||
      part.serverTick !== first.preparation.serverTick ||
      message.sourceEpoch !== first.sourceEpoch ||
      message.destination.fieldEpoch !== first.destination.fieldEpoch ||
      message.deadline !== first.deadline
    ) {
      throw new Error("Transition preview identity changed");
    }
    active.bytes += encoder.encode(JSON.stringify(part.entities)).byteLength;
    active.entities += part.entities.length;
    if (
      active.bytes > MAX_PREVIEW_BYTES ||
      active.entities > MAX_PREVIEW_ENTITIES
    ) {
      throw new Error("Transition preview exceeds snapshot bound");
    }
    active.parts[part.part] = part.entities;
    active.count++;
    if (active.count === active.parts.length) {
      this.completePreview(active, part.serverTick);
    }
  }
  completePreview(active, serverTick) {
    const entities = [];
    const ids = new Set();
    for (const chunk of active.parts) {
      for (const entity of chunk) {
        if (ids.has(entity.id)) {
          throw new Error("Duplicate transition preview entity");
        }
        ids.add(entity.id);
        entities.push(entity);
      }
    }
    active.partsReady.resolve({ serverTick, entities });
  }
  fail() {
    const active = this.active;
    if (!active) return;
    active.controller.abort();
    active.partsReady.resolve(null);
    active.candidate?.destroy();
    this.fade.fail(active.generation);
    this.active = null;
  }
  draw(ms) {
    this.fade.update(ms);
    const screen = this.owner.app.screen;
    if (screen.width !== this.width || screen.height !== this.height) {
      this.width = screen.width;
      this.height = screen.height;
      this.overlay
        .clear()
        .rect(0, 0, screen.width, screen.height)
        .fill(0x000000);
    }
    this.overlay.alpha = this.fade.opacity;
    this.overlay.visible = this.overlay.alpha > 0;
    if (this.overlay.visible) {
      this.owner.app.stage.setChildIndex(
        this.overlay,
        this.owner.app.stage.children.length - 1,
      );
    }
  }
  cancel() {
    this.active?.controller.abort();
    this.active?.partsReady.resolve(null);
    this.active?.candidate?.destroy();
    this.active = null;
    this.fade.cancel();
  }
  destroy() {
    this.cancel();
    this.overlay.destroy();
  }
}
