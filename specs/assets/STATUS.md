# TF2 asset phase: status

State on 2026-11-02, after wave 1. `assets` sits on `highlander` `a06e4c7` and holds the asset contract (`contract.md`, v1.3; section 11 records the accepted deviations), the four foundation tasks, M3-props and these docs. `highlander` has not moved. Nothing is pushed, and every commit is unsigned because gpg signing fails here (`specs/highlander/STATUS.md` has the commands to re-sign). `AGENTS.md` "Asset pack" has the operational notes: build command, serving, settings, probes and budgets.

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

- Contract 2.6 still says VMT patches apply "replace then insert". The code applies insert (add or overwrite), then replace (existing keys only), with nested blocks merged on the raw tree before conditions, as Source and bsp-to-glb do. The orchestrator should amend 2.6. `scripts/assets/README.md` also still says contract 2.3 lists `ms` and that an amendment was requested; 11.3 item 7 has settled that, and A0-pack owns that line.
- The orchestrator should confirm contract 11.3, which the integrator wrote.
- The three A0-pack minors listed above.
- Experiment packs that can go: `/home/dalibor/tf2-pack-review`, and also `/home/dalibor/tf2-pack-runtime` and `/home/dalibor/tf2-pack-a0-harness` (fake bytes and a test symlink, no Valve data) once nobody needs them for re-runs.
- Patch 0003 is not in the main bsp-to-glb checkout. That is a user decision before phase 3.

## Next phases (contract section 10; each gets its own contract version first)

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
