# Sign-in and reconnect

A player signs in, enters a starter character and reconnects the same character through the visible development control.

## Sub-features

- `login-entry` reaches the field from the account and password form.
- `reconnect-session` obtains a new active connection while retaining character, map and mesos.
- `reconnect-repeat` explores repeated reconnects and intervening actions as a separate bug-discovery experiment.
- `quit-sign-in` uses the normal Quit confirmation, checks session revocation, and signs back into the same character.

## How to get to it (user POV)

Enter `playtester` and `password` in the sign-in form, choose Sign in, then Enter the world. During gameplay, expand development tools, choose Diagnostics, and click Reconnect session. For a full sign-out, open GameMenu, choose Quit and confirm OK, then sign in through the form again.

## Driving it with playtest

Preconditions: use the runner's fresh fixture and wait for game assets and character selection to finish.

- Every playtest automatically types into the real sign-in controls and enters the character before executing its plan.
- Run `bun run playtest --plan .agents/skills/verify-openms/plans/smoke.json` with the platform's `--chrome` path. Its final `reconnect` action drives the visible control and waits for active gameplay.
- Inspect `entry` and reconnect trace observations. The character, map and mesos must be unchanged; the connection epoch must change.
- Run [session-cycle.json](../plans/session-cycle.json) for native Quit and re-entry. The `relogin` trace must contain `during.authenticationStatus: 401` before sign-in, then a new epoch with unchanged character, map and mesos. Later window/chat actions check controls after re-entry.
- To investigate repetition, run `bun run playtest --seed 42 --steps 8` and inspect the saved plan. Replay the actual saved plan before claiming a repeatable failure.

## Gotchas

- A responsive configuration endpoint does not establish that the character reconnected.
- A healthy service with a disconnected page is still a failed player flow; the runner captures it before teardown.
- This recipe covers the development reconnect button and native Quit/sign-in. It does not prove browser-reload recovery, network-loss recovery, registration or password recovery.
- Account fixtures are disposable and do not change the user's normal accounts.
