import { Graphics, Text } from "pixi.js";
import { EntityAnimation } from "../rendering/animation.js";
import { VisualTextures } from "../rendering/visual-resources.js";
import { entities } from "../rendering/stream-validation.js";
import { check } from "../rendering/stream-network.js";
import { mobFlipped } from "./mob-movement-metadata.js";

const MAX_PENDING_TEMPLATES = 2;
const PREFETCH_VIEWPORTS = 0.5;

/** Mob HP bar — 52×10 nested-frame gauge:
 *  Layer order (outer → inner): black 1px → white 1px → black 1px.
 *  Inner fill region is 46×4, split into top 3px HP-color fill + bottom 1px dark-red accent.
 *  Hidden when full or dead. */
const GAUGE_OUTER_W = 52;
const GAUGE_OUTER_H = 10;
const FRAME_PX = 1;       // thickness of each of the three frame layers
const FILL_H = 4;         // inner fill region height (top + bottom accent)
const FILL_COLOR_H = 3;   // top portion that shows HP-percent color
const FILL_ACCENT_H = 1;  // bottom accent row
const FILL_INSET = FRAME_PX * 3; // 3px total frame thickness on each side
const FILL_W = GAUGE_OUTER_W - FILL_INSET * 2; // 46
const FILL_Y = FRAME_PX * 3; // y=3, after 3 top frame layers

const COLOR_FRAME_BLACK = 0x000000;
const COLOR_FRAME_WHITE = 0xffffff;
const COLOR_ACCENT_DARK = 0x990000; // deeper red, avoids clashing with low-HP fill

// HP bar auto-hide: hide 5s after last hit, with 1.5s fade-out tail.
const HPBAR_SHOW_MS = 5000;
const HPBAR_FADE_MS = 1500;
const HPBAR_VISIBLE_WINDOW = HPBAR_SHOW_MS - HPBAR_FADE_MS; // 3500

export function createMobHpBar() {
  const bar = new Graphics();
  bar.eventMode = "none";
  bar.hitArea = null;
  bar.width = GAUGE_OUTER_W;
  bar.height = GAUGE_OUTER_H;
  bar._lastHp = -1;        // previous hp value, to detect damage
  bar._hitAt = 0;          // performance.now() timestamp of last detected damage
  return bar;
}

/** Draw the nested-frame HP bar.  All rects centered at x=0.
 *  Auto-hides 5 seconds after the last hp reduction, with a 1.5s linear fade. */
export function drawMobHpBar(bar, hp, maxHP) {
  const now = performance.now();
  bar.clear();

  // Detect a fresh hit: hp decreased since last draw
  if (bar._lastHp >= 0 && hp < bar._lastHp) {
    bar._hitAt = now;
  }
  bar._lastHp = hp;

  if (!maxHP || !hp || hp <= 0 || hp >= maxHP) {
    bar.visible = false;
    bar.alpha = 1;
    return;
  }

  // Decide visibility based on time since last hit
  const elapsed = now - bar._hitAt;
  if (bar._hitAt === 0) {
    // Never been hit — show once damage is detected; do not show brand-new full mob
    bar.visible = false;
    bar.alpha = 1;
    return;
  }
  if (elapsed > HPBAR_SHOW_MS) {
    bar.visible = false;
    bar.alpha = 1;
    return;
  }
  // Fade-out tail (last HPBAR_FADE_MS)
  if (elapsed > HPBAR_VISIBLE_WINDOW) {
    bar.alpha = Math.max(0, 1 - (elapsed - HPBAR_VISIBLE_WINDOW) / HPBAR_FADE_MS);
  } else {
    bar.alpha = 1;
  }

  bar.visible = true;
  const pct = hp / maxHP;
  const cx = -GAUGE_OUTER_W / 2; // gauge center at x=0 of parent

  // ------- three nested 1px black→white→black frames (as filled rects, not stroke) -------
  // outer black
  bar.rect(cx, 0, GAUGE_OUTER_W, FRAME_PX).fill(COLOR_FRAME_BLACK);                              // top
  bar.rect(cx, GAUGE_OUTER_H - FRAME_PX, GAUGE_OUTER_W, FRAME_PX).fill(COLOR_FRAME_BLACK);      // bottom
  bar.rect(cx, 0, FRAME_PX, GAUGE_OUTER_H).fill(COLOR_FRAME_BLACK);                             // left
  bar.rect(cx + GAUGE_OUTER_W - FRAME_PX, 0, FRAME_PX, GAUGE_OUTER_H).fill(COLOR_FRAME_BLACK);  // right
  // white frame (1px inset)
  bar.rect(cx + FRAME_PX, FRAME_PX, GAUGE_OUTER_W - FRAME_PX * 2, FRAME_PX).fill(COLOR_FRAME_WHITE);
  bar.rect(cx + FRAME_PX, GAUGE_OUTER_H - FRAME_PX * 2, GAUGE_OUTER_W - FRAME_PX * 2, FRAME_PX).fill(COLOR_FRAME_WHITE);
  bar.rect(cx + FRAME_PX, FRAME_PX, FRAME_PX, GAUGE_OUTER_H - FRAME_PX * 2).fill(COLOR_FRAME_WHITE);
  bar.rect(cx + GAUGE_OUTER_W - FRAME_PX * 2, FRAME_PX, FRAME_PX, GAUGE_OUTER_H - FRAME_PX * 2).fill(COLOR_FRAME_WHITE);
  // inner black frame (another 1px inset)
  bar.rect(cx + FRAME_PX * 2, FRAME_PX * 2, GAUGE_OUTER_W - FRAME_PX * 4, FRAME_PX).fill(COLOR_FRAME_BLACK);
  bar.rect(cx + FRAME_PX * 2, GAUGE_OUTER_H - FRAME_PX * 2 - FRAME_PX, GAUGE_OUTER_W - FRAME_PX * 4, FRAME_PX).fill(COLOR_FRAME_BLACK);
  bar.rect(cx + FRAME_PX * 2, FRAME_PX * 2, FRAME_PX, GAUGE_OUTER_H - FRAME_PX * 4).fill(COLOR_FRAME_BLACK);
  bar.rect(cx + GAUGE_OUTER_W - FRAME_PX * 3, FRAME_PX * 2, FRAME_PX, GAUGE_OUTER_H - FRAME_PX * 4).fill(COLOR_FRAME_BLACK);

  // ------- 46×4 fill region -------
  const fillX = cx + FILL_INSET; // cx + 3
  // full black background slot (shows through where HP fill does not reach)
  bar.rect(fillX, FILL_Y, FILL_W, FILL_H).fill(COLOR_FRAME_BLACK);
  // bottom 1px dark-red accent (full width, for depth)
  bar.rect(fillX, FILL_Y + FILL_COLOR_H, FILL_W, FILL_ACCENT_H).fill(COLOR_ACCENT_DARK);
  // top 3px — HP-percent color fill (width cropped by percent)
  const colorW = Math.round(FILL_W * pct);
  if (colorW > 0) {
    const fillColor = pct > 0.5 ? 0x4dd24d : pct > 0.25 ? 0xffaa33 : 0xff4444;
    bar.rect(fillX, FILL_Y, colorW, FILL_COLOR_H).fill(fillColor);
  }
}

export function createMobNameLabel(name) {
  const label = new Text({
    text: name ?? "",
    style: {
      fontFamily: "sans-serif",
      fontSize: 12,
      fill: 0xffffa0,
      align: "center",
      stroke: { color: 0x15202b, width: 3 },
    },
  });
  label.anchor.set(0.5, 0);
  label.eventMode = "none";
  return label;
}

/** Gameplay lives in mobs; this owner may discard/reacquire only presentation. */
export class OfflineMobRenderer {
  constructor(scene, mobs) {
    this.scene = scene;
    this.mobs = mobs;
    this.templates = new Map();
    this.destroyed = false;
    this.pending = 0;
    this.error = null;
    for (const mob of mobs) {
      this.registerTemplate(mob, scene.manifest);
    }
  }

  /** Foreign templates keep only their own validated texture metadata, not a map. */
  registerTemplate(mob, manifest) {
    const key = mob.record.template;
    if (this.templates.has(key)) return this.templates.get(key);
    const descriptor = manifest.life.renderables?.[key];
    if (!descriptor && !mob.defaultAction) return null;
    if (!descriptor) {
      throw new Error("Dynamic mob artwork missing from package");
    }
    entities([descriptor.entity], manifest);
    const textures = Object.create(null);
    const atlases = Object.create(null);
    for (const frames of Object.values(descriptor.entity.actions)) {
      for (const frame of frames) {
        for (const part of frame.parts) {
          const texture = manifest.textures[part.texture];
          textures[part.texture] = texture;
          atlases[texture.atlas] = manifest.atlases[texture.atlas];
        }
      }
    }
    const slot = {
      descriptor,
      manifest: { textures, atlases },
      values: [descriptor.entity],
      wanted: 0,
      reserved: 0,
      resources: null,
      controller: null,
      promise: null,
      ready: false,
      failed: false,
    };
    this.templates.set(key, slot);
    return slot;
  }

  /** Preparation holds demand until the caller publishes or rejects the new mob. */
  async prepareSpawn(mob, manifest, signal) {
    check(signal);
    const slot = this.registerTemplate(mob, manifest);
    if (!slot) throw new Error("Monster has no original artwork");
    slot.reserved++;
    try {
      if (slot.promise) await slot.promise;
      else if (!slot.ready) await this.load(slot);
      check(signal);
      if (this.destroyed || !slot.ready) {
        throw new Error("Monster artwork preparation was cancelled");
      }
      return slot;
    } catch (error) {
      slot.reserved--;
      throw error;
    }
  }

  wanted(mob) {
    if (!mob.active || !mob.visible) return false;
    const scene = this.scene;
    const bounds = this.templates.get(mob.record.template).descriptor.bounds;
    const marginX = scene.viewport.width * PREFETCH_VIEWPORTS;
    const marginY = scene.viewport.height * PREFETCH_VIEWPORTS;
    const radius = Math.max(Math.abs(bounds.left), Math.abs(bounds.right));
    return (
      mob.x + radius >= scene.camera.x - marginX &&
      mob.x - radius <= scene.camera.x + scene.viewport.width + marginX &&
      mob.y + bounds.bottom >= scene.camera.y - marginY &&
      mob.y + bounds.top <= scene.camera.y + scene.viewport.height + marginY
    );
  }

  countDemand() {
    for (const slot of this.templates.values()) slot.wanted = 0;
    for (const mob of this.mobs) {
      if (this.wanted(mob)) this.templates.get(mob.record.template).wanted++;
      else this.remove(mob);
    }
    for (const slot of this.templates.values()) {
      if (!slot.wanted && !slot.reserved) this.release(slot);
    }
  }

  async prepare(signal) {
    check(signal);
    this.countDemand();
    const cancel = this.destroy.bind(this);
    signal.addEventListener("abort", cancel, { once: true });
    try {
      for (const slot of this.templates.values()) {
        if (slot.wanted) await this.load(slot);
        check(signal);
      }
      this.instantiateDemand();
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  /** Called by scene demand scheduling, never by fixed-step simulation. */
  updateDemand() {
    if (this.destroyed) return;
    this.countDemand();
    this.instantiateDemand();
    for (const slot of this.templates.values()) {
      if (this.pending >= MAX_PENDING_TEMPLATES) break;
      if (!slot.wanted || slot.resources || slot.promise || slot.failed) {
        continue;
      }
      this.load(slot)
        .then(this.loaded.bind(this))
        .catch(this.failed.bind(this, slot));
    }
  }

  loaded() {
    if (!this.destroyed) this.instantiateDemand();
  }

  failed(slot, error) {
    if (error.name === "AbortError" || this.destroyed) return;
    slot.failed = true;
    this.error = error.message;
    this.scene.lastError = error.message;
  }

  async load(slot) {
    if (this.destroyed) return;
    const controller = new AbortController();
    const resources = new VisualTextures(slot.manifest, this.scene.atlases);
    slot.controller = controller;
    slot.resources = resources;
    slot.promise = resources.load(
      slot.values,
      controller.signal,
      slot.descriptor.atlases,
    );
    this.pending++;
    try {
      await slot.promise;
      check(controller.signal);
      if (!this.destroyed && slot.resources === resources) slot.ready = true;
    } catch (error) {
      resources.destroy();
      if (slot.resources === resources) {
        slot.resources = null;
        slot.ready = false;
      }
      throw error;
    } finally {
      if (slot.controller === controller) slot.promise = null;
      this.pending--;
    }
  }

  instantiateDemand() {
    for (const mob of this.mobs) {
      if (mob.presentation || !this.wanted(mob)) continue;
      const slot = this.templates.get(mob.record.template);
      if (!slot.ready) continue;
      const source = {
        ...slot.descriptor.entity,
        id: mob.id,
        kind: "mob",
        order: 100000 + Number(mob.id.slice(5)),
        x: mob.x,
        y: mob.y,
        z: 239991, // Native uncontacted plane7/group0; synchronize applies live contact.
      };
      const presentation = new EntityAnimation(source, slot.resources.textures);
      presentation.gameplayOwned = true;
      mob.presentation = presentation;
      const label = createMobNameLabel(mob.template.name);
      presentation.container.addChild(label);
      mob.nameLabel = label;
      // HP bar: only show if template doesn't suppress it
      if (!mob.template.info.HPgaugeHide) {
        const hpBar = createMobHpBar();
        hpBar.position.set(0, 0); // real position set in synchronizeMob
        presentation.container.addChild(hpBar);
        mob.hpBar = hpBar;
      }
      this.synchronizeMob(mob);
      try {
        this.scene.addDynamicEntity(presentation);
        this.scene.registerPresentationContainer(label);
        if (mob.hpBar) this.scene.registerPresentationContainer(mob.hpBar);
      } catch (error) {
        this.scene.unregisterPresentationContainer(label);
        if (mob.hpBar) this.scene.unregisterPresentationContainer(mob.hpBar);
        mob.presentation = null;
        presentation.container.destroy({ children: true });
        label.destroy();
        if (mob.hpBar) { mob.hpBar.destroy(); mob.hpBar = null; }
        mob.nameLabel = null;
        throw error;
      }
    }
  }

  /** Original frame selection is projected from simulation, never RAF time. */
  synchronizeMob(mob) {
    const entity = mob.presentation;
    if (!entity) return;
    entity.setPosition(mob.x, mob.y);
    entity.container.scale.x = mobFlipped(mob) ? -1 : 1;
    entity.container.visible =
      mob.visible &&
      !this.scene.offlineField?.hooks.skillTargetController?.()?.hidesBody(mob);
    entity.container.alpha = mob.opacity;
    this.synchronizeDepth(mob, entity);
    // Update HP bar: position atop mob head, centered horizontally, flip reversal, animated fill
    if (mob.hpBar) {
      const slot = this.templates.get(mob.record.template);
      const b = slot?.descriptor?.bounds;
      // bounds is {left, right, top, bottom} where top<0 (head above feet anchor=0)
      const height = b?.top ?? -30; // e.g. -40 means head is 40px above the foot anchor
      mob.hpBar.position.set(0, height - 10);
      // Flip reversal: container.scale.x=-1 flips the bar; undo with same scale
      mob.hpBar.scale.x = entity.container.scale.x; // -1 × -1 = +1
      drawMobHpBar(mob.hpBar, mob.hp, mob.maxHP);
    }
    const once =
      !mob.alive ||
      mob.state === "spawning" ||
      mob.state === "hit" ||
      mob.state === "attack";
    entity.setAction(mob.action, once ? "once" : "loop");
    entity.seek(mob.actionMs);
    this.synchronizeName(mob);
  }

  /** 00664e35: controller3 uses its own aerial plane, not an authored floor. */
  synchronizeDepth(mob, entity) {
    const foothold = mob.foothold;
    const depth =
      mob.movementType === 3
        ? 270100
        : foothold
          ? 29991 + (foothold.layer * 3000 - foothold.group) * 10
          : 239991;
    this.scene.setEntityDepth(entity, depth);
  }

  /** Nameplates counter the body's flip and obey authored suppression flags. */
  synchronizeName(mob) {
    const label = mob.nameLabel;
    if (label) {
      label.position.set(0, 4);
      label.scale.x = mob.presentation.container.scale.x;
      label.visible =
        mob.visible &&
        mob.nameRemainingMs > 0 &&
        !mob.template.info.hideName &&
        !mob.template.info.HPgaugeHide &&
        !mob.template.info.damagedByMob &&
        Boolean(mob.template.name);
    }
  }

  synchronize() {
    for (const mob of this.mobs) this.synchronizeMob(mob);
  }

  remove(mob) {
    if (!mob.presentation) return;
    if (mob.nameLabel) {
      this.scene.unregisterPresentationContainer(mob.nameLabel);
    }
    mob.nameLabel?.destroy();
    mob.nameLabel = null;
    if (mob.hpBar) {
      this.scene.unregisterPresentationContainer(mob.hpBar);
      mob.hpBar.destroy();
      mob.hpBar = null;
    }
    this.scene.removeDynamicEntity(mob.id);
    mob.presentation.container.destroy({ children: true });
    mob.presentation = null;
  }

  release(slot) {
    slot.controller?.abort();
    slot.resources?.destroy();
    slot.resources = null;
    slot.ready = false;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const mob of this.mobs) this.remove(mob);
    for (const slot of this.templates.values()) this.release(slot);
  }
}
