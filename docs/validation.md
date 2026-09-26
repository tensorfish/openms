# Validation results and known limits

Read a result together with its **source/catalog identity, fixture, action and limitation**. A passing unit test, an implemented handler and a native browser replay establish different things. [Validation method](validation-method.md) owns the procedure; old run narratives are in the [archive](archive/index.md).

## Current evidence index

| Area                                   | Evidence                                                                                                             | Scope                                                                                                  |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Online 100% movement                   | [Movement parity](movement-parity.md#scoped-verification)                                                            | Shared-kernel/server steps, browser prediction and checkpoint continuation.                             |
| Slow-network gameplay                 | [Latency repair](#slow-network-gameplay-repair) | 500 ms RTT, delayed map assets, native walking/dialogue/travel and reconnect. |
| Optimistic client and queued actions | [Queue and authority checks](#optimistic-client-and-queued-actions) | Immediate combat, two queued casts and inventory moves at 500 ms RTT, authoritative settlement and reconnect. |
| Local walking at high latency | [Correction regression repair](#movement-correction-regression-at-high-latency) | Rendered self movement at 0/1,000/2,000 ms RTT, a 1.5-second traffic stall and final reconciliation. |
| Ground contact during correction | [Floating regression repair](#ground-contact-during-correction) | Native jumps and landings at 2,000 ms RTT; deterministic slope, ledge and recoil contact checks. |
| Watchdog false kicks and stuck leases | [Contact and retirement repair](#watchdog-contact-and-retirement-repair) | Real map 10000 physics across a delivery gap; kicked-character cleanup. |
| Startup asset preload                 | [Startup cache](#startup-asset-preload) | Cold/warm startup, map entry, cache residency and walking at 500 ms RTT. |
| Browser cache capacity                | [Cache capacity and index](#browser-cache-capacity-and-index) | Quota-aware disk limits, retained metadata, interruption recovery and startup regression. |
| Refresh without asset downloads       | [Catalog reuse](#catalog-reuse-on-refresh) | Fresh server hash, local catalog verification and zero retained-cache asset requests. |
| Single startup download | [Startup pack](#single-startup-download) | One generated-file request, cold/warm timing and gameplay at 500 ms RTT. |
| Immediate local feedback and lag tolerance | [Local feedback](#local-feedback-and-watchdog-lag-tolerance) | Pending chat, skill Use artwork/audio before delayed replies, echo suppression and Win95 loading indicator. |
| Portal feedback and regional caching | [Portal and downloads check](#portal-feedback-and-regional-caching) | Pending-portal movement, local speech bubble, portal audio, map progress and pausable region downloads at 500 ms RTT. |
| Client-owned motion and knockback      | [Movement parity](movement-parity.md#client-owned-motion) · [Browser check](#client-owned-motion-browser-check)      | One native browser hold and the real server/predictor divert tests; not original Windows parity.        |
| Airborne skill continuity and recoil   | [Skill cast repair](#skill-cast-stutter-repair) · [Movement contract](movement-parity.md#skill-snapshot-continuity) | Same-field snapshot continuity, immediate impulses and recovered foothold-tangent mob recoil. |
| Consecutive Flash Jump artwork         | [Replay validation](#consecutive-flash-jump-artwork-14-september-2026) | Five admitted casts, including a rapid direction reversal, with zero rendered-origin offset. |
| Meso Explosion placement              | [Recovery](meso-explosion-animation.md) · [Browser report](native-ui-validation/meso-explosion/report.json) | Six fixed pile effects across opposite-facing casts, original canvas offsets, persisted consumption. |
| Modern combat equations               | [Formula contract](combat-formulas.md) · [Validation](#modern-combat-formulas-14-september-2026) | Shared client/server calculations and explicit mappings for existing v83 content. |
| Drops, presets and chat                | [Two-player report](native-ui-validation/drop-chat-presets/report.json) · [Recovery](original-resource-audit.md)     | Source-identified native recipients/reconnects; no all-content claim.                                  |
| Skill admission (every preset job)     | [Report](ingame-validation/skill-admission.json) · [Tool](../server/tools/check-skill-admission.js)                  | 71 preset jobs / 2,879 skill-job pairs from packaged content; no browser or native-cast proof.          |
| NPC, Ability and development tools     | [Native report](native-ui-validation/ui-authority-repairs/report.json) · [Recovery](native-ui-authority-recovery.md) | Repaired native UI and authority paths on its recorded build.                                          |
| NPC dialogue and shared ambient speech | [Native report](native-ui-validation/online-npc-dialogue/report.json)                                                | Session dialogue, cancel/quest behavior and shared NPC presentation.                                   |
| Login, creation, spotlight and dice    | [Recovery and evidence](login-creation-recovery.md)                                                                  | Original placements and server-issued starting stats.                                                  |
| Selection and travel                   | [Focused report and method](login-selection-travel.md)                                                               | Retained native selection/transition checks.                                                           |
| Original asset inventory               | [Resource audit](original-resource-audit.md)                                                                         | All 16 resource archives inventoried; counts are not runtime completeness.                             |
| Extraction performance                 | [Measured comparison](#extraction-performance) · [Report](extraction-performance.json)                                | Same 735-map all-hit workload, complete output verification and identical catalog bytes.              |
| Online surface declarations            | [Feature inventory](server/offline-parity.md)                                                                        | 72 action kinds, 45 social actions, 69 online hooks; static coverage only.                             |
| Documentation                          | [Maintenance and checks](documentation-guide.md)                                                                     | Source links/routes, current constants, readable navigation and rendered diagrams.                     |

Reports above retain the build they actually measured. A later source edit does not retroactively refresh their results.

## Optimistic client and queued actions

On **2026-09-24**, `bun server/tools/check-combat-latency.js --scope combat --output /tmp/openms-optimistic-accepted` passed using isolated fighter/mage accounts and retained extracted assets. With **500 ms simulated RTT** and **1.2–1.5 second traffic holds**, native basic-attack, warrior-skill and mage-skill input produced local feedback in **25.1, 8.3 and 16.4 ms**, respectively. Each action confirmed without restarting its local animation; the mage projectile preview also matched its authoritative echo. These are three observed samples, not a p95 or general WAN performance claim.

Two native casts started before confirmation and reserved MP from **996 to 988**; authoritative publication and reconnect both restored **988**. Two native whole-stack moves previewed slots **1 → 2 → 3** while the confirmed inventory still held slot 1, then settled at slot 3 with the same item UID and quantity **10**, including after reconnect. This checks the private owner update and recovery, not a second player's view or trade/pickup contention. No browser errors were recorded. Remote monsters continued moving during the separate 450 ms observation hold, within the renderer's elapsed-time movement budget.

Focused checks passed **122 tests / 977 assertions across 14 files**, including forged damage/position reports, ordinary checkpoint replay, silent impulse reconstruction, socket backpressure, immutable retries, queued cast release ordering, unknown receipts, resource reservations, last-ammunition presentation and rejected inventory dependencies. The guarded online build covered **975 modules**; scoped formatting, lint and whitespace checks passed. Documentation checking retained **881 pre-existing failures**, with no added failures. The browser acceptance check now compares monster displacement with actual frame time; its former fixed 20-pixel threshold could reject a legal 20.04-pixel step at a 16.7 ms frame interval.

Measured fixture stages: database/content **328 ms**, seed **176 ms**, backend startup **1,222 ms**, frontend startup **1,985 ms**, browser acquisition **503 ms**, fixture teardown **131 ms**. Scenario stages: identity **1,451 ms**, fighter login/readiness **19,921 ms**, basic attack **2,532 ms**, warrior skill **2,531 ms**, queued casts **6,571 ms**, monsters **1,019 ms**, mage login/readiness **19,993 ms**, mage skill **2,535 ms**, context teardown **85 ms**. These stages include deliberate delays; no extraction or concurrency comparison ran.

The measured tree used source fingerprint `9133fec28f3ab8828b5b49077887d1d97b83947fc358e1adcb701e0099ef08a8`, source build `d697f1be58d11292b531ce5218212b4773048f0e397cac5b32e8b8c4cee30af4`, rules `ca2ce943f6a264a98f63f3b06c6ef20f8e5fdc33a76f0ced550568f8d16a8ea0`, catalog `bf4d12c856304ed77c55a1296dcd7bf82d11f2bea505e111c517ae1b1e482af4`, and asset build `11be20f84c507b5d85eba2fbdbd91f06c6b591922b11bad32ad0d02d3a16a939`. Raw reports, traces and logs remain outside the repository.

See the [implemented scope and research](optimistic-client.md#implemented-subset). Server motion and damage remain authoritative; prediction and action queues are bounded. Long upstream stalls can still cause corrections or expired actions, same-domain command throughput remains receipt-bound, and historical movement/world rollback is not implemented. Restart the client and server together to use the matching rules identity. This scoped acceptance run does not establish every skill, gameplay domain, outage duration or production security property.

## Movement correction regression at high latency

On **2026-09-24**, a reported snapping/stuttering regression in `16c7de1` prompted a separate local-walking investigation. The queue acceptance above measured combat feedback and remote monsters; it did **not** establish smooth continuous movement of the local player. The new bounded town-floor scenario uses real right/left input, then a right hold through a **1.5-second bidirectional traffic stall**. It samples the rendered character, not only its kernel coordinates, and excludes the first 400 ms of each direction change from the steady measurement.

Reproduce with `bun server/tools/check-skill-motion.js --scope walk --round-trip-ms 2000 --output /tmp/openms-walk-2000`; use `0` and `1000` for the other connections. `--baseline` records without repair assertions. All runs used isolated characters, original Henesys geometry and retained extracted assets, sequentially. No extraction or concurrency comparison ran.

| Simulated RTT | Before: backward frames during stalled hold | Before: largest backstep | After: backward frames during stalled hold | After: largest backstep |
| --- | --- | --- | --- | --- |
| 0 ms | 32 | 4.467 px | 4 | 0.267 px |
| 1,000 ms | 37 | 3.265 px | 0 | 0 px |
| 2,000 ms | Not measured | Not measured | 0 | 0 px |

A backward frame here means more than 0.1 px opposite the held direction. Both uninterrupted holds had zero backward frames at every measured latency. The repaired 1,000/2,000 ms runs also had zero paused frames during the stalled hold; at 0 ms, two single-frame pauses remained, neither exceeding **16.7 ms**. Final 0/2,000 ms assertions confirmed uninterrupted prediction availability, zero history overflow and **zero rendered-to-kernel error after recovery**. These are fixed workload samples, not population percentiles or guarantees for every map, skill or outage length.

The failures were specific: correction offsets were measured against the full kernel position and then added to an already interpolated pose (a **1.875 px** deterministic snap); errors below 3 px snapped instead of easing; the correction curve could move backward faster than normal walking; and a **2 ms RTT change** cleared the field-clock filter, allowing an old packet to reset its origin (**1,470 ms** in the isolating test). The repair preserves the current interpolated pose, eases small offsets, accounts for smoothstep's peak speed and retains field-clock samples across small RTT adjustments. Clock fitting now allows 3 seconds so a 2-second link plus scheduling overhead is accepted. Server simulation, admission windows and authoritative movement/damage remain unchanged. An intermediate repair still produced a 3.113 px stalled backstep; the final scenario asserts the stalled hold as well as steady walking. Early probe setup timeouts yielded no gameplay measurements.

Focused validation passed **45 tests / 513 assertions across five files**, scoped formatting/lint and the **975-module** guarded online build. The final 2,000 ms fixture measured database/content **300 ms**, seed **96 ms**, server startup **1,146 ms**, frontend startup **1,870 ms**, browser acquisition **473 ms**, and fixture teardown **150 ms**. Scenario stages were identity **4,399 ms**, login/readiness **37,355 ms**, latency settling **2,501 ms**, walking/recovery **16,832 ms**, and context teardown **25 ms**. Stages include deliberate delay and overlap with fixture ownership; they are not summed.

Baseline 0/1,000 ms source build: `07e0dffb9c4d95a06be56a10074c6a4e7e8399c5f033cdb1c0b1318079eca8dd`, rules `d808eb2eaf651a909868b83d557d3fe0e6689a8e710c154bf694705b2779eb80`. Repaired 1,000 ms source build: `e4b2d4a732f5c2300d66caf3175985115041a8e62cab19281f3732bdf1df64ae`, rules `d00163c4a6ac507787ebf0bb66f8f6ec44a52ccb5723c96a1a2f9d4ccb6802b6`. Final 0/2,000 ms source build: `cb20c8dd13d27ede8fe1b469243e9354edfc88cc47f6ffb2fdd6dbb6cc035e34`, rules `20de2c082856d7899ba8b0cd04b3839179761ccbf4232ad429c10743583377e4`. The final change between repaired runs was formatting, a no-simulation presentation guard and stronger recovery assertions. Every run retained catalog `bf4d12c856304ed77c55a1296dcd7bf82d11f2bea505e111c517ae1b1e482af4` and asset build `11be20f84c507b5d85eba2fbdbd91f06c6b591922b11bad32ad0d02d3a16a939`. Raw reports and frames remain outside the repository.

## Ground contact during correction

On **2026-09-26**, the follow-up floating report exposed a missing constraint: the correction offset was added after physics contact, allowing the sprite to hover above or sink below its supporting floor. The earlier flat-walking check did not exercise this. Five isolating tests failed before the repair, covering a landed checkpoint, a connected slope, an unsupported edge, retained vertical offset and landing interpolation.

Reproduce with `bun server/tools/check-skill-motion.js --scope landing --round-trip-ms 2000 --output /tmp/openms-landing-2000`; `--baseline` records without repair assertions. This uses six native jumps, including left/right movement and a **1.5-second bidirectional traffic stall**, on the original Henesys floor in a disposable account. At **2,000 ms simulated RTT**, the baseline recorded **two grounded frames** off the floor near the beginning of sampling, with a maximum **44.762 px** gap. The repaired run recorded **zero off-floor frames / zero gap**, **194 airborne frames**, no unavailable prediction or history overflow, and zero final rendered-to-kernel error. Ground-contact measurement excludes the normal landing interpolation quantum. This is one fixed workload, not all maps or skills.

The repair follows connected floor geometry during horizontal easing, retires vertical correction on landing, and uses the active hit preview's contact state. It leaves the shared physics and server authority unchanged. **34 tests / 346 assertions across four files** passed, including seven focused presentation cases; scoped formatting/lint and a **976-module** guarded browser build passed. Generated reports and logs remain outside the repository; existing assets were reused without extraction.

The same repaired build also passed `--scope walk --round-trip-ms 2000`: all three holds, including the stalled hold, recorded **zero backward steps and zero paused frames**. Documentation checking retained **881 pre-existing missing targets**, with no added failures.

Baseline source build: `d3d5832606c0ae3976b7e185357983985f5c5363ff28cc33d1f5164c9ca57e1f`; repaired source build: `3583dee9ed205a80e6b7e763c8593c0d8daace0fd9e72c90a81d807e78df824d`, rules `178b554ca6dfb6bf483c66e91a035ce3f3559054f7803a288f2413422f53dc0d`. Both retained catalog `bf4d12c856304ed77c55a1296dcd7bf82d11f2bea505e111c517ae1b1e482af4` and asset build `11be20f84c507b5d85eba2fbdbd91f06c6b591922b11bad32ad0d02d3a16a939`. Repaired fixture stages: database/content **278 ms**, seed **84 ms**, backend **1,113 ms**, frontend **1,858 ms**, browser acquisition **462 ms**, teardown **127 ms**. Scenario stages: identity **4,403 ms**, readiness **37,227 ms**, latency settling **2,501 ms**, jumps/recovery **19,187 ms**, context teardown **24 ms**. Stages include deliberate latency and are not summed.

## Portal feedback and regional caching

On **2026-09-15**, `bun server/tools/check-skill-effects.js --output /tmp/openms-region-downloads-complete` passed with **500 ms simulated RTT**, a held chat/skill reply, and an additional two-second hold on an uncached destination manifest. The native browser established:

- The local speech bubble was visible while the outgoing chat row was still pending. The committed echo settled one row and did not replay local skill artwork/audio.
- Held movement survived repeated Up taps. At a real portal, holding Right while the travel request was pending advanced X from **−64.325 to −54.920** before the transition began.
- Travel from `001000000` to `000050000` played original `Sound.wz:Game.img/Portal`. The mushroom window showed “Loading Dangerous Forest…”, a visible progress bar/counter and the current map-layout resource; travel then committed.
- Victoria Island queued automatically. Entering the starter field prioritized Maple Island, whose cache advanced to **26 / 286 discovered files**, with Victoria still queued. The **310×71** download button opened a **530×344** Windows 95 dialog within the **800×600** viewport; native Pause and close controls worked. Both the modal and mushroom captures were visually reviewed. No browser errors were recorded.

Fixture timing: database/content **300 ms**, seed **91 ms**, backend startup **1,157 ms**, frontend startup **1,467 ms**, browser acquisition **477 ms**. Scenario stages: identity **1,405 ms**, login/readiness **15,319 ms**, chat **2,946 ms**, cast **3,311 ms**, download controls **941 ms**, movement/travel **14,312 ms**, context teardown **18 ms**, fixture teardown **150 ms**. These are instrumented stage durations, including deliberate latency/holds, not throughput or ordinary portal-duration claims. No extraction ran.

The browser used source build `7bd71ee7239df5b750c040b7d9267a5b9a7fadf14df6e9715fa84e886959f41a`, rules `29a483ff939e12d7075e18d8cb9594e48f7babf5f1ad0864f9f364982ef46ee1`, catalog `5bd1177cb1269b1d8f366451f4cf6c1603652dc76266d83146fa68f4a6d0e0ca`, and asset build `93fd94109cabeafcaa948e48c86447e4f723d2cc9d3d73a70ca79a625cd3fa27`. Formatting afterward changed source identity only. The final production build compiled **952 modules** and published three outputs in **1.548 s**, including **954 ms** rebuilding the startup pack from retained assets: source build `382f3fa87b6fb408bdf314d38a5131accc963b33c43a8679299631be7f3c02e2`, rules `4d21b67c95d46137a4e493edb1c23381acbea44de4ae06ab34f2aa019ade8c95`, unchanged catalog/assets. The updated pack includes the speech skin: **398 members**, **83,802,352 unpacked bytes**, **32,184,378 compressed bytes**.

The ten affected suites passed **84 tests / 497 assertions** in **804 ms**, covering regional membership, complete scenery/mob-art/sound dependency traversal, shared-file deduplication, foreground network reservations, quota/cache loss including the final batch, synchronous prepared speech, cache eviction, startup pack, portal/input behavior and network latency. Scoped formatting/lint passed. Documentation checking retains its existing **884 missing historical targets** with no missing headings.

Local manifest-only planning measured Victoria's available closure at **268 maps / 6,498 files / 1,475,943,505 bytes** in **3.032 s**. This motivated the quota-aware 4 GiB cache ceiling; no image payloads were decoded or extraction rebuilt. The browser check proves partial background progress and controls, not a complete 1.4 GB transfer, every map's appearance or persistence across browser eviction. Plans stop explicitly when the region cannot fit with foreground headroom. Raw reports, logs and captures remain outside the repository under `/tmp/openms-…`.

## Iteration-loop investigation

The retained [iteration investigation](archive/validation-history.md#iteration-loop-investigation) measured existing primitives on Bun 1.3.14 / Darwin arm64. These are historical observations, not a new performance benchmark or fixed budget.

| Stage                                          | Retained observation | Practical implication                                                     |
| ---------------------------------------------- | -------------------- | ------------------------------------------------------------------------- |
| Scoped formatting / lint                       | 173 / 298 ms         | Fail early before acquiring runtime resources.                            |
| Online protocol tests / import build           | 385 / 112 ms         | Cheap checks can validate one contract and authority imports.             |
| Content/rules/map preparation                  | 190 ms               | Online iteration can reuse extracted content.                             |
| Isolated browser context / login-art readiness | 5 / 353 ms           | Reuse the browser, isolate participants; readiness is not gameplay proof. |
| Warm extraction integrity / receipt reuse      | 53.565 s / 156 ms    | Preserve the successful-extraction receipt. These are different checks.   |
| Retired local-client build startup             | 29.523 s             | Historical measurement; it is not part of the online workflow.            |

The proposed `check online-social` domain command remains **unimplemented**. Use existing scoped checks in the [documented order](validation-method.md#shorten-the-loop). Current source hashing still requires backend/frontend restarts after shared runtime changes; do not weaken identity guards to avoid a restart.

## Client-owned motion browser check

On **2026-09-14**, a real headless Chrome entered the development server (`map` `000050000`, source `c9d4b895…`, rules `373d3460…`, assets `93fd9410…`) with the client-authoritative prediction. A 3 s held right-arrow was sampled from `requestAnimationFrame` across 180 presented frames: the character advanced `kernelX 11 → 380.5`, presented **123.94 px/s** against `walkSpeed` 125, with **stall ratio 0**, jerk ratio 0.194, **0 prediction corrections**, 0 overflow and 0 last-position error. This establishes that ordinary movement is paced by the browser's own kernel with no server correction; it is not a frame-rate claim or original Windows parity. The mid-air skill and mob-knockback trajectories are proven by `client/test/divert-alignment.test.js` (optimistic skill applied once, refused cast rolled back, hit divert merged into the client's own state) and `server/test/hit-divert-replay.test.js` (a real `OnlineWorld` publishes the 270/-270 hit divert and a real `OnlinePrediction` merges it) rather than by this hold.

## Skill cast stutter repair

On **2026-09-14**, the [scoped native check](validation/skill-motion/report.json) completed **three successful rank-20 Flash Jumps** in original Henesys (`100000000`) with disposable account/database state. Source `edad787f…`, rules `15f80b52…`, assets `93fd9410…`; full identities and receipts are in the report. Across **211 frames**, prediction had **0 tick regressions, 0 unready frames, 0 loading/input-blocking frames, and 0 server position-ownership frames**. Frame interval median/p95 were **16.7/16.7 ms**, maximum **16.8 ms**, with no interval over 20 ms. Each cast's 60-ms observation retained horizontal speed **±550 px/s**. This is a short local workload, not an all-skills, WAN-latency or original Windows benchmark.

Readiness took **2.719 s**, the three-cast action window **3.543 s**, and browser-context teardown **21 ms**. [Runtime log](validation/skill-motion/runtime.log) retains server startup and catalog/rules/source checks and the guarded browser compilation stages. Existing generated assets were reused with **no extraction**. Browser acquisition is included in fixture startup rather than separately instrumented; these measurements make no acquisition-speed claim.

The [before report](validation/skill-motion/before.json) and [frames](validation/skill-motion/before-frames.json) captured **3 clock resets, 3 unready frames and 3 loading frames** despite stable 16.7-ms rendering. Its three key attempts included two successful casts and one insufficient-MP refusal: the initial fixture set displayed maximum MP without base MP. The final fixture sets both and explicitly checks three **cast** receipts rather than counting release receipts. This is causal failure evidence, not an equal-workload throughput comparison. Earlier setup attempts also exposed a missing shared report `results` array and missing WZ prerequisite; both harness defects were fixed before the retained baseline. An intermediate fix still reset prediction because assembled profile snapshots omit connection epoch; the final guard uses the authenticated transport epoch.

[Targeted test log](validation/skill-motion/tests.log): **107 tests / 1,453 assertions passed**, covering movement adoption/watchdog disconnection, protocol transport, immediate native cast and echo consumption, repeated/invalid casts, stale refusal after field replacement, player impulses and grounded mob recoil. Scoped formatting/lint and the nonpublishing guarded browser build passed. [Ghidra run log](validation/skill-motion/ghidra.log) and [full decompilation](ghidra-client/knockback-trajectory.txt) retain the original-client investigation. [Movement findings](movement-parity.md#skill-snapshot-continuity) describe the fixes and source boundaries.

## Extraction performance

On **2026-09-14**, the same default 735-map extraction with all 742 units cached fell from **57.11 s to 36.50 s**, a **36.1% reduction**. Both serial runs used Bun 1.3.14 on Darwin arm64 with CPU profiling enabled. This is one measured pair on this machine, not a cold-disk or cross-machine guarantee. [Evidence](extraction-performance.json) retains source hashes, input identity, timings and sampled hotspots; [profiling instructions](asset-delivery.md#profiling-a-slow-extraction) reproduce the workflow.

| Work | Before | After | Interpretation |
| --- | ---: | ---: | --- |
| Complete extraction | 57.11 s | 36.50 s | Final success progress time; includes the rows below. |
| Selected-world preflight | 17.85 s | 7.56 s | Same source/dependency validation and decoded-pixel checks. |
| UI cache unit | 11.30 s | 7.34 s | Source, cache-record and transitive output verification. |
| Map cache units, summed | 22.26 s | 18.58 s | 735 sequential units; excludes surrounding catalog work. |
| Verified resources / bytes | 49,445 / 4,552,029,422 | 49,445 / 4,552,029,422 | Every unique reachable output still receives a length and SHA-256 check. |

The profile identified typed-array checksum iteration and generic per-pixel coordinate expansion as avoidable costs. Indexed signed-checksum arithmetic and direct unscaled RGBA conversion remove that overhead. Output verification also resolves its owned root once and uses native synchronous SHA-256. It still resolves each resource path, parses JSON dependencies and repairs missing/corrupt output through the existing cache path.

The decoder/recipe change required **one rebuild of all 742 units**, recorded separately at **662.22 s**. It independently compared **4,457,477,660 bytes** of atlas pixels, then reproduced the exact previous catalog bytes: build `20f52c09a7bf695a0b1e5b921383757aa48947d6b1be13f1ad53f5515294418e`, catalog SHA-256 `4fbf9bf3c70f13a209ff633f058fbf6a4aec139e962e168daa4dbcceeab4a17e`. The cache was retained and refreshed; this rebuild is excluded from the all-hit speed comparison. Cold conversion remains expensive and has no before/after speed claim here.

All **27 focused tests / 120 assertions** passed, including every 16-bit packed color, transparent RGB, scaled edges, signed checksum overflow, corrupt output/cache repair, nested descriptors, symlink escape refusal and publication binding changes. Scoped Prettier/ESLint checks passed. No gameplay or browser benchmark was needed for this identical-output conversion change.

The optimized warm run still spent **23.34 s** in output-closure verification, including **10.81 s** in reads/path checks and **9.61 s** in JSON decoding/traversal. These nested times are not additive with the total. Explicit extraction remains the integrity/repair operation; unchanged receipt probing is a separate, much cheaper operation. PNG encoding, metadata serialization and hashing remain costs when units actually rebuild.

## Known limits

| Claim not established                                       | Where to look                                                                                   |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Complete original Windows rendering / native execution      | [Windows reference requests](windows-reference-captures.md)                                     |
| Every original skill, quest, item, reactor or service       | [Feature gaps](server/offline-parity.md#shared-rules-and-missing-coverage)                      |
| Production security, durability and deployment readiness    | [Required protocol proof](server/protocol.md#implementation-order-and-required-proof)           |
| Current full-catalog or world-wide performance             | [Historical reports](archive/index.md); these gates must be explicitly rerun for a new release. |

## Historical results

Earlier account names, schema versions, capture counts and benchmarks have moved to [validation history](archive/validation-history.md), [offline gameplay history](archive/gameplay-history.md) and [native UI history](archive/native-ui-history.md). Use the original report and source identity when investigating a regression; use the current guides for setup and implementation.


## Modern combat formulas (14 September 2026)

The user selected modern combat equations from StrategyWiki for the existing v83 content. [The formula contract and content mappings](combat-formulas.md) supersede earlier native damage calculations; native movement and authored action timing remain in place.

- **137 tests / 866 assertions passed** across sixteen affected client/server suites: formulas, stat display, large-number glyphs, first-cast area/Meso contexts, incoming hits, skill/status lifecycle, authority publication, protocol and motion. [Test output](validation/modern-formulas/tests.log).
- Scoped ESLint (zero warnings), Prettier and documentation links passed. The guarded browser build contains 930 modules. The running client/server identity matches the browser-tested source build `e17db7502eb12b3018eda94d305ab356549cb10d55c99f4f12505ecf4c6d4983` and rules `093a4c7c7504727b2e12b5ce30c9dd3da826bce8b0e499419da79b7028801293`.
- The isolated browser repeated three airborne Flash Jumps with the new combat/stat schema. All three casts committed. Across 210 frames: median 16.7 ms, p95/max 16.8 ms, zero intervals over 20 ms, zero motion regressions, zero unready/loading samples and zero metric overflow. [Report](validation/modern-formulas/report.json), [frames](validation/modern-formulas/frames.json).

This is a scoped regression measurement, not a guarantee across all hardware, maps or simultaneous combat populations. Modern-only content systems remain outside the v83 catalog; missing monster defense-rate fields explicitly mean zero percent, never a reinterpretation of legacy flat defense.

## Consecutive Flash Jump artwork (14 September 2026)

The [initial rapid-cast reproduction](validation/flash-jump-replay/before-report.json) committed two consecutive jumps and measured a 221 px separation between the second effect's rendered and published origins; its third cast was rejected. [Before frame samples](validation/flash-jump-replay/before-frames.json) and [image](validation/flash-jump-replay/before.png) retain that failure. Slower casts did not reproduce the offset. Intermediate rapid checks also exposed the input-order and paused-skill-clock admission cases described in [movement parity](movement-parity.md#skill-snapshot-continuity).

The final [report](validation/flash-jump-replay/report.json) and [frame samples](validation/flash-jump-replay/frames.json) cover five committed casts, including a rapid pair with a direction reversal and one replay while the old effect was still resident. Every visible Flash Jump frame matches the new cast's quantized origin: maximum offset **0 px**. [After image](validation/flash-jump-replay/after.png). Across 278 frames, median/p95 intervals were 16.7 ms, maximum 16.8 ms, with no intervals over 20 ms, loading/unready samples, regressing prediction ticks or authoritative movement resets. This is a local scoped measurement, not a hardware-wide performance claim.

**30 tests / 102 assertions passed** across seven suites covering effect reuse, WZ playback publication, queued-input ordering, airborne-use recovery, skill admission, combat and protocol. [Test output](validation/flash-jump-replay/tests.log). Changed JavaScript passed Prettier and ESLint with zero warnings; the browser used existing extracted assets. The report retains the exact source, rules and catalog identities.

## Meso Explosion placement — 15 September 2026

The [native replay](native-ui-validation/meso-explosion/report.json) passed on source build `8f51a55e208d3dae9183d0bb9a1a3f64649d9853faafd0f544dc169de511bcd1`, rules `41cb72c762ea9f385cdbdbf965e6062376c02e154240cfc048dcd26a54bd847c`, and unchanged catalog `5bd1177cb1269b1d8f366451f4cf6c1603652dc76266d83146fa68f4a6d0e0ca`. A disposable Chief Bandit dropped three separated piles per cast through the Item window, turned using native movement input, and cast Meso Explosion facing each direction. All six effects remained at the recovered centered drop anchors across 160 visible frame observations; no monster was present. Reconnection retained balance 9,940 after six 10-meso drops. Both casts committed and the browser error list was empty.

Reviewed captures show the [left-facing explosions](native-ui-validation/meso-explosion/ArrowRight-explosion.png) and [right-facing explosions](native-ui-validation/meso-explosion/ArrowLeft-explosion.png). The first fixture attempt used a zero-duration direction press, which did not reach a movement tick; waiting for the observed facing corrected the fixture before the retained run. The passing report also retains a separate `NOT_ALLOWED` result from native UI interaction; both requested skill casts committed.

Scoped checks: seven tests covering the original WZ animation pools, all nine variants, currency-height thresholds, modern first-hit formulas, and target geometry; changed-file Prettier/ESLint; guarded online build with 930 inputs. No extraction was required. Ghidra evidence and the remaining packet-stagger/Windows-runtime limitations are documented in [animation recovery](meso-explosion-animation.md).

## Slow-network gameplay repair

On **2026-09-15**, the [scoped native scenario](validation-method.md#slow-network-gameplay-check) passed in headless Chrome at 1280×800, using a disposable account/database, **500 ms HTTP delay and 250 ms in each WebSocket direction**. Existing extraction was reused. Raw reports and logs remain local under the [artifact policy](validation-method.md#artifact-policy).

| Identity | Measured value |
| --- | --- |
| Browser build | `beaf7e266dca6ea2eecca786a0d477ee1cc25b6bd33c64950900529c359537c3` |
| Rules | `6c5f64edcc08626b8ee49861ff0b2e2bff3802b7e84712924d09af61680fdd7a` |
| Asset build | `93fd94109cabeafcaa948e48c86447e4f723d2cc9d3d73a70ca79a625cd3fa27` |
| Catalog | `5bd1177cb1269b1d8f366451f4cf6c1603652dc76266d83146fa68f4a6d0e0ca` |

- A **20-second initial map-manifest hold** kept the socket alive. Disconnecting during that load resumed the same character without `CHARACTER_BUSY`.
- Native walking survived a **1.5-second traffic stall**. The server's published X and the client's X both moved **112 → −460.687**, with **zero prediction overflows**.
- Regular Cab's tested Next page took **753 ms** at the imposed RTT. Dialogue made **zero additional prose HTTP requests**.
- A **20-second destination-manifest hold** completed, charged the 100-meso fare once, and preserved 1,900 mesos after reconnect.

Browser acquisition took **484 ms**, identity verification **1.434 s**, login **19.682 s**, cold entry plus interruption/reconnect **51.179 s**, walking/stall **7.769 s**, dialogue/cold travel **58.361 s**, and final reconnect **2.439 s**. The cold stages include deliberate holds and real artwork loading; they are not download-speed estimates. Browser-context teardown was **20 ms** and enclosing fixture teardown **157 ms**. Startup/content timings are retained separately; overlapping timings must not be summed. This verifies one recovery workload, not all maps, arbitrary packet loss or frame-rate performance.

Attempt 1 incorrectly expected automatic reconnect; attempt 2 clicked Enter behind the connection-loss dialog. Attempt 3 read an unchanged baseline position instead of live motion and also exposed one stale prediction overflow after preparation. The final scenario reads published motion, dismisses the actual dialog, and the client obtains a fresh checkpoint before enabling input after a long load.

Targeted checks passed **75 tests** across transport, protocol, dialogue, server admission and lifecycle. The overlapping final transport checks passed **33 tests / 178 assertions**, including the last review change: stale-checkpoint refreshes share the three-attempt recovery limit. That bounded-retry change and a cancellation-disposal review followed the browser run. Their later source identity was `1ae79aefec3187f614a23d7434fc463b83e9ee8eb5ba253f6a411bf5a8b4b0fc`; the browser measurements above retain their original identity. Final scoped formatting/lint and a nonpublishing guarded build (**934 modules**) passed. At validation time, the documentation checker reported **884 existing missing historical targets**.

Reproduce the native scenario and focused transport checks with:

```sh
bun server/tools/check-network-latency.js --output /tmp/openms-network-latency
bun test client/test/online-latency.test.js client/test/online-transport.test.js client/test/sync-alignment.test.js
```

## Startup asset preload

On **2026-09-15**, sequential before/after runs of the [startup scope](validation-method.md#slow-network-gameplay-check) passed in headless Chrome at 1280×800, with a disposable account in Henesys, **500 ms HTTP delay and 250 ms in each WebSocket direction**. Both reused the same extraction/catalog. The final run includes eviction-order protection for recently used cache entries.

| Measurement | Before | After |
| --- | --- | --- |
| Cold startup to usable login | 16.585 s | 53.847 s |
| Login to character selection | 3.378 s | 3.034 s |
| Enter to playable Henesys | 29.063 s | 2.659 s |
| Generated-asset HTTP requests during entry | 83 | 0 |
| Startup after a retained-cache reload | 2.456 s | 2.562 s |
| Generated-asset HTTP requests after reload | 1 | 1 |

Startup completed **395 unique files / 48,112,678 encoded bytes (45.9 MiB)** before any game connection existed. Reload reused those files; its one generated-asset request fetched the catalog. The original login render allocation remained **16 atlases / 89,535,960 decoded CPU and estimated GPU bytes** before and after: warming encoded files added no texture residency. The tradeoff is a longer first startup, which also prepares the default starter map, Lith Harbor and common controls before a character holds a server session. Other maps and uncommon appearances still load on demand.

Native movement at this latency survived a **1.5-second traffic stall** without changing the connection epoch or overflowing prediction history. The final walking/stall stage took **7.779 s**, followed by a **2.378 s** reconnect. No browser errors occurred. This is one fixed network workload, not a guarantee for every map, device or loss pattern.

The separate storage-disabled latency scope also passed on the final source: both **20-second map-manifest holds** preserved their connections, a forced initial disconnect resumed without `CHARACTER_BUSY`, native walking survived the traffic stall, and NPC travel charged its fare once and retained 1,900 mesos after reconnect. Dialogue used no additional prose HTTP requests, and no browser errors occurred. Without persistent caching, cold entry including the deliberate hold/interruption took **55.672 s**, dialogue/cold travel **66.261 s**, and the final reconnect **53.552 s**. These longer waits remain possible when the browser refuses storage; preloading cannot accelerate files it cannot retain.

| Identity | Value |
| --- | --- |
| Browser before | `7805701860e8159e0902af257469d1d82fd3a3399cd1041b583cab9ab3acdd6d` |
| Browser after | `90cd16410d8590a93fe10b87baac85c5491437423b6c22a6e7e72e3dd10d292a` |
| Rules before | `3984c2a6725e3acaaed5f97125a31277737c6ac5bbcb0cd45766667b9d28e5d1` |
| Rules after | `9a5d446f0e603f960300bc28b6b5c5efaa8416ffee2163550020861b7667567c` |
| Asset build | `93fd94109cabeafcaa948e48c86447e4f723d2cc9d3d73a70ca79a625cd3fa27` |
| Catalog | `5bd1177cb1269b1d8f366451f4cf6c1603652dc76266d83146fa68f4a6d0e0ca` |

Final fixture preparation measured **300 ms** for database/content, **110 ms** for seed, **1.185 s** for server startup, **555 ms** for frontend startup, **492 ms** for browser acquisition and **1.432 s** for browser identity verification. Browser-context teardown took **13 ms** and enclosing fixture teardown **180 ms**. These stages were recorded separately, without adding overlapping timings. There was no extraction. An initial passing preload run measured **2.584 s** entry; the table uses the later final run after the full-cache regression fix.

Focused validation passed **32 tests / 131 assertions**, covering verified cold/warm loads, shared atlas/region deduplication, byte/file limits, corrupt resources, batch cancellation/failure, unavailable/quota-limited storage and eviction from a full cache. Changed-file Prettier/ESLint and the production guarded build (**938 modules**) passed. The documentation checker retained **884 existing missing historical targets**. Raw reports and logs stay outside the repository under the [artifact policy](validation-method.md#artifact-policy).

```sh
bun server/tools/check-network-latency.js --scope startup --output /tmp/openms-startup
bun test client/test/online-startup-preload.test.js client/test/online-loading.test.js client/test/stream-network.test.js
```

## Browser cache capacity and index

On **2026-09-15**, sequential isolated Chrome runs of the [cache scope](validation-method.md#slow-network-gameplay-check) measured opening a real CacheStorage containing **2,048 synthetic 1 KiB files**. The new budget was **1 GiB / 16,384 files** on this browser. Existing payloads were migrated in place; ordinary reopening read indexed metadata without scanning payload headers.

| Measurement | Before | After |
| --- | ---: | ---: |
| First open / migration | 258.9 ms | 239.2 ms |
| First-open header reads | 2,048 | 2,048 |
| Files retained after first open | 2,047 | 2,048 |
| Warm open | 100.5 ms | 12.8 ms |
| Warm-open header reads | 2,047 | 0 |

The old opening path unnecessarily reserved a new entry slot and evicted one file at capacity. The replacement retains the complete set. Growing the cache to **4,096 files / 4 MiB** took **1.293 s**; reopening retained all files in **27.8 ms with zero header reads**. Three injected interruptions (after insertion, after deletion and before payload mutation) recovered the correct inventory using exactly **three targeted reads**. Corrupted bytes failed SHA-256 verification and their index entry was removed. With IndexedDB opening forced to fail, an existing valid payload still produced a verified cache hit without a download.

This is one local metadata/opening comparison, not a full 1 GiB fill or cross-browser storage benchmark. Logical byte-accounting tests establish retention above the old 192 MiB ceiling, eviction at 1 GiB, quota headroom, one smaller-budget retry, read-only fallback and oversized-file skipping. The final storage probe measured module build **3.940 ms**, browser acquisition **466 ms**, seeding **436 ms** and teardown **320 ms**. There was no database, asset extraction or artificial network delay in this scope.

The separate **500 ms RTT startup scope passed** with the same 395-file / 48,112,678-byte preload. Cold startup was **53.854 s**, login **3.803 s**, entry **2.637 s**, walking/stall **7.768 s**, reconnect **2.396 s**, and retained-cache startup **2.586 s**. Entry made **zero generated-asset HTTP requests**; reload made one catalog request. Native walking survived the 1.5-second stall. Initial render residency remained **16 atlases / 89,535,960 decoded CPU and estimated GPU bytes**. Chrome reported persistence as `best-effort`; no browser grant is claimed. Warm cache opening was **25.2 ms with zero header reads**.

| Identity | Value |
| --- | --- |
| Cache module before | `a97c25e8bebc5a4f9405953b2bb30bea5d9e4b521a1f086cb9742d9766071701` |
| Cache module after | `66503fb073f57460bcb287c8fea867a75fccee09537da3c8d6c688a95c2cce8a` |
| Startup browser build | `c783e47181c522286519e258f7837c6bef96144e48479475a05693d6cde7fb1b` |
| Rules | `f126571fcb44557a74e859e7235b1c72c03b63e4ef61a6e49f90d9e8416441c4` |
| Asset build | `93fd94109cabeafcaa948e48c86447e4f723d2cc9d3d73a70ca79a625cd3fa27` |
| Catalog | `5bd1177cb1269b1d8f366451f4cf6c1603652dc76266d83146fa68f4a6d0e0ca` |

The startup fixture separately measured database/content **253 ms**, seed **101 ms**, server startup **1.102 s**, frontend startup **547 ms**, browser acquisition **461 ms**, identity verification **1.411 s**, browser-context teardown **16 ms** and enclosing teardown **163 ms**. Existing extraction was reused. Overlapping stages must not be summed.

Focused validation passed **42 tests / 171 assertions** across cache policy, preload, verified networking and loading. Changed JavaScript passed Prettier and ESLint with zero warnings, and the guarded production build passed with **941 modules**. The documentation checker retained **884 existing missing historical targets**, with no missing headings. Raw measurements and logs remain outside the repository under the [artifact policy](validation-method.md#artifact-policy).

```sh
bun server/tools/check-network-latency.js --scope cache --output /tmp/openms-cache
bun server/tools/check-network-latency.js --scope startup --output /tmp/openms-startup
bun test client/test/cache-policy.test.js client/test/online-startup-preload.test.js client/test/stream-network.test.js client/test/online-loading.test.js
```

## Catalog reuse on refresh

On **2026-09-15**, investigation of repeated refresh downloads found that the root catalog bypassed persistent caching even though the server configuration already supplied its SHA-256. The earlier retained-cache run above transferred **35,679,091 bytes (34.0 MiB)** for that catalog on every reload. The startup presentation also called local hash-checking work “Downloading” and labelled prepared bytes as downloaded bytes.

The root catalog now shares the bounded disk cache and is checked against the fresh server hash before reuse. A missing, changed or corrupt copy gets one verified replacement. The loading decoration also uses the verified cache. Startup distinguishes saved-file checks from real downloads; `delivery.preparedBytes` names completed preparation, while `streaming.downloadBytes` reports actual downloaded bytes. Quota admission reserves enough space for both the catalog and the common preload.

The [startup scope](validation-method.md#slow-network-gameplay-check) passed in isolated Chrome at 1280×800, using the same extracted assets, a disposable Henesys account, **500 ms HTTP delay and 250 ms per WebSocket direction**. The retained-cache reload made **zero `/generated/` requests and downloaded zero asset bytes**, with **427 verified cache hits**. Startup fell from **2.586 s to 2.072 s** for this local fixed-latency pair. The cache retained **397 files / 83,796,030 bytes**, including the catalog and decoration; the common preload itself remained 395 files / 48,112,678 bytes. Opening restored metadata in **27.7 ms with zero header reads**. These measurements do not establish every browser's storage availability or every map's performance.

Cold startup took **54.918 s**, login **3.248 s**, entry **2.585 s** with zero new generated-asset requests, walking through the 1.5-second stall **7.774 s**, and reconnect **2.385 s**. No browser errors occurred. Warm login render residency remained **16 atlases / 89,535,960 decoded CPU and estimated GPU bytes**. Browser build: `6772f06cdc46a211e65a2c166b576170dc11eb02e2efb38d90ca49c679c90273`; rules: `88e5b3ebbbff93ddd9b437b2e4e58a48561244c71199aaba5aaf01f59a6c72a6`. Catalog and asset identities match the preceding cache-capacity run.

Fixture stages were database/content **300 ms**, seed **114 ms**, server startup **1.250 s**, frontend startup **556 ms**, browser acquisition **505 ms**, identity verification **1.426 s**, browser-context teardown **14 ms** and enclosing teardown **160 ms**. No extraction was needed; overlapping stages are not additive.

**48 focused tests passed**, covering unchanged/changed/corrupt catalogs, mismatched server responses, cancellation, storage fallback, preload capacity and loading presentation. The expanded catalog-plus-preload quota cases separately passed the eight-test preload suite. Changed JavaScript passed Prettier/ESLint, and the guarded production build passed with **942 modules**. Documentation checks retain **884 existing missing historical targets**. Raw reports and logs stay outside the repository.

```sh
bun server/tools/check-network-latency.js --scope startup --output /tmp/openms-refresh-startup
bun test client/test/stream-catalog.test.js client/test/stream-network.test.js client/test/online-loading.test.js client/test/online-startup-preload.test.js client/test/cache-policy.test.js
```

## Watchdog contact and retirement repair

On **2026-09-15**, the reported map-10000 kick (`position:200`, `velocity:0`, `elapsedMs:30`, `allowedPosition:32`) led to two reproducible defects. A delayed position could be accepted, then projected back onto the server's old foothold during its next step. Separately, `faultMotion` set `actor.retiring`, which caused the gateway's old maintenance guard to skip starting retirement and leave the character/account lease busy indefinitely.

The executable regression runs the real map **000010000** physics in independent client/server simulations for **240 quanta**. It withholds **50 reports / 1.5 seconds** while walking across adjacent ground segments, then sends neutral input. Before the fix, the second returning report faulted at tick 132: server X **225** versus client X **366**, a **141 px** discrepancy with zero velocity discrepancy and a 32 px allowance. This establishes the same false-kick mechanism, not a replay of the user's particular NPC dialogue.

After contact adoption was repaired, all 240 quanta completed with **zero watchdog faults** and final X agreement within one pixel. Reports leaving ground or a ladder release stale references without moving to nearby terrain. Existing tests still reject an impossible single report and repeated suspicious reports; watchdog thresholds are unchanged. The separate retirement regression failed before the fix because no retirement promise existed after a kick. It now proves one cleanup owner, a checkpoint that waits for its pending completion, one lease release, and removal from field/account/character registries.

**33 tests / 413 assertions passed** across motion adoption, lifecycle, delayed input admission, hit-divert replay and skill/input ordering. Changed-file Prettier/ESLint and the guarded production build (**942 modules**, source build `426f36ac29f490d84b901b7a3c9dcb5400ebb308a6cc3a3fb5b942d61a8008d8`) passed. The map manifest is `cd4d631f640a14529e426e0bdd9e06f4d4e90cfdbf8453d676b853d153959c8d`, from asset build `93fd94109cabeafcaa948e48c86447e4f723d2cc9d3d73a70ca79a625cd3fa27`. Existing extraction was reused. Validation was scoped to these server/kernel regressions; no new browser or frame-rate claim is made. Raw logs remain outside the repository.

```sh
bun test server/test/motion-adoption.test.js server/test/lifecycle.test.js server/test/network-latency.test.js server/test/hit-divert-replay.test.js server/test/skill-input-order.test.js
```


## Single startup download

On **2026-09-15**, the startup scope passed with the same retained extraction, isolated Chrome at 1280×800, disposable Henesys account, **500 ms HTTP delay and 250 ms per WebSocket direction**. The comparison uses the earlier [catalog-reuse baseline](#catalog-reuse-on-refresh); those measurements already captured the 397-request bottleneck. No extraction or competing performance run was needed.

| Measurement | Individual-file baseline | Startup pack |
| --- | ---: | ---: |
| Cold startup to usable login | 54.918 s | **3.130 s** |
| Generated-file requests during cold startup | 397 | **1** |
| Retained-cache startup | 2.072 s | 2.036 s |
| Generated-file requests after reload | 0 | 0 |
| Enter to playable Henesys | 2.585 s | 2.585 s |
| Additional generated-file requests during entry | 0 | 0 |

The one transfer contained **32,183,852 compressed bytes (30.7 MiB)**. It installed **397 files / 83,796,030 bytes**, including the catalog, decoration and unchanged 395-file / 48,112,678-byte common preload. SHA-256 verification completed before login and before any game connection. Reload reused **427 verified cache hits**, downloaded **zero bytes**, and reopened indexed storage in **23.6 ms with zero header scans**. Login render residency remained **16 atlases / 89,535,960 decoded CPU and estimated GPU bytes**; temporary archive buffers are separate from those renderer metrics. The pack itself is not retained as a second persistent copy.

Login took **2.911 s**, native walking through a **1.5-second traffic stall** took **7.769 s**, and reconnect took **2.357 s**. The connection survived the walking/stall stage, entry needed no additional generated files, and there were no browser errors. These figures isolate request latency on a local delayed relay; they do not measure internet bandwidth, packet loss or low-memory devices.

| Identity | Value |
| --- | --- |
| Baseline browser | `6772f06cdc46a211e65a2c166b576170dc11eb02e2efb38d90ca49c679c90273` |
| Packed browser, development scenario | `73a44e95172212cf29215349e3859a9d4ff961d9efbbfc13c039c9127597dd56` |
| Final production browser | `48826bfa873edcc83cd58aefe78d43483d615df80a1b974c143445b92d20e9a3` |
| Packed-run rules | `3cbf52793dba5bdc4b9abd35754d6a36a50c663e907b46db180efa1415eaf777` |
| Asset build, both runs | `93fd94109cabeafcaa948e48c86447e4f723d2cc9d3d73a70ca79a625cd3fa27` |
| Catalog, both runs | `5bd1177cb1269b1d8f366451f4cf6c1603652dc76266d83146fa68f4a6d0e0ca` |
| Startup pack | `ddab610eb895feb02eaac3c7c1202b868c858e550dfd43f963ab1e7eb4b6e349` |

Fixture stages measured database/content **284 ms**, seed **103 ms**, server startup **1.074 s**, frontend startup **1.331 s**, browser acquisition **473 ms**, identity verification **1.397 s**, browser-context teardown **11 ms** and fixture teardown **103 ms**. Frontend startup includes about **818 ms** packing the retained common files. The final production build took **1.460 s**, including about **912 ms** packing; it compiled **944 modules** and published three bundles. These nested stages are not summed.

Focused checks passed **47 tests / 206 assertions**, including one-transfer cache installation, reopened-cache reuse, individual repair of small gaps, fresh-server identity rejection, compressed/member corruption before cache writes, expanded/truncated bodies, path/size bounds, cancellation and quota loss. Changed JavaScript passed Prettier/ESLint. The documentation checker still reports **884 existing missing historical targets**. Raw reports and logs remain outside the repository.

```sh
bun server/tools/check-network-latency.js --scope startup --output /tmp/openms-startup-pack
bun test client/test/online-startup-pack.test.js client/test/online-startup-preload.test.js client/test/stream-catalog.test.js client/test/stream-network.test.js client/test/online-loading.test.js
bun client/tools/build-online.js
```

## Local feedback and watchdog lag tolerance

On **2026-09-15**, the watchdog gained **500 ms of position headroom**, with suspicious reports within **50 ticks / 1.5 seconds** sharing one evidence mark. A fault now requires eight separate marks within 27 seconds, or an extreme deviation exceeding eight times its envelope; extreme position faults also require more than 4,096 px. The reported 200 px / 30 ms discrepancy is inside the new 477 px allowance. Tests establish acceptance of that case and a burst of delayed reports, rejection of repeated independent incidents and impossible teleports, and continued kicked-character lease cleanup. These are lag policies, not recovered original-client constants.

The focused native browser check passed in isolated Chrome with a disposable account in map **1000000**, **500 ms HTTP delay and 250 ms per WebSocket direction**. Native chat appeared locally while replies were held for **1.5 seconds**; its echo settled exactly one row. Native Recovery (`1001`) started its Use artwork and sound while replies were held for **three seconds**, before a receipt or server presentation event arrived. The later matching visual/audio events did not replay those cues, and the connection remained active with zero browser errors. Damage, costs, buffs and recipient delivery remain server-owned. This check establishes local Use feedback for one native cast, not every skill or attack phase.

The **142×50 Win95 loading panel** remained inside both **1280×800 and 800×600** viewports, with its bottom edge 86 px above the viewport bottom and no pointer interception. Screenshot review confirmed the larger navy progress ring and readable label above the HUD. Focused ownership tests cover refusal cleanup, delayed asset completion after scene exit, server-first races, exact operation matching, fixed movement-effect origins and reuse beyond the 32-record feedback bound.

Browser stages measured identity **1.404 s**, startup/login/map entry **15.189 s**, chat **2.976 s**, cast **3.342 s** and context teardown **16 ms**. The chat/cast stages include their deliberate reply holds; login includes cold startup and this map's uncached assets. Fixture stages measured database/content **314 ms**, seed **86 ms**, server startup **1.084 s**, frontend startup **1.395 s**, browser acquisition **456 ms** and fixture teardown **102 ms**. Existing extraction was reused. These nested timings are not additive and do not establish a general internet or frame-rate benchmark.

The first scenario attempt exposed a missing report-results array and a cast racing the HUD's debounced settings save (`SERVER_BUSY`). The harness now waits for that save before isolating the cast reply hold; the initial refused cue was correctly cleaned up. The final run committed every observed command. A test fixture also referenced a removed historical JSON report; it now reads physics globals from the retained real map manifest rather than restoring generated evidence to the repository.

| Identity | Value |
| --- | --- |
| Browser, development scenario | `5bb8ea7eff68a9ea8098dcf6e977ad64a369c5b3f47c20d85bfe8e7f4d8b7140` |
| Final production browser | `70c3d70cfdf1780f387c290c6a2c8785a7e04d729993607cdf8d04b58ee1be87` |
| Rules | `db5ec85f756c24f7b2fde444791e5f4855f8e840443d6fafb86f37f4e770f4ce` |
| Asset build | `93fd94109cabeafcaa948e48c86447e4f723d2cc9d3d73a70ca79a625cd3fa27` |
| Catalog | `5bd1177cb1269b1d8f366451f4cf6c1603652dc76266d83146fa68f4a6d0e0ca` |

**71 tests / 653 assertions passed** across local feedback, chat, skill motion/replay, watchdog adoption, lifecycle, delayed input ordering and loading. Changed JavaScript passed Prettier and ESLint with zero warnings. The guarded production build passed with **948 modules** and three bundles. The documentation checker retains **884 existing missing historical targets**, with no missing headings. Raw reports, screenshots and logs remain outside the repository under the [artifact policy](validation-method.md#artifact-policy).

```sh
bun server/tools/check-skill-effects.js --output /tmp/openms-local-feedback
bun test client/test/local-feedback.test.js client/test/online-chat.test.js client/test/online-skill-motion.test.js server/test/chat-delivery.test.js server/test/skill-visual-replay.test.js server/test/motion-adoption.test.js server/test/lifecycle.test.js server/test/network-latency.test.js server/test/skill-input-order.test.js client/test/online-loading.test.js
bun client/tools/build-online.js
```


## Combat latency and remote motion

On **2026-09-16**, the focused combat scenario used native controls in disposable fighter/mage accounts on map **50000**, with **500 ms RTT** and an additional **1.2-second bidirectional traffic pause** for each attack. Existing extraction and the common startup pack were reused. The original run lost the short basic attack when its movement sample expired; Power Strike appeared only after **1,553 ms**.

| Input | Original first pose | Repaired first pose | Confirmation |
| --- | ---: | ---: | --- |
| Basic attack | No pose observed | **41.6 ms** | Original input sequence confirmed; one animation run |
| Power Strike | 1,553 ms | **9.3 ms** | Original operation confirmed; one animation run |
| Magic Bolt | Not in baseline | **15.5 ms** | Original operation and projectile confirmed; one animation run |

Magic Bolt's local flight began at **465.2 ms**, following its authored release frame, while traffic was still held. Server costs committed, and the matching projectile identity reached the preview consumer. Local presentation never granted damage, MP, ammunition or hit results. The first projectile integration lost its cast identity at delayed release; the corrected shot now captures the identity before later casts can replace it. A real original-ball resource test verifies that its eventual publication retains the first cast's ID.

A separate **450 ms traffic pause** exercised remote motion. The final browser sample retained **391 moving entity/frame pairs more than 150 ms after their last changed observed position**; maximum movement between sampled frames was **3.292 px**. Idle mobs remain legitimately still. AI choices were not seeded between runs, so aggregate idle/moving counts are diagnostics rather than a matched AI or FPS benchmark. A deterministic 1.5-second test with 300 ms updates establishes zero stationary frames and less than 3 px per 15 ms step, including gradual corrections; separate checks cover braking at the 600 ms prediction bound, foothold slopes/endpoints and respawn resets.

Early checks exposed two additional faults: a new server pose could publish with the previous action's identity/phase, and late press/release bursts could discard the attack with expired motion. Immediate action projection and a bounded independent attack-edge queue fix these cases. One early browser run replayed Power Strike after confirmation; the scenario now requires exactly one animation run and original-request confirmation. The initial direct import of the skill attack controller failed the guarded browser build because it pulled in offline authority; a shared pure action selector resolved this without relaxing the guard.

Final browser stage timings were identity **1.406 s**, fighter login/entry **18.719 s**, basic attack **2.529 s**, Power Strike **2.525 s**, mob sampling **1.011 s**, mage login/entry **19.708 s**, Magic Bolt **2.537 s**, and context teardown **81 ms**. Attack stages include the deliberate pause and observation interval. Fixture timings were database/content **287 ms**, seed **172 ms**, server startup **1.122 s**, frontend startup **1.427 s**, browser acquisition **489 ms** and fixture teardown **131 ms**. Baseline timings were identity **1.448 s**, login/entry **17.104 s**, basic **2.517 s**, Power Strike **2.520 s**, mob sampling **1.013 s** and context teardown **25 ms**; fixture database/content **383 ms**, seed **99 ms**, server **1.320 s**, frontend **1.702 s**, browser acquisition **581 ms**, teardown **163 ms**. Nested timings are not summed; these are local delayed-relay measurements, not internet bandwidth results.

| Identity | Value |
| --- | --- |
| Baseline browser | `ffb915e7c9ce45ae5c7991da31bc914d18df9a05da83b61952e57f9e9b1558ad` |
| Final measured browser | `489a82d547c00a80a6bf99b0838ef485e2300e60563fd7ec5ce68fe3ff472c58` |
| Measured rules | `1a3b3c1d0a35d03880b982da4965f94f61bbf90dbcea0551bf4b86b9b6d779dd` |
| Final production browser | `731bca0f9a8ba09346a0a418aece0b138264394ebd57910146f58580ade69b79` |
| Asset build, both runs | `93fd94109cabeafcaa948e48c86447e4f723d2cc9d3d73a70ca79a625cd3fa27` |
| Catalog, both runs | `5bd1177cb1269b1d8f366451f4cf6c1603652dc76266d83146fa68f4a6d0e0ca` |

After the measured browser run, field replacement/destruction and death were wired to cancel the local combat owner immediately; pending preparation across a field-owner change is covered by the final targeted tests. **84 tests / 725 assertions passed** across 14 affected files. A final three-test / 16-assertion run also verifies that the default nonflight sequence call retains its cast identity. Changed JavaScript passed Prettier and ESLint with zero warnings. The guarded production build compiled **961 modules** and three bundles in **1.490 s**, including **894 ms** packing retained assets; no extraction ran. The documentation checker retains **884 existing missing historical targets**. Raw reports, frame samples and logs remain outside the repository under the [artifact policy](validation-method.md#artifact-policy).

```sh
bun server/tools/check-combat-latency.js --output /tmp/openms-combat-latency
bun test client/test/combat-latency.test.js client/test/local-feedback.test.js client/test/sync-alignment.test.js client/test/online-protocol.test.js client/test/skill-actor-replacement.test.js client/test/skill-projectile-chase.test.js client/test/weapon-usage.test.js server/test/attack-input.test.js server/test/field-combat.test.js server/test/skill-visual-replay.test.js server/test/network-latency.test.js server/test/skill-input-order.test.js server/test/motion-adoption.test.js server/test/retired-combat-view.test.js
bun client/tools/build-online.js
```

## Remote players and drops under latency

On **2026-09-16**, the [remote motion check](validation-method.md#remote-player-and-drop-check) used two disposable native browser clients on map **50000**, with **500ms HTTP delay and 250ms per WebSocket direction**. The mover walked/jumped during a **450ms traffic pause**, then created an item through the native development control. The observer sampled the item's flight/hover during a **1.2-second pause**. Both runs reused the same extraction; no competing probes ran.

| Observation | Before | After |
| --- | ---: | ---: |
| Drop moving frames over 180ms after its last changed observed XY | **0** | **26** |
| Drop rendered Y range, landing floor at Y335 | 320–419 (below floor) | **240–324** |
| Maximum drop displacement between sampled frames | 14px | 12px |
| Peer moving frames over 180ms after last changed observed XY | 32 | **64** |
| Maximum peer displacement between sampled frames | 11.402px | **10px** |

The after run passed with no browser errors and both connections ready. Generic foothold projection had pulled flying drops below their floor; the dedicated trajectory now preserves flight and hover during held updates. Native frame counts are diagnostics from two short runs with varying arrival/render timing, not matched FPS or percentage-speedup claims. Both peer runs already met the 20px frame-displacement threshold. Deterministic tests establish the new peer gravity/landing, connected slopes, ladder limits, gradual correction and mode handling rather than inferring those properties from counts alone.

| Measured stage | Before | After |
| --- | ---: | ---: |
| Identity | 1.417s | 1.401s |
| Mover login/readiness | 17.129s | 17.141s |
| Observer login/readiness | 17.674s | 17.619s |
| Peer action/sample | 3.680s | 3.750s |
| Drop action/sample | 4.487s | 4.461s |
| Context teardown | 74ms | 66ms |
| Fixture database/content | 319ms | 288ms |
| Fixture seed | 159ms | 158ms |
| Server startup | 1.213s | 1.078s |
| Frontend startup | 1.484s | 1.436s |
| Browser acquisition | 505ms | 571ms |
| Fixture teardown | 141ms | 126ms |

Stage timings include deliberate waits; nested timings are not summed. These local relay measurements do not establish internet bandwidth, all special movement skills, pickup admission or Windows visual parity.

| Identity | Value |
| --- | --- |
| Baseline browser | `e1f2b8704a1fb7e91229146c13e5afe5fe377bba1112a9c49b25d77c969a6068` |
| Baseline rules | `934aa1e7accc8e55bae900d10d40f3e0b252546632236e914e4c5dccd86a1b8c` |
| Measured after browser | `356708c71eb4b888326814f7e47070bcf8fb6d033d5be9cd2672d5d220410b43` |
| Measured after rules | `dae9fed0101b47b05f9827558f00a5f445fd5eb409f05b8652de68770ddbc632` |
| Final production browser | `1ae28ed89bae4a23bab161e1a937cccf629be60632189b72678ddd316cde15d6` |
| Final production rules | `9c5a6595a58f15149baecc5bd70e62266385c6936cad911e163d5a5014095689` |
| Asset build, both runs | `93fd94109cabeafcaa948e48c86447e4f723d2cc9d3d73a70ca79a625cd3fa27` |
| Catalog, both runs | `5bd1177cb1269b1d8f366451f4cf6c1603652dc76266d83146fa68f4a6d0e0ca` |

After the browser run, explicit relocation was corrected to discard stale velocity/contact and hold its destination until fresh state. Its targeted regression passed; ordinary walk/drop browser actions were not rerun for this separate event path. The final eight affected suites passed **43 tests / 506 assertions** in **1.432s**, including 303 original-equation comparisons across three landing heights, delayed drop clocks/fades, unchanged source observations, remote animation phase, teleport continuation and the compact wire fragment. Changed JavaScript passed Prettier and ESLint with zero warnings. The final guarded production build compiled **964 modules** and three bundles in **1.411s**, including **890ms** packing retained assets; no extraction ran. The documentation checker retains **884 existing missing historical targets** with no missing headings. Raw reports and logs remain outside the repository under the [artifact policy](validation-method.md#artifact-policy).

```sh
bun server/tools/check-remote-motion.js --output /tmp/openms-remote-motion
bun test client/test/remote-presentation.test.js server/test/remote-presentation.test.js client/test/combat-latency.test.js client/test/drop-rotation.test.js client/test/drop-system.test.js server/test/field-drops.test.js client/test/online-protocol.test.js server/test/field-combat.test.js
bun client/tools/build-online.js
```

## Peer move stream and incoming feedback

**Symptom.** At 500 ms ping a peer appeared to float and briefly clip through a platform after a
jump or a rope drop.

**Cause.** Peer membership/appearance rode the ordered `state` frame, which the server
serializes behind an application-level ack (`pendingStateId` in
[publication.js](../server/src/publication.js)). At most one state frame is outstanding, so
that path is bounded by the **round trip**, not by its 90 ms period: the browser received a
new peer position only about twice a second and had to forecast across a full round trip. That
forecast is where the floating and the brief floor penetration came from.

**Correction.** Sampled motion now rides a separate un-acknowledged `peers` frame, the browser
form of the native move packet `0xb6`: one sample per changed peer per 30 ms tick
([world.js](../server/src/world.js) `publishPeerMotions`), applied directly to the drawn actor
([scene.js](../client/src/online/scene.js) `peers`). The ordered `state` frame keeps
membership, appearance and removal, and no longer replays its older sample over a peer the
move stream already owns. `RemoteMotion` interpolates between two authentic 30 ms states and
clamps a landing span to the landed sample's foothold surface.

A deterministic trace tool ([peer-latency-trace.js](../client/tools/peer-latency-trace.js), no
browser, account or database) drives the peer through the real shared kernel over a run, jump,
rope climb and rope drop, delivers samples at a **250 ms one-way** leg and measures the drawn
pose against the true state at the presented content time:

| Sample delivery                                 | Playout | Worst grounded error |
| ----------------------------------------------- | ------: | -------------------: |
| One sample per 90 ms, serialized behind the ack |  192 ms |               14.1 px |
| One sample per 90 ms, un-throttled              |  144 ms |                5.3 px |
| Native move stream, one sample per 30 ms tick   |   60 ms |                5.6 px |

This establishes the reconstruction lag and playout of the presentation path only; it is not a
Windows capture, an internet bandwidth measurement or a claim about every movement controller.

**Incoming feedback.** [local-incoming.js](../client/src/online/local-incoming.js) additionally
resolves the defender's damage digit and authored flinch face at the frame the drawn mob swing
reaches its authored `attackAfter`, against the same authored area and ordinary receiver (`00af14b8`/`00af14c8`)
the authority tests. HP, death, knockback, status and the hit sound remain authoritative; the
confirmed `combat.impact` consumes the prediction by actor so the digit is drawn once, and a
missed or refused outcome is still shown as a correction. This is an OpenMS latency policy,
not a recovered Nexon rule (the original client is server-driven for damage it receives).

```sh
bun test client/test/remote-move-stream.test.js client/test/local-incoming.test.js \
  server/test/remote-presentation.test.js client/test/remote-presentation.test.js \
  client/test/combat-latency.test.js server/test/motion-adoption.test.js
bun client/tools/peer-latency-trace.js --interval 3 --gated   # round-trip-bound path
bun client/tools/peer-latency-trace.js                        # native per-tick move stream
```

Changed files pass Prettier and ESLint. Two pre-existing `client/test/online-skill-motion.test.js`
failures and five pre-existing `server/test/publication.test.js`/lifecycle fixture failures
remain at the baseline commit and are unrelated to this path.

## Combat responsiveness, remote visibility and peer entry

Four reported issues were corrected. Each is a presentation or content-policy change; the
authority still owns admission, HP, death, drops, rewards and durable status.

| Symptom | Cause | Correction |
| --- | --- | --- |
| A new character was offered "skip the tutorials and head straight to Lith Harbor" | The admitted `tutoChatNPC` portal program opens the authored `scripts/npc/2007.js` conversation, whose Yes branch warps to 104000000 | `REMOVED_TUTORIAL_NPCS`/`tutorialNpcOffered` in `npc-script-portals.js`; the portal settles without opening the NPC |
| Damage and the mob's knockback arrived after the swing | The attacker resolved the digit and pose locally but left all displacement to the authority, one round trip later | [local-hits.js](../client/src/online/local-hits.js) integrates the recovered `0066b6fc`/`009bbdfd` recoil profile on the release frame, drawing only `predicted − authoritative` and releasing an unconfirmed prediction |
| A peer's projectile on login appeared to drop over and over | The ordered, acknowledged state frame armed the free-fall forecast while a still-loading actor was frozen in the initial airborne spawn state, so each round trip re-dropped it | The shared-geometry forecast is armed only by the first un-acked move sample ([scene.js](../client/src/online/scene.js) `peers`); before that the held sample has zero velocity |
| Projectiles and buff effects could vanish for a peer | An event-created `skill.visual` could be released by an acknowledged snapshot older than the event, and `OnlineUI.cast` dereferenced a missing local-combat owner | [native-skill-presentation.js](../client/src/online/native-skill-presentation.js) holds an event-created visual for one reconciliation; `cast` uses optional chaining |

Every admitted cast is already broadcast to the whole field — there is no self-only skill
category — so no skill filter was added. The recovered recoil coefficients are ordinary
130 px/s braking at 400 px/s² and strong 300/200, matching the authority's mob step.

```sh
bun test client/test/local-hits.test.js client/test/remote-move-stream.test.js \
  client/test/portal.test.js client/test/skill-projectile-chase.test.js \
  client/test/online-skill-motion.test.js server/test/remote-presentation.test.js
```

The client suite passes **638 tests / 10,095 assertions** with no failures; the two
`online-skill-motion` failures present before this batch were the missing local-combat owner
and are now green. Five pre-existing `publication`/lifecycle fixture failures remain
unrelated. Generated evidence JSON (`docs/ghidra-physics-motion/*.json`,
`docs/ghidra-physics-refinements/*.json`) is produced locally by
`bun client/tools/regenerate-physics-evidence.js` and is not committed.

## Peer drops, projectile flights and contact damage

Three latency artifacts reported at 500 ms RTT, and the optimistic-client policy they follow.

| Symptom | Cause | Correction |
| --- | --- | --- |
| An observer saw only the second half of a peer's item-drop arc | The ack-gated entity frame arrives hundreds of ms after the drop spawns, and the presentation anchored its projection to the authority's already-elapsed age | A drop first seen in `waiting`/`launching` re-seeds the projection at the published origin and keeps its own monotonic clock; a late-join drop still anchors to the authority age |
| A peer's projectile did not match the thrower's | The observer received no flight plan, only acknowledged `position` samples chased over a fixed 90 ms window on a different timeline than the drawn thrower | `skillVisual` publishes `flight: {startX,startY,endX,endY,durationMs,delayMs}` and the observer integrates that line locally; the thrower adopts the authoritative plan and bends onto it |
| Walking into a monster dealt damage only after a round trip | Only authored mob attacks were predicted; `bodyAttack` contact damage was authority-only | [local-incoming.js](../client/src/online/local-incoming.js) resolves contact on the first overlapping drawn frame against the same ordinary receiver, sharing the authority's 1500 ms hit window |

A dedicated investigation confirmed the projectile trajectory math was already identical on both
sides at every 30 ms step when fed the same plan, so no damage or hit rule was changed: the
divergence was entirely the missing plan and the sampling timeline. Generated evidence JSON
stays untracked and is produced by `bun client/tools/regenerate-physics-evidence.js`.

```sh
bun test client/test/remote-presentation.test.js client/test/drop-rotation.test.js \
  client/test/skill-projectile-chase.test.js client/test/local-incoming.test.js \
  client/test/combat-latency.test.js server/test/skill-visual-replay.test.js
bun client/tools/peer-latency-trace.js --interval 3 --gated
```

Client suite: **648 tests, 0 failures**. Server suite: **218 pass / 5 fail / 18 skip**, the same
pre-existing `publication`/lifecycle fixture failures as the baseline. Changed files pass
Prettier and ESLint.

## Local hit feedback and critical eligibility (2026-09-16)

Outgoing and incoming feedback both read an absent `owner.hooks.characterStats` hook in the real online client. Their unit fixtures supplied that hook, hiding the failure. Both now read the live `state.presentation.stats`, and fixtures use that production shape. Incoming contact protection also advanced once per mob instead of once per frame; crowded fields could exhaust it early.

Local release/contact now presents damage digits, pose/expression, sound and provisional recoil before a server reply. A separate shared-kernel continuation supplies the player's drawn recoil without reporting unconfirmed displacement. A source-tagged hit adopts that continuation once; misses, resisted recoil, mismatched vectors, relocation and expiry release it. Multi-line skill confirmations consume each matching prediction once, and the audio and digit consumers share the same reconciliation result. HP, death, drops and statuses remain server-owned. Predicted random damage can differ from the committed amount; these are visual previews, not authoritative damage rolls.

Removed the universal 5% critical chance. Missing stats now mean zero, weapon-compatible learned passives supply their authored chance, and temporary/conditional critical sources retain their own requirements.

```sh
bun test client/test/local-hits.test.js client/test/local-incoming.test.js \
  client/test/local-hit-motion.test.js client/test/physical-damage.test.js \
  client/test/combat-latency.test.js client/test/divert-alignment.test.js \
  server/test/hit-divert-replay.test.js server/test/field-combat.test.js \
  client/test/online-protocol.test.js
bun server/tools/check-combat-latency.js --scope hits --output /tmp/openms-hit-feedback
```

The targeted suite passed **94 tests / 501 assertions**. Native runs use the retained extraction and an isolated database/account/browser at 500 ms RTT. An early outgoing trial showed the local mob reaction after 421 ms (the authored attack release) with replies held for 1200 ms. Two initial contact trials did not establish contact during the hold: an earlier server recoil displaced the player, and a long traffic hold exhausted the bounded prediction lead before the player reached the mob. The scenario now approaches through native movement before holding replies just outside the drawn contact boundary. The original baseline had no local outgoing reaction. These runs are bounded behavior checks, not seeded AI or internet-throughput benchmarks. Reports and raw logs remain outside the repository.


The final native run passed both checks: **437 ms** to the mob's authored local hit frame and **98 ms** to contact feedback after the approach, with all socket replies held for **1200 ms**. That contact roll was a local MISS; an earlier positive contact trial presented recoil after **83 ms** during the same hold. The final browser run recorded no JavaScript errors. Additional setup failures identified a spawn request sent before the authority observed landing and an outgoing attack aimed at a mob that had crossed behind the player. The scenario now waits for server grounding and aims from two observed positions before attacking.

| Final run stage | Milliseconds |
| --- | ---: |
| Content/database setup | 316 |
| Account seed | 189 |
| Server startup | 1127 |
| Frontend startup/build | 1472 |
| Browser acquisition | 487 |
| Identity read | 1418 |
| Login/readiness | 24417 |
| Native spawn | 2237 |
| Outgoing exercise | 2283 |
| Approach/contact exercise | 6116 |
| Browser / fixture teardown | 23 / 150 |

Extraction was reused. The separate nonpublishing browser build passed its authority-boundary guard (**969 modules**). JavaScript formatting/lint passed. The documentation checker still reports **881 existing missing targets**, with no heading failures; generated evidence was not added to repair historical links.

Final native source build: `cbbd776c52b8d5c0236df0f655ad79fb09167298ce24c7a3f924056842c84bf8`; rules: `97170e96c871e40c535af16328573c3b707a100a0d4bed81ff58dbe473b0fcce`. Shared retained catalog: `bf4d12c856304ed77c55a1296dcd7bf82d11f2bea505e111c517ae1b1e482af4`; asset build: `11be20f84c507b5d85eba2fbdbd91f06c6b591922b11bad32ad0d02d3a16a939`. Baseline source build: `ea50fbc3018755b0fb608bbe4bcc7e7e1fabb80d99d372767de515191abe86aa`; rules: `79f202d4737a3764323a4be42fe85f4973a2e8a628cbe634359fb322263ad078`. No conversion was performed. Deploying the runtime/protocol change requires rebuilding/restarting client and server together.
