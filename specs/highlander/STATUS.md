# Highlander support: status

State on 2026-10-18, after the final verification (contract 14.3). Every contract task is done. The orchestrator's `hl/merge-w3` holds wave 3 (X2, H1, DOCS), contract v2.4 and the first round of final-verification fixes (`hl/fix-parser`, `hl/fix-state`, `hl/fix-hud`, `hl/fix-leaks`, `hl/fix-scripts`, merged up to `2d584cc`). The second round (`hl/fix-ticksync`, `hl/fix-hudlayout`, `hl/fix-converter`, `hl/fix-misc` and this documentation branch `hl/docs-final`) branches from `2d584cc`. The intended final state is that the orchestrator merges those five into `hl/merge-w3` and fast-forwards `highlander` to it, so **`highlander` = `hl/merge-w3` after the final fixes**; this file and `AGENTS.md` describe that tree. When this was written, `highlander` itself still pointed at `b6688f4`. In `../dribble-parser`, `highlander` is at `41fe9f3`, and `src/libs/hlextras` is built from `hl/fix-parser` `dd178d2`, one commit on top of it that the final state takes in as a fast-forward. `contract.md` (version 2.4, whose section 14 overrides older text) is the binding plan, and `AGENTS.md` at the repo root has the operational notes: commands, settings, probes and gotchas.

## Overview

dribble.tf now shows the class mechanics of Highlander (9v9) SourceTV demos, with a 9v9 HUD and the 11 maps the 133 local demos use (pl_vigil 65 demos, koth_ashville and koth_product 19 each, pl_upward 11, the other seven 2 to 5). It does this without TF2 game assets. Buildings, viewmodels, kits, lockers, the payload cart and every projectile the base viewer had no model for are procedural placeholder geometry, and the maps come from the BSP files themselves.

What a viewer sees today:

- **Players and spies**: cloak fades with the TF2 timing and a readable floor, the decloak ring and tag, disguises in the spectator, enemy or POV player's view, uber, Quick-Fix, Vaccinator, Bonk, crit, minicrit, soldier-buff, burning, bleeding, jar, gas, marked and stun effects, crouching, the held weapon's kill icon on the nameplate, and MEDIC! calls.
- **Engineers**: sentries at levels 1 to 3 and minis with calibrated aim, dispensers with beams to the players they heal, teleporters, sappers, the wrangler shield, construction, upgrades, carried buildings, blueprints and destruction.
- **Combat**: every projectile type, including the ones the base parser drops, with crit glows, deflects, explosions from the game's own explosion events, hitscan pellets, sentry tracers, flamethrower cones, airblast, muzzle flashes, syringes and landed crossbow bolts.
- **POV**: the TF2 FOV with zoom transitions, a scope overlay with charge, class eye heights, placeholder viewmodels driven by fire, reload and animation events, a weapon HUD (ammo, uber, cloak, disguise, stickies, rage, the engineer's buildings), sniper and wrangler dots and beams, a death camera on the killer, then the spectated teammate, and a chase camera.
- **HUD**: an objective panel for KOTH, payload, control points, tug of war and the stopwatch state, team names and games won, a round banner, 9v9 player columns with class, health, respawn time and status badges, a medic panel with uber advantage, a Tab scoreboard, killfeed crit, headshot, backstab, domination and objective lines with Dead Ringer fakes hidden, and timeline markers with `[` and `]`.
- **Maps**: 10 Highlander maps converted from their BSPs with baked lightmaps and the props that ship inside the map files, plus `koth_product_final`'s older textured model. Doors, gates and trains move, kits vanish and return with a respawn ring, thrown lunchbox items fly, and deaths leave a marker.

How to use it:

1. Open a SourceTV demo as before: a file, drag and drop, `?demo=<demos.tf id>` or `?demoUrl=<url>`. The base parse runs first; the Highlander data parses afterwards in the background, in about 1 s on an 800 s demo and 2.7 s on the 130k-tick 1429417. "Highlander data NN %" shows at the bottom left while it loads.
2. The Settings panel has a "Highlander" section: the master switch, an effects preset, and toggles for every group. The switch decides at demo load whether the Highlander data parses, while the HUD and the layers follow it at once. `AGENTS.md` lists every key with its default.
3. Keys: `V` viewmodel, `I` disguise view, `4` chase camera, `[` and `]` timeline markers, hold `Tab` for the scoreboard; `1`, `2` and `3` still switch to POV, spectator and RTS.

How it works: the committed base parser (`src/libs/parser2`) still drives the base viewer. A second wasm module (`src/libs/hlextras`, built from `../dribble-parser` branch `highlander`) parses the same file again in its own worker, with the base parse's start tick, tick base and player list as input, so its data lines up with the base caches by construction. A 16-sample alignment check guards it. Scene layers and HUD widgets in `src/highlander/` draw from that data and from the base caches as pure functions of the tick, so seeking and shared `?tick=` links reproduce the same picture.

## Tasks

| task | branch and tip | merged in | state |
|---|---|---|---|
| step 0 | `598e328` on `highlander` | | done |
| step 0.3 base viewer on the two longest demos | measurement at `598e328` | | done: both load and play (1437285 26.1 fps, 1432698 32.1 fps); see Performance and memory |
| S0 scaffold | `hl/s0` `61e6ece` | `c50bc38` | done |
| P1 extras parser | `hl/p1` `41f6699`; parser `hl/p1-extras` `1a8f2f9` | `4572bdc` | done |
| M1 maps | `hl/m1` `f67809d` | `fce10b5` | done |
| B1 base-parse fallback | `hl/b1` `15c2168`; parser `hl/b1-fallback` `96deea0` | `c38c13a` | done |
| F1 conditions and spy | `hl/f1` `4e32136` | `5e01757` | done |
| F2 buildings | `hl/f2` `ed78b1b` | `883a666` | done |
| F3 projectiles and combat FX | `hl/f3` `99c62ae` | `5006c75` | done |
| F4 sniper, POV, viewmodels | `hl/f4` `827a796` | `63c787c` | done |
| F5 objectives and HUD | `hl/f5` `82b897b` | `b954df3` | done |
| F6 map dynamics | `hl/f6` `bb8fe2f` | `cc74311` | done |
| M2 PAK static props | `hl/m2` `4aed659` | `0ac066d` | done |
| B2 delayed-start fallback | `hl/b2` `f9a0ded` | `460726e` | done |
| P2 parser data follow-ups | `hl/p2` `4abf03d`; parser `hl/p2` `41fe9f3` | `24f60b0` | done |
| X1 integration and performance | `hl/x1` `5b6b066` | `ab4f613` | done |
| X2 base projectile memory | `hl/x2` `308ffba` | `f51f0c0` on `hl/merge-w3` | done |
| H1 harness in the repo | `hl/h1` `9acf271` | `73a8412` on `hl/merge-w3` | done; not a contract task |
| DOCS | `hl/docs` `2b6166d` | `1ced433` on `hl/merge-w3` | done: this file and `AGENTS.md` |
| final verification (contract 14.3) | review dimensions, gap review and two fix rounds; see "Final verification" | first round `612c432` to `2d584cc` on `hl/merge-w3`; second round merged by the orchestrator | done |

An independent review checked every task, and its findings were fixed or recorded before the merge. Before every merge the orchestrator ran `npm run build`, tsc (only the 10 pre-existing errors allowed) and the 15-shot baseline plan on 1438891, and each task's report covered its acceptance list plus, where they applied, Highlander off, extras unavailable, the 6v6 sample and seeking to the same tick twice. The orchestrator recorded the accepted deviations in the contract: section 11.1 (rows A1 to A11) after the foundation, 12.1 after wave 1, 13.1 after wave 2 and 14.1 after wave 3. The final verification's own deviations are listed under "Final verification" below; the contract has no rows for them yet.

### S0 scaffold

- **Built**: the shared modules `constants.ts`, `settings.ts`, `extras/types.ts`, `enums.ts`, `track.ts`, `hooks.ts`, `items.ts`, `debug.ts`, the actor registry, `useActorFx`, eye heights, the scene and HUD roots, `ExtrasNotice`, the settings section and stubs for every later task. Shared edits: the store and loading flow (sections 3.3 and 3.4), the base parser additions (duck cache, `startTick`, `tickBase`, `positionScale`, the file buffer handed back by the worker, the worker ended after the parse), the debug bridge `hl` object with `waitReady` and `cameraNear`, actors keyed by entity id, the new keys, the crosshair hidden while scoped, `public/draco/` with a global decoder path, and the "09:60" clock fix.
- **Acceptance**: build and tsc clean; the baseline changed only where intended (POV eye heights, the clock, actors keyed by entity id); Highlander off, the 6v6 sample, a disconnect check and determinism passed. Ending the base worker after the parse cut the harness page memory at load from about 1330 MB to about 1010 MB.
- **Accepted deviations**: 11.1 A1 (`lerpField` takes any numeric array), A2 (`DEFAULT_ACTOR_FX` uses class 0 and team `''` for "the base actor"), A3 (`actors.registry` reports `modelVisible`), A4 (only a camera named `povCamera` under an actor group counts as an actor's own POV camera).

### P1 extras parser and data layer

- **Built**: in the parser, `src/extras/` (entity tracking with dormancy and instance identity, change-list tracks, one module per output group, the capture-progress simulation, parented transforms, group-by-group conversion to JS), the wasm exports `parse_demo_extras`, `ExtrasInput` and `parse_demo_extras_input`, and the native runner `hl_extras`. In the frontend: `ExtrasWorker.ts`, `loadExtras.ts`, `hydrate.ts`, `alignment.ts`, the memory plan, every getter, `findTicks`, the probes, `scripts/hl/check-extras.mjs`, `base-values.mjs` and the expectation files.
- **Acceptance**: 61 of 61 native acceptance checks; the native `--self-check` passed on 1434434, 1438891, 1440442, 1428628, 1432698, 1437285, 1433815 and the 6v6 sample (1429417 had no base timeline until B1); a survey of all 133 demos in 247 s with 0 errors. In the Node checker: 1434434 parses in 302 ms into 3.35 MB of typed arrays (limits 3 s and 8 MB), 1438891 in 922 ms into 9.88 MB (limits 7 s and 25 MB), 1429417 in 2.4 s into 39.2 MB with a VmHWM of 322 MB. The peak fit is `1.6 x fileMB + 126` MiB. In the browser 1438891's extras take 1.1 s with a 77.5 MB wasm heap. The output is deterministic.
- **Accepted deviations**: 11.1 A5 (`eyeZAt` is null while observing, without local tables and below 20 units), A6 (`findTicks('capping')` returns crossings of 0.5; `uber` means a stock or unknown Medi Gun), A7 (`available.carts` needs train watchers), A8 (local-only values dropped per player whose local tables never update; `hasLocalTables`), A9 (checker memory limit `max(2.6 x fileMB + 100, 140)` MB).
- **Not done**: the per-group size caps of section 2.8 are exceeded for movers, drops and buildings on long cp_steel and tow_tetsudo demos (no lossy compression); rare kinds without a local demo stay unvalidated (see Known limits). Scoring element 0 holds the match totals on every measured demo; 1434434 and the 6v6 sample tie and get a warning.

### M1 maps

- **Built**: converter changes (initially hidden brush entities keep their geometry, `--only-meta`, the shared-sky rule), the 10 converted maps with lightmaps, visibility, `map-meta.json` and the PAK skies, and in the app `mapAssets.ts` (folder lookup, one cached `conversion.json` per folder, an `index.html` answer counts as absent), the bsp-to-glb path in `World.tsx` (meshopt, lightmap atlas, shared materials in `bspMaterials.ts`, `mapNodes`, `mapStatus`, fog, brightness), the sun direction in `Lights.tsx`, the folder and sky mappings, the tow_tetsudo boundary override, converter cameras with a median-player fallback, `MapNotice`, `mapMeta.ts` and `mapNodes.ts`.
- **Acceptance**: all 10 maps load with `mapStatus` ready, without alerts or page errors; tow_tetsudo uses the BSP bounds; the floating-object cases are recorded in `AGENTS.md`; the vigil RTS view runs at 60.2 fps paused at 1600x900 with 82 draw calls; vigil's `mapNodes` include the cart train (`bspModelIndex` 1); koth_product keeps its textured model with `gameMode` koth. A map converts in 6 to 13 s; the maps take about 26 MB plus 3.7 MB of skies.
- **Accepted deviations**: 11.1 A10 (`--only-meta` also runs the render pass), A11 (a shared sky folder is never replaced silently; the map's own faces go to `<sky>_<map>/`).
- **Not done**: in-browser `.bsp` conversion (D6, deferred); chunk and PVS culling stay off on bsp-to-glb maps; the converter edits no code, so every new folder needs hand-written `MAP_NAME_SEARCH_MAP` and `MAP_SKYBOX_MAP` entries in `src/constants/mappings.ts`, and it prints a hint only for a `<sky>_<map>` sky folder (no map needs one today).

### M2 PAK static props

- **Built**: `scripts/lib/static-props.mjs` and the props pass of `convert-bsp.mjs`, nine `props.glb` files (warmtic ships no PAK props), `src/highlander/map/StaticProps.tsx`, the `map.staticProps` setting and the `map.props` and `map.propInstances` probes.
- **Acceptance**: vigil draws 88 PAK instances, and its rock skirt closes the island edge that is open without them (10.2 % of the south RTS view); tetsudo (475), ashville (204) and proot (57) render theirs; the vigil RTS default view runs at 60.2 fps with 90 draw calls and tetsudo's at 60.2 fps with 256 calls and 977k triangles; drawn-triangle winding agreement is 96.8 to 100 %; a full reconversion reproduces every committed file byte for byte. The `props.glb` files total 11.3 MB.
- **Accepted deviations**: the 12.1 M2 row (counts without the 3D-skybox copies, meshes per model, skin, sun cluster and lighting pattern plus one merged batch, the alpha rule, untextured mode keeps the props' unlit material, the 90 % winding gate).
- **Not done**: stock props stay invisible (D1, D7); PAK props inside the 3D skybox are skipped (vigil 6, proot 139); the sprp fade distances and coarser VTX LODs are ignored; 74 tetsudo instances keep a shared lighting pattern (baking all would need about 560k vertices and 4 MB more); props without VRAD lighting borrow a neighbour's (tetsudo 129, ashville's 38 ground lights, eruption's 54 rocks); named, parented, disabled or animated `prop_dynamic` entities are skipped (ashville 16, vigil 2, eruption 2, tetsudo 7); untextured mode shows the props with their baked light.

### F1 player conditions and spy

- **Built**: `useActorFx` with cloak opacity `max(1 - inv, cloakFloor)`, the four disguise views, one tint by priority, crouch scale 0.756 and the nameplate extras (weapon icon, disguise badge, cloak and shield bars, tags, pinned plates); `PlayerFxLayer` overlays per actor (Quick-Fix ring, Vaccinator shells, Bonk, crit aura with orbiters, soldier-buff ring, flames, drips, marked skull, stun stars, overheal, teleport ring, disguise smoke, decloak ring); probes `fx.actor`, `fx.overlays`, `fx.plates`, `fx.frameCache`.
- **Acceptance**: on 1438891 the first five normal cloaks read 0.42 to 0.45 at onset + 33 ticks and 0.95 at + 80, decloaks 0.5125 to 0.535 at + 66 and 0 at + 140, and the rendered opacity matches the formula; Pooper's scout disguise on 1434434 shows as a BLU scout from a BLU POV through 'auto'; crouch scales 0.7561; a revved heavy shows REV; screenshots of a cloaked spy, the decloak ring, uber shells, kritz orbiters, burning and stun. Partial: one Dead Ringer cloak (MaGe at cache tick 1590) reads 0.91 at its onset, because the data puts its completion 6 ticks later.
- **Accepted deviations**: the three 12.1 F1 rows (uber fading tested before uber, flame shape and stun-star and drip placement, the skull as a tag glyph, `teamOverride`, the forced-'pov' fallback, the game-accurate hiding rules, rage tags, the extra probes).
- **Not done**: jarate, milk and Quick-Fix visuals exist only as synthetic shots; Vaccinator blast and fire shells and the minicrit aura are unvalidated; a decloak seen through an enemy's eyes is validated by probe data only.

### F2 engineer buildings

- **Built**: the public model `buildingsAt` and `buildingsOf`, pure draw state in `render.ts`, the layer with sentries (levels 1 to 3 and minis), dispensers, teleporters, sappers, the wrangler shield, upgrade ring, status labels, range ring, carry box and badge, blueprints, destruction blasts and dispenser beams, the sentry aim calibration, and `sentryMuzzleAt`, `tracerBarrel`, `poseAimAt` and `povLabelContext` for other layers.
- **Acceptance**: 29 sentries and 13 sappers on 1438891; sentry 451 builds from 0.0118 to 1 in 10.44 s with level pips at each upgrade and hides while carried; vigil's two cart dispensers are flagged map-placed and never drawn; the drawn barrel is within 15 degrees of the enemy on 80.1 % of attacking samples (wrangled and other skipped states excluded) and 99.8 % of firing samples, with R^2 0.998 for yaw and 0.974 for pitch; in POV the subject's own labels hide while the weapon HUD lists them.
- **Accepted deviations**: the two 12.1 F2 rows (the fit on firing samples and the 80 % metric, the 62 x 26 label quad kept 80 to 130 px wide, POV label rules, the range-ring band, beam width, the fireball flash, the extra carry badge, cap stripe and sapped screen).
- **Not done**: on the contract's literal sample set, wrangled samples included, the aim metric is 78.8 %; `AIM_AT_ENEMY` stays false.

### F3 projectiles and combat effects

- **Built**: the source split `getProjectileSource`, `ProjectilesExtraLayer` (one instanced mesh per placeholder part, sample-based ribbons), `CombatFxLayer` (explosion bursts and scorches from `TETFExplosion` events, building explosions, hitscan tracers with TF2's fixed spread pattern, sentry tracers, flame cones, airblast, deflect flashes and rings, muzzle flashes, syringes with streaks, crit glows), the extras mode of `Projectiles.tsx` (positions, glows, rings, trails and smoke from the extras samples), landed healing bolts and the probes.
- **Acceptance**: the alive set equals the extras tables on 20 of 20 ticks; 0 mismatches between the base types and the extras kinds on 7 demos; crit glows sit 0 units from their meshes over 68 frames of playback; trails are identical after seeking from either side; explosions off removes both sources; syringes on 1441640 read clearly; no wall-clock code in effects.
- **Accepted deviations**: the 12.1 F3 row, deviations 1 to 12 of the F3 report.
- **Not done**: cannonballs exist only on 1428628 and were not shown; jarate, milk, cleaver, stun ball, Short Circuit orb and energy-ring tempents have no local demo; a bolt stuck in a player who dies disappears instead of moving to the ragdoll; about 10 % of world-hit bolts sit partly inside the wall.

### F4 sniper, POV and viewmodels

- **Built**: the POV subject with the dead-POV policy (D16), chase and death cameras, the TF2 FOV (`povFovAt`) with near plane 1, the POV medic beam, `ViewmodelLayer` with the depth-clear render order, viewmodel FOV, left-handed mirror and minimal offset, the placeholder provider (one builder per item kind, 39 weapons) with data-driven draw, fire, reload, swing, spin, flame, charge and watch animations, `SniperLayer`, `ScopeOverlay`, `PovWeaponHud`, class eye heights and the Linux pointer-lock fallback.
- **Acceptance**: at zoom + 25 the FOV is 20 horizontal (15.07 vertical), the scope shows and the viewmodel hides, and at unzoom + 3 it reads 49.77; the base crosshair is gone at the zoom tick; one POV shot per class and team at tick 30000; the kick reads 0.875 one tick after a fire event; eye heights 65, 75 and 45 ducked; no `NotSupportedError` in spectator mode; 0 wrong killers over all 211 deaths of 1438891 (41,197 samples); clip reloads animate (27 of 27 pistol, 38 of 40 revolver events); the depth clear keeps the viewmodel whole against walls.
- **Accepted deviations**: the 12.1 F4 row, deviations 1 to 11 of the F4 report.
- **Not done**: the left-handed mirror is checked only through `viewmodel.debug` (no player on 1438891 is left-handed); bow draw and crossbow states are unvalidated on demo data; the chase camera has no wall collision; a sentry kill's death camera aims at the engineer.

### F5 objectives and HUD

- **Built**: one shared HUD snapshot per `hudTick`, the objective HUD for KOTH, payload, control points and tug of war with the stopwatch line, the team header with games won, the round banner, the scoreboard, 9v9 player columns with badges, hover text and click-to-POV, the medic panel, the killfeed upgrades, the match feed panel with its chips, timeline markers in four categories with `[` and `]`, the TICK and jump-to-tick fix, and scene markers for the cart, push zone, track and control points.
- **Acceptance**: KOTH clocks and side switches are right at all 10 captures of 1438891, with overtime from tick 52088; the payload bar equals the cart watcher, with checkpoints at 0.251, 0.451 and 0.718; the full stopwatch game on 1433441 shows the banked line, the side swap, the points to beat and games won, and the `STOPWATCH_WINNER` rule held on 1433441, 1440442, 1439994 and 1440048; scoreboard K and D at the last tick match the base deaths minus 24 feigns; no feign line in the killfeed; no layout overlap; 90 snapshot computes over 267 ticks at 1x; 58.1 fps at tick 21000 against the 33 fps baseline, with the killfeed rows at 0 % self time.
- **Accepted deviations**: the 12.1 F5 row (OVERTIME hidden while waiting for players, the two-line medic panel).
- **Not done**: two medics on one team never happen in the local demos and were checked only with a synthetic render. The previous-point padlocks, missing at the merge, came with P2, and X1 checked the building badges against F2's data.

### F6 map dynamics

- **Built**: brush movers with the render-mode-10 rule, prop-door slabs, resupply lockers, kits with a floor analysis and respawn rings, death markers, drops and the `mapdyn.*` probes.
- **Acceptance**: mover instances with a BSP model find their node on vigil (140 of 140), steel (799 of 800), divulgence (245 of 252) and ashville (340 of 340); vigil's setup gates move at `setupFinished`; kits vanish, fill their ring (0.4993 halfway) and return; koth_product shows no movers and no errors; seeking is deterministic down to the instanced buffers.
- **Accepted deviations**: the 12.1 F6 row, items (a) to (i), and tetsudo's mover coverage of 94.74 % (two static `trigger_catapult` brushes; every changing mover is covered).
- **Not done**: kits that players drop, such as the Candy Cane's, have no local demo; death markers of deaths on an undrawn stock prop sit on the prop's top.

### B1 base-parse fallback

- **Built**: the wasm export `parse_demo_cache_fallback` in the parser, the no-timeline route in `ParseWorker.ts` and `AsyncParser.ts`, `parsedDemo.parserFallback` and `parserFallbackInfo`, `scripts/hl/fallback-values.mjs`, `check-fallback.mjs` and `parser2-survey.mjs`.
- **Acceptance**: 1429417 (tow_tetsudo, 130k ticks) loads with 19 players and 18 actors instead of an empty map; its 476 respawns land on the map's spawn points (median 0.56 units off in XY and 0.13 in height), so the fallback's offset is exact; the extras align 244 of 244; seeking is deterministic; every other demo's base cache is byte-identical to before; the 133-demo survey found 1429417 as the only demo parser2 cannot start.
- **Accepted deviations**: the 12.1 B1 row. B1's route ignores the Highlander switch.

### X1 integration and performance

- **Built**: sentry tracers from F2's drawn barrel, the POV subject's hitscan tracers from F4's viewmodel muzzle (`integration/ownMuzzle.ts`), the teammate-death camera (`PovSubject.deathOfEntityId`, decision 12.2 item 1), `fetchMapMeta` gated on `files.meta` with `isCachedMapConversion`, render-path memos, the dropped projectile scans, one settings selector per actor, the 12-plate nameplate declutter, and memory-audit fixes in `viewmodel/input.ts` and `PovLayer.tsx`. `Crosshair` stays unmemoized.
- **Acceptance**: with every Highlander setting on, 1438891 at tick 21000 runs at 58.0 fps (60.0 with Highlander off, 48.9 before X1); 1433441 runs at 59.3 fps at 1x and 59.1 at 2x; paused 60.2 everywhere; browser PSS on 1438891 is 1249 MB against 1535 MB before Highlander; the long demos 1437285 and 1432698 run at 59.0 and 59.9 fps with peaks of 1566 and 1570 MB; the teammate-death camera covers 3614 samples with 0 wrong killers; 502 of 502 sentry tracers start at the barrel; a disguised spy keeps his badge from 2985 units away.
- **Accepted deviations**: the three 13.1 X1 rows (the declutter rule, `fetchMapMeta` and the `isCachedMapConversion` export, and the items left undone).
- **Not done**: crit hitscan tracers look like normal ones; the sentry-kill death camera; the shader compile on a player model's first appearance (one 120 to 133 ms long task); an overlap-aware declutter would need a contract change. X1 also found that `src/pages/ViewerPage.tsx`'s `loadingDownloads` selector re-rendered the page every tick, about 2.4 % of main-thread time; X2 fixed it (`0a43c15`).

### P2 parser data follow-ups

- **Built**: an xform track for pickups that move, the plate rule with small chocolate, banana and fishcake plates, the previous control points (`prevRed`, `prevBlu`, `baseRed`, `baseBlu`, `miniRounds`), the matching getters, `pointLockedAt` with TF2's `TeamMayCapturePoint`, thrown and dropped items drawn along their track and at rest, a cleaner `pickupTaken`, 12 expectation files, and `src/libs/hlextras` rebuilt with `parse_demo_cache_fallback` kept.
- **Acceptance**: a thrown Sandvich on 1434434 has 32 xform entries and rests 0.12 units above the floor; cp_steel's B, C and D stay padlocked until the capture each waits on; the exported previous points match the BSP keyvalues on 6 maps, and an independent port of the lock rule agreed on 7284 samples; every unchanged group is byte-identical on 1434434 and the 6v6 sample; the checker passes on 12 demos; extras time and memory stay within 2.2 %.
- **Accepted deviations**: the two 13.1 P2 rows: behaviour changes 1 to 9 (5CP padlocks on the 6v6 sample, the KOTH padlock while waiting for players, thrown items resting on their box bottom and hidden within 40 units of the POV camera, and so on) and the unvalidated cases.
- **Not done**: dropped kit-model items and the arena branch of the lock rule have no local demo; a disguised spy at full health who takes a thrown item fires no `item_pickup`, so that take has no taker.

### B2 delayed-start fallback

- **Built**: the delayed-start route (`DELAYED_START_FALLBACK_SECONDS` = 5 after the tick of the demo's 100th frame), `demoWarmup` and `delayedStartOf`, a parser2 retry with `{ lateStart: true }` when the fallback of a delayed start fails, progress that never falls back, and the scripts `parser2-survey.mjs --parser2`, `parser2-start.mjs`, `check-delayed-start.mjs`, `check-delayed-trigger.mjs` and `check-parse-routes.mjs`.
- **Acceptance**: the survey ran parser2 on all 133 demos; 131 start exactly at the warmup end, 1428628 starts 55.17 s after it and 1429417 never. On 1428628 the fallback covers cache ticks 0 to 94284 with no empty tail; its positions match parser2's within quantization after parser2's constant +1/32 in x, over 1,720,402 samples; the extras align 241 of 241; the page peaks at 1464 MB, against 1437 MB before B2. Every other demo's cache is byte-identical.
- **Accepted deviations**: the 13.1 B2 row: (a) the route ignores the Highlander switch, so with Highlander off 1428628 loads from demo tick 94 with the fork's cache and contract 7.4 does not hold for it; (b) on 1428628 a moment's cache tick moved by +3678, so `?tick=` links and bookmarks saved before B2 point 55.2 s earlier; (c) a failed delayed-start fallback loads parser2's late timeline.
- **Done later**: `hl/fix-scripts` (`869c2c7`) made `fallback-values.mjs` run the viewer's own `delayedStartOf` and pick bounds in the viewer's order, so it and `check-fallback.mjs` mirror both triggers and the late-start hand-back; `check-fallback.mjs` prints the route and takes `--expect-route` and `--tmp`. The late-start branch has no local demo; `check-parse-routes.mjs --fail-fallback` covers the viewer side.
- **Not done**: parser2's empty tails after pauses or on cut files are unchanged; a crash of the fallback worker itself still fails the load, because its file buffer was transferred.

### X2 base projectile memory

- **Built**: `src/highlander/memory/projectileAdapter.ts`, an exact sparse copy of the base projectile rows, and `projectileMemory.ts`, which schedules the release, runs it and registers six `memory.*` probes. `AsyncParser` gains `projectileReader()`, `releaseProjectileCache(replacement)` and `projectileCacheReleased`; `ProjectileCache.ts` gains the `ProjectileReader` interface and `getTypeCode`; F3's `getProjectileSource` reads through the reader; `?hlProjectileRelease=manual` defers the release to the `memory.release` probe. Two fixes ride along in commits of their own: `ProjectileModel` re-clones its GLB when the model changes (`e2b1c33`), and `ViewerPage` selects the downloads Map instead of building a new array on every store update (`0a43c15`), which cut ViewerPage's renders in 10 s of 1x playback from 598 to 0 and DemoViewer's from 1195 to 599. `AGENTS.md` "Base projectile release" describes how it works.
- **Readers of the base projectile cache**: DemoViewer's projectile block (`getProjectilesAtTick` at the render tick and the next one) and F3's `getProjectileSource` read through `projectileReader()`. `Projectiles.tsx`, `ProjectilesExtraLayer`, `CombatFxLayer`, the combat probes and the memory probes reach the base rows only through those two. `ParseWorker` writes the cache, `landing.ts` reads only the player cache, and the Node scripts in `scripts/hl/` read wasm results and never release. Analysis, drawing, export and the debug bridge never read it, so no reader has to keep the cache.
- **Acceptance**: a Node check compared the adapter with the cache at every tick and slot on 1434434, 1438891 and the 6v6 sample (parser2, `positionScale` 1024) and on 1429417 and 1428628 (fallback, 32): 0 differences over 1.6 to 27.9 million slot lookups, no row outside a served instance and no type changed. In the browser, the same page before and after the release gave identical rows, drawn groups, `projectiles.at` and trails, and the same `memory.digest` over the whole demo: on 1438891 at ticks 21896, 4627, 30043 and 24907, on 1429417 at 57672 and 111601, and on 1428628 at 9645 and 6754. The pixel differences were the FPS digits, animated heal beams and a one-off 0.007 % highlight in a crit glow at 1438891 tick 24907 that six reruns did not show. After the release, Highlander off at runtime, an extras restart and a forced extras error drew the same rows (0 to 0.003 % of pixels). With Highlander off at load, Highlander switched off before the release, `?hlExtrasBudget=1` or `projectiles` excluded, the cache stayed, and the rows and projectile meshes equalled `b6688f4`'s. Seeking to the same tick from 300 ticks before and after gave identical probe output on 1438891, 1429417, 1428628 and the 6v6 sample. Page memory fell by 201 MB on 1438891, 638 MB on 1429417 and 505 MB on the 2041 s 1437285 (see Performance and memory). The automatic release costs 19 to 34 ms while a demo plays and runs as its own task; before the review it took 69 to 142 ms inside the task that made the extras ready. With every setting on, 1438891 at tick 21000 ran at 59.3 and 59.1 fps against 58.7 and 57.5 for `b6688f4` in the same session. The baseline plan matched `b6688f4` apart from heal beams and the FPS digits, with 0 console errors, and a DOCS run of the merged `hl/merge-w3` tree through the repo harness gave the same result (`compare-runs` exit 0). Build and tsc pass with the 10 known errors.
- **Deviations**: recorded in contract 14.1. X2 also changed two lines of F3's `combat/projectileSource.ts`, and item 5 goes beyond "the data source only" in `Projectiles.tsx`; its report lists both as out-of-scope edits.
  1. D13 says X2 "serves the base types from extras". The adapter instead copies the base rows exactly, raw fixed-point values plus the bucket team and type, decoded with the cache's own scales, and groups them by F3's served instances with the type from `baseType[j]`. Extras samples cannot feed the legacy path that draws with Highlander off or after a later extras error, and 13.4 requires both to stay unchanged.
  2. The method is `releaseProjectileCache(replacement: ProjectileReader): number`, not `releaseProjectileCache()`.
  3. `AsyncParser` gains `projectileReader()` and `projectileCacheReleased`, and `getProjectilesAtTick` and F3's `getProjectileSource` read through the reader. The rule: read base projectiles only through those two, never through `projectileCache`.
  4. `ProjectileCache.ts` exports `ProjectileTypeMap` and the `ProjectileReader` interface.
  5. `e2b1c33` changes rendering with Highlander off, which rule 7.4 forbids. It fixes a D12 bug that `b6688f4` has too: on 1429417, a seek from tick 57372 to 57672 drew the BLU crit sticky 722 with the RED model. The reviewer recommended keeping it.
  6. The automatic release waits for an idle period of at most 2 s instead of running inside the task that made the extras ready, and the `memory.release` probe stays synchronous. The rows served are the same before and after, so the bound is scheduling, not effect logic.
  7. The `ViewerPage` selector fix, which 13.4 allows.
- **Done later**: contract 14.1 records the deviations above. `hl/fix-scripts` (`2a9a882`, `834d37a`) ported the all-tick check to `scripts/hl/check-adapter.mjs`, with the planted-error step of `compare-builds.mjs`; `compare-builds.mjs` itself, which compared against a one-off old copy of the adapter, was not ported, and `check-adapter --root <older checkout>` takes its place. It passed on 1434434, 1438891, the 6v6 sample, 1428628 and 1429417 with 0 differences.
- **Not done**: in X2's runs headless Chromium found no idle period while the canvas rendered, so the release ran at the 2 s bound (a paused DOCS run on 1434434 released after 1.5 s); desktop browsers were not measured. The crit-glow highlight at 1438891 tick 24907 was not investigated. The long demo 1432698 was not run (1437285 was), and the extras restart and error cases ran on 1438891 and the 6v6 sample only. Pre-existing and outside X2: the legacy projectile path smooths on frame time, so its pixels are not deterministic, and `DemoDrawing.tsx` still renders about 179 times per second during playback through its own subscriptions.

### H1 harness in the repo

H1 is a wave-3 task outside the contract's task list. It moves the harness that every task ran from the session scratchpad into the repo, so it outlives the session.

- **Built**: `scripts/hl/harness/` with `shot.mjs`, `build-child.mjs`, `summarize.mjs` (a Node port of the merge runs' `summ.py`), `lib/setup.mjs` (checkout, lock, playwright-core and browser lookup), `lib/images.mjs` (the pixel diff), `plans/1438891-baseline.json`, `plans/smoke-gen.mjs`, `tools/` (`compare-runs.mjs`, `imgdiff.mjs`, `sheet.mjs`, `gpu-probe.mjs` and four base-parser stats tools), `README.md`, and a `package.json` that pins playwright-core 1.64.0 for that folder only. `.gitignore` gains `/scripts/hl/harness/node_modules`. Two commits: `f7e59ee` and the review fixes `9acf271`. `AGENTS.md` "Highlander validation tools" has the commands.
- **Changes from the session copy**: every path resolves from the checkout that holds the script, so `--root` defaults to it. The lock is `--lock`, `DRIBBLE_HARNESS_LOCK` or `<os.tmpdir()>/dribble-heavy.lock`, and an ancestor `flock` counts only when flock's own lock argument is the same file by inode; the old check matched any argument ending in `heavy.lock`. The build cache is `--build-cache`, `DRIBBLE_HARNESS_BUILDS` or `<root>/node_modules/.cache/dribble-harness`, `--out` defaults to a folder next to the checkout, and the browser is auto-detected, the revision playwright-core expects first. New: `--check`, `--init-script` (what B2's private copy did with `B2_INIT_SCRIPT`), `--min-available`, `--wait-available` and `-h`. Bad options, ticks, modes, sizes, perf specs and plans fail before the lock and the build. Smoke plans are named `smoke-<demo>.json` instead of `m3-`, and the sweep no longer reports `map.props` as an error. The manifest format is unchanged, except for a warning when the browser revision is not the expected one.
- **Acceptance**: the baseline plan through the repo harness against the scratchpad harness's run of `b6688f4` gave `compare-runs` exit 0, an identical manifest structure (4369 paths) and all 15 steps equal, with 0 to 0.052 % of pixels changed, all on heal beams and the FPS counter, 0 app console errors and a page peak of 1198 MB against 1204. Synthetic variants of a baseline run gave exit 1 with the named reason for a changed focus, tick, render tick, mode, error, player list, step definition, demo header or viewport and for a missing or resized screenshot; exit 0 with a warning for eval, browser, renderer and timed-step changes; exit 2 for a missing manifest; and exit 64 for usage errors. `imgdiff.mjs` called through a symlinked path gives the same rows as through the real path and as X1's imgdiff. With fake browser caches, the expected revision 1248 wins over a newer 1300, and a lone 1300 runs with the warning. `--help` lists all 32 options. Build and tsc pass with the 10 known errors.
- **Not done**: the browser-mismatch path ran only against a fake revision folder (a symlink to the 1248 binary), to avoid a download. `--gpu vulkan` was not run through the harness, although `gpu-probe` shows the 1248 headless shell rendering on RADV at 60 fps. `imgdiff.mjs` still exits 1 without sharp, where `compare-runs` exits 2. Linux only. The README and the smoke sweep predated X2; the wave-3 merge brought both up to date (65 probes, the `memory.*` probes and `?hlProjectileRelease=manual` in the README, `memory.release` and `memory.digest` in the sweep's skip list).

### DOCS

- **Built**: `AGENTS.md` rewritten (Highlander mode, every setting, the debug bridge and its 65 probes, the validation harness, the converter with `props.glb`, the base-parser fallback with B2's text, X2's projectile release, gotchas, limits) and this file. Every command, path, flag, probe name, settings key and number in both files was checked against the code at `b6688f4`, `hl/x2` `308ffba` and `hl/h1` `9acf271`, or against the task reports and their output files. The contract stays as it is.
- **Found in review**: with Highlander on, the HUD and POV keep their Highlander form from base data whenever the extras are missing, which contract 3.9 did not allow. A harness run on 1434434 confirmed it, and contract 14.2 accepts it; see Known limits. The second review found that the docs had called reconverting a newer map version enough; the viewer only uses a folder registered in `src/constants/mappings.ts`, and a run of the real lookup functions against patched copies of that file confirmed it.
- **Wave 3**: X2's and H1's sections come from their final reports, after their review fixes (13.4). Their numbers were checked against the manifests, logs and check files in `/home/dalibor/programming/personal/dribble.tf-wt/x2-out/` and `h1-out/`. A DOCS run of the merged tree (`hl/merge-w3` `73a8412`) through the repo harness confirmed the setup check, 65 probes, the automatic release on 1434434 (37 MB released, a 0.4 MB adapter, self-check clean) and the baseline plan against `b6688f4` (`compare-runs` exit 0, changes only on heal beams and the FPS counter).
- **Final state** (`hl/docs-final`): both files updated for the final verification. Every hash, path and behaviour added was checked with `git show` on `2d584cc` and on the second-round branches, or taken from the fix reports and reviews in `_scratch/final/fixes.json`. The completeness critic's stale lines are fixed: the state line, the DOCS and final-verification rows, the X2 contract rows (now 14.1), the branch list and the 3.9 wording.

### Final verification (contract 14.3)

The review covered the whole diff `009cdb0..highlander` plus the parser's `c7185e4..41fe9f3`, in the dimensions of 14.3 (parser and data, scene, HUD and state, the base app with Highlander off, security and robustness). Every finding went to a separate agent that tried to refute it, and a completeness critic checked sections 5 and 9 and the open lists against the code and this file. A gap review then covered what those dimensions had left out: the parser modules, the converter's output, frontend internals and runtime behaviour. Each confirmed finding was fixed on its own branch from the merge tree, reviewed by another agent, and gated with tsc (the 10 known errors), `npm run build` and the 1438891 baseline plan through `compare-runs`, where every pixel change was a heal-beam wisp, the FPS counter or an intended change. Reports and reviews: `/home/dalibor/programming/personal/dribble.tf-wt/_scratch/final/fixes.json` (keys `fixes` and `gaps`) and `/home/dalibor/programming/personal/dribble.tf-wt/final-review-out/`.

**First round**, merged on `hl/merge-w3` as `612c432` (fix-parser), `cbd6353` (fix-state), `a3dd7e5` (fix-hud), `f53757d` (fix-leaks) and `2d584cc` (fix-scripts), each review approved:

- **`hl/fix-parser`** (`3fe97d5`, parser `hl/fix-parser` `dd178d2`): a class number above 9 (a modded server's civilian, a corrupted prop) panicked the parser, which in wasm kills the fallback worker. `dd178d2` restores `Class::new`'s `unwrap_or_default`, so such a value becomes `Class::Other`; it reverts the upstream commit `c7185e4`, whose message ("dont unwrap when casting ints to Class") says the opposite of what it did. `src/libs/hlextras` was rebuilt from `dd178d2` and only `hlextras_bg.wasm` changed; an independent wasm-pack build is byte-identical. Clippy with the crate's deny lints finds nothing in `src/extras/`.
- **`hl/fix-state`** (`ae00ff5`, `3fbc04b`): the POV focus is resolved again after each actor commit, and while the focused player is absent the player in his list slot stands in until he is drawn again; a user pick replaces the remembered player, and returning from RTS or spectator to POV counts as a resume. With Highlander off, `V`, `I`, `4` and `Tab` do nothing. A failed load that cancels the loaded demo's extras leaves that demo at status `error` instead of `loading`. The RTS centre pick and the sticker raycast skip meshes under hidden ancestors (`isDrawnUnder` in `src/utils/raycast.ts`).
- **`hl/fix-hud`** (`c10cd9f`, `b378574`): the medic panel's "popped m:ss ago" uses that medic's own last uber since the round start, and the tooltip says "last uber this round m:ss ago" or "no uber this round", left out without extras medigun data. The scoreboard footer names where K and D come from: "K and D without Dead Ringer feigns" with extras kill events, "K and D from base deaths, Dead Ringer feigns included" without, and it names a damage source only when there is one (the 14.2 footer fix).
- **`hl/fix-leaks`** (`70ed6b6`): react-three-fiber 8.18 frees removed JSX objects only from an idle-priority task that never runs in this app, so remounts stranded GPU objects. The mapdyn instanced meshes now come from `useInstancedMesh` in `mapdyn/frame.ts` and render as `<primitive>`, heal beams share one geometry and dispose their material, and skinned projectile clones dispose their skeletons. Mode and Highlander toggles kept adding 32 textures each before; now the counts stay flat.
- **`hl/fix-scripts`** (`c7b8ccd`, `2a9a882`, `869c2c7`, `834d37a`): the tetsudo expect notes name the viewer's routes (the stale "the base viewer cannot load it" in `1429417.json`, a 14.2 item), X2's all-tick check is `scripts/hl/check-adapter.mjs` (14.2), and `fallback-values.mjs` and `check-fallback.mjs` mirror both fallback triggers (the B2 follow-up).

**Gap review**: the parser-modules and runtime reviewers found nothing they could back with evidence. The parser reviewer read `tracker.rs`, `derive.rs`, `buildings.rs`, `weapons.rs` with the loadout code, `tempents.rs`, flames, dots and viewmodels, ran all 133 local demos plus the 6v6 sample and 45 corrupted variants of 1440442 without a panic, and cross-checked FireBullets, sappers, laser dots, build events and loadouts on the dumps. The runtime reviewer loaded up to 9 demos in one page with Highlander on and off (the probes follow each new demo and old demos are freed once console capture is out of the way), drew with Highlander on, tried eight viewport sizes, and checked `?tick=`, bookmarks and `]` on 1428628. Eight findings were confirmed: three in the converter, three in frontend internals and two in runtime layouts. The second round fixed all of them, plus leftovers that first-round reviews had routed elsewhere (`hl/fix-misc`).

**Second round**, each branch from `2d584cc`, reviewed and approved:

- **`hl/fix-ticksync`** (`207a734`, `0e99889`), a major finding: buildings and map dynamics added this frame's `frameProgress` to the `renderTick` prop, which reaches React a frame late, so interpolated motion stepped back at tick boundaries (the 1438891 teleporter blade 73 times in 180 frames at 0.5x, the pl_vigil train 58 times in 130). `BuildingObject`, `EngineerFx` and every interpolating mapdyn part now read the tick and the fraction from the store through `frameTime()` (`combat/time.ts`) and `frameTickF()` (`mapdyn/frame.ts`): 0 backward steps at 1x and 0.5x. The unused `renderTick` and `tickRef` props are gone, so the memoised mapdyn parts no longer re-render every tick.
- **`hl/fix-hudlayout`** (`8949693`, `6494764`, `7e4b92e`): the POV weapon HUD sits above the FocusedPlayer card and the PlaybackPanel below 1024 px wide; on viewports under 500 px tall it moves to the bottom edge left of the RED column from 1434 px wide and is hidden on narrower ones (phone landscape). From 768 to 943 px wide, next to the compact columns, the killfeed moves below the taller column when there is room, else it shows 3 compact lines between them. A teleporter shows "ready" only in the states READY to RECEIVING_RELEASE; an idle one shows "exit building", "entry carried", "waiting" and so on from the builder's other teleporter, and "no exit" or "no entrance" only when that one does not exist. The building detail column is 80 px wide, so "building 76%" fits.
- **`hl/fix-converter`** (`3b1d5e5`, `da631ab`, `fa7b23f`, `e14c469`): the map-meta payload path stops at the watcher's `goal_node`, so the pushed ribbon ends at the cart (pl_upward_f12 14543.1 -> 14447.1 units, pl_downfall_b13 13448.2 -> 13415.9; the other payload and tow maps reconvert byte-identical). An untagged resupply locker takes the team of the team-2 or team-3 `func_respawnroom` that contains it, else the nearest spawn enabled at round start, which turns eruption's `prop_locker_red_2` and divulgence's `prop_locker_any_2` and `any_3` from BLU to RED. `convert-bsp.mjs` stages every output in its temp dir and moves it in only after every step succeeded, `conversion.json` last; a failed or interrupted run leaves the previous package and removes the temp dir unless `--keep-temp`.
- **`hl/fix-misc`** (`100fad7`, `3d60e12`, `c197ccd`, `5c2d931`): `PovLayer` imports `isDrawnUnder` instead of its own copy. The legacy projectile path and `Stickers` free their GPU objects: over 3 reloads of 1434434 geometries went 182 -> 206 with Highlander on and 168 -> 200 off, and now stay at 164 and 141 with 0 leaked objects. `check-adapter` and `check-fallback` reject unknown and valueless options with exit 2 before any parse, and `check-adapter --root` names what a checkout lacks (the adapter files or `node_modules`).

**Deviations of the final verification** (not yet contract rows):

- Rule 7.4: with Highlander off the base path frees GPU memory it used to keep, the smoke-trail `InstancedMesh`, MeshLine trails, explosion materials, sticker textures and sprite materials, and the fallback sphere and legacy bolt now share module-level geometry and materials. Nothing drawn changes. With Highlander on, `ExtrasBaseProjectile`'s fallback to the legacy components uses the same shared objects (`hl/fix-misc`).
- Rule 7.4, `hl/fix-state`: with Highlander off, `V`, `I`, `4` and `Tab` do nothing, as before S0.
- With `scene.interpolateFrames` off, buildings and map dynamics snap to whole ticks like actors and F3; before, they interpolated whatever the setting said (`hl/fix-ticksync`).
- Contract section 5 F4 and F5 do not describe the viewport rules of `hl/fix-hudlayout` above, nor the teleporter labels.
- Lockers keep the round-start owner's colour, so a forward room that changes team later keeps its first colour; the old rule was static too (`hl/fix-converter`, documented in `mapdyn/lockers.ts`).

**14.2 and 11.5**: the scoreboard footer, the stale `1429417.json` text and the ported adapter check are done (above). The pre-Highlander viewer (`598e328`) cannot load 1429417: parser2 returns 1 tick and no players there. Highlander loads it through B1's fallback.

## Contract section 9, row by row

| item | state | where |
|---|---|---|
| Scoreboard (Tab) | done: K, A, D, damage, heals, ubers, backstabs, headshots, caps, buildings destroyed, classes played; empty columns hide | F5 `hud/widgets/Scoreboard.tsx`, `objectives/scoreboardModel.ts`; P1 `players.scoring` |
| Stopwatch halves and games | done; games won from `roundWin` with `STOPWATCH_WINNER` | F5 `objectives/stopwatch.ts`, `TeamHeader.tsx`, `RoundBanner.tsx` |
| Static props on the bsp-to-glb maps | partial: PAK props drawn; stock props impossible without game assets | M2 `props.glb`, `map/StaticProps.tsx`; D7 |
| What a third-person player holds, and crouching | done: weapon kill icon on the nameplate, crouch scale 0.756 | F1 |
| Spy reads from far away | done: pinned plates skip the fade and the 12-plate cap | F1, X1 `perf/nameplates.ts` |
| Decloak cue | done: ring and DECLOAK tag | F1 |
| Finding spy, medic, engineer and objective moments | done: timeline categories, `[` and `]`, the Spy chip | F5 `hud/timeline.ts`, `MatchKillfeedPanel.tsx` |
| The POV player's own view of disguises and cloak | done: `disguiseView` 'pov' through 'auto' | F1 |
| Dead POV during the death and freeze cams | done: death camera on the base killer, then the spectated teammate; teammate-death camera | F4 `pov/subject.ts`, X1 |
| Chase camera | done, without wall collision | F4 `pov.chase`, key `4` |
| Round results | done | F5 `RoundBanner.tsx` |
| Per-class status | done: rage, shield charge, Vaccinator resist, rev, stun, gas, jar and cleaver recharge | F1 tags, F4 weapon HUD, F5 badges and medic panel, P1 `itemCharge` |
| Engineer POV building panel | done | F4 `PovWeaponHud.tsx` with F2 `buildingsOf` |
| Effect density at 9v9 | done: effect groups and presets, thin dispenser beams, nameplate cap | F1, F2, section 6.3, X1 |
| Dead Ringer fake deaths | done: hidden in the killfeed, counts and death markers | F5, F6 (`RAG.FEIGN`), P1 `feign` |
| Sappers | done | F2 |
| Spawn doors and setup gates | done | F6 `mapdyn/`, M1 node fix |
| Health and ammo kits with respawn timers | done, plus thrown and dropped items | F6 `mapdyn/pickups.ts`, P2 |
| Loadouts | done: weapons and wearable weapons in the player row tooltip | P1 `players.loadout`, F5 |
| Tug of war | done | P1 `objectives.pd`, F5, M1 boundary override, B1 and B2 routes |
| Respawn timers and waves | partial: per-player respawn seconds done; wave clocks later (`rules.waveRed`, `rules.waveBlu` exported, `findTicks('respawnWave')`) | F5 |
| Uber advantage and medigun type | done | F5 `MedicPanel.tsx` |
| Substitutes, disconnects, class swaps | done: actors keyed by entity id | S0 |
| Long demos and memory | done: the extras memory plan, and X2 releases the base projectile cache once the extras serve projectiles (page memory -505 MB on the 2041 s 1437285, -638 MB on 1429417) | step 0.3, D18, `extras/memory.ts`, X1 long-demo runs, X2 `memory/` |
| Tournament pauses | later: `meta.pauses` is exported, nothing reads it | |
| Crit, headshot, backstab, domination and revenge icons | done | F5 `Killfeed.tsx`, `hud/killfeedModel.ts` |
| Building kills and captures in the killfeed | done | F5 `hud.killfeedObjectives` |
| MEDIC! calls | done | F1 tag from `misc.saveMe` |
| Teleporter use | partial: teleport glow done (under `fxOverheal`); entrance-to-exit pairing line later | F1, F2 |
| Wrangler laser and shield | done | F4 `SniperLayer.tsx`, F2 |
| Death markers | done | F6 `mapdyn/DeathMarkers.tsx` |
| Damage numbers and DPM | later: `hurts` is exported; `hud.damageNumbers` is reserved and unread | |
| Overtime, setup, KOTH unlock countdown, cart rollback warning, cappers | done | F5 `ObjectiveHud.tsx` |
| Humiliation crits after a round win | done: `HL.CRIT_BONUS` at half strength | F1 |
| Left-handed viewmodels | done; no player on 1438891 is left-handed, so the mirror was checked through `viewmodel.debug` | F4 |
| Spectator mouse-look on Linux Chrome | done: pointer-lock fallback | F4 `SpectatorControls.js` |
| "09:60" clock and TICK x2 | done | S0 `src/utils/parser.ts`, F5 `PlaybackPanel.tsx` |
| Offline loading of models | done: `public/draco/` and one global decoder path | S0 |
| Map versions newer than the converted BSP | partial: `MapNotice` names the geometry used; to switch, convert the new BSP and add its exact name to `MAP_NAME_SEARCH_MAP` (converting alone changes nothing) | M1, `src/constants/mappings.ts` |
| Third-person weapon models | later: reuse F4's placeholder builders at world scale | |
| tow_tetsudo's HUD counters | later: the world bounds are only overridden; on 1429417 they stay zero, so the counter cannot be read there | M1 `MapBoundaries.ts` |
| Decals and signage (cap letters, arrows) | not in v1: stock decals are game materials | |
| Demos without `tv_transmitall` | done as graceful degradation | A8, `hasLocalTables`, section 3.9 |
| Colour-blind friendly team colours | later | |
| Shared links and saved setups reproduce views | done (D12); 1428628's links from before B2 point 55.2 s earlier | all layers; B2 |

## Follow-ups

From the "later" rows above, with the data already exported where one is named:

- Respawn wave clocks from `rules.waveRed` and `rules.waveBlu`.
- Tournament pauses from `meta.pauses`.
- Damage numbers and damage per minute from `hurts`, behind the reserved `hud.damageNumbers`.
- A line from each teleporter entrance to its exit.
- Third-person weapon models, built from F4's placeholder builders at world scale.
- A tug-of-war HUD from tow_tetsudo's `plhud.nut` counters, which sit in the world bounds on 1428628 and stay zero on 1429417.
- Colour-blind friendly team colours.
- Decals and signage, out of scope for v1, and in-browser `.bsp` conversion (D6).

From the task reports:

- parser2's empty tails after pauses and on cut files: clamp the timeline to the last tick with positions.
- The tickbase lead: export the lead (`m_nTickBase` minus the server tick) or apply `povFovAt`'s `min()` in the getters (F4).
- Aim a sentry kill's death camera at the sentry instead of the engineer; this needs F2's building model (F4, X1).
- Give crit hitscan tracers their own look; it would be a contract deviation (F3, X1).
- An overlap-aware nameplate declutter; it needs a contract change (X1).
- Wall collision for the chase camera; map raycasts cost 3.6 to 10.6 ms per frame without a BVH (F4).
- PAK props: the sprp fade distances and coarser VTX LODs for weaker GPUs, exact lighting for the 74 shared tetsudo instances (about 4 MB more), the BSP's ambient cubes instead of neighbour estimates, named or parented `prop_dynamic` props, and per-vertex albedo so untextured mode can light props (M2).
- Let the converter register what it writes, the `MAP_NAME_SEARCH_MAP` key and the `MAP_SKYBOX_MAP` entry, or write a `public/models/maps/index.json` that replaces the hard-coded tables, as `maps.md` section 5 suggests (M1).
- Move a bolt stuck in a dying player to his ragdoll, and test world hits against the map (F3).
- Measure when the automatic release runs in a desktop browser that has idle time (X2).
- Test the harness's browser-mismatch warning with a real second Playwright revision, and run `--gpu vulkan` through it (H1).

From the final verification:

- Five layers still add the current `frameProgress` to the stale `renderTick` prop, so they can step back at tick boundaries below 1x: `scene/layers/SniperLayer.tsx` (dot beams), `ObjectivesLayer.tsx` (`CartObject` and `ControlPointDisc`), `PovLayer.tsx`, `scene/viewmodel/ViewmodelLayer.tsx`, and `players/frameContext.ts`, which builds `tickF` from the tick that `PlayerFxLayer.tsx` copies from its prop. The fix in each is `const { tick, tickF } = frameTime(_time)` inside `useFrame` (`hl/fix-ticksync`).
- Base race: `DemoViewer.animate` advances from its own playback state, so a seek issued right after `setPlaying(false)` can be overridden; harness evals wait 300 ms before such a seek (`hl/fix-ticksync`).
- Short viewports: at 844x390 and 1024x480 the player columns and the FocusedPlayer card still overlap the PlaybackPanel, as in the base; that needs a short-viewport layout for the columns or the base panel. At exactly 480 px tall, with the round banner, a 6-line killfeed and an engineer with 4 buildings, the killfeed and the moved weapon HUD can touch by a few pixels. The base "POV Camera" key hint can briefly cover the bottom of the weapon HUD (`hl/fix-hudlayout`).
- Contract rows for the final verification's deviations, and contract section 5 F4/F5 text for the viewport rules (orchestrator). Contract 14's opening sentence says X2, H1 and DOCS are merged on `highlander`; that holds once `highlander` is fast-forwarded.
- The payload path keeps the goal node's `next` field naming the dropped node, and the ribbon trails the cart prop by 12 to 20 units, the prop-to-train-origin offset the base has too. A converter run with `--props false` still leaves an older `props.glb` in place (`hl/fix-converter`).
- Not measured: the sprite-material disposal when a sticker is removed and the `Stickers` texture disposal on unmount, because no plan deletes stickers and `Stickers` never unmounts on a demo load (`hl/fix-misc`).
- `fallback-values.mjs`'s late-start branch has no local demo (`check-parse-routes.mjs --fail-fallback` covers the viewer side), and `compare-builds.mjs` was not ported as a tool (`hl/fix-scripts`).
- The 23 clippy hits (indexing, raw pointers) in the parser's `src/lib.rs` come from upstream commits and look bounded; they are untouched (`hl/fix-parser`).
- The parser fork's `cargo test` has 12 snapshot tests that already fail at the upstream base `cb48015`, so `cargo test --lib` is the gate for parser changes.
- `parseDemoAction` in `src/zustand/actions.ts` still runs the base `console.log(parsedDemo)`, which predates Highlander. While devtools or a console capture such as the harness's holds the logged object, every loaded demo and its extras stay alive; without that, the demos of earlier loads are freed.
- Unvalidated corners the gap review named: the sentry pose index order against the model, demos recorded with `tv_transmitall 0` (a dormant dot or flame), a building that exists during signon (it would emit `buildStart` at tick 0), cp_steel and 1429417 in the browser for the runtime checks, touch gestures on a real phone, and the default RTS framings and sky faces judged by eye.
- Two medics on one team still have no local demo; `hl/fix-hud`'s per-medic uber timer is checked by reading the code only.

## Known limits

- **No game assets** (D1): every model Highlander adds is a procedural placeholder; the player models and the rocket, pipe and sticky models are the viewer's existing GLBs. Stock static props are invisible: 353 to 1844 per map, 117 to 837 of them solid, so sticky traps, sniper dots, rockets, sentries and players can float on the bsp-to-glb maps (114 of the 133 local demos). Overlays and decals, the 3D skybox, light styles toggled during a round and two stock skies (stand-ins) are missing; `AGENTS.md` "Known visual limits" has the examples.
- **Tickbase lead** (12.2 item 6): `m_flFOVTime`, `m_flChargeBeginTime` and `m_flInvisChangeCompleteTime` are written in the player's tickbase time and run 3 to 4 ticks ahead of the server tick. The data is unchanged; `povFovAt` works around it for the POV camera and scope, while `fovAt`, `invisAt` and charge-begin values are not adjusted.
- **Rare kinds without a local demo** (11.4 and the wave reports): jarate, Mad Milk, the Quick-Fix uber, Vaccinator blast and fire ubers, cleavers, stun balls, Short Circuit orbs and energy-ring tempents. Also unvalidated on real data: the minicrit aura, crit syringes, kits that players drop, arena points, two medics on one team and left-handed viewmodels.
- **Highlander on without extras**, accepted in contract 14.2: while the extras load, after an extras error, after a memory-plan skip and for a demo loaded with Highlander off and switched on later, the HUD keeps the 9v9 columns, the medic panels and the Highlander killfeed, fed from base data. POV keeps TF2's FOV without zoom, the class eye heights and the death camera at the death spot, and the 12-plate nameplate cap stays on. Dead Ringer feigns then count as kills and deaths in the killfeed and the Tab scoreboard, whose footer says so ("K and D from base deaths, Dead Ringer feigns included", since `hl/fix-hud`). Contract 3.9 said "base UI only" for the first three states; 14.2 accepts the Highlander form instead. The review of DOCS found it in the code (`HudLayout.tsx`, `hudSnapshot.ts`, `eyeHeight.ts`, `PovLayer.tsx`, `perf/nameplates.ts`) and in earlier harness runs with the extras skipped, and a DOCS run on 1434434 confirmed it for a demo loaded with Highlander off and switched on later (status `disabled`, 9v9 columns, camera FOV 73.74, class eye heights, cap 12, death camera without a killer). Only Highlander off restores the pre-Highlander HUD and POV camera. `AGENTS.md` "Highlander on without extras" has the details.
- **Projectile memory without extras**: X2 releases the base projectile cache only once the extras serve projectiles. A demo loaded with Highlander off, skipped by the memory plan or left with an extras error keeps the whole cache, 205 MB on 1438891 and 641 MB on 1429417, and the release cannot lower the load peak.
- **Fallback demos**: with Highlander off, 1429417 and 1428628 load through the fork's cache (positionScale 32), not as before S0; 1428628's saved ticks moved by +3678 with B2.
- **Newer map versions**: they load the older converted geometry with a notice. Converting the new BSP alone changes nothing, because the shared key (`pl_vigil` -> `pl_vigil_rc10`) still wins; the new folder also needs its exact name as a `MAP_NAME_SEARCH_MAP` key in `src/constants/mappings.ts`, and a newer tow_tetsudo its own boundary override. `AGENTS.md` has the steps. Contract 14.2 adds the mapping step to section 8's fallback.
- **Frame interpolation off**: with `scene.interpolateFrames` off, buildings and map dynamics snap to whole ticks like actors and F3 (`hl/fix-ticksync`).
- **Behaviour worth knowing**: the chase camera has no wall collision; a sentry kill's death camera aims at the engineer; crit hitscan tracers look like normal ones; the nameplate cap thins plates by distance only, and DOM plates draw over the buildings' canvas labels; the KOTH point shows a padlock while waiting for players, as in TF2; thrown items can hover a few units on slopes; a player model's first appearance costs one 120 to 133 ms long task.

## Base parser limits and bugs

The committed `src/libs/parser2` binary was built from an unpublished version of Hona's parser fork, so it is never rebuilt (D2); these stay as they are. No task found a decoding bug in the extras parser.

1. **Start rule**: parser2 starts its cache only after 100 warmup packets with non-zero world bounds. tow_tetsudo's `plhud.nut` writes HUD values into the world bounds, so 1429417 never starts and 1428628 started 55.2 s late. Both now go through the fork's fallback builder (B1, B2).
2. **Timeline length**: parser2 sizes its timeline by the header's tick count from its own start, so pauses and cut files leave empty tails: -9 397 s, 1442402 104 s, 1429425 80 s, 1426663 37,222 ticks, 1422900 8065 ticks. Expected: the last tick with positions + 1.
3. **Shift residual**: positions are offset by `m_WorldMins` at the cache start while the result reports the end-of-demo bounds, which left +1/32 unit in x on tetsudo. Both tetsudo demos now use the fallback, so it no longer shows.
4. **Cut downloads**: 1422900 and 1426663 end inside a packet; they parse, and the extras add "truncated at demo tick N" to `meta.warnings`.
5. **Tickbase lead**: see Known limits; it is data semantics, not a decoding error.
6. **parser2-only fields**: `endTick`, `endDemoTick`, `shots` and `playerCache.activeWeaponDef` exist only in parser2's output, and nothing reads them.

## Performance and memory

Measured with the headless harness on this machine's Radeon 680M through ANGLE EGL at 1600x900, RTS default view, every Highlander setting on unless noted. 60 fps is the vsync cap.

| point | before Highlander | wave-1 merge (`0ac066d`) | X1 (`5b6b066`) and the wave-2 merge |
|---|---|---|---|
| 1438891 koth_product, tick 21000, 1x | 33.8 fps | 48.9 fps (`fa3997b`) | 58.0 fps; 60.0 with Highlander off |
| 1438891 at 50 %, 1x | | 56 fps | 59.8 fps, page 1.26 GB |
| 1433441 pl_vigil, busiest tick 7939, 1x / 2x | | 58.9 / 56.8 fps | 59.3 / 59.1 fps |
| 1434434, 1440442, 1429417 at 50 %, 1x | | 60 fps | 1429417 60.1 fps |
| paused | | | 60.2 fps everywhere |
| 1437285 (2041 s) / 1432698 (1557 s) | 26.1 / 32.1 fps, peaks 2211 / 2296 MB (base viewer at `598e328`, map models missing then) | | 59.0 / 59.9 fps, peaks 1566 / 1570 MB |

- **X2** (`308ffba`): two runs at 1438891 tick 21000, 1x, every setting on, gave 59.3 and 59.1 fps (p95 16.8 ms, no long task), against 58.7 and 57.5 fps for `b6688f4` in the same session.
- **Browser memory**: PSS on 1438891 is 1249 MB with every setting on and 1177 MB with Highlander off, against 1535 MB before Highlander; ending the base worker after the parse gave most of that. Page peaks in the wave-2 smoke runs: 1434434 890 MB, 1440442 1097 MB, 1438891 1259 MB, the 6v6 sample 1126 MB, 1428628 1442 MB, 1429417 1687 MB, with 0 app errors on every run.
- **Base caches**: 702 MB on 1429417, 641 MB of it projectiles; 472 MB with parser2 and 477 MB with the fallback on 1428628; the base projectile cache alone is 332 MB on 1442753 (910 s).
- **Base projectile release** (X2): browser PSS in the same page after a forced GC, before and after the release. 1438891: 969 -> 768 MB (-201; a 204.6 MB cache replaced by a 1.6 MB adapter). 1429417: 1449 -> 811 MB (-638; 640.9 MB, 3.8 MB). 1428628: 1215 -> 785 MB (-430; 432.6 MB, 2.7 MB). 1437285, 2041 s: 1268 -> 763 MB (-505; 508.3 MB, 4.1 MB). The 6v6 sample: 791 -> 742 MB (-49; 57.5 MB, 1.0 MB). V8's backing stores fall by about the cache size (290.2 -> 87.5 MB on 1438891, 778.5 -> 141.6 MB on 1429417), and the JS heap stays at 31 to 37 MB used. The release cannot lower the load peak, because it runs after the parse. In X2's perf runs at 1438891 tick 21000 the browser peaked at 1100 and 1105 MB, against 1220 and 1221 MB for `b6688f4` in the same session.
- **Extras**: typed arrays of 3.35 MB on 1434434, 9.9 MB on 1438891 and 39 MB on 1429417. The worker's wasm heap (77.5 MB on 1438891, 213 MB on 1429417) ends with the worker. The memory plan predicts at most about 322 MiB for the largest local demo, under the 600 MB budget, so no local demo loses a group.
- **Load time**: the extras parse takes 0.2 s (the 6v6 sample) to 2.7 s (1429417) after the base parse. 1429417 adds a 3.5 s fallback pass after the failed 2.4 s parser2 pass, 1428628 a 2.5 s pass after 3 s.
- **Repository**: the converted maps add about 26 MB, the skies 3.7 MB and the PAK props 11.3 MB; `hlextras_bg.wasm` is 3.16 MB and the main bundle 2.83 MB (2.81 MB before X2).

## Validation tools

- **Headless harness**: `scripts/hl/harness/` (H1). `shot.mjs` builds a checkout, serves it with a local demo, drives headless Chromium through `window.__dribble` and writes screenshots and a manifest per run. `plans/1438891-baseline.json` is the 15-shot baseline plan and `plans/smoke-gen.mjs` writes the smoke plans; `--perf-play tick:seconds[:mode[:player[:speed]]]` measures frame rate and memory, `summarize.mjs` summarises a run, and `tools/compare-runs.mjs` is the baseline gate. `AGENTS.md` has the commands, and `scripts/hl/harness/README.md` the details.
- **Debug bridge**: `window.__dribble` with `hl.status`, `hl.waitReady`, `hl.findTicks` (59 kinds plus `proj:<kind>`) and 65 probes; plans assert on probe values instead of pixels. See `AGENTS.md`.
- **Extras checker**: `scripts/hl/check-extras.mjs` with the 12 expectation files in `scripts/hl/expect/`, and the native `hl_extras` runner in `../dribble-parser` with `--self-check`, `--print-options` and `--counts-only` for the 133-demo survey.
- **Base-parse routes**: `scripts/hl/fallback-values.mjs` and `check-fallback.mjs` (B1, both fallback triggers since `hl/fix-scripts`), `check-delayed-start.mjs`, `check-parse-routes.mjs`, `check-delayed-trigger.mjs`, `parser2-start.mjs` and `parser2-survey.mjs` (B2).
- **Projectile adapter**: `scripts/hl/check-adapter.mjs` compares X2's adapter with the base cache at every tick and slot, also against an older checkout with `--root`.
- **Sentry calibration**: `scripts/hl/calibrate-sentry.mjs`.

## Branches, merges and signatures

- **Merges on `highlander`** (frontend, oldest first): step 0 `598e328`, S0 `c50bc38`, P1 `4572bdc`, M1 `fce10b5`, contract v2.1 `69b18ef`, B1 `c38c13a`, F1 `5e01757`, F2 `883a666`, F3 `5006c75`, F4 `63c787c`, F5 `b954df3`, F6 `cc74311`, M2 `0ac066d`, contract v2.2 `fa3997b`, B2 `460726e`, P2 `24f60b0`, X1 `ab4f613`, contract v2.3 `b6688f4`. That is 72 commits on top of `dev` at `009cdb0`, 14 of them merges.
- **Merges on `hl/merge-w3`** after `b6688f4` (first parent, oldest first): X2 `f51f0c0`, H1 `73a8412`, DOCS `1ced433`, the smoke-sweep and README fix `30f792c`, contract v2.4 `36e98a1`, the docs pointer commit `6c386ce`, then the first fix round: fix-parser `612c432`, fix-state `cbd6353`, fix-hud `a3dd7e5`, fix-leaks `f53757d` and fix-scripts `2d584cc`. At `2d584cc` that is 104 commits on top of `009cdb0`, 22 of them merges, and `git show --remerge-diff` prints nothing for any of the 8 new merges.
- **Intended final state**: the orchestrator merges the second fix round, `hl/fix-ticksync` (`0e99889`), `hl/fix-hudlayout` (`7e4b92e`), `hl/fix-converter` (`e14c469`), `hl/fix-misc` (`5c2d931`) and `hl/docs-final`, into `hl/merge-w3` and fast-forwards `highlander` to it, so `highlander` = `hl/merge-w3` after the final fixes. The four code branches touch disjoint files. Their merge hashes did not exist when this was written.
- **Parser `highlander`** (`../dribble-parser`) is linear: 9 commits from `3dbbe1b` (the `hl_probe` research binary) to `41fe9f3` on top of `c7185e4`, with the task branches `hl/p1-extras` (`1a8f2f9`), `hl/b1-fallback` (`96deea0`) and `hl/p2` (`41fe9f3`). `hl/fix-parser` (`dd178d2`) adds one commit on `41fe9f3`; the committed `src/libs/hlextras` is built from it, and the final state fast-forwards the parser's `highlander` to it.
- **Task branches** `hl/<task>` remain in both repos after their merge.
- **Nothing was pushed**, and every Highlander commit in both repos is unsigned, because gpg signing fails in the agents' environment. After the final merge, the user can re-sign both branches from their own shell:

```sh
git -C /home/dalibor/programming/personal/dribble.tf rebase --rebase-merges \
    --exec 'git commit --amend --no-edit -S' 009cdb0
git -C /home/dalibor/programming/personal/dribble-parser rebase \
    --exec 'git commit --amend --no-edit -S' c7185e4
```

- **Why `--rebase-merges`**: the plain form `git rebase --exec 'git commit --amend --no-edit -S' <base>` flattens the frontend history and drops its merge commits; the parser branch has no merges, so the plain form fits there. Every merge up to `2d584cc` is conflict-free (`git show --remerge-diff` prints nothing for each), so the rebase recreates them without stopping; check the final round's merges the same way before re-signing. A dry run on a scratch clone at `b6688f4`, with signing replaced by a plain amend, recreated all 72 commits and 14 merges with an identical final tree in 5 s. Every commit gets a new hash; the `hl/*` branches keep pointing at the old unsigned commits.
