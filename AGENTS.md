# AGENTS.md — Operational Details for AI Agents

## Build & Dev

- **Package manager**: npm (`yarn` not installed; use `npm run build`, `npm run dev`)
- **Build**: `npm run build` — completes in ~10s
- **Type check**: `npx tsc --noEmit` — note: has pre-existing TS errors (uninitialized properties in AsyncParser, unused React imports)
- **Dev server**: `npm run dev` (Vite)
- **Converter config precedence**: `scripts/convert-config.json` overrides `scripts/convert-map.mjs` defaults when present, so map-conversion verification should pass explicit CLI flags or update the config if testing a changed default such as `chunk-grid`
- **Converter validation reruns**: pass `--chunk-grid 8` explicitly while `scripts/convert-config.json` still pins `chunk-grid=4`; `--skip-material-truth true` skips the slow VPK material scan when validating chunking/visibility output
- **Converter resume path**: `node scripts/convert-map.mjs ... --metadata-only true` reuses the temp BSP/VMF/GLBs/lightmaps to finish skybox, teleports, visibility, and `conversion.json` after a late-stage failure; skybox conversion still needs `vtf2img` importable from the `python3` on `PATH`
- **Headless browser validation**: Chrome remote debugging currently needs both `--user-data-dir=<tmp>` and `--remote-allow-origins=*`, and WebGL-backed validation in headless mode needed `--use-angle=swiftshader --enable-unsafe-swiftshader --enable-webgl --ignore-gpu-blocklist`; runtime perf logs are enabled with `?perf=true`
- **WASM support**: Vite 5 handles `.wasm` via `new URL('./file.wasm', import.meta.url)` natively — no `vite-plugin-wasm` or `vite-plugin-top-level-await` needed; wasm-bindgen's JS glue uses this pattern and has its own MIME-type fallback
- **Framework**: React + Three.js (react-three-fiber) + Zustand + Tailwind

## Maps: the bsp-to-glb pipeline (Highlander maps)

- **Setup once**: `npm run setup:bsp` (`node scripts/setup-bsp-to-glb.mjs`) clones Hona/bsp-to-glb into `../bsp-to-glb` (from the main checkout: `/home/dalibor/programming/personal/bsp-to-glb`), checks out the pinned commit `7b7f7fc` on a local `dribble` branch, applies `scripts/bsp-to-glb/0001-*.patch` and `0002-*.patch` with `git am`, and runs `cargo build --release --locked` (about 25 s with `CARGO_BUILD_JOBS=4`). The patches make upstream work without game assets: unresolved cubemap-patch includes become warnings, multi-style lightmaps are composed (`--lightmap-styles`), NaN displacement alphas are sanitised, materials carry the texdata reflectivity (the flat albedo), and a `vtf-to-png` helper decodes PAK skybox faces.
- **Worktrees**: both scripts resolve `../bsp-to-glb` relative to the checkout, which is the wrong place in a worktree. Set `BSP_TO_GLB_DIR=/home/dalibor/programming/personal/bsp-to-glb` (or pass `--dir` / `--bsp-to-glb`).
- **Convert**: `npm run convert:bsp -- --bsp <tf/maps/map.bsp>` (`node scripts/convert-bsp.mjs`) writes `public/models/maps/<map>/{world.glb, lightmap.webp, visibility.json, map-meta.json, conversion.json}` in 6 to 13 s per map and, when the BSP PAK ships the sky faces, `public/models/skybox/<sky>/`. No game assets are needed: surfaces get the compile-time average albedo as vertex colours, lit by the BSP's own baked lightmap. `--only-meta true` runs the same passes into the temp dir but writes only `map-meta.json`; `koth_product_final` uses it, because it keeps its older textured GLB and `conversion.json`. Other flags: `--map`, `--out-dir`, `--chunk-grid 4`, `--lightmap-format webp|png`, `--meshopt true|false`, `--skybox-dir`, `--keep-temp true`, `--temp-dir`, `--overwrite-sky true`. Sky folders are shared between maps, so the converter never replaces an existing `public/models/skybox/<sky>/` whose pixels differ from the map's PAK faces: it writes them to `<sky>_<map>/` instead and prints the `MAP_SKYBOX_MAP` entry to add (`--overwrite-sky true` replaces the shared folder). The Node dependencies (`@gltf-transform/*`, `meshoptimizer`, `sharp`) come in through `@gltf-transform/cli`.
- **Runtime**: when `conversion.json` says `pipeline: 'bsp-to-glb'`, `World.tsx` loads `files.model` with the meshopt decoder plus the lightmap atlas (otherwise `textured_compressed.glb`), replaces materials by `material.userData.dribble.kind` (`src/highlander/map/bspMaterials.ts`, the rules any bsp-to-glb GLB such as `props.glb` reuses), and publishes brush-entity nodes by BSP model index in `useInstance().mapNodes` (`src/highlander/map/mapNodes.ts`). `src/utils/mapAssets.ts` resolves the folder through `MAP_NAME_SEARCH_MAP` and caches one `conversion.json` fetch per folder. A missing file counts as absent and is cached as `null`, including the `index.html` that `npm run dev`, `vite preview` and the Netlify rewrite return with status 200; only a failed request is retried. `src/highlander/map/mapMeta.ts` loads `map-meta.json` (raw Source units; scene = Source minus the demo's boundaryMin). Debug probes: `__dribble.hl.probe('map.status' | 'map.nodes' | 'map.meta')`.
- **Boundary overrides**: Highlander maps need no `OVERWRITE_MAP_BOUNDARIES` entry, because the demo's `m_WorldMins/m_WorldMaxs` equal the BSP's `world_mins/world_maxs`. The one exception is `tow_tetsudo_b10c`: its `plhud.nut` writes the tug-of-war push counter into the world entity's `m_WorldMins` and HUD counters into `m_WorldMaxs` (1428628 changes `m_WorldMins` 1572 times), so `MapBoundaries.ts` pins the BSP bounds and the converter camera from that map's `conversion.json`. Copy them again if the map is reconverted.
- **Known visual limits** (expected, not bugs): stock static props (crates, rocks, rails, oil drums, trains, most spawn doors and the payload cart) are TF2 game assets and are not rendered; only map geometry is. Sticky traps rest on invisible crates, sniper dots and laser beams end in mid-air, rockets burst against nothing, sentries built on props float, and players stand on air. Examples on 1434434 (pl_vigil): at cache tick 6955 the BLU sniper UNC. redlix stands about 100 units above the visible floor and his sniper dot ends 109 units above it; at cache tick 9078 a sticky rests 167 units above the floor. VRAD baked the props' shadows into the lightmap, so dark patches can appear with nothing casting them, and a few gaps that a prop fills in game show the sky (pl_divulgence). Prop-only doors and setup gates keep their rendermode-10 collision brush as a node with `initiallyVisible: false`, which runtime code may show as the door's stand-in; rendermode-10 `func_brush` blockers and respawn visualizers are invisible walls in game and stay hidden. Overlays and decals (signs, arrows, cap letters), the 3D skybox (hidden) and light styles that toggle during a round are not rendered. Two stock skies are stand-ins: pl_divulgence `sky_badlands_01` uses `sky_dustbowl_01`, pl_upward `sky_upward` uses `sky_tf2_04`. Props embedded in the map's PAK are a separate task (contract section 4.8).

## Project Structure

- `src/utils/parser.ts` — Duration/tick utilities
- `src/components/Analyse/Data/` — Demo parsing (ParseWorker, AsyncParser, PlayerCache, ProjectileCache)
- `src/components/Scene/` — 3D scene rendering (World, Actors, Projectiles, Skybox, Lights)
- `src/utils/mapAssets.ts`, `src/highlander/map/` — map folder lookup, cached `conversion.json`, `map-meta.json` loader, brush-entity nodes
- `scripts/convert-bsp.mjs`, `scripts/lib/map-meta.mjs`, `scripts/setup-bsp-to-glb.mjs`, `scripts/bsp-to-glb/*.patch` — BSP to map package converter
- `src/components/DemoViewer.tsx` — Main playback engine
- `src/components/UI/` — UI panels (PlaybackPanel, SettingsPanel)
- `src/zustand/store.ts` — Global state store
- `public/models/players/` — Player model GLB files

## Git

- Remotes: `origin` (bryjch/dribble.tf), `tf2jump` (Hona/dribble.tf)
- Reference branch for perf work: `tf2jump/dev`
