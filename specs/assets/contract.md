# Asset-phase contract

Version 1.0, 2026-11-02. Branch `assets` starts at `highlander` `a06e4c7` (Highlander contract v2.5). This file binds
every asset-phase task after C0. It extends `specs/highlander/contract.md`. Where the two disagree on game assets,
this file wins; everything else in the Highlander contract and in `AGENTS.md` still holds (build, tsc, harness, lock,
`/tmp` quota, GPU disposal, D12 determinism, the memory rule of Highlander contract 12.3, the settings reducer).

Sources: `WT/assets-research-out/plan.md`, `$S/asset-critique.md` (which corrects the plan; this contract follows
the critique) and `$S/asset-research.json`. Numbers marked (est.) are estimates; the others were measured.

Abbreviations:

- `S` = `/tmp/claude-1000/-home-dalibor-programming-personal-dribble-tf/bbe6eb71-192d-40ae-b6da-70834234db27/scratchpad`
- `LOCK` = `$S/heavy.lock`
- `REPO` = `/home/dalibor/programming/personal/dribble.tf` (main checkout, branch `highlander`, never touched)
- `WT` = `/home/dalibor/programming/personal/dribble.tf-wt`
- `BSP2GLB` = `/home/dalibor/programming/personal/bsp-to-glb` (main checkout on branch `dribble`, never touched)
- `VPK` = `/home/dalibor/tf2-assets/tf` and `/home/dalibor/tf2-assets/hl2` (`tf2_textures_*`, `tf2_misc_*`,
  `hl2_textures_*`, `hl2_misc_*`)
- `PACK` = `/home/dalibor/tf2-pack` (experiments: `/home/dalibor/tf2-pack-<task>`)
- `BSPS` = `~/.local/share/Steam/steamapps/common/Team Fortress 2/tf/maps/`

How to use it: every task in section 9 lists the files it owns and edits nothing else. If it needs another file, it
stops and asks the orchestrator. Names, paths, settings keys, defaults, probe names and manifest fields written here
are fixed. A task may add optional fields and new files inside its own folders.

---

## 1. Decisions

| # | topic | decision |
|---|---|---|
| D19 | distribution | Local pack only. `scripts/assets/` converts the user's own VPKs into a pack directory outside every repo (`PACK`). `npm run dev`, `vite preview` and the harness serve it. A production build makes no pack request unless `VITE_ASSET_PACK_URL` was set when it was built. No Valve asset, and no number copied out of a Valve model, is ever committed. |
| D20 | toolchain and formats | No new installs: no basisu, toktx, Blender or Python packages. Tools are the patched bsp-to-glb (`--studio-*`, `--material-mount-plan`, `vtf-to-png`), `node_modules` (gltf-transform 4.3, meshoptimizer, sharp) and python3 stdlib. Stock props are flat albedo x VHV lighting now. Textures come later as DDS sidecars rewrapped from VTF DXT data, with a WebP sidecar fallback. KTX2 is out until hosting is decided. |
| D21 | fallback | The rule of section 5. With no pack the site is identical to `a06e4c7` by construction, and a test proves it. |
| D22 | order | Stock static props first (wave 1), then textured maps and world models, then viewmodels (section 10). |

### 1.1 Amended Highlander decisions

- **D1, replaced.** "This phase adds no Valve assets to git or to the default deploy; pre-existing upstream files
  are unchanged." Those pre-existing files are the 18 player GLBs, the rocket, pipe and sticky models, about 270 MB
  of upstream textured maps and the 257 kill icons. Real TF2 content beyond them appears only from a local pack the
  user built. Data embedded in the BSPs (lightmaps, PAK props, PAK skies) stays allowed in `public/`, as before.
- **D5, amended.** `koth_product_final` is excluded from map packs. It keeps its upstream `textured_compressed.glb`,
  has no `mapNodes`, and with Highlander off it is the base viewer's map. The pack builder refuses it with exit 2.
- **D7, amended.** Stock static props draw from the pack (`props-stock.glb`). PAK props stay in `public/` `props.glb`.
- **D8, amended.** A later GLB viewmodel provider at priority 10 reads the pack. The placeholder stays the fallback.
- **D12, extended.** Everything drawn is a pure function of (extras, base caches, `renderTick`, `frameProgress`,
  settings, pack state). Pack state is the manifest plus the set of items that finished loading. Animations of pack
  models use `AnimationMixer.setTime` from tick arithmetic, never clock deltas. Seeking to the same tick twice gives
  identical probe output once `assets.waitIdle()` has resolved.
- **D15, unchanged.** No dependency is added, `yarn.lock` stays as it is, and no root `package-lock.json` appears.

### 1.2 Legal note

This reads public documents and is not legal advice. The Steam Subscriber Agreement (SSA) section 2.A licenses Valve
content for personal, non-commercial use, and section 2.G forbids distributing derivative works without Valve's
written consent. The Steamworks FAQ answer "TF2 mods can only redistribute their own game files, and load TF2 content
from a local install" is guidance, not a licence. A local pack built from the user's own install is the closest fit.

- The pack is for personal use. `scripts/assets/README.md` says so in its first paragraph.
- Hosting a pack means distributing it. That is a separate, explicit decision of the user, recorded in a later
  contract version. It never happens through a default. No committed file sets `VITE_ASSET_PACK_URL`:
  `netlify.toml`, `vercel.json`, `.env*`, `package.json` scripts and CI files stay free of it.
- Committed code may not contain values copied from Valve models or textures: attachment offsets, bone positions,
  pose ranges, calibration blocks fitted to a model, albedo tables, expectation JSON with model values. Runtime code
  reads them from the pack. Aggregate measurements in docs (sizes, counts, timings) are allowed.
- Screenshots, harness outputs and build caches that show pack content stay in `WT/<task>-out/`. They are never
  committed or attached to docs.

---

## 2. The pack

### 2.1 Location and build

- Default output `PACK`. The builder refuses an `--out` inside any git work tree (it runs `git rev-parse` there) and
  any path under `/tmp`.
- Command: `npm run assets:build -- --tf2 /home/dalibor/tf2-assets/tf --hl2 /home/dalibor/tf2-assets/hl2 --out <dir>
  [--stages maps,models,viewmodels] [--maps <folder,...|all>] [--bsp-dir <BSPS>] [--tmp <dir on disk>] [--force]`.
  `package.json` gains exactly one line, `"assets:build": "node scripts/assets/build-pack.mjs"`.
- Heavy builds run under `flock LOCK`. `--tmp` defaults to `<out>/.tmp`, never `/tmp`.
- Writes are atomic per file (`.partial` then rename). `manifest.json` is written last. A failed or interrupted build
  leaves the previous `manifest.json` and the files it lists working, and prints which stage failed.
- Incremental: a stage skips an item whose input key (VPK fingerprint, BSP sha256, generator version, options) equals
  the recorded one. `--force` rebuilds everything.

### 2.2 Layout

```
<pack>/
  manifest.json                         v1, section 2.3
  maps/<folder>/props-stock.glb         wave 1 (M3-props)
  maps/<folder>/{conversion.json, world.glb, lightmap.webp, overlays.glb}   later, phase 2
  models/<source path minus .mdl>.glb   later, e.g. models/buildables/sentry1.glb
  textures/<source path minus .vtf>.dds and .webp   later, e.g. textures/models/buildables/sentry1.dds
  reports/<stage>/<name>.json           build stats, not read at runtime
```

`<folder>` is a `public/models/maps/` folder name that `MAP_NAME_SEARCH_MAP` points at. Source paths are lower case
with forward slashes.

### 2.3 `manifest.json` v1

```jsonc
{
  "format": "dribble-asset-pack",
  "version": 1,
  "generator": { "version": "1.0.0", "commit": "<git sha of the checkout or null>" },
  "builtFrom": {
    "vpks": [{ "file": "tf/tf2_misc_dir.vpk", "bytes": 0, "treeCrc32": "8 hex", "archives": 28, "archiveBytes": 0 }],
    "fingerprint": "sha256 hex of the canonical JSON of vpks"
  },
  "options": { },                         // the options that change output, canonical key order
  "maps": {
    "<folder>": {
      "mapName": "pl_vigil_rc10",          // equals public conversion.json mapName
      "bspSha256": "hex", "bspBytes": 0,
      "publicProps": { "pak": 88, "stock": 1428, "stockSolid": 409 }, // copy of public conversion.json props
      "files": { "propsStock": "maps/pl_vigil_rc10/props-stock.glb" },
      "sizes": { "propsStock": 0 },
      "stats": { }                         // instances, models, excluded models, triangles, ms
    }
  },
  "items": {
    "<source path>": { "kind": "model | texture", "file": "<pack path>", "bytes": 0, "sha256": "hex" }
  }
}
```

- No timestamps and no absolute paths, so equal inputs can give an equal manifest.
- `version` other than 1, or `format` other than `"dribble-asset-pack"`, makes the runtime status `error`.
- The VPK fingerprint uses file sizes, the directory tree CRC32, archive count and total archive bytes, never mtimes.
- Every file the runtime may request appears in the manifest. The runtime requests nothing else.

### 2.4 Determinism

Test it, do not assume it. A0-pack ships `scripts/assets/check-determinism.mjs <packA> <packB>`, which compares
file lists and sha256 and exits 1 with the differing files. Each stage task builds its output twice into two
directories and reports the result.

- When the difference comes from our code (ordering, maps iterated by insertion of async results, floats printed
  differently), the task fixes it. Byte identity is then binding for that stage.
- When it comes from a tool (bsp-to-glb, meshopt, sharp), the task records the tool and the files in its report and
  the orchestrator records it in section 11. For that stage, identity of rendered output (compare-runs exit 0
  between the two packs) replaces byte identity.

### 2.5 Formats

- **Wave 1, stock props.** One `props-stock.glb` per map, built by the same code path as `props.glb`
  (`scripts/lib/static-props.mjs`): `EXT_mesh_gpu_instancing`, meshopt, vertex colour = flat albedo x VHV lighting.
  Albedo is the VTF reflectivity of the material's `$basetexture`, as for PAK props. No images.
- **Later, textures.** Each VTF becomes `textures/<path>.dds` and, optionally, `textures/<path>.webp`.
  - DXT1 and DXT5 are rewrapped as DDS without re-encoding (measured pixel-identical). The full VTF mip chain is
    kept and reversed to DDS order. A cap drops the top mips (no re-encode). three cannot generate mips for
    compressed textures, so a VTF without mips gets `minFilter = LinearFilter`.
  - BGRA8888, BGR888 and RGBA8888 become WebP only. UV88, RGBA16161616F, format 9 and BGRX8888 are unsupported; the
    material then draws its flat albedo. Animated VTFs export frame 0, and the manifest item says `frames: n`.
  - The item records `srgb`, `oneBitAlpha` (VTF flag `ONEBITALPHA`), `alpha: "opaque" | "test" | "blend"`,
    `alphaCutoff`, `width`, `height`, `mips`.
  - GLTFLoader in three 0.163 cannot load DDS (`setDDSLoader` only logs that `MSFT_texture_dds` is unsupported). So
    no GLB embeds or references textures. A material carries `extras.dribble.texture = { key, uv }` and a runtime
    binding step (section 4.6) loads the sidecar and assigns it before the object first draws. WebP uses the same
    sidecar path, so there is one binding path for both formats.
- **Later, models.** LOD0 only, unused clips removed, plain `gltf-transform meshopt` (never the full `optimize`, which
  drops TEXCOORD_0 and LODs), empty `mesh.weights` removed. Attachments, sequences, skins, bodygroups and pose
  parameter ranges go into the GLB `extras` or the manifest item, never into committed code.

### 2.6 VMT rules (for every stage that reads VMTs)

- Keys are case-insensitive. Inside one block the last occurrence of a key wins.
- Conditional blocks follow the PC DirectX 9 path: `>=dx90`, `>dx90_20b`, `srgb?` and `GPU>=` apply, `<dx90`,
  `360?` and `ps3?` do not. A key in an applying block overrides the same key outside it.
- `patch` shaders take `include` and apply `replace` then `insert`. bsp-to-glb already resolves PAK patches; the Node
  reader must handle VPK ones the same way.
- No `$basetexture`: the material draws NEUTRAL (`#8a8a8a`), as `static-props.mjs` does today.
- Alpha is opacity only with `$alphatest` (cutoff `$alphatestreference`, default 0.5) or `$translucent`. Otherwise
  base alpha is a phong, tint or blend mask and is ignored (the survey found 8,653 `$phong` and 3,996
  `$blendtintbybasealpha` model VMTs in tf2_misc).

---

## 3. Runtime

### 3.1 Code location

`src/assetpack/` with alias `@pack/*` (`tsconfig.json` `paths`; `vite-tsconfig-paths` picks it up). `src/assets/`
and `@assets/*` already exist for class and kill icons and stay unchanged.

### 3.2 Pack URL

`src/assetpack/config.ts` exports `ASSET_PACK_URL: string | null`:

1. `import.meta.env.VITE_ASSET_PACK_URL` set and not `off`: that value, with a trailing `/` added when missing.
2. `VITE_ASSET_PACK_URL === 'off'`: `null`.
3. Unset and `import.meta.env.DEV`: `'/tf2-assets/'`.
4. Unset in a production build: `null`. This is the hosted default. No request is ever made.

`vite preview` serves a production build, so it loads the pack only when the build had
`VITE_ASSET_PACK_URL=/tf2-assets/`. `VITE_APP_ASSET_URL` is unrelated and is not used for the pack.

### 3.3 Dev and preview serving

An inline plugin in `vite.config.mts` adds middleware for `/tf2-assets/` in `configureServer` and
`configurePreviewServer`. It serves files from `process.env.DRIBBLE_ASSET_PACK`, default `path.join(os.homedir(),
'tf2-pack')`. Rules:

- GET and HEAD only. The resolved path must stay inside the pack root, else 404.
- A missing file or a missing pack root answers 404 with `text/plain`. It never falls through to Vite's SPA
  `index.html`.
- Types: `.json` `application/json`, `.glb` `model/gltf-binary`, `.dds` `application/octet-stream`, `.webp`
  `image/webp`. `Cache-Control: no-cache`.
- The pack is never under `public/`, so it never reaches `dist/`, the harness build cache or a deploy.

### 3.4 Status

`src/assetpack/pack.ts` holds one page-level record (the memory rule allows this: it holds no demo, extras or store
snapshot):

```ts
type AssetPackStatus = 'absent' | 'loading' | 'ready' | 'error'
interface AssetPackState {
  status: AssetPackStatus
  reason: null | 'not-configured' | 'disabled' | 'not-found' | 'html' | 'timeout' | 'network' | 'invalid' | 'version'
  url: string | null
  manifest: AssetPackManifest | null
}
```

- `absent`: `ASSET_PACK_URL` is null (`not-configured`), `assets.enabled` is false or `?assets=off` is in the URL
  (`disabled`), the manifest answered 404 (`not-found`), or it answered `index.html` (`html`; detect it as
  `mapAssets.ts` does). `error`: timeout, network failure, bad JSON (`invalid`) or a wrong version.
- `absent` and `error` draw the same thing: no pack item. `error` logs one `console.warn`; `absent` with reason
  `not-found` or `html` logs one `console.info` line `[assets] no asset pack at <url>`; `not-configured` and
  `disabled` log nothing.
- Resolution starts on the first call of `resolveAssetPack(): Promise<AssetPackState>` and runs once per page. It
  reads `assets.enabled` and the URL flag at that moment. The manifest request has a 2000 ms timeout. A response after
  the timeout is ignored for the page.
- `getAssetPackState()` is the synchronous read; `useAssetPack()` the React hook. `assetPackFile(path)` returns the
  URL of a manifest-listed file or `null`.
- No pack code runs and nothing is requested when `ASSET_PACK_URL` is null: the state is
  `{ status: 'absent', reason: 'not-configured' }` from module load, and `resolveAssetPack()` returns an already
  resolved promise.

### 3.5 Map load order

- World resolves the pack before it fetches `conversion.json`. When `getAssetPackState().status` is already
  settled (`absent`, `ready`, `error`), World adds no `await` and no microtask hop to today's load path.
- A drawn world is never swapped. Map items that replace something (phase 2 textures) apply on the next map load.
  Additive items (stock props) may mount on the drawn map once their file has loaded.
- Pack map entries are checked against the public folder before use: `mapName` must equal the public
  `conversion.json` `mapName`, and `publicProps` must equal its `props`. A mismatch skips that map's pack items for
  the page with one `console.warn` (`[assets] maps/<folder> was built from another BSP; using public files`).
  Phase 2 adds `bspSha256` to the public `conversion.json` and compares that instead.

### 3.6 Items and fallback

- An item is a file the manifest lists. Its probe row is
  `{ key, kind, state: 'idle' | 'loading' | 'ready' | 'failed' | 'skipped', source: 'pack' | 'fallback', url, bytes, error }`.
- Nothing is requested for an item the manifest does not list.
- A failed load logs one `console.warn` (`[assets] <key>: <error>; using the fallback`), marks the item `failed` for
  the page and never retries. The other items stay real.
- While an item loads, its fallback keeps drawing (or nothing, where nothing drew before, as for stock props). When it
  is ready, every copy switches in the same frame.
- Loaders (GLTFLoader with the meshopt decoder, later DDSLoader) load through dynamic `import()` from
  `src/assetpack/`, so a build without a pack runs none of that code. The main bundle grows by at most 25 KB minified.
- Later phase binding (section 4.6) checks both `WEBGL_compressed_texture_s3tc` and
  `WEBGL_compressed_texture_s3tc_srgb` before it picks DDS, because three resolves an sRGB S3TC format to `null`
  without the second. Without both it takes the WebP sidecar, and without that the flat albedo.

### 3.7 Settings

`settings.assets`, a new top-level settings group. `src/assetpack/settings.ts` defines `AssetSettings` and
`DEFAULT_ASSET_SETTINGS`; `src/zustand/store.ts` adds the type and `assets: cloneDeep(DEFAULT_ASSET_SETTINGS)`.
Saved settings merge as today (`merge(defaultSettings, settings)` in `loadSettingsAction`). Reads in React go through
`useAssetSetting('stockProps')`, which selects a primitive; elsewhere `getAssetSetting`.

| key | default | effect |
|---|---|---|
| `assets.enabled` | true | Master switch. Read when the pack resolves. Turning it off later unmounts and disposes every pack item at once; turning it on mounts them again, resolving the pack first if it never ran. |
| `assets.stockProps` | true | `props-stock.glb`. Applies at once. Also needs `map.staticProps` (the Highlander map setting), so that one switch still hides every static prop. |
| `assets.mapTextures` | true | Phase 2. Applies on the next map load. |
| `assets.models` | true | Phase 3 world models (buildings, projectiles, map items, cart). Applies at once. |
| `assets.viewmodels` | true | Phase 4. Applies at once. |

- `?assets=off` forces `enabled` off for the page without writing the setting.
- The rows live in `src/assetpack/AssetSettingsSection.tsx`, built from the existing `Option`, `ToggleOption` and
  `SelectOption` rows of `UI/Shared/SettingsOptions.tsx`, which stays unchanged. `SettingsPanel.tsx` gets one import
  and one `<AssetSettingsSection />` line. The section renders nothing when `ASSET_PACK_URL` is null. It shows a
  status line ("TF2 asset pack: ready, N maps, M items", "not found at /tf2-assets/", the error) and only the rows
  whose feature exists; later tasks add their row.
- The settings reducer rule of AGENTS.md applies: never memoise on the `settings.assets` reference.

### 3.8 Probes

Registered through `registerHlProbe` (`@highlander/debug`) from `src/assetpack/probes.ts`, which `src/main.tsx`
imports with one line. `hl.probes()` grows from 65 to 68. That changes the smoke sweep's eval output, which
compare-runs reports only as a warning; it is an accepted difference.

- `assets.status()`: `{ status, reason, url, version, fingerprint, generatorVersion, maps: string[], itemCount,
  loading, failed }`.
- `assets.items(filter?)`: the item rows of 3.6, sorted by key, filtered by key substring.
- `assets.waitIdle(timeoutMs = 30000)`: a Promise that resolves `{ idle: boolean, status, pending: string[] }` once
  the pack is settled and no item is `loading`, or at the timeout with `idle: false`. It never rejects, and it
  resolves at once when the status is `absent` or `error`.

### 3.9 Highlander off

- Map items (stock props now, textures later) follow `assets.*` only, like the rest of the map pipeline. With a pack
  present, a Highlander-off user therefore sees stock props on the 10 bsp-to-glb maps. That is a new recorded
  deviation from Highlander contract 7.4 ("with Highlander off the app behaves as before S0"). With no pack, 7.4
  holds unchanged.
- Models and viewmodels feed only Highlander layers. With Highlander off, no request goes to `<pack>/models/` or to
  model textures.
- The base player GLBs and the rocket, pipe and sticky models are unchanged in every mode (D13).
- `koth_product_final` is unaffected in every mode (D5 amended).

### 3.10 GPU and memory rules

- No JSX-owned GPU objects. Pack geometries, materials and textures are created in `useMemo` or a loader callback,
  rendered with `<primitive>`, and disposed in an effect cleanup.
- Map items are owned by the mounted component that draws them and are disposed on unmount and map change. Shared
  model caches (phase 3) are reference-counted and dispose at zero.
- Check: `renderer.info.memory` geometries and textures stay flat over three map reloads with the pack and over two
  `assets.enabled` off and on cycles.
- No module-level variable holds a parsed demo, an extras object or a store snapshot (Highlander contract 12.3).

---

## 4. Later-phase runtime rules (stated now so wave 1 does not block them)

### 4.1 Placeholder constants

`sentryMuzzleAt`, `tracerBarrel`, `buildingTop`, `sapperOffset`, the SENTRY and DISPENSER constants and the
calibration block in `sentryAim.ts` keep today's values byte for byte. They serve the placeholder. With a pack model
drawn, the same API reads the model's attachments at runtime. `calibrate-sentry.mjs --write` is never run against a
pack model; the manifest's pose-parameter range maps the networked U8 to degrees directly.

### 4.2 API stability

Every cross-feature API in AGENTS.md keeps its signature. Probes add `source: 'pack' | 'placeholder'` only to rows
of items drawn from the pack; with no pack, every probe returns exactly what `a06e4c7` returns, the three new probes
aside.

### 4.3 Shader warm-up

Every new material program (textured lit world, WorldVertexTransition blend, alphatest variants, skinned buildings,
viewmodels) compiles through `renderer.compileAsync(object, camera, scene)` before the object joins the drawn scene.
The ready state of 3.6 means loaded and compiled.

### 4.4 Animation

Pack model animations run from tick arithmetic through `AnimationMixer.setTime`. Viewmodels play `vm0.seq` at
`(tickF - since) x intervalPerTick x rate x 30 fps`.

### 4.5 Fades

sprp fade distances apply in POV and spectator views only. The default RTS camera sits 2000 to 3700 units from the
players on vigil, and honouring the fades there would remove the props that keep objects from floating.

### 4.6 Texture binding step

For each mesh whose material has `extras.dribble.texture`, the runtime looks the key up in the manifest, picks DDS or
WebP (3.6), loads it, sets `colorSpace = SRGBColorSpace` when `srgb`, overrides DXT1 to `RGBA_S3TC_DXT1_Format` when
`oneBitAlpha` (DDSLoader maps every DXT1 to the RGB format and drops the alpha), sets `channel` from `uv`, applies the
alpha rule of 2.6, compiles (4.3) and only then shows the mesh with the texture. Until then it draws its flat albedo.

---

## 5. D21: the fallback rule

1. **Pack not configured** (production default). Identical to `a06e4c7` by construction: no request, no console
   line, no settings section, no new code on the map load path (3.4, 3.5).
2. **Pack configured but absent.** One request, `<url>manifest.json`, and one `console.info` line. Everything drawn
   is identical to `a06e4c7`.
3. **Pack present, disabled** (`?assets=off` or `assets.enabled` false at resolution). No pack request. Drawn output
   identical to `a06e4c7`.
4. **Item absent from the manifest.** That item keeps its fallback. No request for it.
5. **Item load failure.** 3.6: one warning, fallback for the page, the rest stays real.
6. **Stale map entry.** 3.5: the whole map entry falls back.

### 5.1 How D21 is verified (binding for A0-runtime, A0-harness, M3-props and every later runtime task)

Use the harness of the task's checkout for both runs. `REF` is a run with `--root <a worktree at a06e4c7>`.

| run | harness flags | must hold |
|---|---|---|
| N1 | none | `compare-runs REF N1` exits 0 on `plans/1438891-baseline.json`, and the request path sets are equal |
| N2 | `--asset-pack missing` | `compare-runs` exits 0 with `--allow-request /tf2-assets/manifest.json`; exactly 1 request under `/tf2-assets/`, status 404 |
| N3 | `--asset-pack PACK --query assets=off` | `compare-runs REF N3` exits 0; 0 requests under `/tf2-assets/` |
| N4 | `--asset-pack PACK`, Highlander off (`settings` step) | 0 requests under `/tf2-assets/models/`; map items as 3.9 says |

Eval differences from the 3 new probes are the only accepted warnings. A run on the 6v6 sample smoke plan repeats N1.

---

## 6. Budgets

Measured on this machine (Radeon 680M, 1600x900, headless shell 1248, `egl`). The frame budget uses uncapped frames
(`--no-vsync`, section 9 A0-harness), because 16.8 ms p95 under vsync cannot fail until the frame rate drops.

### 6.1 Wave 1 (flat stock props)

| item | budget |
|---|---|
| Pack not configured | section 5.1 N1 passes; main bundle growth at most 25 KB minified |
| `props-stock.glb` per map | at most 12 MB; all 10 maps at most 80 MB; reported per map |
| Pack build per map (props stage) | at most 60 s under the lock; all 10 maps at most 10 min |
| RTS draw calls / triangles (`renderer.info.render`, the smoke RTS shots) | at most 450 calls and 1.2M triangles on every packed map |
| Frame time, uncapped, `--perf-play 50%:10:rts` and a POV run on 1434434 | p95 at most 13.3 ms; if the no-pack run already misses that, at most no-pack p95 + 3 ms |
| Long tasks | none over 50 ms in the perf window, which starts after `assets.waitIdle()` resolved and 3 s of play warmed every player model (their first shader compile, 120 to 133 ms, predates this phase) |
| Peak PSS 1434434 | at most 1.15 GB (no-pack measured 872 MB) |
| Peak PSS tow_tetsudo (1429417 and 1428628, 3000 MB available first) | at most no-pack peak + 250 MB and at most 2.0 GB; PSS after the X2 release and a forced GC at most no-pack + 250 MB |
| GPU memory | flat over reloads (3.10); geometry bytes of `props-stock.glb` reported per map |

### 6.2 Later phases (binding once the phase starts; the phase task re-measures before it builds)

| item | DDS (default) | WebP variant |
|---|---|---|
| Caps (world / stock props / models / viewmodels) | 1024 / 512 / 1024 / 1024 | 512 / 256 / 512 / 512 |
| Texture GPU memory per map, world + props, computed from the manifest texture list with mips | at most 256 MB (critique est. 201 MB on vigil) | at most 256 MB (est. 234 MB) |
| Texture GPU memory per page, all pack textures | at most 320 MB | at most 320 MB |
| Tier-1 world models download | at most 20 MB | at most 5 MB |
| Viewmodel per class download | at most 10 MB | at most 2.5 MB |
| Pack on disk, 10 maps | at most 3 GB, written under `PACK`, `--tmp` on disk | |

- Peak PSS 1434434 at most 1.3 GB with textures. Tetsudo at most no-pack peak + 400 MB and at most 2.15 GB.
- RTS draw calls: M3-proptex measures textured props (one primitive per material on top of the instancing groups)
  and the orchestrator sets the limit in section 11. 600 holds until then. M3-lod cuts triangles, not calls.
- Frame and long-task rules as in 6.1, with the warm-up of 4.3.

---

## 7. Definition of done (every asset task)

- Only owned files changed. Committed in the task worktree with `git -c commit.gpgsign=false commit`, each message
  ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Nothing pushed.
- `npm run build` passes. `node_modules/.bin/tsc --noEmit -p .` shows exactly the 10 known errors.
- `git diff --name-only assets...HEAD` lists no file under `public/` and no `.vtf`, `.vmt`, `.mdl`, `.vvd`, `.vtx`,
  `.dds`, `.webp` or `.glb` file anywhere. `yarn.lock` is untouched and no `package-lock.json` exists.
- Tasks that touch runtime code pass section 5.1.
- Seeking to the same tick twice gives identical probe output after `assets.waitIdle()`.
- Every screenshot taken was looked at. Outputs stay in `WT/<task>-out/`.
- The final report lists files changed, each acceptance check with its evidence, what was skipped and why, and any
  deviation from this contract.

---

## 8. Machine rules

AGENTS.md "Gotchas" applies unchanged: worktrees with the `node_modules` link, heavy work under `flock LOCK` called
directly (the harness takes `--lock LOCK` itself), `free -m` first and 3000 MB available for tow_tetsudo, every
output and temp dir under `WT/<task>-out/`, and `df -h /home` (about 57 GB free) before a full pack build.

---

## 9. Wave 1 tasks

Order: A0-pack, A0-runtime, A0-harness and A0-exporter run in parallel. M3-props starts once A0-pack, A0-runtime and
A0-harness are merged into `assets` (it does not need A0-exporter). DOCS runs last. Branches are `as/<task>`,
worktrees `WT/as-<task>`, outputs `WT/as-<task>-out/`.

### A0-pack: converter core

Owns `scripts/assets/**` except `scripts/assets/maps/**`, and the one `package.json` script line of 2.1.

- `scripts/assets/lib/vpk.mjs`: VPK v1 and v2 reader with split archives and CRC32 checks. API
  `openVpkSet(dirFiles: string[]) -> { has(path), read(path): Buffer, stat(path), list(prefix), fingerprint() }`.
  Earlier directories in the list win (tf before hl2). Start from `assets-research-out/textured-maps/tools/vpk.mjs`.
- `scripts/assets/lib/vmt.mjs`: the rules of 2.6, with `parseVmt(text) -> { shader, params }` and
  `resolveMaterial(vpkSet, name, searchDirs) -> { file, shader, params } | null`. A test script over all 26,086
  tf2_misc VMTs reports the counts for conditionals, repeated `$basetexture`, missing `$basetexture` and patch
  shaders, and parses every file without throwing.
- `scripts/assets/lib/vtf.mjs`: header parse (version, format, flags, reflectivity, mips, frames). DDS rewrap and WebP
  conversion may wait for phase 2, but the header parse and reflectivity are needed now.
- `scripts/assets/lib/manifest.mjs`: read, merge and write manifest v1 (2.3) with canonical key order and atomic
  writes. `scripts/assets/version.mjs` exports `GENERATOR_VERSION`.
- `scripts/assets/build-pack.mjs`: the CLI of 2.1. It discovers stages as `scripts/assets/<stage>/stage.mjs` in the
  fixed order `maps`, `models`, `viewmodels`, skips missing ones, and calls
  `run(ctx: { vpk, out, tmp, options, manifest, log, generatorVersion })`. It refuses `koth_product_final`, an
  `--out` in a git work tree and `/tmp` paths (exit 2).
- `scripts/assets/check-determinism.mjs` (2.4) and `scripts/assets/README.md` (personal-use note first, then usage).

Acceptance:
- Indexing the four `_dir.vpk` files takes under 1 s; `stats` prints the entry counts (tf2_misc 104,343,
  tf2_textures 29,669, hl2_misc 18,946, hl2_textures 5,032).
- `read()` of 20 sampled files matches the research reader `tooling/bin/vpk.py extract` byte for byte, including
  files in split archives.
- A build with no stages writes a valid manifest; two such builds pass `check-determinism.mjs`.
- The VMT survey runs over every tf2_misc VMT with 0 exceptions.

### A0-runtime: loader, settings, probes

Owns `src/assetpack/**`, `vite.config.mts` (the inline plugin), `tsconfig.json` (the `@pack/*` path only),
`src/zustand/store.ts` (the `assets` type and default only), `src/components/UI/SettingsPanel.tsx` (one import and
one JSX line), `src/main.tsx` (one import line).

- Sections 3.2 to 3.4, 3.6 to 3.8 and 3.10. `resolveAssetPack`, `getAssetPackState`, `useAssetPack`,
  `assetPackFile`, `useAssetSetting`, `getAssetSetting`, `loadPackGltf(url) -> Promise<GLTF>` (dynamic import of
  GLTFLoader and the meshopt decoder) and an item registry the probes read.
- No map or model code. World is M3-props's.

Acceptance:
- Section 5.1 N1 to N3 with an A0-pack test manifest (a hand-written v1 manifest with no items is enough).
- `npm run dev` with and without `PACK` present: `/tf2-assets/manifest.json` answers 200 or 404, never `index.html`;
  `/tf2-assets/../package.json` answers 404.
- A production build without `VITE_ASSET_PACK_URL` contains no `/tf2-assets/` string in the main bundle and no
  settings section.
- `assets.status`, `assets.items` and `assets.waitIdle` return the shapes of 3.8 in all four status cases (no URL,
  404, `index.html` answer, valid manifest), checked in the harness or the dev server.

### A0-harness

Owns `scripts/hl/harness/**`.

- `--asset-pack <dir>`: serves `<dir>` at `/tf2-assets/` with the rules of 3.3 and builds the checkout with
  `VITE_ASSET_PACK_URL=/tf2-assets/`. `--asset-pack missing` builds the same way and answers 404 for every
  `/tf2-assets/` path. The build cache keys each entry by checkout path and `VITE_ASSET_PACK_URL`, so the two variants
  do not rebuild each other.
- The manifest gains `assetPack: { dir, served, manifestSha256, fingerprint, generatorVersion } | null` and
  `requests: [{ path, status, type }]` for every same-origin request (query kept, sorted by first occurrence), plus
  `requestSummary: { total, failed, byPrefix }`.
- Before each screenshot, when the page has the probe `assets.waitIdle`, the harness awaits it (30 s) and records
  `assetsIdle` in the step. Pages without the probe (`a06e4c7`) skip it, so REF runs still work.
- `--no-vsync` adds `--disable-gpu-vsync --disable-frame-rate-limit`; `perf.json` records it.
- `compare-runs.mjs`: a difference in the set of unique same-origin request paths is a failure reason
  (`requests differ`, exit 1), except paths given with `--allow-request <path>` (repeatable). A different pack
  fingerprint is a warning. `smoke-gen.mjs` adds `assets.status` and `assets.items` to the sweep.
- README and `--help` updated.

Acceptance:
- REF against itself (two runs of `a06e4c7`) exits 0, with equal request sets.
- A deliberately extra request (a plan `eval` that fetches `/favicon.ico?x`) makes compare-runs exit 1 naming it.
- `--asset-pack missing` against REF fails without `--allow-request` and passes with it, once A0-runtime is merged
  (before that, test against a branch that has it, or report as pending).

### A0-exporter: bsp-to-glb patch 0003

Owns a bsp-to-glb worktree `WT/as-exporter-bsp2glb` on branch `as/exporter` from `BSP2GLB` branch `dribble`,
`scripts/bsp-to-glb/0003-*.patch` and `scripts/setup-bsp-to-glb.mjs`. The `dribble` branch and target directory of
`BSP2GLB` stay untouched; the task builds in its own worktree.

- Fixes: MDL version 47 (the five sapper models), "sequence layer start is not finite" (c_ubersaw, c_ubersaw_xmas,
  c_uberneedle, demo_animations, engineer_animations; clamp or drop the layer and warn), the unterminated model name
  (tomb_pick_*), and no empty `mesh.weights` arrays in any output.
- No mip-limit option. The Node VTF path handles textures (critique 1.7).
- `setup-bsp-to-glb.mjs`: today it treats any `dribble` branch that contains the pinned commit as patched, so an
  existing checkout would never get 0003. It must check that every `scripts/bsp-to-glb/*.patch` is applied (by
  subject line in `git log PINNED..HEAD`) and apply the missing ones in order. `PINNED_COMMIT` stays `7b7f7fc`.

Acceptance:
- `cargo test` in the worktree, with failures that also fail on `dribble` listed as pre-existing.
- Bulk studio export with the new binary (`flock LOCK`, outputs under `WT/as-exporter-out/`, deleted after the count):
  models/buildables 77 of 77, models/weapons 449 of 449, models/player failures counted against 1716 of 1736. Any
  remaining failure is listed with its error.
- `gltf-validator` reports 0 EMPTY_ENTITY errors on the sentry1 export.
- Map output unchanged: converting pl_vigil_rc10 and koth_ashville_final1 with the old and the new binary
  (`--bsp-to-glb`, `--temp-dir` on disk, `--out-dir` under `-out`) gives byte-identical `world.glb` and `props.glb`,
  or the task names the bytes that differ and why. Two runs of the new binary are compared the same way (2.4).
- `setup-bsp-to-glb.mjs` on a scratch clone at `dribble` applies only 0003; on a fresh clone it applies 0001 to 0003.

### M3-props: stock static props

Owns `scripts/lib/static-props.mjs`, `scripts/assets/maps/**` (with `stage.mjs`), `src/highlander/map/StaticProps.tsx`,
and the glue in `src/components/Scene/World.tsx` and `src/utils/mapAssets.ts` described below, nothing more in
those two files.

Step 1, before any code. Check the 1434434 floating examples against the static prop lump of pl_vigil_rc10 (the
bsp-to-glb props export): the BLU sniper UNC. redlix at cache tick 6955, about 100 units above the visible floor,
and the sticky at cache tick 9078, 167 units above it. For each, list the props whose model bounds lie under the
point within 8 units vertically and say whether each is a stock `prop_static`, a PAK prop or a named or parented
`prop_dynamic`. Only stock `prop_static` cases become acceptance items. The others go into the report as remaining
limits.

Work:
- `static-props.mjs` accepts an optional stock source (the A0-pack VPK set) beside the PAK index; the PAK wins. With
  the stock source it can write the stock instances alone. Without it, it behaves exactly as today: the same inputs
  give a `props.glb` byte-identical to the `a06e4c7` code's output (test on vigil and tetsudo from one temp export).
- `scripts/assets/maps/stage.mjs` runs, per folder, the bsp-to-glb export the props pass needs (same flags as
  `convert-bsp.mjs`, temp dir under the pack's `--tmp`), then `convertStaticProps` with the stock source. It writes
  `maps/<folder>/props-stock.glb` and the manifest `maps` entry of 2.3, BSP from `--bsp-dir`. It never writes under
  `public/`. Skybox instances are skipped as for PAK props.
- Models below 90 % winding agreement are excluded and listed in `stats.excludedModels` (vigil has 4 between 54 and
  85 %). The pass-level 90 % rule stays.
- Runtime: `StaticProps.tsx` takes a source (`'pak' | 'stock'`) and draws both files with the same material rules,
  `map.brightness`, `settings.scene.mode` and `map.staticProps`; the stock instance also follows
  `assets.enabled && assets.stockProps`. World mounts a second `<StaticProps>` with the pack URL when the pack is
  ready, the map entry passes 3.5 and the setting is on. World resolves the pack before `fetchMapConversion` (3.5).
  `mapAssets.ts` may gain only a helper that returns the public `conversion.json` `mapName` and `props` for the check.
- `map.props()` and `map.propInstances()` add stock rows with `source: 'stock'` only while stock props are drawn;
  with no pack their output is unchanged.

Acceptance (harness with `--asset-pack PACK`):
- All 10 bsp-to-glb maps built into `PACK`; `koth_product_final` refused. Sizes, times and instance counts reported
  per map. Two builds of vigil and tetsudo pass `check-determinism.mjs`, or 2.4's tool rule applies.
- Screenshots on 1434434 (vigil), 1438891 (koth_product, unchanged: no pack entry), a tetsudo demo and one demo per
  remaining packed map, chosen with `tools/demo-stats.mjs`. Stock props are drawn; the step 1 cases that are stock
  `prop_static` stand on a drawn prop, shown by eye and by a `map.propInstances` row under the point.
- `map.nodes()` and `map.meta()` identical with and without the pack on 1434434.
- Budgets of 6.1, including tetsudo with 3000 MB available.
- Section 5.1 N1 to N4. With Highlander off and the pack, stock props draw (3.9).
- A manifest edited to a wrong `publicProps` makes that map fall back with one warning; a deleted `props-stock.glb`
  gives one warning and the PAK props still draw.
- `renderer.info.memory` flat over vigil, ashville, vigil reloads and two `assets.stockProps` toggles.

### DOCS

Owns `AGENTS.md` and `specs/assets/STATUS.md` (new). Runs after the wave-1 merges.

- AGENTS.md gains an "Asset pack" section: build command, layout, manifest, serving in dev, preview and the harness,
  `VITE_ASSET_PACK_URL` and `DRIBBLE_ASSET_PACK`, `?assets=off`, the `assets.*` settings and probes, budgets, the
  legal note's practical rules, and that rendered Valve content stays in `-out` folders.
- Updates elsewhere in AGENTS.md: the probe count (68), the harness options, the 7.4 deviation of 3.9, "Known visual
  limits" (which floating cases end with a pack, from M3-props step 1), and the D1 wording in "Known Highlander
  limits".
- STATUS.md: each wave-1 task with its acceptance results and deviations, open follow-ups, and the later phases of
  section 10.

---

## 10. Later phases (outline; each gets its own contract version before it starts)

### Phase 2: textured maps

- M3-world (owns `scripts/convert-bsp.mjs`, `bspMaterials.ts`, World): bsp-to-glb resolves VMTs and VTFs only
  (`materials.json`, `textures.json` provenance); every VTF goes through the one Node path of 2.5, so no PNG-per-mip
  step (24.4 s and 140 MB on vigil). The pack's `conversion.json`, `world.glb` and lightmap come from one run and load
  together. `bspSha256` is added to both the public and the pack `conversion.json`, and a mismatch refuses the pack
  folder. The world keeps TEXCOORD_0 as a second UV set, one material per (texture, kind), the lightmap kept. The
  untextured mode keeps working. `map-meta.json` and `props.glb` stay public. `mapNodes` must be identical with and
  without the pack.
- M3-blend: WorldVertexTransition with `_DISPLACEMENT_ALPHA` kept, TextureScroll and TextureTransform from `tickF`.
- M3-proptex: UV0 and per-instance skin, alphatest from the VMT, the draw-call re-baseline of 6.2.
- M3-lod: VTX LOD1 at distance; fades per 4.5.
- M3-overlays and `map.skybox3d`: the skybox props need the sky_camera scale and their own prop pass, which nobody
  has costed yet.
- Since World and `convert-bsp.mjs` are shared between the world and props tracks, one task at a time owns them.

### Phase 3: world models

- W-pack depends on A0-exporter (the sappers fail on MDL v47 without it).
- W-buildings: 4.1 applies. Choose between additive aim clips (`AnimationUtils.makeClipAdditive` on `a_yaw_*` and
  `a_pitch_*`) and direct bone rotation with a prototype before the task is sized.
- W-projectiles: energy ring, fireball and Short Circuit orb have no model and keep their placeholders; base rocket,
  pipe and sticky stay base GLBs.
- W-mapitems: kits, plates, ammo, drops and lockers by model string.
- W-cart: `bomb_cart` is a named or parented `prop_dynamic` that bsp-to-glb skips. Orientation comes from the train
  transform in the extras or mapdyn. tetsudo's `props_tow/tow_cart` is only in the BSP PAK.
- Download budgets are per format (6.2).

### Phase 4: viewmodels

- V-provider also owns `ViewmodelLayer.tsx`. Its instance cache is keyed by (class, weapon, team) and
  `ViewmodelProvider.create` is synchronous, so a GLB that finishes loading after the first POV frame would never
  replace the cached placeholder. The key must include the model-ready state, or the cache must evict on load.
- Open items: team skin on c_model weapons, bodygroups, the spy watch on `vm1` with its own `since`, the cloak fade
  on the viewmodel, minigun barrel spin (client-side in TF2), parity restarts as clip restarts, and the include merge
  order for unmapped sequence indices (soldier 57, 59, 66; heavy 42).
- Old demos without local tables (the 6v6 sample) keep the placeholder provider unchanged.

### Not scheduled

Third-person weapon models, KTX2 if hosting is ever chosen, overlays on displacements, light styles, other maps.

---

## 11. Amendments

The orchestrator appends accepted deviations, measured limits (6.2 draw calls, 2.4 tool nondeterminism) and
decisions here, as numbered subsections, and bumps the version line.
