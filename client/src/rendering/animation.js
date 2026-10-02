import { Container, Sprite } from "pixi.js";
import { EquipmentEffects } from "../items/equipment-effects.js";
import {
  compileAction,
  timedFrame,
  advanceActionClock,
  seekActionClock,
} from "./animation-timing.js";

// 0092ff77..009300f4: rotating parent at feet-20, child(-10,0), period2000.
const GHOST_PERIOD_MS = 2000;
const GHOST_RADIUS = 10;
const GHOST_CENTER_Y = -20;

/** Blink scheduling — user-facing timing.
 *  Every 5-8 s, roll a 4-way uniform decision:
 *    0 → skip this round (no blink)
 *    1 → 1 quick blink  (expressionLoopMs ≈ 480 ms)
 *    2 → 2 quick blinks (≈ 960 ms total)
 *    3 → 3 quick blinks (≈ 1440 ms total)
 *  Before the expressionLoopMs fix (was incorrectly using expressionDuration=5000),
 *  consecutive blinks looked pathological — each blink lasted 5 s instead of 480 ms.
 *  Now each blink is one clean sub-frame cycle, so 2-3 in a row reads as a quick
 *  natural double/triple blink rather than a stuck state. */
const BLINK_IDLE_MIN_MS = 5000;
const BLINK_IDLE_RANGE_MS = 3000;
const BLINK_MODES = 4;

/** Shape2D51406ffa..51407045 rounds rotated vectors before adding their origin. */
function vectorPixel(value) {
  return Math.trunc(value + (value >= 0 ? 0.5 : -0.499999999));
}

/** @typedef {{texture:string,x:number,y:number,z:number,flip?:boolean,opacity?:number,expression?:string,expressionStart?:number,expressionEnd?:number,expressionLoopMs?:number,expressionDuration?:number}} Part */
/** @typedef {{delay:number,parts:Part[],alphaEnd?:number,repeat?:number,sourceSize?:{width:number,height:number},rotate?:number,flip?:boolean,moveX?:number,moveY?:number,alias?:boolean,preAction?:boolean,poseAction?:string,poseIndex?:number}} Frame */
/** @typedef {{type:number,rx:number,ry:number,cx:number,cy:number,canvas:{width:number,height:number,scale:number}}} Background */
/** @typedef {{id:string,order:number,kind:string,x:number,y:number,z:number,visible:boolean,flip:boolean,opacity:number,action:string,actions:Record<string,Frame[]>,background?:Background}} Entity */

function repetitionType(type) {
  if (type < 4) return type;
  if (type === 4) return 1;
  if (type === 5) return 2;
  return 3;
}

/** A persistent container and sprite pool; changing frames never builds display objects. */
export class EntityAnimation {
  /** @param {Entity} entity @param {Map<string, import('pixi.js').Texture>} textures */
  constructor(entity, textures) {
    this.id = entity.id;
    this.kind = entity.kind;
    this.avatar = entity.avatar;
    this.order = entity.order;
    this.textures = textures;
    this.background = entity.background;
    this.repeat = entity.background
      ? repetitionType(entity.background.type)
      : 0;
    this.backgroundLayout = {
      firstX: 0,
      lastX: 0,
      firstY: 0,
      lastY: 0,
      cx: 0,
      cy: 0,
    };
    if (this.background) this.configureBackground();
    this.elapsedMs = 0;
    this.expression = "default";
    this.expressionMs = 0;
    this.expressionElapsedMs = 0;
    this.expressionTimeMs = 0;
    this.expressionLoopMs = 0;
    this.expressionLoops = new Map();
    this.expressionDurations = new Map();
    this.actions = new Map();
    this.expressions = new Set(["default"]);
    /** Auto-blink scheduling state. Only active for character entities that
     *  have a compiled `blink` face expression. */
    this.blinkState = {
      /** Countdown until the next blink decision (ms). 0 = immediate decision. */
      nextDecisionMs: 0,
      /** Remaining consecutive blinks in the current run. */
      remainingBlinks: 0,
      /** True when a `blink` call is currently playing. */
      blinking: false,
    };
    this.tint = 0xffffff;
    this.container = new Container({ label: entity.id });
    this.setPosition(entity.x, entity.y);
    this.container.zIndex = entity.z;
    this.container.depthOrder = entity.order;
    this.container.visible = entity.visible !== false;
    this.container.alpha = entity.opacity ?? 1;
    this.container.scale.x = entity.flip ? -1 : 1;
    let capacity = 0;
    for (const [name, frames] of Object.entries(entity.actions)) {
      const action = compileAction(frames, textures);
      this.actions.set(name, action);
      for (const parts of action.parts) {
        capacity = Math.max(capacity, parts.length);
        for (const part of parts) {
          this.registerExpression(part);
        }
      }
    }
    this.createSpritePool(capacity);
    this.action = "";
    this.frame = -1;
    this.actionTimeMs = 0;
    this.holdFrame = false;
    this.setAction(entity.action);
    this.equipmentEffects = entity.avatar?.equipmentEffect
      ? new EquipmentEffects(this, entity.avatar.equipmentEffect, textures)
      : null;
  }

  createSpritePool(capacity) {
    this.poseLayer = this.kind === "character" ? new Container() : null;
    if (this.poseLayer) this.container.addChild(this.poseLayer);
    this.sprites = new Array(capacity);
    for (let index = 0; index < capacity; index++) {
      const sprite = new Sprite();
      sprite.visible = false;
      this.sprites[index] = sprite;
      (this.poseLayer ?? this.container).addChild(sprite);
    }
  }

  /** Compile immutable expression periods outside animation updates. */
  registerExpression(part) {
    if (!part.expression) return;
    this.expressions.add(part.expression);
    if (part.expressionDuration !== undefined) {
      const duration = this.expressionDurations.get(part.expression);
      if (duration !== undefined && duration !== part.expressionDuration) {
        throw new Error("Inconsistent avatar expression duration");
      }
      this.expressionDurations.set(part.expression, part.expressionDuration);
    }
    if (part.expressionLoopMs === undefined) return;
    const previous = this.expressionLoops.get(part.expression);
    if (previous !== undefined && previous !== part.expressionLoopMs) {
      throw new Error("Inconsistent avatar expression period");
    }
    this.expressionLoops.set(part.expression, part.expressionLoopMs);
  }

  /** Repeating the same name/mode is idempotent unless a pooled lease restarts it.
   * Omitted playback honors original repeat; explicit consumer modes override it.
   * @param {string} name @param {'loop'|'once'} [playback] @param {boolean} [restart] */
  setAction(name, playback, restart = false) {
    const next = this.actions.get(name);
    if (!next) throw new Error(`Unknown action ${name} for ${this.id}`);
    if (playback === undefined) playback = next.repeat < 0 ? "once" : "loop";
    if (playback !== "loop" && playback !== "once") {
      throw new Error(`Unknown animation playback ${playback}`);
    }
    if (!restart && this.action === name && this.playback === playback) return;
    this.action = name;
    this.playback = playback;
    this.current = next;
    this.actionTimeMs = 0;
    this.elapsedMs = 0;
    this.completed = playback === "once" && next.duration === 0;
    this.frame = -1;
    this.selectTimedFrame();
  }

  /** Original avatar tint does not propagate into independent name overlays. */
  setTint(tint) {
    if (tint === this.tint) return;
    this.tint = tint;
    for (const sprite of this.sprites) sprite.tint = tint;
  }
  /** Select a packaged face family independently from the body action clock. */
  setExpression(name, duration) {
    if (
      !this.expressions.has(name) ||
      !Number.isFinite(duration) ||
      duration < 0
    ) {
      throw new Error("Invalid avatar expression");
    }
    this.expression = name;
    this.expressionMs = duration;
    this.expressionElapsedMs = 0;
    this.expressionTimeMs = 0;
    this.expressionLoopMs = this.expressionLoops.get(name) ?? 0;
    if (this.frame >= 0) this.applyFrame(this.frame);
  }

  advanceExpression(ms) {
    if (this.expressionMs <= 0) return;
    this.expressionMs = Math.max(0, this.expressionMs - ms);
    // 004534a2..bd selects default, not a saved previous emotion.
    if (this.expressionMs === 0) {
      this.setExpression("default", 0);
      return;
    }
    this.expressionElapsedMs += ms;
    this.expressionTimeMs =
      this.expressionLoopMs > 0
        ? this.expressionElapsedMs % this.expressionLoopMs
        : 0;
    const parts = this.current.parts[this.frame];
    for (let i = 0; i < this.sprites.length; i++) {
      this.sprites[i].visible = this.expressionVisible(parts[i]);
    }
  }

  /** Half-open authored face-frame intervals advance independently of body frames. */
   *  Real extracted data structure confirmed: body/weapon/equipment parts carry
   *  NO expression field (always visible), while face variants (default, blink,
   *  hit, smile, ...) DO carry expression. The match-based filter below is
   *  therefore correct — only face variants participate in expression gating.
   *  GM-source L1339-L1342 handles face/weapon visibility via separate part
   *  categories — openms flattens everything into one list so we rely on
   *  absence of expression on non-face parts to keep them visible. */
  expressionVisible(part) {
    if (!part) return false;
    if (!part.expression) return true;
    if (part.expression !== this.expression) return false;
    return (
      part.expressionStart === undefined ||
      (this.expressionTimeMs >= part.expressionStart &&
        this.expressionTimeMs < part.expressionEnd)
    );
  }

  /** Player callers supply only the simulation's executed quantum.
   * @param {number} ms */
  advance(ms) {
    const advanced = advanceActionClock(this, ms);
    this.advanceExpression(ms);
    this.advanceBlink(ms);
    this.applyDeathMotion();
    this.equipmentEffects?.advance(ms);
    if (advanced) this.selectTimedFrame();
  }

  /** Automatic blink scheduler for character entities that have a `blink` face
   *  expression. Mirrors GM MapleCharacter.pas L1290-L1332 and sdlms run_face_animate:
   *  4-mode random decision (0 = skip, 1..3 = consecutive blinks) every 3-6 s.
   *  Unlike the previous attempt, this runs ALWAYS (mirroring GM source which
   *  does NOT gate blink scheduling on body pose) — the expressionVisible fix
   *  guarantees that blink+attack won't hide weapon/body parts with expression:"default".
   *  Non-default face expressions (player-triggered smile/wink/etc.) suppress
   *  the blink scheduler so they play out completely. */
  advanceBlink(ms) {
    if (this.kind !== "character" || !this.expressions.has("blink")) return;

    // A blink is currently playing — let it finish. advanceExpression handles
    // the duration countdown; we just mark blinking for the post-blink branch.
    if (this.expression === "blink") {
      this.blinkState.blinking = true;
      return;
    }

    // Player-triggered non-default expression (smile, wink, oops, ...) takes
    // full control — pause the idle blink scheduler but keep existing counters.
    // When expression returns to default, normal scheduling resumes.
    if (this.expression !== "default") return;

    // Just returned from a blink to default — decide whether consecutive.
    // remainingBlinks tracks how many total blinks this round still needs.
    if (this.blinkState.blinking) {
      this.blinkState.blinking = false;
      if (this.blinkState.remainingBlinks > 1) {
        this.blinkState.remainingBlinks -= 1;
        this._triggerBlink();
        return;
      }
      // Final blink in the round — reset counters, schedule next decision.
      this.blinkState.remainingBlinks = 0;
      this.blinkState.nextDecisionMs =
        BLINK_IDLE_MIN_MS + Math.random() * BLINK_IDLE_RANGE_MS;
      return;
    }

    // Regular scheduler countdown. Always runs (mirror GM source FaceCount
    // which increments every frame regardless of body action).
    if (this.blinkState.nextDecisionMs > 0) {
      this.blinkState.nextDecisionMs -= ms;
      if (this.blinkState.nextDecisionMs > 0) return;
      this.blinkState.nextDecisionMs = 0;
    }

    // 4-way uniform roll: 0 = skip, 1 = single, 2 = double, 3 = triple.
    // remainingBlinks IS the TOTAL count this round (post-blink decrements when > 1).
    const mode = Math.floor(Math.random() * BLINK_MODES);
    if (mode === 0) {
      this.blinkState.nextDecisionMs =
        BLINK_IDLE_MIN_MS + Math.random() * BLINK_IDLE_RANGE_MS;
      return;
    }
    this.blinkState.remainingBlinks = mode;
    this._triggerBlink();
  }

  _triggerBlink() {
    // expressionLoops holds the authored per-expression cycle (480 ms for blink
    // from extracted data), while expressionDuration is a generic 5-second
    // max-lifetime shared by ALL face expressions — not the blink animation
    // duration. GM source uses a multi-frame FaceFrame/FaceTime mechanism; we
    // collapse it into one expressionLoopMs cycle here.
    const loopMs = this.expressionLoops.get("blink");
    const duration = Number.isFinite(loopMs) && loopMs > 0
      ? loopMs
      : this.expressionDurations.get("blink");
    if (!Number.isFinite(duration) || duration <= 0) return;
    this.setExpression("blink", duration);
  }

  /** Seek an authoritative action clock without exposing mutable frame bookkeeping.
   * Resuming a completed one-shot at an earlier time clears completion.
   * @param {number} ms Elapsed milliseconds since the current action began. */
  seek(ms) {
    seekActionClock(this, ms);
    this.selectTimedFrame();
    this.applyDeathMotion();
  }

  selectTimedFrame() {
    const frame = timedFrame(this.current, this.actionTimeMs);
    if (frame !== this.frame) this.applyFrame(frame);
    this.applyAlpha();
  }

  /** @param {number} index */
  applyFrame(index) {
    this.frame = index;
    this.applyPoseTransform(this.current.frames[index]);
    const parts = this.current.parts[index];
    for (let i = 0; i < this.sprites.length; i++) {
      const sprite = this.sprites[i];
      const part = parts[i];
      sprite.visible = this.expressionVisible(part);
      if (!part) continue;
      const texture = this.textures.get(part.texture);
      sprite.tint = this.tint;
      sprite.texture = texture;
      sprite.position.set(part.x + (part.flip ? texture.width : 0), part.y);
      sprite.scale.set(part.flip ? -1 : 1, 1);
      sprite.alpha = part.opacity ?? 1;
    }
    this.applyDeathMotion();
    this.equipmentEffects?.sync();
  }

  /** 004522a6 + Gr2D5040d98b reflect final rotated vertices around the actor origin. */
  applyPoseTransform(frame) {
    if (!this.poseLayer) return;
    const angle = frame.rotate ?? 0;
    const direction = frame.flip ? -1 : 1;
    this.poseLayer.rotation = (direction * angle * Math.PI) / 180;
    this.poseLayer.scale.set(direction, 1);
    // In the zero-angle branch alias flip does not reflect the authored move.
    const moveDirection = angle === 0 ? 1 : direction;
    this.poseLayer.position.set(
      moveDirection * (frame.moveX ?? 0),
      frame.moveY ?? 0,
    );
  }

  /** Move only the composed ghost, never the actor origin, tomb or physics feet.
   * Native rotation is in world coordinates, independent of artwork facing. */
  applyDeathMotion() {
    if (this.kind !== "character" || this.action !== "dead") return;
    const angle =
      ((this.elapsedMs % GHOST_PERIOD_MS) * Math.PI * 2) / GHOST_PERIOD_MS;
    const x =
      vectorPixel(-GHOST_RADIUS * Math.cos(angle)) *
      (this.container.scale.x < 0 ? -1 : 1);
    const y = GHOST_CENTER_Y + vectorPixel(-GHOST_RADIUS * Math.sin(angle));
    const parts = this.current.parts[this.frame];
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      const sprite = this.sprites[index];
      sprite.position.set(
        part.x + (part.flip ? sprite.texture.width : 0) + x,
        part.y + y,
      );
    }
  }

  applyAlpha() {
    const end = this.current.frames[this.frame].alphaEnd;
    if (end === undefined) return;
    const elapsed =
      this.actionTimeMs - (this.frame ? this.current.ends[this.frame - 1] : 0);
    const duration = this.current.frames[this.frame].delay;
    const parts = this.current.parts[this.frame];
    if (duration === 0) {
      for (let i = 0; i < parts.length; i++) this.sprites[i].alpha = end;
      return;
    }
    for (let i = 0; i < parts.length; i++) {
      const start = Math.round((parts[i].opacity ?? 1) * 255);
      const target = Math.round(end * 255);
      // Original Shape2D 5140809f uses signed integer division.
      this.sprites[i].alpha =
        (start + Math.trunc(((target - start) * elapsed) / duration)) / 255;
    }
  }

  /** @param {number} x @param {number} y */
  setPosition(x, y) {
    // Quantize the whole composition, not each GPU vertex at an unstable half-pixel tie.
    if (this.kind !== "ui") {
      x = Math.trunc(x);
      y = Math.trunc(y);
    }
    this.baseX = x;
    this.baseY = y;
    this.container.position.set(x, y);
  }

  /** 0063e397/e3eb: first original canvas fixes periods, including its storage scale. */
  configureBackground() {
    const bg = this.background;
    const overlap = 2 ** bg.canvas.scale - 1;
    this.backgroundLayout.cx = bg.cx || bg.canvas.width - overlap;
    this.backgroundLayout.cy = bg.cy || bg.canvas.height - overlap;
    const speed =
      bg.type === 4 || bg.type === 6
        ? bg.rx
        : bg.type === 5 || bg.type === 7
          ? bg.ry
          : 0;
    this.backgroundScrollStep = Math.sign(speed) * 100;
    this.backgroundScrollDuration =
      speed === 0 ? 0 : Math.trunc(20000 / Math.abs(speed));
  }

  /** Reserve all repetition sprites outside rendering for the current bounded viewport. */
  prepareBackground(viewport, available = 10000) {
    const layout = this.backgroundLayout;
    let capacity = 1;
    for (const action of this.actions.values()) {
      for (let index = 0; index < action.parts.length; index++) {
        const geometry = action.geometry[index];
        const columns =
          Math.ceil((viewport.width + geometry.width) / layout.cx) + 3;
        const rows =
          Math.ceil((viewport.height + geometry.height) / layout.cy) + 3;
        const copies =
          (this.repeat & 1 ? columns : 1) * (this.repeat & 2 ? rows : 1);
        capacity = Math.max(capacity, copies * action.parts[index].length);
      }
    }
    if (capacity > 10000 || capacity > available) {
      throw new Error(`Background pool exceeds browser limit: ${this.id}`);
    }
    while (this.sprites.length < capacity) {
      const sprite = new Sprite();
      sprite.visible = false;
      this.sprites.push(sprite);
      this.container.addChild(sprite);
    }
  }

  /** 00639708 resets the native center to zero BEFORE background attachment.
   * Its positive parent cancels the field camera, unlike ordinary map objects.
   * @param {{x:number,y:number}} camera Top-left world pixel.
   * @param {{width:number,height:number}} viewport
   */
  positionBackground(camera, viewport) {
    const bg = this.background;
    const autoX = bg.type === 4 || bg.type === 6,
      autoY = bg.type === 5 || bg.type === 7;
    const centerX = Math.trunc(camera.x) + Math.trunc(viewport.width / 2),
      centerY = Math.trunc(camera.y) + Math.trunc(viewport.height / 2);
    // 0063df23..0063e02a: signed 100px extrapolation with integer duration.
    const scroll =
      this.backgroundScrollDuration === 0
        ? 0
        : -this.backgroundScrollStep +
          Math.trunc(
            (this.elapsedMs * this.backgroundScrollStep) /
              this.backgroundScrollDuration,
          );
    const px =
      this.baseX +
      (autoX
        ? scroll
        : autoY
          ? Math.trunc((centerX * (bg.rx + 100)) / 100)
          : centerX + Math.trunc((centerX * bg.rx) / 100));
    const py =
      this.baseY +
      (autoY
        ? scroll
        : autoX
          ? Math.trunc((centerY * (bg.ry + 100)) / 100)
          : centerY + Math.trunc((centerY * bg.ry) / 100));
    this.container.position.set(px, py);
  }

  layoutBackground(camera, viewport) {
    const geometry = this.current.geometry[this.frame];
    const layout = this.backgroundLayout;
    const screenX = this.container.x - camera.x;
    const screenY = this.container.y - camera.y;
    const flip = this.container.scale.x < 0;
    const left = flip ? screenX - viewport.width : -screenX;
    const right = flip ? screenX : viewport.width - screenX;
    layout.firstX =
      this.repeat & 1
        ? Math.floor((left - geometry.x - geometry.width) / layout.cx) + 1
        : 0;
    layout.lastX =
      this.repeat & 1 ? Math.ceil((right - geometry.x) / layout.cx) - 1 : 0;
    layout.firstY =
      this.repeat & 2
        ? Math.floor((-screenY - geometry.y - geometry.height) / layout.cy) + 1
        : 0;
    layout.lastY =
      this.repeat & 2
        ? Math.ceil((viewport.height - screenY - geometry.y) / layout.cy) - 1
        : 0;
  }

  drawBackground() {
    const layout = this.backgroundLayout;
    const parts = this.current.parts[this.frame];
    const count =
      Math.max(0, layout.lastX - layout.firstX + 1) *
      Math.max(0, layout.lastY - layout.firstY + 1) *
      parts.length;
    if (count > this.sprites.length) {
      throw new Error(
        `Background pool requires resize preparation: ${this.id}`,
      );
    }
    let index = 0;
    for (let y = layout.firstY; y <= layout.lastY; y++) {
      for (let x = layout.firstX; x <= layout.lastX; x++) {
        index = this.drawBackgroundCopy(index, x, y);
      }
    }
    for (; index < this.sprites.length; index++) {
      this.sprites[index].visible = false;
    }
  }

  drawBackgroundCopy(index, x, y) {
    const parts = this.current.parts[this.frame],
      layout = this.backgroundLayout;
    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const part = parts[partIndex],
        texture = this.textures.get(part.texture);
      const sprite = this.sprites[index++];
      sprite.texture = texture;
      sprite.visible = true;
      sprite.alpha = this.sprites[partIndex].alpha;
      sprite.position.set(
        part.x + x * layout.cx + (part.flip ? texture.width : 0),
        part.y + y * layout.cy,
      );
      sprite.scale.set(part.flip ? -1 : 1, 1);
    }
    return index;
  }

  updateBackground(camera, viewport) {
    this.positionBackground(camera, viewport);
    this.layoutBackground(camera, viewport);
    this.drawBackground();
  }

  snapshot() {
    const node = this.container;
    return {
      id: this.id,
      kind: this.kind,
      action: this.action,
      playback: this.playback,
      completed: this.completed,
      frame: this.frame,
      actionTimeMs: this.actionTimeMs,
      elapsedMs: this.elapsedMs,
      expression: this.expression,
      expressionMs: this.expressionMs,
      expressionElapsedMs: this.expressionElapsedMs,
      actions: [...this.actions.keys()],
      visible: node.visible,
      x: this.background ? this.baseX : node.x,
      y: this.background ? this.baseY : node.y,
      z: node.zIndex,
      depthOrder: node.depthOrder,
      geometry: { ...this.current.geometry[this.frame] },
      flip: node.scale.x < 0,
      opacity: node.alpha,
    };
  }
}
