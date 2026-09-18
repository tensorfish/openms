# Online agent and development interface

The online browser exposes `window.maple.agent` for normal player actions and read-only observation. It exposes `window.maple.dev` for audited server development actions. Both surfaces use the current input, UI, transport and server authority; they do not create a second simulation.

Await `maple.ready` before using either surface. Normal gameplay refusal remains a refusal, and development actions require a development server plus an authenticated developer character.

For isolated agent bug discovery, use the [playtesting pipeline](agent-playtesting.md). It drives the real browser controls, records read-only observations and replayable action plans, and owns a disposable database instead of sharing the user's session.

## Permission and human takeover

1. A human activates **Allow agent control** in the Agent section. A script-generated click cannot grant permission.
2. The caller runs `maple.agent.acquire("descriptive label")`. Labels contain 1–80 characters.
3. Only one command may be pending. Commands are never queued.
4. Trusted keyboard, pointer-down or wheel input revokes the lease before normal gameplay consumes the event. Window blur and a hidden document also revoke it.
5. `maple.agent.release()` or **Stop agent** clears held input and consumes permission. Resuming requires a fresh human grant.

Permission is session-only. It is an interaction safeguard, not a JavaScript security boundary.

## Normal action API

```js
await maple.ready;

const agent = maple.agent;
agent.status();
agent.observe();

// After the human grants permission:
agent.acquire("movement check");
await agent.act({ type: "action", action: "right", phase: "hold" });
await agent.act({ type: "action", action: "right", phase: "release" });
agent.release();
```

The admitted command families are:

| Type | Purpose |
| --- | --- |
| `key` | Dispatch an allowed physical key code and phase through the shared input owner. |
| `action` | Dispatch a named player action such as movement, jump or attack through current bindings. |
| `interact` | Interact with a resident entity through ordinary world admission. |
| `chat` | Submit through the current channel, relationship and server chat rules. |
| `inventory` | Use an owned item through ordinary inventory admission. |
| `ui` | Open or operate a supported native window action. |
| `keyConfig` | Edit and save through the native binding transaction. |

`hold` and `press` establish a down edge; an explicit `release` ends the hold. Returned `{accepted:false}` results remain visible refusals. A thrown command failure consumes permission and requires a fresh grant.

`agent.status()` returns permission, active owner, generation, readiness and pending-command state. `agent.observe()` returns a detached online snapshot containing connection/content identity, prediction state, current quest projection, bounded recent inspection records and the server-owned participant/read model. `agent.capture()` returns a PNG data URL from the actual Pixi canvas; it excludes DOM windows and inspection controls.

Read-only observation and capture do not require a lease. They cannot authorize actions or mutate returned state back into the game.

## Audited server experiments

`maple.dev.describe()` returns the current development capability, connection and scene summary. `maple.dev.describe({entityId})` restricts its bounded entity result to one ID.

The automation API additionally requires an active human-granted agent lease:

```js
maple.agent.acquire("server setup");

await maple.dev.scenarios.setup({ kind: "map", mapId: 100000000 });
await maple.dev.scenarios.setup({ kind: "preset", job: 100 });
await maple.dev.scenarios.setup({
  kind: "spawn",
  templateId: 100100,
  count: 1,
});
await maple.dev.scenarios.pause(true);
await maple.dev.scenarios.step(1); // 1–4 authoritative 30 ms ticks
await maple.dev.scenarios.pause(false);
```

`setup` accepts only the closed `map`, `preset`, `spawn`, `profile` and `physics` actions. The server validates developer role, field ownership, inputs and operation identity. An unknown transport result is recovered using the same operation ID rather than resubmitting a second mutation.

These actions can persist according to server rules. There is no temporary browser profile, saved local baseline, recording replay or automatic rollback. Use a dedicated development realm and explicitly restore any fixture state the check changes.

The visible **Server experiments** controls use the same audited server endpoint. A trusted human click does not require an agent lease, but it still requires developer authorization and an active online session.

## Ownership and implementation

| Module | Responsibility |
| --- | --- |
| `client/src/development/agent-control.js` | Human grant, lease, takeover and one-command ownership. |
| `client/src/online/inspection.js` | Online observations, normal-action dispatch and server result logging. |
| `client/src/online/inspection-development.js` | Closed development action adapter and visible experiment controls. |
| `client/src/input/player-actions.js` | Shared normal player action admission. |
| `client/src/online/transport.js` | Authenticated command and development-operation transport. |

Use the [online validation procedure](validation-method.md) for scenario isolation, evidence identity and reconnect checks. The [server protocol](server/protocol.md) defines authority and retry boundaries.
