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
  plans/1438891-baseline.json   the baseline plan (koth_product, 15 shots)
  plans/smoke-gen.mjs   writes the smoke plans
  tools/                run comparison, pixel diff, contact sheets, GPU probe, base-parser stats
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
3. A browser. The harness looks in `$PLAYWRIGHT_BROWSERS_PATH` and `~/.cache/ms-playwright` and takes the
   newest `chromium_headless_shell-*`, then the newest `chromium-*`. To install the one that matches the pinned
   playwright-core:

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
| `--perf-play <spec>` | | `tick:seconds[:mode[:player[:speed]]]`, e.g. `50%:10:rts`; speed 0 measures paused. Writes `perf.json` |
| `--cpu-profile` | off | with `--perf-play`: CDP CPU profile, `perf.cpuprofile` and `perf-top.txt` |
| `--rebuild` | off | build even when the cached build is fresh |
| `--no-build` | off | reuse the cached build even when it is stale |
| `--no-minify` | off | unminified build in its own cache entry, for readable profiles |
| `--build-cache <dir>` | `$DRIBBLE_HARNESS_BUILDS`, else `<root>/node_modules/.cache/dribble-harness` | build cache |
| `--browser <shell\|chrome\|path>` | `$CHROME_PATH`, else shell, else chrome | `shell` and `chrome` pick the newest Playwright headless shell or chromium |
| `--gpu <egl\|vulkan\|swiftshader>` | `egl` | WebGL backend, see GPU backends |
| `--keep-default-map` | off | load the boot map GLB too (normally stubbed with an empty GLB) |
| `--allow-network` | off | let the page reach hosts other than 127.0.0.1 |
| `--query <a=1&b=2>` | | extra URL query parameters, repeatable (e.g. `hlExtrasBudget=1`) |
| `--init-script <file>` | | script that runs in the page before the app, repeatable |
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

## Smoke plans

```sh
node scripts/hl/harness/plans/smoke-gen.mjs ../runs/plans            # all plans, or name some: 1434434 sample
node scripts/hl/harness/shot.mjs --demo ~/demo_tool/demos/1434434.dem --plan ../runs/plans/smoke-1434434.json \
  --out ../runs/smoke-1434434
node scripts/hl/harness/summarize.mjs ../runs/smoke-1434434
```

Each smoke plan waits for the extras, records an extras status step, sweeps every probe except the slow and
side-effecting ones at 40 % (on 1438891 also at 75 % in POV), and takes RTS and POV shots with probe reads.
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

`manifest.json`:

```
root, demo                     checkout and demo paths
header                         { server, map, game, duration, ticks } from the demo header
viewport                       { width, height }
startedAt, finishedAt          ISO times
browser                        { executablePath, gpu, renderer }
loaded                         { atSec, state, memoryMB } when the demo and map were ready
shots[]                        one entry per step:
  index, step                  position and the step as written in the plan
  tick                         resolved playback tick
  modeResult                   { ok, scene } or { ok: false, error }
  cameraApplied                true when the step's camera was applied
  eval                         the eval result
  state                        { playback, scene, perf } after settling
  players                      listPlayers() after settling
  file                         screenshot path (absent with screenshot: false)
  error                        why the step failed
perf                           with --perf-play: { spec, summary, frames } (same as perf.json)
memoryMB                       { peak, final } PSS of the browser process tree in MB, sampled every second
warnings[]                     failed steps, unresolved players, network never idle, dialogs, a map that did not load
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
| `hl.probes()` | names of the registered probes (59 at b6688f4) |
| `hl.probe(name, ...args)` | runs a probe |
| `hl.at(tick?)` | the `players.at` probe |
| `hl.findTicks(kind, { limit = 20, player, team })` | cache ticks where something happens |
| `hl.cameraNear(entityId, tick?, distance = 350)` | an RTS pose behind and above a player, for `camera` |

Probes return the values a feature draws at a tick, so plans can check data instead of pixels. At b6688f4:
`actors.registry`; `buildings.at`, `.draw`, `.of`, `.scene`, `.summary`, `.tracerMuzzle(row)`, `.track`;
`combat.critGlow`, `.fx`; `extras.plan`, `.summary`, `.restart`, `.load`, `.call`; `eyeHeight.at`;
`fx.actor(entityId)`, `.frameCache`, `.overlays`, `.plates`; `hud.layout`, `.rows`, `.scoreboard`,
`.snapshotStats`; `killfeed.lines`; `map.meta`, `.nodes`, `.propInstances`, `.props`, `.status`;
`mapdyn.kits`, `.markers`, `.movers`, `.moving(tick?, floors?)`, `.pickups`, `.slabs`, `.state`, `.summary`,
`.surface`; `nameplates.cap(bool)`, `.declutter`; `objective.hud`; `objectives.scene`; `players.at`;
`pov.hud`, `.state`, `.wallDistance`, `.wallScan`; `projectiles.at`, `.landed`, `.meshes`, `.source`,
`.trails`; `scope.state`; `sniper.dots`; `stopwatch.games`; `timeline.markers`; `viewmodel.debug`, `.state`.
`extras.restart`, `extras.load`, `extras.call` and `viewmodel.debug` change state; `pov.wallScan` and
`pov.wallDistance` are slow. `hl.probes()` is the authoritative list.

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
the extras memory plan skip or exclude groups).

## GPU backends

| `--gpu` | Chromium flags | result on the Radeon 680M machine |
|---|---|---|
| `egl` (default) | `--use-gl=angle --use-angle=gl-egl --enable-gpu` | ANGLE on radeonsi through `/dev/dri/renderD128`, renderer `ANGLE (AMD, AMD Radeon 680M (radeonsi rembrandt ACO), OpenGL ES 3.2)`, 60 fps (vsync cap) |
| `vulkan` | `--use-angle=vulkan --enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan --enable-gpu` | ANGLE on RADV |
| `swiftshader` | `--use-angle=swiftshader --enable-unsafe-swiftshader` | CPU rendering on every core, 1 to 6 fps |

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

## Comparing two runs

```sh
node scripts/hl/harness/tools/compare-runs.mjs ../runs/baseline-before ../runs/baseline-after [outDir] \
  [--threshold 24] [--max-pct <p>] [--cols 2] [--tile 400x225] [--no-diff-tile] [--no-sheet]
```

It compares the two manifests path by path (every key and value type, array indices included), lists per step
the tick, render tick, camera mode, focused player and whether the eval result and player list are identical,
and pixel-diffs every screenshot pair. It writes `<name>-diff.png` per changed shot (B dimmed, changed
pixels magenta), `compare.json`, and `sheet.png` with A, B and the diff side by side for each step. outDir
defaults to `<runB>-vs-<runA name>`. Exit code 1 means the structure differs, or with `--max-pct` that a shot
changed more than p percent.

A pixel counts as changed when one of its channels moves by more than the threshold (24 of 255). Read a result
like this:

- the structure must be identical and every step's tick, mode and focus equal, or the runs did not do the same
  thing;
- changed pixels that lie only on heal beams or the corner FPS counter are noise, whatever the percentage;
- anything else is a real change. Open the `-diff.png` (or `sheet.png`) for every shot above about 0.01 %
  before calling it noise.

`tools/imgdiff.mjs <dirA> <dirB> <outDir> [threshold]` is the pixel diff alone (same diff images and
`diff.json`). `tools/sheet.mjs <out.png> <cols> <image | folder>... [--tile 640x360]` tiles one run's shots
into a contact sheet. The image tools use the app's `sharp`. The two that draw text labels (`compare-runs.mjs`
and `sheet.mjs`) run themselves again as a child with sharp's fontconfig warnings filtered out of stderr.

## Tools

| tool | use |
|---|---|
| `summarize.mjs <run>...` | summary of one or more runs |
| `tools/compare-runs.mjs` | two runs: structure, steps, pixels, side-by-side sheet |
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
  `DRIBBLE_HARNESS_BUILDS`), and `--out` to a folder next to the checkout. The browser is auto-detected
  (`--browser` also takes a path; `CHROME_PATH`).
- New: `--check`, `--init-script` (what B2's private copy did with `B2_INIT_SCRIPT`), `--min-available`,
  `--wait-available`; `--load-timeout` is now listed in the help; `-h` works.
- Unknown options, missing values, bad ticks, modes, sizes or `--perf-play` specs, and malformed plans fail
  before the lock and the build. A repeated `--query` now adds its parameters.
- The ancestor-lock check compares flock's own lock file by inode. The old check matched any argument ending in
  `heavy.lock`.
- Smoke plans are named `smoke-<demo>.json` (were `m3-`), and the probe sweep no longer reports `map.props`
  as `ERROR: null`.
- The manifest format is unchanged.
