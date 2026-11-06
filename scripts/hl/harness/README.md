# Headless validation harness

`shot.mjs` builds a dribble.tf checkout, serves the build and a local `.dem` file on 127.0.0.1, opens the
viewer in headless Chromium and drives it through the debug bridge (`window.__dribble`). For each plan step it
seeks, switches the camera, runs an optional page expression and saves a screenshot. Every run writes
`manifest.json` and `console.log`; with `--perf-play` it also measures frame rate and memory. It takes a lock
so heavy runs never overlap, and it always shuts down its server and browser.

The Highlander tasks used this harness from a session scratchpad. This folder is the durable copy. Every path
resolves from the checkout that contains it, so it runs from the main checkout, from a git worktree, or
against another checkout with `--root`.

```
scripts/hl/harness/
  shot.mjs              the harness
  build-child.mjs       vite build of a checkout, run by shot.mjs in a child process
  summarize.mjs         one-screen summary of a run (port of the merge runs' summ.py)
  lib/setup.mjs         checkout paths, lock, playwright-core and browser lookup
  lib/images.mjs        the app's sharp and the pixel diff, for scripts that import them
  plans/1438891-baseline.json   the baseline plan (koth_product, 15 shots)
  plans/smoke-gen.mjs   writes the smoke plans
  lib/perf-analysis.mjs frame statistics, trace and CPU profile breakdowns
  lib/system-sampler.mjs Radeon, CPU clock, power and per-thread CPU telemetry of a perf window (read only)
  tools/                run comparison, perf matrix, pixel diff, contact sheets, GPU probe, base-parser stats
  package.json          pins playwright-core 1.64.0 for this folder only
```

## Setup

Linux only. The memory sampler reads `/proc` and the lock uses `flock` from util-linux. Node 20 or newer.

1. App dependencies. The build uses the checkout's own `node_modules` (vite, three). The main checkout has them
   installed from the frozen `yarn.lock`. A worktree without `node_modules` gets a symlink to the main
   checkout's folder on the first run.
2. playwright-core, once per checkout. It goes into `scripts/hl/harness/node_modules`, which git ignores, and it
   leaves the app's dependencies and lockfile alone:

   ```sh
   npm install --prefix scripts/hl/harness --no-package-lock
   ```

   A worktree without its own copy uses the main checkout's `scripts/hl/harness/node_modules`.
3. A browser. The harness looks in `$PLAYWRIGHT_BROWSERS_PATH` and `~/.cache/ms-playwright` for the
   revision that the installed playwright-core lists in its `browsers.json` (1248 for 1.64.0): first
   `chromium_headless_shell-<revision>`, then `chromium-<revision>`. Only when neither is there does it take
   the newest `chromium_headless_shell-*`, then the newest `chromium-*`, and it says so: the run logs a
   warning naming both revisions and adds it to the manifest's `warnings`, and `--check` prints it. So a
   newer Playwright installed later for another project does not change the browser behind two runs that
   get compared. To install the expected one:

   ```sh
   node scripts/hl/harness/node_modules/playwright-core/cli.js install chromium-headless-shell
   ```

   `--browser <path>` or `CHROME_PATH=<path>` uses any other Chromium build.
4. Check the result. `--check` prints the resolved root, build cache, lock, playwright-core and browser, and
   exits 1 with the fix for anything missing:

   ```sh
   node scripts/hl/harness/shot.mjs --check --demo ~/demo_tool/demos/1434434.dem
   ```

A run without playwright-core or a browser stops before taking the lock and prints the install command.

## Running

```sh
# baseline plan on this checkout
node scripts/hl/harness/shot.mjs --demo ~/demo_tool/demos/1438891.dem \
  --plan scripts/hl/harness/plans/1438891-baseline.json --out ../runs/baseline

# a worktree, two ticks, RTS and the POV of the blue medic
node scripts/hl/harness/shot.mjs --root ../dribble.tf-wt/x2 --demo ~/demo_tool/demos/1438891.dem \
  --ticks 7700,30000 --modes rts,pov --pov medic@blue --out ../runs/x2-medic

# frame rate for 12 s of 1x playback from tick 21000, with a CPU profile that keeps function names
node scripts/hl/harness/shot.mjs --demo ~/demo_tool/demos/1438891.dem --ticks 21000 --modes rts \
  --perf-play 21000:12:rts --cpu-profile --no-minify --out ../runs/perf-21000

# a big demo: wait up to 10 minutes for 3000 MB of free memory, skip the run otherwise (exit code 75)
node scripts/hl/harness/shot.mjs --demo ~/demo_tool/demos/1429417.dem --min-available 3000 --wait-available 600 \
  --ticks 10%,62% --modes rts --out ../runs/tetsudo
```

A run prints one line per shot, then the console error count and the manifest path. Exit code 0 means the run
finished; a failed step is recorded in the manifest and in `warnings`, and does not stop the run. Exit 1 means
a setup or load failure, 2 a usage error, 75 a closed memory gate, 124 the hard timeout, 130 an interrupt.

## Options

`node scripts/hl/harness/shot.mjs --help` prints the same list. An unknown option, a missing value or a stray
argument stops the run with a usage error before anything is built.

| option | default | meaning |
|---|---|---|
| `--root <dir>` | the checkout holding the harness | checkout or worktree to build and serve |
| `--demo <file.dem>` | required | local SourceTV demo |
| `--plan <file.json>` | | JSON array of steps (see Plans); replaces `--ticks`, `--modes`, `--pov` |
| `--ticks <list>` | `10%,50%,90%` | playback ticks or percentages, comma separated or repeated |
| `--modes <list>` | `rts,pov` | any of `rts`, `pov`, `spectator` |
| `--pov <list>` | `auto` | POV players (see player selectors) |
| `--out <dir>` | `<root>/../<root name>-harness-out/<demo>-<UTC time>` | output folder |
| `--size <WxH>` | `1600x900` | viewport |
| `--hide-hud` | off | hide the React HUD layers (`.ui-layers`) in every shot |
| `--settle-ms <n>` | 700 | wait before each shot |
| `--settle-frames <n>` | 8 | animation frames to wait before each shot |
| `--perf` | off | open with `?perf=true` so the app logs `[Perf]` lines |
| `--perf-play <spec>` | | `tick:seconds[:mode[:player[:speed]]]`, e.g. `50%:10:rts`; speed 0 measures paused. Writes `perf.json`, see Perf window |
| `--quiet-cores <n>`, `--quiet-wait <sec>` | off, 30 | with `--perf-play`: wait before the window until other processes use at most n cores over a second, at most that long, then measure anyway; `perf.json` records it as `quiet` |
| `--gpu-timer` | off | with `--perf-play`: time each `renderer.render()` with `EXT_disjoint_timer_query_webgl2`; `perf.json` gets `gpuTimer` |
| `--cpu-profile` | off | with `--perf-play`: CDP CPU profile, `perf.cpuprofile` and `perf-top.txt` |
| `--trace` | off | with `--perf-play`: a Chromium trace of the measured seconds, `perf-trace.json`, and `perf-trace.txt` with the busy ms per frame of the renderer main thread, the compositor and the GPU process main thread, the renderer main thread by category (scripting, style, layout, paint, commit, GC), and self time by event; `perf.json` gets the same as `trace`. A 5 s trace is about 60 MB |
| `--rebuild` | off | build even when the cached build is fresh |
| `--no-build` | off | reuse the cached build even when it is stale |
| `--no-minify` | off | unminified build in its own cache entry, for readable profiles |
| `--source-map` | off | with `--no-minify`: also write source maps, in its own cache entry; the build takes about 4 GB of memory |
| `--build-only` | off | build, or find the fresh cached build, under the lock and exit; needs `--demo` like a run |
| `--build-cache <dir>` | `$DRIBBLE_HARNESS_BUILDS`, else `<root>/node_modules/.cache/dribble-harness` | build cache |
| `--browser <shell\|chrome\|path>` | `$CHROME_PATH`, else the expected shell, then chromium, then the newest of each | `shell` and `chrome` pick the Playwright headless shell or chromium of the revision playwright-core expects, else the newest one (with a warning) |
| `--gpu <egl\|vulkan\|swiftshader\|default>` | `egl` | WebGL backend, see GPU backends |
| `--keep-default-map` | off | load the boot map GLB too (normally stubbed with an empty GLB) |
| `--allow-network` | off | let the page reach hosts other than 127.0.0.1 |
| `--query <a=1&b=2>` | | extra URL query parameters, repeatable (e.g. `hlExtrasBudget=1`) |
| `--init-script <file>` | | script that runs in the page before the app, repeatable |
| `--no-vsync` | off | uncapped frames: adds `--disable-gpu-vsync --disable-frame-rate-limit`; `manifest.browser.noVsync` and `perf.json` `spec.noVsync` record it |
| `--asset-pack <dir\|missing>` | | serve a TF2 asset pack at `/tf2-assets/` and build with `VITE_ASSET_PACK_URL=/tf2-assets/`; see Asset pack |
| `--timeout <sec>` | 900 | hard timeout for the whole run (exit 124) |
| `--load-timeout <sec>` | 300 | time for the demo to parse and the scene to switch to its map |
| `--lock <file>` | `$DRIBBLE_HARNESS_LOCK`, else `<os.tmpdir()>/dribble-heavy.lock` | lock that serialises heavy runs |
| `--no-lock` | off | do not take the lock (the caller holds it) |
| `--min-available <MB>` | | memory gate on `MemAvailable`, checked once the lock is held |
| `--wait-available <sec>` | 0 | how long to wait for the gate before giving up |
| `--check` | | print the resolved setup and exit |
| `--help`, `-h` | | print the option list |

In zsh, write `--query a=b` literally. A variable that holds `--query a=b` reaches the harness as one argument,
which it rejects as an unknown option.

## Lock, build cache and output folder

The harness re-runs itself under `flock <lock>` and prints `waiting for <lock>` while another run holds it.
It skips that step when an ancestor process is already `flock <lock> ...` on the same file, when
`--no-lock` is given, or inside its own re-run. Without `flock` on `PATH` it warns and runs unlocked. The
memory gate is checked after the lock is acquired, so the free memory it sees belongs to this run.

`os.tmpdir()` follows `TMPDIR`, so runs started with different `TMPDIR` values get different default locks.
Runs that must not overlap pass the same `--lock`, or export `DRIBBLE_HARNESS_LOCK`. The Highlander agents
shared the scratchpad's `heavy.lock` this way and also ran Node demo parses, `tsc` and `npm run build` under it.

The build cache holds one entry per checkout path: the first 12 hex digits of the SHA-1 of the checkout's real
path, plus `-nominify` for `--no-minify` builds. An entry is fresh while a fingerprint over `src/**` (path,
size, mtime) and the root config files matches, so editing any source file triggers a rebuild (about 13 s,
8.5 MB per entry). `public/` is served from the checkout and never copied. The build forces
`VITE_APP_ASSET_URL` to empty so every asset loads from the local server. In a worktree, `node_modules` is a
link to the main checkout's, so the default cache sits in the main checkout's
`node_modules/.cache/dribble-harness`; delete entries there to reclaim space.

The default output folder sits next to the checkout, never in `/tmp`. For `/work/dribble.tf` and demo
`1434434.dem` it is `/work/dribble.tf-harness-out/1434434-2026-10-18T06-15-45`.

## Plans

A plan is a JSON array of steps. Every field is optional.

```json
[
  { "name": "overview", "tick": "10%", "mode": "rts" },
  { "name": "blu-sniper", "tick": 24902, "mode": "pov", "player": "sniper@blue",
    "settings": { "ui.nameplate.enabled": false }, "eval": "window.__dribble.hl.probe('scope.state')" },
  { "name": "find", "tick": "5%", "screenshot": false, "eval": "window.__dribble.hl.findTicks('uber', { limit: 5 })" }
]
```

| field | meaning |
|---|---|
| `name` | file label: the shot is `NN-<name>.png` (NN = step index). Default `t<tick>-<mode>[-<player>]` |
| `tick` | playback tick as a number, or a percentage string of the demo such as `"50%"`. Default `"50%"`, clamped to 1 .. maxTicks |
| `mode` | `rts` (default), `pov` or `spectator` |
| `player` | POV player for `mode: "pov"`, see below. Default `auto` |
| `reset` | for `rts` and `spectator`: forget the last POV first. Default true |
| `settings` | object of dotted settings paths and values, the paths SettingsPanel uses (`ui.nameplate.enabled`, `highlander.enabled`, `highlander.players.cloak`) |
| `speed` | playback speed |
| `camera` | camera pose for `setCamera`, e.g. `{ "mode": "rts", "position": [x, y, z], "target": [x, y, z] }` in scene units |
| `play` | seconds of real time to play after seeking, then pause |
| `eval` | page expression. A returned promise is awaited; the JSON result goes to the manifest, a thrown error becomes `{ "error": "..." }` |
| `hideHud` | hide the HUD layers for this shot (default: `--hide-hud`) |
| `reload` | after applying `settings`, reload the page and wait for the demo again, for settings read once at load (`ui.antialias`, `highlander.enabled`) |
| `screenshot` | `false` skips the PNG; the state, players and eval are still recorded |

The harness logs a warning for any other field and ignores it.

Each step runs in this order: settings, speed, seek, camera mode, `camera`, `play`, `eval`, HUD hiding,
settle, state snapshot, screenshot. `eval` runs before the settle wait, so a panel it opens is in the shot.
Settling waits for network idle, `--settle-frames` animation frames, and `--settle-ms`, or 2.3 s after a camera
mode change so the camera tip panel has faded.

Ticks. Plan ticks are playback ticks. The scene draws cache tick `renderTick = playback tick - 2`, which the
manifest records per step. Probes and `hl.findTicks` return cache ticks, so add 2 before seeking to one. On
1434434, cache tick = demo tick - 94.

Player selectors, resolved among connected RED and BLU players at the step's tick:

- `auto`: the first alive player, RED before BLU, then scout, soldier, pyro, demoman, heavy, engineer, medic,
  sniper, spy;
- an entity id (`4` or `"4"`);
- a class with an optional team: `sniper`, `sniper@red`, `medic@blue`, `medic@blu`, `class:spy:red` (an alive
  player of that class wins);
- a name: exact first, then a substring, case-insensitive.

A step whose player does not resolve records `modeResult: { ok: false, error }` and a warning, and the shot is
taken anyway.

Finding interesting ticks takes two passes. Pass 1 asks the page:

```json
[
  { "name": "ready", "tick": "5%", "screenshot": false, "eval": "window.__dribble.hl.waitReady(90000)" },
  { "name": "find", "tick": "5%", "screenshot": false,
    "eval": "({ cloak: window.__dribble.hl.findTicks('cloak', { limit: 5 }), near: window.__dribble.hl.cameraNear(7, 3443) })" }
]
```

Pass 2 seeks to the returned cache ticks plus 2 and copies `cameraNear` results into `camera` fields. Steps
that check data also call the feature's probe in `eval`, so the manifest records what was drawn.

Plan gotchas:

- A camera set by `camera` or `setCamera` stays for later steps and for the perf pass. `reset: true` does not
  bring back the default RTS camera while the controls are already in RTS. Put default-view steps first, or
  reach the default camera from a POV step.
- Actors move 2 to 5 frames after a seek. Evals that read scene nodes should `await window.__dribble.frames(5)`.
- The first step can run before the player models load (`modelVisible: null` in `actors.registry`). Evals that
  check models should poll.
- The extras load after the base demo. Start a plan with a `hl.waitReady()` step before reading HL probes.
- An eval can switch the POV or camera itself (`await window.__dribble.setControlsMode('pov', { player: 7 })`)
  right before the shot.

## Asset pack

The asset phase (`specs/assets/contract.md`) loads TF2 content from a local pack folder, `/home/dalibor/tf2-pack`
by default, which `scripts/assets/` builds from the user's own VPKs. Production builds request nothing from it
unless `VITE_ASSET_PACK_URL` was set at build time (contract 3.2), so a harness run without `--asset-pack` builds
and behaves like the hosted site.

```sh
node scripts/hl/harness/shot.mjs --demo <demo.dem> --plan <plan.json> --asset-pack /home/dalibor/tf2-pack ...
node scripts/hl/harness/shot.mjs ... --asset-pack missing             # pack configured, but absent (404)
node scripts/hl/harness/shot.mjs ... --asset-pack <dir> --query assets=off   # pack present, disabled
```

- `--asset-pack <dir>` builds the checkout with `VITE_ASSET_PACK_URL=/tf2-assets/` and serves `<dir>` at
  `/tf2-assets/` by the rules of contract 3.3: GET and HEAD only (other methods 405), the resolved path, symlinks
  included, must stay inside the folder, and a missing file answers 404 `text/plain`, never `index.html`.
  A raw request path that starts with `/tf2-assets/` but leaves it through dot segments (`../`, `%2e%2e/`) also
  answers 404, although URL normalisation would turn it into another route; the check reads `req.url` as sent.
  Types: `.json` `application/json`, `.glb` `model/gltf-binary`, `.dds` `application/octet-stream`, `.webp`
  `image/webp`, anything else `application/octet-stream`; `Cache-Control: no-cache`. The folder must exist; a
  folder without a valid v1 `manifest.json` gives a warning, and the page sees what the server answers.
- `--asset-pack missing` (the literal word) builds the same way and answers 404 for every `/tf2-assets/` path.
- Without `--asset-pack`, the build gets no `VITE_ASSET_PACK_URL` (the harness removes one inherited from the
  shell) and `/tf2-assets/` paths answer 404 as well.
- The build cache keys an entry by checkout path and `VITE_ASSET_PACK_URL`: a pack build sits in
  `<key>-pack-<6 hex>`, next to the plain `<key>` entry, so the two variants never rebuild each other.
- The pack is served from its folder and is never copied into the build cache or the output folder. Screenshots
  of a run with a real pack show Valve content: keep them in the task's `-out` folder (contract 1.2).
- Before each step's settle wait, after its `eval`, the harness awaits the probe `assets.waitIdle(30000)` when the
  page registers it, and stores the result as the step's `assetsIdle`. A result other than `idle: true` adds a
  warning. A page without the probe (`a06e4c7` and older) gets `assetsIdle: null`.

## Smoke plans

```sh
node scripts/hl/harness/plans/smoke-gen.mjs ../runs/plans            # all plans, or name some: 1434434 sample
node scripts/hl/harness/shot.mjs --demo ~/demo_tool/demos/1434434.dem --plan ../runs/plans/smoke-1434434.json \
  --out ../runs/smoke-1434434
node scripts/hl/harness/summarize.mjs ../runs/smoke-1434434
```

Each smoke plan waits for the extras, records an extras status step, sweeps every probe except the slow and
side-effecting ones at 40 % (on 1438891 also at 75 % in POV), and takes RTS and POV shots with probe reads.
The sweep always reports `assets.status` and `assets.items`, as `absent` on a page without them, and skips
`assets.waitIdle`, which the harness awaits itself; the status step records both results under `assets`.
The plans are for 1438891 (koth_product, also run with `--perf-play 50%:10:rts`), 1434434 (pl_vigil, the
quickest), 1440442 (cp_steel), 1429417 and 1428628 (tow_tetsudo, both through the base-parser fallback, gate
3000 MB) and `sample` (`public/samples/i52_snakewater_gc.dem`, the bundled 6v6 demo). Their ticks and player
names belong to those demos.

`summarize.mjs` prints the load state, memory and warnings, then a line per step: probe errors for `sweep*`
steps, the extras status for the `status` step, and render tick, shot and eval for the rest. It ends with the
perf summary and the console's error lines, with the known noise counted apart. In a sweep, `fx.actor` and
`buildings.tracerMuzzle` always fail because they need an argument; the summary lists them as expected.

## Output

| file | content |
|---|---|
| `NN-<name>.png` | one screenshot per step |
| `manifest.json` | the run record, below |
| `console.log` | page console, page errors, failed local requests and dialogs: `<seconds>s <kind> <text>` |
| `build.log` | vite output, written when the run built |
| `perf.json` | with `--perf-play` |
| `perf.cpuprofile`, `perf-top.txt` | with `--cpu-profile`; open the profile in Chrome DevTools |
| `perf-trace.json`, `perf-trace.txt` | with `--trace` |

`manifest.json`:

```
root, demo                     checkout and demo paths
header                         { server, map, game, duration, ticks } from the demo header
viewport                       { width, height }
startedAt, finishedAt          ISO times
browser                        { executablePath, gpu, renderer, noVsync }
assetPack                      { dir, served, manifestSha256, fingerprint, generatorVersion }; every field null
                               without --asset-pack. dir is the folder or "missing", served is false for
                               missing; manifestSha256 hashes <dir>/manifest.json, fingerprint is its
                               builtFrom.fingerprint and generatorVersion its generator.version
requests[]                     every same-origin request of the page and its workers, one entry per method and
                               path (query kept), in order of first occurrence:
                               { path, method, status, type, count, failure }; status is the first response's
                               (null when none came), type Playwright's resource type, failure the network error
requestSummary                 { total, failed, byPrefix }: raw request counts; failed means no response, status
                               400 or more, or a network error; byPrefix counts by first path segment ("/assets/")
loaded                         { atSec, state, memoryMB } when the demo and map were ready
shots[]                        one entry per step:
  index, step                  position and the step as written in the plan
  tick                         resolved playback tick
  modeResult                   { ok, scene } or { ok: false, error }
  cameraApplied                true when the step's camera was applied
  eval                         the eval result
  assetsIdle                   the assets.waitIdle result, null when the page has no such probe
  state                        { playback, scene, perf } after settling
  players                      listPlayers() after settling
  file                         screenshot path (absent with screenshot: false)
  error                        why the step failed
perf                           with --perf-play: { spec, summary, frames, frameDeltas } (same as perf.json;
                               frameDeltas: every frame's ms, for histograms of the uncapped frame pacing)
memoryMB                       { peak, final } PSS of the browser process tree in MB, sampled every second
warnings[]                     failed steps, unresolved players, network never idle, dialogs, a map that did not load,
                               a browser revision other than the one playwright-core expects
perfLines[]                    console lines containing [Perf] or parser2:
```

`state` is `__dribble.getState()`: `ready`, `parser {status, progress, error?}`, `demo {map, ticks,
intervalPerTick, playerCount, deathCount, roundCount, chatCount}`, `playback {tick, renderTick, maxTicks,
playing, speed, intervalPerTick}`, `scene {map, controlsMode, focusedEntityId, lastFocusedEntityId, mapLoaded,
actorCount}`, `perf {renderCalls, renderTriangles, visibleChunkCount, currentCluster}` and `downloads`.
Player entries are `{index, entityId, userId, steamId, name, team, teamId, classId, className, health, alive,
connected}`.

`perf.summary` holds `fps`, `frameMs {avg, p50, p95, max}`, `ticksPerSecond` against
`expectedTicksPerSecond`, `longTasks {count, totalMs}`, `jsHeapMB {start, end}`, `browserMemMB {before, after,
peakSoFar}`, `renderCalls`, `renderTriangles` and, with a profile, the top self-time functions and scripts.

Before the steps, the harness waits for the parse to finish and the scene to switch to the demo's map, pauses
playback, waits for network idle, then waits up to 60 s for the map model (less when `mapStatus` reports the map
missing). Requests to other hosts are blocked except the Draco decoder, which is served from three's bundled
copy, so runs work offline. Map GLBs of other maps (the boot scene's) get an empty GLB.

## Debug bridge

`src/utils/debugBridge.ts` installs `window.__dribble` when the URL has `?debug=1` (the harness adds it) or
under the Vite dev server. Everything it returns is plain JSON.

| call | does |
|---|---|
| `getState()` | the state object above |
| `listPlayers(tick?)` | players at a cache tick (default renderTick) |
| `resolvePlayer(query)` | the player a selector resolves to |
| `frames(n)` | resolves after n animation frames |
| `goToTick(tick, { frames = 2 })` | seek to a playback tick |
| `setPlaying(bool)`, `setSpeed(n)` | play or pause (without the toast), playback speed |
| `focusPlayer(query)` | POV of a player |
| `setControlsMode(mode, { player, reset })` | `rts`, `spectator` or `pov` |
| `getCamera()`, `setCamera(pose)` | camera pose in the saved-setup format |
| `setSetting(path, value)` | a SettingsPanel option by dotted path |
| `stores.useStore`, `stores.useInstance` | the Zustand stores, for ad-hoc reads |
| `hl.status()` | `{ status, progress, error, meta }` of the Highlander extras (meta without convars) |
| `hl.waitReady(ms = 90000)` | resolves with `'ready'`, `'error'` or `'disabled'`, or the current status at the timeout |
| `hl.probes()` | names of the registered probes (65 with X2's `memory.*` probes) |
| `hl.probe(name, ...args)` | runs a probe |
| `hl.at(tick?)` | the `players.at` probe |
| `hl.findTicks(kind, { limit = 20, player, team })` | cache ticks where something happens |
| `hl.cameraNear(entityId, tick?, distance = 350)` | an RTS pose behind and above a player, for `camera` |

Probes return the values a feature draws at a tick, so plans can check data instead of pixels:
`actors.registry`; `buildings.at`, `.draw`, `.of`, `.scene`, `.summary`, `.tracerMuzzle(row)`, `.track`;
`combat.critGlow`, `.fx`; `extras.plan`, `.summary`, `.restart`, `.load`, `.call`; `eyeHeight.at`;
`fx.actor(entityId)`, `.frameCache`, `.overlays`, `.plates`; `hud.layout`, `.rows`, `.scoreboard`,
`.snapshotStats`; `killfeed.lines`; `map.meta`, `.nodes`, `.propInstances`, `.props`, `.status`;
`mapdyn.kits`, `.markers`, `.movers`, `.moving(tick?, floors?)`, `.pickups`, `.slabs`, `.state`, `.summary`,
`.surface`; `memory.base(tick?)`, `.digest(from?, to?)`, `.drawn`, `.projectiles`, `.release`, `.split`;
`nameplates.cap(bool)`, `.declutter`; `objective.hud`; `objectives.scene`; `players.at`;
`pov.hud`, `.state`, `.wallDistance`, `.wallScan`; `projectiles.at`, `.landed`, `.meshes`, `.source`,
`.trails`; `scope.state`; `sniper.dots`; `stopwatch.games`; `timeline.markers`; `viewmodel.debug`, `.state`.
`extras.restart`, `extras.load`, `extras.call`, `viewmodel.debug` and `memory.release` (it frees the base
projectile cache for good) change state; `pov.wallScan`, `pov.wallDistance` and `memory.digest` are slow. The smoke
sweep skips all of them. `hl.probes()` is the authoritative list.

`hl.findTicks` kinds: `cloak`, `decloak`, `disguise`, `disguising`, `feign`, `backstab`, `headshot`, `uber`,
`kritz`, `quickfix`, `vacc`, `crit`, `minicrit`, `burning`, `jarate`, `milk`, `marked`, `bonk`, `overheal`,
`teleportedGlow`, `stun`, `gas`, `banner`, `busiest`, `zoom`, `airblast`, `flamesOn`, `deflect`,
`buildStart`, `buildDone`, `upgrade`, `carry`, `redeploy`, `sapped`, `destroyed`, `teleported`, `wrangled`,
`proj:<kind>` (`proj:7` flares, `proj:8` arrows), `syringe`, `explosion`, `tracer`, `bullet`, `critBullet`,
`capStart`, `captured`, `capBlocked`, `capBroken`, `capping`, `cartMoving`, `cartReceding`, `overtime`,
`roundWin`, `roundStart`, `setupFinished`, `doorMove`, `pickupTaken`, `pickupBack`, `medicDrop`,
`respawnWave`, `medicCall`. Section 3.8 of `specs/highlander/contract.md` defines each. `busiest` returns
the earliest of the top windows first, not the busiest one.

Useful query parameters: `perf=true` (the app's `[Perf]` lines), `hlExtrasBudget=<MB>` (a small budget makes
the extras memory plan skip or exclude groups), `hlProjectileRelease=manual` (the base projectile cache stays
until the `memory.release` probe frees it, so one page can measure both sides). Without it the release lands
about 2 s after the extras are ready: a plan that reads `memory.projectiles` right after `hl.waitReady()` sees
`pending`.

## GPU backends

| `--gpu` | Chromium flags | result on the Radeon 680M machine |
|---|---|---|
| `egl` (default) | `--use-gl=angle --use-angle=gl-egl --enable-gpu` | ANGLE on radeonsi through `/dev/dri/renderD128`, renderer `ANGLE (AMD, AMD Radeon 680M (radeonsi rembrandt ACO), OpenGL ES 3.2)`, 60 fps (vsync cap) |
| `vulkan` | `--use-angle=vulkan --enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan --enable-gpu` | ANGLE on RADV |
| `swiftshader` | `--use-angle=swiftshader --enable-unsafe-swiftshader` | CPU rendering on every core, 1 to 6 fps |
| `default` | `--enable-gpu` | no ANGLE switch: what the browser picks by itself |

Every launch also passes `--enable-webgl --ignore-gpu-blocklist`, turns off background throttling and mutes
audio. The harness reads the WebGL renderer string from a probe page; when it says SwiftShader, or WebGL2 is
missing, it relaunches with `swiftshader` and logs the fallback. `manifest.browser` records the backend and
renderer, so check it before comparing frame rates. `tools/gpu-probe.mjs` tries four flag sets on each
installed browser and prints frame rate and renderer.

## Memory gates

Section 7.3 of the contract gates big demos on the `available` column of `free -m`. Swap on the development
machine is nearly full, so that column is the real headroom. Browser PSS seen in harness runs:

| demo | page memory |
|---|---|
| 1434434 (pl_vigil, 226 s) | about 0.95 GB |
| 1438891 (koth_product, 817 s) | 1.2 to 1.3 GB |
| 1428628 (tow_tetsudo, fallback) | peak 1.44 GB |
| 1437285, 1432698 (2041 s and 1557 s) | peak about 1.57 GB |
| 1429417 (tow_tetsudo, fallback, 130k ticks) | peak 1.69 to 1.75 GB |

Browser runs on 1428628, 1429417 and the long demos need 3000 MB available; runs that 7.3 marks "gated 1500"
(the Node extras checks on the big demos) need 1500. `--min-available 3000 --wait-available 600` applies the
gate inside the lock, and a closed gate exits 75 with nothing run; report such a run as skipped. The final
memory figure varies by about 120 MB between runs of the same code, so compare peaks.

## Known noise

Console lines that are not app errors (the harness still counts them in its error total):

- `reqfail http://127.0.0.1:<port>/models/maps/<map>/textured_compressed.glb net::ERR_ABORTED`, the stubbed
  boot map or a textured GLB the loader dropped;
- `reqfail .../models/players/<class>_<team>.glb net::ERR_ABORTED`, and the same for projectile models and
  map `world.glb` or `props.glb`.

`summarize.mjs` and `tools/compare-runs.mjs` count aborted `.glb` requests apart from app errors. A
`NotSupportedError` page error from spectator pointer lock and 404s for `map-meta.json` were real bugs, fixed
in F4 and X1.

Pixels that change between two runs of the same build:

- heal beams, which animate from wall-clock time, and the ÜBER READY pulse;
- the FPS counter in the bottom right corner.

On the baseline plan, two runs of the same build differ by 0.001 to 0.64 % of pixels per shot, the most in
the shots with heal beams (00, 01, 02, 14) and the beam line in 09. A beam that passes close to a POV camera
covers more of the screen: shot 07 of the 1434434 smoke plan changed by 1.7 % between two runs of the same
code, all of it beam and FPS counter.

## Perf window

`--perf-play` seeks, waits for the settle, 2.3 s for the camera tip panel and `assets.waitIdle`, then plays for the given
seconds. `perf.json` holds:

| field | content |
|---|---|
| `spec`, `modeResult`, `startState`, `assetsIdle` | what was asked, whether the camera mode took, the state at the start, the pack's idle result |
| `summary` | as before: `fps`, `frameMs {avg, p50, p95, max}`, ticks per second, long tasks, memory, render calls |
| `frameStats` | from `frameDeltas`: `fps`, `avg`, `p50`, `p95`, `p99`, `max`, `over20Pct`, `over34Pct` (shares of frames over 20 and 34 ms, one and two missed vsyncs) and `droppedVsyncPct` (vsyncs without a new frame) |
| `frameWork`, `frameDone` | per frame, the main thread's time from the frame's first rAF callback (`frameWork`) or from the vsync's timestamp (`frameDone`, so with the delay before the task could start) to the end of the frame's task (callbacks, style, layout, paint, commit), measured with a message posted from the rAF callback: `avg`, `p50`, `p95`, `p99`, `max`, `over16Pct`. Not quantized by vsync, so `frameWork` shows the margin to the 16.7 ms budget while fps sits at 60 |
| `renderInfo` | `renderer.info` of the r3f root twice a second: `calls`, `triangles` (`{n, avg, min, p50, p95, max}`), `rendersPerFrame` (1 means `info` covers the whole frame), `alive`, `focusedAlivePct`, and the raw `samples` with programs, geometries and textures |
| `system` | sampled at 10 Hz in the window only: `gpuBusyPct`, `sclkMhz` (active level of `pp_dpm_sclk`), `sclkActualMhz`, `cpuMhz` (mean `scaling_cur_freq`), `cpuMaxCoreMhz` (the fastest core), `gpuPptWatts`, `gpuTempC`, `batteryWatts`, `vramUsedMB`, `gttUsedMB`, each `{n, avg, min, p50, p95, max}`; `power` (`label` such as `battery/power-saver/3.2GHz`, AC, battery status and capacity, profile, platform profile, energy preference, CPU limit, `changed`); `cpuLoad` (busy cores of the system, of the browser and of everything else, plus `topOther`, the busiest other processes); `memory` (available MB at the start and the end, swap traffic and major faults of the whole system in the window); `processes` and `threads` (on-CPU and run-queue ms per frame and busy % per process type and thread, from `/proc/<pid>/task/<tid>/schedstat`, read at the start and the end) |
| `browserInfo` | `version`, `userAgent`; `canvas`: the app's WebGL context (renderer, attributes, `samples`, `maxSamples`, drawing buffer, `timerQuery`, `multiDraw`, every extension); `system`: CDP `SystemInfo` (`featureStatus`, `glRenderer`, `glImplementationParts`, the command line) |
| `gpuTimer` | with `--gpu-timer`: `sceneMs` per frame, `disjoint` and `pendingAtEnd` |
| `trace` | with `--trace`: `threads` (busy and CPU ms per frame per thread role), `rendererCategories`, `counts` |
| `distDir` | the build that ran, for source maps |
| `frames`, `frameDeltas` | every frame's ms |

The memory sampler pauses during the measured seconds, because its `smaps_rollup` walk takes each process's mmap
lock; the summary's memory figures come from samples right before and after. All of this exists only with
`--perf-play`, so a run without it keeps the manifest structure `compare-runs.mjs` checks. Telemetry reads
sysfs and `/proc` only and changes no setting; one 10 Hz sample costs about 2 ms in the harness's process, not the
browser's. Without an amdgpu card or a battery those fields are null.

`tools/perf-breakdown.mjs <run> [--profile-run <run>] [--top 30] [--out <file>]` prints the per-thread CPU table, the
trace's categories and, from a `--cpu-profile --no-minify` run, the top functions by self and inclusive time, with
native WebGL calls and garbage collection apart; with `--source-map` also self time per source group.

A full browser such as Brave runs like the shell with `--browser <path>`. The harness removes `DISPLAY` and
`WAYLAND_DISPLAY` from its environment and adds `--ozone-platform=headless`, so it cannot reach the desktop, and
Playwright gives it a throwaway profile under `TMPDIR`, never a user's. Its process singleton needs a socket path under
108 bytes, so a long `TMPDIR` is replaced for the browser by `~/.cache/dribble-harness-tmp`.

## Perf matrix

`tools/perf-matrix.mjs` runs scenario x checkout x repeat through `shot.mjs`, alternating the checkouts run by run
(A B A B) so that drift and the power state cancel, and writes `matrix.json` and `report.md` under `--out`: medians and
ranges per cell, A/B tables with the median of paired deltas and a noise verdict, the power state of every run, and the
run order. Scenarios live in `tools/perf-scenarios.json` (`--list` prints them; the lock and build cache default to
what that file names, or `--lock` and `--build-cache`).

```sh
# A/B of two checkouts on one scenario: 3 uncapped and 3 vsync runs each, 10 s windows, about 8 minutes
node scripts/hl/harness/tools/perf-matrix.mjs --quick test-rts --root before=<base checkout> --root after=<your worktree> --out <out>/ab-mychange

# the same with the user's likely settings, in POV
node scripts/hl/harness/tools/perf-matrix.mjs --quick test-pov-tf2 --root before=<base> --root after=<worktree> --out <out>/ab-mychange-pov

# the whole fixed set on one checkout, vsync and uncapped, 2 repeats
node scripts/hl/harness/tools/perf-matrix.mjs --scenarios tag:core --vsync on,off --repeats 2 --root base=<checkout> --out <out>/baseline

# a resolution sweep: one size per cell
node scripts/hl/harness/tools/perf-matrix.mjs --scenarios test-rts,test-pov --sizes 960x600,1280x800,1600x900,1920x1100 --vsync off --root base=<checkout> --out <out>/sweep

# the same checkout under two browsers, or with and without a setting, is an A/B too
node scripts/hl/harness/tools/perf-matrix.mjs --quick test-rts --root shell=<checkout> --root brave=<checkout>,browser=/opt/brave-bin/brave --out <out>/browsers
node scripts/hl/harness/tools/perf-matrix.mjs --quick test-rts --root on=<checkout>,set=highlander.players.xrayGlow=true --root off=<checkout>,set=highlander.players.xrayGlow=false --out <out>/glow
```

Each run's plan checks the settings paths, applies the scenario's settings, waits for the extras and the projectile
release, then plays the window once at 4x so everything that first appears in it has loaded and compiled (`warm: false`,
as in the scenario `test-rts-cold`, measures the first pass instead). Each run prints one line and leaves its outputs in
`runs/<cell>/<root>-r<n>/` (`shot.log`, `command.txt`, `plan.json`, `perf.json`, `manifest.json`, the one screenshot,
which shows pack content, so `--out` stays out of git). `perf-trace.json` goes after its summary unless `--keep-traces`.
A scenario in the file takes `demo`, `tick`, `mode`, `player`, `presets` and `settings`, `query`, `flags`, `browser`, `gpu`,
`init` (init scripts, relative to the file), `noPack`, `size`, `seconds`, `warm`, `minAvailable` and `extends`. `viewPresetChecks` warns when a settings preset drifts
from a checkout's `VIEW_PRESETS`.

Before the runs it builds each checkout once, so no measured run follows a build. Before each run it checks the battery
and stops at `--min-battery` (12 %) when discharging, exit 3; what finished stays in the report and `--resume` continues.
Before each run, with no browser up, it waits up to 120 s for other processes to use at most 2.5 cores
(`--pre-quiet-wait`, at most `--pre-quiet-budget` 1200 s over the matrix); before each window it waits up to 20 s more
(`--quiet-cores`, `--quiet-wait`) and notes a window that started without that.
A closed memory gate skips that run and the matrix goes on. The harness's memory gate defaults to 2500 MB (3000 on
1428628) with a wait of 900 s.

Read a report with the machine in mind. On battery in power-saver the package power limit couples CPU and GPU, and other
processes take from the same budget, so the columns `CPU MHz`, `sclk MHz`, `other cores` and `power` say which runs compare.
On AC a long session heats the package to 93 to 95 °C and the fastest core falls from 4.3 to 3.6 GHz, so two runs an hour
apart do not compare either. The A/B tables pair runs of one repeat and skip a pair whose power states differ. A run during
which other processes used more than 3.5 cores leaves the medians when its cell has a quieter run (the run order marks it
NOISY), and a window that measured no scene (the map never loaded, playback did not advance) is retried once and then
marked invalid. Vsync frame times are quantized, so use fps, the shares of frames over 20 and 34 ms and `frame work` there,
and the average on uncapped runs, whose frames come in short/long pairs. An A/A run of `--quick test-rts` on two checkouts
of the same code calls every metric noise; its ranges were 56.3 to 58.1 fps and 17.05 to 17.65 main thread ms/frame with
vsync, 55.4 to 59.8 fps and 16.8 to 18.2 ms uncapped.

Which browser. Use the headless shell (the default) for A/B runs and repeat a decision on Brave with
`--root <name>=<dir>,browser=/opt/brave-bin/brave`. Both are Chromium 156.0.8078 with the same WebGL backend, extensions and
MSAA (the GUI Brave's GPU process loads the same Mesa radeonsi GL libraries; headless Brave needs `--gpu egl`, the default,
because `--gpu default` falls back to SwiftShader there). Brave's main thread costs 7 to 9 % more on AC. Its headless
SwapBuffers blocks the GPU main thread for 4 ms a frame on AC and 9.5 ms on battery, and the shell's takes 0.07 ms. That
looks like a full frame readback, which a real display does not do, and it would become a false cap once the main thread
gets faster. Neither headless browser shows Hyprland's composition or a real Wayland swap.

Spectator scenarios stub the pointer lock (`tools/perf-no-pointer-lock.js`): headless Chromium answers it with 20 000
`WidgetInputHandler` messages a second, which keep the browser's main thread and the renderer's compositor thread busy.
A plain `--perf-play ...:spectator` run without the stub measures that storm too.

## Comparing two runs

```sh
node scripts/hl/harness/tools/compare-runs.mjs ../runs/baseline-before ../runs/baseline-after [outDir] \
  [--threshold 24] [--max-pct <p>] [--allow-request <key>]... [--cols 2] [--tile 400x225] [--no-diff-tile] [--no-sheet]
```

It compares the two manifests path by path (every key and value type, array indices included, except the
subtrees `assetPack`, `requests`, `requestSummary` and each step's `assetsIdle` and `eval`), compares the
request logs (below), lists per step
the tick, render tick, camera mode, focused player and whether the eval result and player list are identical,
and pixel-diffs every screenshot pair. It writes `<name>-diff.png` per changed shot (B dimmed, changed
pixels magenta), `compare.json`, and `sheet.png` with A, B and the diff side by side for each step (a step
that differs gets a red label). outDir defaults to `<runB>-vs-<runA name>`. The last lines of the output are
the warnings and the result, and `compare.json` holds them under `result`.

The exit code answers "did the two runs do the same thing?", like `diff`:

| exit | meaning |
|---|---|
| 0 | same demo header, viewport, manifest structure and request keys, and every step the same (below); with `--max-pct`, no shot changed more than p percent |
| 1 | something differs; each reason is listed under `result: DIFFERENT` |
| 2 | the runs could not be compared: a `manifest.json` is missing or unreadable, or `sharp` cannot be loaded |
| 64 | usage error |

A step is the same when both runs have the same step definition (the plan entry as written), tick, camera
mode, focused player and step error, and both or neither saved a screenshot that can be diffed. A step
without `play` must also have the same render tick and player list, which are pure functions of the demo
at that tick. A step with `play` runs on wall time, so its render tick and player list are printed but do
not count; such a step is marked `timed`. Differences in eval results, the browser, the WebGL renderer
and the console's app-error count are printed as warnings and leave the exit code alone. Eval results can
carry frame counts that change from run to run (`hud.snapshotStats` does), and the other three describe
the setup and the console rather than what the runs did. Read every warning anyway.

Requests follow the request-set rule of contract 5.1. Each logged path is reduced to its pathname, so the
query, and with it the page URL's `--query` additions, takes no part. Under `/assets/` only, Vite's content
hash becomes `[hash]` (`/assets/index-B-261qmv.js` is the key `/assets/index-[hash].js`), so a `src/` change
that renames every bundle compares equal; `/tf2-assets/` and every other path compare verbatim. Each side maps
a key to the number of distinct pathnames behind it, and the maps must be equal. A differing key is the failure
`requests differ: <key> <count A> -> <count B>`; `--allow-request <pathname or key>` (repeatable) leaves that
key out and lists it as an allowed difference among the warnings, as the N2 run (`--asset-pack missing`) does
for `/tf2-assets/manifest.json`. A request log in only one run is a failure; none in either (two runs of the
harness before the asset phase) is a warning. A different pack fingerprint, served flag or manifest hash is a
warning. `compare.json` holds the keys under `requests` and both `assetPack` records.

A pixel counts as changed when one of its channels moves by more than the threshold (24 of 255). Read a result
like this:

- exit 1 means the runs did not do the same thing (or a shot passed `--max-pct`): find out why before
  reading pixels;
- a warning about a different browser or WebGL backend means pixel and frame-rate differences can come from
  the browser, not the app;
- changed pixels that lie only on heal beams or the corner FPS counter are noise, whatever the percentage;
- anything else is a real change. Open the `-diff.png` (or `sheet.png`) for every shot above about 0.01 %
  before calling it noise.

`tools/imgdiff.mjs <dirA> <dirB> <outDir> [threshold]` is the pixel diff alone (same diff images and
`diff.json`). `tools/sheet.mjs <out.png> <cols> <image | folder>... [--tile 640x360]` tiles one run's shots
into a contact sheet. The image tools use the app's `sharp`. The files in `tools/` are command lines only;
a script that needs the pixel diff imports `diffPng` and `diffDirs` from `lib/images.mjs`. The two that draw text labels (`compare-runs.mjs`
and `sheet.mjs`) run themselves again as a child with sharp's fontconfig warnings filtered out of stderr.

## Tools

| tool | use |
|---|---|
| `summarize.mjs <run>...` | summary of one or more runs |
| `tools/compare-runs.mjs` | two runs: structure, requests, steps, pixels, side-by-side sheet; exit 0 when they did the same thing |
| `tools/perf-matrix.mjs` | scenario x checkout x repeat, alternating; medians, spreads, A/B deltas (see Perf matrix) |
| `tools/perf-breakdown.mjs <run>` | CPU per thread, trace categories, top functions and source groups of a run |
| `tools/imgdiff.mjs` | pixel diff of two folders |
| `tools/sheet.mjs` | contact sheet |
| `tools/gpu-probe.mjs [--browser ...]` | which WebGL flag sets give hardware rendering (launches Chromium 8 times) |
| `tools/demo-stats.mjs <demo> [parser2-dir]` | base-parser stats for picking ticks: killfeed peaks, projectile counts, uber pops, rounds |
| `tools/awd-coverage.mjs <demo>` | share of alive samples with an active weapon per player |
| `tools/medic-probe.mjs <demo> <tick>...` | medic charge and active weapon around ticks |
| `tools/shots-probe.mjs <demo>` | the base parser's `shots` per player and weapon |

The four base-parser tools parse the demo in Node with the committed `src/libs/parser2`, and `gpu-probe.mjs`
launches browsers, so run them under the same lock, e.g.
`flock /tmp/dribble-heavy.lock node scripts/hl/harness/tools/demo-stats.mjs <demo>`. Node prints a
`MODULE_TYPELESS_PACKAGE_JSON` warning on stderr when they load `parser2.js`; it is harmless, and stdout stays
clean JSON or text.

## Changes from the scratchpad copy

For anyone moving from `$S/harness/shot.mjs`:

- `--root` defaults to this checkout, the lock to `<os.tmpdir()>/dribble-heavy.lock` (`--lock`,
  `DRIBBLE_HARNESS_LOCK`), the build cache to `<root>/node_modules/.cache/dribble-harness` (`--build-cache`,
  `DRIBBLE_HARNESS_BUILDS`), and `--out` to a folder next to the checkout. The browser is auto-detected,
  preferring the revision playwright-core expects (`--browser` also takes a path; `CHROME_PATH`).
- New: `--check`, `--init-script` (what B2's private copy did with `B2_INIT_SCRIPT`), `--min-available`,
  `--wait-available`; `--load-timeout` is now listed in the help; `-h` works.
- Unknown options, missing values, bad ticks, modes, sizes or `--perf-play` specs, and malformed plans fail
  before the lock and the build. A repeated `--query` now adds its parameters.
- The ancestor-lock check compares flock's own lock file by inode. The old check matched any argument ending in
  `heavy.lock`.
- Smoke plans are named `smoke-<demo>.json` (were `m3-`), and the probe sweep no longer reports `map.props`
  as `ERROR: null`.
- The manifest format is unchanged. A browser revision other than the expected one adds an entry to
  `warnings`.
- Asset phase (A0-harness): `--asset-pack`, `--no-vsync`, the manifest fields `assetPack`, `requests`,
  `requestSummary`, `browser.noVsync` and per step `assetsIdle`, and the request comparison and
  `--allow-request` of `compare-runs.mjs`. A run of the older harness has no request log, so compare runs made
  by the same harness, as contract 5.1 asks (REF is this harness with `--root` at `a06e4c7`).
