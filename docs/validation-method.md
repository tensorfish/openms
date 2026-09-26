# Browser validation method

## Validation scope

Validation is proportional to the change. Use the smallest check that covers the changed contract, then stop.

- **Documentation/comments only:** review edited instructions and run the documentation link check. No browser, extraction or gameplay run is required.
- **Compose/environment/setup configuration:** use the relevant parser or configuration check. Do not start databases, migrate data or exercise gameplay unless startup behavior itself changed.
- **Application logic:** run the affected existing test or a narrow reproduction.
- **UI behavior/appearance:** check the changed interaction or surface only.
- **Asset/extraction logic:** check the affected decoder or recipe. Reuse existing generated assets for unrelated edits.

Comprehensive end-to-end runs, full extraction and concurrency benchmarks require an explicitly requested validation, release or performance scope. Documentation/configuration work needs no new screenshots, timing report or `validation.md` entry.

## Artifact policy

Generated validation JSON reports and their raw runtime/test logs must never be committed, whether under `docs/validation/` or elsewhere in the repository. Write them outside the checkout with an explicit output path, such as `--output /tmp/openms-network-latency`, or use ignored `artifacts/` storage. Retaining evidence means retaining it locally; do not copy it into `docs/`, force-add it, or link published documentation to an untracked report.

Commit concise Markdown findings when the validation scope calls for them: the reproduction command, workload, source/rules/catalog identities, measured result and limitations. Original input manifests, test fixtures and source/reference evidence remain governed by their own contracts; they are not generated validation-run reports.

## Shorten the loop

- Prove one complete vertical slice first: native input → transaction → recipient update → reconnect.
- Work in small file-disjoint batches with fixed interfaces and run cheap validation after each batch stabilizes.
- Reuse generated assets, running authority and isolated browser contexts when their source, rules and catalog identities match.
- Build a domain-scoped tool when repeated manual work is the bottleneck.

### Immediate online iteration sequence

1. Name the intent, server admission, committed result, recipient publication and reconnect-restored state.
2. Run Prettier `--check` and ESLint on the edited JavaScript files, followed by affected tests.
3. Check the online import graph with a nonpublishing Bun build using `onlineBuildGraph` from `client/tools/online-build-graph.js`. The guard rejects browser imports of server-side authority modules.
4. Restart only stale owners. Browser-only changes do not require asset extraction.
5. Run the affected online scenario with a disposable account/database and isolated browser context. Capture images only for appearance or failure context.
6. Retain one bounded local report with source/rules/catalog identities, following the [artifact policy](#artifact-policy), and stop.

### Current invalidation and reuse constraints

| Change                               | Required owner refresh                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Browser JavaScript                   | Rebuild/restart the frontend; restart the backend when its conservative rules identity includes the changed module |
| Server JavaScript or shared protocol | Restart backend and frontend so protocol/rules identities agree                                                    |
| CSS or HTML shell                    | Rebuild/restart frontend only                                                                                      |
| Original inputs or extraction recipe | Run affected extraction/preflight checks, then restart owners using the new catalog                                |

Do not delete the extraction cache or rebuild assets merely because browser code changed. A matching generated catalog remains reusable across sessions.

## Run the current client

Start the authoritative server and client in separate terminals:

```sh
bun run server:dev
bun run client:dev
```

Open `http://127.0.0.1:3102`. The client development server builds the online entry, serves generated assets and proxies `/api/` HTTP and WebSocket traffic to the backend.

For a production bundle:

```sh
bun client/tools/build-online.js
```

The build verifies the current catalog/rules identities, compiles the guarded browser graph and writes the deployable shell, bundles and deployment metadata to `client/dist/online/site/`. Its HTML excludes the development sidebar and its startup skips inspection controls; `client:dev` retains both. It does not regenerate assets.

`bun run client:prod` performs the same build and then serves the production site, generated assets and API proxy using `.env.client` listener settings.

## Online browser scenarios

Domain checks under `server/tools/check-*.js` own disposable databases, server/client listeners, accounts and browser contexts. Scenario modules under `client/tools/scenarios/online-*.js` operate through native controls and received state. Reuse an existing browser when practical, but never share a mutable game session between checks.

For production client presentation checks, pass `productionClient: true` to `isolatedOnlineCheck`. This compiles and serves the production shell through the fixture's local HTTP/API proxy, including real WebSocket connections. Its disposable backend still uses development authentication; this verifies browser behavior, not public HTTPS deployment.

`bun server/tools/check-login-pages.js --scope utilities --output /tmp/openms-login-utilities` checks production character-selection Refresh and Sign out at 800×600 and 1280×800. It verifies visible, separate button targets, refresh by mouse and sign-out by keyboard, using a disposable account without entering gameplay. Production scenarios pass `{ development: false }` as the third argument to `onlineIdentity` so the expected source identity matches the production bundle.

Every browser report should identify the served source, rules and asset catalog. A stale source or mismatched catalog is a failed check. Use fresh module processes after editing scenario code so an older imported module cannot be mistaken for current evidence.

### Slow-network gameplay check

`bun server/tools/check-network-latency.js --output /tmp/openms-network-latency` runs one isolated native-input scenario with 500 ms HTTP delay and 250 ms in each WebSocket direction. It disables persistent caching in its isolated browser so the normal startup preload cannot mask cold-asset deadlines. It holds initial and destination map manifests for 20 seconds, reconnects during initial loading, walks through a 1.5-second traffic stall, advances Regular Cab dialogue, commits its fare and verifies that fare after reconnect. The report records identities, stage timings, received movement and whether dialogue required another HTTP request. Existing generated assets are reused; no extraction or personal account mutation is involved. This fixed workload establishes recovery behavior, not a general WAN or frame-rate benchmark.

Use `bun server/tools/check-network-latency.js --scope startup --output /tmp/openms-startup` for startup preloading changes. This scope keeps persistent caching enabled and measures cold startup, login, entry, native walking through a 1.5-second stall, reconnect and a retained-cache reload at the same latency. It records asset request counts, cache bytes/hits, decoded/GPU residency and source identities, and checks that the preload completes before a game connection exists. Cold startup must make exactly one `/generated/` request with a completed startup pack. The retained-cache reload must make zero `/generated/` requests and report zero downloaded asset bytes, including the root catalog.

Use `bun server/tools/check-skill-effects.js --output /tmp/openms-local-feedback` for local chat/skill feedback and the loading indicator. It uses a disposable account at 500 ms RTT, holds chat replies for 1.5 s and cast replies for 3 s, and verifies local pending text, early artwork/audio and exact echo reconciliation. It also captures the download button at 1280×800 and 800×600, checks its Win95 details dialog and Pause control, verifies the local speech bubble before delivery, and walks through repeated Up taps into a portal with one delayed destination manifest. The portal must play its original sound and expose mushroom progress/details. The scenario waits for the chat settings debounce before its cast so an unrelated settings write does not change cast admission.

Use `bun server/tools/check-network-latency.js --scope cache --output /tmp/openms-cache` for cache capacity/index changes. It serves the current network module to isolated Chrome, seeds 2,048 synthetic 1 KiB payloads in real CacheStorage, measures migration and warm opening, then checks 4,096-file retention, interrupted-write recovery, corruption rejection and verified reads when IndexedDB is unavailable. It records the served module hash, header-read counts, effective limits and build/browser/seed/action/teardown timings. This scope requires no gameplay database, extracted assets or artificial network delay; it does not establish a full 1 GiB fill or gameplay performance. Run comparable before/after probes sequentially. All scopes keep raw outputs outside the repository.

For two-player behavior, give each participant a separate browser context and account. Verify the sender receipt, other recipient's visible state and reconnect-restored result. The server fixture owns cleanup; do not run mutation scenarios against personal accounts.

Movement presentation can be measured with:

```sh
bun tools/openms.js smoothness --account admin --password password
```

The tool samples the presented player and authoritative prediction state while real keyboard input is held. It reports stalls and jerk within frames where the authoritative kernel moved; it does not step the simulation itself or establish original-Windows parity.

### Combat latency check

For local walking and correction regressions, use `bun server/tools/check-skill-motion.js --scope walk --round-trip-ms 2000 --output /tmp/openms-walk-2000`. The isolated character walks right, left, then right through a 1.5-second traffic stall on a safe original town floor. The sampler measures the **rendered player**, checking backward steps, pauses, prediction availability and final settlement onto trusted state. Repeat with `--round-trip-ms 0` or `1000` for the corresponding connection; run comparisons sequentially. `--baseline` records a failing implementation without enforcing the repair assertions. The fixture records source/catalog identities and setup/readiness/action/teardown timings; it reuses extracted assets. This establishes the fixed walking workload, not every map, skill, connection or frame-rate percentile.

Use `--scope landing` with the same tool and latency flags for six native jumps, including moving jumps and a 1.5-second airborne traffic stall. It measures the rendered feet against the flat town floor after the normal landing interpolation quantum, requires actual airborne frames, and checks prediction availability and final settlement. `bun test client/test/grounded-presentation.test.js` separately covers connected slopes, unsupported edges, landing interpolation and disposable hit recoil. These contact checks complement the steady walking check; they do not establish every movement skill or map.

`bun server/tools/check-combat-latency.js --output /tmp/openms-combat-latency` runs native basic attack, Power Strike and Magic Bolt input in isolated fighter/mage contexts at 500 ms RTT, with 1.2-second traffic pauses. It measures first local pose/flight, checks one animation run across confirmation, requires the original action's confirmation, and samples mobs through a separate 450 ms pause. `--baseline` records the older behavior without repaired-behavior assertions. Frame reports and logs stay outside the repository. AI choices are not seeded across runs, so aggregate moving/idle counts are diagnostics, not a matched AI benchmark.

`bun server/tools/check-combat-latency.js --scope hits --output /tmp/openms-hit-feedback` isolates outgoing impact and incoming contact feedback. It logs in a disposable developer fighter, spawns a Stump through the native console, attacks with Control and walks into its drawn body. With 500 ms RTT and separately held replies, it records first local hit pose/contact timestamps and bounded frame samples. This checks presentation before confirmation; deterministic tests separately cover critical eligibility, shared protection timing, recoil confirmation/refusal and multi-line echo ownership.

`bun test client/test/combat-latency.test.js server/test/attack-input.test.js server/test/field-combat.test.js` checks bounded motion/correction, local clocks and echo ownership, projectile refusal/teardown, expired movement with a retained attack edge, and immediate server action identity. Reuse extracted assets; this check does not require extraction.

### Remote player and drop check

`bun server/tools/check-remote-motion.js --output /tmp/openms-remote-motion` uses two isolated native browser contexts on map 50000 at 500ms RTT. One player walks and jumps while the observer samples rendered movement through a 450ms traffic pause. A native development drop command then creates an item; the observer samples its flight/hover through a 1.2-second pause. The check requires continued drop motion between publications, no projection below the fixture's landing floor, bounded peer frame displacement, ready connections and matching source identity. `--baseline` records the same workload without repaired-behavior assertions. Raw reports and at most 600 frame samples per stage stay outside the repository.

`bun test client/test/remote-presentation.test.js server/test/remote-presentation.test.js client/test/drop-rotation.test.js` covers original drop equations, late-packet age, fade, peer slopes/jump landing/ladder/buoyant modes, teleport handling, monotonic attack phase and the compact wire hint. This scope reuses extraction. It does not exercise pickup admission, reconnect persistence, all special movement skills or original Windows visual parity.

### Timing the feedback loop

When timing is in scope, separate source/rules/catalog checks, browser acquisition, readiness, actions and teardown. Parent and child timings overlap, so do not sum hierarchical durations. Compare serial and concurrent runs only with identical scenarios and identities, and do not run competing performance probes simultaneously.

## Evidence boundaries

These checks validate browser behavior and project interchange. They do not establish original-client parity. Ghidra output is retained binary evidence, not supplied C/C++ source. The original client cannot run on this Mac; original runtime parity requires a supplied Windows capture.

- **Recovered:** an original archive field or executable/DLL consumer establishes it.
- **Browser-exercised:** actual input/output exercised the reconstructed surface.
- **Interchange-matched:** independent state/resource checks match the packaged contract.
- **Original-reference-matched:** a supplied original runtime capture was compared.
- **Unknown/unsupported:** evidence or server state is missing; no substitute behavior fills it.

## Delegated in-game acceptance

Use separate isolated browser contexts and nonoverlapping artifact directories. Each run records `sourceBuildId`, rules identity and extracted catalog identity. Restart after source edits and preserve earlier failures under their original identities.

Native input must operate the actual client controls. Read-only inspection may collect state and diagnostics; it must not manufacture a successful gameplay outcome. Server development endpoints may seed an explicitly labeled fixture, but the tested action and receipt must still use the normal gameplay path.

## Audio proof

Audio validation requires the real audio graph and output capture. Mute unrelated BGM when isolating a cue, retain exact source identity, and distinguish scheduled source start from nonzero mixed PCM. Autoplay denial is a failed readiness condition for a requested audio check.

## Performance reporting

Profile before optimizing. Retain the exact workload, source/rules/catalog identities, browser ownership and per-stage timing. Compare like with like and report measured wall time rather than inferred savings. Routine edits do not update [validation results](validation.md); requested performance or release work does.
