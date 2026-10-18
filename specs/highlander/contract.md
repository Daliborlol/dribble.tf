# Highlander implementation contract

Version 2.3, 2026-10-18 (section 11 lists the amendments after the foundation merge, section 12 those after the feature wave, section 13 those after wave 2). This file is the binding contract for the Highlander (9v9) work in dribble.tf and
`../dribble-parser`. It was written from the four research documents in this folder, all of which were present:
`parser-probe.md`, `maps.md`, `tf2-reference.md` and `frontend.md`. It also reflects a read of the current code
(`dribble-parser/src/lib.rs`, the Analyse/Data layer, `store.ts`, `actions.ts`, `DemoViewer.tsx`, `Actors.tsx`,
`World.tsx`, `Lights.tsx`, `Projectiles.tsx`, `SettingsPanel.tsx`, `scripts/convert-bsp.mjs`). Version 2 applies the
first review. Section 10 lists the review points that were rejected or adopted in a different form, plus the open
questions that a task must answer by measurement.

How to use it:

- Every task in section 7 lists the files it owns. A task edits only those files. If it needs a change anywhere
  else, it stops and asks the orchestrator.
- Names, typed-array element types, bit numbers, sentinel values, settings keys and defaults written here are
  fixed. A task may add optional fields or new files inside its own folders. It may not rename or retype anything
  defined here.
- Where this file and a research doc disagree, this file wins. Where a line number here no longer matches the code,
  keep the intent and use the current line.
- `S` means `/tmp/claude-1000/-home-dalibor-programming-personal-dribble-tf/bbe6eb71-192d-40ae-b6da-70834234db27/scratchpad`.
  `H` means `$S/harness`. `REPO` means `/home/dalibor/programming/personal/dribble.tf`. `PARSER` means
  `/home/dalibor/programming/personal/dribble-parser`.

---

## 0. Decisions

| # | topic | decision | reason |
|---|---|---|---|
| D1 | game assets | None. Procedural placeholder geometry for buildings, cart, projectiles, viewmodels, pickups. Data embedded in the BSPs on disk (lightmaps, PAK skies) is allowed. | user decision |
| D2 | parsers | Keep the committed `src/libs/parser2` binary as the base parser. Add a second wasm module `hlextras` built from `PARSER` branch `highlander`, export `parse_demo_extras`, run in its own worker. | parser2 source is unpublished; rebuilding it would lose its 4x speed and extra fields |
| D3 | alignment | The frontend passes the base parse's `startTick`, `tickBase`, `ticks` and player entity list into `parse_demo_extras`. The extras never pick their own start tick in the browser. | alignment by construction instead of by hope |
| D4 | scheduling | The extras parse starts after the base parse resolves and after the base worker is terminated. Never concurrently. A new `parseDemoAction` cancels a running extras parse before it starts the next base parse. | two wasm heaps of 2x the file size each would not fit on this machine or on phones |
| D5 | maps | All 11 HL maps use the patched bsp-to-glb pipeline (`scripts/convert-bsp.mjs`). BSPSource, VMF and Blender are not used. `koth_product_final` keeps its textured GLB and only gains `map-meta.json`. | maps.md: 6 to 13 s per map, 1.4 to 4.4 MB per map, exact alignment |
| D6 | in-browser BSP conversion | Deferred. Not part of this contract. | all 11 maps ship pre-converted; 570 MB peak memory; 2 to 3 days |
| D7 | static props | Stock static props are not rendered, because their models are TF2 game assets (D1). Props whose models are embedded in the map's PAK are converted by task M2 (section 4.8). Before M1 merges, the orchestrator shows the user what missing props look like (section 7.1). | vigil has 1522 static props and 409 solid ones; only its 94 `props_vigil` instances are in the PAK |
| D8 | viewmodels | Procedural placeholders behind a `ViewmodelProvider` interface so a GLB provider can be added later. | D1 |
| D9 | disguise view | `players.disguiseView` default `'auto'`: in POV, spies show as the POV player would see them (`'pov'`); elsewhere the spectator view (`'true'`: real spy model plus a disguise badge). `'true'`, `'enemy'` and `'pov'` can be forced. | STV shows the real spy; reviewing a missed spy-check needs the POV player's view |
| D10 | Dead Ringer | Fake deaths are hidden from the killfeed, kill counts and death markers by default. | spectators never see them in game |
| D11 | cloak | Visibility floor 0.15 opacity by default (TF2 spectators see 0.05). Setting `players.cloakFloor`. | readability in a review tool |
| D12 | determinism | Everything drawn at a frame is a pure function of (extras, base caches, `renderTick`, `frameProgress`, settings). No wall-clock effect timers in new code. | users scrub randomly; setups and `?tick=` links must reproduce |
| D13 | projectiles | Split by source. `Projectiles.tsx` draws every projectile that has a typed base slot (base types 1 to 4). The HL layer draws every extras instance without one, whatever its kind. Once extras are ready, `Projectiles.tsx` positions, trails and crit-glows its projectiles from the matching extras samples, so nothing in it depends on wall-clock time. Explosions switch to `TETFExplosion` events at the same moment. X2 then serves the base types from extras and frees the base cache. | no double drawing, no dependence on how parser2 types cannonballs or practice stickies, and D12 holds for the most common projectiles |
| D14 | POV FOV | POV uses the TF2 FOV by default: horizontal 90 at 4:3, which is 73.74 degrees vertical, with zoom transitions from `m_iFOV`. | the current 90 degrees vertical is about 121 horizontal at 16:9 |
| D15 | tests | No unit-test framework is added (it would change `yarn.lock`). Verification is the native `hl_extras` binary, the Node checker `scripts/hl/check-extras.mjs`, bridge probes and harness screenshots. | lockfile stays frozen |
| D16 | POV subject | POV mode has one effective player, the POV subject (section 5 F4). It is the focused player, or, while the focused player is dead, the player he spectates in IN_EYE or CHASE mode. The subject drives the camera, FOV, eye height, viewmodel, scope overlay, weapon HUD and POV medic beam. During DEATHCAM and FREEZECAM a death camera holds the death position and looks at the killer. | the dead player's own observer target is the killer for several seconds after a death |
| D17 | stopwatch | The stopwatch HUD follows `tf_hud_tournament.cpp`. Games won are derived from `roundWin` events, because no networked team field counts them. | `m_iRoundsWon` has no writer in the SDK; team scores reset when a game is decided and swap at halftime |
| D18 | memory | X2 is required. The extras worker owns its input in wasm memory and drops the JS copy. The base worker hands the file buffer back instead of the main thread copying it. Group exclusion for large files follows a rule measured by P1 (section 8). | the median local demo is 1017 s and the longest is 2041 s; the base projectile cache alone is 332 MB at 910 s |

---

## 1. Global conventions

### 1.1 Repositories, worktrees, commits, machine rules

- The main checkout `REPO` stays on branch `highlander`. Only the orchestrator commits there. `PARSER` likewise.
- **Step 0 (orchestrator, before any worktree exists).** Several files that S0, M1 and the harness need exist only
  as uncommitted changes in `REPO`, so a worktree made from `highlander` would not contain them. Commit them first:

  ```sh
  cd /home/dalibor/programming/personal/dribble.tf
  git add src/utils/debugBridge.ts src/main.tsx src/constants/items.json scripts/build-items.mjs \
          scripts/convert-bsp.mjs scripts/lib/map-meta.mjs scripts/setup-bsp-to-glb.mjs \
          scripts/bsp-to-glb/0001-feat-support-asset-less-export-of-shipped-TF2-maps.patch \
          scripts/bsp-to-glb/0002-feat-add-vtf-to-png-helper-binary.patch specs/highlander
  git -c commit.gpgsign=false commit -m "chore(highlander): commit debug bridge, items table, map converter and specs" \
          -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git show highlander:src/utils/debugBridge.ts > /dev/null && git show highlander:src/constants/items.json > /dev/null
  ```

  `src/main.tsx` carries only the one-line bridge import at this point. After step 0, S0 owns `src/utils/debugBridge.ts`,
  `src/main.tsx`, `src/constants/items.json` and `scripts/build-items.mjs`. M1 owns the converter scripts and
  patches (section 4.1). The orchestrator owns `specs/highlander/` until the DOCS task.
- **Step 0.3 (orchestrator, needs at least 3000 MB available in `free -m`).** Measure the base viewer alone on the
  two longest local demos: `1437285.dem` (koth_warmtic, 2041 s, 120 MB) and `1432698.dem` (pl_vigil, 1557 s,
  101 MB). Run `node $H/shot.mjs --demo <demo> --perf --perf-play 50%:5:rts --root REPO` on the step-0 commit and
  record the page PSS in `$S/baseline/long-demos.json`. If either demo fails to load, tell the user right away: the
  base parser binary (D2) causes it, and no Highlander task can fix it. When the machine never has the headroom,
  record that the step was skipped.
- Each task works in its own worktree and branch:
  - frontend: `git -C REPO worktree add /home/dalibor/programming/personal/dribble.tf-wt/<task> -b hl/<task> highlander`
  - parser: `git -C PARSER worktree add /home/dalibor/programming/personal/dribble-parser-wt/p1 -b hl/p1-extras highlander`
- Worktrees live on disk (`/home/...`), never in `/tmp` (tmpfs, about 2 GB free).
- Before running `tsc` in a frontend worktree, link the shared modules once:
  `ln -s REPO/node_modules /home/dalibor/programming/personal/dribble.tf-wt/<task>/node_modules`. The harness
  creates the same link itself.
- Commit with `git -c commit.gpgsign=false commit`. End the message with the attribution line
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push. The orchestrator merges `hl/<task>` into
  `highlander` and tells the user that commits are unsigned.
- Heavy commands (cargo, wasm-pack, `npm run build`, `tsc`, Node parses of demos, Chromium) run under
  `flock $S/heavy.lock <command>` with `CARGO_BUILD_JOBS=4`. `node $H/shot.mjs` takes the lock itself, so do not wrap
  it. Kill any dev server or browser you start.
- Type check: `flock $S/heavy.lock node_modules/.bin/tsc --noEmit -p .`. The 10 existing errors (BuildingCache.ts x4,
  ChunkedArray.ts x3, AnalyseMenu.tsx, DemoDrawing.tsx, UrlDemoNotice.tsx) are allowed. Any new error fails the task.
- Build check: `flock $S/heavy.lock npm run build`.

### 1.2 Ticks and time

- A cache tick `i` (0 to `ticks - 1`) is server tick `startTick + i`. Every tick in the extras output is a cache
  tick. This file says "tick" for cache tick.
- `renderTick = max(1, playback.tick - 2)` (DemoViewer `INTERP_DELAY_TICKS`). Scene layers and HUD widgets read
  `renderTick`. `tickF = renderTick + frameProgress`, where `frameProgress = useInstance.getState().frameProgress`
  read inside `useFrame` (0 while paused). Never select `frameProgress` in a component.
- Networked time floats (every `SendPropTime`, value = server curtime) convert to a fractional cache tick:
  `tickF = time / intervalPerTick - startTick`, stored as `Float32`. For fields marked "0 means unset", a raw value
  of 0 becomes `NaN`.
- Entity state belongs to the packet's server tick: `tick = serverTick - startTick`, with `serverTick` from the
  packet's `NetTick` message, exactly as lib.rs.
- Game events use `tick = demoTick + tickBase - startTick`, exactly as lib.rs does for deaths.
- **Signon data belongs to tick 0.** Every message in a `Signon` packet, and every message that arrives before the
  first `NetTick` of the demo, belongs to cache tick 0. That covers convars, game events, string-table updates and
  entity state. The demo tick on signon packets is meaningless: 1440442 logs its signon `SetConVar`s (including
  `mp_tournament_redteamname "BLU"`) at demo tick 60501 in a 48263-tick demo, the 6v6 sample at 148998 in a
  28179-tick demo, and 1428628 at 2147483648.
- State changes before tick 0 fold into tick 0. Events before tick 0 are dropped. Anything at `tick >= ticks` is
  dropped.
- Event effects compute `age = tickF - eventTick` and draw only while `0 <= age < lifetimeTicks`.
- The harness and the bridge seek by playback tick. Playback tick = cache tick + 2.

### 1.3 Indices and sentinels

- Player index `p` = base parser player id, the key of `parsedDemo.entityPlayerMap`. The extras arrays are indexed
  by the same `p`, built from `options.playerEntityIds[p]`.
- Sentinels: `U8` 255 = none, `U16` 65535 = none, `U32` 0xFFFFFFFF = none (and "still alive at demo end" for
  `deleted`), `I8`/`I16`/`I32` -1 = none, `F32` NaN = none.
- An instance is one entity lifetime, keyed by (entity index, serial). A Leave followed by an Enter with the same
  serial and class is the same instance (it was dormant). A different serial or class starts a new instance.
  Instance index = position in that group's instance table.
- Teams: 0 unassigned, 1 spectator, 2 RED, 3 BLU. Classes: 1 scout, 2 sniper, 3 soldier, 4 demoman, 5 medic,
  6 heavy, 7 pyro, 8 spy, 9 engineer (`CLASS_MAP`).
- Item definition indices map to `src/constants/items.json` through `src/highlander/items.ts`.

### 1.4 Coordinates

- The Rust side writes absolute Source coordinates as `Float32`: X forward, Y left, Z up. Angles are degrees.
  Rotations are quaternions `(qx, qy, qz, qw)` built with Source's `AngleQuaternion` (Appendix B.1).
- The extras worker converts every position field listed in section 3.5 to scene space by subtracting
  `sceneOrigin = parsedDemo.world.boundaryMin`, the value after ParseWorker applied any `OVERWRITE_MAP_BOUNDARIES`
  shift. After hydration every position in `HighlanderExtras` is scene space. Quaternions need no conversion,
  because scene axes are Source axes (Z up).
- Placeholders are modelled with +X forward, +Z up, origin at the entity origin (feet or base centre).
- GLB map nodes live in glTF axes under the `world` group (rotation [pi/2, 0, 0], position -boundaryMin). To move a
  brush node to an absolute Source transform (p, q): `node.matrix = C * T(p) * R(q) * C^-1`, where C is the
  rotation by -90 degrees about X, so C maps Source (x, y, z) to glTF (x, z, -y). Code in Appendix B.2.

### 1.5 Style tokens

`src/highlander/constants.ts` (scaffold S0) holds these; use them instead of new literals.

```ts
export const TEAM_HUD = { red: '#b8383b', blue: '#5885a2' }      // HUD panels, bars, text
export const TEAM_FX = { red: '#ff4b3e', blue: '#4ba3ff' }       // glows, auras, dots, beams, tracers (crit)
export const TEAM_DARK = { red: '#6e2224', blue: '#2f4a5c' }     // placeholder bodies
export const TEAM_TRAIL = { red: '#cf4a2e', blue: '#5885a2' }    // same as Projectiles.tsx TEAM_COLORS
export const NEUTRAL = '#8a8a8a'
export const METAL = '#4a4a4a'
export const DARK_METAL = '#2b2b2b'
export const CLOAK_TINT = { red: [1.0, 0.5, 0.4], blue: [0.4, 0.5, 1.0] } as const
export const EYE_HEIGHT: Record<number, number> = { 1: 65, 2: 75, 3: 68, 4: 68, 5: 75, 6: 75, 7: 68, 8: 75, 9: 68 }
export const DUCK_EYE_HEIGHT = 45
export const LEGACY_EYE_HEIGHT = 83                               // ActorDimensions.z
export const HULL = { width: 48, height: 82, duckHeight: 62 }
export const HUD_TICK_STEP = 3                                    // section 1.6 rule 10
export const HEAL_BEAM_OFFSET = 41.5                              // HealBeam adds this to both ends (BEAM_HEIGHT_OFFSET)
export const teamKey = (team: number) => (team === 2 ? 'red' : team === 3 ? 'blue' : null)
```

Units are Hammer units (1 inch). Placeholder materials are `MeshLambertMaterial` for solid parts and
`MeshBasicMaterial` with `AdditiveBlending, depthWrite: false` for glows.

### 1.6 Component rules (binding for every new scene layer and HUD widget)

1. Layers and widgets are `React.memo` components with primitive props (`renderTick`, ids).
2. They read extras through `useExtras()` and render `null` until it returns data.
3. Per-frame work happens in `useFrame` through refs. The only React state that may change per tick is the list of
   mounted instance keys.
4. Store selectors return primitives. Use `useHlSetting('players.cloak')`, not `useStore(s => s.settings.highlander)`
   (the shallow settings clone keeps nested references, frontend.md section 9).
5. No `performance.now()`, `Date.now()` or `setTimeout` in effect logic. Animation phase comes from `tickF`.
6. Geometries and materials are created once per layer (module scope or `useMemo`). Clone a material per instance
   only when its opacity or colour differs per instance.
7. Use `InstancedMesh` when a layer can show more than about 20 copies of one shape (pickups, tracers, sparks).
8. No network requests. Do not use drei `<Text>` (troika fetches fonts). Text in the 3D scene uses drei `<Html>`
   sparingly or HUD widgets.
9. Every layer checks its own setting and `extras.meta.available` (section 3.9) and degrades to nothing.
10. DOM HUD widgets that show per-player or per-team numbers read the shared snapshot of section 5 F5 at `hudTick`:
    `hudTick = renderTick` while paused and `renderTick - (renderTick % HUD_TICK_STEP)` while playing, with
    `HUD_TICK_STEP = 3` in `src/highlander/constants.ts` (X1 may tune it between 2 and 4). Each shown value still
    depends only on the tick, so seeking stays deterministic. Scene layers keep `renderTick` and `tickF`.

---

## 2. Extras parser (task P1, Rust part)

### 2.1 Files in `PARSER` (worktree `dribble-parser-wt/p1`, branch `hl/p1-extras`)

| file | content |
|---|---|
| `src/extras/mod.rs` | `pub struct ExtrasOptions`, `pub struct ExtrasOutput`, `pub fn parse_extras(buffer: &[u8], opts: &ExtrasOptions, progress: &mut dyn FnMut(u32)) -> Result<ExtrasOutput, String>`. Pure Rust, no `js_sys`. |
| `src/extras/tracker.rs` | Generic tracked-entity layer: per-entity prop map keyed by flattened index, Enter/Delta/Leave/Delete, dormancy, instance ids. Port of `hl_probe.rs` `on_enter`/`on_delta`/`on_leave`/`on_delete`/`ensure_class` minus the statistics. |
| `src/extras/track.rs` | `TrackBuilder`, `EventBuilder`, `InstanceTable` (section 2.4). |
| `src/extras/{players,weapons,viewmodels,buildings,projectiles,flames,dots,objectives,movers,pickups,tempents,events}.rs` | One module per output group of section 2.5. |
| `src/extras/js.rs` | Converts `ExtrasOutput` to the JS object of section 2.5 (`js_sys::Reflect::set`, `Uint8Array::from(&v[..])` and so on). Field names exactly as in `src/highlander/extras/types.ts`. Converts group by group and drops each Rust vector right after its copy, so the Rust and JS copies of the whole output never coexist. |
| `src/lib.rs` | `pub mod extras;` plus the exports of section 2.2. Do not change `parse_demo_cache_internal`. |
| `src/bin/hl_extras.rs` | Native runner (section 2.7). Register it in `Cargo.toml` as `[[bin]] name = "hl_extras"`, no required features. |

### 2.2 Export

```rust
#[wasm_bindgen]
pub fn parse_demo_extras(buffer: &[u8], options: JsValue, progress_callback: js_sys::Function) -> JsValue

/// The demo bytes, owned by wasm memory. The worker copies the file in and drops its own ArrayBuffer before parsing.
#[wasm_bindgen]
pub struct ExtrasInput { data: Vec<u8> }

#[wasm_bindgen]
impl ExtrasInput {
    #[wasm_bindgen(constructor)]
    pub fn new(len: usize) -> ExtrasInput          // zero-filled vector of `len` bytes
    pub fn ptr(&mut self) -> *mut u8               // JS: new Uint8Array(wasm.memory.buffer, ptr, len).set(bytes)
}

/// Same result as `parse_demo_extras`. Consumes and frees `input` before the JS output is built.
#[wasm_bindgen]
pub fn parse_demo_extras_input(input: ExtrasInput, options: JsValue, progress_callback: js_sys::Function) -> JsValue
```

`options` is deserialised with `serde_wasm_bindgen::from_value` into:

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtrasOptions {
    pub start_tick: u32,            // base result `startTick` (server tick of cache tick 0), required
    pub tick_base: i64,             // base result `tickBase`, required
    pub ticks: u32,                 // base result `ticks`, required
    pub interval_per_tick: f32,     // base result `intervalPerTick`
    pub player_entity_ids: Vec<u32>,// index p -> entity id; 0 for indices without a base `players` entry
    #[serde(default)]
    pub groups: Option<Vec<String>>,// optional allow-list of top-level group names; default all
    #[serde(default)]
    pub wearable_defs: Option<Vec<u16>>, // item defs that count as loadout wearables (section 2.5.1); default: keep all
}
```

- Return value: the `ExtrasRaw` object of section 2.5, or a JS string describing a fatal error (bad options, demo
  header unreadable).
- A packet error after the header does not fail the call. Stop parsing, finish every builder with what it has, and
  add `"truncated at demo tick N"` to `meta.warnings`.
- Groups left out by `groups` are still emitted, empty: `count` 0, zero-length columns, every `offsets` array of
  length `keyCount + 1` filled with 0, `available` false for their keys, and the group name in `meta.excluded`.
  Consumers and `hydrate` never see a missing group.
- Progress: call `progress_callback` with `clamp(round(100 * packetDemoTick / header.ticks), 0, 100)`, at most once
  per percent, and once with 100 at the end. Signon packets report 0 (section 1.2).
- The crate denies `unwrap`, `expect`, indexing and `panic`. Keep it that way in `src/extras`.

### 2.3 Decoding rules

1. Loop: `DemoHandler::with_analyser(ExtrasAnalyser)` plus `RawPacketStream`, as lib.rs. `ExtrasAnalyser` handles
   `PacketEntities`, `TempEntities`, `GameEvent`, `NetTick`, `SetConVar`, `SetPause`, `ServerInfo`, data tables and
   string tables (`modelprecache`, `userinfo`, `ParticleEffectNames`, `EffectDispatch`).
2. Enter props are merged by `SendProp.index`: own props, then the instance-or-static baseline, then the static
   baseline (probe section 0.5 and `on_enter`). `PacketEntity::props()` is not used, because it drops repeated
   UtlVector elements.
3. Duplicated identifiers (UtlVector elements such as `m_pProvider`, item attributes) are told apart by flattened
   index. Build the per-class map from flattened index to element number once per class, as the probe's
   `class_info.dup`.
4. Array props use the array table name as the owner and the 3-digit element as the prop name, for example
   `SendPropIdentifier::new("m_iAmmo", "003")` for metal and `("m_flNextRespawnTime", "011")` for entity 11.
   UtlVector props work the same way with the `_ST_` table, for example `("_ST_m_hMyWearables_8", "000")`.
   Two props are exceptions: the library decodes each as one `SendPropValue::Array` value, so they have no
   per-element identifiers.
   - `SendPropIdentifier::new("DT_BaseTeamObjectiveResource", "m_vCPPositions")`: an array of 8 vectors.
   - `SendPropIdentifier::new("DT_ObjectDispenser", "healing_array")`: an array of EHANDLE integers.
   Verify every array path against the probe's name map before relying on it.
5. Leave marks the instance dormant. Enter with the same serial and class revives it. Delete and
   `removed_entities` end it.
6. EHANDLE: `index = v & 0x7FF`, `serial = v >> 11`, `0x1FFFFF` is null. Player handles resolve by index through
   `player_entity_ids`. Weapon, building, projectile and mover handles resolve to the live instance with that
   (index, serial).
7. Temp entities: a temp entity whose class equals the previous temp entity's class in the same message is a delta
   against it. Otherwise absent props are zero (probe `on_temp_entities`).
8. Model, particle and effect indices resolve through this demo's string tables at the time of use.
9. `userinfo`: keep `userId -> entityId` from `UserInfo::parse_from_string_table`, updated on every entry. Event
   user ids map to `p` through it. Unknown users map to 255.
10. Only these server classes get prop bookkeeping (the library still decodes every packet): `CTFPlayer`,
    `CTFPlayerResource`, `CTFTeam`, `CTFGameRulesProxy`, `CTFObjectiveResource`, `CTeamRoundTimer`,
    `CTeamTrainWatcher`, `CTFPlayerDestructionLogic`, `CTFViewModel`, every weapon class (a class whose flattened
    props include `DT_BaseCombatWeapon.m_hOwner`), `CObjectSentrygun`, `CObjectDispenser`, `CObjectTeleporter`,
    `CObjectSapper`, `CObjectCartDispenser`, every class named `CTFProjectile_*`, `CTFGrenadePipebombProjectile`,
    `CTFStunBall`, `CTFBall_Ornament`, `CTFFlameManager`, `CSniperDot`, `CLaserDot`, `CBaseDoor`, `CFuncRotating`,
    `CFuncTrackTrain`, `CFuncBrush`, `CBaseEntity`, `CDynamicProp`, `CPhysicsProp`, `CPhysicsPropMultiplayer`,
    `CBaseAnimating`, `CTFAmmoPack`, `CTFDroppedWeapon`, `CTFRagdoll`, `CWorld`, and every class whose name starts
    with `CTFWearable` (only `DT_ScriptCreatedItem.m_iItemDefinitionIndex` and `DT_BaseEntity.m_hOwnerEntity` are
    kept for those). Weapon classes also keep `DT_TFWeaponBase.m_bDisguiseWeapon`.
11. The native binary may run without options. Then it also runs `GameStateAnalyser` in the same handler and
    reproduces lib.rs: start at the first packet where at least 100 packets have had a non-empty
    `game_state.players` and the world bounds are non-zero; player indices in first-seen order of
    `game_state.players` entity ids; `tickBase = serverTick - demoTick` at that packet. The browser path never does
    this. In this mode `--self-check` compares the `alignment` samples with the `GameStateAnalyser` player
    positions at the same ticks (the rule of section 3.6), and `--print-options` writes the derived options as JSON
    so the Node checker can run the wasm path without parser2 (section 2.7).
12. **Disguise weapons.** When a spy disguises, the server creates a real weapon entity owned by the spy with
    `m_bDisguiseWeapon = 1` (`tf_player_shared.cpp:8375-8530`). The probes saw disguise copies of `CWeaponMedigun`
    (6 on 1434434, 29 on 1438891, 27 on 1440442), `CTFSniperRifle` and `CTFPipebombLauncher`. Every owner-based
    lookup (`players.medigun`, `.sniper`, `.builder`, `misc.stickies`, `players.fire`) skips weapon instances whose
    `weapons.disguise` is 1. `disguise.weaponDef` is the one place that reads them.

### 2.4 Encodings

Four container shapes. All typed arrays are little-endian JS typed arrays.

1. **Track.** A change list keyed by an integer key (player index, instance index, point index, team, or 0 for
   singletons), stored CSR style: `offsets: Uint32Array(keyCount + 1)`, `ticks: Uint32Array(n)`, plus one typed
   array of length `n` per field. Entries of key `k` are `[offsets[k], offsets[k+1])`, with strictly increasing
   ticks. The value at tick T is the last entry with `ticks[i] <= T`. Before the first entry there is no value.
2. **Instances.** Per-instance static columns of length `count`, always including `entityId: Uint16Array`,
   `created: Uint32Array` (first Enter, clamped to 0) and `deleted: Uint32Array` (Delete tick, 0xFFFFFFFF if alive
   at the end). Instances that end before tick 0 are dropped. Tables are sorted by `(created, entityId)`. Tracks
   keyed by instance use the final, sorted index.
3. **EventList.** Columnar list sorted by tick ascending (stable sort, arrival order within a tick):
   `tick: Uint32Array(n)` plus one typed array per field.
4. **JSON events.** `events: HlEvent[]`, sorted by tick, built with `serde_wasm_bindgen::to_value`.

`TrackBuilder::push(key, tick, record)`:

```text
if tick >= ticks: ignore
tick = max(tick, 0)
list = per_key[key]
if list is not empty and list.last.tick == tick:
    list.last.record = record
    if list.len >= 2 and list[len-2].record == record: list.pop()
elif list is not empty and list.last.record == record:
    skip
else:
    list.push((tick, record))
```

A record is the full tuple of a track's fields. A change in any field pushes a whole record.

### 2.5 Output schema

`src/highlander/extras/types.ts` is the schema. The scaffold (S0) creates it with exactly this content. P1 writes
the Rust side to match it. Field groups below the code block say where every value comes from.

```ts
// src/highlander/extras/types.ts
export const HL_EXTRAS_SCHEMA = 1

export type U8 = Uint8Array
export type I8 = Int8Array
export type U16 = Uint16Array
export type I16 = Int16Array
export type U32 = Uint32Array
export type I32 = Int32Array
export type F32 = Float32Array

/** CSR change list. Entries of key k: [offsets[k], offsets[k+1]), strictly increasing ticks. */
export interface Track { offsets: U32; ticks: U32 }
/** Columnar events sorted by tick. */
export interface EventList { tick: U32 }
/** Per-instance static columns. */
export interface Instances { count: number; entityId: U16; created: U32; deleted: U32 }
/** Absolute (Rust) or scene (after hydration) transform track. */
export type XformTrack = Track & { x: F32; y: F32; z: F32; qx: F32; qy: F32; qz: F32; qw: F32 }

export type HlAvailKey =
  | 'cond' | 'cloak' | 'disguise' | 'weapon' | 'wstate' | 'ammo' | 'medigun' | 'sniper' | 'fov' | 'view'
  | 'resource' | 'misc' | 'builder' | 'loadout' | 'viewmodels' | 'fire' | 'anim' | 'scoring' | 'itemCharge'
  | 'buildings' | 'projectiles' | 'flames' | 'dots'
  | 'objectiveResource' | 'timers' | 'rules' | 'teams' | 'watchers' | 'carts' | 'pd'
  | 'movers' | 'pickups' | 'ragdolls' | 'drops'
  | 'bullets' | 'explosions' | 'tracers' | 'particles' | 'clientProjectiles' | 'hurts' | 'events'

export interface XMeta {
  schema: 1
  startTick: number          // echo of options.startTick
  tickBase: number           // echo
  ticks: number              // echo
  intervalPerTick: number    // from ServerInfo, falls back to options
  snapshotInterval: number   // most common server-tick gap between consecutive PacketEntities messages: 1 on the HL demos, 2 on the 6v6 sample
  playerCount: number        // options.playerEntityIds.length
  map: string                // ServerInfo map name
  parseMs: number            // Rust writes 0 (std::time::Instant panics on wasm32-unknown-unknown); ExtrasWorker sets the wall time
  available: Record<HlAvailKey, boolean>   // true when the group produced at least one entry
  counts: Record<string, number>           // diagnostics: instances per class, events per type
  warnings: string[]
  excluded: string[]                       // groups left out through options.groups (emitted empty, section 2.2)
  convars: { tick: number; key: string; value: string }[]   // every SetConVar entry; signon entries at tick 0 (section 1.2)
  pauses: { tick: number; paused: boolean }[]               // SetPause messages
}

export interface XStrings {
  models: string[]        // modelprecache, index = m_nModelIndex
  classes: string[]       // server class names, index = class id
  particles: string[]     // ParticleEffectNames
  effects: string[]       // EffectDispatch names
}

export interface XAlignment {
  ticks: U32              // 16 sample ticks: for k = 0..15, the first tick at or after round(ticks * (k + 0.5) / 16) that received a PacketEntities message
  pos: F32                // (p * 16 + k) * 3 + axis; NaN when player p is absent or dead at that tick
}

export interface XPlayers {
  count: number
  entityId: U32
  cond: Track & { w0: U32; w1: U32; w2: U32; w3: U32; w4: U32 }
  cloak: Track & { meter: U8 }
  invis: Track & { completeTick: F32 }
  disguise: Track & { team: U8; cls: U8; target: U8; health: U16; weaponDef: U16; desiredTeam: U8; desiredCls: U8 }
  weapon: Track & { id: U32; def: U16; cls: U16 }
  wstate: Track & { state: U8; reload: U8; clip: I16; flags: U8; chargeTick: F32 }
  ammo: Track & { primary: U16; secondary: U16; metal: U16 }
  medigun: Track & { charge: U16; flags: U8; target: U8; def: U16; resist: U8 }
  sniper: Track & { charge: U8 }
  fov: Track & { fov: U8; start: U8; tick: F32; rate: F32 }
  view: Track & { eyeZ: U8; duck: U8 }
  resource: Track & { respawnTick: F32; maxHealth: U16; maxBuffed: U16; alive: U8; score: U16; damage: U32; healing: U32 }
  misc: Track & { healers: U8; carrying: U8; flip: U8; obsMode: U8; obsTarget: U8; revenge: U8; heads: U8; charge: U8; rage: U8; stickies: U8; saveMe: U8 }
  builder: Track & { state: U8; type: U8; mode: U8 }
  loadout: Track & { d0: U16; d1: U16; d2: U16; d3: U16; d4: U16; d5: U16; d6: U16; d7: U16; w0: U16; w1: U16; w2: U16; w3: U16 }
  scoring: Track & {
    kills: U16; deaths: U16; assists: U16; damage: U32; heals: U32; caps: U16; defenses: U16; backstabs: U16
    headshots: U16; invulns: U16; teleports: U16; built: U16; destroyed: U16; dominations: U16; revenges: U16; points: U16
  }
  itemCharge: Track & { s0: U8; s1: U8; s2: U8 }
  vm0: Track & { model: U16; seq: U8; parity: U8; muzzle: U8; weaponDef: U16; rate: F32; nodraw: U8 }
  vm1: Track & { model: U16; seq: U8; parity: U8; muzzle: U8; weaponDef: U16; rate: F32; nodraw: U8 }
  fire: EventList & { player: U8; weaponDef: U16 }
  anim: EventList & { player: U8; event: U8; data: U16 }
}

export interface XWeapons extends Instances { owner: U8; def: U16; cls: U16; disguise: U8 }

export interface XBuildings extends Instances {
  type: U8; mode: U8; builder: U8; team: U8; mini: U8; mapPlaced: U8; builtOn: I32
  state: Track & {
    level: U8; health: U16; maxHealth: U16; built: U8; flags: U16; objState: U8; upgradeMetal: U16
    shells: U16; rockets: U8; metal: U16; rechargeTick: F32; rechargeDur: F32; timesUsed: U16
  }
  pose: Track & { yaw: U8; pitch: U8 }
  xform: XformTrack
  enemy: Track & { kind: U8; index: U16 }
  heal: Track & { lo: U32; hi: U32 }
}

export interface XProjectiles extends Instances {
  kind: U8; team: U8; owner: U8; launcherDef: U16; crit: U8; sentry: U16
  hidden: U32                      // first tick the projectile is no longer drawn (Leave or Delete)
  vx: F32; vy: F32; vz: F32        // m_vInitialVelocity, NaN when absent
  posStart: U32; posCount: U32     // sample s of instance j is tick created[j] + s, at pos[(posStart[j] + s) * 3]
  pos: F32
  deflects: Track & { team: U8; owner: U8; count: U8 }
}

export interface XFlames extends Instances {
  owner: U8
  box: Track & { firing: U8; cx: F32; cy: F32; cz: F32; hx: F32; hy: F32; hz: F32 }
}

export interface XDots extends Instances {
  owner: U8; team: U8; laser: U8
  pos: Track & { x: F32; y: F32; z: F32; chargeTick: F32 }
}

export interface XTimers extends Instances {
  state: Track & {
    paused: U8; endTick: F32; remaining: F32; length: U16; maxLength: U16; setupLength: U16
    mode: U8; flags: U8; totalTime: F32
  }
}

export interface XWatchers extends Instances {
  state: Track & { progress: U16; speed: I8; cappers: I8; recedeTick: F32 }
}

export interface XControlPoints {
  count: number
  layout: string
  pos: F32            // 8 * 3, m_vCPPositions
  visible: U8         // 8
  group: U8           // 8
  capTimeRed: F32     // 8, seconds for one capper (m_flTeamCapTime[16 + p])
  capTimeBlu: F32     // 8 (m_flTeamCapTime[24 + p])
  reqRed: U8          // 8
  reqBlu: U8          // 8
  pathDistance: F32   // 8, payload checkpoint fractions
  scales: U8          // 8, m_bCPCapRateScalesWithPlayers
  state: Track & { owner: U8; capping: U8; inZone: U8; numRed: U8; numBlu: U8; lazy: F32; flags: U8; unlockTick: F32 }
  progress: Track & { p: U16 }   // simulated capture fraction toward state.capping, 0..65535
}

export interface XObjectives {
  gameType: number
  koth: boolean
  rules: Track & {
    roundState: U8; winner: U8; flags: U16; swState: U8; rounds: U8
    redKoth: I16; bluKoth: I16; hudTimer: I16; swTimer: I16
    waveRed: F32; waveBlu: F32; restartTick: F32
  }
  teams: Track & { score: I32; roundsWon: U16; role: U8; flagCaps: U8 }   // key = team number 0..3
  timers: XTimers
  cp: XControlPoints
  watchers: XWatchers
  cart: { movers: I32; trains: I32 }   // mover instance indices of payload cart props and of CFuncTrackTrain
  pd: Track & { red: U16; blu: U16; max: U16 }   // key 0, tug of war (CTFPlayerDestructionLogic)
}

export interface XMovers extends Instances {
  cls: U8; bspModel: I16; model: U16; parent: I32
  xform: XformTrack
  vis: Track & { v: U8 }
}

export interface XPickups extends Instances {
  kind: U8; size: U8; model: U16; x: F32; y: F32; z: F32
  vis: Track & { v: U8 }
}

export interface XRagdolls extends Instances {
  player: U8; cls: U8; team: U8; flags: U16; custom: U16
  x: F32; y: F32; z: F32; vx: F32; vy: F32; vz: F32
}

export interface XDrops extends Instances {
  kind: U8; model: U16; def: U16
  xform: XformTrack
}

export interface XTempEnts {
  bullets: EventList & { player: U8; weaponId: U8; crit: U8; seed: U8; spread: F32; x: F32; y: F32; z: F32; pitch: F32; yaw: F32 }
  explosions: EventList & { x: F32; y: F32; z: F32; nx: F32; ny: F32; nz: F32; weaponId: U8; def: U16; entity: U16; particle: U16 }
  tracers: EventList & { sentry: U16; sx: F32; sy: F32; sz: F32; ex: F32; ey: F32; ez: F32 }
  particles: EventList & { name: U16; x: F32; y: F32; z: F32; entity: U16 }
  clientProjectiles: EventList & { kind: U8; player: U8; crit: U8; x: F32; y: F32; z: F32; vx: F32; vy: F32; vz: F32 }
}

export type XHurts = EventList & { victim: U8; attacker: U8; damage: U16; health: I16; crit: U8; weaponId: U8; custom: U16 }

export type HlEvent =
  | { t: 'kill'; tick: number; victim: number; attacker: number; assister: number; inflictor: number; weapon: string; weaponLog: string; weaponDef: number; weaponId: number; deathFlags: number; customKill: number; critType: number; feign: boolean }
  | { t: 'uberDeployed'; tick: number; medic: number; target: number }
  | { t: 'medicDeath'; tick: number; medic: number; attacker: number; healing: number; charged: boolean }
  | { t: 'deflect'; tick: number; pyro: number; owner: number; weaponId: number; entity: number; projectile: number }
  | { t: 'buildStart'; tick: number; building: number; builder: number; type: number; mode: number }
  | { t: 'buildDone'; tick: number; building: number; builder: number; type: number }
  | { t: 'upgrade'; tick: number; building: number; builder: number; level: number }
  | { t: 'carry'; tick: number; building: number; builder: number }
  | { t: 'redeploy'; tick: number; building: number; builder: number }
  | { t: 'destroyed'; tick: number; building: number; owner: number; attacker: number; assister: number; weapon: string; type: number; wasBuilding: boolean }
  | { t: 'detonated'; tick: number; building: number; owner: number; type: number }
  | { t: 'sapped'; tick: number; building: number; spy: number; owner: number; type: number }
  | { t: 'teleported'; tick: number; player: number; builder: number; dist: number }
  | { t: 'capStart'; tick: number; cp: number; cpName: string; team: number; capTeam: number; cappers: number[]; capTime: number }
  | { t: 'captured'; tick: number; cp: number; cpName: string; team: number; cappers: number[] }
  | { t: 'capBlocked'; tick: number; cp: number; cpName: string; blocker: number; victim: number }
  | { t: 'capBroken'; tick: number; cp: number; cpName: string; timeRemaining: number }
  | { t: 'cpLocked'; tick: number; cp: number }
  | { t: 'cpUnlocked'; tick: number; cp: number }
  | { t: 'roundStart'; tick: number; fullReset: boolean }
  | { t: 'roundActive'; tick: number }
  | { t: 'setupFinished'; tick: number }
  | { t: 'roundWin'; tick: number; team: number; winReason: number; fullRound: boolean; roundTime: number; suddenDeath: boolean }
  | { t: 'overtimeStart'; tick: number }
  | { t: 'overtimeEnd'; tick: number }
  | { t: 'timeAdded'; tick: number; timer: number; seconds: number }
  | { t: 'gameOver'; tick: number; reason: string }
  | { t: 'banner'; tick: number; owner: number; buffType: number }
  | { t: 'pickup'; tick: number; player: number; item: string }
  | { t: 'spawn'; tick: number; player: number; cls: number; team: number }
  | { t: 'classChange'; tick: number; player: number; cls: number }
  | { t: 'teamChange'; tick: number; player: number; team: number; oldTeam: number; disconnect: boolean }
  | { t: 'disconnect'; tick: number; player: number; reason: string }

export interface ExtrasRaw {
  meta: XMeta
  strings: XStrings
  alignment: XAlignment
  players: XPlayers
  weapons: XWeapons
  buildings: XBuildings
  projectiles: XProjectiles
  flames: XFlames
  dots: XDots
  objectives: XObjectives
  movers: XMovers
  pickups: XPickups
  ragdolls: XRagdolls
  drops: XDrops
  tempents: XTempEnts
  hurts: XHurts
  events: HlEvent[]
}

/** Index lists built during hydration: rows of a global EventList grouped by player, tick order kept. */
export interface ByPlayer { offsets: U32; rows: U32 }

export interface HighlanderExtras extends ExtrasRaw {
  derived: {
    sceneOrigin: { x: number; y: number; z: number }
    flags: U32                         // HL flag mask per players.cond entry (same offsets/ticks as players.cond)
    entityToPlayer: Map<number, number>
    fireByPlayer: ByPlayer
    animByPlayer: ByPlayer
    bulletsByPlayer: ByPlayer
    hurtsByVictim: ByPlayer
    hurtsByAttacker: ByPlayer
    projectilesByEntity: Map<number, number[]>   // entity id -> instance indices sorted by created
    buildingsByEntity: Map<number, number[]>
    eventsByType: Record<string, number[]>       // HlEvent type -> indices into events
  }
}
```

Flag bit tables used by the fields below live in `src/highlander/extras/enums.ts` (S0 writes them, Appendix A).

#### 2.5.1 `players` (key = player index p; entity = `CTFPlayer` with entity id `playerEntityIds[p]`)

| field | source | notes |
|---|---|---|
| `cond.w0` | `DT_TFPlayerShared.m_nPlayerCond` OR `DT_TFPlayerConditionListExclusive._condition_bits` | as u32. Without the OR, Kritzkrieg and revenge crits vanish. |
| `cond.w1..w4` | `m_nPlayerCondEx`, `m_nPlayerCondEx2`, `m_nPlayerCondEx3`, `m_nPlayerCondEx4` | as u32 |
| `cloak.meter` | `DT_TFPlayerShared.m_flCloakMeter` | `ceil(clamp(v, 0, 100))`, so 0 means empty |
| `invis.completeTick` | `DT_TFPlayerShared.m_flInvisChangeCompleteTime` | tickF; raw 0 becomes `-startTick` (it is a time, not "unset") |
| `disguise.team`, `.cls` | `m_nDisguiseTeam`, `m_nDisguiseClass` | 0 when not disguised |
| `disguise.target` | `m_hDisguiseTarget` | player index, 255 none |
| `disguise.health` | `m_iDisguiseHealth` | clamp 0..65534 |
| `disguise.weaponDef` | `m_hDisguiseWeapon` | item def of that weapon instance, 65535 none |
| `disguise.desiredTeam`, `.desiredCls` | `DT_TFPlayerSharedLocal.m_nDesiredDisguiseTeam`, `m_nDesiredDisguiseClass` | the target while DISGUISING |
| `weapon.id`, `.def`, `.cls` | `DT_BaseCombatCharacter.m_hActiveWeapon` | `id` = weapons instance index (0xFFFFFFFF none), `def` and `cls` copied from it. If the handle cannot be resolved yet, push again when that weapon instance enters. |
| `wstate.state` | active weapon `DT_WeaponFlameThrower.m_iWeaponState` or `DT_WeaponMinigun.m_iWeaponState` | 0 for other weapons |
| `wstate.reload` | active weapon `DT_TFWeaponBase.m_iReloadMode` | 0..3 |
| `wstate.clip` | active weapon `DT_LocalWeaponData.m_iClip1` | -1 when absent or negative |
| `wstate.flags` | bit0 `DT_TFWeaponKnife.m_bReadyToBackstab`, bit1 `m_bCritFire` or `m_bCritShot`, bit2 `DT_TFWeaponBase.m_bLowered`, bit3 `DT_WeaponFlameThrower.m_bHitTarget` | of the active weapon |
| `wstate.chargeTick` | active weapon `DT_PipebombLauncherLocalData.m_flChargeBeginTime` | tickF, NaN when 0. Covers sticky launchers and bows. |
| `ammo.primary`, `.secondary`, `.metal` | `m_iAmmo` elements 001, 002, 003 | clamp to u16 |
| `medigun.*` | the `CWeaponMedigun` instance with `m_hOwner` = this player and `weapons.disguise` 0, newest alive (rule 2.3.12) | `charge` = round(clamp(`DT_TFWeaponMedigunDataNonLocal.m_flChargeLevel`, falling back to `DT_LocalTFWeaponMedigunData.m_flChargeLevel`, 0, 1) x 1000); `flags` bit0 `m_bHealing`, bit1 `m_bAttacking`, bit2 `m_bChargeRelease`, bit3 `m_bHolstered` (all `DT_WeaponMedigun`); `target` = player index of `m_hHealingTarget`; `def` = item def; `resist` = `m_nChargeResistType`. When the player stops owning a medigun push `{charge 0, flags 0, target 255, def 65535, resist 0}`. |
| `sniper.charge` | `DT_SniperRifleLocalData.m_flChargedDamage` of the owned non-disguise `CTFSniperRifle`, `CTFSniperRifleDecap` or `CTFSniperRifleClassic` | round, 0..150; 0 without a rifle |
| `fov.fov`, `.start`, `.tick`, `.rate` | `DT_BasePlayer.m_iFOV`, `m_iFOVStart`, `m_flFOVTime` (tickF), `DT_Local.m_flFOVRate` (seconds) | |
| `view.eyeZ` | `DT_LocalPlayerExclusive.m_vecViewOffset[2]` | round, clamp 0..255 |
| `view.duck` | bit0 `DT_Local.m_bDucked`, bit1 `DT_Local.m_bDucking` | |
| `resource.*` | `CTFPlayerResource` arrays at element = player entity id | `respawnTick` = tickF(`m_flNextRespawnTime`), NaN when 0; `maxHealth` `m_iMaxHealth`; `maxBuffed` `m_iMaxBuffedHealth`; `alive` `m_bAlive`; `score` `m_iTotalScore`; `damage` `m_iDamage`; `healing` `m_iHealing` |
| `misc.healers` | `DT_TFPlayerShared.m_nNumHealers` | |
| `misc.carrying` | `DT_TFPlayerShared.m_bCarryingObject` | |
| `misc.flip` | `DT_TFPlayer.m_bFlipViewModels` | left-handed viewmodel |
| `misc.obsMode`, `.obsTarget` | `DT_BasePlayer.m_iObserverMode`, `m_hObserverTarget` | target as player index |
| `misc.revenge`, `.heads` | `DT_TFPlayerShared.m_iRevengeCrits`, `m_iDecapitations` | |
| `misc.charge` | `DT_TFPlayerShared.m_flChargeMeter` | round 0..100 (demo shield) |
| `misc.rage` | `DT_TFPlayerSharedLocal.m_flRageMeter` | round 0..100 |
| `misc.stickies` | `DT_PipebombLauncherLocalData.m_iPipebombCount` of the owned non-disguise `CTFPipebombLauncher` | 0 without one |
| `misc.saveMe` | `DT_TFPlayer.m_bSaveMeParity` | a change = a MEDIC! call |
| `builder.*` | the owned non-disguise `CTFWeaponBuilder` whose `DT_BuilderLocalData.m_iObjectType` is not 3 | `state` = `DT_TFWeaponBuilder.m_iBuildState` while that weapon is active, else 0; `type` = `m_iObjectType`; `mode` = `DT_TFWeaponBuilder.m_iObjectMode` |
| `loadout.d0..d7` | `m_hMyWeapons` elements 000..047 | item defs of the first 8 non-null handles in element order, 65535 padding |
| `loadout.w0..w3` | `_ST_m_hMyWearables_8` elements 000..007 | item defs of the first 4 handles that resolve to a tracked `CTFWearable*` instance whose def is in `options.wearableDefs` (all defs when the option is absent), 65535 padding. The frontend passes the defs of every `items.json` entry whose class starts with `tf_wearable`, so Gunboats, Mantreads, shields, the Razorback, Darwin's Danger Shield and the booties count and cosmetics do not. |
| `scoring.*` | `DT_TFPlayerSharedLocal` `DT_TFPlayerScoringDataExclusive` element that holds the match totals (section 2.6.4) | `kills` `m_iKills`, `deaths` `m_iDeaths`, `assists` `m_iKillAssists`, `damage` `m_iDamageDone`, `heals` `m_iHealPoints`, `caps` `m_iCaptures`, `defenses` `m_iDefenses`, `backstabs` `m_iBackstabs`, `headshots` `m_iHeadshots`, `invulns` `m_iInvulns`, `teleports` `m_iTeleports`, `built` `m_iBuildingsBuilt`, `destroyed` `m_iBuildingsDestroyed`, `dominations` `m_iDominations`, `revenges` `m_iRevenge`, `points` `m_iPoints`. Local-only table: empty on demos without `tv_transmitall`. |
| `itemCharge.s0..s2` | `DT_TFPlayerSharedLocal.m_flItemChargeMeter` elements 000..002 (loadout slots primary, secondary, melee) | round, clamp 0..100. Recharge of jars, milk, cleavers and balls. Local-only. |
| `vm0`, `vm1` | `CTFViewModel` with `DT_BaseViewModel.m_hOwner` = this player and `m_nViewModelIndex` 0 or 1 | `model` `m_nModelIndex`; `seq` `m_nSequence`; `parity` `m_nAnimationParity`; `muzzle` `m_nMuzzleFlashParity`; `weaponDef` = def of `m_hWeapon`; `rate` `m_flPlaybackRate`; `nodraw` = `(m_fEffects & 32) != 0` or the viewmodel is dormant |
| `fire` (EventList) | any non-disguise weapon instance owned by p whose `DT_LocalTFWeaponData.m_flLastFireTime` increases | `player` = p, `weaponDef` = that weapon's def. One event per change. |
| `anim` (EventList) | every merged `CTEPlayerAnimEvent` | `player` = p of `m_hPlayer`, `event` = `m_iEvent` (Appendix A), `data` = `m_nData` |

`alignment`: for each k, the sample tick is the first tick at or after `round(ticks * (k + 0.5) / 16)` that
received a `PacketEntities` message (on the 33 Hz 6v6 sample every second tick has none, and lib.rs fills those
ticks by interpolation, so they must not be sampled). Write the tick into `alignment.ticks[k]`. If no packet
arrives within 64 ticks of the target, write the target and NaN positions. After applying that packet, write the
player's origin taken from the same props `GameStateAnalyser` uses (`DT_TFLocalPlayerExclusive.m_vecOrigin` and
`[2]`, and `DT_TFNonLocalPlayerExclusive.m_vecOrigin` and `[2]`, last write wins, `player.rs:86-95`), but only
when the entity is present and `DT_BasePlayer.m_lifeState == 0`. Otherwise NaN.

#### 2.5.2 `weapons` (Instances)

Every instance of a weapon class. `owner` = player index of `DT_BaseCombatWeapon.m_hOwner` (255 when not a player),
`def` = `DT_ScriptCreatedItem.m_iItemDefinitionIndex` (65535 when absent), `cls` = server class id, `disguise` = 1
when `DT_TFWeaponBase.m_bDisguiseWeapon` was 1 at any time during the instance, else 0 (rule 2.3.12).

#### 2.5.3 `buildings` (Instances)

Classes: `CObjectDispenser` (type 0), `CObjectTeleporter` (1), `CObjectSentrygun` (2), `CObjectSapper` (3),
`CObjectCartDispenser` (type 0, `mapPlaced` 1). `type` prefers `DT_BaseObject.m_iObjectType` when present.

| field | source |
|---|---|
| `mode` | `DT_BaseObject.m_iObjectMode` (teleporter 0 entrance, 1 exit) |
| `builder` | player index of `m_hBuilder` (255 for map-placed) |
| `team` | `DT_BaseEntity.m_iTeamNum` at creation |
| `mini` | `m_bMiniBuilding` |
| `mapPlaced` | `m_bWasMapPlaced`, or 1 for `CObjectCartDispenser` |
| `builtOn` | sappers: building instance index of `m_hBuiltOnEntity`, first non-null value; -1 otherwise |
| `state.level` | `m_iUpgradeLevel` |
| `state.health`, `.maxHealth` | `m_iHealth`, `m_iMaxHealth` |
| `state.built` | round(`m_flPercentageConstructed` x 255) |
| `state.flags` | `BLD` bits, Appendix A |
| `state.objState` | sentry `DT_ObjectSentrygun.m_iState`, dispenser `DT_ObjectDispenser.m_iState`, teleporter `DT_ObjectTeleporter.m_iState`, else 0 |
| `state.upgradeMetal` | `m_iUpgradeMetal` |
| `state.shells`, `.rockets` | `DT_ObjectSentrygun.m_iAmmoShells`, `m_iAmmoRockets` |
| `state.metal` | `DT_ObjectDispenser.m_iAmmoMetal` |
| `state.rechargeTick`, `.rechargeDur`, `.timesUsed` | `DT_ObjectTeleporter.m_flRechargeTime` (tickF, NaN when 0), `m_flCurrentRechargeDuration` (seconds), `m_iTimesUsed` |
| `pose.yaw`, `.pitch` | round(`m_flPoseParameter` element 001 x 255), element 000; sentries only |
| `xform` | absolute `DT_BaseEntity.m_vecOrigin` and `m_angRotation`, composed with the parent's absolute transform when `DT_BaseEntity.moveparent` is set (sappers on buildings, cart dispensers on the train) |
| `enemy` | `DT_ObjectSentrygun.m_hEnemy`: kind 0 none, 1 player (index = p), 2 building (index = instance), 3 other (index 65535) |
| `heal.lo`, `.hi` | `SendPropIdentifier::new("DT_ObjectDispenser", "healing_array")`, one array value (rule 2.3.4); its EHANDLE entries mapped to player indices, as a 64-bit mask split into two u32 (bit p of lo for p < 32, bit p-32 of hi) |

#### 2.5.4 `projectiles` (Instances)

| class | condition | kind |
|---|---|---|
| `CTFProjectile_Rocket` | | 1 rocket |
| `CTFGrenadePipebombProjectile` | `DT_TFProjectile_Pipebomb.m_iType` 0 / 1 / 2 / 3 | 2 pipe / 3 sticky / 4 practice sticky / 5 cannonball |
| `CTFProjectile_SentryRocket` | | 6 sentry rocket |
| `CTFProjectile_Flare` | | 7 flare |
| `CTFProjectile_Arrow` | `m_iProjectileType` 18 | 9 repair bolt (Rescue Ranger) |
| `CTFProjectile_Arrow` | any other value (8 arrow, 19 festive) | 8 arrow |
| `CTFProjectile_HealingBolt` | | 10 healing bolt |
| `CTFProjectile_Jar` / `_JarMilk` / `_JarGas` | | 11 jarate / 12 milk / 13 gas |
| `CTFProjectile_Cleaver` | | 14 cleaver |
| `CTFStunBall` | | 15 stun ball |
| `CTFBall_Ornament` | | 16 ornament |
| `CTFProjectile_EnergyRing` | | 17 energy ring |
| `CTFProjectile_EnergyBall` | | 18 energy ball |
| `CTFProjectile_BallOfFire` | | 19 fireball |
| `CTFProjectile_MechanicalArmOrb` | | 20 short-circuit orb |
| any other `CTFProjectile_*` | | 0 unknown |

Kind 21 (syringe) exists only in `tempents.clientProjectiles`.

Base cache types and extras kinds use different numbers. The base `ProjectileType::new` maps classes this way, so
these kinds are expected to have a base slot:

| base type (`ProjectileCache` `ProjectileTypeMap`) | extras kinds |
|---|---|
| 1 `rocket` | 1 rocket, 6 sentry rocket |
| 2 `pipebomb` | 2 pipe |
| 3 `stickybomb` | 3 sticky, 4 practice sticky (Sticky Jumper) |
| 4 `healingBolt` | 10 healing bolt |

The committed parser2 binary is unpublished, so the cannonball (kind 5) and edge cases may differ. Drawing never
relies on this table. It uses the source split of D13: an extras instance belongs to `Projectiles.tsx` exactly when
its entity has a typed base slot (section 5 F3, `projectileSource.ts`). The table is the expectation that F3 and X2
log mismatches against.

| field | source |
|---|---|
| `team` | `DT_BaseEntity.m_iTeamNum` at creation |
| `owner` | classes with `DT_BaseGrenade.m_hThrower`: that player; others: `DT_BaseEntity.m_hOwnerEntity`; 255 none |
| `launcherDef` | def of `DT_BaseProjectile.m_hOriginalLauncher`, else of `DT_TFBaseRocket.m_hLauncher`, `DT_TFProjectile_Pipebomb.m_hLauncher` or `DT_TFBaseProjectile.m_hLauncher` |
| `crit` | 1 if `DT_TFProjectile_Rocket.m_bCritical`, `DT_TFWeaponBaseGrenadeProj.m_bCritical` or `DT_TFProjectile_Arrow.m_bCritical` was ever 1 |
| `sentry` | kind 6 only: the sentry instance whose pivot (origin + 46 z) is within 64 units of the first sample; 65535 otherwise |
| `hidden` | tick of the first Leave (detonating pipes and landed bolts get `EF_NODRAW` and leave) or of the Delete, whichever comes first |
| `vx, vy, vz` | `m_vInitialVelocity` from `DT_TFBaseRocket` or `DT_TFWeaponBaseGrenadeProj` |
| `pos` | one sample per tick from `created` to `hidden - 1`. Between two origin updates at most 8 ticks apart, the in-between samples are linear interpolations, as lib.rs does for base positions (33 Hz demos update every second tick). Across longer gaps the last value holds. Origin prop chosen per class when the class is registered: `DT_TFBaseRocket.m_vecOrigin` if the class has it, else `DT_TFWeaponBaseGrenadeProj.m_vecOrigin`, else `DT_BaseEntity.m_vecOrigin`. |
| `deflects` | an entry each time `m_iDeflected` increases: `team` = current `m_iTeamNum`, `owner` = current owner (`m_hDeflectOwner` for grenades when set), `count` = `m_iDeflected` |

#### 2.5.5 `flames`, `dots`

- `flames`: `CTFFlameManager`. `owner` = player index of `DT_TFFlameManager.m_hAttacker`. `box`: `firing` =
  `m_bIsFiring`; centre = `DT_BaseEntity.m_vecOrigin + (m_vecMins + m_vecMaxs) / 2` and half extents =
  `(m_vecMaxs - m_vecMins) / 2`, both from `DT_CollisionProperty`.
- `dots`: `CSniperDot` (`laser` 0) and `CLaserDot` (`laser` 1, wrangler). `owner` = player index of
  `DT_BaseEntity.m_hOwnerEntity`, `team` = `m_iTeamNum`, `pos` = `DT_BaseEntity.m_vecOrigin` plus `chargeTick` =
  tickF(`DT_SniperDot.m_flChargeStartTime`).

#### 2.5.6 `objectives`

| field | source |
|---|---|
| `gameType`, `koth` | last `DT_TFGameRules.m_nGameType` and `m_bPlayingKoth` |
| `rules.roundState`, `.winner`, `.rounds` | `DT_TeamplayRoundBasedRules.m_iRoundState`, `m_iWinningTeam`, `m_nRoundsPlayed` |
| `rules.flags` | `RULES` bits, Appendix A |
| `rules.swState` | `DT_TFGameRules.m_nStopWatchState` |
| `rules.redKoth`, `.bluKoth` | timer instance of `m_hRedKothTimer`, `m_hBlueKothTimer`, -1 none |
| `rules.hudTimer`, `.swTimer` | timer instance whose entity index equals `CTFObjectiveResource.m_iTimerToShowInHUD` / `m_iStopWatchTimer`, -1 when 0 or unresolved. Re-push the rules record when these objective-resource props change. |
| `rules.waveRed`, `.waveBlu` | tickF(`m_flNextRespawnWave` elements 002 / 003), NaN when 0 |
| `rules.restartTick` | tickF(`m_flRestartRoundTime`), NaN when not positive |
| `teams` | `CTFTeam`, key = `DT_Team.m_iTeamNum`: `score` `m_iScore`, `roundsWon` `m_iRoundsWon`, `role` `DT_TFTeam.m_iRole`, `flagCaps` `m_nFlagCaptures` |
| `timers` | `CTeamRoundTimer` instances. `paused` `m_bTimerPaused`; `endTick` tickF(`m_flTimerEndTime`); `remaining` `m_flTimeRemaining` (s); `length`, `maxLength`, `setupLength` `m_nTimerLength`, `m_nTimerMaxLength`, `m_nSetupTimeLength`; `mode` `m_nState` (0 setup, 1 normal); `flags` `TIMER` bits; `totalTime` `m_flTotalTime` (s) |
| `cp.count`, `.layout` | max `m_iNumControlPoints`, last `m_pszCapLayoutInHUD` |
| `cp.pos` | last value of `SendPropIdentifier::new("DT_BaseTeamObjectiveResource", "m_vCPPositions")`, decoded as a `SendPropValue::Array` of 8 vectors (rule 2.3.4; on steel it reads `[(-1152,-1472,-249.19), ..., (0,0,0)]`) |
| `cp.visible`, `.group`, `.pathDistance`, `.scales` | last values of `m_bCPIsVisible`, `m_iCPGroup`, `m_flPathDistance`, `m_bCPCapRateScalesWithPlayers` (per-element props, rule 2.3.4) |
| `cp.capTimeRed/Blu`, `.reqRed/Blu` | `m_flTeamCapTime[2*8+i]` / `[3*8+i]`, `m_iTeamReqCappers` same indexing |
| `cp.state` (key = point 0..7) | `owner` `m_iOwner[i]`, `capping` `m_iCappingTeam[i]`, `inZone` `m_iTeamInZone[i]`, `numRed` `m_iNumTeamMembers[16+i]`, `numBlu` `m_iNumTeamMembers[24+i]`, `lazy` `m_flLazyCapPerc[i]`, `flags` `CPF` bits, `unlockTick` tickF(`m_flUnlockTimes[i]`) NaN when 0 |
| `cp.progress` | simulated, section 2.6.1 |
| `watchers` | `CTeamTrainWatcher`: `progress` round(clamp(`m_flTotalProgress`, 0, 1) x 65535), `speed` `m_iTrainSpeedLevel`, `cappers` `m_nNumCappers`, `recedeTick` tickF(`m_flRecedeTime`) NaN when 0 |
| `cart.movers` | mover instances (section 2.5.7) of class `CPhysicsProp`, `CPhysicsPropMultiplayer` or `CDynamicProp` whose model name matches the cart pattern below |
| `cart.trains` | mover instances of class `CFuncTrackTrain` |
| `pd` | `CTFPlayerDestructionLogic` props `DT_TFRobotDestructionLogic.m_nRedScore`, `.m_nBlueScore`, `.m_nMaxPoints` (seen on 1428628: 4 instances over the demo, `m_nMaxPoints` 100, scores 1..98). Key 0 follows the newest alive instance. Verify with native `hl_extras` on 1428628 (section 2.7). |

Cart model pattern: `/bomb_cart|minecart|_cart\b|cart\.mdl/i`.

#### 2.5.7 `movers`, `pickups`, `ragdolls`, `drops`

- `movers`: classes and `cls`: `CBaseDoor` 0 (func_door, func_door_rotating, func_movelinear), `CFuncRotating` 1,
  `CFuncTrackTrain` 2, `CFuncBrush` or `CBaseEntity` with a `*N` model 3, `CPhysicsProp`/`CPhysicsPropMultiplayer`
  4, `CDynamicProp` 5. `bspModel` = N when `m_nModelIndex` resolves to `*N`, else -1. `model` = `m_nModelIndex`.
  `parent` = mover instance index of `DT_BaseEntity.moveparent` at creation, -1. `xform` = absolute transform
  (section 2.6.2). `vis` = 1 at Enter and re-Enter, 0 at Leave. Keep an instance only if `bspModel >= 0`, or it has
  more than one `xform` entry, or more than one `vis` entry, or it is a cart, or it is the parent of a kept
  instance.
- `pickups`: any tracked entity whose model name matches `/items\/(medkit|ammopack)_(small|medium|large)\.mdl$/`
  (`kind` 0 health or 1 ammo, `size` 0 small, 1 medium, 2 large) or `/plate[^/]*\.mdl$/` (health, medium).
  `CTFAmmoPack` is excluded. `x, y, z` = origin at creation. `vis` as for movers (taken = Leave, respawned =
  re-Enter).
- `ragdolls`: `CTFRagdoll`. `player` of `m_hPlayer`, `cls` `m_iClass`, `team` `m_iTeam`, `custom`
  `m_iDamageCustom`, `x, y, z` `m_vecRagdollOrigin`, `vx, vy, vz` `m_vecRagdollVelocity`, `flags` `RAG` bits
  (Appendix A).
- `drops`: `CTFAmmoPack` (`kind` 0 ammo pack, 1 building gib when the model matches `/buildables\/gibs\//`) and
  `CTFDroppedWeapon` (`kind` 2, `def` = `m_iItemDefinitionIndex`). `xform` per tick while it moves.

#### 2.5.8 `tempents`, `hurts`, `events`

- `bullets`: `CTEFireBullets`. `player` = p of entity `m_iPlayer + 1`; `weaponId` `m_iWeaponID` (Appendix A);
  `crit` `m_bCritical`; `seed` `m_iSeed`; `spread` `m_flSpread`; `x, y, z` `m_vecOrigin` (shooter eye);
  `pitch` = `m_vecAngles[0]` minus 360 when above 180; `yaw` = `m_vecAngles[1]`.
- `explosions`: `CTETFExplosion`. `m_vecOrigin[0..2]`, `m_vecNormal`, `m_iWeaponID`, `m_nDefID` (65535 none),
  `entity` = raw `entindex` (2047 none, 0 world), `particle` = `m_iCustomParticleIndex` (65535 none).
- `tracers`: `CTEEffectDispatch` whose effect name is `Tracer` and whose `entindex` is a live sentry: `sentry` =
  building instance, `s*` = `m_vStart`, `e*` = `m_vOrigin`.
- `particles`: `CTETFParticleEffect` (`name` = `m_iParticleSystemIndex`, origin `m_vecOrigin[0..2]`, `entity` =
  `entindex`) and `CTEEffectDispatch` effect `ParticleEffect` (`name` = `m_nHitBox`, origin `m_vOrigin`).
- `clientProjectiles`: `CTEEffectDispatch` effects `ClientProjectile_Syringe` (kind 21) and
  `ClientProjectile_EnergyRing` (kind 17): origin `m_vOrigin`, velocity `m_vStart`, `player` = p of `entindex`
  when it is a player, `crit` = 1 when `DT_EffectData.m_nDamageType & (1 << 20)` (DMG_CRITICAL, set in
  `tf_projectile_base.cpp:216-221`), else 0. `m_fFlags` holds the lifetime (6), not the crit.
- `hurts`: `player_hurt`. `victim` p(`userid`), `attacker` p(`attacker`), `damage` `damageamount`, `health`,
  `crit` 2 when `crit`, 1 when `minicrit`, else 0, `weaponId` `weaponid`, `custom` `custom`.
- `events` (JSON), one row per source:

| `t` | source | notes |
|---|---|---|
| `kill` | `player_death` | user ids to p; `weapon` raw string; `weaponLog` `weapon_logclassname`; `feign` = `death_flags & 0x20` |
| `uberDeployed` | `player_chargedeployed` | `medic` = userid, `target` = targetid |
| `medicDeath` | `medic_death` | `charged` true means a drop |
| `deflect` | `object_deflected` | `entity` = `object_entindex`; `projectile` = projectile instance alive with that entity id, or -1 (a player was pushed) |
| `buildStart` | derived | a new building instance with `mapPlaced` 0, at `created` |
| `buildDone` | derived | `BLD.BUILDING` goes 1 to 0 while `BLD.CARRY_DEPLOY` is 0 |
| `upgrade` | derived | `level` increases |
| `carry` | derived | the building turns dormant (Leave) |
| `redeploy` | derived | a dormant building re-enters |
| `destroyed` | `object_destroyed` | `building` = instance whose entity id equals `index` and is alive at that tick |
| `detonated` | `object_detonated` | |
| `sapped` | `player_sapped_object` | |
| `teleported` | `player_teleported` | |
| `capStart` | `teamplay_point_startcapture` | `cappers` = bytes of the string as entity indices, mapped to p |
| `captured` | `teamplay_point_captured` | same `cappers` decoding |
| `capBlocked`, `capBroken`, `cpLocked`, `cpUnlocked` | `teamplay_capture_blocked`, `teamplay_capture_broken`, `teamplay_point_locked`, `teamplay_point_unlocked` | |
| `roundStart`, `roundActive`, `setupFinished`, `roundWin` | `teamplay_round_start`, `teamplay_round_active`, `teamplay_setup_finished`, `teamplay_round_win` | |
| `overtimeStart`, `overtimeEnd` | derived | edges of `RULES.IN_OVERTIME` (the overtime game events never reach STV) |
| `timeAdded` | `teamplay_timer_time_added` | `timer` = timer instance by entity index |
| `gameOver` | `teamplay_game_over`, `tf_game_over` | |
| `banner` | `deploy_buff_banner` | |
| `pickup` | `item_pickup` | |
| `spawn`, `classChange`, `teamChange`, `disconnect` | `player_spawn`, `player_changeclass`, `player_team`, `player_disconnect` | |

Not produced, because STV never receives the source and no reliable derivation exists: extinguishes
(`player_extinguished`), ignites, `payload_pushed`, escort progress events. Burning starts are visible from
`HL.BURNING` edges.

### 2.6 Values the Rust side derives

#### 2.6.1 Capture progress (port of `C_BaseTeamObjectiveResource::ClientThink`, `c_team_objectiveresource.cpp:214-460`)

State per point i: `capTimeLeft` (seconds), plus the latest networked values from `cp.state` and the static arrays.
`teamCapTime(i, team)` = `capTimeRed[i]` for team 2, `capTimeBlu[i]` for team 3, else 0.
`members(i, team)` = `numRed[i]` for team 2, `numBlu[i]` for team 3, else 0.
`blocked[i]` = `CPF.BLOCKED`, `locked[i]` = `CPF.LOCKED`, `teamCanCap(i, team)` = `CPF.RED_CAN_CAP` for team 2,
`CPF.BLU_CAN_CAP` for team 3, else false, all from the latest `cp.state` entry. `IN_OVERTIME` comes from the latest
`objectives.rules` entry.
Convars from `SetConVar` if present: `mp_capstyle` (default 1), `mp_capdeteriorate_time` (default 90).

```text
on capping[i] change to team:            capTimeLeft = (team != owner[i] && team > 1) ? teamCapTime(i, team) : 0
on owner[i] change to team:              if team == capping[i]: capping[i] = 0; capTimeLeft = 0
on lazy[i] change:                       capTimeLeft = lazy[i] * teamCapTime(i, capping[i])
after every packet, dt = intervalPerTick * (ticks since the previous packet):
  if capTimeLeft != 0 and not blocked[i]:
    team = inZone[i]; n = members(i, team); deteriorate = true
    if n > 0:
      reduction = dt
      if capstyle == 1 and scales[i]: for k in 1..n-1: reduction += dt / (k + 1)
      if team == capping[i]:               capTimeLeft -= reduction; deteriorate = false
      elif owner[i] == 0 and team != 0:    capTimeLeft += reduction; deteriorate = false
    if deteriorate:
      if not locked[i] and teamCanCap(i, capping[i]):
        len = teamCapTime(i, capping[i]); scale = scales[i] ? capdeteriorate_time : len
        dec = (len / scale) * dt; if IN_OVERTIME: dec *= 6
        capTimeLeft += dec
      else: capTimeLeft = 0
    capTimeLeft = clamp(capTimeLeft, 0, teamCapTime(i, capping[i]))
progress = len > 0 ? (len - capTimeLeft) / len : 0     (len = teamCapTime(i, capping[i]); 0 when capTimeLeft == 0)
push cp.progress(i, tick, round(progress * 65535))
```

#### 2.6.2 Mover and parented transforms

`abs(child) = abs(parent) composed with local(child)`: `p_abs = p_parent + rotate(q_parent, p_local)`,
`q_abs = q_parent * q_local`. When a parent's absolute transform changes, re-push every tracked child, recursively,
at that tick. When `moveparent` is null or untracked, the local transform is used as absolute and the instance gets
`meta.warnings += "untracked parent for <class> <entityId>"` once per class.

#### 2.6.3 Other derivations

- `overtimeStart`/`overtimeEnd`: edges of `RULES.IN_OVERTIME` in `objectives.rules`.
- Building events: section 2.5.8 table.
- `tracers.sentry`, `projectiles.sentry`, `events[].building`, `events[].projectile`: resolved against instances
  alive at that tick.
- `meta.snapshotInterval`: the most common gap in server ticks between consecutive `PacketEntities` messages.

#### 2.6.4 Scoring element

`DT_TFPlayerSharedLocal` sends `m_ScoreData` (match totals) and then `m_RoundScoreData` (reset every round), both
as `DT_TFPlayerScoringDataExclusive` (`tf_player_shared.cpp:487-525`). Rule 2.3.3 tells the two apart by flattened
index. Send-table order suggests that element 0 is `m_ScoreData`, but flattening can reorder datatables. So P1
picks the element at the end of the parse: the one whose `m_iKills` decreased fewer times across the demo is the
match total. P1 records the choice in `meta.counts['scoring.element']` and adds a warning when both elements
decreased equally often. `scoring` comes from that element only.

### 2.7 Build, copy and verify

```sh
cd /home/dalibor/programming/personal/dribble-parser-wt/p1
flock $S/heavy.lock env CARGO_BUILD_JOBS=4 cargo build --release --bin hl_extras
target/release/hl_extras /home/dalibor/demo_tool/demos/1434434.dem --json $S/p1/1434434.json
flock $S/heavy.lock env CARGO_BUILD_JOBS=4 ~/.local/bin/wasm-pack build --target web --release \
  --out-dir $S/hlextras-pkg --out-name hlextras
mkdir -p <frontend worktree>/src/libs/hlextras
cp $S/hlextras-pkg/hlextras.js $S/hlextras-pkg/hlextras.d.ts $S/hlextras-pkg/hlextras_bg.wasm \
   $S/hlextras-pkg/hlextras_bg.wasm.d.ts <frontend worktree>/src/libs/hlextras/
```

`hl_extras` prints per-group entry counts, typed-array bytes, parse time (measured natively with `Instant`; never
call `Instant` inside `src/extras`, which also runs in wasm) and peak RSS (`VmHWM`), and with `--json` writes them
plus the event-type counts. Options:

| option | effect |
|---|---|
| `--start-tick N --tick-base N --ticks N --players e0,e1,...` | explicit base values; without them it uses rule 2.3.11 |
| `--self-check` | rule 2.3.11 mode: compares the alignment samples with the `GameStateAnalyser` positions (section 3.6 rules); exit code 1 on failure |
| `--print-options <file>` | writes the derived options as JSON (`startTick`, `tickBase`, `ticks`, `intervalPerTick`, `playerEntityIds`) |
| `--wearable-defs <file>` | JSON array for `wearableDefs` (the checker writes the same list the browser passes) |
| `--counts-only` | prints only the survey counts below and skips building the output |

The Node checker runs in two processes, because parser2's wasm heap never shrinks: on 1442753 its projectile cache
alone is 332 MB in wasm plus the same again as JS copies, so one process would measure parser2, not the extras.

- `scripts/hl/base-values.mjs <demo.dem> --out <file.json>` (P1) loads `src/libs/parser2` with `initSync`, parses
  the demo, writes `startTick`, `startDemoTick`, `tickBase`, `ticks`, `intervalPerTick`, `nextMappedPlayer`,
  `playerEntityIds`, `sceneOrigin` (the boundaryMin after any override shift) and, for every k, the base position
  and health of every player at each tick from `round(ticks * (k + 0.5) / 16)` to 64 ticks later. Then it exits.
- `scripts/hl/check-extras.mjs <demo.dem> [--expect scripts/hl/expect/<demo>.json] [--options-from <file>]` (P1)
  runs `base-values.mjs` as a child process with `spawnSync(process.execPath, ...)`, or reads a native
  `--print-options` file instead for demos too large for parser2 in Node. In its own process it then loads
  `src/libs/hlextras` with `initSync`, copies the file into an `ExtrasInput`, drops the Node buffer, calls
  `parse_demo_extras_input` with the base values and the wearable defs from `src/constants/items.json`, hydrates
  with the `src/highlander/extras/hydrate.ts` logic (ported to plain JS in the script, or bundled with esbuild,
  which is in node_modules), runs the alignment check of section 3.6 against the child's samples (with
  `--options-from` the native `--self-check` covers alignment), prints counts, and reports its own `VmHWM` from
  `/proc/self/status`. That number is the extras path alone.

Run it as `flock $S/heavy.lock node scripts/hl/check-extras.mjs <demo.dem> --expect ...`. The expectation files
hold the numbers below and fail the run on a mismatch.

Acceptance numbers. The probe counts include events before the cache start, so a count passes when it lies within
95 % to 100 % of the probe value. Exact values are marked "=".

| demo | check | probe value |
|---|---|---|
| 1434434 | `HL.CLOAKED` rising edges, all players | 10 |
| 1434434 | `HL.DISGUISED` / `HL.UBER` / cond 11 / `HL.FEIGN` / `HL.ZOOMED` rising edges | 14 / 18 / 2 / 3 / 61 |
| 1434434 | `tempents.bullets` / `players.anim` / `tempents.explosions` | 859 / 9356 / 292 |
| 1434434 | `players.fire` for "Dwapking" (soldier) / "kanon" (scout) / "dastron" (demoman) / the sniper / the heavy | 43 / 36 / 56 / 17 / 351 |
| 1434434 | `dots` instances laser 0 / laser 1 | 61 / 7 |
| 1434434 | `buildings` sentry / dispenser with `mapPlaced` 0 / teleporter instances; `CObjectCartDispenser` instances (`mapPlaced` 1) | 6 / 3 / 6; = 2 |
| 1434434 | `weapons` `CWeaponMedigun` instances with `disguise` 1; `players.medigun` entries with a non-65535 `def` for spies | 6; = 0 |
| 1434434 | `projectiles` kind 1 / kinds 2+3 / 7 / 8+9 / 10 / 6 / 16 | 86 / 140 / 68 / 15 / 15 / 14 / 18 |
| 1434434 | `kill` events / of which `feign` | 33 / 3 |
| 1434434 | `objectives.cp.count` = 4, `cp.pathDistance[0..3]` = 0.251, 0.451, 0.7176, 1 (within 0.001) | |
| 1438891 | `HL.CLOAKED` / `HL.ZOOMED` rising edges | 51 / 249 |
| 1438891 | `tempents.bullets` / `players.anim` | 5001 / 50239 |
| 1438891 | `buildings` sentry / sapper instances; `flames` instances | 29 / 13; 333 |
| 1438891 | `weapons` `CWeaponMedigun` instances with `disguise` 1; spy `players.medigun` entries with a def | 29; = 0 |
| 1438891 | `kill` events / `feign` | 211 / at least 16 |
| 1438891 | `objectives.koth` = true, `rules.redKoth` and `rules.bluKoth` resolve to timers | |
| 1438891 | `meta.counts['scoring.element']` is set and `scoring` has entries for at least 16 players | |
| 1440442 | `RULES.STOPWATCH` set; `swState` reaches 1; `cp.count` = 5; `capStart` and `captured` events present | |
| 1440442 | `convarAt(x, 'mp_tournament_redteamname', 0)` = `"BLU"` (signon convars at tick 0, section 1.2); `CWeaponMedigun` disguise instances 27 | |
| `i52_snakewater_gc.dem` | `meta.snapshotInterval` = 2; every `alignment.ticks[k]` received a packet; the alignment check passes | |
| 1428628 (native `hl_extras --self-check`) | `pd` has entries, `pd.max` = 100 and both scores pass 90; the self-check passes on tetsudo, whose world bounds carry HUD data (section 4.5 item 4) | |
| all | alignment: the section 3.6 rule passes | |
| all | the parse never panics and `meta.warnings` has no "truncated" entry | |

Speed and size: in Node, `parse_demo_extras_input` takes at most 3 s on 1434434 and at most 7 s on 1438891. Output
typed arrays sum to at most 8 MB on 1434434 and at most 25 MB on 1438891. The checker's own `VmHWM` stays at or
below `2.6 x file size + 100 MB` (section 2.8).

Survey for rare kinds. None of 1434434, 1438891 or 1440442 has a syringe gun, a `ClientProjectile_*` effect,
jarate (cond 24), Mad Milk (27), a Quick-Fix uber (28) or a Vaccinator uber (58 to 60). P1 runs
`hl_extras --counts-only` over every demo in `/home/dalibor/demo_tool/demos` (one at a time under the lock, about
10 minutes) and writes `$S/p1/survey.json`: per demo, the rising edges of conds 15, 24, 27, 28, 58, 59, 60 and 123,
`clientProjectiles` kinds 17 and 21, `projectiles` kinds 5, 9 and 11 to 20, `dots` with `laser` 1, and the
`banner`, `teleported`, `sapped` and `deflect` event counts. F1, F3 and F5 pick their demos for those kinds from the
survey. A kind with no demo in the survey is reported as "unvalidated" by the task that owns it.

### 2.8 Memory budget for a 130k-tick 9v9 demo

The largest local demos are 1429417.dem (tow_tetsudo, 130 079 ticks, 122 MB) and 1433815.dem (koth_ashville,
130 318 ticks, 123 MB). Estimates scale the 1438891 measurements by 130/54.

| group | estimate | cap |
|---|---|---|
| players tracks (cond to loadout) | 4 MB | 6 MB |
| `vm0`, `vm1` | 1.5 MB | 3 MB |
| `fire`, `anim` | 1.5 MB | 3 MB |
| `weapons`, `buildings`, `dots`, `pickups`, `ragdolls`, `drops` | 2 MB | 4 MB |
| `projectiles` (position samples dominate; sticky traps live long) | 8 MB | 16 MB |
| `flames` | 2 MB | 4 MB |
| `objectives` (cart moving every tick, cap progress) | 1.5 MB | 3 MB |
| `movers` (doors, `CFuncRotating` every tick on cp_steel) | 4 MB | 8 MB |
| `tempents`, `hurts`, `events` | 2 MB | 4 MB |
| `scoring`, `itemCharge`, loadout wearables | 0.5 MB | 1 MB |
| total typed arrays after hydration | about 28 MB | 49 MB |

Peak inside the extras worker, with input ownership (section 2.2) and group-by-group output conversion: the file in
wasm memory (file size), the transferred JS buffer until the worker drops it (file size, only during the copy),
parser state (about 20 MB), the builders (about the output size) and the JS copy of one group at a time. For 122 MB
that is about 250 MB, against about 350 MB without input ownership. The cap is `2.6 x file size + 60 MB` in the
browser worker and `2.6 x file size + 100 MB` for the checker process, which also holds the Node runtime.

Where it is measured:

| demos | how | when |
|---|---|---|
| 1434434, 1438891, 1442753 | `check-extras.mjs` with the base-values child process | every P1 run; the child for 1442753 peaks near 0.8 GB, so that one waits for 1500 MB available |
| 1428628 (tug of war, 90 MB, 94 378 ticks), 1432698 (vigil, 1557 s, 101 MB), 1437285 (warmtic, 2041 s, 120 MB), 1429417 and 1433815 (130k ticks) | native `hl_extras --self-check` (about 250 MB) | every P1 run |
| the same five | `check-extras.mjs --options-from <native options>` (wasm path, no parser2) | only when `free -m` shows at least 1500 MB available |
| the same five in the browser | X1 and F5 harness runs | only when `free -m` shows at least 3000 MB available |

P1 fits `peakMB = a x fileMB + b` over the measured demos and writes `a`, `b` and the measured bytes per group per
demo minute into `src/highlander/extras/memory.ts`. Section 8 uses them.

---

## 3. TypeScript data layer

### 3.1 Files

| file | written by | content |
|---|---|---|
| `src/highlander/extras/types.ts` | S0 | schema, section 2.5, verbatim |
| `src/highlander/extras/enums.ts` | S0 | Appendix A constants and `deriveFlags()` |
| `src/highlander/extras/track.ts` | S0 | complete track and event helpers, section 3.7.1 |
| `src/highlander/extras/hooks.ts` | S0 | `useExtras()`, `useExtrasStatus()`, `useHlSetting(path)` |
| `src/highlander/extras/getters.ts` | S0 writes the signatures with stub bodies (return `null` or the documented default); P1 writes the bodies | section 3.7.2 |
| `src/highlander/extras/loadExtras.ts` | S0 stub (`startHighlanderExtras` sets status `'disabled'` and returns); P1 replaces it | section 3.4 |
| `src/highlander/extras/ExtrasWorker.ts` | P1 | worker entry |
| `src/highlander/extras/hydrate.ts` | P1 | section 3.5 |
| `src/highlander/extras/alignment.ts` | P1 | section 3.6 |
| `src/highlander/extras/memory.ts` | P1 | measured peak fit and group sizes (sections 2.8 and 8), `planExtrasGroups()` |
| `src/highlander/extras/findTicks.ts` | S0 stub returning `[]` (the bridge imports it); P1 implements | section 3.8 |
| `src/highlander/items.ts` | S0 | `items.json` accessors, section 3.7.3 |
| `src/highlander/settings.ts` | S0 | section 6.3 |
| `src/highlander/constants.ts` | S0 | section 1.5 |
| `src/highlander/debug.ts` | S0 | probe registry, section 3.10 |
| `src/libs/hlextras/{hlextras.js, hlextras.d.ts, hlextras_bg.wasm, hlextras_bg.wasm.d.ts}` | P1 | wasm-bindgen output (excluded from `tsc` by `tsconfig.json`) |
| `scripts/hl/check-extras.mjs`, `scripts/hl/base-values.mjs`, `scripts/hl/expect/<demo>.json` | P1 | section 2.7 |

S0 also adds `"@highlander/*": ["src/highlander/*"]` to `tsconfig.json` `paths` (vite picks it up through
`vite-tsconfig-paths`).

Stub rule (tsc runs with `noUnusedLocals` and `noUnusedParameters`): stub bodies prefix unused parameters with an
underscore (`_x`, `_p`, `_tick`) and stub components take `_props`. Parameter names are not part of the API, so the
task that writes a body renames them. Stubs never destructure props they do not use.

### 3.2 Base parser additions (S0)

`ParseWorker.ts`:
- `WasmPlayerCache` gains `duck?: Uint8Array[]`. `WasmResult` gains `startTick: number`, `startDemoTick: number`,
  `tickBase: number`, `endTick?: number`, `endDemoTick?: number`.
- After hydration: `if (wasmPlayerCache.duck) playerCache.duckCache.data = wasmPlayerCache.duck`, and its buffers
  go into the transfer list.
- `CachedDemo` gains `startTick`, `startDemoTick`, `tickBase`, `positionScale`, copied from the result.
- The result message also carries `fileBuffer`: the input `ArrayBuffer`, which wasm-bindgen copied into the wasm heap
  and the worker no longer needs. It goes into the transfer list, so the file comes back to the main thread at no
  cost and `actions.ts` no longer copies it with `fileBuffer.slice(0)` during the base parse.

`PlayerCache.ts`:
- `duckCache: SparseDataCache = new SparseDataCache(tickCount, 1, 8, 0)`, rehydrated with the others.
- `getDuck(playerId: number, tick: number): number` (bit0 `FL_DUCKING`, bit1 `FL_ANIMDUCKING`; 0 without data).
  It is not added to `getPlayer`.

`AsyncParser.ts`:
- Fields `startTick = 0`, `startDemoTick = 0`, `tickBase = 0`, `positionScale = POSITION_FIXED_SCALE`, copied in
  `cache()`.
- `getCachedData()` calls `worker.terminate()` after it resolved or rejected.
- `cache()` keeps the returned `fileBuffer` in a private field. `takeFileBuffer(): ArrayBuffer | undefined` returns it
  once and clears the field.
- `playerEntityIds(): Uint32Array`: length `nextMappedPlayer`, element p = `entityPlayerMap.get(p)?.user.entityId`
  or 0.
- `playerIndexOfEntity(entityId: number): number`: from a lazily built `Map`, -1 when unknown.

`src/utils/parser.ts`: `Math.ceil` becomes `Math.floor` for seconds (fixes "09:60").

### 3.3 Store additions (S0)

`StoreState.settings` gains `highlander: HighlanderSettings`. `initialState.settings.highlander =
cloneDeep(DEFAULT_HIGHLANDER_SETTINGS)` (lodash), so the shallow-clone reducer never mutates the constant.
`loadSettingsAction` already deep-merges saved settings into defaults, so new keys appear for existing users.

`InstanceState` gains exactly:

```ts
extras?: HighlanderExtras
extrasStatus: 'idle' | 'disabled' | 'loading' | 'ready' | 'error'
extrasProgress: number                    // 0..100
extrasError?: string
setExtras: (extras?: HighlanderExtras) => void
setExtrasStatus: (status: InstanceState['extrasStatus'], progress?: number, error?: string) => void
povCameraOverride?: THREE.Camera          // F4 POV subject camera (section 5 F4); Controls uses it only in POV mode with a focused player
setPovCameraOverride: (camera?: THREE.Camera) => void
scopeActive: boolean                      // F4 ScopeOverlay visible; the base Crosshair hides while true
setScopeActive: (active: boolean) => void
scoreboardOpen: boolean                   // Tab held (S0 key handler); F5 Scoreboard shows while true
setScoreboardOpen: (open: boolean) => void
mapNodes?: Map<number, THREE.Object3D>    // M1: brush-entity parent nodes by bspModelIndex
setMapNodes: (nodes?: Map<number, THREE.Object3D>) => void
mapStatus: { state: 'idle' | 'loading' | 'ready' | 'missing' | 'error'; message?: string; folder?: string; pipeline?: string }
setMapStatus: (status: InstanceState['mapStatus']) => void
actorRegistryVersion: number              // bumped when an actor mounts or unmounts
bumpActorRegistryVersion: () => void
```

Initial values: `extrasStatus 'idle'`, `extrasProgress 0`, `mapStatus { state: 'idle' }`, `actorRegistryVersion 0`,
`scopeActive false`, `scoreboardOpen false`.
These live in the instance store, never in the Redux store (devtools would choke on typed arrays).

### 3.4 Loading flow

S0 edits `src/zustand/actions.ts`:

```ts
// parseDemoAction, first statement, before `new AsyncParser(fileBuffer, ...)`:
cancelHighlanderExtras()                       // D4: the previous demo's extras must not run beside this base parse
const wantExtras = getState().settings.highlander?.enabled !== false
// ... unchanged base parse, PARSE_DEMO_SUCCESS, await loadSceneFromDemoAction(parsedDemo) ...
const extrasBuffer = wantExtras ? parsedDemo.takeFileBuffer() : undefined   // handed back by the base worker (3.2)
if (!wantExtras) useInstance.getState().setExtrasStatus('disabled')
else if (!extrasBuffer) useInstance.getState().setExtrasStatus('error', 100, 'file buffer not returned by the parser')
else void startHighlanderExtras(extrasBuffer, parsedDemo)

// loadSceneFromDemoAction and loadEmptySceneMapAction, next to setParsedDemo(...):
cancelHighlanderExtras()
useInstance.getState().setExtras(undefined)
useInstance.getState().setExtrasStatus('idle', 0)
useInstance.getState().setPovCameraOverride(undefined)

// jumpToRtsCamera and jumpToSpectatorCamera, next to setFocusedObject(undefined):
useInstance.getState().setPovCameraOverride(undefined)
```

P1 implements `src/highlander/extras/loadExtras.ts`:

```ts
export async function startHighlanderExtras(buffer: ArrayBuffer, parsedDemo: AsyncParser): Promise<void>
export function cancelHighlanderExtras(): void
```

1. `const req = ++requestId`; terminate any running extras worker.
2. `const plan = planExtrasGroups(buffer.byteLength)` (`memory.ts`, section 8). When `plan.skip` is true,
   `setExtrasStatus('disabled', 0, plan.reason)` and return.
3. `setExtrasStatus('loading', 0)`.
4. `options = { startTick, tickBase, ticks, intervalPerTick, playerEntityIds: Array.from(parsedDemo.playerEntityIds()), groups: plan.groups, wearableDefs: wearableDefs() }`
   (`wearableDefs()` from `items.ts`).
5. `new Worker(new URL('./ExtrasWorker.ts', import.meta.url), { type: 'module' })`, then post
   `{ buffer, options, sceneOrigin: { ...parsedDemo.world.boundaryMin }, map: parsedDemo.header.map }` with
   `[buffer]` as transfer list.
6. `{ type: 'progress', progress }`: `setExtrasStatus('loading', progress)` when the integer changes.
7. `{ type: 'result', extras }`: drop it if `req !== requestId` or `useInstance.getState().parsedDemo !== parsedDemo`.
   Otherwise run `checkAlignment(extras, parsedDemo)`. On success `setExtras(extras)` then
   `setExtrasStatus('ready', 100)` and log `[HL] extras ready` with `meta.parseMs`, total typed-array bytes,
   `meta.counts` and `meta.excluded`. On failure `setExtrasStatus('error', 100, 'misaligned: <reason>')` and keep
   `extras` unset.
8. `{ type: 'error', error }`, `worker.onerror`, or no result after 180 s: `setExtrasStatus('error', 100, message)`.
9. Every terminal path calls `worker.terminate()`. `cancelHighlanderExtras()` bumps `requestId` and terminates.
10. Nothing throws into the caller.

`ExtrasWorker.ts` (P1):

```ts
import init, { ExtrasInput, parse_demo_extras_input } from '../../libs/hlextras/hlextras.js'
import type { ExtrasRaw } from './types'
import { collectBuffers, hydrate } from './hydrate'

// The DOM lib types the worker global as Window, whose postMessage needs a target origin (TS2769). Same fix as ParseWorker.ts:10.
declare function postMessage(message: any, transfer?: any[]): void

onmessage = async (event: MessageEvent) => {
  const data = event.data
  try {
    const wasm = await init()
    const t0 = performance.now()
    let bytes: Uint8Array | null = new Uint8Array(data.buffer)
    data.buffer = null                                         // after the copy below, no JS reference to the file remains
    const input = new ExtrasInput(bytes.length)
    new Uint8Array(wasm.memory.buffer, input.ptr(), bytes.length).set(bytes)
    bytes = null
    const raw = parse_demo_extras_input(input, data.options, (p: number) => postMessage({ type: 'progress', progress: p }))
    if (typeof raw === 'string' || !raw) return postMessage({ type: 'error', error: raw || 'extras parse failed' })
    ;(raw as ExtrasRaw).meta.parseMs = performance.now() - t0
    const extras = hydrate(raw as ExtrasRaw, data.sceneOrigin)
    postMessage({ type: 'result', extras, ms: performance.now() - t0 }, collectBuffers(extras))
  } catch (e) {
    postMessage({ type: 'error', error: e instanceof Error ? e.message : String(e) })
  }
}
```

### 3.5 Hydration (`hydrate.ts`, P1)

`export function hydrate(raw: ExtrasRaw, sceneOrigin: { x: number; y: number; z: number }): HighlanderExtras` is a
pure function. The Node checker reuses its logic.

1. Subtract `sceneOrigin` in place from these fields (NaN stays NaN): `alignment.pos` (stride 3),
   `buildings.xform.x/y/z`, `projectiles.pos` (stride 3), `flames.box.cx/cy/cz`, `dots.pos.x/y/z`,
   `objectives.cp.pos` (stride 3), `movers.xform.x/y/z`, `pickups.x/y/z`, `ragdolls.x/y/z`, `drops.xform.x/y/z`,
   `tempents.bullets.x/y/z`, `tempents.explosions.x/y/z`, `tempents.tracers.sx/sy/sz/ex/ey/ez`,
   `tempents.particles.x/y/z`, `tempents.clientProjectiles.x/y/z`. Velocities, normals, half extents and
   quaternions are not shifted.
2. `derived.flags[i] = deriveFlags(w0[i], w1[i], w2[i], w3[i], w4[i])` for every `players.cond` entry.
3. `derived.entityToPlayer` from `players.entityId` (skip 0).
4. `ByPlayer` index lists (counting sort that keeps tick order) for `players.fire` and `players.anim` (by
   `player`), `tempents.bullets` (by `player`), `hurts` (by `victim` and by `attacker`).
5. `projectilesByEntity`, `buildingsByEntity`: entity id to instance indices sorted by `created`.
6. `eventsByType`: `HlEvent.t` to indices into `events`.
7. `collectBuffers(extras)` returns every typed array's `buffer`, deduplicated.

The result is plain objects, typed arrays and `Map`s. Nothing needs prototype restoration on the main thread.
Excluded groups arrive empty (section 2.2), so every step above runs on them unchanged.

### 3.6 Alignment check (`alignment.ts`, P1)

`export function checkAlignment(x: HighlanderExtras, d: AsyncParser): { ok: boolean; reason?: string; pairs: number; within: number }`

1. Require `x.meta.startTick === d.startTick`, `x.meta.tickBase === d.tickBase`, `x.meta.ticks === d.ticks`,
   `x.meta.playerCount === d.nextMappedPlayer`. A mismatch returns `ok: false` with the field name.
2. Read the base at the ticks Rust sampled, `x.alignment.ticks[k]`, which always received a packet, so the base
   value there is not interpolated. For each k and player p, the base sample is alive when its position is not
   exactly (0, 0, 0) and its health is above 0; count those as `aliveBase`. Skip a (k, p) when the extras sample is
   NaN or the base sample is not alive. Otherwise count a pair, and count it as within when the scene distance is
   at most 4 units.
3. `need = Math.min(20, Math.ceil(aliveBase / 2))`. When `aliveBase === 0`, return `ok: true` with reason
   `'no alive samples'` and log a warning. Otherwise
   `ok = pairs >= need && (pairs >= 20 ? within / pairs >= 0.9 : within === pairs)`. So an output whose player
   samples are all NaN (wrong entity ids, missing origin props) fails instead of passing with zero pairs.

### 3.7 Accessors

#### 3.7.1 `track.ts` (S0, complete)

```ts
/** Index of the entry of `key` in effect at `tick`, or -1. */
export function trackIndexAt(t: Track, key: number, tick: number): number {
  const lo0 = t.offsets[key], hi0 = t.offsets[key + 1]
  if (lo0 === undefined || hi0 === undefined || lo0 === hi0) return -1
  let lo = lo0, hi = hi0
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (t.ticks[mid] <= tick) lo = mid + 1; else hi = mid }
  return lo - 1 >= lo0 ? lo - 1 : -1
}
/** Tick of the first entry of `key` after `tick`, or Infinity. */
export function trackNextTick(t: Track, key: number, tick: number): number
/** [start, end) global entry range of `key`. */
export function trackRange(t: Track, key: number): [number, number]
/** First index i in sorted `ticks` with ticks[i] >= tick. */
export function lowerBound(ticks: U32, tick: number, lo = 0, hi = ticks.length): number
/** [start, end) of events with from <= tick < to. */
export function eventRange(ticks: U32, from: number, to: number): [number, number]
/** Rows of a ByPlayer list for key p with from <= tick < to, as indices into the global list. */
export function byPlayerRange(idx: ByPlayer, list: EventList, p: number, from: number, to: number): number[]
/** Walk back from the entry in effect at `tick` while `test(entry)` holds; returns the tick where it started, or null. */
export function sinceTick(t: Track, key: number, tick: number, test: (i: number) => boolean, maxSteps = 256): number | null
/** Linear interpolation of a Float32 field between the entry in effect at tickF and the next one, only when the next entry is at most maxGap ticks later. */
export function lerpField(t: Track, field: F32, key: number, tickF: number, maxGap = 1): number
/** Same for xform tracks: writes position and slerped quaternion into the outputs. */
export function xformAt(t: XformTrack, key: number, tickF: number, outPos: THREE.Vector3, outQuat: THREE.Quaternion, maxGap = 1): boolean
```

`lerpField` and `xformAt` interpolate between the entry in effect and the next entry when the two are at most
`maxGap` ticks apart. Callers pass `x.meta.snapshotInterval`, so objects on 33 Hz demos move every frame like the
lerped base actors instead of stepping every second tick. A larger gap means the value held, so they return the
held value. Both are pure functions of `tickF`, which keeps the rendering seek-deterministic.

#### 3.7.2 `getters.ts` (S0 signatures, P1 bodies)

All take `x: HighlanderExtras` first. `p` is a player index, `tick` an integer cache tick, `tickF` fractional. The
parameter types are left out below for width; in the file every parameter is typed (`x: HighlanderExtras`, the rest
`number`).

```ts
export function playerIndexOf(x, entityId: number): number                 // -1 unknown
export function flagsAt(x, p, tick): number                                 // HL mask, 0 without data
export function condAt(x, p, tick, cond: number): boolean                   // raw ETFCond test on w0..w4
export function flagSince(x, p, tick, bit: number): number | null           // tick the flag became set, null if not set
export function flagClearedSince(x, p, tick, bit: number): number | null    // tick the flag last went from set to clear, null while set or if never set (within 256 entries)
export function invisAt(x, p, tickF, cap = 0.95): number                   // 0..cap, formula below; cap 0.95 is the spectator view, 1 the enemy view
export function cloakMeterAt(x, p, tick): number                            // 0..100, 100 without data
export interface DisguiseState { team: number; cls: number; target: number; health: number; weaponDef: number; disguising: boolean; desiredTeam: number; desiredCls: number; since: number }
export function disguiseAt(x, p, tick): DisguiseState | null                // null unless DISGUISED or DISGUISING
export interface ActiveWeapon { id: number; def: number; cls: string; kind: string; slot: string; name: string; since: number }
export function activeWeaponAt(x, p, tick, classId: number): ActiveWeapon | null
export interface WeaponState { state: number; reload: number; clip: number; readyToBackstab: boolean; critFire: boolean; lowered: boolean; chargeTick: number | null }
export function weaponStateAt(x, p, tick): WeaponState | null
export type MedigunType = 'medigun' | 'kritzkrieg' | 'quickfix' | 'vaccinator'
export interface MedigunState { charge: number; healing: boolean; attacking: boolean; releasing: boolean; holstered: boolean; target: number; def: number; type: MedigunType; resist: number }
export function medigunAt(x, p, tick): MedigunState | null                  // null when def is 65535
export function sniperChargeAt(x, p, tick): number                          // 0..150
export function fovAt(x, p, tickF, defaultFov = 90): number                 // Source FOV (horizontal at 4:3)
export function verticalFov(fovH43: number): number                         // degrees, for three.js
export function eyeZAt(x, p, tick): number | null                           // m_vecViewOffset z, null without data
export function respawnSecondsAt(x, p, tickF): number | null                // null when alive or unknown
export function ammoAt(x, p, tick): { primary: number; secondary: number; metal: number } | null
export function loadoutAt(x, p, tick): number[]                             // weapon defs (d0..d7), then wearable defs (w0..w3) known to items.json; 65535 dropped
export interface ScoringState { kills: number; deaths: number; assists: number; damage: number; heals: number; caps: number; defenses: number; backstabs: number; headshots: number; invulns: number; teleports: number; built: number; destroyed: number; dominations: number; revenges: number; points: number }
export function scoringAt(x, p, tick): ScoringState | null                  // null without data (no tv_transmitall)
export function itemChargeAt(x, p, tick): { primary: number; secondary: number; melee: number } | null   // 0..100
export interface VmState { model: string; seq: number; parity: number; muzzle: number; weaponDef: number; rate: number; nodraw: boolean; since: number }
export function viewmodelAt(x, p, tick, which: 0 | 1): VmState | null
export function fireTicks(x, p, from, to): number[]
export function animEvents(x, p, from, to): { tick: number; event: number; data: number }[]
export function miscAt(x, p, tick): { healers: number; carrying: boolean; flip: boolean; obsMode: number; obsTarget: number; revenge: number; heads: number; charge: number; rage: number; stickies: number; saveMeTick: number } | null
export interface RulesState { roundState: number; winner: number; flags: number; swState: number; rounds: number; redKoth: number; bluKoth: number; hudTimer: number; swTimer: number; waveRed: number; waveBlu: number; restartTick: number }
export function rulesAt(x, tick): RulesState | null
export function timerSecondsAt(x, timer: number, tickF): number             // formula below
export function capProgressAt(x, point: number, tickF): number              // 0..1, lerpField with maxGap = meta.snapshotInterval
export function teamAt(x, team: number, tick): { score: number; roundsWon: number; role: number } | null
export function convarAt(x, key: string, tick): string | undefined          // last SetConVar value at or before tick
```

Formulas the bodies must implement exactly:

```ts
// invisAt: tf2-reference 3.2 (InvisibilityThink), spectator cap 0.95; Cloak and Dagger empty-meter motion cloak is not modelled
const i = trackIndexAt(x.players.cond, p, Math.floor(tickF)); if (i < 0) return 0
const f = x.derived.flags[i]
const S = (f & HL.CLOAKED) !== 0
const j = trackIndexAt(x.players.invis, p, Math.floor(tickF))
const C = j < 0 ? -Infinity : x.players.invis.completeTick[j]
const dt = (C - tickF) * x.meta.intervalPerTick            // seconds until the fade completes
let inv = C > tickF ? (S ? 1 - dt : dt * 0.5) : (S ? 1 : 0)
if (f & (HL.CLOAK_BLINK | HL.JARATED)) inv *= 0.85
return Math.min(cap, Math.max(0, inv))
// Dead Ringer cloaks set m_flInvisChangeCompleteTime to the onset time (tf2-reference 3.1), so a feign cloak is
// fully invisible from its onset: 0.95 at onset + 0 in the spectator view.

// fovAt: C_BasePlayer::GetFOV (c_baseplayer.cpp:2435-2504)
const i = trackIndexAt(x.players.fov, p, Math.floor(tickF)); if (i < 0) return defaultFov
const t = x.players.fov
const target = t.fov[i] || defaultFov, start = t.start[i] || defaultFov, rate = t.rate[i]
if (!(rate > 0) || target === start) return target
const d = ((tickF - t.tick[i]) * x.meta.intervalPerTick) / rate
if (d >= 1) return target
const s = Math.max(0, d)
return start + (target - start) * (s * s * (3 - 2 * s))      // SimpleSpline

// verticalFov: Source FOV is horizontal at 4:3
return (2 * Math.atan(Math.tan((fovH43 * Math.PI) / 360) * 0.75) * 180) / Math.PI   // 90 -> 73.74, 20 -> 15.07, 70 -> 55.4

// timerSecondsAt: teamplay_round_timer.cpp:377-403
const s = x.objectives.timers.state; const i = trackIndexAt(s, timer, Math.floor(tickF)); if (i < 0) return 0
if ((s.flags[i] & TIMER.STOPWATCH) && (s.flags[i] & TIMER.CAPTURE_WATCH)) return s.totalTime[i]
if (s.paused[i]) return Math.max(0, s.remaining[i])
return Math.max(0, (s.endTick[i] - tickF) * x.meta.intervalPerTick)

// medigun type from items.json `ct`: 1 kritzkrieg, 2 quickfix, 3 vaccinator, otherwise medigun
```

#### 3.7.3 `items.ts` (S0)

```ts
export interface ItemInfo { def: number; name: string; itemClass: string; slot: string; classes: string[]; kind: string; icon?: string; weaponMode?: number; chargeType?: number; buffType?: number; projectileType?: number; minViewmodelOffset?: [number, number, number] }
export function itemInfo(def: number): ItemInfo | null          // null for 65535 or unknown
export function itemName(def: number): string                    // 'Unknown' fallback
export function itemKind(def: number): string                    // items.json `k`, 'other' fallback
export function itemSlot(def: number, classId: number): string   // `cs[className]` override, else `s`
export function killIconFor(def: number): string | undefined     // items.json `i`
export function wearableDefs(): number[]                          // defs whose `c` starts with 'tf_wearable' (options.wearableDefs)
```

### 3.8 Interesting ticks (`findTicks.ts`, P1)

`export function findTicks(x: HighlanderExtras, kind: FindKind, opts?: { limit?: number; player?: number; team?: number }): { tick: number; player?: number; instance?: number; note?: string }[]`

Returns cache ticks sorted ascending, `limit` default 20. The bridge exposes it (section 3.10). `FindKind` is the
string union of the kinds below, with `proj:${number}` as a template literal type. Kinds:

| kind | definition |
|---|---|
| `cloak`, `decloak` | `HL.CLOAKED` rising / falling edges. A `cloak` result whose onset tick has `HL.FEIGN` set gets `note: 'feign'` (24 of the 51 cloaks on 1438891 are Dead Ringer feigns) |
| `disguise`, `disguising` | `HL.DISGUISED` / `HL.DISGUISING` rising edges |
| `feign` | `kill` events with `feign` |
| `backstab`, `headshot` | `kill` events (not feign) with `customKill` 2 / 1 |
| `uber`, `kritz`, `quickfix`, `vacc` | `uberDeployed` events, filtered by the medic's medigun type at that tick |
| `crit`, `minicrit`, `burning`, `jarate`, `milk`, `marked`, `bonk`, `overheal`, `teleportedGlow`, `stun` | rising edges of the matching `HL` bit |
| `gas` | rising edges of cond 123 (`condAt`; it has no HL bit) |
| `banner` | `banner` events |
| `busiest` | the start ticks of the non-overlapping 132-tick windows with the most `hurts` rows, most first (ties: earliest), then sorted by tick |
| `zoom` | `HL.ZOOMED` rising edges |
| `airblast` | `wstate.state` entering 3 |
| `flamesOn` | `flames.box.firing` rising edges |
| `deflect` | `deflect` events |
| `buildStart`, `buildDone`, `upgrade`, `carry`, `redeploy`, `sapped`, `destroyed`, `teleported` | the matching events |
| `wrangled` | `BLD.WRANGLED` rising edges |
| `proj:<kind>` | `projectiles` instances of that kind, at `created` (`proj:7` flares, `proj:8` arrows ...) |
| `syringe` | `clientProjectiles` of kind 21 |
| `explosion`, `tracer`, `bullet`, `critBullet` | the matching tempent rows |
| `capStart`, `captured`, `capBlocked`, `capBroken` | the matching events |
| `capping` | `cp.progress` entries above 0.5 |
| `cartMoving` | `watchers.state.speed` turning positive |
| `cartReceding` | `watchers.state.speed` turning negative |
| `overtime`, `roundWin`, `roundStart`, `setupFinished` | the matching events |
| `doorMove` | first `xform` entry of a `movers` cls 0 instance after at least 66 ticks without change |
| `pickupTaken`, `pickupBack` | `pickups.vis` falling / rising edges |
| `medicDrop` | `medicDeath` with `charged` |
| `respawnWave` | changes of `rules.waveRed` or `rules.waveBlu` |
| `medicCall` | `misc.saveMe` changes |

### 3.9 Degradation

`extras.meta.available[key]` is true when that group produced at least one entry. Every consumer checks it.

| situation | behaviour |
|---|---|
| `settings.highlander.enabled` false at demo load | no extras worker, status `'disabled'`, every HL layer and widget renders nothing, base UI unchanged |
| extras still loading | base UI only; `ExtrasNotice` shows "Highlander data NN %" for at most 3 s after the scene loads, then a small dot in the HUD corner until ready |
| status `'error'` | base UI only; `ExtrasNotice` shows "Highlander data unavailable: <reason>" for 6 s; console warns once |
| status `'disabled'` with a reason (the memory plan skipped the file) | base UI only; `ExtrasNotice` shows "Highlander data off: <reason>" for 6 s |
| `meta.excluded` not empty (the memory plan dropped groups) | the matching features hide; `ExtrasNotice` shows "Highlander data without <groups> (large demo)" for 6 s |
| `available.scoring` false (no local tables) | the scoreboard takes kills, deaths and assists from base deaths and `kill` events, damage and heals from `resource`, and hides the other columns |
| `available.itemCharge` false | throwable recharge badges hide |
| `available.loadout` false | loadout tooltips list nothing; the nameplate weapon icon still uses `weapon` |
| `available.view` false | eye height falls back to `EYE_HEIGHT[classId]`, or `DUCK_EYE_HEIGHT` when the base `duck` bit 0 is set |
| `available.weapon` false | no viewmodel, no weapon HUD, no medigun type |
| `available.medigun` false | uber % from the base `uberCache` (16-tick resolution), medigun type unknown ("Medigun") |
| `available.cond` false | no condition visuals; cloak and disguise disabled |
| `available.objectiveResource` false | no objective HUD; payload bar from `watchers` alone if present |
| `available.timers` false | no round clock |
| `available.movers` false or `mapNodes` empty (old textured maps) | doors do not move; F6 draws nothing for doors |
| `available.explosions` false | `Projectiles.tsx` keeps its own despawn explosions |
| `tv_transmitall 0` demos (no local tables): `available.sniper`, `.ammo`, `.wstate`, `.medigun`, `.view` may be false | each feature hides the dependent element; nothing else changes |
| the 6v6 sample `public/samples/i52_snakewater_gc.dem` | all features work where data exists; no errors |

### 3.10 Debug bridge (S0 wiring, P1 and features fill in)

`src/highlander/debug.ts` (S0):

```ts
export type HlProbe = (...args: any[]) => unknown           // must return JSON-safe data
export function registerHlProbe(name: string, fn: HlProbe): void
export function runHlProbe(name: string, ...args: unknown[]): unknown
export function listHlProbes(): string[]
```

`src/utils/debugBridge.ts` (S0) adds `hl` to the bridge object:

```ts
hl: {
  status: () => ({ status, progress, error, meta: extras?.meta without convars }),
  at: (tick?: number) => runHlProbe('players.at', tick ?? renderTick),   // P1 registers 'players.at'
  findTicks: (kind: string, opts?: Parameters<typeof findTicks>[2]) => {
    const x = useInstance.getState().extras
    return x ? findTicks(x, kind as FindKind, opts) : []                  // extras may be unset; the bridge takes any string
  },
  probe: (name: string, ...args: unknown[]) => runHlProbe(name, ...args),
  probes: () => listHlProbes(),
}
```

Every feature registers at least one probe named `<feature>.<what>` at module load of its layer (for example
`buildings.at`, `cloak.actor`, `viewmodel.state`, `objective.hud`) that returns the values it would draw at a given
tick. Plans assert on those values instead of reading pixels.

---

## 4. Maps (task M1)

### 4.1 Approach

The patched bsp-to-glb pipeline converts every Highlander map. The scripts are `scripts/convert-bsp.mjs`,
`scripts/lib/map-meta.mjs`, `scripts/setup-bsp-to-glb.mjs`, `scripts/bsp-to-glb/0001-*.patch` and `0002-*.patch`.
Step 0 (section 1.1) commits them on `highlander`, so the M1 worktree has them. M1 owns them from then on, and M2
owns `scripts/convert-bsp.mjs` after M1 merges.

- `package.json` gains two scripts and no dependencies (the lockfile stays frozen; `@gltf-transform/*`,
  `meshoptimizer` and `sharp` come in through `@gltf-transform/cli`):
  `"setup:bsp": "node scripts/setup-bsp-to-glb.mjs"`, `"convert:bsp": "node scripts/convert-bsp.mjs"`.
- bsp-to-glb lives in `/home/dalibor/programming/personal/bsp-to-glb` (the setup script default `../bsp-to-glb`
  seen from the main checkout; worktrees set `BSP_TO_GLB_DIR`), pinned at `7b7f7fc` plus the two patches.

### 4.2 Converter changes (M1)

1. Brush entities whose class matches `ADDRESSABLE` but that start hidden (`initiallyRendered` false, not in
   `HIDDEN_BRUSH_CLASSES`) keep their geometry. Today `entityHidden` skips their primitives, so a gate that appears
   mid-round has no mesh. Emit the mesh child and set `extras.dribble.initiallyVisible = false` on the parent node.
   Every other brush-entity node gets `initiallyVisible: true`.
2. `--only-meta true`: run pass 1 and the entity graph, write only `map-meta.json`. Used for `koth_product_final`.
3. `conversion.json` keeps its current shape (`pipeline`, `worldBounds`, `files`, `lightmap`, `lightEnvironment`
   with `direction`, `fog`, `skybox`, `camera`, `chunking`, `visibility`).

### 4.3 Outputs

```sh
cd /home/dalibor/programming/personal/dribble.tf-wt/m1
# both scripts resolve ../bsp-to-glb relative to the checkout, which in a worktree is the wrong place: pin it
export BSP_TO_GLB_DIR=/home/dalibor/programming/personal/bsp-to-glb
flock $S/heavy.lock node scripts/setup-bsp-to-glb.mjs --dir "$BSP_TO_GLB_DIR"
TF="/home/dalibor/.local/share/Steam/steamapps/common/Team Fortress 2/tf/maps"
for m in cp_steel_f12 koth_ashville_final1 koth_proot_b5b koth_warmtic_f10 pl_divulgence_b4b pl_downfall_b13 \
         pl_eruption_b15 pl_upward_f12 pl_vigil_rc10 tow_tetsudo_b10c; do
  flock $S/heavy.lock node scripts/convert-bsp.mjs --bsp "$TF/$m.bsp"
done
flock $S/heavy.lock node scripts/convert-bsp.mjs --bsp "$TF/koth_product_final.bsp" --only-meta true
```

| path | content |
|---|---|
| `public/models/maps/<map>/world.glb` | meshopt + quantized brush geometry, chunk nodes, brush-entity nodes |
| `public/models/maps/<map>/lightmap.webp` | sRGB lightmap atlas |
| `public/models/maps/<map>/visibility.json` | `MapVisibilityMetadata` v2 |
| `public/models/maps/<map>/map-meta.json` | schema below |
| `public/models/maps/<map>/conversion.json` | `pipeline: 'bsp-to-glb'` |
| `public/models/maps/koth_product_final/map-meta.json` | added; `textured_compressed.glb` and the old `conversion.json` stay untouched |
| `public/models/skybox/{sky_badlands90_01, sky_eveningtoast_01, sky_midnight_01, sky_vigil_01}/` | PAK skies (from the converter or `$S/skybox-out/`) |

About 31 MB of new files, committed like the existing maps (the repo tracks map GLBs directly, no LFS).

### 4.4 `map-meta.json` (v1)

The schema is maps.md section 6, unchanged. All positions are raw Source units; scene = Source - boundaryMin of the
demo. M1 writes the TypeScript type and loader in `src/highlander/map/mapMeta.ts`:

```ts
export interface MapMeta { schema: 'dribble.map-meta'; version: 1; map: string; gameMode: 'koth' | 'payload' | 'payload-race' | 'tug-of-war' | 'attack-defend' | 'control-points' | 'unknown'; /* every field of maps.md section 6 */ }
export function fetchMapMeta(map: string): Promise<MapMeta | null>     // cached per folder; null when absent
export function useMapMeta(map: string): MapMeta | null                 // hook; null while loading
export function sourceToScene(p: [number, number, number], sceneOrigin: { x: number; y: number; z: number }): THREE.Vector3
```

### 4.5 Runtime changes (M1)

1. New `src/utils/mapAssets.ts`:

   ```ts
   export interface MapConversion { pipeline?: 'bsp-to-glb' | string; worldBounds?: { boundaryMin: Vector; boundaryMax: Vector }; files?: { model?: string; lightmap?: string; visibility?: string; meta?: string }; lightmap?: { file: string; width: number; height: number; range: number; colorSpace: 'srgb'; uvChannel: number }; lightEnvironment?: unknown; fog?: { enabled: boolean; color: number[]; start: number; end: number } | null; skyboxName?: string; camera?: { rtsCenter: Vector; cameraOffset: Vector } }
   export function getMapFolder(map: string): string | undefined                 // MAP_NAME_SEARCH_MAP prefix lookup
   export function fetchMapConversion(map: string): Promise<MapConversion | null> // one fetch per folder, cached promise
   export function getMapModelUrl(map: string, conv: MapConversion | null): string | undefined  // bsp pipeline: files.model; else textured_compressed.glb
   ```

   `utils/game.ts` `fetchMapWorldBounds` and `Lights.tsx` use `fetchMapConversion` (no duplicate fetches).
   `fetchMapWorldBounds` also returns `camera` when present.
2. `World.tsx`, for `pipeline === 'bsp-to-glb'`:
   - `new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)` from `three/examples/jsm/libs/meshopt_decoder.module.js`.
   - Load `files.lightmap` with `THREE.TextureLoader`: `flipY = false`, `colorSpace = SRGBColorSpace`,
     `channel = lightmap.uvChannel`, `generateMipmaps = false`, `minFilter = magFilter = LinearFilter`.
   - Replace materials by `material.userData.dribble.kind` with one shared material per kind:
     `new MeshBasicMaterial({ vertexColors: true, lightMap: d.lightmap ? lm : null, lightMapIntensity: lightmap.range * Math.PI * brightness, transparent: kind !== 'opaque' && kind !== 'unlit', depthWrite: !transparent, side: kind === 'water' || kind === 'visualizer' ? DoubleSide : FrontSide })`.
     `brightness` = `settings.highlander.map.brightness`; changing it updates `lightMapIntensity` on the shared
     materials without reloading.
   - Skip `INVISIBLE_TOOL_MATERIALS`, `isInvisibleEntityNode` and `material.vertexColors = false` for this
     pipeline (vertex colours are the albedo).
   - Hide `skybox_3d` and meshes whose material has `hiddenByDefault`. Visualizer meshes follow
     `settings.highlander.map.respawnVisualizers`.
   - Brush-entity parent nodes start with `visible = userData.dribble.initiallyVisible !== false`.
   - `untextured` mode: shared `MeshLambertMaterial({ vertexColors: true })`. `wireframe` mode unchanged.
   - After freezing matrices, collect `Map<bspModelIndex, Object3D>` of nodes whose `userData.dribble.kind` is
     `brushEntity` or `respawnVisualizer` and call `useInstance.getState().setMapNodes(nodes)`. Clear it on map
     change. Old textured GLBs produce an empty map.
   - `setMapStatus` through the load: `loading`, then `ready`, `missing` (no folder or 404) or `error`.
   - Remove the two blocking `alert()` calls. `MapNotice` (below) shows the message instead.
   - Fog: when `settings.highlander.map.fog` is true and `conversion.fog.enabled`, set
     `scene.fog = new THREE.Fog(color, start, end)`; remove it otherwise.
3. `Lights.tsx`: when `lightEnvironment.direction` exists, `keyDirection = direction.map(v => -v * 1000)`. Colour
   heuristics unchanged. This lights players and placeholders; lightmaps light the map.
4. `src/constants/mappings.ts`: `MAP_NAME_SEARCH_MAP` gains `cp_steel: 'cp_steel_f12'`,
   `koth_ashville: 'koth_ashville_final1'`, `koth_proot: 'koth_proot_b5b'`, `koth_warmtic: 'koth_warmtic_f10'`,
   `pl_divulgence: 'pl_divulgence_b4b'`, `pl_downfall: 'pl_downfall_b13'`, `pl_eruption: 'pl_eruption_b15'`,
   `pl_upward: 'pl_upward_f12'`, `pl_vigil: 'pl_vigil_rc10'`, `tow_tetsudo: 'tow_tetsudo_b10c'`.
   `MAP_SKYBOX_MAP` gains steel `sky_dustbowl_01`, ashville `sky_midnight_01`, proot `sky_eveningtoast_01`,
   warmtic `sky_trainyard_01`, divulgence `sky_dustbowl_01`, downfall `sky_badlands90_01`, eruption `sky_tf2_04`,
   upward `sky_tf2_04`, vigil `sky_vigil_01`, tetsudo `sky_trainyard_01`. No `OVERWRITE_MAP_BOUNDARIES` entries for
   these maps, with one exception. On `tow_tetsudo_b10c` the demo's world bounds are not the BSP bounds: the map's
   `plhud.nut` writes the push counter into `m_WorldMins` (`NetProps.SetPropVector(world, "m_WorldMins", ...)`) and
   HUD counters into `m_WorldMaxs`. On 1428628 `m_WorldMins` changes 1572 times, with values such as
   (+/-0.03, 0, 0) and (0, 0, 0). Placement works today only because that value is near 0 at both the start packet
   and the end. M1 adds an `OVERWRITE_MAP_BOUNDARIES` entry `tow_tetsudo_b10c` in
   `src/components/Analyse/MapBoundaries.ts` with `boundaryMin` and `boundaryMax` from the map's
   `conversion.json` `worldBounds`, and `rtsCenter` and `cameraOffset` from `conversion.camera`. ParseWorker then
   shifts positions from the demo value to the BSP bounds, and nothing reads the HUD data in `boundaryMax` or a
   bounds centre on this map. The extras use the overridden `boundaryMin` as `sceneOrigin`, so they stay aligned.
5. `src/zustand/actions.ts`, only the camera lines of `loadSceneFromDemoAction` and `loadEmptySceneMapAction`:
   `rtsCenter = saved ?? override.rtsCenter ?? conversion.camera?.rtsCenter`,
   `cameraOffset = override.cameraOffset ?? conversion.camera?.cameraOffset`, keeping the existing
   `translatePointBetweenBoundaryMins`. When none exists (unsupported map), centre on the median alive player
   position at 10 % of the demo, with offset (0, 700, 1400).
6. `src/highlander/hud/widgets/MapNotice.tsx` (M1): reads `mapStatus`; shows "Map geometry for <map> is not
   available; players and objectives still play." for `missing` (dismissable, 8 s), and "Using <folder> geometry
   for <map>" when the demo map name differs from the folder name.
7. `src/highlander/map/mapNodes.ts` (M1): `getMapNode(bspModelIndex)`, `sceneXformToNode(node, scenePos, quat, sceneOrigin)`
   (Appendix B.2), `restoreNode(node)` (back to the GLB matrix and initial visibility).
8. `AGENTS.md`: document `setup:bsp`, `convert:bsp`, the `../bsp-to-glb` location, the patches, the rule that HL
   maps need no boundary overrides except `tow_tetsudo_b10c` (item 4, with the reason), and a "Known visual limits"
   paragraph. Stock static props are invisible (D7), so these are expected and are not bugs: sticky traps resting
   on invisible crates, sniper dots and beams ending in mid-air, rockets bursting against nothing, sentries built on
   props floating, and players standing on air.

### 4.6 Runtime `.bsp` conversion

Deferred (D6). If it is built later: wasm wrapper in `src/libs/bsp2glb`, a worker port of the convert-bsp
post-process minus sharp and meshopt, results cached in IndexedDB through `localforage`, and user-supplied `.bsp`
files by drag and drop. maps.md section 7 has the measurements.

### 4.7 Acceptance (M1)

| check | demo | pass |
|---|---|---|
| each of the 10 maps loads with `mapStatus.ready`, `__dribble.getState().scene.mapLoaded` true, no `alert`, no page errors | 1440442 steel, 1442753 ashville, 1437271 proot, 1443060 warmtic, 1422948 divulgence, 1429444 downfall, 1429425 eruption, 1439994 upward, 1434434 vigil, 1428628 tetsudo | all; 1428628 (90 MB) only when `free -m` shows at least 3000 MB available, otherwise render the tetsudo GLB with `$S/render/render.mjs` and rely on the P1 native self-check for alignment |
| tetsudo uses the BSP bounds: `parsedDemo.world.boundaryMin` equals `conversion.json` `worldBounds.boundaryMin`, and players stand on floors in a POV shot | 1428628 (gated as above) | both |
| floating-object cases recorded: one RTS shot each of a sticky trap on an invisible prop, a sniper dot or beam ending mid-air, and a player on an invisible prop, listed in the M1 report and in the AGENTS.md "Known visual limits" paragraph | 1434434 (use `findTicks('zoom')` and sticky ticks once P1 has merged; otherwise pick ticks by eye) | recorded |
| RTS default shot frames the objective named in `conversion.camera.method` | same | visual |
| players stand on floors: in a POV shot at 50 % the floor is below the camera and nearby walls are opaque | 1434434, 1440442 | visual |
| baked shadows visible under the sun direction; character lighting comes from the sun direction | 1434434 | visual |
| koth_product_final still renders the textured GLB and `fetchMapMeta('koth_product_final')` returns `gameMode 'koth'` | 1438891 | both |
| GPU paused fps at 1600x900 at least 55 on vigil RTS default view | 1434434 | `--perf-play 50%:5:rts:auto:0` |
| `mapNodes.size` > 0 on vigil and includes the `func_tracktrain` model index from `map-meta.payload[0].cart.brush.bspModelIndex` | 1434434 | bridge eval |

### 4.8 Task M2: PAK static props (after M1 merges; parallel with F1 to F6)

Purpose: render the static props whose models ship inside each map's PAK lump. That is map data on disk, which D1
allows. Stock props stay invisible. PAK models cover 0 to 473 instances per map (maps.md section 8.1): tetsudo 473,
ashville 204, proot 196, eruption 145 plus 56 dynamic, divulgence 105, vigil 94, steel 5, warmtic 0. On vigil the 94
`props_vigil` instances are the map's custom edges: 33 cliff walls, 45 terrain patches, the observatory and the
doorways. A hand-made box table for stock models is not worth it, because vigil alone uses 281 distinct prop
models.

Files owned: `scripts/lib/static-props.mjs` (new), `scripts/convert-bsp.mjs` (the props pass only),
`public/models/maps/<map>/props.glb` and the `conversion.json` additions below, `src/highlander/map/StaticProps.tsx`
(new), and in `src/components/Scene/World.tsx` only the `files.props` load and the `<StaticProps />` mount inside
the world group.

1. Extract the PAK's `.mdl`, `.vvd` and `.vtx` files (the converter already reads the PAK for skies) and convert
   each model with `bsp-to-glb --studio-mdl ... --studio-vvd ... --studio-vtx ...` (25 of 25 proot models converted
   in the maps.md test).
2. Read the static prop lump (model index, origin, angles, skin, solid type, fade distances). Keep instances whose
   model came from the PAK.
3. Write one `props.glb` per map: one mesh per model, instance transforms through `EXT_mesh_gpu_instancing` (three
   r163's `GLTFLoader` reads it), meshopt plus quantization as for `world.glb`, flat colours from the average of the
   PAK texture when it is in the PAK, else `NEUTRAL`, and the PAK's per-vertex lighting (VHV) as vertex colours when
   present.
4. `conversion.json` gains `files.props` and `props: { pak: N, stock: M, stockSolid: K }`.
5. `StaticProps.tsx` loads `files.props` with the meshopt decoder and the shared bsp-to-glb material rules of
   section 4.5 item 2, under the rotated `world` group. Setting `map.staticProps` (default true) toggles it.

Acceptance:
- vigil (1434434) shows the 94 PAK instances in an RTS shot at 10 % and a POV shot at 50 %. The cliff walls close
  the map edge that is open without them.
- tetsudo, ashville and proot render their PAK props (render tool or harness, with the memory gates of section
  4.7).
- GPU paused fps on the vigil RTS default view at 1600x900 stays at or above 55.
- Each map prints its `conversion.json.props` counts in the M2 report.

---

## 5. Feature modules

Every feature below lists: what it is for, the data it reads, the exact placeholder look, its settings (keys from
section 6.3), the files it owns, the edits it may make to shared files (usually none, because the scaffold already
added the hooks), its bridge probes and its acceptance checks. Section 7 has the run order and harness commands.

Shared rules for all features:
- Read data only through `getters.ts`, `track.ts`, the cross-feature APIs of section 6.5, and the base
  `parsedDemo` caches.
- Draw only for players that `DemoViewer` renders (connected RED/BLU at `renderTick`), using the actor registry
  (section 6.4) for their scene nodes.
- In POV mode, "the POV player" always means the POV subject of D16 (`usePovSubject`, section 6.5), never the
  focused player directly.
- Never draw effects on dead players or inside the body of the player whose `povCamera` the scene renders from.

### F1. Player conditions and spy

Purpose: make cloak, decloak, disguise, uber (all four medigun types), crit and minicrit boosts, burning, bleeding,
jarate, milk, gas, stuns, mark-for-death, overheal, teleport glow, Bonk and soldier buffs visible on and around each
player, and show what each player holds and whether he crouches.

Data: `flagsAt`, `flagSince`, `flagClearedSince`, `condAt` (Vaccinator resist conds 58/59/60, gas 123), `invisAt`,
`cloakMeterAt`, `disguiseAt`, `miscAt` (`saveMeTick`, `rage`, `charge`), `activeWeaponAt`, `weaponStateAt`,
`loadoutAt`, `eyeZAt`, the `view.duck` track, base `getDuck`, base player names and health, `usePovSubject`.

Files owned: `src/highlander/scene/actorFx.ts` (body of `useActorFx`), `src/highlander/scene/layers/PlayerFxLayer.tsx`,
`src/highlander/players/*`, `src/components/Scene/Nameplate.tsx` (S0 adds only the `extra` prop type first).

`useActorFx(entityId, renderTick, classId, team): ActorFx` (signature fixed in section 6.4) returns `DEFAULT_ACTOR_FX`
while extras are not ready or `enabled` is false. Otherwise it applies the tables below.

Effects come in four groups. Each needs `players.conditions` (the master toggle) and its own key:
`players.fxUber` (uber tint, Quick-Fix and Vaccinator shells, Bonk), `players.fxCrit` (crit and minicrit tints and
auras, soldier buff), `players.fxDebuffs` (burning, bleeding, jarate, milk and gas tints and drips, marked for death,
stun) and `players.fxOverheal` (overheal plus signs, teleport glow). Cloak and disguise follow `players.cloak` and
`players.disguiseView` only.

The disguise view in effect is `players.disguiseView`, where `'auto'` means `'pov'` while a POV subject exists and
`'true'` otherwise (D9).

| state | `modelClassId` / `modelTeam` | `opacity` | `tint` | `emissive` |
|---|---|---|---|---|
| default | base class / team | 1 | null | 0 |
| cloaked (`invisAt > 0`, setting `players.cloak`), views `'true'` and `'enemy'`, and same-team spies in `'pov'` | unchanged | `max(1 - inv, players.cloakFloor)` | `CLOAK_TINT[team]` as a colour | `0.6 * inv` |
| cloaked, a spy on the other team from the POV subject in `'pov'` view | disguise if disguised | `1 - invE` with `invE = invisAt(x, p, tickF, 1)`, no floor | `CLOAK_TINT[team]` | `0.6 * invE` |
| uber (`HL.UBER`) | | 1 | `TEAM_FX[team]` | `0.9 + 0.15 * sin(2 * PI * renderTick * 0.015)` |
| uber wearing off (`HL.UBER_FADING`) | | 1 | `TEAM_FX[team]` | `Math.floor(renderTick / 4) % 2 ? 0 : 0.9` |
| crit (`HL.CRIT`, not cloaked) | | 1 | `TEAM_FX[team]` | 0.45 (0.22 for `HL.CRIT_BONUS` alone) |
| jarate / milk / gas | | 1 | `'#e8d34a'` / `'#f2f2f2'` / `'#7a8a5a'` | 0.35 |
| minicrit | | 1 | `TEAM_FX[team]` | 0.25 |
| disguised, `'enemy'` view, or `'pov'` view for a spy on the other team from the POV subject | disguise class, `teamKey(disguise.team)` | | | |

Only one tint applies. Priority: cloak, uber, uber wearing off, crit, jarate, milk, gas, minicrit. A tint whose group
is off is skipped. When a spy is drawn as his disguise, he shows no crit tint (the game hides it). `hidden` is true
only in `'pov'` view for an enemy spy with `invE >= 0.99`; spectator views never hide a spy.

Crouch: `ActorFx.scaleZ = HULL.duckHeight / HULL.height` (0.756) while `view.duck` bit 0 is set, or the base
`getDuck` bit 0 when `available.view` is false; 1 otherwise. S0 applies it to the body group and the nameplate
height (section 6.2 item 8), so a crouched player no longer looks exposed above cover.

`ActorFx.nameplate` (setting `players.nameplateExtras`):

| item | when | look |
|---|---|---|
| weapon icon | setting `players.nameplateWeapon`, active weapon known | the kill icon `killIconFor(def)` of the active weapon, 14 px high, left of the name; for a spy drawn as his disguise, the icon of `disguise.weaponDef`; nothing when the item has no icon |
| disguise badge | `HL.DISGUISED`, spy drawn as himself | `ClassIcon` 14 px of the disguise class on a 2 px border in `TEAM_HUD[disguise team]`, text "as Scout" |
| disguise identity | spy drawn as his disguise (`'enemy'`, or `'pov'` for enemy spies) | the target's name and `disguise.health` against the disguise class max from `HEALTH_MAP`; in `'pov'` view the plate hides while `invE > 0.5` |
| disguising | `HL.DISGUISING` | badge at 50 % opacity with the desired class |
| cloak bar | spy and (`cloakMeter < 100` or cloaked) | 40 x 3 px bar, fill `#c8d7ff` |
| charge bar | demoman with an item of kind `shield` in `loadoutAt`, and `misc.charge < 100` or `HL.SHIELD_CHARGE` | 40 x 3 px bar, fill `#e0c040` |
| tags | | small pills: `UBER`, `CRIT` (`HL.CRIT`), `QF`, `VACC`, `BONK`, `MARKED`, `TAUNT`, `STUN` (`HL.STUNNED`), `GAS` (cond 123), `REV` (active weapon kind `minigun` and `wstate.state` 1 or 3, spinning without firing), `BANNER`, `MMMPH`, `FOCUS` (`misc.rage` 100 and a loadout item with `buffType`: banners 1 to 3, Phlogistinator 5, Hitman's Heatmaker 6), `DECLOAK` (66 ticks after `flagClearedSince(HL.CLOAKED)`), `MEDIC!` (within 133 ticks of a `saveMe` change) |
| pinned | disguised or disguising, cloaked (`inv > 0`), a spy with `cloakMeter < 100`, `HL.UBER`, `HL.QUICKFIX_UBER`, `HL.VACC_UBER`, or a `MEDIC!` tag | `NameplateExtra.pinned = true`: the S0 distance fade and the X1 nearest-12 cap skip this plate, so far spies keep their reads |
| nameplate opacity | cloaked with inv > 0.5 | 0.6 |

`PlayerFxLayer` overlays. One child component per actor, mounted with `createPortal` into the actor's `group` from
the registry, so it follows the actor without extra work. Geometries are shared module constants; aura materials are
cloned per actor because their opacity differs. The group column names the setting each effect needs.

| effect | group | trigger | geometry and look (Source units, z from the feet) |
|---|---|---|---|
| Quick-Fix uber | uber | `HL.QUICKFIX_UBER` | torus radius 30, tube 2, at z 2, `TEAM_FX`, additive, opacity 0.6, rotating `tickF * 0.1` rad |
| Vaccinator uber | uber | `HL.VACC_UBER` | sphere r 46 at z 41, additive, opacity 0.15, colour by cond: 58 `#ffd24a` bullet, 59 `#ff8a3d` blast, 60 `#ff4a3d` fire |
| Bonk | uber | `HL.BONK` | sphere r 42 `#ffe14a`, additive, opacity 0.12 |
| crit aura | crit | `HL.CRIT`, not cloaked (`HL.CRIT_BONUS` alone: opacity 0.05, no orbiters) | sphere r 42 at z 41, additive, opacity 0.10, plus 6 octahedra (size 2.5) orbiting at radius 28 between z 30 and 70, angle `tickF * 0.05 + i * PI / 3`, `TEAM_FX` |
| minicrit aura | crit | `HL.MINICRIT` | the crit sphere at opacity 0.06, no orbiters |
| soldier buff | crit | `HL.SOLDIER_BUFF` | torus r 22, tube 2, z 2, `TEAM_FX`, opacity 0.5 |
| burning | debuffs | `HL.BURNING` | 3 additive cones (r 6, h 20) at 0, 120, 240 degrees, radius 10, z 30..60, `#ff7a1a`, opacity 0.7, height scale `0.7 + 0.5 * hash(Math.floor(tickF / 3) + i)` |
| bleeding | debuffs | `HL.BLEEDING` | 3 spheres r 1.5 `#b01515` falling from z 50 to 0 over 30 ticks, staggered by 10 |
| jarate / milk / gas drips | debuffs | `HL.JARATED` / `HL.MILKED` / cond 123 | as bleeding, `#e8d34a` / `#f2f2f2` / `#7a8a5a` |
| marked for death | debuffs | `HL.MARKED` | sprite of `src/assets/kill_icons/skull.png`, 18 units, at z 100 |
| stun | debuffs | `HL.STUNNED` | 3 octahedra (size 2) `#ffe14a` circling at radius 10, z 92, angle `tickF * 0.12 + i * 2 * PI / 3` |
| overheal | overheal | `HL.OVERHEALED` | 2 plus-shaped billboards (two crossed quads 8 x 2.5), `TEAM_FX`, rising from z 45 to 90 over 40 ticks, phase offset 20 ticks, opacity 0.8 to 0 |
| teleport glow | overheal | `HL.TELEPORTED` | torus r 26, tube 1.5, z 2, `TEAM_FX`, opacity `0.2 + 0.1 * sin(tickF * 0.2)` |
| disguise smoke | cloak | within 30 ticks after `flagSince(HL.DISGUISING)` | 4 spheres `#bbbbbb`, radius 10 to 40, opacity 0.35 to 0, centred at z 30 |
| decloak cue | cloak | within 20 ticks after `flagClearedSince(HL.CLOAKED)` | horizontal torus at z 41, radius `10 + 30 * a` with `a = age / 20`, tube 1.5, `TEAM_FX`, additive, opacity `0.5 * (1 - a)`. TF2 signals a decloak by sound, which this viewer lacks. |

`Nameplate.tsx` renders the `extra` items above. Without `extra` it renders exactly as today.

Third-person weapon models (F4's placeholder builders at world scale in the actor's hand) are later work (section 9).

Probes: `fx.actor(entityId, tick)` returns the `ActorFx` plus `inv`, `invE` and the disguise view in effect;
`fx.overlays(tick)` returns `{ entityId, effects: string[] }[]`.

Acceptance:
- Cloak on 1438891. Take the first five `findTicks('cloak', { limit: 60 })` results without `note: 'feign'` whose
  `invis.completeTick - onset` lies within 69.7 +/- 2 ticks (1.045 s). For those, `invisAt` at onset + 33 ticks is
  0.45 +/- 0.05 (1 - (1.045 - 0.495) s) and at onset + 80 it is 0.95. For the first three `note: 'feign'` results
  (Dead Ringer, for example Broly LSSJ at demo tick 1498 and MaGe at 1684), `invisAt` is 0.95 from the onset tick.
  For `findTicks('decloak')` results that end a normal cloak: 0.53 +/- 0.05 at offset + 66 ticks
  ((2.045 - 0.99) x 0.5) and 0 at offset + 140. The probe `fx.actor` shows the rendered opacity equal to
  `max(1 - inv, players.cloakFloor)` in the `'true'` view.
- The vigil spy "Pooper" on 1434434 shows a scout disguise badge in BLU colours from the DISGUISED onset near demo
  tick 9178 (probe sample, parser-probe section 2.2). With POV on a BLU player at onset + 10, `fx.actor(Pooper)`
  reports a scout in BLU (`'pov'` view through `'auto'`). With POV on a RED player it reports the real spy.
- A player whose base duck bit 0 is set reports `scaleZ` 0.756. A heavy on 1438891 shows `REV` at a tick with
  `wstate.state` 3.
- Screenshots: a translucent, tinted spy; a decloak ring at `findTicks('decloak')` + 5; a team-coloured uber shell
  on medic and patient at an `uber` tick; kritz orbiters on 1440442 at a `kritz` tick; flames on a burning player.
- Jarate, milk, gas, stun, Quick-Fix and Vaccinator visuals: one shot each on a demo chosen from `$S/p1/survey.json`;
  a kind without a demo is reported as unvalidated.
- 1x playback on 1438891 at tick 21000 (RTS, 1600x900, GPU egl) stays at or above 30 fps.

### F2. Engineer buildings

Purpose: sentries, dispensers, teleporters and sappers at their real positions with level, health, construction,
upgrade, sapper, wrangler, ammo, aim and carry state.

Data: `buildings` (all tracks), `tempents.tracers` (muzzle flashes), `events` (`destroyed`, `buildStart`,
`buildDone`, `upgrade`, `carry`, `redeploy`, `sapped`), `players.misc.carrying` and `players.builder`, actor
registry (builder position for blueprints and carry boxes, healed players for dispenser beams).

Files owned: `src/highlander/scene/layers/BuildingsLayer.tsx`, `src/highlander/buildings/*` including the public
API `src/highlander/buildings/model.ts` (section 6.5), `scripts/hl/calibrate-sentry.mjs`.

Map-placed buildings (`mapPlaced` 1, for example the two `CObjectCartDispenser`s on vigil's cart) are not drawn:
no body, beams, labels or range ring. `buildingsAt` still returns them with `mapPlaced: true`, and F5 ignores them.

Placeholder geometry (origin at the base centre, +X = building yaw from `xform`):

| part | spec |
|---|---|
| sentry base | box 34 x 34 x 6 at z 0..6, `DARK_METAL` |
| sentry post | cylinder r 3.5 from z 6 to pivot - 8, `METAL` |
| sentry yoke | box 10 x 20 x 6 at pivot - 8 .. pivot - 2, `TEAM_DARK` |
| sentry turret | rotates in yaw then pitch about (0, 0, pivot). Box 22 x 16 x 12 (L1), 26 x 20 x 14 (L2, L3), `TEAM_DARK`, with a 0.5-unit `TEAM_FX` stripe on top |
| sentry barrels | along +X from the turret front: L1 one cylinder r 1.6 length 18; L2 and L3 two at y +/-3.5, length 22 |
| L3 rocket pod | box 12 x 18 x 8 at pivot + 10, front with four r 2 dark discs |
| pivot heights | L1 32, L2 40, L3 46. Mini sentry: L1 parts scaled 0.75 (pivot 24), body colour lerped 40 % from `TEAM_DARK` to `TEAM_FX` |
| dispenser | body box 24 x 24 x H with H = 40 / 46 / 52 by level, `TEAM_DARK`; cap box 26 x 26 x 4 `METAL` on top; screen box 1 x 14 x 10 on the +X face at z H - 18, `#9fd7ff`, emissive 0.5 while `metal > 0`; metal gauge box 1 x 3 x ((H - 10) * metal / 400) on the -Y face, `#f0c040` |
| dispenser beams | not `HealBeam`, which would make a dispenser with four players around it read like four medics. A thin straight beam of its own: a camera-facing quad 1.5 units wide from the dispenser top to each player in `heal` at chest height (+41), `TEAM_FX`, opacity 0.25, no glow, no animation |
| teleporter | pad cylinder r 24 h 6 `TEAM_DARK`; ring torus r 20 tube 1.5 `TEAM_FX` at z 6.2; three blades (box 18 x 3 x 1) spinning about z at 6 degrees per tick in states 2..5, 1.5 per tick in state 6, still otherwise (angle from `tickF`); entrance: flat cone arrow pointing +X at z 7; exit: beacon cylinder r 2 h 30 `TEAM_FX` opacity 0.5; states 2..5 add an open additive cylinder r 20 h 50 opacity 0.15; state 6 draws a recharge arc `1 - remaining / rechargeDur` |
| sapper | box 8 x 6 x 8 `DARK_METAL` on the building's +Y face at half height, plus an additive `#9fd7ff` sprite, opacity `0.4 + 0.4 * hash(tick)` |
| construction | while `BLD.BUILDING`: scale z by `0.25 + 0.75 * built / 255`, all parts at opacity 0.55 |
| upgrading | while `BLD.UPGRADING`: a ring rising from z 0 to the top every 40 ticks |
| wrangler shield | `BLD.SHIELD`: sphere r 45 at the pivot, `TEAM_FX`, additive, opacity 0.18 |
| status billboard | setting `buildings.labels`: drei `<Billboard>` at top + 14 with a 40 x 4 health bar (background `#111` at 0.6, fill `#4caf50` above 50 %, `#e0c040` above 25 %, else `#e04040`), three 4 x 4 level pips, and for sentries a 40 x 2 shells bar (`#d8c08a`, max 150 at L1, 200 otherwise) plus a rockets bar at L3 |
| range ring | setting `buildings.sentryRange`: flat ring radius 1100 at z 2, `TEAM_FX`, opacity 0.12, not while carried or building |
| muzzle flash | tracer rows with `sentry` = this instance and age < 2 ticks: additive sprite size 10 `#ffd27a` at the barrel tip |
| carried | the building instance is dormant (`BLD.DORMANT`) so it is hidden; the builder actor gets a 16 x 16 x 16 `TEAM_DARK` box with a `TEAM_FX` top at (-14, 0, 40) while `misc.carrying` |
| blueprint | setting `buildings.blueprints`: `builder.state` 2 (placing) draws the hull of `builder.type` as a translucent box 64 units in front of the engineer at his feet height, `TEAM_FX` at 0.3; state 3 (invalid) in `#ff2020`. Hulls: sentry 40 x 40 x 66, dispenser 40 x 40 x 55, teleporter 48 x 48 x 12 |
| destruction | `destroyed` event, age < 20 ticks: flash sphere r 40 `#ffd28a` fading, plus 8 boxes (4 x 4 x 4) flying outward with gravity 800, directions from a hash of (instance, i) |

Sentry aim: `src/highlander/buildings/sentryAim.ts` holds four constants with initial values
`YAW_RANGE = 360`, `YAW_SIGN = -1`, `PITCH_RANGE = 100`, `PITCH_SIGN = -1`:
`yaw = buildYaw + YAW_SIGN * (pose.yaw / 255 * YAW_RANGE - YAW_RANGE / 2)`,
`pitch = PITCH_SIGN * (pose.pitch / 255 * PITCH_RANGE - PITCH_RANGE / 2)`.
`scripts/hl/calibrate-sentry.mjs` fits them: for every `state` sample with `objState == 2` and `enemy.kind == 1`,
take the direction from the pivot (origin + pivot height) to the enemy's base position + 41, convert to yaw
relative to the build yaw and pitch, and fit range, sign and offset by least squares on 1438891 and 1440442. Write
the fitted constants, sample count and R^2 into the file header. If R^2 < 0.9 for either axis, set
`AIM_AT_ENEMY = true`: aim at the enemy while attacking and use the build yaw with a +/-50 degree sweep from `tickF`
otherwise.

Probes: `buildings.at(tick)` returns the `BuildingView[]` of section 6.5.

Acceptance:
- On 1438891 the probe lists 29 distinct sentry instances over the demo and 13 sappers.
- For the product sentry entity 451 (parser-probe section 7): construction rises from 0.0118 to 1 over about
  10.5 s, health climbs with it, the level pips change at `upgrade` events, the model hides between `carry` and
  `redeploy`.
- Aim: with the fitted constants, the barrel direction is within 15 degrees of the enemy centre on at least 80 % of
  attacking samples (printed by the calibration script).
- Screenshots at `buildDone + 10`, `sapped + 10`, `wrangled + 10` and at a dispenser healing two players.
- On 1434434 the probe lists 3 player dispensers and no drawn building on the cart (`mapPlaced` instances are
  returned but flagged).

### F3. Projectiles and combat effects

Purpose: draw every projectile the base parser drops, crit glows for all projectiles, deterministic positions and
trails for the base projectiles, event-based explosions, hitscan and sentry tracers, flamethrower flames, airblast
puffs, deflect flashes, muzzle flashes and syringes.

Data: `projectiles`, `tempents` (explosions, bullets, tracers, clientProjectiles, particles), `flames`,
`players.wstate`, `players.anim`, `players.fire`, `hurts`, `events` (`deflect`), base view angles and positions,
the base `projectileCache` (for the source split), actor registry.

Files owned: `src/highlander/scene/layers/ProjectilesExtraLayer.tsx`, `src/highlander/scene/layers/CombatFxLayer.tsx`,
`src/highlander/combat/*`, `src/components/Scene/Projectiles.tsx`.

Source split (D13). `src/highlander/combat/projectileSource.ts` exports:

```ts
export interface ProjectileSource { servedByBase: Uint8Array; baseType: Uint8Array; mismatches: number }
export function getProjectileSource(x: HighlanderExtras, demo: AsyncParser): ProjectileSource   // built once per (extras, demo), cached
```

For each extras projectile instance j, look up the base slot of its entity id (a `Map` from entity id to slot
index, built once from `projectileCache.projectileIds`) and call `getProjectile(t, slot)` at
`t = min(created + 2, hidden - 1)`. A non-null result sets `servedByBase[j] = 1` and `baseType[j]` to the base type
(1 to 4). `mismatches` counts instances whose kind disagrees with the table in section 2.5.4. X2 reads this table
before it frees the base cache, so the split stays the same afterwards.

`ProjectilesExtraLayer` draws every instance with `servedByBase[j] === 0` that is alive at `renderTick`
(`created <= tick < hidden`), whatever its kind. In practice that means kinds 0, 5, 7, 8, 9 and 11 to 20; the
healing bolt (kind 10) has a base slot. "Base types 1 to 4" in this section always means the base cache numbering,
never extras kinds. Position: `lerpField`-style interpolation between consecutive samples with `tickF`.
Orientation: along the delta of the last two samples, or the last non-zero delta within 16 samples, or the initial
velocity.

| kind | mesh (Source units) |
|---|---|
| 1 / 6 rocket (only when the base missed it) | cylinder r 2 length 16 `DARK_METAL` with a `TEAM_FX` cone tip |
| 2 pipe / 3, 4 sticky (only when the base missed it) | sphere r 3 `TEAM_DARK` |
| 10 healing bolt (only when the base missed it) | cylinder r 0.6 length 14 `#e8d44d` |
| 5 cannonball | sphere r 4 `DARK_METAL` |
| 7 flare | cylinder r 1 length 6 `#ff8c1a` plus an additive glow sprite size 12 |
| 8 arrow | shaft cylinder r 0.5 length 30 `#c8b48a`, head cone r 1.2 length 3 `METAL`, three 4 x 2 fletching quads in `TEAM_FX` at the tail |
| 9 repair bolt | cylinder r 1 length 12 `METAL` with a `TEAM_FX` tip |
| 11 / 12 / 13 jar | cylinder r 3 h 8, `#e8d34a` / `#f2f2f2` / `#7a8a5a`, opacity 0.85 |
| 14 cleaver | blade box 16 x 1 x 6 `METAL` plus handle box 6 x 1.5 x 1.5 `#6b4a2b` |
| 15 stun ball | sphere r 1.5 `#f0f0f0` |
| 16 ornament | sphere r 2.5 `#d03030` with a small `#d4af37` cap |
| 17 energy ring | torus r 8 tube 1.5, `TEAM_FX`, additive |
| 18 energy ball | sphere r 4, `TEAM_FX` additive, white core r 2 |
| 19 fireball | sphere r 18 `#ff8a2e`, additive, opacity 0.5 |
| 20 short-circuit orb | sphere r 5 `#9fd7ff`, additive |
| 0 unknown | sphere r 3 `NEUTRAL` |

Trails for every instance the extras layer draws: a ribbon through the instance's last 6 samples (taken from
`pos`, so seek-deterministic), width 3, `TEAM_TRAIL`, opacity falling to 0 at the tail. Crit projectiles: width 6 and
`TEAM_FX`. drei `<Trail>` is not used (it keeps wall-clock history).

`CombatFxLayer`:

| effect | trigger | look |
|---|---|---|
| crit glow | every projectile instance with `crit` that the extras layer draws, alive at the tick. Base-drawn projectiles get the same glow inside `Projectiles.tsx` (edit 2 below) | additive sphere r 9 `TEAM_FX`, opacity `0.35 + 0.1 * sin(tickF * 0.4)`, at the instance's interpolated position |
| deflected | instance drawn by the extras layer with a `deflects` entry at or before the tick (base-drawn ones: edit 2 below) | ring r 6 tube 1 around it in the new team's `TEAM_FX` |
| explosion | `tempents.explosions`, age < 14 ticks | sphere radius `R * (1 - (1 - a) ** 3)` with `a = age / 14`, opacity `0.5 * (1 - a)`, colour `#ff9a4a` (`#ff6a1a` for flares). R: 110 for weapon ids 22, 65, 79, 55; 100 for 23, 24, 35, 53, 91; 28 for 58, 84; 70 otherwise. When `|normal.z| > 0.7` and `entity == 0`, a dark disc r `0.4 * R`, opacity 0.35 fading over 200 ticks |
| building explosion | `particles` named `ExplosionCore_buildings`, age < 16 | as explosion with R 140 |
| hitscan tracer | `tempents.bullets`, age < 4 ticks | from the bullet origin, direction from the base view angles of the shooter at that tick (fallback: the bullet's pitch and yaw). Pellets: 10 for weapon ids 12, 13, 14, 15, 16, 69, 76, 85 and 4 for id 71, using the fixed pattern (Appendix B.5) scaled by `spread`; 1 otherwise (minigun 18 included). Length: to the victim centre (+41) when a `hurts` row has the same tick and attacker and the victim lies within 8 degrees of the centre pellet; else 1500, or 4000 for sniper ids 17, 77, 99. Look: instanced quad 1.2 wide, `#fff2b3`, opacity 0.8 to 0; crit `TEAM_FX` |
| sentry tracer | `tempents.tracers`, age < 3 | same look from start to end |
| flames | `flames` instance with a `box` entry at the tick, `firing` or within 10 ticks after `firing` dropped | open cone (16 segments) from the pyro muzzle (actor position + (0, 0, eye - 12) + forward * 20, forward from the base view angles), axis = view direction, length = distance from the muzzle to the farthest box corner along the axis clamped to 40..320, end radius `0.38 * length`; vertex-colour gradient `#ffe066` alpha 0.6 at the base to `#ff5a1a` alpha 0 at the tip, additive; radius scale `0.9 + 0.2 * hash(Math.floor(tickF))`; an inner cone at 0.6 size; fade over 10 ticks after `firing` drops. With no actor for the owner: an additive ellipsoid filling the box |
| airblast | `wstate.state` entering 3 (via `sinceTick`), or `anim` event 1 (ATTACK_SECONDARY) for a player whose active weapon kind is `flamethrower`, age < 10 | cone at the muzzle along the view, half angle 35 degrees, length growing 0 to 260, `#dff3ff`, opacity `0.45 * (1 - a)`, additive, plus a ring at the muzzle |
| deflect flash | `deflect` events, age < 10 | additive sphere r 20 `#ffffff` at the projectile's position (or the pyro muzzle when `projectile == -1`) |
| muzzle flash | `players.fire` rows for non-melee, non-medigun, non-flamethrower weapons, age < 2, not for the POV subject while the camera is his own `povCamera` | additive sprite size 10 `#ffd27a` at actor + (0, 0, eye - 10) + forward * 26 + right * 8 |
| syringes | `clientProjectiles` kind 21 | position `p0 + v * t + 0.5 * (0, 0, -240) * t^2` for t in [0, 0.6 s]; instanced 6-unit needles along the velocity, `TEAM_TRAIL` of the shooter's team at that tick |

`Projectiles.tsx` edits. "Extras ready" below means `useExtras()` is defined and `available.projectiles` is true.

1. Position. Each base projectile (entity id E at `renderTick`) finds its extras instance through
   `derived.projectilesByEntity.get(E)`: the instance with `created <= tick < hidden`. When extras are ready and the
   instance exists, the object takes its position from the extras samples, interpolated with `frameProgress`, and
   its orientation from the sample delta, instead of the smoothed base position. The 50 ms exponential smoother
   (`PROJECTILE_POSITION_SMOOTH_SECONDS`, Projectiles.tsx:20) stays only for projectiles without a match and while
   extras are not ready. In steady flight that smoother trails the true position by speed x 0.05 s (about 55 units
   for a stock rocket, 99 for the Direct Hit), so mesh, glow and trail must share one position.
2. Crit glow and deflect ring for base-drawn projectiles render as children of the base projectile object, keyed by
   entity id, with the look of the CombatFxLayer rows. They follow the mesh exactly.
3. Trails. Once extras are ready, trails for base types 1 to 4 come from the instance's `pos` samples like the
   extras ribbons (rockets use the last 12 samples). Rocket smoke becomes instanced puffs: one puff per sample of the
   last 48 ticks at `pos[sampleTick]`, size `4 + 10 * age / 48`, opacity `0.35 * (1 - age / 48)`, `#9a9a9a`, with
   `age = tickF - sampleTick`. drei `<Trail>`, the 800 ms smoke ring buffer and the 1.5 s frozen-trail decay
   (wall-clock code at Projectiles.tsx:296 and 526) run only while extras are loading or unavailable.
4. Explosions. With `settings.highlander.enabled` false, behaviour is unchanged. Otherwise `projectiles.explosions`
   off means no explosions from either source. On means CombatFxLayer's `TETFExplosion` effects when extras are
   ready and `available.explosions` is true, and the despawn-based explosions of this file otherwise.
5. No Draco change here: S0 sets the decoder path for every `useGLTF` call (section 6.2 item 8).

Settings: `projectiles.extraTypes`, `.critGlow`, `.explosions`, `.tracers`, `.flames`, `.airblast`.

Probes: `projectiles.at(tick)` returns `{ instance, entityId, kind, pos, crit, deflected, source: 'base' | 'extras' }[]`
for every alive instance; `projectiles.source()` returns the served-by-base count and `mismatches`;
`projectiles.trails(tick)` returns every trail's point list; `combat.fx(tick)` returns the active effects with their
ages; `combat.critGlow()` returns the world positions of each crit glow and its mesh in the current frame.

Acceptance:
- For 20 random ticks of 1438891, the probe's alive set equals `created <= tick < hidden` over the extras tables.
- At `findTicks('proj:10')` + 2 on 1438891 (141 bolts exist), exactly one row and one bolt mesh exist for that
  entity id. `projectiles.source()` reports its `mismatches`.
- RTS screenshots at `findTicks('proj:7')`, `('proj:8')`, `('deflect')`, `('airblast')`, `('flamesOn')` and
  `('critBullet')` + 2 ticks show the effect at the right place.
- 1x playback for 2 s from a tick where a crit rocket flies (`projectiles.at` with `crit` and `source: 'base'`; 1440442
  has 41 crit projectiles): every frame's `combat.critGlow()` puts the glow centre within 0.5 units of its mesh.
- Seeking to the same tick from 300 ticks before and from 300 ticks after gives identical `projectiles.trails(T)`
  output (the D12 check now covers trails).
- With `projectiles.explosions` off, `combat.fx` and the scene show no explosion from either source.
- `syringe` on a demo from `$S/p1/survey.json`, or reported as unvalidated.
- No new `performance.now()` in effect code. 1x playback at tick 21896 (most projectiles) on 1438891 stays at or
  above 30 fps.

### F4. Sniper, POV and viewmodels

Purpose: correct first-person view (eye height, TF2 FOV, zoom), the POV subject with the dead-POV policy and a
chase camera, scope overlay, POV weapon HUD, placeholder viewmodels driven by the demo, sniper and wrangler laser
dots, POV medic beam, and the Linux pointer-lock fix.

Data: `players.fov`, `.view`, `.weapon`, `.wstate`, `.vm0`, `.vm1`, `.fire`, `.anim`, `.medigun`, `.sniper`,
`.ammo`, `.misc` (including `obsMode`, `obsTarget`, `rage`), `disguiseAt`, `buildingsOf`, `dots`, `HL.ZOOMED`,
items, base health, deaths and view angles.

Files owned: `src/highlander/scene/viewmodel/*`, `src/highlander/scene/layers/SniperLayer.tsx`,
`src/highlander/scene/layers/PovLayer.tsx`, `src/highlander/pov/*`,
`src/highlander/hud/widgets/ScopeOverlay.tsx`, `src/highlander/hud/widgets/PovWeaponHud.tsx`,
`src/highlander/scene/eyeHeight.ts` (refines the S0 version), `src/components/Controls/SpectatorControls.js`.

POV subject (D16). `src/highlander/pov/subject.ts` (S0 writes the stub, F4 the body):

```ts
export type PovCameraKind = 'own' | 'spectated' | 'chase' | 'deathcam' | 'stay'
export interface PovSubject {
  focusedEntityId: number; focusedP: number      // the player the user picked
  entityId: number; p: number                    // the player whose view, FOV, viewmodel and HUD are shown
  camera: PovCameraKind
  killerEntityId?: number                        // deathcam: the actor the camera looks at
  deathTick?: number                             // deathcam: the focused player's latest death at or before the tick
}
export function povSubjectAt(x: HighlanderExtras | undefined, demo: AsyncParser, focusedEntityId: number, tick: number, opts: { deadPov: 'stay' | 'spectated'; chase: boolean }): PovSubject
export function usePovSubject(renderTick: number): PovSubject | null    // null unless the controls mode is 'pov' and focusedObject is set
```

`povSubjectAt` is a pure function of the tick. The S0 stub returns the focused player with camera `'own'`.

| focused player at `tick` | `pov.deadPov` | focused player's `misc.obsMode` and `obsTarget` | subject | camera |
|---|---|---|---|---|
| alive (base health > 0) | any | | focused | `'own'`, or `'chase'` when `pov.chase` |
| dead | `'stay'` | | focused | `'stay'` (today's behaviour) |
| dead | `'spectated'` | 4 IN_EYE, target alive with an actor | target | `'spectated'`, or `'chase'` when `pov.chase` |
| dead | `'spectated'` | 5 CHASE, target alive with an actor | target | `'chase'` |
| dead | `'spectated'` | 1 DEATHCAM or 2 FREEZECAM | focused | `'deathcam'`, `killerEntityId` = the target's entity (none when the target is the focused player, a suicide) |
| dead | `'spectated'` | anything else, or no extras | focused | `'deathcam'` without a killer |

At death TF2 sets the observer target to the attacker and keeps it through DEATHCAM and FREEZECAM
(`tf_player.cpp:12438-12473` and `13794-13821`). On 1438891 those two modes account for 385 of the 748
observer-mode changes, against 178 for IN_EYE. Following `obsTarget` in them would cut into the killer's eyes after
nearly every death, so the rule never does.

`PovLayer` (active while the controls mode is `pov` and `focusedObject` is set) applies the subject every frame:
- Camera. `'own'` and `'stay'` need no override: Controls renders the focused actor's `povCamera`. `'spectated'`
  calls `setPovCameraOverride(subject actor's povCamera)`. `'chase'` uses a PovLayer-owned `PerspectiveCamera`
  placed each frame at `eye - forward * 150 + (0, 0, 20)` and looking along `forward`, with `eye` and `forward` from
  the subject actor's `aim` world transform. That transform is the interpolated actor, so a seek matches playback.
  There is no wall collision. `'deathcam'` uses a second PovLayer-owned camera at the focused player's eye at
  `deathTick - 1` (base position plus eye height), looking each frame at the killer actor's position + 41, or along
  the last base view angles when there is no killer. The override is set only when the camera object changes,
  never per frame.
- Cleanup. PovLayer clears the override when the camera kind becomes `'own'` or `'stay'`, when the controls mode
  leaves `pov`, and when it unmounts. S0 also clears it in `jumpToRtsCamera`, `jumpToSpectatorCamera` and on scene
  loads, and `Controls` ignores it outside POV mode (section 6.2 item 7), so it never leaks into RTS or spectator.
- FOV (setting `pov.tf2Fov`). Each frame set the active camera's `fov` to `verticalFov(fovAt(x, subject.p, tickF,
  90))` for `'own'` and `'spectated'`, or to `verticalFov(90)` for `'chase'` and `'deathcam'`, and call
  `updateProjectionMatrix()` when it changed by more than 0.01. When the setting is off, or a camera stops being the
  active POV camera, restore `settings.camera.fov` on it.
- Near plane: 1 instead of 0.1 on the active POV camera (restore after).
- POV medic beam. When the subject heals someone (`medigunAt(x, subject.p, tick)` with `healing` and a target) and
  the camera is `'own'` or `'spectated'`, draw `HealBeam` from the viewmodel muzzle's world position (camera position
  + down 12 + forward 20 when there is no viewmodel) minus `(0, 0, HEAL_BEAM_OFFSET)` to the target actor's position
  as is. HealBeam adds 41.5 to both ends, so only the origin needs the correction. S0 already hides the base beam for
  the actor whose `povCamera` is active.
- Chase key: S0 binds `4` to toggle `pov.chase`.

`ViewmodelLayer`, mounted with `createPortal(<group name="viewmodelRoot" />, subject actor's povCamera)` while the
camera kind is `'own'` or `'spectated'`, setting `pov.viewmodel` is on, the subject is alive and not `HL.ZOOMED`, and
an active weapon is known. Every input (`ViewmodelInput.p`, weapon, fire and anim events, flags) comes from the
subject, so a spectated teammate shows his own viewmodel.

Render-order trick (exact; it works with plain rendering and with the outline `EffectComposer`):

```ts
const DEPTH_CLEAR_ORDER = 1_000_000
const VM_ORDER = 1_000_001
// one tiny mesh, first in the group
depthClear.material = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, transparent: true })
depthClear.renderOrder = DEPTH_CLEAR_ORDER
depthClear.frustumCulled = false
depthClear.onBeforeRender = renderer => {
  renderer.state.buffers.depth.setMask(true)   // glClear(DEPTH_BUFFER_BIT) obeys the depth mask
  renderer.clearDepth()
}
// every viewmodel mesh
mesh.material.transparent = true; mesh.material.depthTest = true; mesh.material.depthWrite = true
mesh.renderOrder = VM_ORDER; mesh.frustumCulled = false
```

Transparent objects render after opaque ones and sort by `renderOrder` first, so the depth clear runs after the
whole world and the viewmodel never clips into walls. The `setMask(true)` line is required: three r163's `clear()`
resets the stencil mask but not the depth mask, and `renderObject` calls `object.onBeforeRender` before the clear
mesh's own material state is applied. Without it the clear inherits the mask of the previous object, and every
additive glow is `depthWrite: false` (section 1.5) and sorts before the clear, so whenever a glow draws last the
clear does nothing. Going through `state.buffers.depth` keeps three's state cache in sync.

Viewmodel FOV: `root.scale.set(k, k, 1)` with `k = tan(camFovV / 2) / tan(vmFovV / 2)`,
`vmFovV = verticalFov(pov.viewmodelFov)`. Placement converts Source eye space (forward, right, up) to camera space
(x = right, y = up, z = -forward). Left-handed players (`misc.flip`) get `root.scale.x *= -1` (three.js flips the
front face for negative determinants). Setting `pov.minimalViewmodel` adds the item's `o` offset (forward, right,
up) to the anchor.

Provider interface (`src/highlander/scene/viewmodel/provider.ts`, S0 writes it verbatim):

```ts
export interface ViewmodelInput {
  p: number; classId: number; team: 'red' | 'blue'
  weaponDef: number; kind: string            // items.json `k`, 'other' fallback
  tickF: number
  drawTick: number                           // tick the current weapon became active
  fireTicks: number[]                        // fire events of p within [tickF - 40, tickF]
  anim: { tick: number; event: number; data: number }[]   // anim events of p within [tickF - 60, tickF]
  wstate: WeaponState | null
  medigun: MedigunState | null
  sniperCharge: number
  flags: number
  flip: boolean
  vm0: VmState | null
  vm1: VmState | null
}
export interface ViewmodelInstance { object: THREE.Object3D; muzzle: THREE.Object3D; update(input: ViewmodelInput): void; dispose(): void }
export interface ViewmodelProvider { id: string; priority: number; supports(input: ViewmodelInput): boolean; create(input: ViewmodelInput): ViewmodelInstance }
export function registerViewmodelProvider(provider: ViewmodelProvider): void
export function pickViewmodelProvider(input: ViewmodelInput): ViewmodelProvider
```

The placeholder provider (`placeholderProvider.ts`) has priority 0 and supports everything. A later GLB provider
(priority 10) would map (classId, weaponDef) to a model and drive its clips from `vm0.seq`, `vm0.parity` and
`vm0.rate`. Instances are recreated when (classId, weaponDef, team) changes.

Placeholder shapes and anchors: the table in tf2-reference section 10.4, one builder per `k`. Colours `METAL`,
`DARK_METAL`, wood `#6b4a2b`, accents `TEAM_FX`. Hands: two boxes 7 x 5 x 5 in `TEAM_DARK`, at the grip and the
fore end.

Animations (`animate.ts`), all pure functions of `ViewmodelInput`:

| animation | rule |
|---|---|
| draw | `d = clamp((tickF - drawTick) / 33, 0, 1)`, `e = 1 - (1 - d) ** 3`; up offset `-14 * (1 - e)`, pitch `+25 * (1 - e)` degrees |
| fire kick | latest fire tick within 12 ticks: `a = max(0, 1 - (tickF - tf) / 8)`; back `2.5 * a`, pitch up `4 * a` degrees; muzzle sprite (size 6 `#ffd27a`) for age < 2 except melee, medigun and flamethrower |
| melee swing | latest anim event 0 within 14 ticks for kinds `melee_blunt`, `melee_blade`, `knife`, `wrench`, `fists`: `s = age / 14`; yaw from 35 to -45 degrees, forward `6 * sin(PI * s)`, roll `20 * sin(PI * s)` degrees |
| reload | `wstate.reload` 1 or 2, or anim event 3 or 4 within 40 ticks: dip -5, roll 18 degrees, eased over 6 ticks; each event 4 adds a 6-tick bump of -2 |
| minigun | barrel roll `tickF * rate`, rate 18 degrees per tick in states 2 and 3, 6 in state 1, 0 otherwise |
| flamethrower | states 1 and 2: additive cone r 3 length 14 at the nozzle with flicker; state 3: a puff cone growing over 8 ticks |
| medigun | nozzle glow while healing |
| sniper rifle | hidden while zoomed; after a fire event the bolt slides back 3 and returns over 20 ticks |
| bow | arrow and string pulled back by `clamp((tickF - chargeTick) * interval / 1.0, 0, 1)` |
| sticky launcher | barrel retracts by `clamp((tickF - chargeTick) * interval / 4.0, 0, 1)` |
| knife | blade raised 30 degrees while `readyToBackstab` |
| spy watch | `vm1` without `nodraw`: watch box at (18, -10, -10), raised for 20 ticks after a `HL.CLOAKED` edge |
| idle sway | right `+0.4 * sin(tickF * 0.05)`, up `+0.3 * sin(tickF * 0.1)` |

`SniperLayer` (settings `sniper.dots`, `sniper.beams`): every `dots` instance alive at the tick, held at its `pos`
entry (not interpolated: the dot jumps between hit points). Two billboard sprites from one radial canvas texture
made once: outer size 6 at opacity 0.5, inner size `6 * s` at opacity 1, `s = clamp(charge / 150, 0.1, 1)` with
charge from `sniperChargeAt(owner)` (fallback `(tickF - chargeTick) * interval * 50`), `TEAM_FX`, `depthTest: false`
so dots read through walls. Beam: a line from the owner's eye (actor position + eye height) to the dot, `TEAM_FX`,
opacity 0.3 (0.5 for the wrangler laser).

`ScopeOverlay` (HUD widget, POV only, setting `pov.scopeOverlay`): when the camera kind is `'own'` or `'spectated'`,
the subject has `HL.ZOOMED` and the subject's active weapon kind is `sniper_rifle`: black outside a centred circle of radius 46vh (CSS radial-gradient), 1 px crosshair lines across the
circle, a vertical charge gauge (left 50% + 6vh, height 18vh, width 0.8vh) filled by `charge / 150` in `TEAM_HUD`
(`#e8d34a` for the Sydney Sleeper, `wm` 1) with an "NN%" label. Opacity `clamp((90 - fov) / 70, 0, 1)`, so it fades
with the zoom transition. While the opacity is above 0 it calls `setScopeActive(true)`, and `false` otherwise and on
unmount. The base `Crosshair` hides while `scopeActive` is true (S0), so a zoomed sniper shows one crosshair.

`PovWeaponHud` (HUD widget, POV only, setting `pov.weaponHud`), bottom right, 220 px wide, for the subject:
- weapon name; clip and reserve ("6 / 20", reserve from `ammo.primary` or `.secondary` by the item slot, none for
  melee);
- engineers: "Metal 200" and a building panel from `buildingsOf(x, subject.p, tick)`, one 20 px row per building
  (type glyph, level, health bar, sentry shells and rockets, dispenser metal, teleporter recharge, a red outline
  when sapped, "carried" and "building" states);
- medics: "UberCharge 87% Kritzkrieg" with READY at 100 %;
- spies: the cloak bar and "Disguised as <class>, <team> (<weapon name>)" from `disguiseAt` while disguised
  ("Disguising as ..." while disguising);
- soldiers and pyros: the rage meter from `misc.rage`, labelled BANNER or MMMPH, when the loadout has a rage item or
  the rage is above 0;
- demomen: "Stickies 3"; bows and sticky launchers: a charge bar;
- "Spectating <name>" for camera `'spectated'` and "Killed by <name>" for `'deathcam'` with a killer.

`eyeHeight.ts`: `getEyeHeight(entityId, classId, tick)` returns `LEGACY_EYE_HEIGHT` when `enabled` or `pov.eyeHeight` is off;
otherwise `eyeZAt(...)` when available, else `DUCK_EYE_HEIGHT` when the base duck bit 0 is set, else
`EYE_HEIGHT[classId]`.

`SpectatorControls.js` line 151 becomes:

```js
const lock = this.domElement.requestPointerLock({ unadjustedMovement: true })
if (lock && typeof lock.catch === 'function') lock.catch(() => this.domElement.requestPointerLock())
```

Probes: `pov.state()` returns `{ focusedEntityId, entityId, camera, killerEntityId, fovH, fovV, eyeZ, near, zoomed,
override }`; `viewmodel.state()` returns `{ subject, provider, kind, weaponDef, draw, kick, reload, swing }`.

Acceptance:
- On 1438891 with `--pov sniper@red` at `findTicks('zoom')` + 25: `fovH` is 20 +/- 0.5 and `fovV` 15.07 +/- 0.3;
  the scope overlay is visible; no viewmodel. At unzoom + 3 the FOV is between 20 and 90.
- One POV shot per class and team at 30000: each shows a placeholder for the active weapon kind.
- `viewmodel.state()` reports `kick > 0` one tick after a fire event of the subject.
- Eye height probe: scout 65, heavy 75, ducked 45.
- Spectator mode in the harness logs no `NotSupportedError`.
- Dead POV on 1438891: take a focused player's first death from the base deaths. On every 5th tick from the death to
  the respawn, `pov.state().entityId` never equals the killer. The camera is `'deathcam'` while `obsMode` is 1 or 2,
  then `'spectated'` with the teammate's entity once `obsMode` is 4, and `viewmodel.state().subject` is that
  teammate.
- Switching to RTS at death + 200 ticks leaves `povCameraOverride` undefined, and the RTS camera renders.
- Depth clear: a POV shot with the viewmodel against a wall while an additive glow (another player's uber shell or
  crit aura) is on screen shows the viewmodel unclipped.
- At the zoom tick the base crosshair is absent from the DOM (`scopeActive` true).
- With `pov.chase` on, the subject's model is visible, and seeking to the same tick twice gives the same camera
  position.
- Engineer POV at a `buildDone` + 10 tick shows one panel row per building. Spy POV at a `disguise` + 10 tick shows the
  disguise line.
- POV playback at 1x for the medic stays at or above 30 fps.

### F5. Objectives and HUD

Purpose: objective HUD for KOTH, payload, A/D, 5CP and tug of war, round and setup timers, the stopwatch state on
every attack/defend map, team header, round banner, cart and control point markers in the scene, a 9v9 player list
with class badges, a medic panel, a Tab scoreboard, killfeed upgrades, faster MatchKillfeed panel, timeline markers
with event categories and next/previous keys, and the TICK display fix.

Data: `objectives`, `events`, `players` (medigun, cloak, disguise, sniper, misc, scoring, itemCharge, loadout),
`buildingsOf` (section 6.5), `hurts`, `findTicks`, `convarAt`, map-meta (`useMapMeta`), base deaths, rounds and meta
cache.

Files owned: `src/highlander/scene/layers/ObjectivesLayer.tsx`, `src/highlander/objectives/*`,
`src/highlander/hud/HudLayout.tsx`, `src/highlander/hud/hudSnapshot.ts`, `src/highlander/hud/widgets/ObjectiveHud.tsx`,
`src/highlander/hud/widgets/TeamHeader.tsx`, `src/highlander/hud/widgets/MedicPanel.tsx`,
`src/highlander/hud/widgets/Scoreboard.tsx`, `src/highlander/hud/widgets/RoundBanner.tsx`,
`src/highlander/hud/killfeedModel.ts`, `src/highlander/hud/timeline.ts`, `src/components/UI/PlayerStatuses.tsx`,
`src/components/UI/Killfeed.tsx`, `src/components/UI/MatchKillfeedPanel.tsx`, `src/components/UI/PlaybackPanel.tsx`,
`src/utils/matchEvents.ts`.

HUD snapshot (section 1.6 rule 10). `src/highlander/hud/hudSnapshot.ts` exports
`useHudSnapshot(renderTick: number): HudSnapshot | null`. It computes one plain object per `hudTick`, memoized at
module level by (extras, demo, `hudTick`): the per-player rows (class, health, alive, respawn seconds, badge data),
the per-team medic state, the objective values and the team header values. PlayerStatuses, MedicPanel,
ObjectiveHud, TeamHeader, Scoreboard and RoundBanner read only the snapshot; none of them calls getters itself. The
baseline is CPU-bound at 33 fps, and 18 rows plus every widget calling getters on each tick would cost more than the
scene layers.

Layout (desktop, at least 1024 px wide):

| element | position |
|---|---|
| ObjectiveHud + TeamHeader | top 8 px, centred, at most 560 px wide and 72 px tall |
| BLU player column | left 72 px (clears the toolbar at x 16..56), top 96 px |
| RED player column | right 8 px, top 96 px |
| rows | 26 px tall, 232 px wide, 2 px gap, opaque `bg-pp-panel/90` |
| MedicPanel | under each column, at most two 30 px rows |
| Killfeed | top 96 px, right 248 px, newest `hud.killfeedMaxLines` lines (default 6), 30 px lines; below 1280 px width: top 88 px, centred |
| RoundBanner | top 84 px, centred, 420 px wide |
| Scoreboard | centred overlay, 760 px wide, while Tab is held |
| ChatHud, PlaybackPanel, FocusedPlayer | unchanged |
| mobile | existing bottom strip and 3-line killfeed; ObjectiveHud reduced to timer plus progress at 0.75 scale |

ObjectiveHud by mode. The mode comes from map-meta `gameMode`; without map-meta: `objectives.koth` gives KOTH,
watchers give payload, `pd` entries give tug of war, `cp.count > 0` gives control points.

| mode | content |
|---|---|
| all | round timer from `rules.hudTimer` via `timerSecondsAt` as mm:ss (floor); "SETUP mm:ss" while `RULES.IN_SETUP` or the timer `mode` is 0; "OVERTIME" flashing every 33 ticks while `RULES.IN_OVERTIME` |
| KOTH | BLU clock left (`bluKoth`), point icon centre, RED clock right (`redKoth`). The running clock is bright, the paused one dim. Point icon: 36 px circle in the owner's `TEAM_HUD` (grey when neutral), an SVG progress arc in the capping team's colour (`capProgressAt`), "xN" cappers, and a padlock plus "unlocks in N" from `cp.unlockTick` while locked |
| payload | 480 px bar; checkpoints at `cp.pathDistance` (or map-meta linked distance / length) as diamonds in the owner's colour; fill up to the watcher `progress` in the attacking team's colour (`teams.role` 2, default BLU); cart icon at the progress with an "xN" cappers badge; 1 to 3 chevrons from `speed`, one red reverse chevron at -1; "Cart rolling back in N" when `recedeTick - tickF` is under 5 s |
| control points | icons in `cp.layout` order (fallback index order), 32 px each, owner colour, lock, progress arc, cappers |
| tug of war | RED and BLU score bars (`pd.red`, `pd.blu` out of `pd.max`), a cart marker on a bar from the BLU end (0) to the RED end (1) using the watcher `progress`, the timer |
| stopwatch, on top of the mode content whenever `RULES.STOPWATCH` is set (every pl_* demo here and cp_steel: 85 of the 133 local demos) | one line computed as `tf_hud_tournament.cpp:1420-1560` does. `att` and `def` are the teams with `teams.role` 2 and 1 (`teamAt`), `sw` is `rules.swTimer`, and the half is 1 while that timer has `TIMER.CAPTURE_WATCH`, 2 otherwise. `swState` 0: "No capture time set". `swState` 1, half 1: "<att name>: N points, mm:ss banked", with N = att `score` and the time `timerSecondsAt(sw)` (the banked `totalTime`). `swState` 1, half 2: "<att name>: N points to beat in mm:ss", with N = def `score` - att `score` and the countdown `timerSecondsAt(sw)`. `swState` 2 (overtime): "<att name> needs N points to win", with N = def `score` - att `score` + 1. Write "point" when N is 1. |

TeamHeader: team names from `convarAt('mp_tournament_redteamname' / 'mp_tournament_blueteamname')` when set, else
RED and BLU. These convars follow the players across the stopwatch swap, so the RED side can be named "BLU", as on
1440442 from tick 0 (signon convars, section 1.2). Outside stopwatch, scores come from `teamAt(team, tick).score`.
In stopwatch, raw `score` counts points capped in the current game: TF2 resets it when a game is decided
(`tf_gamerules.cpp:5221-5231`) and swaps it between the teams at the side switch (`:16523-16524`), so showing it
would make the header jump and trade places mid-match. In stopwatch the header shows the games won per side and a
centre label "Game N, half H" ("Game N, overtime" while `swState` is 2).

Games won (`src/highlander/objectives/stopwatch.ts`). No networked field counts them (D17). Walk the `roundWin`
events in order. An event decides a game when a `rules` entry within [tick, tick + 3] has `RULES.STOPWATCH_WINNER`
set. Credit the game to the team name `convarAt(nameKey(event.team), event.tick)`, because the names follow the
players across swaps, and show per side the games of the name currently on that side. F5 checks this rule on
1433441 (pl_vigil, 844 s, a full stopwatch game) and records the outcome in its report. If `STOPWATCH_WINNER` never
appears there, use "every second `roundWin` since the last `roundStart` with `fullReset`" instead and record that.

RoundBanner (`RoundBanner.tsx`, setting `hud.roundBanner`): for 330 ticks after each `roundWin` event (age from the
event tick, fading over the last 33), a centred banner. "<team name> wins the round" plus the reason from
`WIN_REASON` (Appendix A) in words: "captured every point", "defended until time ran out", "stalemate", and so on.
After a stopwatch first half: "<next attackers> must beat N points in mm:ss", with N and the time taken from the
first-half attackers' `score` and banked time at the event tick (capping N points faster, or more points, wins). After a decided game: "<team name> wins
game N (a-b)".

Scoreboard (`Scoreboard.tsx`, setting `hud.scoreboard`): shown while `scoreboardOpen` is true (Tab held, S0 key
handler). Two team tables side by side, rows sorted by class order then name, with the current class icon. Columns
at `hudTick`:

| column | source |
|---|---|
| K | base deaths with that attacker, minus feign kills and suicides |
| A | `kill` events with that assister, not feign |
| D | base deaths of that victim, minus feigns |
| damage | `scoring.damage`, else `resource.damage` |
| heals | `scoring.heals`, else `resource.healing` |
| ubers | `uberDeployed` events of that medic |
| backstabs, headshots | `kill` events with `customKill` 2 / 1, not feign |
| caps | `scoring.caps`, else `captured` events listing the player |
| buildings destroyed | `destroyed` events with that attacker |
| classes played | class icons in order of first play, from the base meta cache sampled every 66 ticks up to the tick |

Columns without data hide (section 3.9). Per-player event indices are built once per demo, and counts use binary
search, so the board is a value-at-tick lookup that works with seeking.

ObjectivesLayer (scene):

| object | spec |
|---|---|
| cart | at the cart mover's transform (`cart.movers` instance alive at the tick; else the train mover with z - 48): slab 60 x 36 x 6 at z 6, bomb cylinder r 15 length 46 along X at z 30 `DARK_METAL`, four wheels (cylinder r 7 width 4) at (+/-22, +/-18, 7) `METAL`, a light sphere r 3 at z 48 in the attacking team's `TEAM_FX`, blinking every 20 ticks while `speed > 0`, `#ff2020` while `speed < 0`. Tug of war: `NEUTRAL` body with one light per team |
| push zone | map-meta capture area parented to the train: ring with radius = half the XY diagonal of its bounds (100 when unknown), at cart z + 2, attacking `TEAM_FX`, opacity 0.12, 0.24 while cappers > 0 |
| track | map-meta payload path as a 3-unit ribbon at path z + 4; the pushed part (distance up to progress x length) in the attacking `TEAM_TRAIL`, the rest `NEUTRAL` at 0.35; checkpoint posts (cylinder r 3 h 40) at linked distances in the owner's colour |
| control point | at `cp.pos` (fallback map-meta origin): disc r 48 h 3 in the owner's `TEAM_DARK` or `NEUTRAL`; progress arc torus r 36 tube 3 at z 6 in the capping team's `TEAM_FX`, angle = progress x 2 pi; locked: disc `#3a3a3a` and a dashed ring |

PlayerStatuses (9v9):
- Row: class icon 18 px, name (truncated, full name in `title`), health number on the right; background = health
  fill in `TEAM_HUD` at 85 % opacity for the current share, dark for the missing share, lighter for overheal.
  Dead rows: `#2a2a2a` background, dimmed name, big respawn seconds from `respawnSecondsAt` (fallback: the base
  `respawnTick`).
- Badges (setting `hud.statusBadges`), 14 px, before the health number: medic charge "87%" plus a type letter
  (U, K, Q, V) with a READY glow at 100 %; spy cloak bar (24 x 3) when below 100 or cloaked and the disguise class
  icon (12 px) when disguised; sniper charge bar while above 0; engineer building glyphs (small SVGs: triangle
  sentry, square dispenser, circle with an arrow for the entrance, circle for the exit) coloured by health share,
  level as a small digit, red outline when sapped, striped while building; demoman sticky count when above 0;
  condition glyphs (uber shield, kritz star, flame, blood drop, yellow drop, skull) as SVG, no emoji.
- More badges: soldier, pyro and sniper rage % (`misc.rage`) when the loadout has an item with `buffType`
  (banners `bt` 1 to 3, Phlogistinator 5, Hitman's Heatmaker 6); demoman shield charge bar (`misc.charge`) when the
  loadout has a `shield`; a throwable recharge ring for a loadout item of kind `jar` (`itemCharge.secondary`) or the
  Sandman and Wrap Assassin balls (`melee_blunt` with `wm` 1, `itemCharge.melee`).
- Clicking a row or a name keeps calling `jumpToPlayerPOVCamera(entityId)` (PlayerStatuses.tsx:159 and 232). With
  18 players it is the fastest way into a POV, because the `1` key cycles through everyone in order.
- Hovering a row shows the full name, the loadout item names (`loadoutAt` with `itemName`) and a scoring line
  ("K 12 A 4 D 7, 8.4k damage") in the `title`.
- Rows keyed by `user.entityId`, sorted by `CLASS_ORDER_MAP`.
- MedicPanel (setting `hud.medicPanel`), one per team: medigun type, a percentage bar, state BUILDING / READY /
  ACTIVE with seconds left, the advantage ("BLU +23%") when both teams' medics are alive, and the time since that
  team's last `uberDeployed`. Seconds left while releasing: `charge * 8` for stock, Kritzkrieg and Quick-Fix (all
  drain over `weapon_medigun_chargerelease_rate` 8 s). The Vaccinator removes a 25 % chunk at once and applies its
  resist cond for 3 s (`weapon_vaccinator_resist_duration`, `tf_weapon_medigun.cpp:1979-1990`), so it shows the
  ready count `floor(charge * 4 + 1e-6)` and, while `HL.VACC_UBER` is set on the medic, `3 - (tickF - onset) *
  interval` seconds, with the onset from `flagSince`. A Vaccinator also shows its selected resist icon (bullet,
  blast or fire for `medigun.resist` 0, 1, 2).

Killfeed (`Killfeed.tsx` + `killfeedModel.ts`):
- Lines come from base `deaths`, annotated with extras `kill` events (same victim entity, tick within 1).
- Feign deaths are hidden unless `hud.killfeedFeignDeaths`.
- `critType` 2 shows `crit.png` before the weapon icon, `critType` 1 the same at 60 % opacity.
- `customKill` 1 (headshot) shows the headshot variant of the weapon icon, looked up as `<icon>hs.png` first (the local
  files are named like `sniperriflehs.png`) and then `<icon>_hs.png`, else a small "HS" badge; 2 (backstab) shows
  `backstab.png`.
- `deathFlags` 0x1 and 0x4 show small "DOM" and "REV" badges.
- Name colours come from the base meta cache at the kill tick, not from `user.team`.
- With `hud.killfeedObjectives`: building kills from `destroyed` events ("attacker, icon, owner's Sentry") and
  capture lines from `captured` events ("BLU captured <cpName>", first three cappers then "+N").
- Lines linger 200 ticks as today; at most `hud.killfeedMaxLines`.

MatchKillfeedPanel: render rows only while the panel is open, memoize rows, build each icon URL once per weapon in a
module `Map`. Filter chips: Kills, Ubers, Caps, Buildings, Drops, Spy. The Spy chip lists backstabs, Dead Ringer
feigns (shown here even though the killfeed hides them), `sapped` events and decloaks (`findTicks('decloak')`).
`matchEvents.ts`: `getUberPops` uses `uberDeployed` events when extras are ready; `getAllKills` drops feign deaths.

Timeline (`PlaybackPanel.tsx` + `timeline.ts`, setting `hud.timelineMarkers`): markers on the slider by category,
each with its own toggle. Hovering a marker shows the clock time and a short text. The marker position uses
playback tick = cache tick + 2.

| category (setting) | default | markers |
|---|---|---|
| medic (`hud.timelineMedic`) | on | `uberDeployed` (small triangle in the team colour), `medicDeath` with `charged` (X) |
| objective (`hud.timelineObjective`) | on | `captured` (flag), `roundWin` (tall bar), `overtimeStart` (ring), `setupFinished` (tick mark) |
| spy (`hud.timelineSpy`) | off | backstab kills, feigns, `sapped`, decloaks |
| engineer (`hud.timelineEngineer`) | off | sentry `buildDone`, sentry `destroyed` |

`timeline.ts` exports `jumpToTimelineMarker(direction: 1 | -1): void`, which seeks to the next or previous marker of
an enabled category. S0 binds `]` and `[` to it (both keys are free today). Fix the TICK display (`tick` instead of
`tick * 2`) and make jump-to-tick use the typed value.

Probes: `objective.hud(tick)` returns the mode, the stopwatch line, the header values and every number the widget
shows; `hud.layout()` returns the bounding rectangles of the ObjectiveHud, both columns, the killfeed, the banner and
the toolbar plus an `overlaps` list; `hud.scoreboard(tick)` returns the table rows; `hud.snapshotStats()` returns
`{ computes, lastHudTick }`.

Acceptance:
- 1438891 (KOTH): the running clock matches `timerSecondsAt` within 1 s, counts down while playing, and the running
  side switches at each `captured` event; overtime shows near the end of the round (`m_bInOvertime` at +782.7 s).
- 1434434 (payload): the bar matches the watcher progress; checkpoints at 0.251, 0.451, 0.718; the scene cart sits
  on the track at the bar's position.
- 1440442 (A/D stopwatch on control points): five point icons in layout order with locks; the stopwatch line
  shows points and time in the control-point layout; the header names the RED side "BLU" from tick 0.
- 1433441 (pl_vigil, a full stopwatch game): the first half shows "N points, mm:ss banked" matching the attackers'
  `score` and the banked time; at the side swap the header names change sides; the second half shows
  "N points to beat in mm:ss"; overtime shows the overtime target when it happens; the decided game adds one to the
  winner's games; a RoundBanner appears after each `roundWin`; the report names the games-won rule that held.
- On 1438891 at the last tick, the scoreboard K and D per player equal the base deaths minus feigns, and holding Tab
  opens it.
- `hud.layout().overlaps` is empty at 1280x720, 1366x768, 1600x900 and 1920x1080 at the 9-line killfeed tick 24902
  of 1438891.
- No feign deaths in the killfeed on 1438891 (16 or more exist).
- During 4 s of 1x playback `hud.snapshotStats().computes` grows by at most 4 x 66 / `HUD_TICK_STEP` + 2.
- Tug of war on 1428628 only when `free -m` shows at least 3000 MB available; otherwise the P1 native numbers stand
  in, and the report says so.
- CPU profile (`--perf-play 21000:12:rts --cpu-profile --no-minify`) shows `KillRow` below 1 % self time, and 1x
  playback fps improves by at least 15 % over the 33 fps baseline.

### F6. Map dynamics

Purpose: moving doors, gates, trains and rotating brushes, brush visibility toggles, placeholder slabs for prop
doors, resupply cabinets, health and ammo pickups with respawn timers, death markers and dropped packs.

Data: `movers`, `pickups`, `ragdolls`, `drops`, `mapNodes`, map-meta (`doors`, `resupply`, `items`), node
`userData.dribble`.

Files owned: `src/highlander/scene/layers/MapDynamicsLayer.tsx`, `src/highlander/mapdyn/*`.

| element | spec |
|---|---|
| brush movers | every `movers` instance with `bspModel >= 0` and a node in `mapNodes`: each frame `xformAt(tickF)`; when it changed, `sceneXformToNode(node, pos, quat, sceneOrigin)` (section 4.5 item 7, Appendix B.2). `node.visible` follows the `vis` track while an instance exists. Nodes without any instance keep their GLB state. On unmount, map change or missing extras call `restoreNode` |
| prop doors | map-meta `doors[]` whose node has `userData.dribble.hasGeometry === false`: a slab box from `localMins`/`localMaxs` attached to the mover transform, `NEUTRAL`, opacity 0.85 |
| resupply | map-meta `resupply[]` bounds as boxes in the team's `TEAM_DARK`, opacity 0.9 (static). Only when `mapStatus.pipeline === 'bsp-to-glb'`: the old textured GLB of koth_product_final already contains the lockers (materials such as `resupply_locker`) |
| pickups | setting `map.pickups`; instanced. Health: white box (small 14 x 14 x 8, medium 20 x 20 x 12, large 26 x 26 x 16) with a red cross (two thin `#d02020` boxes on top). Ammo: `#6b6b3a` box (small 12 x 12 x 10, medium 16 x 16 x 14, large 22 x 22 x 18) with a `#e0c040` band. Bob `2 * sin(tickF * 0.1)`, yaw `tickF * 0.03` rad. While taken (`vis` 0): a wire box at opacity 0.15 plus a ring that fills by `(tick - takenTick) / (nextTick - takenTick)` with `nextTick = trackNextTick(vis, key, tick)`. Without extras pickups: map-meta `items` drawn always visible. When `mapStatus.pipeline !== 'bsp-to-glb'` (koth_product_final, 19 of the 133 demos), the textured GLB already shows baked kits (`medkit`, `ammo_box` materials), so draw no kit boxes and no bob: only the taken wire box and the respawn ring. The baked kit stays visible while taken |
| death markers | setting `map.deathMarkers`: for 330 ticks after each `ragdolls` instance is created (skip `RAG.FEIGN`): an X of two 24 x 3 x 1 boxes on the ground at the ragdoll origin in the victim's `TEAM_DARK`, `#b01515` when `RAG.GIB` |
| drops | setting `map.drops`: ammo packs as 12 x 12 x 8 `#6b6b3a` boxes, building gibs as 6 x 6 x 6 `METAL` boxes, dropped weapons as 24 x 4 x 4 `DARK_METAL` boxes, at their `xform` |

Probes: `mapdyn.movers(tick)` returns `{ bspModel, pos, quat, visible, nodeFound }[]`; `mapdyn.pickups(tick)` returns
`{ instance, kind, size, visible, respawnIn }[]`.

Acceptance:
- On HL maps at least 95 % of mover instances with `bspModel >= 0` find a node (`nodeFound`).
- 1434434 (vigil): the setup gates (`setupgate_stage1_*`) move at `setupFinished` (shots at -20 and +60 ticks).
- 1440442 (steel): a `doorMove` tick shows the door moved; rotating brushes turn.
- Pickups vanish at `pickupTaken`, the ring fills and the kit returns at `pickupBack`.
- koth_product_final (textured GLB, empty `mapNodes`) shows no errors and no movers.
- A koth_product shot at a `pickupTaken` tick on 1438891 shows the ring and wire box over the baked kit, no resupply
  boxes and no floating placeholder kits.

### X1. Integration and performance pass (after F1 to F6 and M2 are merged)

Files owned: `src/components/DemoViewer.tsx` (render path only), `src/components/Scene/Actors.tsx` (nameplate path
only), `src/highlander/perf/*`, and two values: the `players.nameplateFadeDistance` default in
`src/highlander/settings.ts` and `HUD_TICK_STEP` in `src/highlander/constants.ts`.

- Memoize `PanelToolbar`; drop the unused `positionPrev`/`positionNext2` projectile scans.
- Nameplate declutter: draw at most the 12 nameplates nearest the camera, plus the focused player, the hovered
  player and every pinned plate (F1: disguised or disguising, cloaked, a spy below 100 cloak, ubered, MEDIC!).
- Nameplate fade: S0 ships `nameplateFadeDistance` 0 (off), because a 2500-unit fade hides names in the default RTS
  overview. X1 judges RTS and POV shots on 1438891 and 1433441 and either keeps 0 or sets a default. Pinned plates
  never fade.
- `HUD_TICK_STEP`: keep 3 unless the measurements below favour 2 or 4.
- Measure, with every HL setting on:
  - `--perf --perf-play 21000:12:rts` on 1438891 (koth_product, textured GLB);
  - `--perf --perf-play <busiest>:12:rts::1` and `::2` on 1433441 (pl_vigil, 844 s, the median length, bsp-to-glb map
    with movers, cart, doors, pickups, PAK props and 18 players), with `<busiest>` = playback tick of
    `findTicks('busiest')[0]`.
  The pass needs at least 40 fps at 1x and at 2x on both demos, paused fps unchanged, and browser PSS at most the
  baseline + 150 MB.
- Long demos, only when `free -m` shows at least 3000 MB available: load 1437285 (2041 s, 120 MB) and 1432698
  (1557 s, 101 MB) with every HL setting on, and record PSS next to the base-only numbers of step 0.3.
- Check: at a `findTicks('disguise')` tick with an RTS camera far from the spy (more than 2500 units), the spy's
  disguise badge is still drawn.

### X2. Base projectile memory (required; after X1 and F3 are merged)

Files owned: `src/components/Scene/Projectiles.tsx` (the data source only, after F3), the adapter
`src/highlander/memory/projectileAdapter.ts` (new), `src/components/Analyse/Data/ProjectileCache.ts` and
`src/components/Analyse/Data/AsyncParser.ts` (the release method only), and the projectile block of `render()` in
`src/components/DemoViewer.tsx` (the `getProjectilesAtTick` calls, after X1).

- After extras are ready and `available.projectiles` is true (not excluded by the memory plan), call
  `getProjectileSource(x, demo)` (F3) while the base cache still exists, then serve every instance with
  `servedByBase[j] === 1` to `Projectiles.tsx` and `DemoViewer` through the adapter, in the `CachedProjectile` shape
  with `type` from `baseType[j]`.
- Then `AsyncParser.releaseProjectileCache()` drops the `projectileCache` typed arrays (205 to 332 MB on the measured
  demos, more on long demos) and every later read goes through the adapter.
- X2 cannot lower the base parse peak, but it removes the cache from steady-state memory.
- Acceptance: identical projectile positions in screenshots at three ticks of 1438891, before and after; a browser
  memory drop of at least 150 MB on 1438891; with `projectiles` excluded by the memory plan, the base cache stays and
  nothing changes.

---

## 6. Scaffold (task S0)

S0 lands as one commit on `highlander` before any parallel frontend work, after step 0 (section 1.1). Afterwards
feature tasks only fill in their own files. S0 must build, type-check with no new errors (stub rule of section 3.1),
and render the baseline plan (`$H/plans/1438891-baseline.json`) with no visual change except the intended ones: POV
eye heights, the clock fix, actors keyed by entity id. The nameplate fade ships at distance 0, so the RTS overview
shots do not change.

Besides the files below, S0 owns the step-0 files `src/utils/debugBridge.ts`, `src/main.tsx`,
`src/constants/items.json` and `scripts/build-items.mjs`.

### 6.1 New files

| file | content |
|---|---|
| `src/highlander/constants.ts` | section 1.5, verbatim |
| `src/highlander/settings.ts` | section 6.3, verbatim |
| `src/highlander/extras/types.ts` | section 2.5, verbatim |
| `src/highlander/extras/enums.ts` | Appendix A, verbatim, plus `deriveFlags` |
| `src/highlander/extras/track.ts` | section 3.7.1, complete |
| `src/highlander/extras/hooks.ts` | `useExtras = () => useInstance(s => (s.extrasStatus === 'ready' ? s.extras : undefined))`; `useExtrasStatus = () => useInstance(s => s.extrasStatus)`; `useHlSetting<T>(path) = useStore(s => get(s.settings.highlander, path) as T)`; `getHlSetting<T>(path)` for non-React code |
| `src/highlander/extras/getters.ts` | section 3.7.2 signatures; bodies return `null`, 0, `[]` or the documented default |
| `src/highlander/extras/loadExtras.ts` | stub: `startHighlanderExtras` sets status `'disabled'`; `cancelHighlanderExtras` does nothing |
| `src/highlander/extras/findTicks.ts` | stub with the section 3.8 signature returning `[]` |
| `src/highlander/items.ts` | section 3.7.3, complete (reads `src/constants/items.json`) |
| `src/highlander/debug.ts` | section 3.10, complete |
| `src/highlander/scene/HighlanderScene.tsx` | root layer, section 6.4 |
| `src/highlander/scene/actorRegistry.ts` | section 6.4 |
| `src/highlander/scene/actorFx.ts` | `ActorFx`, `NameplateExtra`, `DEFAULT_ACTOR_FX` (base class and team, opacity 1, no tint, emissive 0, not hidden, `scaleZ` 1, no nameplate extra), stub `useActorFx` returning the defaults |
| `src/highlander/scene/eyeHeight.ts` | first version, F4 rules |
| `src/highlander/scene/layers/{PlayerFxLayer, BuildingsLayer, ProjectilesExtraLayer, CombatFxLayer, SniperLayer, ObjectivesLayer, MapDynamicsLayer, PovLayer}.tsx` | `export const XLayer = React.memo((_props: { renderTick: number }) => null)` |
| `src/highlander/scene/viewmodel/provider.ts` | F4 interface, verbatim, with an empty registry |
| `src/highlander/scene/viewmodel/ViewmodelLayer.tsx` | stub layer |
| `src/highlander/hud/HighlanderHud.tsx` | root HUD, section 6.4 |
| `src/highlander/hud/HudLayout.tsx` | the current Killfeed and PlayerStatuses markup moved out of DemoViewer, unchanged |
| `src/highlander/hud/widgets/{ObjectiveHud, TeamHeader, MedicPanel, ScopeOverlay, PovWeaponHud, MapNotice, Scoreboard, RoundBanner}.tsx` | stubs `React.memo((_props: { renderTick: number }) => null)` |
| `src/highlander/hud/timeline.ts` | stub `jumpToTimelineMarker(_direction: 1 \| -1): void` that does nothing (F5 fills it; the `[` and `]` keys call it) |
| `src/highlander/pov/subject.ts` | section 5 F4 types; stub `povSubjectAt` returning the focused player with camera `'own'`, and `usePovSubject` built on it |
| `src/highlander/hud/widgets/ExtrasNotice.tsx` | complete: the loading, error, disabled-with-reason and excluded-groups notices of section 3.9, bottom-left above the chat, `text-xs`, fades after the stated times (a timer is fine here: D12 covers demo visuals, not notices) |
| `src/highlander/settings/HighlanderSettingsSection.tsx` | complete, section 6.3 |
| `src/components/UI/Shared/SettingsOptions.tsx` | `Option`, `SliderOption`, `ToggleOption` moved out of SettingsPanel and exported, plus `SelectOption({ label, value, options: { label, value }[], onChange })` in the same button-group style as the Material option |
| `src/highlander/buildings/model.ts` | section 6.5 types and stub functions |
| `src/highlander/combat/projectileSource.ts` | section 5 F3 types; stub `getProjectileSource` returning empty arrays |
| `src/highlander/map/mapMeta.ts`, `src/highlander/map/mapNodes.ts` | section 4.4 and 4.5 signatures with stub bodies (M1 replaces them) |
| `public/draco/` | copy of `node_modules/three/examples/jsm/libs/draco/gltf/` so every GLB loads offline (item 8 sets the path) |

### 6.2 Edits to shared files (S0 only)

1. `tsconfig.json`: alias `"@highlander/*": ["src/highlander/*"]`.
2. `src/zustand/store.ts`: section 3.3.
3. `src/zustand/actions.ts`: section 3.4, S0 part.
4. `ParseWorker.ts`, `AsyncParser.ts`, `PlayerCache.ts`: section 3.2.
5. `src/utils/parser.ts`: `Math.floor` for seconds.
6. `src/utils/debugBridge.ts`: the `hl` object of section 3.10 plus
   `hl.waitReady(timeoutMs = 90000): Promise<status>` (resolves when the status is `ready`, `error` or `disabled`)
   and `hl.cameraNear(entityId, tick?, distance = 350)`, which returns an RTS camera spec looking at that player
   from behind and above.
7. `src/components/DemoViewer.tsx`:
   - `<Actors actors={actorsThisTick} renderTick={renderTick} />`.
   - `<HighlanderScene renderTick={renderTick} />` right after `<Projectiles ... />`, inside the Canvas.
   - Replace the Killfeed block and the PlayerStatuses block in `ui-layers` with
     `<HudLayout demo={demo} tick={playback.tick} renderTick={renderTick} players={playersThisTick} intervalPerTick={demo?.intervalPerTick ?? 0.015} />`.
   - `<HighlanderHud renderTick={renderTick} />` right before `<PanelToolbar ... />` (no `tick` prop: an unused
     destructured prop fails `noUnusedParameters`).
   - `Controls`: select `const povCameraOverride = useInstance(s => s.povCameraOverride)` at the top. The camera
     effect uses the override only in POV mode with a focused player:
     `const pov = controlsMode === 'pov' && focusedObject ? (povCameraOverride ?? focusedObject.getObjectByName('povCamera')) : undefined`,
     then `nextCamera = pov ?? scene.camera`. The dependencies are `[focusedObject, povCameraOverride, controlsMode]`.
8. `src/components/Scene/Actors.tsx`:
   - `Actors` takes `renderTick` and keys actors by `` `actor-${actor.user.entityId}` ``.
   - `Actor` calls `const fx = useActorFx(user.entityId, renderTick, classId, team)`.
   - Register `{ entityId, group: actorRef.current, body: bodyRef.current, aim: playerAimRef.current }` in the actor
     registry in an effect keyed on `user.entityId`; unregister on cleanup.
   - Heal-target lookup through `getActor(healTarget)?.group.position` instead of the scene traversal.
   - Both `useFrame` branches set `playerAimRef.current.position.set(0, 0, getEyeHeight(user.entityId, classId, renderTick))`.
   - Module scope, once: `useGLTF.setDecoderPath(getAsset('/draco/'))`. drei 9.122 shares one `DRACOLoader`, calls
     `setDecoderPath` on every `useGLTF`, and the decoder initialises from whichever path decodes first, so the
     global path is what keeps the `useGLTF(model, true)` callers in `Projectiles.tsx` offline too. Existing
     `useGLTF(..., true)` calls stay as they are.
   - `PlayerModel` is rewritten and wrapped in `React.memo`: it clones `gltf.scene` once per `PlayerModel`
     instance (`useMemo` on `gltf.scene`) with `scene.clone(true)` and clones every mesh material, renders `<primitive object={clone} />` inside `<Select>`,
     disposes the cloned materials on unmount, and takes `opacity`, `tint`, `emissive`. A layout effect on those
     props sets, per cloned material: `transparent = opacity < 1` (and `needsUpdate` only when that flips),
     `opacity`, `depthWrite = opacity > 0.5`, and, when the material has `emissive`, `emissive.set(tint ?? '#000')`
     with `emissiveIntensity = tint ? emissive : 0`. The model uses `fx.modelClassId` and `fx.modelTeam`, and the
     existing remount-on-change effect keys on those. `visible = alive && !isFocusedPOV && !fx.hidden`.
   - `isFocusedPOV` means "Controls renders from this actor's own `povCamera`": in POV mode, true for the focused
     actor when `povCameraOverride` is unset, and for the actor whose `povCamera` is the override when it is set. With
     a chase or death camera (PovLayer-owned cameras) no actor hides, so the chased subject stays visible.
   - The base `HealBeam` is skipped for the actor with `isFocusedPOV` when `pov.viewmodel` is on and extras are
     ready (F4 draws the POV beam).
   - `fx.scaleZ` scales the body group's z (crouch, F1) and multiplies the nameplate height
     (`ActorDimensions.z * 0.85 * fx.scaleZ`).
   - The nameplate `<Html>` gets a `ref`; `useFrame` sets `ref.current.style.opacity` from the camera distance:
     1 up to `players.nameplateFadeDistance`, linear to 0 at twice that, times `fx.nameplate?.opacity ?? 1`.
     Distance 0 (the S0 default) disables fading, and plates with `fx.nameplate?.pinned` never fade. `Nameplate`
     receives `extra={fx.nameplate ?? undefined}`.
   - `src/components/Scene/Nameplate.tsx` (F1's file afterwards): S0 adds only `extra?: NameplateExtra` to
     `NameplateProps`, unused until F1, so the `Actors.tsx` prop type-checks.
9. `src/components/UI/SettingsPanel.tsx`: import the option components from `Shared/SettingsOptions.tsx`, insert
   `<HighlanderSettingsSection />` right before the "Misc" heading.
10. `src/components/Scene/CanvasKeyHandler.tsx`. Keys bound today: space, left, right, `,`, `.`, up, down, `m`,
    `n`, `o`, `b`, `1`, `2`, `3` (CanvasKeyHandler), esc, `f`, `g`, `c`, `z`, backspace, delete (GlobalKeyHandler),
    `w`, `a`, `s`, `d`, `e`, `c`, shift (SpectatorControls). The new keys are all free; recheck before adding.
    - `v` toggles `highlander.pov.viewmodel`.
    - `i` cycles `highlander.players.disguiseView` through `'auto'`, `'true'`, `'enemy'`, `'pov'`.
    - `4` toggles `highlander.pov.chase`.
    - `[` and `]` call `jumpToTimelineMarker(-1)` and `jumpToTimelineMarker(1)`.
    - Tab: keydown calls `setScoreboardOpen(true)` with `preventDefault()` (it would move focus otherwise), keyup and
      window blur call `setScoreboardOpen(false)`.
11. `src/components/UI/Crosshair.tsx`: return `null` while `useInstance(s => s.scopeActive)` is true.

### 6.3 Settings

```ts
// src/highlander/settings.ts
export interface HighlanderSettings {
  enabled: boolean
  players: {
    conditions: boolean; fxUber: boolean; fxCrit: boolean; fxDebuffs: boolean; fxOverheal: boolean
    cloak: boolean; cloakFloor: number; disguiseView: 'auto' | 'true' | 'enemy' | 'pov'
    nameplateExtras: boolean; nameplateWeapon: boolean; nameplateFadeDistance: number
  }
  buildings: { enabled: boolean; labels: boolean; sentryRange: boolean; blueprints: boolean }
  projectiles: { extraTypes: boolean; critGlow: boolean; explosions: boolean; tracers: boolean; flames: boolean; airblast: boolean }
  sniper: { dots: boolean; beams: boolean }
  pov: { viewmodel: boolean; viewmodelFov: number; minimalViewmodel: boolean; tf2Fov: boolean; eyeHeight: boolean; scopeOverlay: boolean; weaponHud: boolean; deadPov: 'stay' | 'spectated'; chase: boolean }
  hud: {
    objective: boolean; compactStatuses: boolean; statusBadges: boolean; medicPanel: boolean; scoreboard: boolean; roundBanner: boolean
    killfeedMaxLines: number; killfeedFeignDeaths: boolean; killfeedObjectives: boolean
    timelineMarkers: boolean; timelineMedic: boolean; timelineObjective: boolean; timelineSpy: boolean; timelineEngineer: boolean
    damageNumbers: boolean
  }
  map: { movers: boolean; pickups: boolean; respawnVisualizers: boolean; brightness: number; fog: boolean; deathMarkers: boolean; drops: boolean; staticProps: boolean }
}

export const DEFAULT_HIGHLANDER_SETTINGS: HighlanderSettings = {
  enabled: true,
  players: {
    conditions: true, fxUber: true, fxCrit: true, fxDebuffs: true, fxOverheal: false,
    cloak: true, cloakFloor: 0.15, disguiseView: 'auto',
    nameplateExtras: true, nameplateWeapon: true, nameplateFadeDistance: 0,
  },
  buildings: { enabled: true, labels: true, sentryRange: false, blueprints: true },
  projectiles: { extraTypes: true, critGlow: true, explosions: true, tracers: true, flames: true, airblast: true },
  sniper: { dots: true, beams: true },
  pov: { viewmodel: true, viewmodelFov: 70, minimalViewmodel: false, tf2Fov: true, eyeHeight: true, scopeOverlay: true, weaponHud: true, deadPov: 'spectated', chase: false },
  hud: {
    objective: true, compactStatuses: true, statusBadges: true, medicPanel: true, scoreboard: true, roundBanner: true,
    killfeedMaxLines: 6, killfeedFeignDeaths: false, killfeedObjectives: true,
    timelineMarkers: true, timelineMedic: true, timelineObjective: true, timelineSpy: false, timelineEngineer: false,
    damageNumbers: false,
  },
  map: { movers: true, pickups: true, respawnVisualizers: false, brightness: 1, fog: false, deathMarkers: true, drops: true, staticProps: true },
}

/** Effects presets: the select writes these keys; it shows "Custom" when the current values match none. */
export const EFFECT_PRESETS = {
  minimal:    { 'players.fxUber': true, 'players.fxCrit': false, 'players.fxDebuffs': false, 'players.fxOverheal': false, 'projectiles.tracers': false },
  standard:   { 'players.fxUber': true, 'players.fxCrit': true,  'players.fxDebuffs': true,  'players.fxOverheal': false, 'projectiles.tracers': true },
  everything: { 'players.fxUber': true, 'players.fxCrit': true,  'players.fxDebuffs': true,  'players.fxOverheal': true,  'projectiles.tracers': true },
} as const
```

The defaults equal the `standard` preset. Overheal plus signs start off because at 9v9 nearly every player near a
medic is overhealed, and the player list already shows overheal in the health colours. `nameplateFadeDistance`
starts at 0 (off); X1 decides whether to turn it on. `hud.compactStatuses` false keeps the old PlayerStatuses layout
(F5 keeps both). `hud.damageNumbers` is reserved for a later task (section 9).

`HighlanderSettingsSection` renders one "Highlander" heading and these rows. All write through
`updateSettingsOptionAction('highlander.<path>', value)`.

| row | control | key | range |
|---|---|---|---|
| Highlander features (applies on next demo load) | toggle | `enabled` | |
| Effects preset | select | writes `EFFECT_PRESETS[...]` | Minimal, Standard, Everything (Custom when none match) |
| Condition effects | toggle | `players.conditions` | |
| - Uber / Crit and buffs / Debuffs / Overheal and teleport | toggles | `players.fxUber`, `.fxCrit`, `.fxDebuffs`, `.fxOverheal` | |
| Cloak fade | toggle | `players.cloak` | |
| - Cloak visibility | slider | `players.cloakFloor` | 0.05 to 0.5, step 0.05 |
| Disguise view (I) | select | `players.disguiseView` | Auto `'auto'`, Spectator view `'true'`, Enemy view `'enemy'`, POV player's view `'pov'` |
| Nameplate extras / Weapon icon on nameplates | toggles | `players.nameplateExtras`, `.nameplateWeapon` | |
| Nameplate fade distance | slider | `players.nameplateFadeDistance` | 0 to 6000, step 250 (0 = off) |
| Buildings | toggle | `buildings.enabled` | |
| - Labels / Sentry range / Blueprints | toggles | `buildings.labels`, `.sentryRange`, `.blueprints` | |
| Extra projectiles / Crit glow / Explosions / Tracers / Flames / Airblast | toggles | `projectiles.*` | |
| Sniper dots / Laser beams | toggles | `sniper.dots`, `sniper.beams` | |
| Viewmodel (V) | toggle | `pov.viewmodel` | |
| - Viewmodel FOV | slider | `pov.viewmodelFov` | 54 to 90, step 1 |
| - Minimal viewmodels | toggle | `pov.minimalViewmodel` | |
| TF2 field of view in POV / Class eye height / Scope overlay / Weapon HUD | toggles | `pov.tf2Fov`, `.eyeHeight`, `.scopeOverlay`, `.weaponHud` | |
| Chase camera in POV (4) | toggle | `pov.chase` | |
| When the POV player dies | select | `pov.deadPov` | Follow spectated player `'spectated'`, Stay `'stay'` |
| Objective HUD / Compact player list / Status badges / Medic panel / Scoreboard (Tab) / Round banner | toggles | `hud.objective`, `.compactStatuses`, `.statusBadges`, `.medicPanel`, `.scoreboard`, `.roundBanner` | |
| Killfeed lines | slider | `hud.killfeedMaxLines` | 3 to 12, step 1 |
| Show Dead Ringer fakes / Objective lines in killfeed | toggles | `hud.killfeedFeignDeaths`, `.killfeedObjectives` | |
| Timeline markers ([ and ]) | toggle | `hud.timelineMarkers` | |
| - Medic / Objective / Spy / Engineer markers | toggles | `hud.timelineMedic`, `.timelineObjective`, `.timelineSpy`, `.timelineEngineer` | |
| Moving doors / Pickups / Respawn room walls / Death markers / Dropped items / Fog / Map props | toggles | `map.movers`, `.pickups`, `.respawnVisualizers`, `.deathMarkers`, `.drops`, `.fog`, `.staticProps` | |
| Map brightness | slider | `map.brightness` | 0.5 to 2, step 0.05 |

### 6.4 Roots and registries

```tsx
// src/highlander/scene/HighlanderScene.tsx
export const HighlanderScene = React.memo(({ renderTick }: { renderTick: number }) => {
  const enabled = useHlSetting<boolean>('enabled')
  if (!enabled) return null
  return (
    <group name="highlander">
      <PlayerFxLayer renderTick={renderTick} />
      <BuildingsLayer renderTick={renderTick} />
      <ProjectilesExtraLayer renderTick={renderTick} />
      <CombatFxLayer renderTick={renderTick} />
      <SniperLayer renderTick={renderTick} />
      <ObjectivesLayer renderTick={renderTick} />
      <MapDynamicsLayer renderTick={renderTick} />
      <PovLayer renderTick={renderTick} />
      <ViewmodelLayer renderTick={renderTick} />
    </group>
  )
})

// src/highlander/hud/HighlanderHud.tsx
export const HighlanderHud = React.memo(({ renderTick }: { renderTick: number }) => {
  const enabled = useHlSetting<boolean>('enabled')
  return (
    <>
      <ExtrasNotice renderTick={renderTick} />
      <MapNotice renderTick={renderTick} />
      {enabled && (
        <>
          <div className="ui-layer pointer-events-none items-start justify-center"><ObjectiveHud renderTick={renderTick} /></div>
          <div className="ui-layer pointer-events-none items-start justify-center"><div className="mt-[84px]"><RoundBanner renderTick={renderTick} /></div></div>
          <div className="ui-layer pointer-events-none"><ScopeOverlay renderTick={renderTick} /></div>
          <div className="ui-layer pointer-events-none items-end justify-end"><div className="mb-28 mr-4"><PovWeaponHud renderTick={renderTick} /></div></div>
          <div className="ui-layer pointer-events-none items-center justify-center"><Scoreboard renderTick={renderTick} /></div>
        </>
      )}
    </>
  )
})
```

`TeamHeader` renders inside `ObjectiveHud` and `MedicPanel` inside `HudLayout`; both are F5's choice of placement.

```ts
// src/highlander/scene/actorRegistry.ts
export interface ActorHandles { entityId: number; group: THREE.Group; body: THREE.Group; aim: THREE.Group }
export function registerActor(handles: ActorHandles): void          // bumps actorRegistryVersion
export function unregisterActor(handles: ActorHandles): void        // removes only if the stored entry is this object; bumps
export function getActor(entityId: number): ActorHandles | undefined
export function allActors(): IterableIterator<ActorHandles>
export const useActorRegistryVersion = () => useInstance(s => s.actorRegistryVersion)

// src/highlander/scene/actorFx.ts
export interface NameplateExtra {
  disguise?: { cls: number; team: number; disguising: boolean; targetName?: string; health?: number }
  cloakPct?: number
  chargePct?: number           // demoman shield charge bar
  weaponIcon?: string          // kill icon file of the shown weapon (players.nameplateWeapon)
  tags?: string[]
  opacity?: number
  pinned?: boolean             // exempt from the distance fade (S0) and the nearest-12 cap (X1)
  nameOverride?: string        // spy drawn as his disguise: the disguise target's name
  healthOverride?: number      // spy drawn as his disguise: disguise health
  classOverride?: number       // spy drawn as his disguise: disguise class
}
export interface ActorFx { modelClassId: number; modelTeam: string; opacity: number; tint: string | null; emissive: number; hidden: boolean; scaleZ: number; nameplate: NameplateExtra | null }
export function useActorFx(entityId: number, renderTick: number, classId: number, team: string): ActorFx
```

### 6.5 Cross-feature APIs (S0 writes the signatures; the owner fills them)

```ts
// src/highlander/buildings/model.ts (owner F2; read by F5)
export interface BuildingView {
  instance: number; entityId: number; type: number; mode: number; builder: number; team: number; mini: boolean; mapPlaced: boolean
  level: number; health: number; maxHealth: number; built: number; building: boolean; sapped: boolean
  disabled: boolean; wrangled: boolean; carried: boolean; upgrading: boolean
  shells: number; rockets: number; metal: number; objState: number; rechargeLeft: number
  pos: THREE.Vector3; yaw: number
}
export function buildingsAt(x: HighlanderExtras, tick: number): BuildingView[]
export function buildingsOf(x: HighlanderExtras, p: number, tick: number): BuildingView[]
```

`src/highlander/map/mapMeta.ts` and `src/highlander/map/mapNodes.ts` (owner M1; read by F5 and F6) carry the
signatures of sections 4.4 and 4.5, plus
`sceneXformToNode(node: THREE.Object3D, scenePos: THREE.Vector3, quat: THREE.Quaternion, sceneOrigin: { x: number; y: number; z: number }): void`.

`src/highlander/pov/subject.ts` (owner F4; read by F1, F3 and F5) carries
`PovSubject`, `povSubjectAt` and `usePovSubject` (section 5 F4).

`src/highlander/combat/projectileSource.ts` (owner F3; read by X2) carries `ProjectileSource` and
`getProjectileSource` (section 5 F3).

`src/highlander/hud/timeline.ts` (owner F5; called by S0's key handler) carries `jumpToTimelineMarker`.

---

## 7. Order, parallel work and validation

### 7.1 Tasks and dependencies

| task | repo | starts after | runs in parallel with | owner files |
|---|---|---|---|---|
| step 0 prerequisite commit (orchestrator) | dribble.tf | this contract | | the files listed in section 1.1 |
| step 0.3 base-viewer memory on long demos (orchestrator) | dribble.tf | step 0 | S0, P1 | none (a measurement) |
| S0 scaffold | dribble.tf | step 0 | P1 (Rust part) | section 6, plus the step-0 files `debugBridge.ts`, `main.tsx`, `items.json`, `build-items.mjs` |
| P1 extras | dribble-parser, then dribble.tf | this contract (Rust part); S0 merged (TS part) | S0, M1 | sections 2 and 3.1 |
| M1 maps | dribble.tf | S0 merged | P1 | section 4 (4.1 to 4.7), including the converter scripts and patches and the tetsudo entry in `MapBoundaries.ts` |
| M2 PAK static props | dribble.tf | M1 merged | F1 to F6 | section 4.8 |
| F1 conditions and spy | dribble.tf | S0 and P1 merged | F2 to F6, M2 | section 5 F1 |
| F2 buildings | dribble.tf | S0 and P1 merged | F1, F3 to F6, M2 | section 5 F2 |
| F3 projectiles and combat FX | dribble.tf | S0 and P1 merged | F1, F2, F4 to F6, M2 | section 5 F3 |
| F4 sniper, POV, viewmodels | dribble.tf | S0 and P1 merged | F1 to F3, F5, F6, M2 | section 5 F4 |
| F5 objectives and HUD | dribble.tf | S0 and P1 merged (map-meta parts degrade until M1 lands) | F1 to F4, F6, M2 | section 5 F5 |
| F6 map dynamics | dribble.tf | S0, P1 and M1 merged | F1 to F5, M2 | section 5 F6 |
| X1 integration and perf | dribble.tf | F1 to F6 and M2 merged | | section 5 X1 |
| X2 base projectile memory (required) | dribble.tf | X1 and F3 merged | | section 5 X2 |
| DOCS final docs pass | dribble.tf | last | | `AGENTS.md`, `specs/highlander/` |

X1 and X2 both touch `DemoViewer.tsx` `render()`: X1 owns the render path, and X2 takes over only the projectile
block once X1 has merged, so they run one after the other.

One agent should own P1 end to end (Rust, wasm, worker, hydration, alignment, checker), because alignment problems
cross the boundary. While S0 is in progress, P1 works on the Rust side, `hl_extras` and the survey.

M1 merge gate. Before M1 merges, the orchestrator shows the user one vigil screenshot from M1's floating-object
shots (a sticky trap or sniper dot on an invisible prop) and says plainly: stock props (crates, rocks, rails,
oil drums) are TF2 game assets and stay invisible; M2 adds the props that ship inside the map files, which on vigil
are the cliff walls, terrain patches, the observatory and the doorways. The user decides whether that is enough.

Merge order on `highlander`: step 0, S0, P1, M1, then F1 to F6 and M2 as they pass, then X1, then X2. Before each
merge the orchestrator runs, under the lock: `npm run build`, `tsc` (no new errors), the baseline plan (no
unintended visual change), and the task's acceptance plans. A branch that edits a file it does not own goes back to
its task.

### 7.2 Finding interesting ticks (two-pass harness runs)

Pass 1 asks the page for ticks. The harness awaits promises returned by `eval`, so `waitReady` works.

```json
[
  { "name": "ready", "tick": "5%", "screenshot": false, "eval": "window.__dribble.hl.waitReady(90000)" },
  { "name": "find", "tick": "5%", "screenshot": false,
    "eval": "({ cloak: window.__dribble.hl.findTicks('cloak', { limit: 5 }), uber: window.__dribble.hl.findTicks('uber', { limit: 5 }) })" }
]
```

```sh
node $H/shot.mjs --root /home/dalibor/programming/personal/dribble.tf-wt/<task> \
  --demo /home/dalibor/demo_tool/demos/1438891.dem --plan $S/plans/<task>-find.json --out $S/shots/<task>-find
```

Read `manifest.json` (`steps[].eval`). Pass 2 uses concrete ticks. Playback tick = cache tick + 2. For a close camera
on a player, add a step whose `eval` is `window.__dribble.hl.cameraNear(<entityId>, <tick>)` in pass 1 and copy the
result into the `camera` field of the pass-2 step. Each pass-2 step that asserts data also has an `eval` calling the
feature's probe, so the manifest records what was drawn.

Plans live in `$S/plans/<task>-*.json`. Output folders `$S/shots/<task>-*`.

### 7.3 Per-task validation

Memory gates: a demo marked "(gated 1500)" runs only when `free -m` shows at least 1500 MB available, "(gated 3000)"
only at 3000 MB. When a gate fails, the task reports the run as skipped and uses the native numbers instead.

| task | demos | find kinds | modes and checks |
|---|---|---|---|
| P1 | 1434434, 1438891, 1440442, 1442753 (memory), `i52_snakewater_gc.dem` (33 Hz); native `hl_extras --self-check` on 1428628 (tug of war, PD props), 1432698, 1437285, 1429417, 1433815; `check-extras.mjs --options-from` on those five (gated 1500); the survey over all 133 demos | | `hl_extras` and `check-extras.mjs` with expectation files (section 2.7); in the browser `hl.waitReady()` returns `ready` and `hl.status().meta.available` is true for every group the demo has |
| M1 | the ten demos of section 4.7 (1428628 gated 3000) | | RTS default view at 10 % and 50 %, one POV at 50 % per map; `getState().scene.mapLoaded`; console has no page errors; the floating-object shots |
| M2 | 1434434, plus tetsudo, ashville and proot through the render tool or gated harness runs | | RTS at 10 %, POV at 50 %, paused fps on vigil |
| F1 | 1438891, 1440442, 1434434, plus survey demos for jarate, milk, gas, stun, Quick-Fix and Vaccinator | `cloak` (normal and `note: 'feign'`), `decloak`, `disguise`, `uber`, `kritz`, `quickfix`, `vacc`, `crit`, `burning`, `marked`, `jarate`, `milk`, `gas`, `stun` | RTS with `cameraNear` at onset + 5, + 35, + 80; probe `fx.actor` at each; disguise views `'true'`, `'enemy'` and `'pov'` (through `'auto'` in POV) via `settings` |
| F2 | 1438891, 1440442, 1434434 | `buildStart`, `buildDone`, `upgrade`, `sapped`, `carry`, `redeploy`, `wrangled`, `destroyed` | RTS with `cameraNear(builder)`; probe `buildings.at`; the calibration script output |
| F3 | 1438891, 1440442, plus a survey demo for syringes | `proj:7`, `proj:8`, `proj:9`, `proj:10`, `proj:16`, `proj:17`, `deflect`, `airblast`, `flamesOn`, `explosion`, `critBullet`, `syringe` | RTS at + 2 ticks; the crit-glow playback check; trails seeked twice; perf at tick 21896 |
| F4 | 1438891 | `zoom`, `uber` (medic POV), `buildDone`, `disguise`, a focused player's death, plus each class at 30000 | POV of `sniper@red`, `medic@blue`, every class; dead POV through the death; chase on; the wall and glow shot; spectator mode once (no pointer-lock error) |
| F5 | 1438891 (KOTH), 1434434 (payload), 1440442 (A/D stopwatch on control points), 1433441 (a full stopwatch game on vigil), 1439994 (upward), 1428628 (tug of war, gated 3000) | `captured`, `capStart`, `cartMoving`, `cartReceding`, `overtime`, `roundWin`, `medicDrop`, `backstab`, `decloak` | RTS plus HUD at 1280x720, 1366x768, 1600x900, 1920x1080 (`--size`); probes `objective.hud`, `hud.layout`, `hud.scoreboard`, `hud.snapshotStats`; Tab held; `[` and `]`; CPU profile run |
| F6 | 1434434, 1440442, 1442753, 1438891 (koth_product) | `doorMove`, `pickupTaken`, `pickupBack`, `setupFinished` | RTS with `cameraNear` or fixed cameras from map-meta door origins; probes `mapdyn.movers`, `mapdyn.pickups` |
| X1 | 1438891, 1433441; 1437285 and 1432698 (gated 3000) | `busiest`, `disguise` | `--perf --perf-play 21000:12:rts --cpu-profile --no-minify` on 1438891; `--perf-play <busiest>:12:rts::1` and `::2` on 1433441; long-demo PSS; the far-spy nameplate check; the baseline plan |
| X2 | 1438891 | | screenshots at three ticks before and after the release; browser memory before and after |
| all | `public/samples/i52_snakewater_gc.dem` | | loads, plays, no page errors, HL features degrade where data is missing |

### 7.4 Definition of done (every task)

- Only owned files changed; the branch is committed in its worktree.
- `npm run build` passes; `tsc` shows no new errors.
- The task's acceptance list passes; screenshots and manifests are in `$S/shots/<task>-*`.
- The baseline plan shows no unintended change.
- With `settings.highlander.enabled = false` the app behaves as before S0 (except the S0 fixes).
- No wall-clock timing in new effect code; seeking to the same tick twice gives identical probe output.
- The final report lists files changed, how acceptance was checked, and anything not done, including every find
  kind or demo run that was skipped (no demo in the survey, or a memory gate).

---

## 8. Risks and fallbacks

Memory plan for the extras worker (`src/highlander/extras/memory.ts`, P1). This replaces the old fixed 600 MB
fallback with a measured rule.

```ts
export const EXTRAS_PEAK = { a: 0, b: 0 }                 // P1 writes the fit peakMB = a * fileMB + b (section 2.8)
export const GROUP_MB_PER_MINUTE: Record<string, number> = {}   // P1 writes the measured output size per group
export const EXTRAS_BUDGET_MB = 600                       // 300 when navigator.deviceMemory is defined and at most 4
export function planExtrasGroups(fileBytes: number): { groups?: string[]; excluded: string[]; skip: boolean; reason?: string }
```

`planExtrasGroups` predicts the peak from the fit. While the prediction exceeds the budget, it drops the largest
optional group by the measured sizes, choosing among `movers`, `drops`, `ragdolls`, `flames`, `tempents` and
`pickups`. It never drops `players`, `objectives`, `buildings` or `projectiles` (X2 needs the last). When even the
smallest plan exceeds the budget, it returns `skip: true` with the reason "demo too large for Highlander data on this
device". Until P1 has measured, the fit is `a = 2.6, b = 60` (section 2.8).

| risk | effect | fallback |
|---|---|---|
| Extras worker memory on long demos (about 250 MB peak for 122 MB with input ownership) | tab crash on phones or this machine | D4 sequential start; D18 (the base worker returns the file, the extras worker owns its input in wasm memory, output converted group by group); terminate both workers after use; the memory plan above, with `ExtrasNotice` naming the dropped groups |
| The base viewer alone fails on the longest demos (1437285, 2041 s) | nothing loads, with or without Highlander | step 0.3 measures it first and the orchestrator tells the user at once; the cause is the base binary (D2), so no Highlander task can fix it |
| Base projectile cache memory (205 to 332 MB measured, about 0.5 to 1 GB estimated at 2041 s) | high steady-state memory before any HL work | X2 (required), plus the S0 worker termination |
| Alignment differs on some demo | extras would draw in the wrong place | the check fails, status `error`, base UI unchanged; the checker runs on several maps before P1 merges |
| An array prop path guess is wrong (for example `m_iAmmo` element names) | that group stays empty | `meta.available[...]` false and the feature hides; the checker fails on HL demos where the probe saw data |
| Typed game-event decoding depends on struct order (parser-probe section 13) | a future TF2 update misreads fields | checker counts catch it; fall back to reading raw events by field name |
| Sentry pose calibration does not fit | barrels point the wrong way | `AIM_AT_ENEMY` mode |
| Viewmodel render-order trick interacts with the outline `EffectComposer` | viewmodel drawn wrong when outlines are on | hide the viewmodel while `ui.playerOutlines` is on |
| Per-actor material clones and transparency flips cost frame time | lower fps during cloaks | flip `transparent` only on state change; keep 18 actors x a few materials; measured in F1 acceptance |
| HUD widgets re-rendering every tick at 9v9 | the CPU-bound 33 fps baseline drops further | one shared snapshot per `hudTick` (section 1.6 rule 10, F5); measured by X1 on 1438891 and 1433441 |
| Nameplates at 9v9 | clutter and React cost | X1 nearest-12 cap with pinned plates exempt; the S0 distance fade, off by default |
| Stock static props are invisible (D7) | players, stickies, dots and sentries appear to float on bsp-to-glb maps (114 of the 133 demos) | M2 renders the PAK props; the user sees the effect before M1 merges; AGENTS.md lists the cases so nobody files them as bugs |
| tow_tetsudo writes HUD data into the world bounds | wrong placement or camera if the bounds are read | the M1 boundary override (section 4.5 item 4) |
| Stopwatch games won cannot be read from a networked field | wrong match score in the header | the derived rule of F5, checked on 1433441, with a recorded fallback |
| A newer map version than the converted BSP | geometry slightly off | `MapNotice` says which geometry is used; re-run `convert:bsp` on the new BSP |
| Tug-of-war PD props missing on another demo | no PD scores | the objective HUD shows the cart bar and timer only |
| `CTFPlayerDestructionLogic` and other classes absent on older demos | missing groups | `available` flags |
| Parallel tasks touching the same file | merge conflicts | file ownership; the orchestrator rejects out-of-scope edits |
| Large binary additions (about 31 MB of maps and skies, plus the M2 prop GLBs) | repo growth | acceptable; the repo already tracks about 275 MB of maps and nothing is pushed |
| PAK skies, PAK props and BSP-derived geometry are community map content | redistribution question | same status as the existing converted maps; stays local (never pushed) |

---

## 9. Things the user may have forgotten

"In scope" means a task in this contract covers it. "Later" means the data is exported and a follow-up task can add
the UI. The first rows are the ones a Highlander reviewer would miss most.

| item | why it matters in Highlander | scope | where |
|---|---|---|---|
| Scoreboard (Tab) | the screen people use most when reviewing a match: per-player K/A/D, damage, heals, ubers, backstabs, headshots, caps, buildings destroyed, classes played; TF2's full live scoreboard is in every demo | in scope | P1 `players.scoring`, F5 Scoreboard |
| Stopwatch halves and games | 85 of the 133 local demos are stopwatch; the HUD must show points banked, points to beat, overtime, games won and the half, not the raw per-game score that resets and swaps | in scope | F5 (stopwatch line, TeamHeader, RoundBanner) |
| Static props on the bsp-to-glb maps | 114 of the 133 demos; players stand on air and stickies, dots and sentries float | partial: M2 renders the PAK props (vigil's cliff walls, terrain, observatory, doorways); stock props need game assets (D7) | M2, M1 notes |
| What a third-person player holds, and crouching | the RTS read of "spy with the knife out", "medic on the crossbow", "sniper on the SMG"; crouched players looked exposed above cover | in scope: active weapon kill icon on the nameplate, crouch scale | F1 |
| Spy reads from far away | a cloaked spy on a far flank lost his nameplate to the declutter | in scope: pinned plates | F1, X1 |
| Decloak cue | TF2 signals a decloak by sound and this viewer has no audio | in scope: ring and DECLOAK tag | F1 |
| Finding spy, medic, engineer and objective moments | `findTicks` only reached the debug bridge | in scope: timeline categories, `[` and `]` keys, a Spy chip | F5 |
| The POV player's own view of disguises and cloak | "why did our pyro not spy-check him" can only be reviewed from the pyro's eyes | in scope: `disguiseView 'pov'` through `'auto'` | F1 |
| Dead POV during the death and freeze cams | following `obsTarget` cut to the killer's eyes after nearly every death | in scope: death camera, then the spectated teammate with his viewmodel | F4 |
| Chase camera | follow one player's positioning while seeing his body | in scope: `pov.chase`, key `4` | F4 |
| Round results | only a timeline marker and a stopped timer said who won | in scope: RoundBanner | F5 |
| Per-class status | banner, Phlogistinator and Heatmaker rage, shield charge, Vaccinator resist, revved heavies, stuns, Gas Passer, jar and cleaver recharge | in scope | F1 tags, F4 POV HUD, F5 badges and MedicPanel, P1 `itemCharge` |
| Engineer POV building panel | what an engineer watches most | in scope | F4 |
| Effect density at 9v9 | overheal signs and dispenser beams everywhere | in scope: effect groups, presets, a thin dispenser beam | F1, F2, section 6.3 |
| Dead Ringer fake deaths | they look like real deaths in the killfeed, kill counts and death markers | in scope | F5 killfeed and counts, F6 skips `RAG.FEIGN`, P1 `feign` flag |
| Sappers | the main way a spy affects an engineer | in scope | F2 |
| Spawn doors and setup gates | they show when a round really starts and where teams can walk | in scope | F6, M1 node fix |
| Health and ammo kits with respawn timers | HL fights are often about a medkit | in scope | F6 |
| Loadouts (Kritzkrieg, Dead Ringer, Gunboats, shields, Razorback) | they change how a player plays | in scope: `players.loadout` weapons and wearable weapons; shown in the player row tooltip | P1, F5 |
| Tug of war (tow_tetsudo, 2 local demos) | a community mode with its own scoring | in scope | P1 `pd`, F5, M1 boundary override |
| Respawn timers and waves | readable HL timing after a pick | in scope (per player); wave clocks later | F5 |
| Uber advantage and medigun type | the core HL read | in scope | F5 MedicPanel |
| Substitutes, disconnects, class swaps | common in pugs; today they switch the POV | in scope | S0 (actors keyed by entity id) |
| Long demos and memory | the median local demo is 1017 s, 30 run past 20 minutes, the longest is 2041 s | in scope: step 0.3 measurement, D18, X2 required, the measured memory plan | orchestrator, P1, S0, X2 |
| Tournament pauses | long gaps in a demo | later (`meta.pauses` exported) | F5 follow-up |
| Crit, headshot, backstab, domination and revenge icons | killfeed context | in scope | F5 |
| Building kills and captures in the killfeed | objective context | in scope | F5 |
| MEDIC! calls | shows who asked for heals | in scope | F1 nameplate tag |
| Teleporter use | glow in scope; entrance-to-exit pairing line later | in scope / later | F1, F2 |
| Wrangler laser and shield | engineer plays | in scope | F4 dots, F2 shield |
| Death markers | "where did our medic die" | in scope | F6 |
| Damage numbers and DPM | review value | later (`hurts` exported, setting `hud.damageNumbers` reserved) | F3 follow-up |
| Overtime, setup, KOTH unlock countdown, cart rollback warning, cappers | HUD basics | in scope | F5 |
| Humiliation crits after a round win | everyone on the winning team glows | in scope: `HL.CRIT_BONUS` uses the crit visuals at half opacity | F1 |
| Left-handed viewmodels | correct POV | in scope | F4 |
| Spectator mouse-look on Linux Chrome | broken on the user's Arch machine | in scope | F4 |
| "09:60" clock and TICK x2 | visible bugs | in scope | S0, F5 |
| Offline loading of models | player and projectile GLBs fetched the Draco decoder from gstatic | in scope | S0 (`public/draco/`, global decoder path) |
| Map versions newer than the converted BSP | silent geometry mismatch | partial | M1 notice |
| Third-person weapon models | the nameplate icon covers the read; a model in the hand would look better | later: reuse F4's placeholder builders at world scale | F1 follow-up |
| tow_tetsudo's HUD counters | `plhud.nut` writes push counters into the world bounds | later: could feed a tug-of-war HUD; today only overridden | F5 follow-up |
| Decals and signage (cap letters, arrows) | orientation | not in v1 | |
| Demos without `tv_transmitall` (other leagues) | missing local tables | in scope as graceful degradation | section 3.9 |
| Colour-blind friendly team colours | accessibility | later | |
| Shared links and saved setups reproduce views | users send ticks to each other | in scope (D12) | all |

---

## 10. Open questions and rejected review points

Review points rejected or adopted in a different form, one line each:

1. Vaccinator duration: the review said 2.5 s per charge, but the SDK applies the resist cond for
   `weapon_vaccinator_resist_duration` = 3 s (`tf_weapon_medigun.cpp:89, 1984-1990`), so MedicPanel uses 3 s from
   the cond onset.
2. Chase camera: adopted as a POV sub-mode (`pov.chase`, key `4`) instead of a fourth `ControlsMode`, because it
   reuses the POV subject, the `1` key cycling and the camera override, and adds no toolbar or store mode.
3. Stopwatch games: the review listed `roundsWon` as a candidate, but `m_iRoundsWon` has no writer in the SDK
   (`team.h:75` `IncrementRoundsWon` has no caller), so games come from `roundWin` with `STOPWATCH_WINNER`.
4. Nameplate fade: took the "ship 0 and let X1 decide" option rather than allowing the fade in the baseline, because a
   2500-unit fade hides names in the default RTS overview, where users identify players.
5. Projectile split: the review offered a kind list (0, 5, 7, 8, 9, 11 to 20) and a split by source; the contract draws
   by source and keeps the mapping table only as the logged expectation, because parser2's handling of cannonballs
   and practice stickies is unknown.
6. Disguise weapons: `m_bDisguiseWeapon` alone decides; the alternative check against `m_hMyWeapons` is not used,
   because one networked flag is simpler and the probe data confirms it.
7. Third-person weapon models in the hand (offered as optional): moved to section 9 as later work; the nameplate icon
   gives the read now.
8. Tagging koth_product's baked kit meshes in M1 (offered as "better still"): not required; the ring and wire box
   show the taken state on that one map.

Open questions that a task answers by measurement and records in its report:

| question | who | how |
|---|---|---|
| Which scoring element holds the match totals | P1 | section 2.6.4 rule on 1438891 |
| Does `STOPWATCH_WINNER` mark the deciding `roundWin` | F5 | 1433441 (section 5 F5) |
| How parser2 types cannonballs and Sticky Jumper stickies | F3 | `projectiles.source().mismatches` |
| Does the base viewer alone survive 1437285 and 1432698 | orchestrator | step 0.3 |
| The extras peak fit (`a`, `b`) and per-group sizes | P1 | section 2.8 |
| Which rare kinds have a demo at all | P1 | the survey |
| Whether a nameplate fade default helps | X1 | RTS and POV shots |

---

## 11. Amendments after the foundation merge (version 2.1)

S0, P1 and M1 are merged on `highlander`. These amendments are binding for every later task and override the text
above where they differ.

### 11.1 Accepted deviations

| # | from | amendment |
|---|---|---|
| A1 | S0 | `lerpField(t, field: ArrayLike<number>, key, tickF, maxGap)`: `field` accepts any numeric array (a strict superset of `F32`), so `capProgressAt` passes the U16 `cp.progress.p` without a cast. |
| A2 | S0 | `DEFAULT_ACTOR_FX` uses `modelClassId` 0 and `modelTeam` `''` as "the actor's base class and team". `Actors.tsx` resolves `fx.modelClassId \|\| classId` and `fx.modelTeam \|\| team`. F1 may return the frozen `DEFAULT_ACTOR_FX` while extras are not ready or Highlander is off, and must never mutate it. To draw no model, set `hidden: true`. |
| A3 | S0 | The `actors.registry` probe reports `modelVisible` (true drawn, false hidden, null not mounted) instead of `bodyVisible`. |
| A4 | S0 | `isFocusedPOV` with an override counts only a camera named `povCamera` under an `actor` group. F4's chase and death cameras must use other names and must not sit under actor groups. |
| A5 | P1 | `eyeZAt` returns null while `misc.obsMode != 0`, when the player has no local tables, and for `z < 20`. Callers fall back to `EYE_HEIGHT[class]` and the base duck bit. |
| A6 | P1 | `findTicks('capping')` returns crossings of capture progress 0.5. `findTicks('uber')` means a stock or unknown Medi Gun uber (Kritzkrieg, Quick-Fix and Vaccinator have their own kinds). |
| A7 | P1 | `available.carts` = train watchers exist AND (`cart.movers` or `cart.trains`). KOTH maps with static `func_tracktrain` brushes report false. Excluding `movers` in the memory plan also turns `carts` off. |
| A8 | P1 | Local-only tables. A player's local tables count as live once a delta changes one of his local props (or a local prop of one of his weapons). For players never marked live, the extras drop `view`, `ammo`, `scoring`, `itemCharge` and sniper entries (clip -1, chargeTick NaN, rage 0, stickies 0, desired disguise 0, fov rate 0, builder type 255). New getter `hasLocalTables(x, p)`: gate any displayed rage, sticky count, clip, ammo, scoring or charge-begin value on it. On old demos (the bundled 6v6) `available.view/ammo/scoring/itemCharge/sniper/builder` are false. All 133 local HL demos are live for every player who played a class. |
| A9 | P1 | Checker memory limit: `max(2.6 x file + 100, 140)` MB. The 6v6 sample measures 117 to 127 MB, which is fixed Node/V8 overhead, not extras data. |
| A10 | M1 | `scripts/convert-bsp.mjs --only-meta` also runs the render-export pass (brush bounds and the camera occlusion test need it); it still writes only `map-meta.json`. |
| A11 | M1 | Shared skies: the converter never silently replaces an existing sky folder whose pixels differ; a map's own faces go to `<sky>_<map>/` with `conversion.json skybox.folder`. |

### 11.2 Facts later tasks must use

- Extras access: `useExtras()` (React) or `useInstance.getState().extras` after checking `extrasStatus === 'ready'`
  (inside `useFrame`). Every position is already scene space. `p` is the base player id; use `playerIndexOf(x, entityId)`
  or `parsedDemo.playerIndexOfEntity`. Check `x.meta.available[key]` before drawing.
- Old demos (the 6v6 sample) have no `uberDeployed`, `capStart`, `medicDeath`, `deflect` or `hurts` events and no
  `fire`, `flames`, sniper charge or `itemCharge`. F5 falls back to `HL.UBER` edges for uber timing there.
- `RULES.MATCH_ENDED` is always set on serveme servers: never use it. `misc.obsTarget` stays stale after respawn: check
  `misc.obsMode`. `scoring.element` is 0 on every measured demo.
- `medigunAt` charge comes from the non-local table and is valid on old demos. `cloakMeterAt` is a shared prop and
  valid on old demos.
- `findTicks` kinds are not memoised; cache results per extras object.
- Map meta: `useMapMeta(map)` starts the fetch; `getLoadedMapMeta(map)` is the synchronous read for `useFrame` code
  (MapMeta, null when absent, undefined while unresolved). Never fetch per frame. Positions are raw Source: use
  `sourceToScene(p, parsedDemo.world.boundaryMin)`. On vigil, `payload[0].cart.brush.bspModelIndex` is 1.
- `useInstance().mapNodes` maps `bspModelIndex` to the brush-entity parent node. World replaces the nodes on every GLB
  reload, map change and `settings.scene.mode` change: subscribe to `mapNodes` and re-apply transforms.
  `userData.dribble` has `classname, targetname, parentname, team, bspModelIndex, entityIndex, origin, angles,
  localMins, localMaxs, hasGeometry, initiallyVisible, renderMode, startDisabled`.
- Map materials for M2: `applyBspMaterials(scene, { mode, lightmap, lightmapRange, brightness })` from
  `src/highlander/map/bspMaterials.ts` returns `setBrightness(b)` and `dispose()`. `isSharedMapMaterial(m)` marks
  module-level materials that must never be disposed. `MapConversion.files.props` and `props { pak, stock, stockSolid }`
  are typed in `src/utils/mapAssets.ts`. `convert-bsp.mjs` gates every write behind `!onlyMeta`; add the props pass
  after the `world.glb` write.
- Harness: actors move 2 to 5 frames after `goToTick`; `await window.__dribble.frames(5)` before reading scene nodes.
  The first plan step can run before player GLBs load (`modelVisible` null): poll in evals that check models.
  Cache tick = demo tick - 94 on 1434434 (probe reports use demo ticks).

### 11.3 F6 rule for render-mode-10 brushes (replaces the F6 "brush movers" visibility wording)

- `renderMode` 10 on any class other than `func_door`, `func_door_rotating`, `func_movelinear`, `func_tracktrain`,
  `func_train` or `func_rotating` stays hidden whatever `vis` says (they are invisible in game).
- Render-mode-10 mover nodes with geometry follow `vis` as the door stand-in.
- The slab rule applies only to door nodes with `hasGeometry === false`.
- Counts across the 10 GLBs: render-mode-10 `func_door` with geometry 77, `func_door_rotating` 12; without geometry
  `func_door` 4 and `func_tracktrain` 2 (tetsudo); render-mode-10 `func_brush` 5 and `func_respawnroomvisualizer` 4;
  StartDisabled `func_brush` toggles 131 (steel 127).

### 11.4 Demos for rare cases (from the P1 survey, `$S/p1/survey-highlights.json`)

stun: 1435000, 1443070, 1440442. Vaccinator uber: 1440001 (passive resist edges: 1442753). Gas Passer: 1439994.
Kritzkrieg: 1437285, 1440442, 1432698. Sapped: 1437285. Wrangler: 1433815, 1436154. Teleported: 1428628.
Syringe: 1441640. Energy ring: 1442739. Energy ball: 1429432. Fireball: 1442381. Cannonball: 1428628. Repair bolt:
1437285. Gas jar: 1439994. Deflects: 1436892. doorMove: 1434434, 1438891. Overtime: 1438891 at cache tick 52088.
No local demo has jarate (cond 24, kind 11), Mad Milk (27, kind 12), a Quick-Fix uber (28), Vaccinator blast or fire
ubers (59, 60), cleavers (14), stun balls (15) or Short Circuit orbs (20): tasks report those as unvalidated.

### 11.5 Orchestrator decisions

- The M1 static-props gate was not put to the user mid-run: the user chose "no game assets" up front, so stock props
  stay invisible, M2 renders the PAK props, and the final report shows the effect with screenshots.
- `1428628` and `1429417` are the tug-of-war demos; whether the base viewer loads `1429417` is recorded in the final
  report (the base parser binary is outside this contract, D2).

## 12. Amendments after the feature-wave merge (version 2.2)

F1 to F6, M2 and the extra task B1 (base-parse fallback) are merged on `highlander` at `0ac066d`; the parser's
`highlander` is at `96deea0`, which adds the wasm export `parse_demo_cache_fallback`. These amendments bind X1, X2,
P2, B2 and DOCS and override the text above where they differ. The final reports of wave 1 (APIs, deviations, data
facts, measurements) are in `$S/handoff/wave1.md`; read the parts your task touches.

### 12.1 Accepted deviations of wave 1

| task | accepted deviation |
|---|---|
| F1 | Tint priority tests `UBER_FADING` before `UBER` (the SDK keeps cond 5 while cond 8 is set). Flames: radius 13, cones r 5 h 24, outward lean 0.24 rad, a vertex-colour gradient with normal blending. Stun stars at z 64, radius 12 while nameplates are on (z 92 without). Drips at radius 14. |
| F1 | Marked for death: with Highlander plates the MARKED tag carries a skull glyph and no 3D skull is drawn; with plain plates the skull hangs below the plate, right of the head; without plates it sits at z 100 on a light disc. DECLOAK tag and ring need CLOAKED clear. The 0.6 plate dimming needs `players.cloak`. |
| F1 | `NameplateExtra.teamOverride`; a forced `'pov'` view without a POV subject falls back to `'true'`; the game-accurate hiding rules of the F1 report (no crit tint, aura, CRIT/MARKED tag or cloak bar on a spy drawn as his disguise, and so on); rage tags BANNER, MMMPH, FOCUS; probes `fx.plates` and `fx.frameCache`. |
| F2 | Sentry calibration fits on firing samples. The aim acceptance is "at least 80 % of attacking samples, excluding building, carried, upgrading, redeploying and wrangled entries, scored on the drawn, interpolated pose" (80.1 % on 1438891 and 1440442). `AIM_AT_ENEMY` stays false. |
| F2 | Status label: one 62 x 26 canvas quad centred about top + 18, kept 80 to 130 px wide on screen; in POV hidden for the POV subject's own buildings while the weapon HUD lists them, and faded between 300 and 120 units from the camera. Range ring: a 40-unit band (1060 to 1100) drawn on top at opacity 0.25. Dispenser beams at least 2 px at opacity 0.4. Destruction flash: an additive fireball sprite of at least 48 px (24 for sapper pops). Additions: carry badge, cap stripe, dispenser screen off while sapped or disabled, the sapper outside the construction scale. |
| F3 | Deviations 1 to 12 of the F3 report: detonated base projectiles are not drawn between hidden and deleted, but landed healing bolts are, until min(deleted, hidden + 3 s), at the wall or riding the hit player; airblast front ring; the POV owner's flames and airblast at 40 %; muzzle flashes from a gun-kind whitelist; the settings mapping; zero-extent flame boxes; minimum ribbon widths (1.5 px, tracers 1.2 px); soft glow shader; syringe needles 6 x 1.6 x 1.6 with a 0.06 s TEAM_FX streak; base healing-bolt trail in TEAM_TRAIL; `combat.fx` empty with Highlander off; sentry tracers start at F2's barrel tip. |
| F4 | Deviations 1 to 11 of the F4 report: `povFovAt` for the POV camera and scope (12.2 item 6); the scope is active for the whole ZOOMED interval; reload dip with a 7-degree lift; hand shapes; a view-space studio light; sniper-dot minimum sizes; the dead-POV killer comes only from the base death record; knife swings also on CUSTOM_GESTURE; builder HUD text; whole-clip reload timing; sentry kills aim the death camera at the engineer. |
| F5 | OVERTIME is hidden while WAITING_FOR_PLAYERS is set. MedicPanel: two lines (state word with value, "popped m:ss ago"; with two medics on a team, the name plus a U/K/Q/V chip). |
| F6 | (a) the textured koth_product and snakewater GLBs carry no field kits, so they get placeholders (baked detection kept); (b) resupply placeholders at the locker prop; (c) nodes with no alive instance are hidden; (d) kits rest on the analysed floor, M2 props included; (e) mid-air death markers drop to the floor below, ground deaths keep the origin, tick-0 ragdolls are skipped; (f) no slab for logic doors or 3D-skybox doors; (g) only `models/items/{medkit,ammopack}_*` kits on map spots are drawn (thrown and dropped items: P2); (h) one kit per spot, estimated rings never full, stale instances hidden; (i) the floor analysis skips brush-entity nodes. Tetsudo mover coverage 94.74 % is accepted (two static trigger_catapult brushes; coverage of changing movers is 100 %). |
| M2 | Rendered prop counts exclude 3D-skybox copies (vigil 88, proot 57, eruption 54 dynamic). Meshes per model, skin, sun cluster and lighting pattern, plus one merged batch with exact lighting. The alpha material rule of the M2 report. Untextured mode keeps the props' unlit textured material. Triangle order is reversed from the VTX order, and the converter fails the props pass below 90 % drawn-triangle winding agreement. |
| B1 | The fallback (parser2 first; a result with at most 1 tick or no players is parsed again by `parse_demo_cache_fallback` with the map's BSP bounds) and its AGENTS.md note, which DOCS keeps. |

### 12.2 Orchestrator decisions

1. Teammate-death camera, replacing F4's "anything else" row for this case: when the teammate a dead player spectates
   dies (IN_EYE with a dead target, and the tournament DEATHCAM fallback of `tf_player.cpp:13777-13786`), the POV
   shows a death camera at that teammate's death spot (his base position at his death tick - 1 plus his eye height)
   looking at his base killer (`latestDeath`), with the header "Spectating <teammate>". It ends at the next misc
   entry whose target is alive, or at the focused player's respawn. `PovSubject` gains an optional
   `deathOfEntityId`. X1 implements it.
2. Control points that wait on an earlier capture show their padlock: P2 exports `m_iPreviousPoints` and F5's
   `pointLockedAt` follows TF2's `TeamMayCapturePoint`.
3. Thrown lunchbox items and dropped kits move: P2 exports their motion and draws them in F6's pickups layer.
4. The plate rule becomes `(^|/)models/(items|workshop)/(.*/)?plate[^/]*\.mdl$`, and the chocolate, banana and
   fishcake plates are small health kits (P2).
5. `1428628`: parser2 starts 55.2 s after the demo start and leaves 56.6 s at the end without positions. B2 decides
   from data whether delayed starts go to the fallback.
6. Tickbase lead: SendPropTime values written during a player's user command (`m_flFOVTime`,
   `m_flChargeBeginTime`, `m_flInvisChangeCompleteTime`) run 3 to 4 ticks ahead of server time. Not fixed in the data;
   `povFovAt` stays; DOCS records it.
7. Performance target: section 5 X1 stands. Smoke runs at `0ac066d` with every setting on: 56 fps on 1438891 (50 %,
   RTS, 1x), 60 fps (vsync cap) on 1434434, 1440442 and 1429417; 0 console errors; page peaks 1.0 to 1.7 GB.

### 12.3 Facts later tasks must use

- Memory rule: no module-level variable may hold a parsed demo, an extras object or a store snapshot. Memoise in a
  WeakMap keyed by the extras object or the demo, or in an object owned by a mounted component. F1 (`FxFrameCache`),
  F2 (`buildingsAt`) and F5 (`getHudSnapshot`, `rosterAt`) follow it.
- Wave-1 APIs (details in `wave1.md`): F2 `sentryMuzzleAt`, `tracerBarrel`, `poseAimAt`, `povLabelContext`;
  F3 `setOwnMuzzleSource`, `ownMuzzleAt`, `boltLanding`, `landedPoseAt`, `getProjectileSource` (cached per extras
  and demo; it must run before the base projectile cache is released); F4 `getPovSubject`, `latestDeath`,
  `povFovAt`, `prepareViewmodelObject`, `vmShared.live.muzzleWorld` (`scene/viewmodel/shared.ts`), render orders
  (depth clear 1e6, viewmodel meshes 1e6 + 1, glows 1e6 + 2); F5 `getHudSnapshot` and the objective, scoreboard and
  killfeed model modules; F6 `SurfaceJob`, `useMapSurface`, `buildKitEntries`.
- Base caches: `positionScale` differs per cache (parser2 1024, fallback 32); read each cache's own value. On
  fallback demos `ticks` is the last written tick + 1, and `endTick`, `endDemoTick`, `shots` and `activeWeaponDef`
  are absent. `parsedDemo.parserFallback` and `parserFallbackInfo` describe the fallback.
- For X2: `Projectiles.tsx` in extras mode needs only `entityId`, `type` and `teamNumber` from the base list, and it
  draws a base entity in its landed phase (hidden <= tick < `landedEnd`), so the adapter keeps entities through
  [hidden, deleted). On 1429417 the fallback's projectile cache is 641 of 702 MB of base caches.
- `tempents.tracers.sx/sy/sz` is (999, 999, 999) on sentry tracers: start them at the drawn barrel.
- `players.medigun.charge` is stored as charge x 1000.
- Harness and disk: `/tmp` is a tmpfs with a per-user quota of about 5 GB shared by every agent, and it filled
  during wave 1 (EDQUOT). Put harness outputs, `TMPDIR` and large scratch files under
  `/home/dalibor/programming/personal/dribble.tf-wt/<task>-out/` (never directly in
  `/home/dalibor/programming/personal/`), and symlink them from `$S/shots/<task>-*` when useful. In zsh, write
  `--query a=b` literally (a variable holding it reaches shot.mjs as one argument). `reqfail net::ERR_ABORTED` lines
  on player GLBs are noise. In plans, a camera set by one step survives later steps and the perf pass. Run
  `flock $S/heavy.lock <command>` directly (a flock around `bash -c` trips a safety check).

### 12.4 Wave 2 and wave 3 tasks

Order: X1, P2 and B2 run in parallel (disjoint files); X2 starts after X1 and B2 are merged; DOCS runs last; a final
verification follows.

**X1 additions** (on top of section 5 X1):
- Extra files owned: a new folder `src/highlander/integration/`; integration edits in `src/highlander/combat/combatData.ts`
  and `combat/view.ts` (F3), `src/highlander/pov/subject.ts` and the POV and death-camera code in
  `src/highlander/scene/layers/PovLayer.tsx` and `src/highlander/hud/**/PovWeaponHud*` (F4),
  `src/highlander/players/fxSettings.ts` (F1), `src/highlander/buildings/model.ts` (F2, only when a measurement
  shows the cache thrashing between hudTick and renderTick), `src/highlander/map/mapMeta.ts` (M1),
  and `public/models/maps/koth_product_final/conversion.json` (only `files.meta`). `PanelToolbar` lives in
  `DemoViewer.tsx`, which X1 already owns. X1 must not touch P2's or B2's files.
- Wiring: F3's sentry tracers start at `sentryMuzzleAt(x, tracers.sentry[row], tracers.tick[row], tracerBarrel(x, row), out)`;
  F3's own-eyes hitscan tracers start at F4's viewmodel muzzle through `setOwnMuzzleSource`, gated on the POV
  subject; decision 12.2 item 1.
- `fetchMapMeta` skips the request when `conversion.json` has no `files.meta` (no 404 on textured maps such as the 6v6
  sample's snakewater); koth_product's `conversion.json` gets `files.meta: "map-meta.json"`.
- Cross-feature checks in the merged build, each with a screenshot and a probe: F1 uber shells and crit auras seen in
  POV with F4's depth clear; F2 labels against F4's viewmodel; F4's engineer panel rows and F5's building badges with
  F2's real data; F6 kit floors with M2 props on tetsudo, ashville and proot; sentry tracers leaving F2's drawn barrel;
  DOM nameplates against F2's canvas labels in crowded fights (decide and record).
- Audit `src/highlander/**` for the 12.3 memory rule and fix what it finds (any HL file, recorded per file).
- Performance: section 5 X1 numbers with every HL setting on, plus the same points with `highlander.enabled` false.
  When the base viewer alone misses 40 fps at a measured point, optimise the paths X1 owns first; if it still misses,
  report both numbers with a CPU profile that shows where the time goes.

**P2 parser data follow-ups** (owner: the parser repo, `src/libs/hlextras/*`, `src/highlander/extras/types.ts`,
`getters.ts`, `hydrate.ts`, `findTicks.ts`, the extras checker and expectations under `scripts/hl/`, F5's
`src/highlander/objectives/objectiveModel.ts` (`pointLockedAt` only), F6's `src/highlander/mapdyn/pickups.ts`,
`Pickups.tsx` and their probes). Parser branch `hl/p2` from the parser's `highlander` (`96deea0`): every hlextras
rebuild must keep `parse_demo_cache_fallback`.
1. Pickup motion: pickups whose origin changes after creation (thrown lunchbox items, dropped kits) get an xform track
   like drops; static pickups keep empty tracks. A getter returns the position at `tickF`.
2. The plate rule and sizes of 12.2 item 4.
3. `DT_BaseTeamObjectiveResource.m_iPreviousPoints` (8 points x 8 teams x 3 slots): exported for RED and BLU per point,
   as a track if any of the 133 demos changes it within a demo, else as static arrays (survey it). `pointLockedAt`
   then follows `CTFGameRules::TeamMayCapturePoint` (SDK): a point is locked for a team while any previous point of
   that team's list is not owned by the team.
4. F6 draws thrown and dropped health and ammo items along their motion and at rest, with the kit placeholder of their
   size, until they are deleted or picked up.
5. Unchanged groups stay byte-identical on 1434434 and the 6v6 sample; the checker and the 133-demo survey cover the
   new fields; the TS types change additively.

**B2 delayed-start fallback** (owner: `src/components/Analyse/Data/ParseWorker.ts` and `AsyncParser.ts` (the fallback
trigger only), `scripts/hl/parser2-survey.mjs` and new `scripts/hl/` checks): measure how late parser2 starts on every
local demo (start tick against the first demo packet). If routing demos that start late (threshold from the data;
1428628 starts 55.2 s late) to the fallback gives the whole timeline with correct positions, aligned extras and no
memory regression beyond 300 MB, add that routing; otherwise record the measurement and change nothing.

**X2**: section 5 X2, with the 12.3 facts.

**DOCS**: `AGENTS.md` (Highlander overview, settings, probes and the debug bridge, the harness, the converter with
`props.glb`, the base-parser fallback, known limits including stock props, decals, the tickbase lead and the rare
kinds without a local demo) and a new `specs/highlander/STATUS.md` (per contract task: what is implemented, the
acceptance state, accepted deviations, follow-ups from section 9's "later" rows). DOCS does not edit sections 0 to 12
of this contract.

## 13. Amendments after the wave-2 merge (version 2.3)

X1, P2 and B2 are merged on `highlander` at `ab4f613`; the parser's `highlander` is at `41fe9f3` (P2's extras
additions; `src/libs/hlextras` is rebuilt from it and still exports `parse_demo_cache_fallback`). These amendments
bind X2, DOCS and the final verification and override the text above where they differ. The wave-2 final reports are
in `$S/handoff/wave2-results.json` (per task: `impl`, `reviews`, `final`); read the parts your task touches.

### 13.1 Accepted deviations of wave 2

| task | accepted deviation |
|---|---|
| X1 | Nameplate declutter (`src/highlander/perf/nameplates.ts`): one pass per frame shows the 12 plates nearest the camera that are on screen, plus the focused player, the POV subject, the hovered player (the scene pointer over the player's screen hull or plate; a PlayerStatuses row does not count) and every pinned plate. A plate drawn at opacity 0 counts as not drawn. The cap is off with Highlander off. The rule thins by distance only, so tight far clusters can still stack plates. DOM plates stay drawn over F2's canvas labels (HTML cannot interleave with WebGL depth). The nameplate fade default stays 0 and `HUD_TICK_STEP` stays 3. |
| X1 | `fetchMapMeta` requests `map-meta.json` only when `conversion.json` lists `files.meta`. A folder whose `conversion.json` is absent (or answered with `index.html`) resolves to `null`, cached, without a request; only a failed request stays uncached and retries. `src/utils/mapAssets.ts` gains the additive export `isCachedMapConversion(map, request)`. |
| X1 | Not done: crit hitscan tracers look like normal ones under additive blending; sentry kills still aim the death camera at the engineer (F4 deviation); a player model's first appearance compiles its shader (one 120 to 133 ms long task, pre-existing). |
| P2 | Behaviour changes: (1) the 5CP HUD of the 6v6 sample padlocks the points behind the frontier; (2) the KOTH point shows a padlock while `WAITING_FOR_PLAYERS` is set (before the first round and in the post-game tail), as TF2 does; (3) a point whose first previous point is itself ignores `m_bCPLocked` (the SDK's early return); (4) thrown items rest on the bottom of their collision box and never bob or tilt, so on slopes the placeholder can hover a few units over the downhill side; (5) thrown items also draw on textured GLBs; (6) seen from a POV player's own eyes, a thrown item is hidden while its placeholder centre is within `POV_HIDE_DISTANCE` (40 units) of that camera; (7) probe additions of 13.2; (8) the `pickupTaken` definition of 13.2; (9) the checker's memory limit is A9's `max(2.6 x file + 100, 140)` MB. |
| P2 | Unvalidated for lack of a local demo: dropped kit-model items (Candy Cane, `DropHealthPack`, bottom offset 0) and the arena branch of `TeamMayCapturePoint` (the extras carry no `m_flCapturePointEnableTime`, so a stalemate counts as cappable). A disguised spy at full health who takes a thrown item fires no `item_pickup`, so that row has no taker. |
| B2 | (a) Delayed-start route: when parser2's timeline starts at least `DELAYED_START_FALLBACK_SECONDS` (5 s) after the tick of the demo's 100th frame, the file goes to B1's fallback (locally only 1428628, 55.2 s late). Like B1's route it ignores `settings.highlander.enabled`, so with Highlander off 1428628 loads from demo tick 94 with the fork's cache (`positionScale` 32) and rule 7.4 does not hold for that demo. (b) On 1428628 a moment's cache tick moves by +3678 against `fa3997b`: `?tick=` links and bookmarks saved before B2 point 55.2 s earlier, and tick-phase effects (F1's uber-fading blink) change phase. (c) When the fallback of a delayed start fails, parser2 parses the file once more (`{lateStart: true}`) and the demo loads with parser2's late timeline; `parsedDemo.parserFallbackFailure` records the error and `parserFallback` stays false. A failed no-timeline fallback, or a crash of the fallback worker itself (its file buffer was transferred), still fails the load. The progress shown continues from the previous pass and never falls back. |

### 13.2 Schema and API additions (binding text for the sections they extend)

- 2.5 and `types.ts`: `XPickups.xform` is an `XformTrack` holding the absolute transform of pickups whose transform
  changes after creation (thrown lunchbox items, dropped kits); static pickups have no entries. `XControlPoints`
  gains `prevRed` and `prevBlu` (I8, 24 entries = 8 points x 3 slots, index `point * 3 + slot`, -1 for none), `baseRed`
  and `baseBlu` (numbers, -1 for none) and `miniRounds` (boolean), all static per demo (the 133-demo survey found no
  change within a demo).
- 2.5.7: the plate rule `(^|/)models/(items|workshop)/(.*/)?plate[^/]*\.mdl$` is a medium health kit; the chocolate,
  banana and fishcake plates are small (size 0).
- 3.5: hydration also shifts `pickups.xform.x/y/z`.
- 3.7.2: `pickupMoves`, `pickupPositionAt(x, j, tickF, out, maxGap = snapshotInterval)`, `pickupRestTick`,
  `cpOwnerAt`, `previousPointsOf`, `farthestOwnedPointAt`, `teamMayCapturePointAt` (a port of
  `CTFGameRules::TeamMayCapturePoint`).
- 3.8 `pickupTaken`: rows `{tick, instance, player?, note?: 'thrown'}`. Deletions at a round restart and kits that
  leave for good are not takes; a thrown item deleted at an `item_pickup` event of its kind is a take (note
  `'thrown'`); `player` is set when exactly one `item_pickup` event matches the tick and kind.
- F5: `pointLockedAt(x, flags, owner, point?, tick?)` follows `CControlPointIcon::IsPointLocked` with
  `teamMayCapturePointAt`; without `point` or `tick` it keeps the old rule.
- F6: thrown and dropped items draw along their xform track and at rest with the kit placeholder of their size, until
  deleted or taken. Probes: `mapdyn.moving(tick?, floors?)` (new), moving rows in `mapdyn.pickups`
  (`{spot: null, moving: true, visible, nearPov}`), the skip reason `'moving'` in `mapdyn.kits`, `movingPickups` in
  `mapdyn.summary`.
- X1: `PovSubject.deathOfEntityId` marks the teammate-death camera (12.2 item 1): `entityId` and `p` are the dead
  teammate, camera `'deathcam'`, `deathTick` his death, `killerEntityId` his base killer (absent for world or
  suicide); `pov.state` reports it. `src/highlander/integration/ownMuzzle.ts` installs F4's viewmodel muzzle as F3's
  own-muzzle source while `PovLayer` is mounted; `SentryTracerFx.startFrom` is `'barrel'` or `'reach'`. Probes
  `nameplates.declutter` and `nameplates.cap(bool)` (reasons near, pinned, followed, hovered, capped, offscreen,
  notDrawn). `fxSettingsKey(settings)` caches up to 32 settings objects; the returned objects are shared and must not
  be mutated.
- B2: `ParseWorker.ts` exports `WARMUP_PACKETS`, `DELAYED_START_FALLBACK_SECONDS`, `demoWarmup(bytes)` and
  `delayedStartOf(result, bytes)`. Requests: `{buffer}`, `{buffer, fallback: ParserFallbackWork}`,
  `{buffer, lateStart: true}`; replies: `{progress}`, `{error}`, a `CachedDemo`, `{fallbackRequest, fileBuffer}`,
  `{fallbackFailed: {error}, fileBuffer}`. `parserFallbackInfo.trigger` is `'no-timeline'` or `'delayed-start'`.
  Bounds order for the fallback: the map's `OVERWRITE_MAP_BOUNDARIES` entry, else `conversion.json` `worldBounds`,
  else (after a delayed start) the world bounds parser2 read.

### 13.3 Facts for X2, DOCS and the final verification

- Settings reducer: `UPDATE_SETTINGS_OPTION` runs lodash `set()` on a shallow clone of the settings, so nested
  settings objects (`ui.crosshair`, `ui.nameplate`, `highlander.*`) keep their reference while their fields change.
  Never wrap a component in `memo` (or memoise on a reference) when it selects a nested settings object; select
  primitives, as `useHlSetting` does. `Crosshair` is deliberately not memoized in `DemoViewer.tsx`.
- `DemoViewer.tsx`: the render-path memo wrappers are module-level; the outline composer is `OutlineComposer({enabled})`;
  the projectile block reads only the current and the next tick, and `positionPrev`/`positionNext2` are aliases kept
  for the `InterpolatedProjectile` type.
- Both tetsudo demos now use the fallback cache: 1429417 (no timeline) and 1428628 (delayed start, starts at demo tick
  94, ends at its last packet). On 1429417 the fallback's projectile cache is 641 of 702 MB of base caches. Check
  1428628 in the browser (extras alignment 241 of 241) or with
  `flock $S/heavy.lock node scripts/hl/check-delayed-start.mjs <demo> --tmp <dir on disk>`, not with P2's native
  self-check (`scripts/hl/expect/1428628.json` uses parser2's start rule through `--options-from`). B1's
  `scripts/hl/fallback-values.mjs` and `check-fallback.mjs` still mirror only the no-timeline rule (a follow-up:
  call `delayedStartOf` there). `node scripts/hl/check-parse-routes.mjs <demo> [--fake-delay s] [--force-empty]
  [--fail-fallback string|throw|empty] [--expect route]` runs AsyncParser and ParseWorker end to end.
- Base parser2 limits (B2, unchanged): positions are offset by `m_WorldMins` at the cache start while the result
  reports the end-of-demo bounds (+1/32 unit in x on tetsudo, moot now); the timeline is sized by the header, so
  pauses and cut files leave empty tails (-9: 397 s, 1442402: 104 s, 1429425: 80 s, 1426663, 1422900).
- `findTicks('busiest')[0]` returns the earliest of the top windows, not the busiest one.
- Known out-of-scope cost: `src/pages/ViewerPage.tsx`'s `loadingDownloads` selector builds a new array on every store
  update, so ViewerPage (with DemoDrawing's forced layouts) re-renders every tick, about 2.4 % of main-thread time.
- Harness: an init script can be injected with B2's copy `/home/dalibor/programming/personal/dribble.tf-wt/b2-out/fix/shot-init.mjs`
  (env `B2_INIT_SCRIPT`). `reqfail ... textured_compressed.glb net::ERR_ABORTED` on the stubbed boot map is noise, like
  the player-GLB lines. Page memory "final" varies by about 120 MB between runs of the same code: compare peaks. To
  reach the default RTS camera in a plan, come from a POV step (`reset: true` does not restore it while the controls
  are already in RTS).
- Performance at the wave-2 merge (X1, every HL setting on / Highlander off): 1438891 21000 RTS 1x 58.0 / 60.0 fps;
  1433441 7939 RTS 1x 59.3 / 60.1 and 2x 59.1 / 60.0; paused 60.2; long demos 1437285 59.0 fps (peak 1566 MB) and
  1432698 59.9 fps (1570 MB). Browser PSS on 1438891 1249 MB with every setting on (pre-Highlander 1535 MB).

### 13.4 Wave 3 tasks

**X2** (section 5 X2 with the 12.3 and 13.3 facts), from `highlander` at `ab4f613`:
- Find every reader of the base projectile cache (`projectileCache`, `getProjectilesAtTick`, `ProjectileCache`
  methods) in the whole app, including analysis, drawing and export code. Route each through the adapter, or keep the
  cache for the session when a reader needs a field the adapter cannot serve, and record which.
- The adapter keeps entities through [hidden, deleted) (12.3), serves fallback caches as well as parser2 caches, and
  holds no module-level demo or extras reference (12.3 memory rule).
- Release only when extras are ready with `available.projectiles` true; with Highlander off, extras unavailable,
  `projectiles` excluded by the memory plan, or an extras error, the base cache stays and nothing changes.
- Once released, the adapter is the only projectile source for the rest of the session: toggling Highlander off at
  runtime, an extras restart or reload, or a later extras error must keep base projectiles drawn exactly as before.
  The adapter keeps what it needs in an object owned by the demo (WeakMap keyed by the demo, 12.3), not in the
  extras status.
- Acceptance: section 5 X2, plus identical projectile positions at one tick of 1429417 and of 1428628 (fallback
  caches), the memory drop measured on 1438891, 1429417 and one long demo, determinism after seeking, and the
  baseline plan.
- X2 may also fix the `ViewerPage.tsx` `loadingDownloads` selector of 13.3 (select a primitive or compare
  shallowly), measured before and after; nothing else in that file.

**DOCS** (12.4), from the same base, in parallel with X2: `AGENTS.md` and `specs/highlander/STATUS.md`, with B2's
fallback text, the `fetchMapMeta` rule, the settings-reducer gotcha, the 13.1 deviations and the 13.2 APIs. DOCS does
not edit sections 0 to 13 of this contract. After X2's review, DOCS adds X2's final state.

**Final verification**, on the merged tree: smoke on every local map and the 6v6 sample with Highlander on and off;
an adversarial review of the whole diff from `598e328` by dimension, each finding verified independently; a
completeness critic against sections 5 and 9 and the 12.4 and 13.4 task lists. Confirmed findings get fixed before
the final report.

## Appendix A. `src/highlander/extras/enums.ts`

```ts
export const COND = {
  AIMING: 0, ZOOMED: 1, DISGUISING: 2, DISGUISED: 3, STEALTHED: 4, INVULNERABLE: 5, TELEPORTED: 6, TAUNTING: 7,
  INVULNERABLE_WEARINGOFF: 8, STEALTHED_BLINK: 9, SELECTED_TO_TELEPORT: 10, CRITBOOSTED: 11, FEIGN_DEATH: 13,
  PHASE: 14, STUNNED: 15, OFFENSEBUFF: 16, SHIELD_CHARGE: 17, DEMO_BUFF: 18, ENERGY_BUFF: 19, RADIUSHEAL: 20,
  HEALTH_BUFF: 21, BURNING: 22, HEALTH_OVERHEALED: 23, URINE: 24, BLEEDING: 25, DEFENSEBUFF: 26, MAD_MILK: 27,
  MEGAHEAL: 28, REGENONDAMAGEBUFF: 29, MARKEDFORDEATH: 30, SPEED_BOOST: 32, CRITBOOSTED_PUMPKIN: 33,
  CRITBOOSTED_USER_BUFF: 34, CRITBOOSTED_DEMO_CHARGE: 35, SODAPOPPER_HYPE: 36, CRITBOOSTED_FIRST_BLOOD: 37,
  CRITBOOSTED_BONUS_TIME: 38, CRITBOOSTED_CTF_CAPTURE: 39, CRITBOOSTED_ON_KILL: 40, CANNOT_SWITCH_FROM_MELEE: 41,
  CRITBOOSTED_RAGE_BUFF: 44, DEFENSEBUFF_HIGH: 45, SNIPERCHARGE_RAGE_BUFF: 46, DISGUISE_WEARINGOFF: 47,
  MARKEDFORDEATH_SILENT: 48, INVULNERABLE_HIDE_UNLESS_DAMAGED: 51, INVULNERABLE_USER_BUFF: 52,
  CRITBOOSTED_CARD_EFFECT: 56, INVULNERABLE_CARD_EFFECT: 57, MEDIGUN_UBER_BULLET_RESIST: 58,
  MEDIGUN_UBER_BLAST_RESIST: 59, MEDIGUN_UBER_FIRE_RESIST: 60, MEDIGUN_SMALL_BULLET_RESIST: 61,
  MEDIGUN_SMALL_BLAST_RESIST: 62, MEDIGUN_SMALL_FIRE_RESIST: 63, STEALTHED_USER_BUFF: 64,
  STEALTHED_USER_BUFF_FADING: 66, FIRE_IMMUNE: 69, MINICRITBOOSTED_ON_KILL: 78, PARACHUTE_ACTIVE: 80,
  BLASTJUMPING: 81, AFTERBURN_IMMUNE: 102, CRITBOOSTED_RUNE_TEMP: 105, KNOCKED_INTO_AIR: 115, HEALING_DEBUFF: 118,
  PARACHUTE_DEPLOYED: 122, GAS: 123, BURNING_PYRO: 124, ROCKETPACK: 125, LOST_FOOTING: 126, AIR_CURRENT: 127,
} as const

/** HL flag bits (u32). Test with `(flags & HL.X) !== 0`; bit 31 makes the value negative in JS, which is fine. */
export const HL = {
  ZOOMED: 1 << 0, AIMING: 1 << 1, DISGUISING: 1 << 2, DISGUISED: 1 << 3, CLOAKED: 1 << 4, CLOAK_BLINK: 1 << 5,
  FEIGN: 1 << 6, UBER: 1 << 7, UBER_FADING: 1 << 8, SPAWN_PROTECT: 1 << 9, CRIT: 1 << 10, CRIT_BONUS: 1 << 11,
  MINICRIT: 1 << 12, QUICKFIX_UBER: 1 << 13, VACC_UBER: 1 << 14, VACC_PASSIVE: 1 << 15, OVERHEALED: 1 << 16,
  HEALED: 1 << 17, BURNING: 1 << 18, BLEEDING: 1 << 19, JARATED: 1 << 20, MILKED: 1 << 21, MARKED: 1 << 22,
  TELEPORTED: 1 << 23, ON_TELEPORTER: 1 << 24, TAUNTING: 1 << 25, BLAST_JUMPING: 1 << 26, SPEED_BOOST: 1 << 27,
  BONK: 1 << 28, STUNNED: 1 << 29, SOLDIER_BUFF: 1 << 30, SHIELD_CHARGE: 1 << 31,
} as const

/** Source conds of each HL bit (OR). Composites follow tf2-reference section 2.3. */
export const HL_SOURCES: Record<keyof typeof HL, number[]> = {
  ZOOMED: [1], AIMING: [0], DISGUISING: [2], DISGUISED: [3], CLOAKED: [4, 64, 66], CLOAK_BLINK: [9], FEIGN: [13],
  UBER: [5, 52, 57], UBER_FADING: [8], SPAWN_PROTECT: [51],
  CRIT: [11, 33, 34, 35, 37, 39, 40, 44, 56, 105], CRIT_BONUS: [38], MINICRIT: [16, 19, 78],
  QUICKFIX_UBER: [28], VACC_UBER: [58, 59, 60], VACC_PASSIVE: [61, 62, 63], OVERHEALED: [23], HEALED: [21],
  BURNING: [22, 124], BLEEDING: [25], JARATED: [24], MILKED: [27], MARKED: [30, 48], TELEPORTED: [6],
  ON_TELEPORTER: [10], TAUNTING: [7], BLAST_JUMPING: [81], SPEED_BOOST: [32], BONK: [14], STUNNED: [15],
  SOLDIER_BUFF: [16, 26, 29, 45], SHIELD_CHARGE: [17],
}

export function condSet(w0: number, w1: number, w2: number, w3: number, w4: number, cond: number): boolean {
  const w = cond < 32 ? w0 : cond < 64 ? w1 : cond < 96 ? w2 : cond < 128 ? w3 : w4
  return ((w >>> (cond & 31)) & 1) === 1
}

export function deriveFlags(w0: number, w1: number, w2: number, w3: number, w4: number): number {
  let f = 0
  for (const key in HL_SOURCES) {
    const conds = HL_SOURCES[key as keyof typeof HL]
    for (let i = 0; i < conds.length; i++) {
      if (condSet(w0, w1, w2, w3, w4, conds[i])) { f |= HL[key as keyof typeof HL]; break }
    }
  }
  return f >>> 0
}

export const BLD = { BUILDING: 1 << 0, SAPPED: 1 << 1, DISABLED: 1 << 2, CARRY_DEPLOY: 1 << 3, WRANGLED: 1 << 4, SHIELD: 1 << 5, PLASMA: 1 << 6, DORMANT: 1 << 7, UPGRADING: 1 << 8 } as const
// sources: m_bBuilding, m_bHasSapper, m_bDisabled, m_bCarryDeploy, m_bPlayerControlled, m_nShieldLevel > 0,
// m_bPlasmaDisable, entity left the PVS, (sentry m_iState 3 | dispenser m_iState 1 | teleporter m_iState 7)
export const BUILDING_TYPE = { DISPENSER: 0, TELEPORTER: 1, SENTRY: 2, SAPPER: 3 } as const
export const SENTRY_STATE = { INACTIVE: 0, SEARCHING: 1, ATTACKING: 2, UPGRADING: 3 } as const
export const TELE_STATE = { BUILDING: 0, IDLE: 1, READY: 2, SENDING: 3, RECEIVING: 4, RECEIVING_RELEASE: 5, RECHARGING: 6, UPGRADING: 7 } as const

export const RULES = { IN_SETUP: 1 << 0, IN_OVERTIME: 1 << 1, WAITING_FOR_PLAYERS: 1 << 2, STOPWATCH: 1 << 3, STOPWATCH_WINNER: 1 << 4, SWITCHED_TEAMS_THIS_ROUND: 1 << 5, TEAMS_SWITCHED: 1 << 6, AWAITING_READY_RESTART: 1 << 7, MATCH_ENDED: 1 << 8, PLAYING_KOTH: 1 << 9 } as const
// sources: m_bInSetup, m_bInOvertime, m_bInWaitingForPlayers, m_bStopWatch, m_bStopWatchWinner,
// m_bSwitchedTeamsThisRound, m_bTeamsSwitched, m_bAwaitingReadyRestart, m_bMatchEnded, m_bPlayingKoth
export const ROUND_STATE = { INIT: 0, PREGAME: 1, STARTGAME: 2, PREROUND: 3, RUNNING: 4, TEAM_WIN: 5, RESTART: 6, STALEMATE: 7, GAME_OVER: 8, BONUS: 9, BETWEEN_ROUNDS: 10 } as const

export const TIMER = { DISABLED: 1 << 0, SHOW_IN_HUD: 1 << 1, STOPWATCH: 1 << 2, CAPTURE_WATCH: 1 << 3, SHOW_TIME_REMAINING: 1 << 4, AUTO_COUNTDOWN: 1 << 5, START_PAUSED: 1 << 6 } as const
// sources: m_bIsDisabled, m_bShowInHUD, m_bStopWatchTimer, m_bInCaptureWatchState, m_bShowTimeRemaining,
// m_bAutoCountdown, m_bStartPaused

export const CPF = { BLOCKED: 1 << 0, LOCKED: 1 << 1, RED_CAN_CAP: 1 << 2, BLU_CAN_CAP: 1 << 3, VISIBLE: 1 << 4 } as const
// sources: m_bBlocked[i], m_bCPLocked[i], m_bTeamCanCap[16 + i], m_bTeamCanCap[24 + i], m_bCPIsVisible[i]

export const RAG = { GIB: 1 << 0, BURNING: 1 << 1, FEIGN: 1 << 2, ICE: 1 << 3, ON_GROUND: 1 << 4, CLOAKED: 1 << 5, ASH: 1 << 6, ELECTROCUTED: 1 << 7, GOLD: 1 << 8 } as const
// sources: m_bGib, m_bBurning, m_bFeignDeath, m_bIceRagdoll, m_bOnGround, m_bCloaked, m_bBecomeAsh,
// m_bElectrocuted, m_bGoldRagdoll

export const PROJ = { UNKNOWN: 0, ROCKET: 1, PIPE: 2, STICKY: 3, PRACTICE_STICKY: 4, CANNONBALL: 5, SENTRY_ROCKET: 6, FLARE: 7, ARROW: 8, REPAIR_BOLT: 9, HEALING_BOLT: 10, JARATE: 11, MILK: 12, GAS: 13, CLEAVER: 14, STUN_BALL: 15, ORNAMENT: 16, ENERGY_RING: 17, ENERGY_BALL: 18, FIREBALL: 19, MECH_ORB: 20, SYRINGE: 21 } as const
/** Expected extras kinds per base cache type (section 2.5.4). Drawing uses the source split, not this table. */
export const BASE_TYPE_KINDS: Record<number, number[]> = { 1: [1, 6], 2: [2], 3: [3, 4], 4: [10] }
export const OBS_MODE = { NONE: 0, DEATHCAM: 1, FREEZECAM: 2, FIXED: 3, IN_EYE: 4, CHASE: 5, POI: 6, ROAMING: 7 } as const   // shareddefs.h:493-500
export const STOPWATCH_STATE = { NOT_SET: 0, RUNNING: 1, OVERTIME: 2 } as const                                            // tf_gamerules.h:142-144
export const TEAM_ROLE = { NONE: 0, DEFENDERS: 1, ATTACKERS: 2 } as const                                                 // tf_shareddefs.h:74-76
export const MINIGUN_STATE = { IDLE: 0, STARTFIRING: 1, FIRING: 2, SPINNING: 3, DRYFIRE: 4 } as const                     // tf_weapon_minigun.h:30-34
export const FLAME_STATE = { IDLE: 0, STARTFIRING: 1, FIRING: 2, SECONDARY: 3 } as const                                 // tf_weapon_flamethrower.h:34-37
export const VACC_RESIST = { BULLET: 0, BLAST: 1, FIRE: 2 } as const
/** WinReason, index = roundWin.winReason (teamplayroundbased_gamerules.h:84-101). */
export const WIN_REASON = [
  'NONE', 'ALL_POINTS_CAPTURED', 'OPPONENTS_DEAD', 'FLAG_CAPTURE_LIMIT', 'DEFEND_UNTIL_TIME_LIMIT', 'STALEMATE',
  'TIMELIMIT', 'WINLIMIT', 'WINDIFFLIMIT', 'RD_REACTOR_CAPTURED', 'RD_CORES_COLLECTED', 'RD_REACTOR_RETURNED',
  'PD_POINTS', 'SCORED', 'STOPWATCH_WATCHING_ROUNDS', 'STOPWATCH_WATCHING_FINAL_ROUND', 'STOPWATCH_PLAYING_ROUNDS',
] as const
export const MOVER = { DOOR: 0, ROTATING: 1, TRACK_TRAIN: 2, BRUSH: 3, PHYS_PROP: 4, DYNAMIC_PROP: 5 } as const
export const PICKUP = { HEALTH: 0, AMMO: 1, SMALL: 0, MEDIUM: 1, LARGE: 2 } as const
export const DROP = { AMMO_PACK: 0, GIB: 1, WEAPON: 2 } as const
export const ENEMY = { NONE: 0, PLAYER: 1, BUILDING: 2, OTHER: 3 } as const
export const DEATH_FLAG = { DOMINATION: 0x1, ASSISTER_DOMINATION: 0x2, REVENGE: 0x4, ASSISTER_REVENGE: 0x8, FIRST_BLOOD: 0x10, FEIGN_DEATH: 0x20, INTERRUPTED: 0x40, GIBBED: 0x80, PURGATORY: 0x100, MINIBOSS: 0x200, AUSTRALIUM: 0x400 } as const

/** ETFWeaponType, index = m_iWeaponID (TEFireBullets, TETFExplosion, player_hurt weaponid). */
export const TF_WEAPON_ID = [
  'NONE', 'BAT', 'BAT_WOOD', 'BOTTLE', 'FIREAXE', 'CLUB', 'CROWBAR', 'KNIFE', 'FISTS', 'SHOVEL', 'WRENCH', 'BONESAW',
  'SHOTGUN_PRIMARY', 'SHOTGUN_SOLDIER', 'SHOTGUN_HWG', 'SHOTGUN_PYRO', 'SCATTERGUN', 'SNIPERRIFLE', 'MINIGUN', 'SMG',
  'SYRINGEGUN_MEDIC', 'TRANQ', 'ROCKETLAUNCHER', 'GRENADELAUNCHER', 'PIPEBOMBLAUNCHER', 'FLAMETHROWER',
  'GRENADE_NORMAL', 'GRENADE_CONCUSSION', 'GRENADE_NAIL', 'GRENADE_MIRV', 'GRENADE_MIRV_DEMOMAN', 'GRENADE_NAPALM',
  'GRENADE_GAS', 'GRENADE_EMP', 'GRENADE_CALTROP', 'GRENADE_PIPEBOMB', 'GRENADE_SMOKE_BOMB', 'GRENADE_HEAL',
  'GRENADE_STUNBALL', 'GRENADE_JAR', 'GRENADE_JAR_MILK', 'PISTOL', 'PISTOL_SCOUT', 'REVOLVER', 'NAILGUN', 'PDA',
  'PDA_ENGINEER_BUILD', 'PDA_ENGINEER_DESTROY', 'PDA_SPY', 'BUILDER', 'MEDIGUN', 'GRENADE_MIRVBOMB',
  'FLAMETHROWER_ROCKET', 'GRENADE_DEMOMAN', 'SENTRY_BULLET', 'SENTRY_ROCKET', 'DISPENSER', 'INVIS', 'FLAREGUN',
  'LUNCHBOX', 'JAR', 'COMPOUND_BOW', 'BUFF_ITEM', 'PUMPKIN_BOMB', 'SWORD', 'ROCKETLAUNCHER_DIRECTHIT', 'LIFELINE',
  'LASER_POINTER', 'DISPENSER_GUN', 'SENTRY_REVENGE', 'JAR_MILK', 'HANDGUN_SCOUT_PRIMARY', 'BAT_FISH', 'CROSSBOW',
  'STICKBOMB', 'HANDGUN_SCOUT_SECONDARY', 'SODA_POPPER', 'SNIPERRIFLE_DECAP', 'RAYGUN', 'PARTICLE_CANNON',
  'MECHANICAL_ARM', 'DRG_POMSON', 'BAT_GIFTWRAP', 'GRENADE_ORNAMENT_BALL', 'FLAREGUN_REVENGE',
  'PEP_BRAWLER_BLASTER', 'CLEAVER', 'GRENADE_CLEAVER', 'STICKY_BALL_LAUNCHER', 'GRENADE_STICKY_BALL',
  'SHOTGUN_BUILDING_RESCUE', 'CANNON', 'THROWABLE', 'GRENADE_THROWABLE', 'PDA_SPY_BUILD', 'GRENADE_WATERBALLOON',
  'HARVESTER_SAW', 'SPELLBOOK', 'SPELLBOOK_PROJECTILE', 'SNIPERRIFLE_CLASSIC', 'PARACHUTE', 'GRAPPLINGHOOK',
  'PASSTIME_GUN', 'CHARGED_SMG', 'BREAKABLE_SIGN', 'ROCKETPACK', 'SLAP', 'JAR_GAS', 'GRENADE_JAR_GAS', 'FLAME_BALL',
] as const

/** PlayerAnimEvent_t, index = m_iEvent. */
export const ANIM_EVENT = [
  'ATTACK_PRIMARY', 'ATTACK_SECONDARY', 'ATTACK_GRENADE', 'RELOAD', 'RELOAD_LOOP', 'RELOAD_END', 'JUMP', 'SWIM',
  'DIE', 'FLINCH_CHEST', 'FLINCH_HEAD', 'FLINCH_LEFTARM', 'FLINCH_RIGHTARM', 'FLINCH_LEFTLEG', 'FLINCH_RIGHTLEG',
  'DOUBLEJUMP', 'CANCEL', 'SPAWN', 'SNAP_YAW', 'CUSTOM', 'CUSTOM_GESTURE', 'CUSTOM_SEQUENCE',
  'CUSTOM_GESTURE_SEQUENCE', 'ATTACK_PRE', 'ATTACK_POST', 'GRENADE1_DRAW', 'GRENADE2_DRAW', 'GRENADE1_THROW',
  'GRENADE2_THROW', 'VOICE_COMMAND_GESTURE', 'DOUBLEJUMP_CROUCH', 'STUN_BEGIN', 'STUN_MIDDLE', 'STUN_END',
  'PASSTIME_THROW_BEGIN', 'PASSTIME_THROW_MIDDLE', 'PASSTIME_THROW_END', 'CYOAPDA_BEGIN', 'CYOAPDA_MIDDLE',
  'CYOAPDA_END', 'ATTACK_PRIMARY_SUPER',
] as const
```

## Appendix B. Math

B.1 Source `AngleQuaternion` (`mathlib`), angles in degrees (pitch, yaw, roll); the Rust side uses it for every
`xform` quaternion:

```ts
const sy = Math.sin(yaw * DEG / 2), cy = Math.cos(yaw * DEG / 2)
const sp = Math.sin(pitch * DEG / 2), cp = Math.cos(pitch * DEG / 2)
const sr = Math.sin(roll * DEG / 2), cr = Math.cos(roll * DEG / 2)
qx = sr * cp * cy - cr * sp * sy
qy = cr * sp * cy + sr * cp * sy
qz = cr * cp * sy - sr * sp * cy
qw = cr * cp * cy + sr * sp * sy
```

B.2 Scene transform to a GLB brush node (`src/highlander/map/mapNodes.ts`):

```ts
const C = new THREE.Matrix4().makeRotationX(-Math.PI / 2)     // Source -> glTF axes: (x, y, z) -> (x, z, -y)
const C_INV = new THREE.Matrix4().makeRotationX(Math.PI / 2)
const ONE = new THREE.Vector3(1, 1, 1)
export function sceneXformToNode(node: THREE.Object3D, scenePos: THREE.Vector3, quat: THREE.Quaternion, origin: { x: number; y: number; z: number }) {
  const source = new THREE.Matrix4().compose(new THREE.Vector3(scenePos.x + origin.x, scenePos.y + origin.y, scenePos.z + origin.z), quat, ONE)
  node.matrix.copy(C).multiply(source).multiply(C_INV)
  node.matrixAutoUpdate = false
  node.matrixWorldNeedsUpdate = true
  node.updateMatrixWorld(true)
}
```

Brush-entity nodes are direct children of the GLB root, so this matrix is relative to the root, which sits in
glTF space under the rotated `world` group.

B.3 `SimpleSpline(s) = s * s * (3 - 2 * s)`.

B.4 Source view vectors for pitch p and yaw y (roll 0, degrees, pitch positive looks down):
`forward = (cos p cos y, cos p sin y, -sin p)`, `right = (sin y, -cos y, 0)`, `up = (sin p cos y, sin p sin y, cos p)`.

B.5 Fixed weapon spread (`tf_fx_shared.cpp:112-124, 315-337`, active because serveme sets
`tf_use_fixed_weaponspreads 1`), for buckshot weapons with fewer than 15 pellets:

```ts
const FIXED_SPREAD = [[0, 0], [1, 0], [-1, 0], [0, -1], [0, 1], [0.85, -0.85], [0.85, 0.85], [-0.85, -0.85], [-0.85, 0.85], [0, 0]]
// pellet i: [x, y] = FIXED_SPREAD[i % 10] scaled by 0.5; dir = normalize(forward + x * spread * right + y * spread * up)
```

B.6 Deterministic noise for flicker and debris: `hash(n) = fract(sin(n * 12.9898) * 43758.5453)`.
