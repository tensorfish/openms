import { randomUUID } from "node:crypto";
import { SkillResources } from "../../client/src/skills/skill-resources.js";
import {
  compileAction,
  timedFrame,
  advanceActionClock,
  seekActionClock,
} from "../../client/src/rendering/animation-timing.js";
import { visualBundle } from "../../client/src/rendering/stream-validation.js";

const MAX_ANIMATIONS = 8192;
const MAX_VISIBLE = 512;

/** Numeric authored animation state, not a renderer or a client admission substitute. */
export class AuthorityAnimation {
  constructor(owner, entity, textures) {
    if (owner.animations.size >= MAX_ANIMATIONS) {
      throw new Error("Skill animation capacity exceeded");
    }
    this.owner = owner;
    this.id = randomUUID();
    this.sourceId = entity.id;
    this.avatar = entity.avatar;
    this.textures = textures;
    this.actions = new Map();
    this.sources = new Map();
    this.compileActions(entity.actions, textures);
    this.container = {
      x: entity.x ?? 0,
      y: entity.y ?? 0,
      zIndex: entity.z ?? 0,
      visible: entity.visible !== false,
      renderable: true,
      alpha: entity.opacity ?? 1,
      rotation: 0,
      scale: {
        x: entity.flip ? -1 : 1,
        y: 1,
        set(x, y) {
          this.x = x;
          this.y = y;
        },
      },
      parent: null,
      destroy: () => {
        this.container.visible = false;
        this.container.parent?.removeChild(this.container);
        owner.animations.delete(this.id);
      },
    };
    this.tint = 0xffffff;
    this.expression = "default";
    this.expressionMs = 0;
    this.action = null;
    this.playbackId = 0;
    this.frame = 0;
    this.actionTimeMs = 0;
    this.elapsedMs = 0;
    this.setAction(entity.action ?? this.actions.keys().next().value);
    owner.animations.set(this.id, this);
  }
  compileActions(actions, textures) {
    for (const [name, frames] of Object.entries(actions)) {
      this.actions.set(name, compileAction(frames, textures));
      const texture = frames[0]?.parts[0]?.texture;
      this.sources.set(name, textures.get(texture)?.bundle ?? null);
    }
  }
  setAction(name, playback, restart = false) {
    const next = this.actions.get(name);
    if (!next) throw new Error(`Missing authored action ${name}`);
    playback ??= next.repeat < 0 ? "once" : "loop";
    if (playback !== "loop" && playback !== "once") {
      throw new Error(`Unknown animation playback ${playback}`);
    }
    if (this.action === name && this.playback === playback && !restart) return;
    if (restart) {
      this.playbackId = (this.playbackId + 1) >>> 0;
      this.feedbackId = this.owner.feedbackId;
    }
    this.action = name;
    this.playback = playback;
    this.current = next;
    this.elapsedMs = 0;
    this.actionTimeMs = 0;
    this.completed = playback === "once" && next.duration === 0;
    this.frame = timedFrame(next, 0);
  }
  setPosition(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("Invalid animation position");
    }
    this.container.x = x;
    this.container.y = y;
  }
  setTint(value) {
    this.tint = value;
  }
  setExpression(name, duration) {
    this.expression = name;
    this.expressionMs = duration;
  }
  advance(ms) {
    const advanced = advanceActionClock(this, ms);
    this.expressionMs = Math.max(0, this.expressionMs - ms);
    if (this.expressionMs === 0) this.expression = "default";
    if (advanced) this.frame = timedFrame(this.current, this.actionTimeMs);
  }
  seek(ms) {
    seekActionClock(this, ms);
    this.frame = timedFrame(this.current, this.actionTimeMs);
  }
}

export class AuthoritySkillResources extends SkillResources {
  constructor(world, actor, scene, hooks) {
    super(scene, hooks);
    this.world = world;
    this.actor = actor;
    this.publicationField = scene.field ?? actor.field;
    this.publicationEnabled = actor.bound !== false;
    this.animations = new Map();
    this.bundles = new Map();
    this.frameSources = new WeakMap();
    this.sources = new Map();
  }
  async loadVisual(descriptor, signal) {
    if (signal?.aborted) throw new Error("Skill preparation cancelled");
    const manifest = visualBundle(await this.world.content.json(descriptor));
    if (signal?.aborted) throw new Error("Skill preparation cancelled");
    for (const entity of manifest.entities) {
      for (const [action, frames] of Object.entries(entity.actions)) {
        for (let index = 0; index < frames.length; index++) {
          this.frameSources.set(frames[index].parts, {
            bundle: descriptor,
            entityId: entity.id,
            action,
            index,
          });
        }
      }
    }
    const textures = new Map();
    for (const [id, texture] of Object.entries(manifest.textures)) {
      textures.set(id, {
        width: texture.width,
        height: texture.height,
        bundle: descriptor,
      });
    }
    const lease = {
      manifest,
      textures,
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
    };
    this.bundles.set(descriptor.sha256, descriptor);
    return lease;
  }
  async prepareSource(kind, id) {
    const source = kind === "item" ? -id : id;
    if (this.sources.has(source)) return;
    const { template, path } = this.sourceIcon(kind, id);
    const owner = await this.loadVisual(
      template.descriptor,
      this.controller.signal,
    );
    if (
      !owner.manifest.metadata.assets[path] ||
      !owner.manifest.entities.some((entity) => entity.id === path)
    ) {
      owner.destroy();
      throw new Error("Original source icon missing from bundle");
    }
    this.sources.set(source, owner);
  }
  sourceIcon(kind, id) {
    const template =
      kind === "item"
        ? this.world.content.items[id]
        : this.world.content.catalog.ui.skills[id];
    const path =
      kind === "item" && Math.trunc(id / 10000) !== 238
        ? template?.iconRawPath
        : template?.iconPath;
    if (!path || !template?.descriptor) {
      throw new Error("Original source icon unavailable");
    }
    return { template, path };
  }
  releaseSource(kind, id) {
    const source = kind === "item" ? -id : id;
    this.sources.get(source)?.destroy();
    this.sources.delete(source);
  }
  createAnimation(entity, textures) {
    return new AuthorityAnimation(this, entity, textures);
  }
  sound(skill, leaf, loop = false) {
    const source = skill.sounds.leaves[leaf];
    if (!source) return null;
    if (!source.available) throw new Error("Unadmitted authored skill sound");
    const voice = { id: randomUUID(), ended: false, skillId: skill.id, leaf };
    this.emit({
      kind: "skill.sound",
      ...(this.feedbackId ? { feedbackId: this.feedbackId } : {}),
      actorId: this.actor.id,
      voiceId: voice.id,
      skillId: skill.id,
      leaf,
      loop,
      stopped: false,
    });
    if (loop) this.voices.add(voice);
    return voice;
  }
  stopSound(voice) {
    if (!voice || voice.ended) return;
    voice.ended = true;
    this.voices.delete(voice);
    this.emit({
      kind: "skill.sound",
      actorId: this.actor.id,
      voiceId: voice.id,
      skillId: voice.skillId,
      leaf: voice.leaf,
      loop: false,
      stopped: true,
    });
  }
  emit(event) {
    // A detached destination records its inherited presentation for the first
    // baseline. Publishing it before travel commits would cross field epochs.
    if (!this.publicationEnabled) return;
    this.world.broadcast(this.publicationField, {
      type: "event",
      fieldEpoch: this.publicationField.epoch,
      event,
    });
  }
  enablePublication() {
    this.publicationEnabled = true;
  }
  playSequence(sequence, target, options) {
    const slot = super.playSequence(sequence, target, options);
    if (slot) {
      slot.animation.feedbackId =
        (options?.flight ? target.feedbackId : this.feedbackId) ?? null;
      this.emit({
        kind: "skill.visual",
        actorId: this.actor.id,
        visual: this.view(slot.animation),
      });
    }
    return slot;
  }
  view(animation) {
    const source = this.frameSources.get(
      animation.current.frames[animation.frame].parts,
    );
    const riding = this.actor.skills?.worldController.riding.current;
    const morph = this.actor.skills?.worldController.forms.current;
    const mount = riding?.animation === animation ? riding : null;
    const view = this.animationView(animation, source, mount);
    view.replacesActor = Boolean(mount || morph?.animation === animation);
    if (mount) {
      const catalog = this.world.content.catalog.ui.skillWorld.riding;
      view.riding = {
        mount: mount.descriptor.bundle,
        saddle: mount.saddleId
          ? catalog.saddles[mount.saddleId][mount.id].bundle
          : null,
        anchor: mount.anchor,
      };
    }
    return view;
  }
  animationView(animation, source, mount) {
    const node = animation.container;
    const bundle = this.animationBundle(animation, source, mount);
    const composite =
      animation.sourceId.startsWith("shadow:") ||
      animation.sourceId.startsWith("combo:");
    const view = {
      id: animation.id,
      ...(animation.feedbackId ? { feedbackId: animation.feedbackId } : {}),
      sourceId: animation.sourceId,
      bundle,
      entityId: source?.entityId ?? animation.sourceId,
      position: { x: node.x, y: node.y },
      action: source?.action ?? animation.action,
      elapsedMs: animation.elapsedMs,
      playback: animation.playback,
      playbackId: animation.playbackId,
      sourceFrame: composite ? (source?.index ?? 0) : null,
      scaleX: node.scale.x,
      scaleY: node.scale.y,
      rotation: node.rotation,
      opacity: node.alpha,
      tint: animation.tint,
      depth: node.zIndex,
      replacesActor: false,
      riding: null,
      // A flight slot publishes its authored plan so an observer drives the same straight
      // line locally instead of chasing acknowledged position samples.
      flight: animation.flight ?? null,
    };
    return view;
  }
  animationBundle(animation, source, mount) {
    const bundle =
      mount?.descriptor.bundle ??
      source?.bundle ??
      animation.sources.get(animation.action);
    if (!bundle) {
      throw new Error("Visible skill actor has no authored bundle source");
    }
    return bundle;
  }
  views() {
    const result = [];
    for (const animation of this.animations.values()) {
      const node = animation.container;
      if (!node.visible || !node.renderable || !node.parent) continue;
      if (result.length >= MAX_VISIBLE) {
        throw new Error("Visible skill actor capacity exceeded");
      }
      result.push(this.view(animation));
    }
    return result;
  }
  destroy() {
    for (const voice of this.voices) this.stopSound(voice);
    super.destroy();
    this.animations.clear();
    this.bundles.clear();
    for (const source of this.sources.values()) source.destroy();
    this.sources.clear();
  }
}

/** Explicit metadata attachment determines which prepared actors are visible on the wire. */
export function authorityLayer() {
  const children = new Set();
  return {
    children,
    addChild(node) {
      node.parent?.removeChild(node);
      children.add(node);
      node.parent = this;
    },
    removeChild(node) {
      children.delete(node);
      node.parent = null;
    },
  };
}
