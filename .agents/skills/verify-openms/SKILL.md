---
name: verify-openms
description: Playtest OpenMS in an isolated local browser and database, choose or replay bounded native-input action plans, and investigate reproducible gameplay or UI failures with retained evidence. Use for agent playtesting, bug discovery, and verification of mapped player flows.
---

# Verify OpenMS

Read [the feature map](features/README.md), then select the relevant recipe. This first version covers a beginner in Henesys, sign-in/reconnect, native Quit/sign-in, movement/jumping, character windows and map chat. Combat, quests, portals, multiplayer and visual/audio fidelity require separate scenarios; a passing run does not verify them.

## Launch

Run from the repository root with Bun, dependencies, `.env.server`, `.env.client`, a running local PostgreSQL instance and completed `client/public/generated/` assets. The PostgreSQL role must be able to create disposable databases. Reuse extraction; this workflow does not download assets or run original executables.

On Windows:

```powershell
bun run playtest --chrome "C:\Program Files\Google\Chrome\Application\chrome.exe" --plan .agents/skills/verify-openms/plans/smoke.json --output artifacts/playtest/smoke-001
```

On macOS, omit `--chrome` to use the existing Google Chrome default. Other installations must pass their actual Chromium executable through `--chrome`. `--headed` makes the owned browser visible.

The command creates an ordinary `playtester` account and detached beginner fixture in a unique `openms_check_*` database, starts an owned backend on 3297 and frontend on 3197, drives the browser, then tears everything down. It never drives the user's normal 3102 session. The fixture password is the published development value `password`.

Use `--database-url` for a different local PostgreSQL connection. Use `--server-port` and `--client-port` together for different, unused ports. Ports already in use cause a blocked run, not attachment to the existing process. Run serially within one checkout because browser builds share generated outputs. Keep the source tree unchanged during a run.

## Doctor

Before gameplay, the runner reads the served catalog/configuration, checks the catalog against the workspace, calculates the expected source identity, then compares it with the authenticated browser's observed build and active character. Listener ownership comes from the fixture that started those listeners.

For diagnosis while a fixture is running:

```sh
bun server/tools/playtest-doctor.js --url http://127.0.0.1:3197
```

This standalone command is read-only. Its `expectedIdentity` is followed by explicit `not-checked` markers for browser source, authentication and ownership. It cannot replace the in-browser checks. After a failed drive, the runner captures evidence, repeats the service doctor, and tears down. Begin any retry with a new fixture; never keep issuing actions to the failed page.

## Drive

For bounded exploration, replace `--plan` with `--seed 42 --steps 12`. The seed selects the action sequence; it does not make network timing or simulation timing deterministic. Generated plans begin with movement, a jump and inventory, and finish with a reconnect.

For an agent-designed experiment, write a JSON file with `version: 1` and an `actions` array. The accepted actions are:

```json
{
  "version": 1,
  "actions": [
    { "type": "walk", "direction": "right", "milliseconds": 400 },
    { "type": "jump", "direction": "left" },
    { "type": "window", "name": "Item", "entry": "hud" },
    { "type": "reconnect" }
  ]
}
```

Plans allow 1–32 actions, walking for 100–1500 ms, left/right movement, and Item/Equip/Stat/Skill windows through keyboard or HUD entry. Every action uses normal Puppeteer keyboard/pointer input. Each window action opens and closes the window. Optional `close` selects `button`, `shortcut` or `escape`; omitting it preserves the close-button behavior. Reconnect uses the visible development Diagnostics → Reconnect session button. Read-only snapshots supply observations. Do not call internal setters, grant an agent lease through script, or replace earned outcomes with development mutations.

A `chat` action takes `text` and `mode: send` or `cancel`. Text must be 1–70 printable ASCII characters without surrounding spaces or slash commands. It selects To All, types natively, checks that shortcut letters and a held arrow stay in the editor, then either waits for a server-confirmed row or cancels with Escape. A `relogin` action uses GameMenu → Quit → OK, checks that the old session receives HTTP 401 from the character list, and signs back in through the form. Both reconnect and relogin require a new connection epoch with the same character, map and mesos.

Run these focused plans separately, each with a fresh output directory:

- [window-dismissal.json](plans/window-dismissal.json) checks shortcut toggles and Escape dismissal for all four windows.
- [chat-focus.json](plans/chat-focus.json) checks draft cancellation, server-confirmed map chat, and control use after leaving chat.
- [session-cycle.json](plans/session-cycle.json) checks native Quit/sign-in and subsequent window/chat controls.

Seed generation retains its original movement/window/reconnect vocabulary so existing seeds keep their sequences. Use saved plans for the added chat and relogin actions.

The agent loop is: select a mapped behavior or vary a bounded action plan, run it, inspect `report.json` and images, then choose the next experiment. Replay a candidate in a fresh fixture with the saved plan:

```powershell
bun run playtest --chrome "C:\Program Files\Google\Chrome\Application\chrome.exe" --plan artifacts/playtest/smoke-001/plan.json --output artifacts/playtest/replay-001
```

Choose a new output directory each time. Existing output paths are rejected. After reproduction, minimize the plan by removing actions while retaining the observed failure. Compare the actual symptoms and before/after observations, not only the fingerprint. Do not report an unreproduced timeout as a confirmed product bug; it may be a runner problem or transient state.

## Evidence

The requested output directory retains `plan.json`, `report.json`, a final screenshot on success, and a failure screenshot plus recent frames when available. The report includes source/catalog/rules identities, before/during/after action observations, bounded browser and service events, stage timings and cleanup status. Frame capture is a short rolling buffer, not a full video.

Exit 0 means the executed checks passed. Exit 1 means a bug candidate needs triage. Exit 2 means setup, cancellation, unavailable services, changed identity or cleanup prevented a trustworthy completion. A candidate can still be a harness gap. Inspect `failure`, `infrastructureFailure`, `doctorAfterFailure` and `cleanup` before making a claim.

Window visibility and closure are asserted. Movement records displacement and finite positions; hitting a wall is not itself an error. Reconnect and relogin check a new connection with the same character, map and mesos. Chat observations in `during` retain the draft, focus, horizontal position, visible windows and matching delivery rows. Only the sender is observed; this does not prove delivery to another player. These are narrow observable contracts, not comprehensive gameplay or persistence proof. Screenshots need visual review before claiming appearance correctness.

Retain raw reports/logs/images under ignored `artifacts/` or outside the checkout. Commit only concise findings and reusable action plans. Report a bug with its expected/observed behavior, minimal plan, source identities, reproducibility and evidence locations. Publishing GitHub issues or comments requires the user's instruction.

## Cleanup

The fixture closes its own browser/context, listeners and database pool, drops only its uniquely named test database, and retains the output directory. A completed report must show `cleanup.status: complete`. Verify the report and images still exist after the command exits.

Ctrl+C requests cleanup after the current bounded operation settles. An OS-level kill cannot guarantee cleanup. If cleanup is unconfirmed, use the recorded fixture identity and process ownership to inspect remaining resources; never kill processes by name or drop the user's configured database. Do not delete evidence to make a retry pass.

## Helpers and maintenance

The implementations are [playtest.js](../../../server/tools/playtest.js), [playtest-doctor.js](../../../server/tools/playtest-doctor.js), and the existing isolated fixture and scenario helpers they import. Use `bun run playtest --help` for flags. The skill adds no model dependency and does not install JEV.

Use the repository's [maintain-verification-skill](../maintain-verification-skill/SKILL.md) to audit the feature map as the app changes. Its edit scope is this skill directory; product bugs and changes to the shared runner belong in separate implementation work. The [creator](../create-verification-skill/SKILL.md), maintainer and bundled references are vendored from `backnotprop/pstack` revision `157aae39a733135e93d8b5b19ff62c6a84b0ad56`, with their upstream MIT licenses. All three skills are available from this checkout.
