# TF2 asset phase: status

State on 2026-11-02, after wave 2. `assets` sits on `highlander` `a06e4c7` and holds the asset contract (`contract.md`, v2.0; section 11 records the accepted deviations, section 12 the wave-2 rules), the four foundation tasks, M3-props, the six wave-2 tasks and these docs. The wave-1 text below is kept as it was; "Wave 2" says what changed since. `highlander` has not moved. Nothing is pushed, and every commit is unsigned because gpg signing fails here (`specs/highlander/STATUS.md` has the commands to re-sign). `AGENTS.md` "Asset pack" has the operational notes: build command, serving, settings, probes and budgets.

## Overview

With a pack built from the user's own VPKs, the ten bsp-to-glb maps now draw their stock static props: rocks, crates, rails, consoles, pines, lamps. They draw like the PAK props already did, as flat albedo times VRAD's per-vertex lighting, without textures. On pl_vigil the two floating examples from the Highlander docs are fixed. At cache tick 6955 of 1434434 the BLU sniper stands on rock004 (static prop 341), and at 9078 the sticky rests on rock002 (static prop 344). Both are stock `prop_static`.

Without a pack the site behaves exactly as `a06e4c7` did, which is the point of D21. A production build without `VITE_ASSET_PACK_URL` makes no pack request and shows no settings block. The harness checks this on every runtime change by comparing request logs against a REF run of `a06e4c7`.

The pack stays local. It lives at `/home/dalibor/tf2-pack` (71 MB, ten maps, generator `1.0.0` from `30a6f80`, VPK fingerprint `b5ee50f5...`), and no Valve file or Valve-derived number is in git.

## Tasks

| task | branch and tip | merged in | state |
|---|---|---|---|
| C0 contract | `as/contract` `b440f8a` | on `assets` directly | done; later amended by the integrator to v1.3 (`e140598`) |
| A0-pack converter core | `as/a0-pack` `2e76b41` | `0c0a040` | done, approved with 4 minors |
| A0-runtime loader, settings, probes | `as/a0-runtime` `588a724` | `1f334a1` | done, approved |
| A0-harness | `as/a0-harness` `6f6fc05` | `a787b8f` | done, approved |
| A0-exporter bsp-to-glb patch 0003 | `as/a0-exporter` `acd4d6c`; bsp-to-glb `as/exporter` `61faedf` | `38eb7e4` | done, approved |
| M3-props stock static props | `as/m3-props` `30a6f80` | `36bc282` | done except the triangle budget, which moved to M3-lod (contract 11.3) |
| DOCS | `as/docs` | this merge | done |

### C0: contract

`specs/assets/contract.md` fixes the decisions D19 to D22 (local pack only, no new tools, the fallback rule, the phase order), the amended Highlander decisions (D1 replaced, D5, D7, D8 and D12 amended), the pack layout and manifest, the runtime, the D21 verification runs N1 to N4, the budgets and the wave-1 task list. It took two review rounds. v1.2 changed the request comparison to pathnames with the `/assets/` content hashes normalised and counted keys, so that a `src/` change or a `--query` no longer fails N1 or N3 (11.2). The integrator added 11.3 when M3-props merged.

### A0-pack: converter core

`scripts/assets/` (README, `build-pack.mjs`, `check-determinism.mjs`, `version.mjs`, `lib/{vpk,vmt,vtf,manifest,fsutil,model-export}.mjs`, tests and surveys under `tools/`) and the `assets:build` line in `package.json`.

Acceptance:
- Indexing the four `_dir.vpk` files takes 354 to 675 ms. The entry counts match: tf2_misc 104,343, tf2_textures 29,669, hl2_misc 18,946, hl2_textures 5,032.
- 28 sampled reads, split archives included, match `tooling/bin/vpk.py` byte for byte. The review cross-read 48 more, and none differed.
- Empty builds and fixture builds are byte-identical, and so are incremental, `--force` and `--force --stages maps` rebuilds.
- The VMT survey parsed 26,086 tf2_misc VMTs and 5,107 hl2_misc VMTs with 0 exceptions. The VTF survey read 34,519 headers with 0 exceptions.
- All 10 refusals exit 2. A failure in the last step, a planted stage failure and SIGINT each leave the previous pack unchanged.
- tsc shows the 10 known errors and the build passes.

Deviations, all recorded in the README: `--only`, `--prune`, `--set` and `--stage-dir`, the `.dribble-asset-pack` marker, `.build.lock`, `generator.commit`, per-stage ownership of manifest entries, and timings kept out of manifest `stats` (contract 11.3 item 7 now says so).

Open minors from the last review:
- A patch key that applies only off PC (`[$X360]`) wipes the include's PC value in `lib/vmt.mjs`. The VPKs contain no patch materials, so nothing is affected today.
- After a generator bump, a partial `--stages` build keeps the other stages' entries but stops recording which generator wrote them.
- `tools/vpk.mjs stats` without `--tf2` prints a stack trace instead of its usage line.

### A0-runtime: loader, settings, probes

`src/assetpack/**` (config, pack state, items, loaders, hooks, settings, probes, `AssetSettingsSection.tsx`), the pack middleware in `vite.config.mts`, the `@pack/*` path, the `assets` settings type and default in the store, and one line each in `SettingsPanel.tsx` and `main.tsx`.

Acceptance:
- N1 (no pack URL): compare-runs exits 0 against REF with equal request keys. The only pixel changes are heal beams and the FPS counter, at most 0.53 %.
- N2 (`VITE_ASSET_PACK_URL=/tf2-assets/`, 404 answer): exactly one request, `manifest.json`, plus one info line.
- N3 (`?assets=off`): 0 pack requests.
- The main bundle grew 1.6 KB and contains no `/tf2-assets` string.
- The middleware answers 404 `text/plain` for a missing file, `..`, `%2e%2e`, a directory, the bare prefix and a symlink that leads out of the pack, and 405 for POST.
- The probes have the shapes of contract 3.8 in all four status cases.

The review fixes added real-path symlink containment. `warmUpObject` now needs the drawn scene. `assets.waitIdle` only waits and no longer starts the resolution. Disposal now frees textures in shader uniforms too.

Not tested: the skinned `SkeletonUtils` clone path at runtime, because no skinned GLB without Draco exists locally.

### A0-harness

`scripts/hl/harness/**`: `--asset-pack <dir|missing>` with its own build-cache entry, `--no-vsync`, the manifest fields `assetPack`, `requests`, `requestSummary` and per step `assetsIdle`, and the request-set rule and `--allow-request` in `compare-runs.mjs`. smoke-gen, summarize and the README were updated to match.

Acceptance:
- REF against REF exits 0 (53 = 53 keys).
- A scratch checkout whose bundle hashes differ exits 0.
- REF against N3 exits 0.
- REF against N1 exits 0 on the baseline and on the 6v6 smoke plan.
- An extra request fails with `requests differ: /__extra-request-test 0 -> 1` and passes with `--allow-request`.
- `--asset-pack missing` fails without `--allow-request` and passes with it. The integrator re-ran this once A0-runtime had merged.
- Pack serving follows contract 3.3, and raw dot-segment paths answer 404.
- `--no-vsync` gives uncapped frames (73 fps in the test shot).

### A0-exporter: bsp-to-glb patch 0003

`scripts/bsp-to-glb/0003-*.patch` and `scripts/setup-bsp-to-glb.mjs`. The patch makes the studio exporter accept MDL version 47 (the five sapper models) and NaN sequence-layer ranges, which it applies at full weight with the parent cycle. It reads 64-byte body-part names that lack a terminator, and it no longer writes empty `mesh.weights`, empty top-level arrays or empty `node.children`. The setup script applies every missing patch in file order, checks each patch's subject on the branch, and handles `--skip-build` without a binary.

Acceptance:
- `cargo test`: 140 passed, 0 failed, 6 ignored.
- Bulk export: buildables 77/77, weapons 449/449, player 1736/1736.
- The sentry1 export has 0 EMPTY_ENTITY errors.
- pl_vigil_rc10 and koth_ashville_final1 give byte-identical `world.glb`, `props.glb`, `visibility.json` and `map-meta.json` with the old and the new binary.
- Scratch clones get exactly the missing patches.

Not done:
- The two dizzy_bottle taunt GLBs still contain an animation with empty channels.
- Non-unit normals and invalid skin skeletons in the validator output predate this task.

The main bsp-to-glb checkout is still on `dribble` `41841bf` without 0003, and the builder finds that binary by default. Stock props do not need 0003. Phase 3 does: it needs either `npm run setup:bsp`, which changes that checkout and so needs the user's go-ahead, or `--bsp-to-glb` pointing at `/home/dalibor/programming/personal/dribble.tf-wt/as-exporter-bsp2glb/target/release/bsp-to-glb`.

### M3-props: stock static props

`scripts/lib/static-props.mjs` takes an optional stock source. `scripts/assets/maps/stage.mjs` is the pack's maps stage. In the runtime, `StaticProps.tsx` takes a `source` prop, `useStockProps` checks the map entry, and the stock rows go into `map.props` and `map.propInstances`. World resolves the pack before `conversion.json` and mounts the second `<StaticProps>`. `mapAssets.ts` gains `publicMapIdentity`.

Step 1 found that both 1434434 floating examples are stock `prop_static`. With the pack they stand on drawn props, which a mesh ray test and the `map.propInstances` rows confirm.

| map | MB | instances | models | excluded (winding) | build s |
|---|---|---|---|---|---|
| cp_steel_f12 | 8.21 | 1406 | 262 | 1 | 17.6 |
| koth_ashville_final1 | 6.16 | 814 | 103 | 2 | 10.4 |
| koth_proot_b5b | 1.34 | 343 | 37 | 1 | 5.3 |
| koth_warmtic_f10 | 6.66 | 1059 | 114 | 1 | 7.6 |
| pl_divulgence_b4b | 9.12 | 1437 | 254 | 2 | 12.7 |
| pl_downfall_b13 | 9.75 | 1755 | 208 | 3 | 13.7 |
| pl_eruption_b15 | 7.86 | 1460 | 277 | 1 | 13.9 |
| pl_upward_f12 | 6.99 | 1001 | 212 | 1 | 9.0 |
| pl_vigil_rc10 | 8.22 | 1406 | 263 | 4 | 12.6 |
| tow_tetsudo_b10c | 6.41 | 1166 | 118 | 1 | 9.2 |

The ten maps total 70.7 MB and take 113.4 s, with 0 missing models. `--maps koth_product_final` exits 2.

Acceptance:
- Two builds of vigil and tetsudo are byte-identical, and a rebuild at the tip reproduces all ten files.
- `props.glb` without a stock source is byte-identical to the old code's output on vigil, tetsudo and proot.
- There are RTS and POV shots on every packed map. 1438891 (koth_product) is unchanged at 324 draw calls.
- `map.nodes` and `map.meta` are identical with and without the pack, and seeking twice gives identical output.
- N1 and N3 exit 0. N2 makes one 404 request. N4 draws stock props with Highlander off, the deviation contract 3.9 records.
- A stale `publicProps` and a deleted `props-stock.glb` each give one warning and fall back.

Budgets (contract 6.1):

| budget | result |
|---|---|
| bundle | +11.0 KB of 25 KB |
| file size | at most 9.75 MB per map of 12 MB, 70.7 of 80 MB in total |
| build time | at most 17.6 s per map of 60 s |
| draw calls | steel 433 and divulgence close 444 of 450; tetsudo close 503 of its 622 |
| frame time, uncapped on 1434434 | RTS p95 14.5 ms of 16.6 ms; POV 15.1 to 15.3 ms of 17.3 ms |
| peak PSS | 1434434 at 997 to 1027 MB of 1150 MB; 1428628 from 1412 to 1457 MB, and 865 to 906 MB after the X2 release |
| GPU memory | flat over three reloads on 1432714, with buffers at 996 and VAOs at 413 counting both copies |
| triangles | fails 1.2M on downfall (1.70M), eruption (1.34M), divulgence close (1.25M) and tetsudo (1.95M) |

Contract 11.3 records the triangle numbers per map and gives the cut to M3-lod. Tetsudo already draws 0.64 to 1.0M triangles without the pack.

Deviations, all in contract 11.3:
- The probe row shape: stock rows carry `source: 'stock'` with the Source origin under `origin`.
- VMTs are read through `lib/vmt.mjs`.
- Models below 90 % winding agreement are excluded. On tetsudo rock006c leaves 25 instances without a model, on eruption 9.
- Unnamed, unparented, non-animated stock `prop_dynamic` entities are included.
- Clusters of one or two lit instances join the exact-light batch.
- Timings go to `reports/`.
- `mapdyn.surface` and `map.status` differ with the pack.
- Two pre-existing effects were measured and are outside M3-props: textures grow by 2 per map reload, and a forced `scene.map` switch loads empty roots.

Not done:
- There is no shader warm-up (contract 4.3) for `props-stock.glb`. 4.3 binds from phase 2 on, and stock props use the PAK props' programs.

### DOCS

`AGENTS.md` gains the "Asset pack" section and a gotcha about forced map switches. Stale text elsewhere was updated: the bundle size, the D1 wording, the 7.4 deviation, `?assets=off`, 68 probes, the 34 harness options with the request check, patch 0003, "Known visual limits" with the vigil examples, "Known Highlander limits", the project structure and the branches. This file is new.

## Integration gates on `assets` `e140598`

- tsc shows exactly the 10 known errors, and `npm run build` passes (17.8 s, main bundle 2,843 kB).
- Without a pack, the 1438891 baseline against REF `a06e4c7` exits 0, with the largest pixel change 0.062 % (heal beam). The 1434434 and 6v6 sample smoke runs have 0 app errors and 0 probe errors.
- With `/home/dalibor/tf2-pack`, the same three runs reach `assets.status` `ready` with 0 app errors. Vigil requests `manifest.json` and `pl_vigil_rc10/props-stock.glb`. koth_product and the sample request only the manifest.
- `--asset-pack missing` makes one 404 request and exits 0 with `--allow-request /tf2-assets/manifest.json`.

## Open follow-ups

- Contract 2.6 now states the patch order the code uses (insert, then replace; fixed in contract v2.0). `scripts/assets/README.md` also still says contract 2.3 lists `ms` and that an amendment was requested; 11.3 item 7 has settled that, and A0-pack owns that line.
- The orchestrator should confirm contract 11.3, which the integrator wrote.
- The three A0-pack minors listed above.
- Experiment packs that can go: `/home/dalibor/tf2-pack-review`, and also `/home/dalibor/tf2-pack-runtime` and `/home/dalibor/tf2-pack-a0-harness` (fake bytes and a test symlink, no Valve data) once nobody needs them for re-runs.
- Patch 0003 is not in the main bsp-to-glb checkout. That is a user decision before phase 3.

## Wave 2

With a pack, the ten bsp-to-glb maps now draw textured world geometry and textured stock and PAK props, and Highlander draws TF2 models for buildings, most extras projectiles, kits, ammo, drops, lockers and the cart. Viewmodels are still placeholders. Without a pack nothing changed: after every merge the no-pack 1438891 baseline against REF `a06e4c7` exited 0, with the largest pixel change 0.64 % from the heal beam. The pack at `/home/dalibor/tf2-pack` is now about 705 MB: 10 maps and 2455 items (2403 textures, 52 models), built from `4ddb7a8` in 302 s.

| task | branch and tip | merged in | state |
|---|---|---|---|
| W-pack models stage and loader | `as/w-pack` `7d91a91` | `6f1959a`, follow-up `367a434` | done |
| M3-world textured maps | `as/m3-world` `e6917b5` | `b266aba` | done |
| W-buildings | `as/w-buildings` `3a6e20f` | `9c8fa49` | done |
| W-projectiles | `as/w-projectiles` `27f2f18` | `dc6e420` | done |
| W-items (map items and cart) | `as/w-items` `cead117` | `e220883` | done |
| M3-props2 textured props and far LODs | `as/m3-props2` `7172ac5` | `4ddb7a8` | done, two budgets over |
| DOCS2 | `as/docs2` | this merge | done |

- **W-pack**: the `models` stage exports 52 world models with attachments, sequences, pose ranges, skins and bodygroups; `@pack/models` holds reference-counted entries with one compiled template per skin. The integrator's follow-up requires the sRGB S3TC extension for DDS. Gaps: skin templates are built for every skin, not lazily; `useRetainPackModels` in W-buildings works around a release-during-compile race in `models.ts`, which is still unfixed.
- **M3-world**: VMT and VTF resolution through upstream bsp-to-glb mounts (no new patch), DDS sidecars with a WebP fallback, the WorldVertexTransition blend and the `Textured maps` setting. 37 to 77 MB of texture GPU memory per map. Gaps: two texture-export modules remain (`scripts/assets/lib/texture-export.mjs` and `scripts/assets/models/texture-export.mjs`); the duplicate `<key>@webp` manifest items are not recorded in contract 12.3; chunk-grid-1 draw calls were measured on vigil and tetsudo only; no runtime check compares `bspSha256`; D21 N2 and N3 were not rerun on the merged tip.
- **W-buildings**: sentries, dispensers, teleporters, sappers and blueprints from the pack with team skins, tick-derived build, upgrade and aim poses, and `sentryMuzzleAt` from the muzzle attachment. Gaps: no GPU-memory reload check after the merge. Polish (`pol/world`): the dark look is gone since the winding fix; sentries play the build sequence of `sentry1_animations.mdl` and cycle `fire` while shooting (live in `/home/dalibor/tf2-pack` since the polish rebuild).
- **W-projectiles**: flares, arrows, bolts, jars, cleavers, stun balls, ornaments, cannonballs and syringes as instanced pack meshes. Gaps: gas, energy rings and balls, fireballs and orbs keep placeholders; instanced variants are not warmed up; the integration run on 1434434 did not confirm pack projectiles (W-projectiles' own runs did).
- **W-items**: kits, plates, ammo, drops and lockers per model as `InstancedMesh`es, the cart from its prop's model; probe `mapdyn.pack`. Gaps: `instantiate()` runs inside `useMemo` during render; a kit spot's model comes from its first instance. Polish (`pol/world`): pack lockers take a team tint; pack cleavers and ornaments spin in flight (cleaver spin unvalidated: no local demo throws one).
- **M3-props2**: textured `props-stock.glb` and new `props-pak.glb` with UVs, skins, the alpha rule and a far LOD per model; `propLod.ts` switches LODs and applies sprp fades in POV and spectator views. Gaps: close RTS on divulgence draws 924 calls against 600, and `props-stock.glb` is 13 to 20 MB against 12 MB; nobody checked the instance-colour fix in the browser by switching from wireframe back to textured.
- **DOCS2**: `AGENTS.md` "Asset pack" gains textured maps, textured props and LODs, models, buildings, map items and the cart, the wave-2 settings and probes (70, or 73 with a ready pack); stale lines in "Known visual limits", "Known Highlander limits" and the Highlander overview are updated.

Experiment packs that can go once their reviews are closed: `/home/dalibor/tf2-pack-as-world`, `/home/dalibor/tf2-pack-as-props2`, and the wave-1 ones listed under "Open follow-ups".

**Next: phase 4, viewmodels.** A `ViewmodelProvider` at priority 10 that reads pack viewmodels (the `viewmodels` stage and the reserved `assets.viewmodels` setting). The instance cache must take the model's ready state into its key, and old demos without local tables keep the placeholder. Still unscheduled: M3-blend texture scroll, M3-overlays and `map.skybox3d`, third-person weapon models, KTX2 hosting, light styles, other maps.

## Wave 3 (viewmodels, contract v2.1 section 13)

With a pack, POV now draws TF2 viewmodels: the class's c_arms model playing the networked `vm0` sequence, with the active weapon's c_model bone-merged onto it in the team skin. Without a pack, with `assets.viewmodels` off, on demos without local tables the placeholders draw as before. After each merge tsc gave the 10 known errors, the build passed and the no-pack 1438891 baseline against REF `a06e4c7` exited 0 (largest pixel change 0.311 %). `/home/dalibor/tf2-pack` now holds 10 maps and 2902 items; the weapons need `--set itemsGame=<items_game.txt>` and the build used the patch-0003 bsp-to-glb from `as-exporter-bsp2glb`.

| task | branch and tip | merged in | state |
|---|---|---|---|
| V-pack viewmodels stage | `as/v-pack` `a81fc60` | `f64a768` | done |
| V-provider GLB viewmodel provider | `as/v-provider` `4b2fcc1` | `e5e4fe5` | done, minigun excluded |
| DOCS3 | `as/docs3` | this merge | done |

- **V-pack**: `scripts/assets/viewmodels/` exports the nine c_arms models with their include models' sequences in Source's virtual-model order (13.2) and 157 c_model weapons of the stock and locally used defs, with `mergeBones` per class (13.3). About 30 s and 115 MB. Gaps: blend sequences keep only their first animation, the `r_handposes` finger layer is dropped, weapon skins other than 0 and 1 draw flat albedo.
- **V-provider**: `glbProvider.ts` at priority 10, sequence time from `tickF` (D12), derived draw, fire, reload and idle when vm0 is unusable, muzzle attachment for F3's tracers, cloak fade, per-weapon placeholder fallback; `viewmodel.state` gains `source` and `pack`, and `viewmodel.meshes` is new. Checked on 1434434: soldier, medic and spy draw from the pack, the heavy's minigun draws from the pack since the user confirmed its pose matches TF2.
- **Gaps**: the minigun pose hides most of the gun behind the left hand, as in TF2 (see "Pose check" below), and now draws from the pack; heavy fists and other heavy weapons were not shot. Not implemented: the finger layer. P-viewmodel (`pol/viewmodel`) added the minigun barrel spin, the spy's watch hand (5 `viewmodel:watch` models) and the soldier rocket hide (see AGENTS.md Viewmodels). Not run: the 6v6 sample with a pack (the local-tables gate is checked in code only), a determinism double seek with the pack (watch included), the Gunslinger (not in the pack), a GPU-memory reload check (watch sub-instances included). `assets.viewmodels` has no settings row and also needs `assets.models` on.
- **Showcase findings** (DOCS3, 1434434 POV with the pack, `viewmodel.meshes` boxes in camera space): the Original (`c_bet_rocketlauncher`, `bet_*` clips) puts the soldier's arms 45 to 90 units left of the camera, out of frame (TF2's own pose, see "Pose check"); the soldier's Disciplinary Action at `s_idle` shows nothing in frame; the Enforcer (`c_snub_nose`) draws the spy's hand without a visible revolver, its box reaching behind the camera; a BLU spy's arms use the `spy_hands_red` material; the soldier's arms draw their rocket mesh while he holds a melee weapon (bodygroups). Scout, pyro, demoman, heavy fists, engineer, medic, sniper and a cloaked spy look right. Pairs: `/home/dalibor/programming/personal/dribble.tf-wt/wave3-showcase/` (local only). Re-shot after the winding fix `3b2b5af` (pack models had every triangle reversed): the Disciplinary Action and the Enforcer now draw in frame and look right; the Original and the minigun are unchanged (see "Pose check"); the BLU spy material is unconfirmed by eye.
- **Pose check** (`as/vm-pose`): neither pose is an export or retargeting error. The `c_*_animations` models have the same bones, parents and defaults as their `c_*_arms`, and the clips match a raw `bsp-to-glb` export of the include. `bet_idle`, `bet_fire` and the other `bet_*` animations hold one track, `weapon_bone`; every other bone, root included, takes its bone default (Source's `CalcAnimation` does the same), which puts the arms 41 units to the side, so TF2 draws the Original centred without hands. The heavy's `m_*` clips animate the whole arm chain with the root at (-8, 0, 18.3), 50.7 units below the reference root; the legacy `v_minigun_heavy` `spool_idle` has the same root and its left hand within 0.5 units of ours. The hand rests on c_minigun's carry handle and the barrels sit 15 units below it (muzzle at 66 forward, 28 down), so at viewmodel FOV 54 to 70 the hand covers the gun. The user confirmed this is how TF2 shows the minigun, so it draws from the pack (`PACK_POSE_EXCLUDED` is empty). The only way to show it would be a per-weapon view offset that TF2 does not apply.

## Polish pass

Merged on `assets`: `pol/world` `e934dd5` in `090dadb`, `pol/viewmodel` `e2a64a7` in `c609a52`, `pol/props` `f313e9a` in `ee33ba0`, plus the integrator fix `d560488`: the soldier rocket stays visible when the weapon's slot is unknown to `items.json`. After the merges tsc gave the 10 known errors, the build passed and the no-pack 1438891 baseline against REF `a06e4c7` exited 0 (largest pixel change 0.005 %). `/home/dalibor/tf2-pack` was rebuilt from the merged tree for the maps, models and viewmodels stages (291 s, 737 MB, 2913 items). With it, 1434434 and 1438891 reached `ready` with 0 app errors and 0 failed pack items; the sentry build sequence and the spy watch hand draw. Before/after pairs: `/home/dalibor/programming/personal/dribble.tf-wt/polish-showcase/` (local only).

- **pol/world**: sentry build and fire sequences, team-tinted pack lockers, spinning pack cleavers and ornaments (see AGENTS.md Buildings and Map items).
- **pol/viewmodel**: spy watch hand on vm1 from five `viewmodel:watch` models, minigun barrel spin, soldier rocket only with a primary.
- **pol/props**: runtime bake of pack static props into per-material batches with array textures, sliced over about 24 ms steps, incremental LOD index writes and row-bounded raycasts. Divulgence close RTS 795 -> 458 calls, p95 33.4 -> 16.8 ms.
- **Still open** (the leftovers below closed the props budget, mini sentries, the Gunslinger, `v_pda_spy` and the GPU check): the bake still runs in slices during load; frame time was not measured on tetsudo, steel or in spectator; mini sentries keep the z scale-up while building; the cleaver spin is unvalidated (no local demo throws one) and the ornament spin was not seen in a shot; the locker tint is mild (halfway to the team colour); `sentry1_heavy` and `sentry1_animations` stay loaded for every non-mini sentry, unmeasured; the barrel spin and rocket hide change no POV pixels; the Gunslinger arms, `v_pda_spy.mdl` and the finger layer are not done; no GPU-memory reload check or determinism double seek with the watch; kits have no yaw because the data has none.

## Leftovers (`as/leftovers`)

Four polish leftovers, on `as/leftovers` from `highlander` `592ac0d`. tsc gave the 10 known errors, the build passed, the no-pack 1438891 baseline against REF `a06e4c7` exited 0 (largest pixel change 0.231 %), and a run on 1422948 with `/home/dalibor/tf2-pack` reached `ready` with 0 app errors and 0 failed requests. `/home/dalibor/tf2-pack` was rebuilt for all three stages (318 s, 733 MB, 2916 items). Before/after pairs: `/home/dalibor/programming/personal/dribble.tf-wt/polish2-showcase/` (local only).

- **props-stock budget**: the ten `props-stock.glb` files went from 80.2 to 75.8 MiB (84.1 to 79.5 million bytes), under the 80 MB budget either way. Pack prop files quantize vertex colours to 8 bits instead of 12 (-3.9 %), and `compactGlbJson` in `scripts/lib/static-props.mjs` drops the default `normalized: false` and `byteOffset: 0` from the GLB JSON (-1.3 MB; the JSON chunk is about a fifth of each file because of its thousands of small accessors). The public `props.glb` path is unchanged. A pixel diff of a divulgence RTS shot between the old and new pack changed nothing outside the mini sentry (threshold 24).
- **Gunslinger and disguise kit viewmodels**: the viewmodels stage exports `c_engineer_gunslinger.mdl` (99 sequences, 63 clips from `c_engineer_animations`) and `v_pda_spy.mdl` (its own 2 sequences) as role `viewmodel:standalone` items with `class` and `defs` (from the schema's `tf_weapon_robot_arm` and `tf_weapon_pda_spy` items: 142 and 27). The Gunslinger item also lists the engineer's `weapons`: TF2 swaps the arms model for every weapon while the Gunslinger is equipped (`g_HACK_GunslingerEngineerArmsOverride`), so the provider uses it as the arms whenever `vm0.model` names it (shotgun, pistol and PDAs bone-merge onto it), and alone for def 142. The disguise kit draws alone. Checked on 1422948: BLU engineer Tywhip holding the shotgun and the Gunslinger, two spies opening the disguise kit.
- **Mini sentries**: they now play `sentry1_heavy`'s build sequence while constructing, in the mini skins (`sentry1_heavy` gained the `variants.mini.skins` pair 2/3 that `sentry1` has; its skin families match `sentry1`'s, mini red then mini blue). The z scale-up stays only for packs without `sentry1_animations`.
- **GPU memory**: 1422948 with the pack, four rounds of POV (Gunslinger engineer, disguising spy), spectator and RTS, with three demo reloads: `renderer.info.memory` geometries 664, 677, 677, 675 and textures 334, 336, 342, 338; live GL textures 338 to 346 and buffers 3435 to 3484. Without the pack: GL textures 95, 97, 97, 97 and buffers 1711 to 1763. Both are flat after the first reload, so nothing was fixed.
- **Still open**: the incremental pack build depends on map order for a few shared world textures (a vigil-only build first gave 5 textures a different size than a full build; `check-determinism` between the two packs listed them and a 24 to 48 byte difference in two props files); the finger layer; the rest of the polish pass's open items.

### as/shutters: skinned props of the older textured map GLBs

- **Cause**: `textured_compressed.glb` of koth_product_final (an upstream file, not from the pack) bakes every skinned `prop_dynamic` in its reference (bind) pose: every joint's world matrix times its inverse bind matrix is one shared matrix, and the GLB has no animations. Source draws frame 0 of the default sequence, whose root bone turns by 120 degrees about (1,1,1) on these models (`door_slide_large_dynamic` `root`, `resupply_locker` `body`, `lantern001`). So the RED and BLU spawn shutters lay on their side (drum vertical, sheet beside it) and the lockers turned. Present without a pack too, since upstream.
- **Fix** (pack only, so no-pack rendering stays `a06e4c7`'s): the models stage lists nine `mapprop` models plus the locker with `refPose: true`, which keeps each moved node's reference TRS in `extras.dribble.refPose`. `src/assetpack/mapPropPoses.ts` (`useMapPropPoses`, called by World) matches each skinned prop of a loaded map to a `mapprop`/`locker` item by triangle count and bone names (GLTFLoader's `_N` suffixes stripped), sets root bones to map bone x reference^-1 x default-sequence pose and the other bones to the pack's local pose, and restores the baked pose on cleanup. Probe `assets.mapProps()`. Needs the `models` stage rebuilt (10 items, about 7 s).
- **Same bug elsewhere**: the other upstream textured maps carry the same skinned props (door_slide on gullywash, metalworks, process, prolands and bagel; main_entrance_door on granary and gullywash; lanterns, banners, chimneys), covered by the same models but not checked in a browser (no local demo). Not covered: weapon and cosmetic models and other one-off props on those maps, and product's trophy (3243 triangles). `scripts/lib/static-props.mjs` bakes one-bone stock `prop_dynamic` models in the reference pose too: `lantern001` (90 degrees off) is in `props-stock.glb` on steel, vigil, downfall and eruption; not fixed here. Prop doors still draw closed (idle); their open and close sequences are not driven.

## Next phases as planned after wave 1 (contract section 10; phases 2 and 3 are done, see "Wave 2")

- **Phase 2, textured maps.**
  - M3-world: VMT and VTF resolution in bsp-to-glb, every VTF through one Node path to DDS sidecars (DXT rewrapped, mips kept) with a WebP fallback, and `bspSha256` in the public and pack `conversion.json`.
  - M3-blend: WorldVertexTransition and texture scroll from `tickF`.
  - M3-proptex: UVs, skins and alpha test on props, plus a new draw-call baseline (600 until then).
  - M3-lod: VTX LOD1 at distance and sprp fades in POV and spectator views. It now also owns the wave-1 triangle cut.
  - M3-overlays and `map.skybox3d`.
  - Budgets per map: 256 MB of texture GPU memory, 1.3 GB peak PSS on 1434434.
  - GLTFLoader cannot load DDS, so a runtime binding step assigns the textures, after a shader warm-up.
- **Phase 3, world models.**
  - W-pack, which depends on patch 0003.
  - W-buildings: placeholder constants stay byte for byte, and the pack model's attachments are read at runtime.
  - W-projectiles, W-mapitems, and W-cart (the cart is a named or parented `prop_dynamic` that the props pass skips).
- **Phase 4, viewmodels.** A GLB provider at priority 10 that reads the pack. The instance cache must take the model's ready state into its key. Old demos without local tables keep the placeholder.
- **Not scheduled.** Third-person weapon models, KTX2 hosting, overlays on displacements, light styles, other maps.
