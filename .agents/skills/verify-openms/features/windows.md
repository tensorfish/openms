# Character windows

A player opens Item Inventory, Equipment, Ability and Skill windows from a shortcut or the HUD and closes them through their close buttons, shortcut keys or Escape.

## Sub-features

- `item-window`: I or Item Inventory (I), then Close Item.
- `equip-window`: E or Equipment Window (E), then Close Equip.
- `stat-window`: S or Ability Window (S), then Close Stat.
- `skill-window`: K or Skill Window (K), then Close Skill.

## How to get to it (user POV)

During active gameplay, focus the canvas and press the shortcut, or click the matching HUD button. Use the window's close button, press its shortcut again, or press Escape to return to gameplay.

## Driving it with playtest

Preconditions: an active character with default key bindings and no blocking dialogue.

- Run `bun run playtest --plan .agents/skills/verify-openms/plans/smoke.json` with the platform's `--chrome` path. It exercises both entry methods for each window.
- A custom action uses `type: window`, `name: Item`, `Equip`, `Stat` or `Skill`, and `entry: keyboard` or `hud`.
- The runner waits for the named panel to be visible, captures its opened state in `during.windows`, clicks its Close control and waits for the panel to disappear.
- Run [window-dismissal.json](../plans/window-dismissal.json) for all four shortcut toggles and all four HUD-open/Escape-close paths. Custom actions select `close: button`, `shortcut` or `escape`; the default is `button`. Every path waits for the named panel to become visible and then disappear.
- Check before/during/after observations and screenshots for suspected missing or misplaced windows. Replay the saved plan before classifying the result.

## Gotchas

- Opening a window is not proof of equipping, item use, AP/SP allocation or skill execution; those require separate recipes.
- The runner closes each window before the next action. Overlapping windows, dragging, custom bindings and menu alternatives are outside this first plan format.
- A timeout can indicate a selector/runner gap. Check the screenshot before reporting a product regression.
