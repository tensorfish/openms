# Movement and jumping

A player moves left or right and jumps using the default beginner controls.

## Sub-features

- `walk-left` and `walk-right` hold an arrow key for a bounded duration.
- `jump-direction` presses Alt while moving left or right.

## How to get to it (user POV)

Enter the field, click empty canvas space to focus it, hold an arrow key, and press Alt to jump.

## Driving it with playtest

Preconditions: an active beginner character using the fixture's default bindings.

- Run `bun run playtest --plan .agents/skills/verify-openms/plans/smoke.json` with the platform's `--chrome` path for walking and jumping.
- For directed experiments, supply a `walk` action with `direction: left` or `right` and `milliseconds` from 100 to 1500. Supply a `jump` action with either direction.
- Compare authoritative `x/y` and presented `localX/localY` in the before/during/after observations. Observe displacement and a jump arc when the character has room to move.
- Inspect the screenshot and retained states for suspected stuck or invisible characters, then reproduce from the same initial fixture.

## Gotchas

- Walls, map edges and airborne state can legitimately prevent a movement request from changing position. The runner flags nonfinite state and runtime failures; zero displacement needs human/agent investigation.
- Position observations are asynchronous. A seed reproduces the inputs, not exact simulation timing.
- The runner releases held direction keys in a finally block. Failed runs still close the owned context and database.
- These checks do not establish collision, combat, climbing, portal or original-client physics fidelity.
