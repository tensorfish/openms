import { GameUI } from "../ui/game-ui.js";
import { ProfileControls } from "../ui/ui-inspection.js";
import { KeyBindings } from "../input/key-bindings.js";
import { allocationPoints } from "../skills/skill-allocation-rules.js";
import { mountQuestJournal } from "../ui/ui-quest-window.js";
import { QuestReadyNotification } from "../ui/ui-quest-ready-notification.js";
import { NativeAvatarPortrait } from "../ui/ui-avatar-portrait.js";
import { skillImpulseFor } from "./optimistic-skill.js";
import { AvatarVisuals } from "../character/avatar-visuals.js";
import { AudiovisualSystem } from "../audio/audiovisual-system.js";
import {
  NativeProfileSource,
  NativeOperationRefusal,
  nativeOutcome,
  unsupported,
} from "./native-source.js";
import { NativeInventory } from "./native-inventory.js";
import { NativeQuests } from "./native-quests.js";
import { NativeMacros } from "./native-macros.js";
import { NativeDialogue } from "./native-dialogue.js";
import { NativeShop } from "./native-shop.js";
import { NativeTrade } from "./native-trade.js";
import { NativeEffects } from "./native-effects.js";
import { NativeSkillPresentation } from "./native-skill-presentation.js";
import { LocalCombat } from "./local-combat.js";
import { NativeSocial } from "./native-social.js";
import { NativeCashShop } from "./native-cash-shop.js";
import { NativeMarket } from "./native-market.js";
import { NativeStorage } from "./native-storage.js";
import { NativeMonsterBook } from "./native-monster-book.js";
import { NativeWorldActions } from "./native-world-actions.js";
import { NativeTransitions } from "./native-transitions.js";
import { nearestPickupDrop } from "./scene-drops.js";

const CHAT_BINDINGS = {
  ChatAll: 7,
  ChatWhisper: 6,
  ChatParty: 2,
  ChatBuddy: 0,
  ChatGuild: 3,
  ChatSpouse: 5,
  ChatAlliance: 4,
};
const USER_TABS = Object.freeze({ Friends: 0, Guild: 2, Party: 1 });
const EMPTY_ENTITIES = Object.freeze([]);
function conversationIdentity(event) {
  return (
    event.conversationId ??
    event.shopSession ??
    event.tradeId ??
    event.storageSession
  );
}
function interactionKey(event) {
  return `${conversationIdentity(event)}:${event.part ?? ""}`;
}
const PROFILE_EDITOR_NOTICE =
  "Profile and preset editing requires an authorized GM developer session.";

/** Explain the empty character host instead of leaving an unauthorized section blank. */
function profileEditorNotice() {
  const host = document.querySelector("#inspection-controls");
  if (!host || host.querySelector("[data-developer-only]")) return null;
  const text = document.createElement("p");
  text.className = "hint";
  text.dataset.developerOnly = "";
  text.textContent = PROFILE_EDITOR_NOTICE;
  host.append(text);
  return null;
}

/** Shared native presentation with read-only publication ports and closed server intents. */
export class OnlineUI {
  constructor(app, services, transport, hooks) {
    this.app = app;
    this.services = services;
    this.transport = transport;
    this.hooks = hooks;
    this.state = null;
    this.connection = null;
    this.catalog = null;
    this.pending = 0;
    this.blockingPending = 0;
    this.nextCast = null;
    this.operationIdle = null;
    this.destroyed = false;
    this.store = new NativeProfileSource(this);
    this.localCombat = new LocalCombat(this);
    this.audio = new AudiovisualSystem(app, services, {
      onError: (error) => this.report(error),
      onEnabled: () => this.skillVisuals.enableAudio(),
    });
    services.audio = this.audio.audio;
    this.social = new NativeSocial(this);
    this.worldActions = new NativeWorldActions(this);
    this.ui = new GameUI(app, services, this.nativeHooks());
    this.ui.setVisible(false);
    this.dialogue = new NativeDialogue(this);
    this.effects = new NativeEffects(this);
    this.skillVisuals = new NativeSkillPresentation(this);
    this.questReady = new QuestReadyNotification(this.ui);
    this.transitions = new NativeTransitions(this);
    this.storage = null;
    this.cash = null;
    this.book = null;
    this.tradeTerminal = null;
    this.shop = null;
    this.trade = null;
    this.shopPages = new Map();
    this.interactionSignatures = new Map();
  }
  get scene() {
    return this.hooks.scene()?.scene ?? null;
  }
  get entities() {
    return (
      this.transport.model?.entities ?? this.state?.entities ?? EMPTY_ENTITIES
    );
  }
  /** Live peer footsteps for the minimap. The buffer is reused, so the per-frame call
   *  allocates nothing; the panel only draws as many as its own bounded marker pool. */
  minimapPeers() {
    const scene = this.hooks.scene();
    const buffer = (this.minimapPeerBuffer ??= []);
    let count = 0;
    if (scene) {
      for (const view of scene.views.values()) {
        if (view.entity.kind !== "player" || view.entity.id === scene.selfId) {
          continue;
        }
        const slot = buffer[count] ?? (buffer[count] = { x: 0, y: 0 });
        slot.x = view.drawX;
        slot.y = view.drawY;
        count++;
      }
    }
    buffer.length = count;
    return buffer;
  }

  nativeHooks() {
    return {
      ...this.profileHooks(),
      ...this.interactionHooks(),
      ...this.audioHooks(),
      clearInput: this.hooks.clearInput,
      keyDown: this.hooks.keyDown,
      inputGeneration: this.hooks.inputGeneration,
      focusGame: this.hooks.focusGame,
      now: () => performance.now(),
      onError: (error) => this.report(error),
      onStatus: (text) => this.hooks.onStatus?.(text),
      onAction: (name) => this.activateBinding(name),
      onCloseWindow: (name) => this.windowClosed(name),
      isOperationPending: () => !this.destroyed && this.blockingPending > 0,
      isFieldBlocked: () => this.blocked(),
      windowCapability: (name) => this.windowCapability(name),
      isWorldInteractive: (x, y) =>
        this.hooks.scene()?.isInteractive?.(x, y) ?? false,
      mapName: (id) => this.catalog?.mapNames[id] ?? null,
      ...this.social.nativeHooks(),
    };
  }
  profileHooks() {
    return {
      createProfileControls: (owner) =>
        import.meta.OPENMS_DEVELOPMENT === false
          ? null
          : this.developer()
            ? new ProfileControls(owner)
            : profileEditorNotice(),
      onProfileEdit: (patch, options) => this.editProfile(patch, options),
      onConjureItem: ({ itemId, quantity }) =>
        this.develop({ kind: "conjure", itemId, quantity }),
      onOfferTemplate: (id) => this.offerTemplate(id),
      profileEditSuccess: "Profile edits committed by the server.",
      onLearnSkill: (skillId) =>
        this.request({ kind: "skills.allocate", skillId, amount: 1 }),
      skillAllocationError: (id) => this.skillAllocationError(id),
      skillAllocationPoints: (id) => this.skillPoints(id),
      apAdmission: () => ({
        ok: this.store.profile?.remainingAp > 0 && !this.blocked(),
        reason: "No available AP or active server field.",
      }),
      spendAp: (stat) =>
        this.request({ kind: "stats.allocate", stat, amount: 1 }),
      confirmAp: () =>
        this.ui.prompt({
          kind: "confirm",
          text: "If you invest your AP in HP or MP, your character may have\\r\\ninsufficient stats to become as strong as it could be.\\r\\nDo you still wish to raise this skill?",
        }),
      characterStats: () => this.state?.presentation.stats,
      minimapPeers: () => this.minimapPeers(),
      petEquipmentUnavailable: () => unsupported("pet equipment").reason,
      onRecover: () => {
        this.ui.showRevival(this.scene).catch((error) => this.report(error));
        return true;
      },
      onRevive: () =>
        this.persist({ kind: "revive.request", method: "return" }),
    };
  }
  windowClosed(name) {
    if (this.destroyed || this.ui.closingAll) return;
    if (name === "PartyHP") {
      this.ui.windows.get("UserList")?.localRefresh?.();
    }
    this.ui.profileControls?.refresh();
  }
  interactionHooks() {
    return {
      openLocalTrade: () => this.inviteTrade(),
      inventoryActions: () => this.inventory,
      skillUtilities: () => ({ enhancement: this.inventory }),
      shop: () => this.shop,
      trade: () => this.trade,
      macros: () => this.macros,
      cashShop: () => this.cashShop(),
      market: () => {
        this.market?.destroy();
        return (this.market = new NativeMarket(this));
      },
      storage: () => this.storage,
      monsterBook: () => this.book,
      onNpcDialogue: (panel) => this.dialogue.mount(panel),
      onQuestJournal: (panel) => mountQuestJournal(panel, this.quests),
      tradePortrait: (surface, point) => this.portrait(surface, point),
      confirmQuestGiveUp: (id, name) =>
        this.ui.prompt({
          kind: "confirm",
          text: `Do you want to forfeit ${name}?`,
        }),
      markQuestNpc: (id) => this.markQuestNpc(id),
      tradeOutcome: (result) => this.tradeOutcome(result),
      onDropMesos: (amount) => this.request({ kind: "mesos.drop", amount }),
      onOfferItem: (uid) =>
        this.worldActions.offer({ uid, actorId: this.store.id }),
      onChatSubmit: (text, channel) => this.submitChat(text, channel),
      onChatSettings: (settings) => this.stageChatSettings(settings),
    };
  }
  audioHooks() {
    return {
      playSound: (category, name) =>
        this.audio
          .playSound(category, name)
          .catch((error) => this.report(error)),
      onErrorNotification: () => this.audio.notifyError(),
      getAudioSettings: () => structuredClone(this.audio.audio.settings),
      applyAudioSettings: (settings) => this.applyAudioSettings(settings),
      saveSettings: (settings) =>
        this.persist({ kind: "settings.save", settings }),
    };
  }
  async prepare(catalog, signal) {
    this.catalog = catalog;
    this.avatars = new AvatarVisuals(this.services, catalog);
    await this.audio.prepare(catalog.audiovisual, signal);
    await this.ui.prepare(catalog.ui, signal);
    await this.questReady.prepare(signal);
  }
  prepareProfile() {
    this.inventory = new NativeInventory(this);
    this.quests = new NativeQuests(this);
    this.book = new NativeMonsterBook(this);
    this.macros = new NativeMacros(this);
    this.bindings = new KeyBindings(this.store, this.catalog, {
      onAction: (name) => this.activateBinding(name),
      onCashExpression: (templateId) =>
        this.worldActions.useCashExpression(templateId),
      onSkill: (skillId) => this.cast(skillId),
      onSkillRelease: (skillId) => this.endSkill(skillId, false),
      onSkillCancel: (skillId) => this.endSkill(skillId, true),
      isBlocked: () => this.blocked() || this.ui.blocksGameplay(),
      now: () => performance.now(),
      report: (text) => this.report(text),
      macros: () => this.macros,
      itemUse: this.inventory,
      saveBindings: (keyBindings) =>
        this.persist({ kind: "key-bindings.save", keyBindings }),
      onSound: (category, name) =>
        this.audio
          .playSound(category, name)
          .catch((error) => this.report(error)),
    });
    this.ui.setProfile(this.store, this.quests);
    this.ui.setBindings(this.bindings);
  }
  async update(snapshot) {
    if (this.destroyed) return;
    if (!snapshot.presentation?.profile) {
      throw new Error("The server did not publish native presentation state.");
    }
    let previous = this.state;
    if (
      previous &&
      (previous.self.entity.id !== snapshot.self.entity.id ||
        this.playSession !== this.transport.playSession)
    ) {
      this.releaseCharacter();
      previous = null;
    }
    this.state = snapshot;
    this.playSession = this.transport.playSession;
    if (!this.bindings) this.prepareProfile();
    if (this.social.closed) {
      this.social = new NativeSocial(this);
      Object.assign(this.ui.hooks, this.social.nativeHooks());
    }
    if (!snapshot.presentation.social) {
      throw new Error("The server did not publish native social state.");
    }
    this.social.publish(snapshot.presentation.social);
    const scene = this.scene;
    if (this.ui.scene !== scene) {
      this.localCombat.bind();
      this.ui.setScene(scene);
      this.audio.setScene(scene);
    }
    this.store.publish();
    this.applySavedPresentation(previous);
    await this.effects.publish(snapshot.self.effects);
    await this.observeEntities(snapshot);
    this.questReady.refresh(this.quests);
    await this.reconcileInteractions(snapshot.presentation.interactions);
    await this.openInitialWindows(previous, scene);
  }
  async openInitialWindows(previous, scene) {
    if (this.state.self.hp === 0 && scene) await this.ui.showRevival(scene);
    if (!previous && scene) await this.ui.open("MiniMap");
    if (!previous && this.store.profile.settings.questTracker.open) {
      await this.ui.open("QuestAlarm");
    }
    const visible = this.transport.status === "active";
    if (this.ui.visible !== visible) this.ui.setVisible(visible);
  }
  applySavedPresentation(previous) {
    const settings = this.store.profile.settings;
    if (!this.ui.windows.has("SysOpt")) this.applyAudioSettings(settings);
    const before = previous?.presentation.profile.settings.chat;
    if (
      !before ||
      before.state !== settings.chat.state ||
      before.height !== settings.chat.height
    ) {
      this.ui.chat.applySettings(settings.chat);
    }
  }
  releaseCharacter() {
    this.nextCast = null;
    this.store.optimistic.clear();
    clearTimeout(this.chatTimer);
    this.chatDraft = null;
    if (this.dialogue.event) {
      this.dialogue.close(this.dialogue.event.conversationId);
    }
    this.closeShop();
    this.closeTrade();
    this.closeStorage();
    this.cash?.destroy();
    this.cash = null;
    this.book?.destroy();
    this.book = null;
    this.effects.destroy();
    this.localCombat.destroy();
    this.skillVisuals.destroy();
    this.social.destroy();
    this.transitions.cancel();
    this.tradeTerminal = null;
    this.ui.retireAllWindows();
    this.bindings?.destroy();
    this.macros?.destroy();
    this.bindings = null;
    this.interactionSignatures.clear();
  }
  stageChatSettings(settings) {
    if (!this.store.profile || this.destroyed) return;
    this.chatDraft = settings;
    clearTimeout(this.chatTimer);
    this.chatTimer = setTimeout(() => this.flushChatSettings(), 250);
  }
  flushChatSettings() {
    if (!this.chatDraft || this.pending || this.blocked()) return;
    const settings = structuredClone(this.store.profile.settings);
    settings.chat = this.chatDraft;
    this.chatDraft = null;
    this.persist({ kind: "settings.save", settings }).catch((error) =>
      this.report(error),
    );
  }
  async reconcileInteractions(events) {
    const ids = new Set(),
      keys = new Set();
    for (const event of events) {
      const id = conversationIdentity(event);
      ids.add(id);
      const key = interactionKey(event);
      keys.add(key);
      const signature = JSON.stringify(event);
      if (this.interactionSignatures.get(key) === signature) continue;
      this.interactionSignatures.set(key, signature);
      await this.event({ event });
    }
    this.retireInteractions(ids);
    for (const key of this.interactionSignatures.keys()) {
      if (!keys.has(key)) this.interactionSignatures.delete(key);
    }
  }
  retireInteractions(ids) {
    if (this.dialogue.event && !ids.has(this.dialogue.event.conversationId)) {
      this.dialogue.close(this.dialogue.event.conversationId);
    }
    if (this.shop && !ids.has(this.shop.event.shopSession)) this.closeShop();
    if (this.trade && !ids.has(this.trade.event.tradeId)) this.closeTrade();
    if (this.storage && !ids.has(this.storage.event.storageSession)) {
      this.closeStorage();
    }
  }
  command(action, revision, preview = null) {
    if (this.destroyed) {
      return Promise.reject(new Error("Native online UI was destroyed."));
    }
    const blocking = !preview && action.kind !== "skill.cast";
    this.beginOperation(blocking);
    let pending;
    try {
      pending = this.transport.command(action, revision);
    } catch (error) {
      this.finishOperation(blocking);
      return Promise.reject(error);
    }
    this.store.optimistic.add(pending.operationId, preview);
    this.store.publish();
    const result = this.completeCommand(pending, blocking);
    result.operationId = pending.operationId;
    return result;
  }
  async completeCommand(pending, blocking) {
    try {
      let receipt = await pending;
      if (receipt.status === "unknown") {
        this.ui.status("Awaiting server confirmation…");
        receipt = await this.transport.recover(receipt.operationId);
      }
      this.store.optimistic.settle(pending.operationId, receipt);
      this.store.publish();
      if (receipt.status !== "committed") {
        this.ui.status(nativeOutcome(receipt).reason);
      }
      return receipt;
    } catch (error) {
      this.store.optimistic.settle(pending.operationId, { status: "rejected" });
      this.store.publish();
      throw error;
    } finally {
      this.finishOperation(blocking);
    }
  }
  beginOperation(blocking = true) {
    if (blocking) this.blockingPending++;
    if (!this.pending) this.operationIdle = Promise.withResolvers();
    this.pending++;
  }
  finishOperation(blocking = true) {
    if (blocking) this.blockingPending--;
    this.pending--;
    if (this.pending) return;
    this.operationIdle?.resolve();
    this.operationIdle = null;
    if (this.chatDraft) queueMicrotask(() => this.flushChatSettings());
  }
  /** Includes the opening npc.open command, whose dialogue event can precede its receipt. */
  whenCommandsSettled() {
    return this.operationIdle?.promise ?? Promise.resolve();
  }
  async request(action, revision) {
    const preview = this.store.optimistic.plan(action);
    return nativeOutcome(await this.command(action, revision, preview));
  }
  async persist(action) {
    const result = await this.request(action);
    if (!result.ok) {
      throw new NativeOperationRefusal(result);
    }
    return result;
  }
  blocked() {
    return (
      this.destroyed ||
      !this.state ||
      this.transport.status !== "active" ||
      Boolean(this.hooks.isFieldBlocked?.())
    );
  }
  developer() {
    return Boolean(
      this.transport.config?.development &&
      this.transport.config?.role === "developer",
    );
  }
  async editProfile(patch, { jobPreset = null } = {}) {
    if (!this.developer()) {
      throw new Error("Developer profile editing is not authorized.");
    }
    const action =
      jobPreset === null
        ? { kind: "profile", patch }
        : {
            kind: "preset",
            job: jobPreset,
            ...(patch && Object.keys(patch).length ? { patch } : {}),
          };
    return this.develop(action);
  }
  async develop(action) {
    this.beginOperation();
    try {
      let receipt = await this.transport.develop(action);
      if (receipt.status === "unknown") {
        this.hooks.onStatus?.(
          "Awaiting server confirmation. Reconnect to recover this operation.",
        );
        receipt = await this.transport.recover(receipt.operationId);
      }
      if (receipt.status !== "committed") {
        throw new NativeOperationRefusal(nativeOutcome(receipt));
      }
      return nativeOutcome(receipt);
    } finally {
      this.finishOperation();
    }
  }
  offerTemplate(id) {
    const item = this.store.profile?.inventory.find(
      (entry) => entry.id === id && entry.count > 0,
    );
    if (!item) {
      return {
        accepted: false,
        reason: "Pick up this item before offering it to a reactor.",
      };
    }
    return this.worldActions.offer({ uid: item.uid, actorId: this.store.id });
  }
  portrait(surface, point) {
    const portrait = new NativeAvatarPortrait(surface, this.avatars, point);
    portrait.refresh(point.profile ?? this.store.profile).catch((error) => {
      if (error.name !== "AbortError") this.report(error);
    });
    return portrait;
  }
  skillPoints(id) {
    const skill = this.catalog.ui.skills[id];
    const profile = this.store.profile;
    return skill && profile ? allocationPoints(profile, skill, Date.now()) : 0;
  }
  skillAllocationError(id) {
    return this.skillPoints(id) > 0 && !this.blocked()
      ? null
      : "No available SP or active server field.";
  }
  cast(skillId) {
    if (this.blocked()) return false;
    const current = this.localCombat?.current();
    if (current) {
      if (
        this.catalog.ui.skills[skillId]?.classification.activation === "channel"
      ) {
        return false;
      }
      const now = performance.now();
      if (current.duration - (now - current.started) > 200) return false;
      this.nextCast = {
        skillId,
        expires: now + 200,
        epoch: this.state.fieldEpoch,
      };
      return true;
    }
    let preview;
    try {
      preview = this.store.optimistic.plan({ kind: "skill.cast", skillId });
      if (!preview) return false;
    } catch (error) {
      this.ui.status(error.message);
      return false;
    }
    return this.startCast(skillId, preview);
  }
  startCast(skillId, preview) {
    // Movement skills are predicted locally so the arc starts on the key press. The
    // authoritative divert for the same skill is then not merged twice, and a refused
    // cast restores the exact pre-cast kernel checkpoint so no unadmitted impulse
    // survives as free position.
    const impulse = this.optimisticImpulse(skillId);
    const token = impulse
      ? (this.hooks.prediction?.beginOptimistic?.(impulse, skillId) ?? null)
      : null;
    const response = this.command({ kind: "skill.cast", skillId });
    const pose = this.localCombat?.begin(skillId, response.operationId);
    const feedback = this.skillVisuals?.predict(skillId, response.operationId);
    // Select the current cast's projectile before reserving its last ammunition.
    this.store.optimistic.add(response.operationId, preview);
    this.store.publish();
    response
      .then((receipt) => {
        if (feedback) feedback.confirmed = receipt.status === "committed";
        if (receipt.status === "rejected") {
          this.localCombat?.reject(pose);
          this.rollbackOptimistic(token);
          this.skillVisuals?.local.reject(feedback);
        }
      })
      .catch((error) => {
        this.localCombat?.reject(pose);
        this.rollbackOptimistic(token);
        this.skillVisuals?.local.reject(feedback);
        this.report(error);
      });
    return true;
  }
  rollbackOptimistic(token) {
    if (token) this.hooks.prediction?.rejectOptimistic?.(token);
  }
  optimisticImpulse(skillId) {
    return skillImpulseFor(
      this.store.profile,
      this.catalog,
      this.scene,
      skillId,
    );
  }
  interact(id) {
    if (this.blocked()) return false;
    this.command({ kind: "npc.open", npcId: String(id) }).catch((error) =>
      this.report(error),
    );
    return true;
  }
  endSkill(skillId, cancelled) {
    if (this.destroyed || this.transport.status !== "active") return;
    this.command({
      kind: cancelled ? "skill.cancel" : "skill.release",
      skillId,
    }).catch((error) => this.report(error));
  }
  pickup() {
    if (this.blocked()) return false;
    const party = this.store.profile.social.party;
    const position =
      this.transport.model?.self.entity.position ??
      this.state.self.entity.position;
    const drop = nearestPickupDrop(
      this.entities,
      position,
      {
        id: this.store.id,
        partyId: party?.id ?? null,
        partyMembers: party?.members ?? [],
      },
      Date.now(),
    );
    if (!drop) return false;
    this.command({ kind: "drop.pickup", dropId: drop.id }).catch((error) =>
      this.report(error),
    );
    return true;
  }
  activateBinding(name) {
    if (!this.store.profile) return false;
    if (Object.hasOwn(USER_TABS, name)) {
      return this.activateUserTab(USER_TABS[name]);
    }
    if (name === "Sit" || name.startsWith("Expression:")) {
      if (this.blocked() || this.ui.blocksGameplay()) return false;
      return this.worldActions.activateBinding(name);
    }
    if (name === "UserInfo") {
      this.social.peers
        .openUserInfo(this.social.selectedId() ?? this.store.id)
        .catch((error) => this.report(error));
      return true;
    }
    const input = this.activateInputBinding(name);
    if (input !== null) return input;
    return this.activateWindowBinding(name);
  }
  activateWindowBinding(name) {
    if (name === "NPT") return this.ui.toggleWindow("ITC");
    if (name === "MiniMap") return this.ui.advanceMinimap();
    if (name === "Quit") {
      this.quit().catch((error) => this.report(error));
      return true;
    }
    if (name === "QuestAlarm") {
      this.toggleTracker().catch((error) => this.report(error));
      return true;
    }
    const unavailable = this.windowCapability(name);
    if (unavailable) {
      this.report(unavailable);
      return false;
    }
    const opened = this.ui.toggleWindow(name);
    if (!opened) this.report(unsupported(name).reason);
    return opened;
  }
  activateUserTab(index) {
    const panel = this.ui.windows.get("UserList");
    if (panel?.localTab === index || this.ui.pending.has("UserList")) {
      this.ui.close("UserList");
    } else if (panel) {
      panel.selectLocalTab(index);
      this.ui.front(panel);
    } else {
      this.ui
        .open("UserList")
        .then((opened) => {
          if (opened && this.ui.windows.get("UserList") === opened) {
            opened.selectLocalTab(index);
          }
        })
        .catch((error) => this.report(error));
    }
    return true;
  }
  activateInputBinding(name) {
    if (Object.hasOwn(CHAT_BINDINGS, name)) {
      this.ui.chat.selector.selectedIndex = CHAT_BINDINGS[name];
      this.ui.chat.open();
      return true;
    }
    if (name === "ExpandChat") {
      this.ui.chat.setState(this.ui.chat.state === 3 ? 1 : 3);
      return true;
    }
    if (name === "Talk") return this.talk();
    if (name === "Pickup") return this.pickup();
    if (name !== "Attack" && name !== "Jump") return null;
    this.hooks.tap?.(name === "Attack" ? "attack" : "jump");
    return Boolean(this.hooks.tap);
  }
  talk() {
    return this.hooks.scene()?.life?.talkNearest() ?? false;
  }
  async quit() {
    if (
      await this.ui.prompt({
        kind: "confirm",
        text: "Are you sure you want to quit?",
        owner: this.ui.modal(),
      })
    ) {
      await this.transport.revoke();
    }
  }
  async toggleTracker() {
    const open = !this.ui.windows.has("QuestAlarm");
    const result = await this.quests.changeTracker(open ? "open" : "close");
    if (!result.ok) throw new NativeOperationRefusal(result);
    if (open) await this.ui.open("QuestAlarm");
    else this.ui.close("QuestAlarm", true);
  }
  windowCapability(name) {
    if (name === "Shop" && !this.shop) {
      return "No server shop conversation is active.";
    }
    if (name === "Trunk" && !this.storage) {
      return "No server account storage conversation is active.";
    }
    if ((name === "TradingRoom" || name === "TradeInvitation") && !this.trade) {
      return "No server trade session is active.";
    }
    return null;
  }
  submitChat(text, index) {
    return this.social.chat.submit(text, index);
  }
  async selectPlayer(text) {
    const name = await this.ui.prompt({
      kind: "text",
      text,
      value: "",
      maxLength: 128,
    });
    if (name === null) return null;
    const entity = this.entities.find(
      (entry) =>
        entry.kind === "player" &&
        (entry.id === name || entry.appearance.name === name),
    );
    if (!entity || entity.id === this.store.id) {
      throw new Error("Choose another server-published player in this field.");
    }
    return entity.id;
  }
  async inviteTrade(targetId = null) {
    targetId ??= await this.selectPlayer("Trade with which player?");
    if (!targetId) return { ok: false, code: "cancelled" };
    return this.request({ kind: "trade.invite", targetId });
  }
  async markQuestNpc(id) {
    const record = this.catalog.quests.records[id];
    const stage =
      record.stages[Math.min(this.quests.view(id)?.partition ?? 0, 1)];
    const npcId = stage.check.npc || stage.actionCheck.npc;
    const panel = await this.ui.open("WorldMap");
    const result = panel.markNpc(npcId);
    if (!result.ok) {
      throw new Error(
        "The original world map has no location for this quest NPC.",
      );
    }
    return result;
  }
  applyAudioSettings(settings) {
    for (const category of ["BGM", "SE"]) {
      const value = settings[category];
      this.audio.audio.setVolume(category, value.volume, value.mute);
      this.audio.controls.root.querySelector(
        `[data-audio-volume="${category}"]`,
      ).value = value.volume;
      this.audio.controls.root.querySelector(
        `[data-audio-mute="${category}"]`,
      ).checked = value.mute;
    }
    this.audio.refreshVolumeControls();
  }
  async event(message) {
    if (this.destroyed || !message.event) return;
    const event = message.event;
    if (conversationIdentity(event)) {
      this.interactionSignatures.set(
        interactionKey(event),
        JSON.stringify(event),
      );
    }
    if (await this.interactionEvent(event)) return;
    if (await this.worldActions.event(message)) return;
    if (await this.skillEvent(event)) return;
    if (await this.combatEvent(event)) return;
    if (await this.dropEvent(event)) return;
    if (event.kind === "chat") this.chatEvent(event);
    else await this.narrativeEvent(event);
  }
  async narrativeEvent(event) {
    switch (event.kind) {
      case "narrative.reward":
        await this.reward(event);
        break;
      case "quest.ready":
        if (this.quests) this.questReady.refresh(this.quests);
        break;
    }
  }
  chatEvent(event) {
    this.social.chat.receive(event);
  }
  async skillEvent(event) {
    switch (event.kind) {
      case "skill.cast":
        await this.skillVisuals.cast(event);
        return true;
      case "skill.visual":
        await this.skillVisuals.visual(event);
        return true;
      case "skill.sound":
        await this.skillVisuals.sound(event);
        return true;
      case "skill.utility":
        if (event.actorId === this.store.id) await this.ui.open(event.window);
        return true;
      default:
        return false;
    }
  }
  async combatEvent(event) {
    switch (event.kind) {
      case "combat.attack":
        this.attackAudio(event);
        return true;
      case "combat.impact":
        this.impactAudio(event);
        return true;
      case "combat.reward":
        if (event.actorId === this.store.id) {
          this.ui.notices.publish({
            kind: "exp",
            amount: event.amount,
            white: true,
          });
        }
        return true;
      case "combat.level-up": {
        const target = this.hooks.scene()?.effectTarget(event.actorId);
        if (target) await this.audio.playGameplayEffect("LevelUp", target);
        return true;
      }
      case "combat.death":
        if (event.actorId === this.store.id) {
          this.audio.onPlayerDeath();
          this.macros.interrupt();
          await this.ui.showRevival(this.scene);
        }
        return true;
      default:
        return false;
    }
  }
  async dropEvent(event) {
    switch (event.kind) {
      case "drop.pickup":
        if (event.actorId === this.store.id) {
          await this.audio.playSound("Game", "PickUpItem");
        }
        return true;
      case "drop.gain":
        if (event.actorId === this.store.id) {
          this.ui.notices.publish(
            event.itemId === 0
              ? { kind: "meso", amount: event.quantity }
              : { kind: "item", itemId: event.itemId, amount: event.quantity },
          );
        }
        return true;
      case "drop.spawn":
        if (event.sound) await this.audio.playSound("Game", "DropItem");
        return true;
      case "drop.card":
        this.recordCard(event);
        return true;
      default:
        return false;
    }
  }
  recordCard(event) {
    if (event.actorId !== this.store.id) return;
    const name = this.catalog.ui.items[event.cardItemId]?.name;
    if (event.full || name) {
      this.ui.chat.receive({
        source: "gameplay",
        text: event.full
          ? "This card is already full in the Monster Book. This card will disappear."
          : `[${name}] has been successfully recorded on the Monster Book.`,
        time: performance.now(),
      });
    }
  }
  async interactionEvent(event) {
    switch (event.kind) {
      case "mts.changed":
        this.market?.invalidate();
        return true;
      case "dialogue":
        await this.dialogue.publish(event);
        return true;
      case "dialogue.closed":
        this.dialogue.close(event.conversationId);
        if (this.shop?.event.shopSession === event.conversationId) {
          this.closeShop();
        }
        return true;
      case "shop":
        await this.publishShop(event);
        return true;
      case "storage":
        await this.publishStorage(event);
        return true;
      case "storage.closed":
        this.closeStorageSession(event.storageSession);
        return true;
      case "trade":
        await this.publishTrade(event);
        return true;
      default:
        return false;
    }
  }
  closeStorageSession(id) {
    if (this.storage?.event.storageSession === id) this.closeStorage();
  }
  async publishShop(event) {
    if (
      this.shop?.event.shopSession === event.shopSession &&
      this.shop.event.revision === event.revision
    ) {
      return;
    }
    if (!this.shopPages.has(event.shopSession)) this.shopPages.clear();
    if (!this.shopPages.has(event.shopSession)) {
      this.shopPages.set(event.shopSession, new Map());
    }
    const pages = this.shopPages.get(event.shopSession);
    pages.set(event.part, event);
    if (pages.size !== event.parts) return;
    const rows = [];
    for (let part = 0; part < event.parts; part++) {
      const page = pages.get(part);
      if (!page) return;
      rows.push(...page.rows);
    }
    this.shopPages.delete(event.shopSession);
    this.closeShop();
    this.shop = new NativeShop(this, event, rows);
    this.dialogue.close(event.shopSession);
    await this.ui.open("Shop");
  }
  closeShop() {
    this.ui.close("Shop", true);
    this.shop?.destroy();
    this.shop = null;
  }
  async publishTrade(event) {
    const existingRoom =
      this.trade?.event.tradeId === event.tradeId &&
      this.ui.windows.has("TradingRoom");
    if (this.trade?.event.tradeId === event.tradeId) this.trade.update(event);
    else {
      this.closeTrade();
      this.trade = new NativeTrade(this, event);
    }
    if (this.trade.terminal) {
      return this.publishTradeTerminal(event, existingRoom);
    }
    if (event.state === "invited" && event.participants[1] === this.store.id) {
      await this.ui.open("TradeInvitation");
    } else if (
      event.state === "invited" ||
      event.state === "open" ||
      event.state === "confirmed"
    ) {
      this.ui.close("TradeInvitation", true);
      await this.ui.open("TradingRoom");
    }
  }
  async publishTradeTerminal(event, existingRoom) {
    const key = `${event.tradeId}:${event.revision}`;
    if (this.tradeTerminal === key) return;
    this.tradeTerminal = key;
    if (!existingRoom) {
      const presentation = this.trade.terminalPresentation();
      this.ui.close("TradeInvitation", true);
      if (presentation) await this.ui.hooks.tradeOutcome(presentation);
    }
  }
  closeTrade() {
    const previous = this.trade;
    this.trade = null;
    this.ui.close("TradeInvitation", true);
    this.ui.close("TradingRoom", true);
    previous?.destroy().catch((error) => this.report(error));
  }
  tradeOutcome(result) {
    if (result.kind === "trade.result") {
      this.tradeTerminal = `${result.tradeId}:${result.revision}`;
    }
    return this.ui.prompt({
      kind: "notice",
      text: result.text ?? result.reason ?? result.code,
    });
  }
  cashShop() {
    if (!this.cash || this.cash.closed) {
      this.cash?.destroy();
      this.cash = new NativeCashShop(this);
    }
    return this.cash;
  }
  async publishStorage(event) {
    if (!event.account) {
      throw new Error("The server account storage state is missing.");
    }
    if (
      this.storage?.event.storageSession === event.storageSession &&
      !this.storage.closed
    ) {
      this.storage.update(event);
      return;
    }
    this.closeStorage();
    this.storage = new NativeStorage(this, event);
    await this.storage.open();
    this.dialogue.close(event.storageSession);
    await this.ui.open("Trunk");
  }
  closeStorage() {
    const previous = this.storage;
    this.storage = null;
    previous?.destroy();
    this.ui.close("Trunk", true);
  }
  async reward(event) {
    for (const item of event.items) {
      if (item.amount > 0) this.ui.notices.publish({ kind: "item", ...item });
    }
    if (event.mesos > 0) {
      this.ui.notices.publish({ kind: "meso", amount: event.mesos });
    }
    if (event.exp > 0) {
      this.ui.notices.publish({ kind: "exp", amount: event.exp, white: true });
    }
    if (event.questClear) await this.audio.playGameplayEffect("QuestClear");
  }
  async observeEntities(snapshot) {
    const entities = snapshot.entities.some(
      (entity) => entity.id === snapshot.self.entity.id,
    )
      ? snapshot.entities
      : [snapshot.self.entity, ...snapshot.entities];
    await this.skillVisuals.observe(entities);
    this.macros?.observeState();
  }
  attackAudio(event) {
    if (this.localCombat.soundEcho(event)) return;
    if (event.weaponSfx) this.audio.onPlayerAttack(event.weaponSfx);
    else if (event.templateId !== null && event.action) {
      const actor = this.entities.find((entry) => entry.id === event.actorId);
      if (actor) {
        this.audio.onMobAttack(
          {
            ...actor.position,
            templateId: event.templateId,
            action: event.action,
          },
          this.scene.presentation,
        );
      }
    }
  }
  /** Report provisional local digits for diagnostics; server rolls determine outcomes. */
  reportHits(report) {
    return this.transport.reportHits(report);
  }
  impactAudio(event) {
    const predicted = this.localCombat.consumeImpact(event);
    const target = this.entities.find((entry) => entry.id === event.targetId);
    if (target?.kind === "mob" && event.damage > 0) {
      const mob = {
        ...event.position,
        templateId: target.templateId,
        alive: !event.lethal,
      };
      if (event.lethal) this.audio.onMobDeath(mob, this.scene.presentation);
      else if (!predicted) {
        this.audio.onMobHit(mob, event.damage, this.scene.presentation);
      }
    } else if (target?.kind === "player" && !predicted) {
      const source = this.entities.find((entry) => entry.id === event.actorId);
      this.audio.onPlayerHit(
        {
          amount: event.damage,
          attackAction: event.attackAction,
          source:
            source?.kind === "mob"
              ? { ...source.position, templateId: source.templateId }
              : null,
        },
        this.scene.presentation,
      );
    }
  }
  status(value) {
    this.connection = value;
    const visible =
      (value.status === "active" || value.status === "transitioning") &&
      Boolean(this.store.profile);
    if (this.ui.visible !== visible) this.ui.setVisible(visible);
    this.updateConnectionActivity(value.status);
    if (value.code === "SIGNED_OUT" && this.state) {
      this.releaseCharacter();
      this.state = null;
      this.playSession = null;
    }
  }
  updateConnectionActivity(status) {
    if (status === "active") {
      this.flushChatSettings();
      this.social.observeInvitation();
    }
    if (
      status === "disconnected" ||
      status === "signing-out" ||
      status === "recovering"
    ) {
      this.transitions.cancel();
      this.closeStorage();
    }
    if (status !== "active") {
      this.macros?.interrupt();
      this.bindings?.releaseAllSkills();
      this.hooks.clearInput();
    }
  }
  report(error) {
    const text =
      error instanceof Error
        ? `${error.code ?? "Error"}: ${error.message}`
        : String(error);
    this.ui?.status(text);
    if (!(error instanceof Error) || error instanceof NativeOperationRefusal) {
      return;
    }
    this.hooks.report?.(error);
  }
  resize(width, height) {
    this.ui.resize(width, height);
    this.questReady.resize();
  }
  flushNextCast() {
    const next = this.nextCast;
    if (!next) return;
    if (
      this.blocked() ||
      next.epoch !== this.state.fieldEpoch ||
      performance.now() > next.expires
    ) {
      this.nextCast = null;
    } else if (!this.localCombat.current()) {
      this.nextCast = null;
      this.cast(next.skillId);
    }
  }
  draw(elapsedMs) {
    this.flushNextCast();
    this.localCombat.update();
    this.effects.update();
    this.macros?.update(elapsedMs);
    this.skillVisuals.update(elapsedMs);
    this.localCombat.projectiles.draw(elapsedMs);
    this.audio.update(elapsedMs);
    this.social.pollInvitation();
    this.ui.update(elapsedMs);
    this.questReady.update(elapsedMs);
    this.transitions.draw(elapsedMs);
  }
  destroy() {
    this.destroyed = true;
    clearTimeout(this.chatTimer);
    this.chatDraft = null;
    this.dialogue.destroy();
    this.effects.destroy();
    this.questReady.destroy();
    this.localCombat.destroy();
    this.skillVisuals.destroy();
    this.closeShop();
    this.closeTrade();
    this.closeStorage();
    this.cash?.destroy();
    this.book?.destroy();
    this.social.destroy();
    this.worldActions.destroy();
    this.transitions.destroy();
    this.bindings?.destroy();
    this.macros?.destroy();
    this.store.destroy();
    this.ui.destroy();
    this.audio.destroy();
  }
}
