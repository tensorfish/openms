# OpenMS verification map

Each run starts a fresh ordinary beginner in Henesys and signs in through the browser. Read the parent [skill](../SKILL.md) for prerequisites, flags, evidence and cleanup.

## Features

- [Sign-in and reconnect](login-reconnect.md): sign in, enter the selected character, reconnect through Diagnostics or quit and sign back in, and observe character continuity.
- [Movement and jumping](movement.md): native left/right and jump inputs with position observations.
- [Character windows](windows.md): Item, Equip, Stat and Skill through keyboard and HUD entry, then close buttons, shortcut toggles or Escape.
- [Map chat and input focus](chat.md): submit or cancel a draft without moving the character or triggering window shortcuts.

## Baseline and reporting

Use [smoke.json](../plans/smoke.json) for the mapped baseline. It drives both entry methods for each listed window and one reconnect. The additional focused plans are [window-dismissal.json](../plans/window-dismissal.json), [chat-focus.json](../plans/chat-focus.json) and [session-cycle.json](../plans/session-cycle.json). Run each separately in a fresh fixture. Custom plans and seeded exploration extend coverage through different ordering, direction, durations and repeated reconnects.

Use a new output directory for every run. Never share the user's game session or run competing builds in one checkout. The database, browser and listener ownership belong to the command that created them.

A feature is verified only through the entry points actually driven. A JSON plan is a recipe, not proof. Report skipped or unreachable paths and unmet prerequisites explicitly. Combat, NPC dialogue, portals, quests, multiplayer, registration, character creation/deletion and original-client fidelity remain outside this initial map.
