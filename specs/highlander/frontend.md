# Highlander frontend guide: harness, architecture, integration points

Scope: how the dribble.tf frontend works today, where Highlander (9v9) features should plug in,
and how to check them headlessly. Game mechanics and networked props are in
`specs/highlander/tf2-reference.md`; this file covers the frontend only. Line numbers refer to
branch `highlander` at `009cdb0` plus the debug bridge (`src/utils/debugBridge.ts`, registered
at `src/main.tsx:7`).

`S` below = `<scratchpad>`,
`H` = `$S/harness`.

---

## 0. Environment facts found while doing this

- **node_modules was missing** in the repo. Installed from the lockfile:
  `npx --yes yarn@1.22.22 install --frozen-lockfile --ignore-scripts` (379 MB, `yarn.lock`
  unchanged, no `package-lock.json`). `--ignore-scripts` is needed because `sharp` (only used by
  `@gltf-transform/cli`) tries to build from source without node-gyp. Nothing the app needs runs
  an install script (esbuild works through its `@esbuild/linux-x64` package).
- **Type check:** use `node_modules/.bin/tsc --noEmit -p .`. Plain `npx tsc` without
  node_modules installs an unrelated npm package called `tsc@2.0.4`. There are 10 existing
  errors: BuildingCache.ts ×4, ChunkedArray.ts ×3, AnalyseMenu.tsx, DemoDrawing.tsx and
  UrlDemoNotice.tsx. The bridge adds none.
- **Headless Chromium can use the GPU.** chrome-headless-shell 1248 with
  `--use-gl=angle --use-angle=gl-egl --enable-gpu` reports
  `ANGLE (AMD, AMD Radeon 680M (radeonsi rembrandt ACO), OpenGL ES 3.2)` through
  `/dev/dri/renderD128`, which is world-rw. `--use-angle=vulkan` (RADV) also works with the shell
  binary; the full `chrome` binary gets no WebGL2 with vulkan. SwiftShader renders koth_product at
  0.7 fps, keeps all 16 cores busy and makes each screenshot take about 60 s. With egl each shot
  takes about 1.5 s. CONTEXT.md's "WebGL needs swiftshader" note should be updated.
- **Draco decoder from the network.** Player models are Draco GLBs, and drei's `useGLTF` fetches the
  decoder from `https://www.gstatic.com/draco/versioned/decoders/1.5.5/`. Offline, every
  player model fails to load. The harness serves three's bundled copy for that URL.

---

## 1. Validation harness (Task A)

The harness lives outside the repo in `$H` (`shot.mjs`, `build-child.mjs`, `plans/`, `tools/`,
`node_modules/playwright-core@1.64.0`, which matches Chromium revision 1248). The only repo change
is the debug bridge (§1.6).

### 1.1 Command lines

```sh
H=<scratchpad>/harness

# a few ticks in RTS + POV of chosen players (main repo, default output dir $S/shots/<demo>-<time>)
node $H/shot.mjs --demo $DRIBBLE_DEMOS/1438891.dem \
  --ticks 25%,60% --modes rts,pov --pov sniper@red,medic@blue

# a worktree, explicit output dir
node $H/shot.mjs --root /path/to/worktree --demo $DRIBBLE_DEMOS/1434434.dem \
  --ticks 3000,9000 --out $S/shots/my-feature

# the baseline (15 shots + perf + CPU profile), ~1 min
node $H/shot.mjs --demo $DRIBBLE_DEMOS/1438891.dem \
  --plan $H/plans/1438891-baseline.json --out $S/baseline \
  --perf --perf-play 21000:12:rts --cpu-profile --no-minify

# helper: 9v9 volume stats of a demo (killfeed density, projectile peaks, uber pops), Node only
flock $S/heavy.lock node $H/tools/demo-stats.mjs $DRIBBLE_DEMOS/1438891.dem
```

Other tools in `$H/tools/` run the committed parser2 in Node (or launch Chromium), so run them
under `flock $S/heavy.lock`. All except `gpu-probe.mjs` take the demo path as the first argument:

| tool | prints |
|---|---|
| `demo-stats.mjs <demo>` | killfeed density, projectile peaks, uber pops, rounds |
| `awd-coverage.mjs <demo>` | `activeWeaponDef` coverage per player |
| `shots-probe.mjs <demo>` | `shots` per weapon and player |
| `medic-probe.mjs <demo> <ticks…>` | charge and weapon def around the given ticks |
| `gpu-probe.mjs` | which Chromium flag sets give hardware WebGL |

**Do not wrap `shot.mjs` in `flock`.** It takes `$S/heavy.lock` itself by re-running under
`flock`. If an ancestor process is already `flock … heavy.lock` it notices and skips the lock;
`--no-lock` forces that skip. `node $H/shot.mjs --help` prints all options.

Timing with GPU egl:
- build: 12 s, cached by a fingerprint of `src/`, `index.html` and the configs. There is one
  cache per root and a separate one for `--no-minify`.
- 47 MB demo: download, parse and scene in 4–6 s.
- shots: about 1.5 s each, plus up to 2.3 s after a camera-mode change so the camera tip panel has
  faded.
- whole baseline: about 55 s.

Memory: the browser process tree uses 1.3–1.6 GB PSS with 47–51 MB demos.

### 1.2 Options

| option | meaning |
|---|---|
| `--root <dir>` | repo or worktree to build (default main repo). A worktree without `node_modules` gets a symlink to the main repo's |
| `--demo <file.dem>` | required. Map name and length are read from the 1072-byte header |
| `--ticks a,b` | playback ticks or percentages of `maxTicks` (`10%,50%,90%` default) |
| `--modes rts,pov,spectator` | default `rts,pov` |
| `--pov a,b` | `auto` (first alive by team/class), entity id, name or substring, `sniper`, `sniper@blue`, `class:sniper:red` |
| `--plan file.json` | explicit steps (overrides ticks/modes/pov), see §1.3 |
| `--out <dir>` | output dir |
| `--size WxH` | viewport, default `1600x900` |
| `--hide-hud` | hide `.ui-layer` HUD in every shot (scene and nameplates only) |
| `--settle-ms`, `--settle-frames` | extra wait per shot (700 ms, 8 frames) |
| `--perf` | load with `?perf=true` and keep `[Perf]` lines (DemoViewer logs every 5 s) |
| `--perf-play tick:seconds[:mode[:player[:speed]]]` | measure while playing (speed 1) or paused (speed `0`): fps, frame ms, ticks/s, long tasks, JS heap, browser PSS, draw calls → `perf.json` |
| `--cpu-profile` | with `--perf-play`: CDP CPU profile (`perf.cpuprofile`) + `perf-top.txt` (self time by function and script) |
| `--no-minify` | unminified build (own cache) so profiles show real function names (`KillRow`, `Killfeed`, ...) |
| `--gpu egl\|vulkan\|swiftshader` | WebGL backend, default `egl` with automatic fallback to swiftshader |
| `--browser shell\|chrome` | chrome-headless-shell (default) or full chromium |
| `--rebuild` / `--no-build` | force a build / reuse the last build even if stale |
| `--keep-default-map` | do not stub other maps' GLBs (see §1.5) |
| `--allow-network` | do not block non-local requests |
| `--query a=1&b=2` | extra URL params |
| `--timeout <s>` | hard timeout (default 900), always cleans up |

### 1.3 Plan files

A JSON array of steps. Every field is optional; `tick` defaults to `50%`:

```json
[
  { "name": "blu-sniper", "tick": "50%", "mode": "pov", "player": "sniper@blue" },
  { "name": "clean", "tick": 24902, "mode": "rts", "hideHud": true,
    "settings": { "ui.nameplate.enabled": false } },
  { "tick": 30000, "mode": "rts", "camera": { "mode": "rts", "position": [x, y, z], "target": [x, y, z] } },
  { "tick": 40000, "play": 3, "speed": 1 },
  { "tick": 40000, "screenshot": false,
    "eval": "window.__dribble.stores.useInstance.getState().parsedDemo.ticks" },
  { "tick": 40000, "eval": "(window.__dribble.stores.useStore.dispatch({ type: 'SET_UI_PANEL_ACTIVE', payload: { name: 'MatchKillfeed' } }), true)" }
]
```

Each step runs in this order: settings → speed → `goToTick` → mode/POV (`reset` defaults to true
for rts/spectator, which drops the last POV so the camera returns to the map default) → `camera`
→ `play` N seconds of wall time → `eval` (a page expression; its JSON result goes to the
manifest, and any UI it opens is captured) → hide HUD → settle (network idle, frames, ms, tip
panel) → screenshot.

`$H/plans/1438891-baseline.json` and `$H/plans/probe-parser-perf.json` are worked examples.

### 1.4 Outputs

| file | content |
|---|---|
| `NN-<name>.png` | one per step (`name` or `t<tick>-<mode>[-<player>]`) |
| `manifest.json` | demo header; browser executable, GPU and WebGL renderer; load state and memory; per step: resolved tick, mode result, `{playback, scene, perf}` state, `players` at the render tick (entityId, name, team, class, health, alive), eval result, file, error; warnings |
| `console.log` | every console message, page error, failed local request and dialog, with seconds since start |
| `build.log` | vite build output |
| `perf.json`, `perf.cpuprofile`, `perf-top.txt` | with `--perf-play` / `--cpu-profile`. Open `.cpuprofile` in Chrome DevTools → Performance |

### 1.5 How it works, and gotchas

1. **Production build, not `vite dev`.** `build-child.mjs` runs the checkout's own Vite and
   `vite.config.mts` with `mode: production`, `publicDir: false` and
   `VITE_APP_ASSET_URL=''` (otherwise `getAsset()` would point at a CDN), writing to
   `$H/builds/<sha1(root)>[-nominify]/dist`, about 10 MB on tmpfs. Dev mode is unsuitable:
   `React.StrictMode` double-invokes `App.componentDidMount` (App.tsx), so a `?demoUrl=` demo is
   downloaded and parsed twice.
2. **Server.** An in-process HTTP server on `127.0.0.1:<random>` serves `dist/` first, then
   `<root>/public` straight from disk (maps, models, skyboxes). `/__harness/demo/<file>.dem` serves
   the demo; it is same-origin, so `embed.ts`'s host allowlist accepts
   `?demoUrl=/__harness/demo/<file>.dem`. `/umami/*` returns 204. A GLB request for any map other
   than the demo's gets an empty 84-byte GLB, because the empty scene boots into the default
   `cp_snakewater` map (a 47 MB GLB) before the demo's map is known (App.tsx:33, store.ts:235).
3. **Browser.** Requests to `www.gstatic.com/draco/**` are answered from
   `three/examples/jsm/libs/draco/gltf/`. Google Fonts gets empty CSS and every other non-local
   request is aborted, so screenshots use the fallback sans font. Dialogs are logged and
   dismissed. An unsupported map raises `alert('Unable to load map model…')`, which the harness
   records as a warning and then continues without a map.
4. **Load.** The harness waits for `window.__dribble`, then for `parser.status === 'done'` with
   the scene map equal to the demo map. It pauses immediately, because `loadSceneFromDemoAction`
   starts playback, then waits for network idle and a map mesh.
5. **Shutdown.** Runs in `finally`, on SIGINT/SIGTERM and on the hard timeout: browser close with
   15 s grace, then SIGKILL of the browser process group, then server close.

Gotchas:
- **Tick semantics:** playback tick `T` renders cache tick `T−2` (`renderTick`,
  DemoViewer.tsx:730-731). The PlaybackPanel shows "TICK" as `2×T` (§1.7 item 10).
- POV targets resolve against the players present at the current render tick. Class queries
  prefer alive players.
- Spectator mode always logs `pageerror NotSupportedError`: SpectatorControls.js:151 calls
  `requestPointerLock({ unadjustedMovement: true })`, which Linux Chromium does not support
  (see §13).
- `setSetting` and plan `settings` persist to the temporary profile's IndexedDB, as a user change
  would.
- A worktree branched before the bridge was committed has no `window.__dribble`. The harness then
  fails fast and names the missing import.

### 1.6 Debug bridge (`window.__dribble`)

`src/utils/debugBridge.ts` is imported last in `src/main.tsx:7`, so module evaluation order is
unchanged. It installs only when the URL has `?debug=1` or `?debug=true`, or under the Vite dev
server. All return values are JSON-safe.

| member | behaviour |
|---|---|
| `getState()` | `{ready, parser{status,progress,error?}, demo{map,ticks,intervalPerTick,playerCount,deathCount,roundCount,chatCount}, playback{tick,renderTick,maxTicks,playing,speed,intervalPerTick}, scene{map,controlsMode,focusedEntityId,lastFocusedEntityId,mapLoaded,actorCount}, perf{renderCalls,renderTriangles,…}, downloads[]}`. `mapLoaded` requires a mesh under the `world` group |
| `listPlayers(tick?)` | all mapped players at `tick` (default render tick): `{index, entityId, userId, steamId, name, team, teamId, classId, className, health, alive, connected}` |
| `resolvePlayer(q)` | entity id / `sniper` / `sniper@blue` / `class:sniper:red` / exact name / name substring, among connected RED+BLU players |
| `goToTick(t, {frames=2})` | `goToTickAction`, then waits for frames |
| `setPlaying(bool)` | dispatches `TOGGLE_PLAYBACK` without the "Paused" toast that `togglePlaybackAction` adds |
| `setSpeed(n)` | `changePlaySpeedAction` |
| `focusPlayer(q)` | `jumpToPlayerPOVCamera` for the resolved player; returns that player or null |
| `setControlsMode(mode, {player?, reset?})` | `rts`/`spectator`/`pov`; `reset` clears `lastFocusedPOV` |
| `getCamera()` / `setCamera(cam)` | the saved-setup camera bridge: `{mode:'rts',position,target}` or `{mode:'spectator',position,quaternion}` |
| `setSetting(path, value)` | `updateSettingsOptionAction` (dotted path) |
| `frames(n)` | wait n animation frames |
| `stores` | `{useStore, useInstance}` for ad-hoc probes, e.g. `__dribble.stores.useInstance.getState().parsedDemo` |

Feature work should add probes to the bridge (for example `getExtras()`) rather than reaching
into internals from plans.

### 1.7 Baseline results (`1438891.dem`, koth_product_final, 9v9, 817 s)

Shots are in `$S/baseline/` (GPU). `$S/baseline-swiftshader/` has the same plan rendered with
SwiftShader. `$S/baseline/hud-1280x720/` and `hud-1920x1080/` show the killfeed peak at other
viewport sizes.

| shot | tick | what it shows |
|---|---|---|
| 00-overview-rts | 10% | default RTS camera over the point |
| 01-uber-red-medic-pov | 7700 | RED medic POV during uber; killfeed highlights the medic as assister |
| 02-double-uber-rts | 12560 | both medics just popped; ubers are not visualized, only the two heal beams show |
| 03-max-projectiles-rts / 04-…-demo-pov | 21896 | most projectiles alive (14, counting untyped ones) |
| 05-killfeed-peak-rts / 06-…-sniper-pov | 24902 | 9 killfeed lines at the round-1 end; the sniper POV is of a dead player |
| 07 spy@blue, 08 engineer@red, 09 pyro@blue | 30000 | class POVs (no viewmodels, no buildings) |
| 10-spectator-default | 30000 | spectator camera (tip panel stays on screen) |
| 11-heavy-blue-pov | 40000 | dead heavy, "Respawning in 6" |
| 12-match-killfeed-panel | 40000 | MatchKillfeed panel open (211 kills) |
| 13-scene-only-no-nameplates | 47990 | `hideHud` and nameplates off |
| 14-late-uber-blue-medic-pov | 51950 | BLU medic healing a rocket-jumping soldier |

Demo volume from `tools/demo-stats.mjs`:
- 211 deaths. Killfeed lines visible at each death: 1→90, 2→60, 3→29, 4→16, 5→9, 6→3, 7→1, 8→1,
  9→2.
- Up to 14 projectiles alive at once; 164 projectile slots.
- 12 uber pops, 2 rounds, 21 chat lines, 1500 `shots`, 21 distinct active weapon definitions.
- Projectile samples (every 4th tick): sticky 23133, healing bolt 7618, pipe 4595, rocket 3094,
  untyped (dropped) 5679.

**9v9 UI problems seen in the screenshots:**
1. **The killfeed collides with the RED status column.** The killfeed sits top-right, each line
   is about 42 px and lingers 200 ticks; the status column is vertically centred. Overlap starts
   at line 5 at 720p, line 7 at 900p and line 9 at 1080p, and 9 lines occur at round ends
   (05, 06, hud-1280x720). The status rows are drawn on top, so the killfeed lines underneath are
   unreadable.
2. **At 720p the BLU column covers the left toolbar.** The rows start at y≈192, on top of the
   Bookmarks button.
3. **Status rows are translucent** (`bg-pp-panel/40`, health fill `/50`), so nameplates and
   killfeed text show through (11: the "Broly LSSJ" nameplate over the "Elegardo" row).
4. **Name truncation** at `w-52`: "MODE 7x: tom…", "PABLOTHERA…", "₍ᐢᐢ₎. usongi ｡O…". Dead rows
   show only a small respawn number.
5. **Medic info is thin.** Each medic gets one "Charge" row with no medigun type
   (PlayerStatuses.tsx:224 TODO) and no ready/active state. There are no per-class extras such as
   sentry level, cloak, sniper charge or sticky count.
6. **Nameplate clutter.** 18 drei `<Html>` nameplates with no distance fade, no occlusion and no
   overlap avoidance produce text like "MODE1013omato" and "PAB1013HERAPIST" (03, 07, 11).
7. **POV problems.**
   - The camera pivot is a fixed 83 u for every class. Real eye heights are 65–75 and 45 when
     ducking (tf2-reference §10.4).
   - The POV medic's own heal beam starts at body centre below the camera and fills the bottom of
     the screen (01).
   - There is no viewmodel.
   - A dead POV stays at the death spot with "Respawning in N".
8. **Projectiles are hard to see** at RTS overview distances. Untyped projectiles (flares,
   arrows, jars, cleavers, balls, …) never render.
9. **Missing game objects and HUD:** no engineer buildings, no objective HUD (KOTH clocks, cap
   progress), no round timer.
10. **Clock bugs.** The time shows "09:60 / 13:37" and "12:60" because `utils/parser.ts:5` rounds
    seconds up with `Math.ceil`. "TICK" shows 2× the playback tick and jump-to-tick halves its
    input (PlaybackPanel.tsx:203, 216), left over from the 33-tick JS parser.
11. **The spectator tip panel stays up** until pointer lock is acquired (10).
12. **Unsupported map** (pl_vigil_rc10 smoke run): a blocking `alert()`, a black void, and the
    default RTS framing far away from the players.

**Perf** (GPU egl, 1600×900, tick 21000, production build):

| state | fps | frame ms avg / p95 | draw calls / triangles |
|---|---|---|---|
| paused, RTS | 60.1 (vsync) | 16.6 / 16.7 | 299 / 830k |
| 1× playback, RTS | **32.5–33.8** (2 runs) | 29.6–30.7 / 33.4 | 296 / 812k |
| 1× playback, POV medic@red | **34.8** | 28.7 / 33.4 | 183 / 672k |

During 1× playback the main thread is saturated. When paused, 32 % of profile samples sit in the
native `now` frame (the main thread waiting for the next frame); during playback that drops to
1.2 %, and frames grow from 16.7 to about 30 ms. The extra time is React work per tick, so the
CPU is the bottleneck, not the GPU. Top self time, from the unminified profile in
`$S/baseline/perf-top.txt`:
- **`KillRow` 11.6–11.8 % + native `URL` 5.9–6.2 %** (+ `ClickableName`/`FilterButton` ~2 %). The
  *closed* MatchKillfeedPanel re-renders all 211 rows every tick, and each row builds a `new URL`
  for its icon (§10).
- react-dom reconciliation (`cj`/`Bj`/`Ik`/`Vk`/`Ej`) ~13 %.
- The r3f reconciler and `applyProps` (`Nf2`/`equ`) ~6 %.
- drei `Clone`/`createSpread` (the PlayerModel subtree per actor), tailwind-merge `cn`, and
  `getObjectByProperty` (heal-target lookup).

Parser memory and timing in the browser:

| demo | projectile cache | player cache | parse | transfer |
|---|---|---|---|---|
| 1438891 | 205 MB (164 slots) | 24 MB | 1.8 s | 0.63 s |
| 1442753 (ashville) | 332 MB (239 slots) | 27 MB | 2.1 s | 0.65 s |

Browser PSS is about 1.4 GB, with a JS heap of 347–441 MB.

---

## 2. Boot and demo-load sequence

1. `main.tsx` renders `<App/>` in `React.StrictMode` and imports the bridge.
2. `App.componentDidMount` (App.tsx:23-48) runs these steps in order:
   1. `loadSettingsAction`: localForage `settings`, deep-merged into the defaults.
   2. `loadSetupsAction`.
   3. `bootstrapSharedSetupFromHashAction` (`#setup=`).
   4. `resolveUrlDemoAction` (`?demo=<demos.tf id>` / `?demoUrl=` / `&tick=`; `embed.ts`).
   5. `loadEmptySceneMapAction(map)`: bounds come from `conversion.json` `worldBounds`, else
      `OVERWRITE_MAP_BOUNDARIES`; it alerts when neither exists.
   6. `setState({isReady})` → `ViewerPage` → `DemoViewer`.
   7. `loadUrlDemoAction`: axios download with the progress overlay, `parseDemoAction`, then
      `goToTickAction(tick)`.
3. `parseDemoAction` (actions.ts:55):
   1. Dispatches `PARSE_DEMO_INIT` and creates `new AsyncParser(buffer, onProgress)`.
   2. `cache()` (AsyncParser.ts:70) calls `getCachedData()`, which starts
      `new Worker(new URL('./ParseWorker.ts', import.meta.url), {type:'module'})` (:111) and posts
      the buffer as a **transfer**, detaching it on the main thread (:112-117).
   3. Worker:
      1. `init()` the wasm, then `parse_demo_cache_with_progress` (ParseWorker.ts:107), which posts
         `{progress}`.
      2. Hydrate the typed arrays into `PlayerCache`, an empty `BuildingCache` and
         `ProjectileCache` (:139-167).
      3. Re-base positions to the `OVERWRITE_MAP_BOUNDARIES` min if the map has an entry
         (:170-195).
      4. Build `entityPlayerMap` (:198-214).
      5. Post the result with all buffers in the transfer list (:271-284).
   4. Main thread: restore the cache class prototypes (AsyncParser.ts:128-130) and assign the
      fields (:72-84). **The worker is never terminated**, so its wasm memory stays allocated.
4. `PARSE_DEMO_SUCCESS`, then `loadSceneFromDemoAction` (actions.ts:89):
   1. Closes the About panel and merges bounds: conversion.json worldBounds + overrides +
      `parsedDemo.world`.
   2. `useInstance.setParsedDemo` (:108) and clears focus.
   3. Dispatches `LOAD_SCENE_FROM_PARSER`:
      - `scene`: players = entityPlayerMap, map, bounds, mode `rts`.
      - `playback`: `{playing: true, tick: 1, maxTicks: ticks-1, intervalPerTick}`.

---

## 3. Per-tick data flow and what re-renders

```
requestAnimationFrame ─ DemoViewer.animate (DemoViewer.tsx:630)
  ├─ playing: n = floor(elapsed / msPerTick); goToTickAction(tick + n)        (:640-644)
  │     └─ GO_TO_TICK (reducer.ts:92, clamp 1..maxTicks)
  │           └─ zustand listeners → DemoViewer.setState({playback}), setState({settings}) (:608-609)
  │                 └─ React re-renders the WHOLE DemoViewer tree (render :727-900)
  └─ useInstance.setFrameProgress(fraction 0..0.999, or 0 when paused) EVERY frame (:645/:647)
        └─ read inside useFrame via useInstance.getState(); no React render
r3f frame loop (frameloop 'always', also while paused):
  Controls.update · Actor / projectile / trail useFrame lerps · HealBeam uniforms ·
  drei Html positions · World cluster culling (disabled: src/constants/mapChunking.json) · gl.render
```

`DemoViewer.render` work per store change:
1. `renderTick = max(1, tick-2)` (:730-731).
2. `getPlayersAtTick(renderTick)` and `(renderTick+1)`, filtered to connected RED/BLU (:743-749).
   Joining by entityId gives `ActorProps = CachedPlayer + positionNext + viewAnglesNext` (:751-760).
3. Projectiles at `renderTick` and `+1`, and at `−1`/`+2` when 16 or fewer are alive (:762-789).
   `positionPrev`/`positionNext2` are never read downstream, so those two extra scans are wasted.
4. JSX: Canvas children (:805-847), HUD (:852-897).

**Any** store change (tick, download progress, event-history toast, drawing, settings)
re-renders all of DemoViewer. `src/` uses `React.memo` nowhere, so every child re-renders too:

| component | work per tick (9v9) |
|---|---|
| `Actors` → 18× `Actor` (Actors.tsx:84-285) | `new Vector3` allocations. A medic with a heal target triggers `scene.getObjectByName('actors')`, a depth-first walk through the whole map graph. `PlayerModel` → drei `Clone` re-renders the whole GLB node tree as r3f elements. The `<Html>` nameplate calls a **separate ReactDOM `root.render`** per actor (drei Html runs a layout effect with no deps) |
| `Projectiles` (Projectiles.tsx:512) | its effect rebuilds the trail `Map` and `setTrailTargets` re-renders whenever a trailable projectile exists (a second render per tick). One component per projectile, trail and explosion |
| `PlayerStatuses` | 2 sorts and 18 + 2 `StatusItem`s, each calling tailwind-merge `cn` |
| `Killfeed` | `for…in` over every death tick plus `inRange` (Killfeed.tsx:33-38) |
| `ChatHud` | backward scan of the chat list, cheap |
| `PlaybackPanel` | 9 Radix tooltip providers and the slider; also subscribes to `playback` |
| `PanelToolbar` → Settings / About / Setups / **MatchKillfeed** / Bookmarks | `TogglePanel` keeps children mounted while closed (`display:none`, TogglePanel.tsx:90-130), so **all MatchKillfeed rows re-render every tick**, each building `new URL(...)` for its icon (MatchKillfeedPanel.tsx:189-191) |

`useInstance` (`focusedObject`, `parsedDemo`, `frameProgress`, …) re-renders only subscribers
whose selected value changed. `frameProgress` changes every frame, so never select it in a
component.

**Rule for new code:** per-frame visuals read caches inside `useFrame` through refs. Do not
create React state that changes per tick. Select primitives from stores. Wrap new heavy
components in `React.memo` with cheap props such as `renderTick` and ids.

---

## 4. Data layer

### 4.1 What the committed parser2 produces and what is used

Hydrated in `ParseWorker.ts` (wasm types at :12-52). "player" is the parser player index; "slot"
is a projectile slot.

| field | per | storage | resolution | frontend | encoding |
|---|---|---|---|---|---|
| `playerCache.position` | player | `Uint32Array[3·ticks]` | 1 tick | `PositionCache` | i32 fixed-point `(src − boundaryMin)·positionScale` (1024 in this binary; 32 is the fallback); `(0,0,0)` means no sample |
| `playerCache.viewAngles` | player | `Uint32Array[3·ticks]` | 1 | `ViewAnglesCache` | x = pitch, y = yaw (degrees)·`angleScale` 256; z unused |
| `health` | player | `Uint16Array[ticks>>2]` | 4 | `HealthCache` (sparse 2) | 0 unless alive |
| `meta` | player | `Uint8Array[ticks>>6]` | 64 | `PlayerMetaCache` (sparse 6) | class (low nibble) \| team<<4 |
| `connected` | player | `Uint8Array[ticks>>4]` | 16 | `SparseDataCache(…,4)` | 0/1 |
| `uber` | player | `Uint16Array[ticks>>4]` | 16 | `SparseDataCache` | medigun charge 0..100 (integer) |
| `healTarget` | player | `Uint16Array[ticks>>4]` | 16 | `SparseDataCache` | heal target **entity id**, 0 = none |
| `activeWeaponDef` | player | `Uint16Array[ticks>>4]` | 16 | **not hydrated** | item definition index → `src/constants/items.json` (tf2-reference §11). **Unreliable:** in 1438891 the share of alive samples with a nonzero def ranges from 0 to 98 % per player. 6 of 18 players are always 0 (RED demoman, both snipers, RED scout, BLU pyro, BLU medic) and 3 more are at most 3 % (both heavies, BLU spy). The rest: RED spy 98 %, BLU scout 87 %, soldiers 76–86 %, RED pyro 79 %, RED medic 78 %, BLU demoman 68 %, engineers 14–54 %. Viewmodels and medigun types need the extras parser (`tools/awd-coverage.mjs`) |
| `duck` | player | `Uint8Array[ticks]` | 1 | **not hydrated** | bit0 `FL_DUCKING`, bit1 `FL_ANIMDUCKING` |
| `projectileCache.ids` | slot | `number[]` | – | `projectileIds` | entity id of the slot; a reused entity id shares the slot |
| projectile `position` / `rotation` | slot | `Uint32Array[3·ticks]` | 1 | `VectorCache` | as players; rotation degrees·256 |
| projectile `team` / `type` | slot | `Uint8Array[ticks>>6]` | 64 | `SparseDataCache(…,6)` | 2/3; 1 rocket (incl. `CTFProjectile_SentryRocket`), 2 pipe, 3 sticky, 4 healing bolt; **0 = anything else, dropped** in `ProjectileCache.getProjectile` (:43-68) |
| `deaths`, `rounds`, `chat` | – | JSON | events | `AsyncParser` fields | §4.4 |
| `shots` | – | `[{tick, playerId, weaponDefIndex}]` | events | **ignored** | projectile-spawn events only (no hitscan). 1500 in 1438891: def 0 (unknown) 451, 513 The Original 421, sticky launchers 421, 19 grenade launcher 201, 18 RL 6, and 6 attributed to SourceTV (`tools/shots-probe.mjs`) |
| `startTick`, `startDemoTick`, `endTick`, `endDemoTick`, `tickBase*` | – | numbers | – | **dropped** by ParseWorker | keep them for extras alignment (§5) |

`BuildingCache` is legacy JS-parser code. It is always empty because the wasm has no building
data, has type errors, and should be replaced rather than revived. `ChunkedArray` is dead code.

### 4.2 Sparse encodings

- `SparseDataCache.getOffset = (tick >> shift)·valuesPerPlayer + offset` (SparseDataCache.ts).
- The parser writes every tick of a window into the same slot (`CacheBuilder::set_sparse_*`,
  `dribble-parser/src/lib.rs`), so slot `i` holds the **last** sample of
  `[i·2^s, (i+1)·2^s−1]`. Values therefore appear up to `2^s−1` ticks early: class and team up
  to 63 ticks, uber/healTarget/connected/activeWeaponDef up to 15, health 3.
- Arrays have length `ticks >> s` (floored), so the last partial window reads `undefined`:
  - `meta`: class 0 / team 0, so **every player vanishes for the last < 64 ticks** (ticks
    54400–54441 in 1438891).
  - `health`: `undefined`.
- `getRespawnTick` (PlayerCache.ts:45-70) scans the health cache forward and memoizes per
  `(player, tick>>2)` in a `Map` that grows while scrubbing.
- For new data, use dense per-tick arrays for anything continuous (aim, cloak alpha, charge),
  sparse arrays only for slowly changing enums, and sorted event arrays plus binary search for
  events.

### 4.3 Indices and coordinates

- **Player index** = parser `players[].id` = key of `entityPlayerMap` (0..`nextMappedPlayer−1`,
  including SourceTV and spectators). `getPlayersAtTick` iterates in that order. `CachedPlayer`
  carries `user.entityId` but no index, so build an entityId → index map once.
- **Scene position = Source position − `parsedDemo.world.boundaryMin`.**
  - When the map has an `OVERWRITE_MAP_BOUNDARIES` entry, ParseWorker re-bases every position to
    that entry's min and overwrites `world.boundaryMin` (:170-195). koth_product_final uses the
    `koth_product_rc8` entry through `getMapBasename`.
  - So `parsedDemo.world.boundaryMin` is always the right offset. New world-space data
    (buildings, cart, CP origins, sniper dots) must subtract it, or go through the same
    `shiftVectorCache` in the worker.
  - Note that `shiftVectorCache` skips `(0,0,0)` triplets.
- Z is up (`THREE.Object3D.DEFAULT_UP=(0,0,1)`, DemoViewer.tsx:65); units are Hammer units. The
  map GLB group is rotated `[π/2,0,0]` and offset from the bounds (World.tsx:330-341).
- Cache tick `i` ↔ server tick `startTick + i` ↔ demo tick `startDemoTick + i`. To convert
  networked `SendPropTime` floats use `serverTick·intervalPerTick` (tf2-reference §1.2).

### 4.4 Events and their consumers

- **`deaths`**: `{ [tick: string]: CachedDeath[] }` (AsyncParser.ts:6-15).
  - `CachedDeath = {tick, victim: PlayerRef, killer: PlayerRef|null, assister: PlayerRef|null, weapon, victimTeam, killerTeam, assisterTeam}`.
  - `PlayerRef = {user: {name, userId, steamId, entityId, team, classes}}`.
  - `weapon` is the kill-icon name (`tf_projectile_rocket`, `sniperrifle`, `obj_sentrygun3`,
    `deflect_promode`, …).
  - Team fields come from the **end-of-demo** user table (`users_by_id` in lib.rs), so killfeed
    colours are wrong for anyone who changed team.
  - There are no death flags (feign death, domination, revenge), no crit flag and no customkill
    (headshot, backstab).
- **`rounds`**: `[{winner:'red'|'blue', length: seconds, endTick}]`, ends only. PlaybackPanel
  places round starts at the previous `endTick + 300` and drops the last round (:108-127).
- **`chat`**: `[{tick, kind, rawText, clientEntityId, clientPlayerId}]`.
  - `kind` ∈ `TF_Chat_All`, `TF_Chat_Team`, `TF_Chat_AllDead`, `TF_Chat_Team_Dead`,
    `TF_Chat_AllSpec`, `NameChange`, `Empty`.
  - `rawText` carries `\x01..\x08` colour codes. ChatHud parses them and colours the name by the
    player's team at the message tick.

Consumers:

| consumer | data it uses |
|---|---|
| Killfeed (Killfeed.tsx:25-66) | deaths with `deathTick ≤ playback.tick < deathTick+200`; highlights the focused player as killer or assister |
| MatchKillfeedPanel (:62-68) | `getAllKills` + `getUberPops` (uber drops from ≥95 to <95 on a medic, at 16-tick resolution) + `annotateKillstreaks` (10 s grace) from `utils/matchEvents.ts:38-148`. Seeks to `tick − killfeedSeekBuffer·tickRate` and jumps to the clicked player's POV |
| PlaybackPanel | rounds |
| ChatHud (:154-179) | last 8 lines within 12 s |

---

## 5. Adding a per-tick data source (worker → cache → getter → component)

CONTEXT.md settled the approach: a second wasm module (`parse_demo_extras`) in its own worker,
loaded progressively after the base demo is viewable. Recipe:

1. **Buffer.** The base worker detaches `fileBuffer`, so copy it before creating `AsyncParser`
   in `parseDemoAction` (actions.ts:59): `const extrasBuffer = fileBuffer.slice(0)`. The copy
   costs about 20 ms and 47 MB. To avoid two wasm heaps at peak, start the extras worker after
   `parsedDemo.cache()` resolves.
2. **Worker:** `src/highlander/extras/ExtrasWorker.ts`, modelled on ParseWorker.ts:
   - `import init, { parse_demo_extras } from '../../libs/<extras>/<name>.js'`. Vite bundles the
     worker through `new Worker(new URL(...), {type:'module'})` and the wasm through
     wasm-bindgen's `new URL('<name>_bg.wasm', import.meta.url)`, with no plugin.
   - Apply the same boundary shift to world-space arrays: move `shiftVectorCache` and the
     override logic (ParseWorker.ts:170-195) into a shared helper.
   - Post typed arrays with their buffers in the transfer list.
3. **Loader:** `loadExtras(buffer, parsedDemo)`.
   - Create the worker, post `{buffer}` with `[buffer]` and forward progress.
   - On the result, restore the class prototypes (`Object.setPrototypeOf`, as in
     `PlayerCache.rehydrate`), then **`worker.terminate()`**.
   - Never reject into the base flow. Log the error and set `extrasStatus: 'error'`.
4. **Alignment check.** Require `extras.startTick === base startTick`, the same
   `players[].id → entityId` mapping, and `extras.ticks ≤ parsedDemo.ticks`. The committed base
   binary covers 93 more ticks than the public fork. On a mismatch, warn and disable extras.
   `AsyncParser` does not keep `startTick`/`startDemoTick`/`tickBase` today; add them to
   `WasmResult` (ParseWorker.ts:39-52), the posted object (:253-268), `CachedDemo`
   (AsyncParser.ts:31-46) and `cache()` (:72-84).
5. **Store.**
   - Add `extras?: HighlanderExtras`, `extrasStatus: 'idle'|'loading'|'ready'|'error'` and
     setters to `InstanceState` (store.ts:35-78, 85-126). Do not put them in the Redux store:
     devtools would choke on the typed arrays.
   - Clear them in `loadSceneFromDemoAction` and `loadEmptySceneMapAction` next to
     `setParsedDemo` (actions.ts:108, 163).
   - Components use `useInstance(s => s.extras)` and re-render once when the extras arrive.
6. **Getters** are pure functions of `(playerIndex | entityId, tick)`, for example
   `extras.cloakAlpha(index, tick)` or `extras.buildingsAt(tick)`. Scene layers call them with
   `renderTick` (`playback.tick − 2`). HUD may use `playback.tick` as Killfeed does, but
   `renderTick` keeps the HUD in sync with the scene. Effects from events derive from
   `renderTick − eventTick`, never from wall-clock state.
7. **Hydrating existing base fields** needs no wasm change:
   - `activeWeaponDef`: `SparseDataCache(ticks, 1, 16, 4)`.
   - `duck`: `SparseDataCache(ticks, 1, 8, 0)`, or a plain dense getter.
   - `shots`: pass it through like `chat`.

   Touch points: the `WasmPlayerCache` type (:12-20), assignments after :151, the transfer list
   (:271-282), `PlayerCache` constructor/rehydrate (PlayerCache.ts:34-43, 91-102), and a getter
   or `getPlayer` (:72-89). Keep heavy per-player extras out of `getPlayer`, because it runs
   38×/tick.
8. **Debug bridge:** expose `getExtras()` / `extrasAt(tick)` so plans can assert data, e.g.
   `"eval": "window.__dribble.extrasAt(30000)"`.

---

## 6. Scene layer

### 6.1 Actors (Actors.tsx)

- `Actors` (:84-94) renders `<Actor key={`actor-${index}`}>`, keyed by **array index**.
  - When the connected RED/BLU set changes (disconnect, team change, substitute), React reuses
    Actor instances for different players.
  - Per-actor refs (last good angles, stale guard, smoothed position) leak across players.
  - `focusedObject`, the actor's THREE.Group, starts belonging to another player, so **POV
    silently switches**.
  - Fix: key by `user.entityId`. This is a prerequisite for any per-player effect state.
- Tree:
  - `group "actor"` (userData = UserInfo with `entityId`), with children:
    - `group "playerBody"`: yaw-only quaternion. Inside it, `PlayerModel` loads
      `/models/players/<class>_<team>.glb` (Draco) and renders `Clone`; `visible = alive &&
      !isFocusedPOV`.
    - `group "playerAim"` at z = `ActorDimensions.z` = **83**: full view quaternion. Holds
      `POVCamera` ("povCamera").
    - `HealBeam`: world-space shader from `actorPos + 41.5` to the target's actor position.
    - drei `<Html>` `Nameplate`, hidden for the POV player (:265-282).
- Interpolation (:148-221):
  - When paused or `interpolateFrames=false`, positions are set directly, which is
    deterministic.
  - Otherwise the actor lerps toward `positionNext` with `frameProgress`, through
    `guardedLerpProgress` (geometry.ts:176-205), plus exponential smoothing (τ 40 ms position,
    30 ms rotation). A jump over 4096 u counts as a teleport.
- Class or team change remounts the model through a 10 ms `changing` flag (:227-231).
- **Materials are shared.** drei `Clone` shares geometries and materials across every actor of
  the same class+team (`deep` unset). Cloak, uber or burning tints must clone materials per
  actor, use an overlay mesh, or use per-object uniforms.
- `ActorDimensions = (49,49,83)`. TF2 hulls are 48×48×82 (62 ducked). Eye heights: scout 65;
  soldier, demoman, pyro and engineer 68; sniper, medic, heavy and spy 75; ducked 45.

### 6.2 Projectiles (Projectiles.tsx)

- Components by type: rocket (`rocket_shared.glb`, oriented with `lookAt` toward its previous
  position), pipebomb and stickybomb (team GLBs, quaternion slerp), healingBolt (yellow
  sphere). All lerp `position → positionNext` with `frameProgress` plus 50 ms smoothing.
- Trails (:192-498): each trail target is an invisible Object3D that follows its projectile. When
  the projectile disappears, the target freezes in place and the trail decays.
  - Rockets get an instanced smoke ring buffer: 64 puffs, 800 ms life, a puff every 8 u.
  - Other types use drei `<Trail>` (MeshLine) with team colours; width depends on POV vs other
    modes.
  - Frozen trails expire after 1.5 s **of wall time**.
- Explosions (:599-627): a slot that disappears on a forward step of 1–3 ticks spawns a 200 ms
  additive sphere, also timed by **wall clock**.
  - Scrubbing clears trails and explosions.
  - Above 3 ticks per render (fast speed with low fps) explosions never spawn.
  - These effects are not seek-deterministic. New effects must use `renderTick − eventTick`.
- Adding types:
  - Base parser types live in `ProjectileTypeMap` (ProjectileCache.ts:15-20) and the component
    switch (Projectiles.tsx:651-668).
  - For extras-provided projectiles (arrows, flares, jars, cleavers, …), render them in a
    separate HL layer instead of growing this file.

### 6.3 World, Skybox, Lights, Stickers

- **World** (World.tsx):
  - Map model: `getMapModelUrls` → `/models/maps/<folder>/textured_compressed.glb`, with the
    folder from `MAP_NAME_SEARCH_MAP` (mappings.ts:52-66, substring match). Loaded by
    `GLTFLoader` without Draco or meshopt, so map GLBs must be uncompressed geometry.
  - Load setup: hides tool materials and `team_control_point*` nodes, freezes matrices, sets
    bounding volumes.
  - Cluster culling via `visibility.json` is disabled by `src/constants/mapChunking.json`.
  - `conversion.json` supplies `worldBounds` and `lightEnvironment` (Lights.tsx).
- **Skybox**: `MAP_SKYBOX_MAP` (mappings.ts:68-82) → 6 PNG faces, PMREM environment.
- **Stickers**: user annotations.
  - `utils/raycast.ts:getWorldIntersectionFromScreen` raycasts the whole `world` group.
  - That is fine for clicks, but too slow for per-frame sniper dots on a big map.
  - Per-frame dots need parser-provided endpoints (`env_sniperdot`, tf2-reference §5.2) or a BVH.
- **Map registration** (map agent): `MAP_NAME_SEARCH_MAP` and `MAP_SKYBOX_MAP` entries,
  optionally `OVERWRITE_MAP_BOUNDARIES` (MapBoundaries.ts:8-93; camera offset, RTS centre), and
  `public/models/maps/<folder>/{textured_compressed.glb, conversion.json[, visibility.json]}`.

---

## 7. Camera modes and POV

- `ControlsMode` is `'rts'|'pov'|'spectator'` (types.ts:17-23), stored at
  `scene.controls.mode`.
- Mode changes: `changeControlsModeAction`, `jumpToPlayerPOVCamera`, `jumpToSpectatorCamera`
  and `jumpToRtsCamera` (actions.ts:184-300); keys `1`, `Shift+1`, `2`, `3`
  (CanvasKeyHandler.tsx:78-96). `CHANGE_CONTROLS_MODE` disposes the previous controls
  (reducer.ts:52-74).
- `Controls` (DemoViewer.tsx:105-367):
  - Owns the `freeCamera` and attaches `RtsControls` (orbit/pan/zoom around `target`) or
    `SpectatorControls` (pointer-lock fly camera).
  - When `focusedObject` changes, it makes `focusedObject.getObjectByName('povCamera')` the r3f
    default camera (:129-136).
  - When the mode or last POV changes, it places the free camera relative to the last POV's
    view, or at the map default (:139-191).
  - It also hosts the saved-setup camera bridge (:214-312).
- **POV:**
  - `jumpToPlayerPOVCamera(entityId)` finds the scene actor by `userData.entityId`, then sets
    `focusedObject` + `lastFocusedPOV` and mode `pov`.
  - The camera is the actor's `povCamera` at playerAim, 83 u above the feet, using
    `settings.camera` (fov 90 vertical, near 0.1, far 15000). There are 18 such cameras, one per
    actor.
  - The POV player's model and nameplate are hidden.
  - HUD reacting to POV: `FocusedPlayer` (name, health, respawn countdown), `Crosshair` (POV
    only, `settings.ui.crosshair`), the PlayerStatuses outline, the Killfeed highlight.
  - POV order on `1`: team, then `CLASS_ORDER_MAP`; it skips nothing (dead players included).
- **Viewmodel hook:** attach to `focusedObject.getObjectByName('povCamera')` from a separate
  layer.
  - Render it with its own camera and cleared depth (tf2-reference §10.4: viewmodel fov 54,
    converted to vertical fov).
  - Move the POV medic's heal-beam origin to the viewmodel muzzle.
  - Re-root the POV camera at the class eye height (+ duck), which needs `classId` and `duck`
    per actor.

---

## 8. HUD

### 8.1 PlayerStatuses at 9 per team

- Layout:
  - Two absolute columns (BLU left, RED right) inside `ui-layer items-center`
    (DemoViewer.tsx:878-886), so they are vertically centred.
  - Each `StatusItem` is `w-52`×`h-9`. The root font size is 14 px from 1024 px viewport width
    (`clamp(8px, 1.5vw, 14px)` below that, index.scss), so a row is 182×31.5 px, with a 1.5 px
    gap.
  - Medic "Charge" rows follow a 7 px spacer.
  - 9 + 1 rows ≈ 337 px per column: y≈192–528 at 720p, 282–618 at 900p, 372–708 at 1080p.
  - A killfeed line is ≈42 px (`py-2` + `mb-2` + 21 px text), which is where the overlap figures
    in §1.7 come from.
- Sorted by `CLASS_ORDER_MAP` (scout → spy). In HL each class appears once per team, so rows are
  stable. Keys are indexes, which is fine for DOM.
- Mobile: a 32 px bottom strip with 9 cells per half, each ≈ 1/9 of half the width. Unreadable
  at 9v9.
- What breaks at 9v9: see §1.7 items 1–5.
- Suggested direction: compact rows (24–28 px), a top-aligned column under the toolbar
  (`top: 15rem`) with the killfeed capped or moved, opaque row backgrounds, a medigun/uber
  sub-row with type and state, and room for per-class status icons (sentry, cloak, charge,
  stickies).

### 8.2 Other HUD pieces

- **Killfeed** (Killfeed.tsx):
  - Top-right; no line cap on desktop (3 on mobile); 200-tick linger (:13).
  - Each line is about 42 px. Icons come from `src/assets/kill_icons/<weapon>.png` through
    `KILL_ICON_ALIASES`, falling back to skull.
- **MatchKillfeedPanel**: §4.4. This is the per-tick perf hazard from §3.
- **PlaybackPanel**: hides itself while playing unless hovered; slider; round chips; bookmarks;
  speed (0.1–3×); "TICK" ×2 bug.
- **ChatHud**: bottom-left, 8 lines / 12 s; hidden on mobile.
- **FocusedPlayer**: bottom-centre at 20 vh, POV only.
- **Crosshair**: centre, POV only.
- **CameraTipPanels**: bottom-right; visible 2 s after a mode change, and in spectator mode
  until pointer lock.
- **Layering:** `.ui-layer` has z-index 2e9, so it is always above drei Html nameplates (z-index
  up to 16.7 M).
- **FpsCounter** (bottom-right, `settings.ui.showStats`) is outside `.ui-layer`.

---

## 9. Settings

- **Defined in** `StoreState.settings` (store.ts:165-208); defaults in `initialState.settings`
  (store.ts:253-299).
- **Persisted:**
  - `UPDATE_SETTINGS_OPTION` (reducer.ts:117-125) runs lodash `set(clone(settings), path, value)`
    and writes the whole settings object to localForage key `settings` on every change.
  - `loadSettingsAction` (actions.ts:453-468) deep-merges the saved object into the defaults, so
    new default keys appear automatically for existing users.
  - Mobile forces `scene.mode = untextured`.
- **Changed through** `updateSettingsOptionAction('a.b.c', v)` and
  `toggleSettingsOptionAction('a.b')` (actions.ts:470-525); keyboard toggles live in
  CanvasKeyHandler.tsx:62-77 (`m`, `n`, `o`).
- **Rendered by** SettingsPanel sections (Camera :190, Scene :268, Players :308, Crosshair :351,
  Drawing :419, Misc :455) using local, unexported `Option`/`SliderOption`/`ToggleOption`
  (:33-152).
- **Pitfall:** `clone` is shallow, so a nested change mutates the existing nested object in
  place. A selector like `useStore(s => s.settings.ui.crosshair)` returns the *same* reference
  after an update and does not re-render. Existing components only work because DemoViewer
  re-renders everything. **Select primitives** (`s => s.settings.highlander.viewmodel.enabled`)
  or the top-level `s.settings`.
- **Recommended shape:**

  ```ts
  // src/highlander/settings.ts
  export type HighlanderSettings = {
    viewmodel: { enabled: boolean; fov: number; minimal: boolean }
    hud: { compactStatuses: boolean; killfeedMaxLines: number; objectiveHud: boolean }
    nameplates: { maxDistance: number; declutter: boolean; showClassIconsOnly: boolean }
    effects: { cloak: boolean; disguise: 'true' | 'enemy-view'; conditions: boolean; sniperDots: boolean; buildings: boolean }
  }
  export const DEFAULT_HIGHLANDER_SETTINGS: HighlanderSettings = { /* … */ }
  ```

  Wire it once:
  - `settings.highlander: HighlanderSettings` in the type (store.ts:165-208) and the defaults
    (store.ts:253-299).
  - `<HighlanderSettingsSection />` inserted in SettingsPanel before "Misc" (:455).
  - Move `Option`/`SliderOption`/`ToggleOption` to `src/components/UI/Shared/SettingsOptions.tsx`
    so feature sections can reuse them.

---

## 10. Performance: existing tricks and known hazards

Existing tricks:
- Parsing:
  - parser2 wasm in a worker; typed arrays posted zero-copy (ParseWorker.ts:271-284).
  - Sparse caches for slowly changing data.
- Playback and interpolation:
  - `renderTick = tick − 2` interpolation delay; `frameProgress` lives in the instance store and
    is read inside `useFrame`.
  - The stale-frame guard (geometry.ts:176-205).
  - Multi-tick advance at high speed (DemoViewer.tsx:640-644).
- Rendering:
  - DPR capped at 1.25 (:734-735).
  - Map: tool materials hidden, static matrices frozen, bounding volumes and frustum culling;
    optional BSP-cluster chunk culling (off).
  - Rocket smoke drawn as one `InstancedMesh` per trail.
  - GLB cache (`useGLTF`, `THREE.Cache.enabled`).
- Instrumentation: `?perf=true` (`[Perf]` every 5 s, `PerfProbe` reads `gl.info`) and
  `[Perf][ParserCache]` timings and sizes.

Hazards, ordered by measured or likely cost at 9v9:
1. **Whole-tree re-render per tick** (§3). Cheapest fixes:
   - Mount MatchKillfeedPanel rows only when the panel is open, and memoize rows with a
     precomputed icon URL. That alone removes about 18–20 % of main-thread time during
     playback.
   - `React.memo` `PlayerModel` (props team, classId, visible) so drei `Clone` stops re-rendering
     the GLB node tree.
   - Pass the nameplate an object of primitives and memo it; or drop drei `Html` for one canvas
     or CSS overlay updated in `useFrame`.
   - Keep `PanelToolbar` out of the per-tick path (memo or move it out of DemoViewer).
   - Subscribe `PlaybackPanel` to `playback.tick` only where needed.
2. Heal-target lookup traverses the scene graph from the root per medic per render
   (Actors.tsx:142-146). Use a `Map<entityId, Object3D>` maintained by Actors.
3. Projectile scans: `getProjectilesAtTick` walks every slot (164–239) 2–4× per render, and the
   prev/next2 data is unused.
4. **Projectile cache memory**: dense `slots × ticks × 24 B`, 205–332 MB for these demos, 10×
   the player cache. Extras should store projectiles as spawn/despawn ranges.
5. The base parse worker is never terminated (wasm heap retained).
6. r3f `frameloop` is `'always'`, so it re-renders at 60 fps while paused. Consider `'demand'`
   plus `invalidate()` when paused, if effects allow.
7. Trails and explosions use wall-clock time (not seek-deterministic).
8. `getRespawnTick` cache `Map` grows with scrubbing; Killfeed scans all deaths per tick.

---

## 11. Registration points (file:line)

| what | where |
|---|---|
| New **scene layer** (inside `<Canvas>`) | DemoViewer.tsx:843-847: add after `<Projectiles …/>`, before `</Canvas>` at :848. `renderTick` is in scope (:731) |
| **Per-actor** visuals (cloak, disguise, duck, conditions) | Actors.tsx:234-283 (`<group name="actor">` children); `PlayerModel` :60-76; `POVCamera` :289-312; key fix at :90 |
| Viewmodel / POV-camera attachments | `focusedObject.getObjectByName('povCamera')` (DemoViewer.tsx:131); `Actors.tsx:247-255` (`playerAim`, eye height) |
| Heal beam origin / medic visuals | Actors.tsx:142-146, 259-261; HealBeam.tsx:112-161 |
| New **projectile types** | ProjectileCache.ts:15-20 (type map), Projectiles.tsx:651-668 (component switch), :36-47 (trail config), :599-627 (explosions) |
| New **HUD widget** | DemoViewer.tsx:858-897 (`ui-layers`), after the FocusedPlayer block (:888-894), before `<PanelToolbar>` (:896). POV-only widgets: `FocusedPlayerLayer` (:502-518). Centre overlays: :854-856 (Crosshair layer) |
| Left **toolbar panel** | DemoViewer.tsx:521-565 (`PanelToolbar`, desktop offsets mt-16/28/40/52); `UIPanelType` types.ts:69-77 |
| PlayerStatuses / Killfeed / PlaybackPanel | PlayerStatuses.tsx:24-138 (layout), :198-199 (sizes), :224 (medigun TODO); Killfeed.tsx:13, :25-66; PlaybackPanel.tsx:34, :108-127, :203, :465 |
| **Settings** | store.ts:165-208 (type), :253-299 (defaults); SettingsPanel.tsx:455 (insert a section before Misc), :33-152 (option components); CanvasKeyHandler.tsx:33-98 (hotkeys) |
| **Data**: base fields | ParseWorker.ts:12-20 (types), :139-152 (hydrate), :170-195 (boundary shift), :253-284 (post + transfers); PlayerCache.ts:34-43, :72-89, :91-102; AsyncParser.ts:31-46, :48-63, :70-107, :142-167 |
| **Data**: extras worker start | actions.ts:55-83 (`parseDemoAction`: copy the buffer before :59, start after `cache()` at :64 or after `loadSceneFromDemoAction` at :76) |
| Instance store (extras, status) | store.ts:35-78 (type), :85-126 (impl); reset at actions.ts:108-111 and :163-166 |
| **Maps** | mappings.ts:52-82; MapBoundaries.ts:8-93; `public/models/maps/<folder>/` |
| Class constants | mappings.ts:1-38 (`HEALTH_MAP`, `CLASS_MAP`, `CLASS_ORDER_MAP`), :40-45 (`TEAM_MAP`) |
| Kill icons | `src/assets/kill_icons/*.png`, constants/killIconAliases.ts; weapons: `src/constants/items.json` (`i` key) |
| Match event list | utils/matchEvents.ts:91-148 (`getAllKills`, `getUberPops`) |
| Debug probes | src/utils/debugBridge.ts (`bridge` object), registered at src/main.tsx:7 |

---

## 12. Recommended scaffold for parallel work

The orchestrator should land one small scaffold commit. After it, feature agents only touch
their own files and the shared files stay stable.

```
src/highlander/
  settings.ts                 HighlanderSettings + DEFAULT_HIGHLANDER_SETTINGS
  extras/
    types.ts                  shared contracts: HighlanderExtras interface, event/enum types
    ExtrasWorker.ts           parser agent
    loadExtras.ts             buffer copy, worker, alignment check, useInstance.setExtras
    getters.ts                pure (index|entityId, tick) accessors used by layers and HUD
  scene/
    HighlanderScene.tsx       ROOT scene layer: React.memo({renderTick}); mounts the layers below
    actorFx.ts                registry: Map<entityId, ActorHandles> filled by Actor (scaffold edit 3)
    layers/BuildingsLayer.tsx       engineer
    layers/ObjectivesLayer.tsx      cart, control points
    layers/ProjectilesExtraLayer.tsx arrows, flares, jars, cleavers, balls, syringes
    layers/SniperLayer.tsx          dots, scope glint
    layers/PlayerFxLayer.tsx        cloak, disguise, uber/crit tint, burning (via actorFx)
    viewmodel/ViewmodelLayer.tsx    attaches to the focused povCamera; own scene + camera
  hud/
    HighlanderHud.tsx         ROOT HUD: React.memo({tick, renderTick}); mounts widgets
    widgets/ObjectiveHud.tsx, widgets/RoundTimer.tsx, widgets/MedicPanel.tsx, …
  settings/HighlanderSettingsSection.tsx
```

One-time edits in the scaffold commit, each a few lines:
1. `store.ts`: `settings.highlander` in the type and defaults; `extras`, `extrasStatus` and
   setters in `InstanceState`.
2. `DemoViewer.tsx`: `<HighlanderScene renderTick={renderTick} />` after `<Projectiles/>`
   (:847), and `<HighlanderHud tick={playback.tick} renderTick={renderTick} />` before
   `<PanelToolbar/>` (:896).
3. `Actors.tsx`:
   - Key by `user.entityId` (:90).
   - Register `{group, body, aim, entityId}` in `actorFx` on mount and unregister on unmount, so
     layers can find a player's nodes without traversing the scene.
   - Read the eye height from a helper (`eyeHeight(classId, ducked)`) instead of the constant 83
     (:247).
4. `SettingsPanel.tsx`: insert `<HighlanderSettingsSection/>` before Misc and move the option
   components to `UI/Shared/SettingsOptions.tsx`.
5. `actions.ts`: copy the buffer and call `startHighlanderExtras(buffer, parsedDemo)` after the
   scene loads; reset extras in both scene-load actions.
6. `ParseWorker.ts` / `AsyncParser.ts`: keep `startTick`, `startDemoTick`, `tickBase` and
   `positionScale`; hydrate `activeWeaponDef`, `duck` and `shots`.
7. `debugBridge.ts`: `getExtras()` / `extrasAt(tick)`.

Suggested file ownership after the scaffold:

| owner | files |
|---|---|
| parser/extras | `extras/*`, `src/libs/<extras>/`, ParseWorker/AsyncParser base-field hydration |
| buildings / objectives / projectiles / sniper | their `scene/layers/*.tsx` |
| spy / conditions | `PlayerFxLayer.tsx`, `actorFx.ts` (read-only for others) |
| viewmodels | `viewmodel/*` (+ POV eye height in Actors via the scaffold helper) |
| HUD | `hud/*`, plus the 9v9 rework of PlayerStatuses.tsx / Killfeed.tsx / MatchKillfeedPanel.tsx (one agent owns those three) |
| maps | mappings.ts, MapBoundaries.ts, `public/models/maps/*`, scripts/ |
| perf | DemoViewer re-render structure (after the scaffold lands, to avoid conflicts) |

Every layer:
- reads `useInstance(s => s.extras)` once and returns null until it is ready;
- does per-frame work in `useFrame` with refs;
- is seek-deterministic (pure in `renderTick`);
- respects its own `settings.highlander.*` primitive;
- ships with a harness plan under `$H/plans/` plus a bridge probe.

---

## 13. Frontend items that are easy to forget

Game-side gaps are in tf2-reference §13. Viewer-side:
- **POV correctness:**
  - class eye heights and duck (data already in the base output);
  - the POV medic's beam origin;
  - a dead-POV policy (stay, follow the killer, or go to free cam);
  - the index-keyed `Actors` bug that switches POV when someone disconnects or a substitute
    joins, which is common in HL pugs;
  - field of view: `settings.camera.fov` (90) is a three.js *vertical* FOV, about 121°
    horizontal at 16:9. TF2's fov 90 is horizontal at 4:3, which is 73.7° vertical
    (tf2-reference §10.4), so POV looks much wider than in game;
  - `POVCamera` uses `near 0.1` with `far 15000`, a 1.5e5 depth ratio that invites z-fighting on
    distant map geometry (the free camera uses near 10).
- **Spectator mouse-look on Linux Chrome:** `requestPointerLock({unadjustedMovement:true})`
  rejects with `NotSupportedError` on Linux Chromium (SpectatorControls.js:151). Retry without
  options. The user is on Arch Linux.
- **Killfeed:**
  - team colours come from end-of-demo teams;
  - no feign-death filtering (Dead Ringer shows up as real deaths once death flags exist);
  - no crit, headshot or backstab icons;
  - no building-destroyed or capture lines.
- **Active weapon:** the base `activeWeaponDef` is always 0 for a third of the players and
  partial for most others (§4.1), so viewmodels, medigun type and weapon-dependent HUD must take
  the active weapon from the extras parser.
- **End of demo:** all players vanish in the last < 64 ticks (§4.2).
- **Clock and tick display bugs** (`09:60`, TICK ×2). A round clock, setup time and overtime
  need timer entities (tf2-reference §12).
- **Unsupported maps:** replace the blocking `alert()` with an in-app notice and keep playback
  usable without geometry. Choose the RTS framing from player positions when no override
  exists.
- **Stopwatch maps** (pl_*, cp_steel) swap sides between halves. Colour by team per tick, not
  by `user.team`.
- **9v9 layout at 720p and mobile:** the status strip, killfeed cap, and toolbar overlap.
- **Memory:** projectile cache size, the un-terminated worker, and two wasm heaps if the extras
  parse runs concurrently with the base parse.
- **Draco decoder from gstatic:** offline or blocked networks get no player models. Consider
  vendoring `draco/gltf` into `public/` and calling `useGLTF.setDecoderPath`.
- **Determinism for sharing:** saved setups and `?tick=` links expect the same view after a
  seek, so new effects must not depend on wall time or playback history.
