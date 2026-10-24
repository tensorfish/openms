import { Container } from "pixi.js";
import { AccountRecovery } from "./account-recovery.js";
import {
  powMessage,
  satisfiesProofOfWork,
} from "../../../shared/proof-of-work.js";
import { JOB_LABELS } from "../ui/ui-job-labels.js";
import { AvatarVisuals } from "../character/avatar-visuals.js";
import { UIRasterPlane } from "../ui/ui-raster-plane.js";
import { createProfile } from "../profile/profile-validation.js";
import { LoginBackdrop } from "./login-backdrop.js";
import { OnlineDialogs } from "./dialogs.js";

const MAX_CHARACTERS = 64;
// 00605975 visits i + page*3; 00606ba9 positions all three avatars together.
const CHARACTERS_PER_PAGE = 3;
const MAX_NONCE = 64 * 1024 * 1024;
const POW_YIELD_HASHES = 512;
const ACCOUNT_NAME_PATTERN = /^[A-Za-z0-9_-]{3,16}$/;
const CHARACTER_NAME_PATTERN = /^[A-Za-z0-9]{4,13}$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 256;
const STAT_KEYS = ["str", "dex", "int", "luk"];
/** 00618026 paints the eight Info choices first, followed by gender (row8). */
const CREATE_ROWS = [
  ["face", "Face"],
  ["hairBase", "Hair"],
  ["hairColor", "Hair colour"],
  ["skin", "Skin"],
  ["top", "Top"],
  ["bottom", "Bottom"],
  ["shoes", "Shoes"],
  ["weapon", "Weapon"],
  ["gender", "Gender"],
];
/** Apparel the original create packet always carried, in its transmitted order. */
const CREATE_GEAR = ["top", "bottom", "shoes", "weapon"];
const CREATE_TABLE_VERSION = 1;

/** Local validation text is ours and shown verbatim; server codes map to explicit wording. */
function localError(message) {
  const error = new Error(message);
  error.local = true;
  return error;
}

const FAILURE_TEXT = new Map([
  [
    "CHARACTER_BUSY",
    "That character is still connected elsewhere. Wait a moment and enter again.",
  ],
  ["NAME_TAKEN", "That name is already used. Choose another one."],
  [
    "CHARACTER_LIMIT",
    "This account already has the maximum number of characters.",
  ],
  ["POW_INVALID", "The proof-of-work challenge was rejected. Try again."],
  [
    "RATE_LIMITED",
    "Too many attempts just now. Wait a few seconds and try again.",
  ],
  ["INVALID_CREDENTIALS", "The account name or password was rejected."],
  ["UNAUTHENTICATED", "The account name or password was rejected."],
  [
    "CONTENT_MISMATCH",
    "This client build does not match the server content. Reload the page to update it.",
  ],
  ["TRANSPORT_CLOSED", "The connection to the server was lost. Try again."],
  ["NETWORK_ERROR", "The connection to the server was lost. Try again."],
  ["SOCKET_ERROR", "The connection to the server was lost. Try again."],
  [
    "NOT_ALLOWED",
    "The server refused that request for this session. Sign in again.",
  ],
  [
    "INVALID_MESSAGE",
    "The server rejected those values. Check the name, stats and look.",
  ],
  ["NOT_FOUND", "That character no longer exists. Refresh the list."],
  ["SERVER_BUSY", "The server is busy right now. Try again in a moment."],
  [
    "REQUEST_FAILED",
    "The server request failed. Check the account or connection and retry.",
  ],
]);

function failureText(error, code) {
  if (
    error?.local === true &&
    typeof error.message === "string" &&
    error.message
  ) {
    return error.message;
  }
  return FAILURE_TEXT.get(code) ?? `The server request failed (${code}).`;
}

/** Create rows use the original category name for their fallback label. */
function optionTitle(field) {
  return CREATE_ROWS.find(([name]) => name === field)?.[1] ?? field;
}

function element(tag, className, text = "") {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function field(label, input) {
  const row = element("label", "online-login-row");
  row.append(element("span", "online-login-label", label), input);
  return row;
}

function textInput(name, label, maxLength) {
  const input = element("input", `online-login-${name}`);
  input.name = name;
  input.type = "text";
  input.autocomplete = "username";
  input.maxLength = maxLength;
  input.spellcheck = false;
  input.setAttribute("aria-label", label);
  return input;
}

function passwordInput(name, label, autocomplete) {
  const input = element("input", `online-login-${name}`);
  input.name = name;
  input.type = "password";
  input.autocomplete = autocomplete;
  input.maxLength = MAX_PASSWORD;
  input.spellcheck = false;
  input.setAttribute("aria-label", label);
  return input;
}

/** Hashcash over the server challenge; the browser may spend a few hundred milliseconds here. */
async function solveProofOfWork(challenge, { signal, onProgress }) {
  const encoder = new TextEncoder();
  const started = performance.now();
  for (let nonce = 0; nonce <= MAX_NONCE; nonce++) {
    const message = powMessage(challenge.challengeId, String(nonce));
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(message)),
    );
    if (satisfiesProofOfWork(digest, challenge.bits)) {
      return {
        challengeId: challenge.challengeId,
        nonce: String(nonce),
        csrfToken: challenge.loginToken,
      };
    }
    if (nonce % POW_YIELD_HASHES !== 0) continue;
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    onProgress?.(nonce, performance.now() - started);
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  throw new Error("The proof-of-work challenge was not solved in time");
}

/** Original login artwork over accessible account controls; the server stays authoritative. */
export class OnlineLogin {
  constructor({ app, services, transport, hooks, audio = null }) {
    this.app = app;
    this.services = services;
    this.transport = transport;
    this.hooks = hooks;
    this.audio = audio;
    this.destroyed = false;
    this.pending = false;
    this.prepared = false;
    this.visible = true;
    this.entered = false;
    this.presentationPaused = false;
    this.generation = 0;
    this.characters = [];
    this.previews = [];
    this.selected = 0;
    this.stage = "account";
    this.creationPhase = "name";
    this.creationRoll = null;
    this.diceElapsedMs = 320;
    this.draft = {
      name: "",
      gender: 0,
      skin: 0,
      face: 0,
      hairBase: 0,
      hairColor: 0,
      top: 0,
      bottom: 0,
      shoes: 0,
      weapon: 0,
    };
    this.listeners = [];
    this.controller = new AbortController();
    this.host = element("section", "online-login");
    this.host.setAttribute("aria-label", "Online MapleStory sign in");
    this.window = element("div", "online-login-window");
    const body = element("div", "online-login-body");
    this.buildAccountStage(body);
    this.buildCharacterStage(body);
    this.buildCreateStage(body);
    this.window.append(body);
    this.host.append(this.window);
    this.buildRegistration();
    document.querySelector("#viewport").append(this.host);
    this.dialogs = new OnlineDialogs(this.host);
    this.recovery = new AccountRecovery(this);
    this.resize(app.screen.width, app.screen.height);
    this.installCues();
    this.setStatus("Preparing the sign in window…");
    this.renderStage();
  }

  /** Native scene progress stays in inspection; registration owns its framed status. */
  setStatus(text = "") {
    this.statusText = text;
    this.registrationStatus.textContent = this.registrationOverlay.hidden
      ? ""
      : text;
  }

  /** Original UI cues: every button answers hover and activation through the one audio
   * owner. Nothing is queued before a trusted gesture, and a locked graph stays silent. */
  installCues() {
    const cue = (event, name) => {
      const button = event.target?.closest?.("button");
      if (!button || button.disabled) return;
      this.playCue(name);
    };
    this.listen(this.host, "click", (event) => cue(event, "BtMouseClick"));
    this.listen(
      this.host,
      "pointerenter",
      (event) => cue(event, "BtMouseOver"),
      true,
    );
  }

  /** A missing or still-locked login cue never blocks sign in. */
  playCue(name) {
    this.audio
      ?.playSound("UI", name)
      .catch((error) => this.hooks.report(error));
  }

  /** Title music is remembered while audio is locked; a committed field replaces it. */
  playTitleBgm() {
    const descriptor = this.catalog?.audiovisual?.login?.bgm;
    if (!descriptor) return;
    this.audio
      ?.setTitleBgm(descriptor)
      .catch((error) => this.hooks.report(error));
  }

  buildAccountStage(body) {
    const stage = element("div", "online-login-account");
    this.signUpTab = element("button", "online-login-register", "Register");
    this.signUpTab.type = "button";
    this.signUpTab.setAttribute("aria-haspopup", "dialog");
    this.listen(this.signUpTab, "click", () => this.openRegistration());
    stage.append(this.signUpTab);
    const form = element("form", "online-login-form");
    form.autocomplete = "on";
    this.name = textInput("name", "Account name", 16);
    this.password = passwordInput("password", "Password", "current-password");
    form.append(
      field("Account name", this.name),
      field("Password", this.password),
    );
    this.submitButton = element(
      "button",
      "online-login-button primary online-login-submit",
      "Sign in",
    );
    this.submitButton.type = "submit";
    form.append(this.submitButton);
    this.listen(form, "submit", (event) => {
      event.preventDefault();
      this.submit().catch((error) => this.report(error));
    });
    this.listen(form, "keydown", (event) => event.stopPropagation());
    this.accountStage = stage;
    stage.append(form);
    this.buildAccountTools(stage);
    body.append(stage);
  }

  /** 0062054a positions these controls relative to Title's world(10,-80) window. */
  buildAccountTools(stage) {
    this.accountButtons = [];
    for (const [action, label, path, x, y] of [
      ["home", "Homepage", "Title/BtHomePage", 524, 348],
      ["quit", "Quit", "Title/BtQuit", 624, 348],
      ["recovery", "Find login ID", "Title/BtLoginIDLost", 554, 301],
      ["recovery", "Find password", "Title/BtPasswdLost", 636, 302],
    ]) {
      const button = element(
        "button",
        "online-login-button online-login-account-tool",
        label,
      );
      button.type = "button";
      button.style.left = `${x}px`;
      button.style.top = `${y}px`;
      if (action === "recovery") {
        button.classList.add("online-login-recovery");
        button.setAttribute("aria-haspopup", "dialog");
      }
      this.listen(button, "click", () => this.accountAction(action));
      this.accountButtons.push({ button, path });
      stage.append(button);
    }
  }

  accountAction(action) {
    if (this.pending) return;
    if (action === "home") window.location.assign("https://docs.openms.dev");
    else if (action === "quit") window.location.assign("about:blank");
    else if (action === "recovery") this.recovery.open();
  }

  buildRegistration() {
    this.registrationOverlay = element("div", "online-registration-overlay");
    this.registrationOverlay.hidden = true;
    this.registrationWindow = element(
      "section",
      "online-registration inspection-chrome",
    );
    this.registrationWindow.tabIndex = -1;
    this.registrationWindow.setAttribute("role", "dialog");
    this.registrationWindow.setAttribute("aria-modal", "true");
    this.registrationWindow.setAttribute("aria-label", "Create account");
    const titlebar = element("header", "online-registration-titlebar");
    this.registrationClose = element(
      "button",
      "online-registration-close",
      "×",
    );
    this.registrationClose.type = "button";
    this.registrationClose.setAttribute("aria-label", "Close registration");
    titlebar.append(
      element("span", "online-registration-title", "Create account"),
      this.registrationClose,
    );
    const form = this.buildRegistrationForm();
    this.registrationWindow.append(titlebar, form);
    this.registrationOverlay.append(this.registrationWindow);
    this.host.append(this.registrationOverlay);
    for (const button of [this.registrationClose, this.registrationCancel]) {
      this.listen(button, "click", () => this.closeRegistration());
    }
    this.listen(form, "submit", (event) => {
      event.preventDefault();
      this.submit(true).catch((error) => this.reportRegistrationFailure(error));
    });
    this.listen(
      document,
      "keydown",
      (event) => this.onRegistrationKey(event),
      true,
    );
    this.listen(document, "focusin", (event) => {
      if (
        this.registrationOverlay.hidden ||
        this.dialogs?.open ||
        this.registrationWindow.contains(event.target)
      ) {
        return;
      }
      (this.pending ? this.registrationWindow : this.registrationName).focus();
    });
  }

  buildRegistrationForm() {
    const form = element("form", "online-registration-form");
    form.autocomplete = "on";
    this.registrationName = textInput("registration-name", "Account name", 16);
    this.registrationPassword = passwordInput(
      "registration-password",
      "Password",
      "new-password",
    );
    this.registrationConfirm = passwordInput(
      "registration-confirm",
      "Confirm password",
      "new-password",
    );
    const instructions = element(
      "p",
      "online-registration-instructions",
      "Account names use 3–16 letters, digits, underscore or hyphen. Passwords use 8–256 characters.",
    );
    form.append(
      instructions,
      field("Account name", this.registrationName),
      field("Password", this.registrationPassword),
      field("Confirm password", this.registrationConfirm),
    );
    this.registrationStatus = element("p", "online-registration-status");
    this.registrationStatus.setAttribute("role", "status");
    this.registrationStatus.setAttribute("aria-live", "polite");
    this.registrationSubmit = element(
      "button",
      "online-registration-submit",
      "Create account",
    );
    this.registrationSubmit.type = "submit";
    this.registrationCancel = element(
      "button",
      "online-registration-cancel",
      "Cancel",
    );
    this.registrationCancel.type = "button";
    const actions = element("div", "online-registration-actions");
    actions.append(this.registrationSubmit, this.registrationCancel);
    form.append(this.registrationStatus, actions);
    return form;
  }

  openRegistration() {
    if (
      this.pending ||
      this.destroyed ||
      this.accountStage.hidden ||
      this.dialogs.open ||
      !this.registrationOverlay.hidden
    ) {
      return;
    }
    this.registrationPreviousFocus = document.activeElement;
    this.registrationOverlay.hidden = false;
    this.window.inert = true;
    this.setStatus("Choose an account name and password.");
    this.registrationName.focus();
  }

  closeRegistration() {
    if (this.pending || this.destroyed || this.dialogs.open) return;
    const previousFocus = this.registrationPreviousFocus;
    this.resetRegistration();
    this.setStatus("Sign in with your server account.");
    if (previousFocus?.isConnected) previousFocus.focus();
    else this.signUpTab.focus();
  }

  /** Internal completion/reset also closes the popup while auth is still unwinding. */
  resetRegistration() {
    this.registrationOverlay.hidden = true;
    this.window.inert = false;
    this.registrationName.value = "";
    this.registrationPassword.value = "";
    this.registrationConfirm.value = "";
    this.registrationStatus.textContent = "";
    this.registrationPreviousFocus = null;
  }

  onRegistrationKey(event) {
    if (this.registrationOverlay.hidden || this.dialogs.open) return;
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      this.closeRegistration();
    } else if (event.key === "Tab") {
      const controls = [
        this.registrationClose,
        this.registrationName,
        this.registrationPassword,
        this.registrationConfirm,
        this.registrationSubmit,
        this.registrationCancel,
      ].filter((control) => !control.disabled);
      const first = controls[0];
      const last = controls.at(-1);
      if (!first) {
        event.preventDefault();
        this.registrationWindow.focus();
      } else if (!controls.includes(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  clearSecrets() {
    this.password.value = "";
    this.registrationPassword.value = "";
    this.registrationConfirm.value = "";
  }

  buildCharacterStage(body) {
    const stage = element("div", "online-login-characters");
    stage.hidden = true;
    this.roster = element("div", "online-login-roster");
    this.roster.setAttribute("role", "group");
    this.roster.setAttribute("aria-label", "Characters");
    this.rosterSlots = [];
    for (let index = 0; index < CHARACTERS_PER_PAGE; index++) {
      this.rosterSlots.push(this.buildRosterSlot(index));
    }
    this.characterDetail = this.buildCharacterInfo();
    stage.append(
      this.roster,
      this.characterDetail,
      this.buildRosterPages(),
      this.buildCharacterActions(),
    );
    this.characterStage = stage;
    body.append(stage);
    this.listen(this.host, "keydown", (event) => this.onKey(event));
  }

  buildRosterSlot(index) {
    const button = element("button", "online-login-card");
    button.type = "button";
    button.style.left = `${120 + index * 125}px`;
    const portrait = element("div", "online-login-portrait");
    portrait.setAttribute("aria-hidden", "true");
    const name = element("span", "online-login-character-name");
    button.append(portrait, name);
    this.roster.append(button);
    const slot = {
      button,
      portrait,
      name,
      index,
      character: null,
      preview: null,
    };
    this.listen(button, "click", () => this.selectCharacter(slot.index));
    this.listen(button, "dblclick", () => {
      this.selectCharacter(slot.index);
      this.enter().catch((error) => this.report(error));
    });
    return slot;
  }

  buildRosterPages() {
    const pages = element("div", "online-login-pages");
    this.previous = element(
      "button",
      "online-login-button online-login-previous",
      "Previous page",
    );
    this.next = element(
      "button",
      "online-login-button online-login-next",
      "Next page",
    );
    for (const [button, delta] of [
      [this.previous, -1],
      [this.next, 1],
    ]) {
      button.type = "button";
      this.listen(button, "click", () => this.changePage(delta));
      pages.append(button);
    }
    return pages;
  }

  buildCharacterInfo() {
    const detail = element("div", "online-login-character-detail");
    // 00603201 loads string 2976 and draws it at (36,99) without ranking data.
    detail.append(
      element("span", "online-login-info-ranking", "Ranking Not Available"),
    );
    this.characterInfo = {};
    for (const key of ["job", "level", "fame", ...STAT_KEYS]) {
      const value = element("span", `online-login-info-${key}`);
      this.characterInfo[key] = value;
      detail.append(value);
    }
    return detail;
  }

  renderCharacterInfo(character) {
    this.characterDetail.hidden = !character;
    if (!character) return;
    const values = {
      job: JOB_LABELS[character.job] ?? `Job ${character.job}`,
      level: character.level,
      fame: character.fame,
      ...character.stats,
    };
    for (const [key, field] of Object.entries(this.characterInfo)) {
      if (key !== "job" && !Number.isSafeInteger(values[key])) {
        throw new Error(`Character summary is missing ${key}`);
      }
      field.textContent = String(values[key]);
      field.setAttribute("aria-label", `${key}: ${values[key]}`);
    }
  }

  buildCharacterActions() {
    const actions = element("div", "online-login-actions");
    this.enterButton = element(
      "button",
      "online-login-button primary online-login-enter",
      "Enter the world",
    );
    this.createButton = element(
      "button",
      "online-login-button online-login-new",
      "Create character",
    );
    this.refreshButton = element(
      "button",
      "online-login-button online-login-refresh",
      "Refresh",
    );
    this.signOutButton = element(
      "button",
      "online-login-button online-login-signout",
      "Sign out",
    );
    this.deleteButton = element(
      "button",
      "online-login-button online-login-delete",
      "Delete character",
    );
    for (const button of [
      this.enterButton,
      this.createButton,
      this.refreshButton,
      this.signOutButton,
      this.deleteButton,
    ]) {
      button.type = "button";
      actions.append(button);
    }
    this.listen(this.enterButton, "click", () =>
      this.enter().catch((error) => this.report(error)),
    );
    this.listen(this.createButton, "click", () => this.showCreate());
    this.listen(this.refreshButton, "click", () =>
      this.refreshCharacters().catch((error) => this.report(error)),
    );
    this.listen(this.signOutButton, "click", () =>
      this.signOut().catch((error) => this.report(error)),
    );
    this.listen(this.deleteButton, "click", () =>
      this.deleteSelected().catch((error) => this.report(error)),
    );
    return actions;
  }

  /** Deletion is irreversible, so it always asks first and never runs while busy. */
  async deleteSelected() {
    if (this.pending || this.destroyed) return;
    const character = this.characters[this.selected];
    if (!character) return;
    const confirmed = await this.dialogs.confirm({
      title: "Delete character",
      text: `Delete ${character.name}? This cannot be undone.`,
      confirm: "Delete",
    });
    if (!confirmed || this.pending || this.destroyed) return;
    await this.performDelete(character);
  }

  async performDelete(character) {
    const generation = ++this.generation;
    this.setPending(true, `Deleting ${character.name}…`);
    try {
      const characters = await this.transport.deleteCharacter(character.id);
      if (this.destroyed || generation !== this.generation) return;
      this.selected = 0;
      this.acceptCharacters(characters);
      this.setStatus(`${character.name} was deleted.`);
    } catch (error) {
      if (this.destroyed || generation !== this.generation) return;
      // A character deleted by another tab is already gone; refresh instead of
      // leaving the stale entry on screen.
      if (safeCode(error) === "NOT_FOUND") {
        await this.refreshCharacters();
        return;
      }
      this.report(error);
    } finally {
      if (!this.destroyed && generation === this.generation) {
        this.setPending(false);
      }
    }
  }

  /** Native Explorer route: name window, then the appearance window in the same scene. */
  buildCreateStage(body) {
    const stage = element("div", "online-login-create");
    stage.hidden = true;
    const layout = element("div", "online-login-create-layout");
    const look = element("div", "online-login-look");
    this.createPreviewElement = element("div", "online-login-preview");
    this.createPreviewElement.setAttribute("role", "img");
    this.createPreviewElement.setAttribute("aria-label", "Character preview");
    this.previewNote = element("p", "online-login-note", "");
    look.append(this.createPreviewElement, this.previewNote);
    this.createOptions = this.buildCreateOptions();
    layout.append(look, this.createOptions);
    stage.append(layout, this.buildNameStep(), this.buildStatsStep());
    const actions = element("div", "online-login-actions");
    this.backButton = element(
      "button",
      "online-login-button online-login-back",
      "Back",
    );
    this.submitCreate = element(
      "button",
      "online-login-button primary online-login-create-submit",
      "Create",
    );
    for (const button of [this.backButton, this.submitCreate]) {
      button.type = "button";
      actions.append(button);
    }
    this.listen(this.backButton, "click", () => this.stepBack());
    this.listen(this.submitCreate, "click", () =>
      this.createCharacter().catch((error) => this.report(error)),
    );
    stage.append(actions);
    this.createStage = stage;
    body.append(stage);
  }

  buildCreateOptions() {
    const options = element("div", "online-login-options");
    this.optionRows = {};
    for (const [field, label] of CREATE_ROWS) {
      const row = element("div", "online-login-option");
      const previous = element(
        "button",
        "online-login-button online-login-option-previous",
        "◀",
      );
      const value = element("output", "online-login-option-value", "—");
      const next = element(
        "button",
        "online-login-button online-login-option-next",
        "▶",
      );
      for (const button of [previous, next]) {
        button.type = "button";
        button.setAttribute(
          "aria-label",
          `${button === previous ? "Previous" : "Next"} ${label.toLowerCase()}`,
        );
      }
      this.listen(previous, "click", () => this.cycleOption(field, -1));
      this.listen(next, "click", () => this.cycleOption(field, 1));
      row.append(
        element("span", "online-login-label", label),
        previous,
        value,
        next,
      );
      this.optionRows[field] = { label, previous, next, value };
      options.append(row);
    }
    return options;
  }

  /** Restore the retained NewChar dice assets as an explicit third browser step. */
  buildStatsStep() {
    const step = element("section", "online-login-stats-step");
    step.setAttribute("aria-label", "Starting stats");
    step.append(element("h2", "online-login-stats-title", "Starting stats"));
    this.statValues = {};
    for (const [index, key] of STAT_KEYS.entries()) {
      const output = element("output", "online-login-stat-value", "—");
      output.setAttribute("aria-label", key.toUpperCase());
      output.style.top = `${57 + index * 19}px`;
      this.statValues[key] = output;
      step.append(output);
    }
    this.rollButton = element("button", "online-login-roll", "Roll the dice");
    this.rollButton.type = "button";
    this.rollButton.setAttribute("aria-label", "Roll the dice");
    this.rollButton.title = "Roll the dice";
    this.rollNote = element(
      "p",
      "online-login-roll-note",
      "Roll the dice to choose your starting stats.",
    );
    this.rollNote.setAttribute("role", "status");
    this.listen(this.rollButton, "click", () =>
      this.rollStats().catch((error) => this.report(error)),
    );
    step.append(this.rollButton, this.rollNote);
    this.statsStep = step;
    return step;
  }

  async rollStats() {
    if (this.pending || this.destroyed) return;
    const generation = ++this.generation;
    this.diceElapsedMs = 0;
    this.rollingStats = true;
    this.setPending(true, "Rolling starting stats…");
    this.rollNote.textContent = "Rolling…";
    try {
      const roll = await this.transport.rollCharacterStats();
      if (this.cancelled(generation)) return;
      this.creationRoll = roll;
      this.setStatus("");
    } catch (error) {
      if (!this.cancelled(generation)) this.reportCreationFailure(error);
    } finally {
      if (!this.cancelled(generation)) {
        this.rollingStats = false;
        this.setPending(false);
        this.rollButton.focus();
      }
    }
  }

  renderStats() {
    const stats = this.creationRoll;
    for (const key of STAT_KEYS) {
      this.statValues[key].textContent = stats?.[key] ?? "—";
    }
    this.rollButton.disabled = this.pending;
    if (!this.rollingStats) {
      this.rollNote.textContent = stats
        ? "Keep these stats, or roll the dice again."
        : "Roll the dice to choose your starting stats.";
    }
  }

  buildNameStep() {
    const step = element("div", "online-login-name-step");
    this.characterNameInput = textInput("character", "Character name", 13);
    this.characterNameInput.autocomplete = "off";
    this.nameNote = element(
      "p",
      "online-login-note",
      "4 to 13 letters or digits.",
    );
    step.append(
      field("Character name", this.characterNameInput),
      this.nameNote,
    );
    this.nameStep = step;
    return step;
  }

  showCreate() {
    if (this.pending || this.destroyed) return;
    if (!this.prepared) {
      this.setStatus(
        "Still preparing the character choices from the server content.",
      );
      return;
    }
    this.stage = "create";
    this.creationPhase = "name";
    this.creationRoll = null;
    this.draft.name = "";
    this.characterNameInput.value = "";
    this.draft.gender = 0;
    this.adoptCreateDefaults();
    this.renderStage();
    this.renderCreate();
    this.refreshCreatePreview();
    this.characterNameInput.focus();
  }

  stepBack() {
    if (this.pending || this.destroyed) return;
    if (this.creationPhase === "stats") {
      this.creationPhase = "appearance";
      this.renderCreate();
      this.focusStage();
    } else if (this.creationPhase === "appearance") {
      this.creationPhase = "name";
      this.renderCreate();
      this.characterNameInput.focus();
    } else this.showCharacters(this.characters);
  }

  /** Recovered original new-character choices; there is no catalog-wide fallback,
   * because the original screen only ever offered these values. */
  createTable() {
    const table = this.catalog?.ui?.characterCreate;
    if (table?.schemaVersion !== CREATE_TABLE_VERSION) {
      throw new Error("Packaged original character-create choices are missing");
    }
    return table;
  }

  /** One gender's authored option sets; every appearance row belongs to exactly one. */
  createSet(gender = this.draft.gender) {
    const set = this.createTable().genders?.[String(gender)];
    if (!set) {
      throw new Error(`No original create choices for gender ${gender}`);
    }
    return set;
  }

  /** Legal values of one row in original file order. */
  createValues(field) {
    if (field === "gender") return [0, 1];
    const values = this.createSet()[field];
    if (!Array.isArray(values) || !values.length) {
      throw new Error(`Packaged create choices lack ${field}`);
    }
    return values;
  }

  /** Authored label when the original names the value, otherwise its position. */
  createLabel(field, value) {
    if (field === "gender") return value === 0 ? "Male" : "Female";
    if (CREATE_GEAR.includes(field)) return this.itemLabel(value);
    const set = this.createSet();
    const authored = set.names?.[field]?.[String(value)];
    if (typeof authored === "string" && authored) return authored;
    const values = set[field];
    const index = values.indexOf(value);
    return `${optionTitle(field)} ${index + 1} of ${values.length}`;
  }

  /** An item row shows the catalog's own name; the profile is never invented. */
  itemLabel(id) {
    const item = this.catalog?.ui?.items?.[String(id)];
    const name = typeof item?.name === "string" ? item.name.trim() : "";
    if (!name) throw new Error(`Packaged starter item ${id} has no name`);
    return name;
  }

  /** First authored equip slot of a packaged starter item. Presentation only:
   * the server derives the committed slot from the same catalog entry. */
  equipSlot(id) {
    const entry = this.catalog?.ui?.avatar?.entries?.[String(id)];
    const slots = entry?.equippedSlots;
    if (!Array.isArray(slots) || !slots.length || !Number.isInteger(slots[0])) {
      throw new Error(`Packaged starter item ${id} has no authored equip slot`);
    }
    return slots[0];
  }

  /** Every row keeps a value the selected gender's original set allows. */
  adoptCreateDefaults() {
    const set = this.createSet();
    for (const [field] of CREATE_ROWS) {
      if (field === "gender") continue;
      if (!set[field].includes(this.draft[field])) {
        this.draft[field] = set[field][0];
      }
    }
  }

  /** The original packet submitted base hair plus its colour suffix. */
  draftHair() {
    const hair = this.draft.hairBase + this.draft.hairColor;
    if (!Number.isSafeInteger(hair)) {
      throw new Error("Character hair choice is not an original id");
    }
    return hair;
  }

  cycleOption(field, delta) {
    if (this.pending || this.destroyed) return;
    const values = this.createValues(field);
    const index = values.indexOf(this.draft[field]);
    this.draft[field] = values[(index + delta + values.length) % values.length];
    // Male and female sets differ, so a gender change re-selects the other rows.
    if (field === "gender") this.adoptCreateDefaults();
    this.renderCreate();
    this.refreshCreatePreview();
  }

  /** Create-screen choices and their packaged artwork, for verification surfaces only. */
  publishOptions() {
    const set = this.createSet();
    const counts = {};
    for (const field of [
      "face",
      "hairBase",
      "hairColor",
      "skin",
      ...CREATE_GEAR,
    ]) {
      counts[field] = set[field].length;
    }
    this.host.dataset.options = JSON.stringify({
      gender: this.draft.gender,
      counts,
      source: this.createTable().source,
    });
  }

  renderCreate() {
    const naming = this.creationPhase === "name";
    const stats = this.creationPhase === "stats";
    this.createStage.dataset.phase = this.creationPhase;
    this.nameStep.hidden = !naming;
    this.createOptions.hidden = this.creationPhase !== "appearance";
    this.statsStep.hidden = !stats;
    this.submitCreate.setAttribute("aria-label", stats ? "Create" : "Next");
    this.submitCreate.title = stats ? "Create" : "Next";
    this.renderStats();
    this.backdrop?.renderCreate();
    // The catalog streams after the account form is usable, so the create screen
    // renders a preparing state instead of failing the sign-in path.
    if (!this.prepared) {
      for (const row of Object.values(this.optionRows)) {
        row.value.textContent = "Preparing…";
        row.previous.disabled = true;
        row.next.disabled = true;
      }
      this.previewNote.textContent =
        "Reading the original starting choices from the server content…";
      this.backButton.hidden = false;
      this.submitCreate.disabled = true;
      return;
    }
    for (const [field, row] of Object.entries(this.optionRows)) {
      row.value.textContent = this.createLabel(field, this.draft[field]);
      const single = field !== "gender" && this.createValues(field).length < 2;
      row.previous.disabled = single || this.pending;
      row.next.disabled = single || this.pending;
    }
    this.publishOptions();
    const set = this.createSet();
    this.previewNote.textContent = `${set.face.length} faces, ${set.hairBase.length} hairs with ${set.hairColor.length} colours and ${set.skin.length} skin tones are the original starting choices.`;
    this.backButton.hidden = false;
    this.submitCreate.disabled = this.pending || (stats && !this.creationRoll);
  }

  draftProfile() {
    const profile = createProfile({
      mapId: this.catalog?.defaultMap ?? "100000000",
      x: 0,
      y: 0,
      facing: 1,
    });
    profile.name = this.draft.name || "Maple";
    profile.gender = this.draft.gender;
    profile.appearance = {
      skin: this.draft.skin,
      face: this.draft.face,
      hair: this.draftHair(),
    };
    profile.equipment = CREATE_GEAR.map((field) => this.draft[field]).map(
      (id) => ({ id, slot: this.equipSlot(id) }),
    );
    return profile;
  }

  /** Each roster portrait composes its character's own appearance and equipped items.
   * A summary without them is a server contract violation: showing a default look instead
   * would present a character the player cannot play. */
  characterProfile(character) {
    const appearance = character.appearance;
    if (
      ![0, 1].includes(character.gender) ||
      !Number.isInteger(appearance?.skin) ||
      !Number.isInteger(appearance?.face) ||
      !Number.isInteger(appearance?.hair) ||
      !Array.isArray(character.equipment)
    ) {
      throw new Error(
        `Character ${character.id} is missing its authoritative look`,
      );
    }
    const profile = createProfile({
      mapId: this.catalog?.defaultMap ?? "100000000",
      x: 0,
      y: 0,
      facing: 1,
    });
    profile.name = character.name;
    profile.gender = character.gender;
    profile.appearance = {
      skin: appearance.skin,
      face: appearance.face,
      hair: appearance.hair,
    };
    profile.equipment = character.equipment.map((item) => ({
      id: item.id,
      slot: item.slot,
    }));
    return profile;
  }

  /** One composed-avatar plane per surface; each owns one prepared animation at a time.
   * The plane scans its root's children at the host origin, so the root itself is never
   * transformed: a nested view carries the preview scale and placement. */
  previewSlot(name, element) {
    const root = new Container({ label: `online-login-preview-${name}` });
    const view = new Container({ label: `online-login-preview-view-${name}` });
    root.addChild(view);
    const slot = {
      name,
      element,
      root,
      view,
      plane: new UIRasterPlane(root, element),
      prepared: null,
      pose: { action: "stand1", facing: -1, state: "ground" },
      controller: null,
      generation: 0,
    };
    this.previews.push(slot);
    return slot;
  }

  /** Composed avatars use original pixels around feet (0,0), never their hair bounds. */
  placePreview(slot) {
    slot.view.scale.set(1);
    slot.view.position.set(
      slot.element.clientWidth / 2,
      slot.element.clientHeight,
    );
  }

  async showPreview(slot, profile) {
    // A hidden surface owns no portrait: the committed field holds the residency
    // budget, and a detached render must never reserve preview atlases behind it.
    if (!this.visuals || this.destroyed || !this.visible || !slot) return;
    const generation = ++slot.generation;
    slot.controller?.abort();
    const controller = new AbortController();
    slot.controller = controller;
    // Retire the replaced portrait before its replacement reserves any atlas, so
    // one slot never holds two previews and the previous character's pixels never
    // sit under the newly selected name.
    this.clearPreview(slot);
    let prepared;
    try {
      prepared = await this.visuals.preparePreview({
        profile,
        signal: controller.signal,
      });
    } catch (error) {
      if (generation === slot.generation) this.previewFailure(slot, error);
      return;
    }
    if (this.destroyed || generation !== slot.generation) {
      prepared.destroy();
      return;
    }
    slot.prepared = prepared;
    prepared.pose(slot.pose);
    slot.view.removeChildren();
    slot.view.addChild(prepared.root);
    this.placePreview(slot);
  }

  /** Empty a retired portrait; its name never describes another character's pixels. */
  clearPreview(slot) {
    if (!slot) return;
    slot.prepared?.destroy();
    slot.prepared = null;
    slot.view.removeChildren();
    const ratio = window.devicePixelRatio || 1;
    slot.plane.sync(ratio, ratio);
  }

  /** A cancelled compose is silent; a real failure is stated where the player can see it. */
  previewFailure(slot, error) {
    if (error?.name === "AbortError" || this.destroyed) return;
    this.hooks.report(error);
    this.clearPreview(slot);
    if (slot === this.createSlot) {
      this.previewNote.textContent =
        "The packaged avatar artwork could not be prepared.";
    }
  }

  refreshCreatePreview() {
    this.showPreview(this.createSlot, this.draftProfile()).catch((error) =>
      this.report(error),
    );
  }

  async createCharacter() {
    const name = this.characterNameInput.value.trim();
    if (!CHARACTER_NAME_PATTERN.test(name)) {
      this.notify("Character names use 4 to 13 letters or digits.");
      return;
    }
    if (this.pending || this.destroyed) return;
    if (this.creationPhase === "name") return this.acceptName(name);
    if (this.creationPhase === "appearance") {
      this.creationPhase = "stats";
      this.renderCreate();
      this.rollButton.focus();
      return;
    }
    if (!this.creationRoll) return;
    return this.submitCharacter(name);
  }

  async submitCharacter(name) {
    const generation = ++this.generation;
    this.setPending(true, `Creating ${name}…`);
    try {
      const created = await this.transport.createCharacter({
        name,
        gender: this.draft.gender,
        skin: this.draft.skin,
        face: this.draft.face,
        hair: this.draftHair(),
        ...this.creationRoll,
        ...this.gearPayload(),
      });
      if (this.destroyed || generation !== this.generation) return;
      this.acceptCreated(created);
    } catch (error) {
      if (!this.destroyed && generation === this.generation) {
        this.reportCreationFailure(error);
      }
    } finally {
      if (!this.destroyed && generation === this.generation) {
        this.setPending(false);
      }
    }
  }

  /** Use the existing account-roster authority for name checks; creation rechecks atomically. */
  async acceptName(name) {
    const generation = ++this.generation;
    this.setPending(true, "Checking the character name…");
    try {
      const characters = await this.transport.listCharacters();
      if (this.cancelled(generation)) return;
      if (characters.some((character) => character.name === name)) {
        throw Object.assign(new Error("Name already used"), {
          code: "NAME_TAKEN",
        });
      }
      this.draft.name = name;
      this.creationPhase = "appearance";
      this.renderCreate();
      this.setStatus("");
      this.refreshCreatePreview();
    } catch (error) {
      if (!this.cancelled(generation)) this.reportCreationFailure(error);
    } finally {
      if (!this.cancelled(generation)) {
        this.setPending(false);
        this.focusStage();
      }
    }
  }

  /** The original create packet always carried top, bottom, shoes and weapon. */
  gearPayload() {
    const payload = {};
    for (const field of CREATE_GEAR) payload[field] = this.draft[field];
    return payload;
  }

  acceptCreated(created) {
    const characters = this.transport.characters;
    this.selected = Math.max(
      0,
      characters.findIndex((character) => character.id === created.id),
    );
    this.showCharacters(characters);
    this.setStatus(`${created.name} is ready. Enter the world when you are.`);
    this.enterButton.focus();
  }

  reportCreationFailure(error) {
    this.notify(failureText(error, safeCode(error)));
    this.hooks.report(
      new Error(`Character creation failed (${safeCode(error)})`, {
        cause: error,
      }),
    );
  }

  async prepare(catalog, signal) {
    if (signal?.aborted) return;
    this.catalog = catalog;
    this.visuals = new AvatarVisuals(this.services, catalog);
    this.createSlot = this.previewSlot("create", this.createPreviewElement);
    for (const slot of this.rosterSlots) {
      slot.preview = this.previewSlot(`character-${slot.index}`, slot.portrait);
    }
    await this.startBackdrop(signal);
    if (this.destroyed || signal?.aborted) return;
    this.prepared = true;
    this.adoptCreateDefaults();
    this.renderCreate();
    this.playTitleBgm();
    this.setStatus(
      !this.registrationOverlay.hidden
        ? "Choose an account name and password."
        : "Sign in with your server account.",
    );
    this.renderStage();
    if (!this.dialogs.open && !this.pending) {
      (this.registrationOverlay.hidden
        ? this.name
        : this.registrationName
      ).focus();
    }
  }

  /** Login scenery and UI share the packaged, hash-verified visual resource pipeline. */
  async startBackdrop(signal) {
    if (this.destroyed || this.backdrop) return;
    const backdrop = new LoginBackdrop(this);
    this.backdrop = backdrop;
    try {
      await backdrop.prepare(signal ?? this.controller.signal);
      if (!this.destroyed && this.backdrop === backdrop) {
        backdrop.showStage(this.host.dataset.stage);
      }
    } catch (error) {
      const cancelled = backdrop.controller.signal.aborted || signal?.aborted;
      backdrop.destroy();
      if (this.backdrop === backdrop) this.backdrop = null;
      // Returning to the field can retire scenery while its asset demand awaits.
      if (!cancelled) throw error;
    }
  }

  /** The field owns the canvas once the character is in; falling back re-creates the scenery. */
  stopBackdrop() {
    this.backdrop?.destroy();
    this.backdrop = null;
  }

  /** Stage visibility derives from the active stage plus the character list. */
  renderStage() {
    const changed = this.renderedStage !== this.stage;
    this.renderedStage = this.stage;
    if (changed) this.setStatus("");
    const creating = this.stage === "create";
    const selecting =
      !creating && (this.characters.length > 0 || this.selecting === true);
    this.accountStage.hidden = creating || selecting;
    this.characterStage.hidden = creating || !selecting;
    this.createStage.hidden = !creating;
    this.host.dataset.stage = creating
      ? "create"
      : selecting
        ? "characters"
        : "account";
    this.backdrop?.showStage(this.host.dataset.stage);
    if (creating) {
      this.host.setAttribute(
        "aria-label",
        "Online MapleStory character creation",
      );
      this.renderCreate();
    } else if (selecting) {
      this.host.setAttribute(
        "aria-label",
        "Online MapleStory character selection",
      );
      this.renderRoster();
    } else {
      this.host.setAttribute("aria-label", "Online MapleStory sign in");
    }
  }

  validate(signup) {
    const nameInput = signup ? this.registrationName : this.name;
    const passwordInput = signup ? this.registrationPassword : this.password;
    const name = nameInput.value.trim();
    const password = passwordInput.value;
    if (!ACCOUNT_NAME_PATTERN.test(name)) {
      throw localError(
        "Account names use 3 to 16 letters, digits, underscore or hyphen.",
      );
    }
    if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
      throw localError(
        `Passwords use ${MIN_PASSWORD} to ${MAX_PASSWORD} characters; this one has ${password.length}.`,
      );
    }
    if (signup && password !== this.registrationConfirm.value) {
      throw localError("The confirmation password does not match.");
    }
    return { name, password };
  }

  async submit(signup = false) {
    if (
      this.pending ||
      this.destroyed ||
      this.dialogs.open ||
      this.accountStage.hidden ||
      signup === this.registrationOverlay.hidden
    ) {
      return;
    }
    const credentials = this.validate(signup);
    const generation = ++this.generation;
    this.setPending(true, "Requesting a proof-of-work challenge…");
    try {
      const proof = await this.mineProof();
      if (this.cancelled(generation)) return;
      const characters = await this.authorize(credentials, proof, signup);
      if (this.cancelled(generation)) return;
      this.acceptCharacters(characters);
    } catch (error) {
      if (!this.cancelled(generation)) this.reportAccountFailure(error, signup);
    } finally {
      credentials.password = "";
      this.clearSecrets();
      if (!this.cancelled(generation)) {
        this.finishSubmission();
      }
    }
  }

  finishSubmission() {
    this.setPending(false);
    if (this.dialogs.open || this.stage !== "characters") return;
    (this.characters.length ? this.enterButton : this.createButton).focus();
  }

  /** Keep registration errors in its own window, with focus on the retry fields. */
  reportAccountFailure(error, signup) {
    if (signup) this.reportRegistrationFailure(error);
    else this.report(error);
  }

  reportRegistrationFailure(error) {
    this.setStatus(failureText(error, safeCode(error)));
    this.registrationName.focus();
    this.hooks.report(
      new Error(`Account registration failed (${safeCode(error)})`, {
        cause: error,
      }),
    );
  }

  /** Every awaited step checks this so a stale attempt never publishes over a newer one. */
  cancelled(generation) {
    return this.destroyed || generation !== this.generation;
  }

  async mineProof() {
    // Verify the compiled identity before spending the client's proof-of-work budget.
    await this.transport.initialize();
    const challenge = await this.transport.challenge();
    return solveProofOfWork(challenge, {
      signal: this.controller.signal,
      onProgress: (nonce, elapsed) => {
        const rate = Math.round((nonce / Math.max(1, elapsed)) * 1000);
        this.setStatus(
          `Solving the proof-of-work challenge… ${nonce} hashes (${rate}/s)`,
        );
      },
    });
  }

  async authorize(credentials, proof, signup) {
    this.setStatus(signup ? "Creating the account…" : "Signing in…");
    return signup
      ? this.transport.register({ ...credentials, proof })
      : this.transport.login({ ...credentials, proof });
  }

  acceptCharacters(characters) {
    this.clearSecrets();
    this.resetRegistration();
    this.showCharacters(characters);
    if (!characters.length) {
      this.setStatus("No characters yet. Create your first character.");
    }
  }

  showCharacters(characters) {
    if (!Array.isArray(characters) || characters.length > MAX_CHARACTERS) {
      throw new Error("Server character roster exceeds its admitted bound");
    }
    this.characters = characters.slice();
    this.selected = Math.max(
      0,
      Math.min(this.selected, this.characters.length - 1),
    );
    this.selecting = true;
    this.stage = "characters";
    this.renderStage();
    this.focusStage();
  }

  /** Native controls take focus on arrival; inspecting the scene must not steal tool focus. */
  focusStage() {
    const active = document.activeElement;
    if (
      this.pending ||
      this.dialogs.open ||
      !this.registrationOverlay.hidden ||
      (active !== document.body && !this.host.contains(active))
    ) {
      return;
    }
    if (this.stage === "account") this.name.focus();
    else if (this.stage === "create") {
      const target =
        this.creationPhase === "name"
          ? this.characterNameInput
          : this.creationPhase === "stats"
            ? this.rollButton
            : this.optionRows.face.previous;
      target.focus();
    } else {
      (this.characters.length ? this.enterButton : this.createButton).focus();
    }
  }

  step(delta) {
    if (this.pending || this.characters.length === 0) return;
    const count = this.characters.length;
    this.selected = (this.selected + delta + count) % count;
    this.renderRoster();
  }

  selectCharacter(index) {
    if (this.pending || !this.characters[index] || index === this.selected) {
      return;
    }
    this.selected = index;
    this.renderRoster();
  }

  changePage(delta) {
    if (this.pending || !this.characters.length) return;
    const page = Math.floor(this.selected / CHARACTERS_PER_PAGE) + delta;
    const pages = Math.ceil(this.characters.length / CHARACTERS_PER_PAGE);
    if (page < 0 || page >= pages) return;
    this.selected = page * CHARACTERS_PER_PAGE;
    this.renderRoster();
  }

  /** Exactly three native slots; every server character is reachable by page or keys. */
  renderRoster() {
    const page = Math.floor(this.selected / CHARACTERS_PER_PAGE);
    const pages = Math.max(
      1,
      Math.ceil(this.characters.length / CHARACTERS_PER_PAGE),
    );
    this.renderCharacterInfo(this.characters[this.selected]);
    this.roster.setAttribute(
      "aria-label",
      `Characters, page ${page + 1} of ${pages}`,
    );
    this.previous.disabled = this.pending || page === 0;
    this.next.disabled = this.pending || page + 1 >= pages;
    for (let index = 0; index < this.rosterSlots.length; index++) {
      const absolute = page * CHARACTERS_PER_PAGE + index;
      this.renderRosterSlot(this.rosterSlots[index], absolute);
    }
    this.backdrop?.renderRoster();
  }

  renderRosterSlot(slot, index) {
    const character = this.characters[index] ?? null;
    slot.index = index;
    slot.button.disabled = this.pending || !character;
    slot.button.setAttribute(
      "aria-pressed",
      String(Boolean(character) && index === this.selected),
    );
    slot.button.setAttribute(
      "aria-label",
      character
        ? `Character ${index + 1}: ${character.name}`
        : `Empty character slot ${index + 1}`,
    );
    slot.name.textContent = character?.name ?? "";
    this.renderRosterPreview(slot, character);
  }

  /** Selection changes the retained pose, including a portrait still loading. */
  renderRosterPreview(slot, character) {
    if (!slot.preview || !this.visible) return;
    // 0060599b sends move action 2 to the selected avatar, 4 to the others.
    // 00451ec8 resolves those to the equipped weapon's walk/stand families.
    slot.preview.pose.action =
      slot.index === this.selected ? "walk1" : "stand1";
    slot.preview.prepared?.pose(slot.preview.pose);
    if (
      slot.character === character &&
      (slot.preview.prepared ||
        slot.preview.controller?.signal.aborted === false)
    ) {
      return;
    }
    slot.character = character;
    slot.preview.controller?.abort();
    slot.preview.generation++;
    this.clearPreview(slot.preview);
    if (character) this.renderPortrait(slot.preview, character);
  }

  /** A summary that cannot compose is reported and left empty, never defaulted. */
  renderPortrait(preview, character) {
    let profile;
    try {
      profile = this.characterProfile(character);
    } catch (error) {
      this.clearPreview(preview);
      this.notify(
        "This character's look could not be read from the server. Sign in again.",
      );
      this.hooks.report(error);
      return;
    }
    this.showPreview(preview, profile).catch((error) => this.report(error));
  }

  keyboardBlocked() {
    return (
      this.pending ||
      this.dialogs.open ||
      !this.registrationOverlay.hidden ||
      this.window.querySelector(".online-login-body").inert
    );
  }

  /** Roster keys select across pages; Enter always uses the selected server identity. */
  onKey(event) {
    if (this.keyboardBlocked()) return;
    if (event.key === "Enter" && event.target.closest("button")) return;
    if (this.stage === "create" && !this.createStage.hidden) {
      if (event.key === "Enter") {
        this.createCharacter().catch((error) => this.report(error));
      } else if (event.key === "Escape") {
        this.stepBack();
      } else {
        return;
      }
      event.preventDefault();
      return;
    }
    if (this.characterStage.hidden) return;
    if (event.key === "ArrowLeft") this.step(-1);
    else if (event.key === "ArrowRight") this.step(1);
    else if (event.key === "Enter") {
      this.enter().catch((error) => this.report(error));
    } else return;
    event.preventDefault();
  }

  async refreshCharacters() {
    if (this.pending || this.destroyed) return;
    const generation = ++this.generation;
    this.setPending(true, "Refreshing characters…");
    try {
      const characters = await this.transport.listCharacters();
      if (this.destroyed || generation !== this.generation) return;
      this.showCharacters(characters);
      this.setStatus(
        characters.length
          ? "Choose a character, then enter the authoritative field."
          : "No characters yet. Create your first character.",
      );
    } catch (error) {
      if (!this.destroyed && generation === this.generation) this.report(error);
    } finally {
      if (!this.destroyed && generation === this.generation) {
        this.setPending(false);
      }
    }
  }

  async enter() {
    if (this.pending || this.destroyed || !this.characters.length) return;
    const generation = ++this.generation;
    this.playCue("CharSelect");
    this.setPending(true, "Connecting to the authoritative field…");
    try {
      await this.connectField(this.characters[this.selected].id);
    } catch (error) {
      if (!this.destroyed && generation === this.generation) this.report(error);
    } finally {
      if (!this.destroyed && generation === this.generation) {
        this.setPending(false);
      }
    }
  }

  /** The server closes a busy character's previous session; one bounded retry follows its delay. */
  async connectField(characterId) {
    try {
      await this.transport.connect({ characterId });
    } catch (error) {
      if (error?.code !== "CHARACTER_BUSY") throw error;
      const delay = Number(this.transport.retryAfterMs);
      if (!Number.isFinite(delay) || delay < 0 || delay > 5000) throw error;
      this.setStatus("That character is still connected. Retrying…");
      await new Promise((resolve) => {
        setTimeout(resolve, delay);
      });
      if (this.destroyed) return;
      await this.transport.connect({ characterId });
    }
  }

  async signOut() {
    if (this.pending || this.destroyed) return;
    const generation = ++this.generation;
    this.setPending(true, "Signing out…");
    try {
      await this.transport.revoke();
      if (this.destroyed || generation !== this.generation) return;
      this.selectionReset();
      this.setStatus("Signed out. Sign in with your server account.");
      this.name.focus();
    } catch (error) {
      if (!this.destroyed && generation === this.generation) this.report(error);
    } finally {
      if (!this.destroyed && generation === this.generation) {
        this.setPending(false);
      }
    }
  }

  selectionReset() {
    this.characters = [];
    this.selected = 0;
    this.selecting = false;
    this.stage = "account";
    this.clearSecrets();
    this.resetRegistration();
    this.releasePreview();
    this.renderStage();
  }

  setPending(pending, message) {
    this.pending = pending;
    this.host.setAttribute("aria-busy", String(pending || this.dialogs.open));
    this.setRegistrationPending(pending);
    if (message) this.setStatus(message);
    for (const control of [
      this.name,
      this.password,
      this.signUpTab,
      this.registrationName,
      this.registrationPassword,
      this.registrationConfirm,
      this.registrationSubmit,
      this.registrationCancel,
      this.registrationClose,
      this.submitButton,
      this.characterNameInput,
      this.submitCreate,
    ]) {
      control.disabled = pending;
    }
    for (const { button } of this.accountButtons) button.disabled = pending;
    for (const control of [this.enterButton, this.deleteButton]) {
      control.disabled = pending || !this.characters.length || !this.prepared;
    }
    for (const control of [
      this.createButton,
      this.refreshButton,
      this.signOutButton,
    ]) {
      control.disabled = pending || !this.prepared;
    }
    this.renderRoster();
    this.backButton.disabled = pending;
    this.renderCreate();
  }

  setRegistrationPending(pending) {
    this.registrationWindow.setAttribute("aria-busy", String(pending));
    if (pending && !this.registrationOverlay.hidden && !this.dialogs.open) {
      this.registrationWindow.focus();
    }
  }

  status(value) {
    if (value.status === "active") {
      if (!this.visible) return;
      this.visible = false;
      this.host.hidden = true;
      this.clearSecrets();
      this.resetRegistration();
      this.stopBackdrop();
      // The field owns the screen and the residency budget while it is live; a
      // hidden portrait must not keep preview atlases resident behind it.
      this.releasePreview();
      this.entered = true;
      this.hooks.entered?.();
      return;
    }
    if (value.status !== "disconnected") return;
    const wasHidden = !this.visible;
    this.visible = true;
    this.host.hidden = false;
    if (wasHidden || value.code === "SIGNED_OUT") this.selectionReset();
    if (wasHidden) {
      // The login surface cannot share the budget with a field it replaced:
      // release the retained field before reserving login artwork.
      this.hooks.releaseField?.();
      this.startBackdrop(this.controller.signal).catch((error) =>
        this.report(error),
      );
      this.playTitleBgm();
    }
    const message = this.disconnectionMessage(value.code, wasHidden);
    if (message) this.setStatus(message);
  }

  disconnectionMessage(code, wasHidden) {
    if (code === "SIGNED_OUT") {
      return "Signed out. Sign in with your server account.";
    } else if (["SESSION_EXPIRED", "UNAUTHENTICATED"].includes(code)) {
      return "Your account session expired. Sign in again to continue.";
    } else if (code === "RECOVERY_EXHAUSTED" || code === "RECOVERY_TIMEOUT") {
      return "Connection recovery failed. Sign in again to reconnect.";
    } else if (wasHidden) {
      return "Connection closed. Sign in again, or press Enter to reconnect.";
    }
    return null;
  }

  resize(width, height) {
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0
    ) {
      throw new Error("Invalid online login viewport");
    }
    this.width = width;
    this.height = height;
    this.host.dataset.viewport = width < 900 ? "compact" : "wide";
    const scale = Math.min(1, width / 800, height / 600);
    this.window.style.transform = `translate(-50%, -50%) scale(${scale})`;
    this.backdrop?.cursor?.resize(width, height);
  }

  /** Each composed preview plane redraws only when its sprite tree changed. */
  draw(elapsedMs) {
    if (!this.visible || this.destroyed) return;
    this.advancePresentation(this.presentationPaused ? 0 : elapsedMs);
  }

  /** Advance only login artwork, never the authenticated game simulation. */
  stepPresentation(ms) {
    if (!this.presentationPaused || !this.visible || !this.backdrop) return;
    this.advancePresentation(ms);
  }

  advancePresentation(ms) {
    this.diceElapsedMs = Math.min(320, this.diceElapsedMs + ms);
    this.backdrop?.update(ms);
    const ratio = window.devicePixelRatio || 1;
    const creating = this.stage === "create";
    for (const slot of this.previews) {
      if (!slot.prepared || slot.element.hidden) continue;
      if ((slot === this.createSlot) !== creating) continue;
      slot.prepared.update(ms);
      slot.plane.sync(ratio, ratio);
    }
  }

  /** Read-only diagnostics never include passwords or proof material. */
  snapshot() {
    return {
      visible: this.visible,
      stage: this.host.dataset.stage,
      status: this.statusText,
      paused: this.presentationPaused,
      artwork: Boolean(this.backdrop?.ready),
      catalogBuildId: this.catalog?.buildId ?? null,
      characters: this.characters.length,
      page: Math.floor(this.selected / CHARACTERS_PER_PAGE),
      selected: this.selected,
      creationPhase: this.creationPhase,
      dice: {
        rolling: Boolean(this.rollingStats || this.diceElapsedMs < 320),
        elapsedMs: this.diceElapsedMs,
      },
      portraits: this.previews.reduce(
        (count, slot) => count + Number(Boolean(slot.prepared)),
        0,
      ),
      ...this.backdrop?.snapshot(),
    };
  }

  releasePreview() {
    for (const slot of this.previews) {
      slot.controller?.abort();
      slot.controller = null;
      this.clearPreview(slot);
      slot.generation++;
    }
  }

  /** Original login modal artwork frames messages that require acknowledgement. */
  notify(text) {
    this.dialogs
      .message({ title: "MapleStory", text, ok: "OK" })
      .catch((error) => this.hooks.report(error));
  }

  report(error) {
    // Local validation text is ours; server codes map to explicit wording (never raw server text).
    const code = safeCode(error);
    this.notify(failureText(error, code));
    this.hooks.report(
      new Error(`Online login request failed (${code})`, { cause: error }),
    );
  }

  listen(target, type, handler, capture = false) {
    target.addEventListener(type, handler, { capture });
    this.listeners.push({ target, type, handler, capture });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearSecrets();
    this.resetRegistration();
    this.controller.abort();
    this.generation++;
    this.releasePreview();
    this.stopBackdrop();
    this.dialogs?.destroy();
    this.recovery?.destroy();
    for (const slot of this.previews) {
      slot.plane.destroy();
      slot.root.destroy({ children: true });
    }
    for (const { target, type, handler, capture } of this.listeners) {
      target.removeEventListener(type, handler, { capture });
    }
    this.host.remove();
    this.listeners.length = 0;
  }
}

/** Server codes are surfaced only while they match the bounded protocol vocabulary shape. */
function safeCode(error) {
  const code = error?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{2,31}$/.test(code)
    ? code
    : "REQUEST_FAILED";
}
