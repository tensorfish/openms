# Development

Server and client settings, operation and architecture. For a first run, follow [Quick Start](index.md); for authoring, see [Custom content](custom-content.md).

## Settings

Copy the tracked example templates once, without overwriting existing local settings:

```sh
cp -n .env.server.example .env.server
cp -n .env.client.example .env.client
cp -n .env.studio.example .env.studio
```

Scoped `.env.server`, `.env.client` and `.env.studio` are loaded relative to the repository. Git ignores `.env` and `.env.*`, with exceptions for `.env.example` and `.env.*.example`; only templates belong in commits. Keep shared defaults in the examples and real credentials in local files or the process environment. Example templates are not loaded directly.

Process environment takes precedence. The scoped loader does not read `.env` or `.env*.local` as overlays; Bun's own environment loading still applies. `OPENMS_MODE` is process-only, and `NODE_ENV=production` forces production mode.

## Server

The Bun server owns shared gameplay and persists accounts, progress and custom content in PostgreSQL.

### Database

```sh
podman compose -f infra/compose.yaml up -d --build --wait --wait-timeout 90
```

[Compose](../infra/compose.yaml) builds the pinned PostgreSQL image, starts it, and waits for database health. On an empty volume, PostgreSQL creates the `openms` database and user. The default connection in `.env.server` is:

```text
postgres://openms:openms_local_only@127.0.0.1:55432/openms
```

These are published local development credentials. PostgreSQL data is retained in the `openms-postgres-data` volume. If an older standalone `openms-postgres` container uses that same volume, stop it before starting Compose. The Bun launchers connect to PostgreSQL; they do not start a database process.

### Migrations

Run the migration CLI against the same database configured in `.env.server`:

```sh
bun run migrate --database-url postgres://openms:openms_local_only@127.0.0.1:55432/openms
```

The equivalent workspace command is `bun tools/openms.js migrate --database-url URL`. The CLI reads the numbered PostgreSQL scripts directly in `infra/sql/`; `--sql-root DIR` selects another SQL directory. It requires `--database-url` explicitly and does not read `.env.server` or ambient environment variables. No generated assets or running backend are needed to migrate.

On its first run, the CLI creates the **`migrations` table inside PostgreSQL** to record each script's version, filename, SHA-256 and application time. Migration history is kept in that database table. Scripts run in numeric order, with pending changes in one transaction. Unchanged applied scripts are skipped; a changed applied script or failed SQL statement stops the run. Existing development databases created by the old startup runner are adopted by replaying the idempotent scripts once and recording them, preserving their data.

Run this command on initial setup and after pulling changes that add SQL scripts. Database creation in Compose creates the database/user; `migrate` creates or updates the application schema. The `infra/sql/tables/` and `infra/sql/data/` directories remain gameplay reference inputs for extraction and are excluded from migration.

### Run {#server-run}

In one terminal, leave this running:

```sh
bun run server:dev
```

The launcher performs the following automatically:

1. Loads `.env.server`, reads the generated catalog and verifies the content it loads.
2. Connects to PostgreSQL and checks the `migrations` table against the schema version required by this runtime. Startup does not create tables or run SQL scripts.
3. Creates or restores the `admin` and `player` development accounts. If an account has no characters, it creates a starter character.
4. Registers the asset catalog in `content_asset_build`, loads any active Studio world release, and starts the authoritative server on **http://127.0.0.1:3200**.

Wait for **`authoritative server ready`**. A missing or incompatible schema fails startup with `MIGRATIONS_REQUIRED`; run [Migrations](#migrations), then restart. Development account provisioning remains part of `server:dev`; schema migration belongs exclusively to the CLI.

Continue with the [client](#client), or open [Studio](#studio) to author content.

### Restart

Stop the Bun processes with **Ctrl-C**, then stop the database:

```sh
podman compose -f infra/compose.yaml stop
```

To resume after an ordinary stop, start the Podman machine first if needed, then:

```sh
podman compose -f infra/compose.yaml up -d --wait --wait-timeout 90
```

Run `migrate` if SQL scripts have changed since the last run. Then run `server:dev`, `client:dev` and optionally `studio:dev` again in separate terminals. Reuse the existing extracted content and database volume. Do not use `down --volumes` for an ordinary stop: it deletes the saved database.

After runtime changes, restart the backend and affected frontend, reload and sign in again. The current rules identity includes shared client code, so game runtime changes require both backend and game frontend to restart. [Restart requirements](validation-method.md#current-invalidation-and-reuse-constraints) explain the boundaries; input changes require a new extraction.

### Settings {#server-settings}

Configure `.env.server`:

| Setting                      | Default                                | Meaning                                            |
| ---------------------------- | -------------------------------------- | -------------------------------------------------- |
| `OPENMS_HOST`, `OPENMS_PORT` | `127.0.0.1`, `3200`                    | Backend listener                                   |
| `OPENMS_ORIGIN`              | `http://127.0.0.1:3102`                | Browser origin allowed to authenticate/play        |
| `OPENMS_STUDIO_ORIGIN`       | `http://127.0.0.1:3103`                | Separate browser origin for sessions and authoring |
| `DATABASE_URL`               | Dedicated local database on port 55432 | PostgreSQL connection                              |
| `OPENMS_CONTENT_ROOT`        | `client/public/generated`              | Verified immutable content                         |
| `OPENMS_POW_BITS`            | `15`                                   | Login/registration proof difficulty, valid 8–24    |
| `OPENMS_MOTION_WATCHDOG_ENABLED` | `false` | Motion discrepancy enforcement; accepts exactly `true` or `false` |
| `OPENMS_DEV_PASSWORD`        | `password`                             | Bootstrap account password override                |

Compose defaults are `POSTGRES_USER=openms`, `POSTGRES_PASSWORD=openms_local_only`, `POSTGRES_DB=openms`, `POSTGRES_PORT=55432`. Export overrides or pass a private `--env-file` to Compose, then supply a matching `DATABASE_URL` to Bun. Compose and Bun do not load each other's scoped files.

The motion watchdog is temporarily disabled by default in development and production. Set `OPENMS_MOTION_WATCHDOG_ENABLED=true` in `.env.server` to restore its lag-tolerant enforcement, or `false` to disable it. Disabled mode skips discrepancy evidence and kicks for both ordinary movement reports and reconnect reports. Finite motion validation, input ordering and independent server movement simulation always apply. Client position reports remain diagnostic hints in either mode; checkpoints correct local prediction. Restart the backend after changing the setting; its startup line reports `motion watchdog enabled` or `disabled`. This setting needs no extraction or asset rebuild.

#### Network

For LAN development, configure reachable listener addresses and `OPENMS_SERVER_URL`, then set `OPENMS_ORIGIN` to the exact game browser URL and `OPENMS_STUDIO_ORIGIN` to Studio's separate public origin. Set Studio's `OPENMS_CLIENT_URL` to the public game origin. A wildcard bind address is not a browser origin. Keep privileged development services on a trusted network. Production uses HTTPS with each frontend proxying its own API requests; browser bundles contain no server secrets.

#### Development

World search/Go, pause/step, physics changes, monster spawning, Character presets, conjure, stats, skills and supported profile edits use the audited HTTP development endpoint. Requests require developer role, development mode, session/CSRF proof, accepted origin and current connection epoch. Normal player sessions cannot use them. Camera/geometry display is local presentation. [Development requests](server/protocol.md#development-requests) defines the closed operations; [inspection](inspection-tools.md) explains the UI.

### Troubleshooting

Both launchers write structured development logs to **stdout**, including startup stages, elapsed time, identities, HTTP refusals, WebSocket lifecycle and operation outcomes. Each entry starts with an ISO 8601 **UTC date and time**, including milliseconds and the `Z` timezone marker: `[2026-09-15T14:30:45.123Z] [server +125.4ms] listener.ready {...}`. Elapsed time uses a separate monotonic clock, so changing the system clock does not change duration measurements. Client build progress, startup messages, browser console diagnostics and server errors use the same date-time prefix; ordinary messages omit elapsed time. Structured diagnostics exclude passwords, cookies, tickets and message bodies. The development launcher separately prints its bootstrap credentials to the terminal with timestamps.

| Symptom                                    | Check / correction                                                                                                                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `403 NOT_ALLOWED` on login or registration | Find `http.rejected`. For `reason: origin-mismatch`, compare request origin with `development.start`'s configured origin. Otherwise check challenge/CSRF proof and session state.   |
| `localhost` works but another host fails   | Loopback development admits `localhost`, `127.0.0.1` and `[::1]` only with the configured scheme/port; cookies remain host-specific. LAN and production origins must match exactly. |
| `CONTENT_MISMATCH` after code changes      | Restart backend and frontend together; reload the browser. Do not bypass the rules/catalog guard.                                                                                   |
| Default credentials fail                   | Confirm the current launcher completed bootstrap against the intended database and check `OPENMS_DEV_PASSWORD`. Role conflicts are explicit startup failures.                       |
| Missing catalog or WZ file                 | Check the `--assets` directory and complete extraction before launching; the backend expects `client/public/generated/catalog.json`.                                                |
| Compose rejects `--wait`                   | Install/select a Compose provider supporting `up --wait` and `--wait-timeout`; check `podman compose version`.                                                                      |
| `MIGRATIONS_REQUIRED` at backend startup   | Run `bun run migrate --database-url URL` against the backend database, then restart. Both development and production startup only check the schema.                                 |
| Backend cannot connect to PostgreSQL       | Check Compose health and `DATABASE_URL`; no in-memory fallback exists.                                                                                                              |
| A second tab cannot start                  | One game owner per browser storage origin is intentional. Close the owner or use another isolated browser profile.                                                                  |
| Connection loss or server restart          | Transient reconnect has a 30 s grace; commands freeze. Authentication is process-local, so backend restart requires login again.                                                    |
| Slow map loading, delayed NPC pages or walking disconnects | Follow [Slow connections](#slow-connections) to distinguish a transport failure from artwork preparation and retain useful diagnostics. |

Stop/start the database explicitly with `podman compose -f infra/compose.yaml stop` / `start`. Ordinary shutdown does not remove the persistent volume.

#### Slow connections

Map downloads run independently of connection maintenance. A loading screen can remain visible while the socket is healthy. Movement accounts for measured network delay, and ordinary NPC pages include their text in the server response. Page changes still require the server's round trip and processing time. The [protocol](server/protocol.md#slow-connections-and-presentation-recovery) defines separate connection, presentation and recovery limits.

| Observation | Meaning and next step |
| --- | --- |
| `CONNECT_TIMEOUT` | Connection establishment or initial baseline delivery missed its client deadline. Compare browser and server timestamps; artwork preparation uses a separate deadline. |
| `HEARTBEAT_TIMEOUT` | The client stopped receiving valid server traffic. Check backend availability and the WebSocket path through the proxy. |
| `PRESENTATION_FAILED` or an asset-download error | Inspect the failed resource and its HTTP status. Presentation recovery retains the socket and uses a bounded retry budget. |
| `CHARACTER_BUSY` after an interrupted entry | Once `welcome` has supplied a play session, retry from the same page to retain it, including when no baseline was received. If the character-selection screen shows a connection-loss dialog, dismiss it before clicking **Enter the world**. A different live owner still prevents entry. |
| Server log says `code:1000, reason:"resynchronize"` | This generic client-close reason appears in older builds and does not identify the underlying cause. Updated clients send a bounded failure reason; capture the browser message as well when a proxy omits close details. |

For a reproducible failure, retain the UTC timestamps, source/rules/catalog identities, map ID, whether the interruption occurred during loading or movement, browser error, and the server's `socket.attached`, `socket.closing` and `socket.closed` lines when present. Include the failing asset URL/status for loading errors. [Production diagnostics](#production) are available without enabling development mode. The [isolated latency check](validation-method.md#slow-network-gameplay-check) exercises delayed assets, movement, dialogue, travel and reconnect with disposable state.

After installing the latency fixes, restart both the backend and game frontend, reload, and sign in again so their rules identities match. Reuse the existing generated assets; this runtime update does not require extraction or a database reset. Normal transient recovery remains bounded by the reconnect grace, and a backend restart requires a new login.

### Production

Apply database updates with `bun run migrate --database-url URL`, then start these commands in separate terminals from the repository root:

```sh
bun run server:prod
bun run client:prod
```

`client:prod` builds **`client/dist/online/site/`** without the development sidebar or toggle, then keeps serving it. Login, gameplay, native windows and audio remain available; `client:dev` retains the sidebar. The listener uses `.env.client` settings `ONLINE_HOST` and `ONLINE_PORT` (default `http://127.0.0.1:3102`) and proxies `/api/`, including WebSocket connections, to `OPENMS_SERVER_URL`. Generated assets are served automatically from `client/public/generated/`. Stop it with Ctrl+C; restart to rebuild changed sources.

Production character selection places **Refresh** and **Sign out** in separate Windows 95-style buttons along the lower-left edge of the selection book. Development keeps these controls in the inspection sidebar.

For public hosting, terminate HTTPS at a reverse proxy in front of the client listener and preserve the **public Host**, Origin, cookies and WebSocket upgrades. The backend validates its exact configured origin. To build files without starting a listener, run `bun client/tools/build-online.js`; publish the entire `site/` directory, mount `client/public/generated/` at `/generated/`, and follow `site/deployment.json` for API/worker routing.

`server:prod` forces production mode, including when `OPENMS_MODE=development` is inherited. Configure `DATABASE_URL` and the exact `OPENMS_ORIGIN` before starting. Set `OPENMS_STUDIO_ORIGIN` to Studio's exact origin, or an empty value to disable Studio access. Set `OPENMS_RULES_HASH` only to pin a reviewed rules identity; when it is unset the server accepts the extracted rules and reports their hash at startup. Origins stay exact in every mode and HTTP is accepted, since TLS may terminate at the reverse proxy; set `OPENMS_ORIGIN` to the origin the browser actually sends. This command checks migrations, replaces any published default account passwords, and then starts the server.

`server:prod` checks existing `admin` and `player` accounts before accepting connections. If either password still matches `password`, it replaces that password with a separately generated 256-bit random value stored as an Argon2id hash. Generated passwords are discarded and never printed. Missing accounts are not created; custom passwords, roles and characters are retained. The replacements run in one transaction with row locks, and a failure stops startup. `server:dev` still creates these accounts as needed and restores `admin:password` and `player:password` on every launch (or the configured `OPENMS_DEV_PASSWORD`).

**Registration is enabled in production.** Register creates a normal player account with an empty roster and signs it in. Login and registration cookies use `Secure` when `OPENMS_ORIGIN` is HTTPS; an explicitly configured HTTP origin receives cookies usable over HTTP. For HTTPS hosting, keep `OPENMS_ORIGIN` set to the public HTTPS origin even when the reverse proxy connects to the backend over HTTP.

Production logs socket opening, character attachment, server-requested closure (`socket.closing`) and the final WebSocket close code/reason (`socket.closed`). Motion/watchdog faults, failed checkpoints and simulation suspension are also retained with bounded diagnostic fields. Routine request/action logs remain development-only. For a gameplay disconnect, capture these lines from the `server:prod` terminal alongside the browser's disconnect message and Caddy logs; enabling development mode is not required. Logs exclude credential and payload fields.

| Gate             | Required deployment behavior                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| HTTPS/WSS        | Game origin serves its static shell/assets and proxies `/api/` to the backend, including upgrades, Origin and cookies.                                                               |
| Studio           | Separate HTTPS origin routes to `bun run studio:start`; configure exact `OPENMS_STUDIO_ORIGIN` on the backend. See [Studio settings](server/studio.md#build-routing-and-validation). |
| Runtime pin      | Optional: set `OPENMS_RULES_HASH` to the verified 64-character lowercase SHA-256 rules identity to refuse mismatched content.                                                        |
| Configuration    | Required production `DATABASE_URL` and exact public `OPENMS_ORIGIN`; securely provision accounts and persistence.                                                                    |
| Static files     | Publish `client/dist/online/site/` plus the generated content mount; use `deployment.json` for exact resource paths.                                                                 |
| Session security | Secure HttpOnly SameSite cookies, CSRF checks and one-use tickets; development endpoint absent.                                                                                      |
| Recovery         | Explicit migration, backup/recovery and [adversarial/durability proof](server/protocol.md#implementation-order-and-required-proof).                                                  |

Keep `/api/` network-only. Handler coverage and a matching source hash do not certify production readiness or complete original behavior.

### Code {#server-code}

| Path                                                                  | Owner                                                                                          |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `server/src/`                                                         | HTTP/session admission, content, fields, actions and interactions                              |
| `infra/sql/*.sql`                                                     | Durable schema scripts, applied by the migration CLI                                           |
| `tools/migrate.js`                                                    | Explicit database migration entry point                                                        |
| `server/tools/`                                                       | Development bootstrap and lifecycle tooling                                                    |
| `infra/gameplay-definitions/`, `infra/sql/tables/`, `infra/sql/data/` | Local gameplay definitions and reference SQL used during content compilation                   |
| `shared/`                                                             | Closed protocol, validation and motion checkpoints                                             |
| `client/src/online/`                                                  | Transport, prediction and read-only native presentation                                        |
| `content/`                                                            | `@openms/content`: original-asset lookup, private custom definitions, revisions and publishing |
| `studio/`                                                             | `@openms/studio`: asset library, map/mob/quest editors and shared-world release dashboard      |

The runtime is implemented by OpenMS. These are development/reference rules, not a reconstruction of Nexon's server. [Feature coverage](server/offline-parity.md) and the [remaining-work audit](server/remaining-work.md) describe current support.

### Protocol

The [protocol](server/protocol.md) owns session lifetimes, input sequencing, field generations, checkpoints, transactions and recovery. Explicit logout retires the actor immediately and checkpoints it; transient disconnection has a separate grace. Dead logout follows the authored return-map revival policy.

[Review fixes and migration](server/reliability.md) documents stateless login admission, byte-bounded snapshots, checkpoint recovery and retention, global character names, and market retry policy.

### Definitions

The imported Cosmic SQL is retained under `infra/sql/tables/` and `infra/sql/data/` (see [SQL ownership](../infra/sql/README.md)) and [`infra/gameplay-definitions/`](../infra/gameplay-definitions/README.md). These are the defaults; optional `--sql-root` and `--gameplay-definitions-root` flags select other local snapshots. No external checkout, Java files or server configuration is read:

```sh
bun tools/openms.js data server --output /tmp/openms-reference-data
```

The converter reads bounded SQL/schema records and script metadata; it neither starts Cosmic nor supplies its account service. [Reference-data coverage](offline-data.md) records exclusions and [provenance](inputs.md) distinguishes emulator policy from original executable/WZ evidence.

The extraction command builds the generated asset catalog used by the browser client and server. Shop/drop rows select required item visuals, and supported NPC routes select map, portrait, dialogue-art and quest dependencies. Dialogue execution, purchase admission, reward calculation and transactions belong to the server; browser presentation sends choices and displays server responses. Packaging static definitions does not grant the browser permission to execute them.

### Authority

| Browser may…                                     | Server must…                                                          |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| Predict movement and display received state      | Own positions, velocities, field membership and checkpoints           |
| Submit a native action or conversation choice    | Validate identity, requirements, costs, clocks and current generation |
| Display/draft inventory, social and character UI | Commit all affected participants atomically and return receipts       |
| Reconnect using a fresh ticket                   | Restore the current authoritative state from durable server data      |

See [client/server integration](reconstruction-contract.md), [feature coverage](server/offline-parity.md) and [validation boundaries](validation-method.md#evidence-boundaries).

## Client

The browser client uses JavaScript, JSDoc, Bun and PixiJS. All gameplay uses the authoritative server. Use a desktop viewport of **800 × 600 or larger**.

Start the [server](#server-run) first. In a **second terminal**, from the repository root:

```sh
bun run client:dev
```

Wait for **`online client ready`**, then open **http://127.0.0.1:3102**.

The frontend builds its browser code, serves generated assets, and proxies same-origin `/api/` HTTP and WebSocket requests to port 3200. Backend startup and frontend startup reuse the [extracted assets](index.md). The browser does not connect to PostgreSQL.

A 27px Windows 95 project bar appears above the game in both development and production. Its left edge shows the live server round-trip time behind a green, orange or red quality dot. Players online shows connected characters across all maps, including before login; it refreshes every 10 seconds and shows a dash when the count is unavailable. Disconnected characters retained for reconnect are excluded. X and GitHub open `x.com/tensorfish` and the repository in separate tabs; Docs opens `docs.openms.dev`. Bug Report opens an email to `tensorfish@proton.me`; About opens a Windows 95 dialog with a short game summary and an as-is, use-at-your-own-risk disclaimer, closed by its OK button, its close box or Escape.

#### Login

| Account  | Password   | Role                                    |
| -------- | ---------- | --------------------------------------- |
| `admin`  | `password` | Developer; inspection mutations allowed |
| `player` | `password` | Normal player                           |

Select the starter character to enter the game. **Register** creates a normal account with an empty roster; create a character afterward. `OPENMS_DEV_PASSWORD` in the server service configuration overrides both bootstrap passwords, and each `server:dev` launch restores them. Existing characters are retained. Legacy development accounts are renamed in place when the new name is absent; role conflicts fail explicitly.

Character creation follows **name → appearance → starting stats**. The server issues each dice result and validates the selected roll on creation. [Login](login-creation-recovery.md) records the exact original assets and placements.

One game tab may own a browser storage origin at a time. Use separate browser profiles or isolated contexts for two-player checks. [Sessions](browser-session.md) explains the boundary. The client does not continue gameplay while disconnected.

### Startup asset cache

The startup download screen prepares common game files before exposing sign-in and character selection. The working set includes login/HUD and common windows, speech bubbles, NPC dialogue controls and quest markers, starter character appearances, common effects and sounds, and the catalog's default map plus Henesys and Lith Harbor. These maps include their region files, atlases, minimaps and music. After login artwork is ready, background caching queues Victoria Island; entering a field prioritizes that field's region. Custom content and uncommon appearances remain on demand. See [regional downloads and their Windows 95 controls](asset-delivery.md#regional-background-downloads).

A cold startup downloads **one compressed, content-addressed pack** containing the catalog, loading decoration and common working set. The browser verifies the pack and every member, then stores the members under their existing per-file cache keys. With the retained catalog this is 398 files / 83,802,352 unpacked bytes delivered as one 32,184,378-byte transfer (30.7 MiB). The pack itself is not also stored in CacheStorage. Only encoded asset bytes are retained; preloading does not decode or reserve every texture on the GPU. There is no game WebSocket or character lease during preparation.

The build creates the pack from existing extracted files; no WZ conversion or full-world scan runs. The common preload remains bounded to 768 files / 64 MiB. The pack has separate 770-member / 128 MiB compressed and unpacked bounds to include the catalog. Its member index ships in the compiled browser, so planning needs no extra asset request. See the [pack format and deployment contract](asset-delivery.md#startup-pack).

The disk cache retains up to 4 GiB / 32,768 files, adapting to browser quota with a 192 MiB fallback when quota estimates are unavailable. This lets later map visits keep more downloaded files without enlarging decoded CPU/GPU limits. The ceiling counts stored bytes, and extraction publishes compressed `.json.gz` siblings for JSON, so the same budget retains far more of the world than raw encoded sizes alone would allow. Existing cached files survive the upgrade. The client requests browser persistence without holding up startup; browser approval is optional. See the [cache policy and diagnostics](streaming.md#persistent-asset-cache).

Refresh fetches the server configuration and compares its current catalog hash with the saved catalog's actual SHA-256. Matching bytes are reused, including the loading decoration and common assets. A fully retained startup downloads no pack or member files. Up to four missing indexed members use ordinary individual downloads; larger gaps fetch the pack once. A stale or corrupt cached catalog still gets its hash-verified replacement. Index metadata chooses the transfer strategy; actual cached bytes are verified when consumed. The screen says “Checking saved game files…” while reading/verifying saved bytes and “Downloading game files…” during actual transfers. Files still need parsing and textures still need decoding after a page refresh.

An unavailable writer or an effective cache budget below the catalog size plus the 64 MiB preload ceiling stops speculative preloading and leaves ordinary asset loading available. Quota failures first attempt bounded eviction and one retry. Corrupt or failed immutable assets keep the startup error visible instead of exposing a partially prepared login page. In development, `streaming.startupPack` reports `downloaded`, `retained`, `individual`, or a storage fallback. `window.maple.snapshot().startupPreload` reports completion, `cache-unavailable` or `insufficient-cache`; `streaming.cacheStatus` and `cachePersistence` report storage usability and browser persistence separately. See the [500 ms startup check](validation-method.md#slow-network-gameplay-check).

### Settings {#client-settings}

Configure `.env.client`:

| Setting                      | Default                 | Meaning                  |
| ---------------------------- | ----------------------- | ------------------------ |
| `ONLINE_HOST`, `ONLINE_PORT` | `127.0.0.1`, `3102`     | Browser client listener  |
| `OPENMS_SERVER_URL`          | `http://127.0.0.1:3200` | Reachable backend origin |

Both `client:dev` and `client:prod` use this one listener configuration. The unused `HOST` and `PORT` entries have been removed and are no longer read.

### Controls

Click empty map space to focus the game. KeyConfig can change these recovered defaults.

| Action                      | Default input                        |
| --------------------------- | ------------------------------------ |
| Move / climb / portal       | Arrow keys; Up at a supported portal |
| Jump / drop through         | Alt / Down + Alt                     |
| Attack / pick up            | Control / Z                          |
| Item / Equip / Stat / Skill | I / E / S / K                        |
| MiniMap / Quest / Set Key   | M / Q / Backslash                    |
| Chat / close top window     | Enter / Escape                       |

The [UI guide](ingame-ui.md) covers focus, original windows, tooltips and modal rules. The [inspection guide](inspection-tools.md) covers World, Character, Diagnostics, Agent and Settings; online mutations require server authorization. Agent control is opt-in. Audio unlocks after a trusted pointer or key input; saved mute/volume preferences are retained.

### Code {#client-code}

| Code                                                                                            | Responsibility                                                   | Contract                                       |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------- |
| `client/src/browser/online/main.js`, `client/src/online/`                                       | Entry point, transport, prediction, native UI and received state | [Protocol](server/protocol.md)                 |
| `client/src/physics/`, `shared/motion.js`                                                       | Shared 30 ms movement and checkpoints                            | [Movement parity](movement-parity.md)          |
| `client/src/ui/`, `input/`, `rendering/`, `audio/`                                              | Original interface, input, scene and audio                       | [UI](ingame-ui.md) · [Streaming](streaming.md) |
| `client/src/character/`, `combat/`, `skills/`, `items/`, `quests/`, `npc/`, `world/`, `social/` | Presentation and rule modules shared with server authority       | [Feature inventory](server/offline-parity.md)  |
| `client/src/profile/`                                                                           | Character schema validation and server snapshot projections      | [Protocol](server/protocol.md)                 |
| `client/src/assets/`, `client/tools/`                                                           | Bounded decoding, extraction, development and validation tools   | [Asset evidence](asset-evidence.md)            |
| `server/src/`, `infra/sql/`, `shared/`                                                          | Online authority, persistence and closed protocol                | [Server](#server)                              |

`client/public/generated/` and `client/dist/` are generated and ignored. Character progress is stored by the server.

### Coverage

Use [feature coverage](server/offline-parity.md) for authority and gaps, and [validation results](validation.md) for scoped proof. Recovered motion uses the original **30 ms** quantum; 100% walking uses **125 px/s**, with the original jump coefficient **555 px/s** before gravity integration.

Choose checks from the [validation method](validation-method.md), rather than running every browser scenario for each edit.

## Studio

Studio edits custom maps, mobs and quests using the shared asset catalog. Complete [Setup](index.md) and start the [Server](#server) first.

### Run {#studio-run}

In an optional **third terminal**:

```sh
bun run studio:dev
```

Open **http://127.0.0.1:3103** and sign in with the same accounts. Studio uses `.env.studio` and a separate listener. It needs the backend, database and generated content; the game client can be stopped while authoring.

Custom maps, mobs, quests and uploaded PNGs are saved in PostgreSQL. To make published creations playable, an `admin` user activates a selection in **Shared world** while the world is idle. The original generated assets remain the shared base. See the [Studio guide](server/studio.md) for authoring and activation.

### Settings {#studio-settings}

Configure `.env.studio`:

| Setting                      | Default                   | Meaning                                 |
| ---------------------------- | ------------------------- | --------------------------------------- |
| `STUDIO_HOST`, `STUDIO_PORT` | `127.0.0.1`, `3103`       | Dedicated Studio listener               |
| `OPENMS_SERVER_URL`          | `http://127.0.0.1:3200`   | Studio's backend API origin             |
| `OPENMS_CLIENT_URL`          | `http://127.0.0.1:3102`   | Public game link in Studio              |
| `OPENMS_CONTENT_ROOT`        | `client/public/generated` | Same original extraction as the backend |

See [Studio](server/studio.md) for authoring and world activation, and [Content](server/content.md) for revisions, publishing and asset pins.

## System

```mermaid
flowchart TD
  WZ[Original v83 WZ archives] --> Extract[Extraction]
  Definitions[Gameplay definitions and reference SQL] --> Extract
  Extract --> Generated[client/public/generated]
  Generated --> Server[Bun server: 3200]
  Generated --> Client[Game frontend: 3102]
  Generated --> Studio[Studio: 3103]
  SQL[Numbered SQL files in infra/sql] --> Migrate[migrate CLI]
  Migrate -->|Schema and migrations table| DB[(PostgreSQL: 55432)]
  Server -->|Durable state| DB
  DB -->|Accounts, progress and custom content| Server
  Browser[Game browser] --> Client
  Client -->|HTTP and WebSocket API| Server
  Studio -->|HTTP authoring API| Server
```

| Location                                                              | What it owns                                                                                                               |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `infra/gameplay-definitions/`, `infra/sql/tables/`, `infra/sql/data/` | Repository-owned inputs for content compilation                                                                            |
| `client/public/generated/`                                            | Generated original catalog, visuals and compiled gameplay definitions read by the services                                 |
| `infra/sql/*.sql`                                                     | PostgreSQL schema scripts applied explicitly by `migrate`                                                                  |
| PostgreSQL `migrations` table                                         | Applied script versions, filenames, checksums and timestamps                                                               |
| PostgreSQL                                                            | Accounts, character progress, transactions, Studio revisions/uploads and world releases; also the registered asset catalog |

Original artwork stays in generated files. The server reads gameplay definitions from that generated package, combines them with the active custom world release from PostgreSQL, and controls online dialogue, movement, rewards and transactions. The client sends inputs and choices, renders the server's responses, and fetches original visuals from the frontend. [Reference data](#definitions) explains why the current extraction packages both visuals and gameplay data.

## Connection recovery

Recoverable socket loss retains the selected character and pending operation IDs,
waits while the page is hidden, and automatically reuses authenticated entry when
execution resumes. Recovery allows three attempts within a 180 s window starting
when foreground recovery begins; ten seconds of sustained movement input resets the
incident budget. Expired
authentication or exhausted recovery returns to sign-in with an explicit reason.

After a fresh play session, a complete authoritative baseline releases old portal
travel reservations and archives their unknown receipts within a bounded collection.
It neither replays the portal script nor infers whether it committed. Durable
transaction recovery keeps its existing envelopes and retry policy.

For an unexpected return to sign-in, retain the bounded `lastFailure` record from
Diagnostics → Connection → Technical observation. It survives connection reset and
includes the failure code, map, transition phase and receiving stage without
credentials. The development proxy forwards WebSocket close codes and bounded
reasons; its logs retain only recognized reason codes.
