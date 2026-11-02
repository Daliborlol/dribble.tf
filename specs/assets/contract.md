# Asset-phase contract

Version 2.1, 2026-11-02 (section 12 adds wave 2, section 13 viewmodels). Branch `assets` starts at `highlander` `a06e4c7` (Highlander contract v2.5). This file binds
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
- **D5, amended** (superseded by as/product, see `STATUS.md` "koth_product_final in the pack": the maps stage now
  builds it, and with a pack entry and `assets.mapTextures` World loads the pack world; without a pack nothing
  changed). Original text: `koth_product_final` is excluded from map packs. It keeps its upstream `textured_compressed.glb`,
  has no `mapNodes`, and with Highlander off it is the base viewer's map. `--maps all` means the 10 bsp-to-glb
  folders, those whose public `conversion.json` has `pipeline: 'bsp-to-glb'`, so it never includes it. The pack
  builder exits 2 only when `koth_product_final` is named explicitly in `--maps`.
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
      "publicProps": { "pak": 88, "stock": 1428, "stockSolid": 409 }, // verbatim copy of public conversion.json props
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
- `publicProps` is a verbatim copy of the public `conversion.json` `props` object, every key included (`dynamic` on
  pl_eruption_b15 and tow_tetsudo_b10c). The runtime compares the two deep-equal.
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
- `patch` shaders take `include`, then apply `insert` (add or overwrite) and then `replace` (keys that exist only).
  Nested blocks merge on the raw tree before conditions are evaluated. In a patch of a patch the outer patch applies
  last and wins. This is Source's order, which bsp-to-glb and `scripts/assets/lib/vmt.mjs` both follow (v2.0 fixed
  the earlier "replace then insert" wording).
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
  reads `assets.enabled` and the URL flag at that moment. One exception: a `disabled` result caused by the setting
  (not by `?assets=off`) is redone once when `assets.enabled` turns true. Every other settled state is final for the
  page. The manifest request has a 2000 ms timeout. A response after
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
  `conversion.json` `mapName`, and `publicProps` must deep-equal its `props` (2.3). A mismatch skips that map's pack items for
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
| `assets.enabled` | true | Master switch. Read when the pack resolves. Turning it off later unmounts and disposes every pack item at once; turning it on mounts them again; if the pack settled `disabled` because of this setting, it resolves once more first (3.4). |
| `assets.stockProps` | true | `props-stock.glb`. Applies at once. Also needs `map.staticProps` (the Highlander map setting), so that one switch still hides every static prop. |
| `assets.mapTextures` | true | Phase 2. Applies on the next map load. |
| `assets.models` | true | Phase 3 world models (buildings, projectiles, map items, cart). Applies at once. |
| `assets.viewmodels` | true | Phase 4. Applies at once. |

- `?assets=off` forces `enabled` off for the page without writing the setting.
- The rows live in `src/assetpack/AssetSettingsSection.tsx`, built from the existing `Option`, `ToggleOption` and
  `SelectOption` rows of `UI/Shared/SettingsOptions.tsx`, which stays unchanged. `SettingsPanel.tsx` gets one import
  and one `<AssetSettingsSection />` line. The section renders nothing when `ASSET_PACK_URL` is null. It shows a
  status line ("TF2 asset pack: ready, N maps, M items", "not found at /tf2-assets/", the error) and only the rows
  whose feature exists. A0-runtime ships the `assets.enabled` row and the `assets.stockProps` row, the latter shown
  when the manifest has any `maps` entry. Phase 2 to 4 tasks own the line of their own row in that file.
- The settings reducer rule of AGENTS.md applies: never memoise on the `settings.assets` reference.

### 3.8 Probes

Registered through `registerHlProbe` (`@highlander/debug`) from `src/assetpack/probes.ts`, which `src/main.tsx`
imports with one line. `hl.probes()` grows from 65 to 68. That adds three keys to the smoke sweep's eval result,
which today's compare-runs counts as a manifest structure difference (exit 1); A0-harness changes that (5.1).

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
- The base player GLBs and the rocket, pipe and sticky models are unchanged in every mode (D1 amended).
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
3. **Pack present, disabled** (`?assets=off` or `assets.enabled` false at resolution). No pack request while it stays
   disabled, and drawn output identical to `a06e4c7`. Turning `assets.enabled` on later in the page (not
   `?assets=off`, which holds for the page) resolves the pack once more (3.4).
4. **Item absent from the manifest.** That item keeps its fallback. No request for it.
5. **Item load failure.** 3.6: one warning, fallback for the page, the rest stays real.
6. **Stale map entry.** 3.5: the whole map entry falls back.

### 5.1 How D21 is verified (binding for A0-runtime, A0-harness, M3-props and every later runtime task)

Use the harness of the task's checkout for both runs. `REF` is a run with `--root <a worktree at a06e4c7>`.

| run | harness flags | must hold |
|---|---|---|
| N1 | none | `compare-runs REF N1` exits 0 on `plans/1438891-baseline.json`, and the request keys (below) are equal |
| N2 | `--asset-pack missing` | `compare-runs` exits 0 with `--allow-request /tf2-assets/manifest.json`; exactly 1 request under `/tf2-assets/`, status 404 |
| N3 | `--asset-pack PACK --query assets=off` | `compare-runs REF N3` exits 0; 0 requests under `/tf2-assets/` |
| N4 | `--asset-pack PACK`, Highlander off (`settings` step) | 0 requests under `/tf2-assets/models/`; map items as 3.9 says |

Manifest structure rule (A0-harness implements it; the gate depends on it). Today `compare-runs.mjs` fails on any
difference of JSON paths or value types between the two manifests, array indices and eval results included. The
new manifest fields would break N1 to N3 under that rule, so compare-runs leaves these subtrees out of the structure
check: `assetPack`, `requests`, `requestSummary`, every step's `assetsIdle` and every step's eval result. Requests are
judged only by the request-set rule below, and evals stay warnings. The harness also writes fixed shapes: `assetPack`
is always an object with nullable fields, and `assetsIdle` is `null` when the page has no `assets.waitIdle` probe.

Request-set rule (A0-harness implements it in `compare-runs.mjs`; the log itself stays raw):
- **Pathname only.** Each same-origin request is compared by its URL pathname. The query string stays in the
  `requests` log but takes no part in the comparison, so the page URL of N3 (`/?debug=1&demoUrl=...&assets=off`)
  and REF's (`/?debug=1&demoUrl=...`) are the same key `/`.
- **Build hashes normalised.** Vite names build output by content hash (`/assets/index-B-261qmv.js`,
  `/assets/ParseWorker-BJEWqfZR.js`), so any `src/` change renames them. Under `/assets/` only, the final
  `-<8 chars of [A-Za-z0-9_-]>` before the extension becomes `-[hash]`: the pattern
  `/^(\/assets\/.+)-[A-Za-z0-9_-]{8}(\.[A-Za-z0-9]+)$/` is replaced by `$1-[hash]$2`. `/assets/index-[hash].js`
  is then one key for REF and N1. No other path is rewritten; `/tf2-assets/` paths are compared verbatim.
- **Counted keys.** Two build files can share a normalised key (two chunks named `index`), so each side is a
  map from key to the number of distinct raw pathnames behind it. The maps must be equal, apart from the keys given
  with `--allow-request <pathname or normalised key>` (repeatable). The failure reason `requests differ` lists each
  key with both counts.
- A task whose change adds or removes a requested chunk with the pack not configured fails N1 on purpose, because
  D21 case 1 says no new code runs on the map load path. The task either removes the request or, when the chunk is
  justified (for example a lazy chunk that only loads after a user action the plan triggers), names the key with
  `--allow-request` and gives the reason in its report.

Eval differences, among them the 3 new probe keys of the smoke sweep, are the only accepted warnings. A run on the
6v6 sample smoke plan repeats N1 under the same rule.

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
| RTS draw calls / triangles (`renderer.info.render`, the smoke RTS shots) | The research measured 259 to 474 calls for a textured world with stock props; no no-pack count exists yet, so M3-props first measures the no-pack calls per map and records them in 11. Then at most 450 calls, or no-pack calls + 300 on a map that misses 450, and at most 1.2M triangles, on every packed map |
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
- The settings section shows the `assets.stockProps` row only with a manifest that has a `maps` entry, and the
  `assets.enabled` row whenever `ASSET_PACK_URL` is set.
- `assets.status`, `assets.items` and `assets.waitIdle` return the shapes of 3.8 in all four status cases (no URL,
  404, `index.html` answer, valid manifest), checked in the harness or the dev server.

### A0-harness

Owns `scripts/hl/harness/**`.

- `--asset-pack <dir>`: serves `<dir>` at `/tf2-assets/` with the rules of 3.3 and builds the checkout with
  `VITE_ASSET_PACK_URL=/tf2-assets/`. `--asset-pack missing` builds the same way and answers 404 for every
  `/tf2-assets/` path. The build cache keys each entry by checkout path and `VITE_ASSET_PACK_URL`, so the two variants
  do not rebuild each other.
- The manifest gains `assetPack: { dir, served, manifestSha256, fingerprint, generatorVersion }` (always an object,
  every field `null` without `--asset-pack`) and
  `requests: [{ path, status, type }]` for every same-origin request (query kept, sorted by first occurrence), plus
  `requestSummary: { total, failed, byPrefix }`.
- Before each screenshot, when the page has the probe `assets.waitIdle`, the harness awaits it (30 s) and records
  `assetsIdle` in the step. Pages without the probe (`a06e4c7`) get `assetsIdle: null`, so REF runs still work.
- `--no-vsync` adds `--disable-gpu-vsync --disable-frame-rate-limit`; `perf.json` records it.
- `compare-runs.mjs`: a difference under the request-set rule of 5.1 (pathname only, `/assets/` hashes normalised,
  counted keys) is a failure reason (`requests differ`, exit 1), except keys given with `--allow-request <key>`
  (repeatable). A different pack
  fingerprint is a warning. The structure check skips the subtrees named in 5.1 (`assetPack`, `requests`,
  `requestSummary`, each step's `assetsIdle` and eval result). `smoke-gen.mjs` adds `assets.status` and
  `assets.items` to the sweep.
- README and `--help` updated.

Acceptance:
- REF against itself (two runs of `a06e4c7`) exits 0, with equal request keys.
- REF against a run of a scratch checkout of `a06e4c7` plus a trivial `src/` change that changes every bundle hash
  (for example one added `console.debug` string in `src/main.tsx`, never committed) exits 0 on requests. The raw
  `requests` logs of the two runs differ in their `/assets/` names, which the report shows.
- REF against N3 (`--asset-pack <test manifest dir> --query assets=off`) exits 0 on requests, although the logged
  document URLs differ by `assets=off`.
- REF (the `a06e4c7` page) against N1 (the A0-harness checkout's page, new manifest fields present) exits 0 on the
  baseline plan and on the 6v6 smoke plan, whose sweep differs by the new probe keys once A0-runtime is merged.
- A deliberately extra request (a plan `eval` that fetches `/__extra-request-test`, a path no page requests) makes
  compare-runs exit 1 naming that key; the same run passes with `--allow-request /__extra-request-test`.
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

### 11.1 Length (v1.1)

The task asked for about 300 to 500 lines. This file is longer, because the wave-1 acceptance lists of section 9 are
kept here, where every task and reviewer reads the same text. Accepted.

### 11.2 Request comparison (v1.2)

Raw same-origin paths cannot be compared between checkouts: Vite's content-hashed bundle names change with any
`src/` edit, and the page URL carries the run's `--query`. Section 5.1 therefore compares pathnames, with the
`/assets/` hashes normalised and the keys counted. The A0-harness acceptance tests both cases.

### 11.3 M3-props merge (v1.3)

Recorded by the integrator when `as/m3-props` (`30a6f80`) was merged; the implementer and the reviewer both asked for it.

1. Triangle budget (6.1): wave 1 reports triangles per map and does not gate on 1.2M. M3-lod (section 9) owns the cut
   and re-measures against 1.2M. Measured by M3-props (`renderer.info.render`, RTS, POV and RTS-close shots at 50 %,
   max calls / max triangles, no pack then pack): divulgence 299 / 0.17M, 444 / 1.25M; tetsudo 322 / 1.00M,
   503 / 1.95M; eruption 183 / 0.41M, 264 / 1.34M; downfall 134 / 0.35M, 339 / 1.70M; ashville 243 / 0.39M,
   301 / 1.07M; vigil 189 / 0.18M, 314 / 1.19M; upward 284 / 0.17M, 336 / 0.97M; proot 221 / 0.25M, 249 / 0.38M;
   steel 329 / 0.16M, 433 / 1.19M; warmtic 162 / 0.14M, 270 / 1.16M; koth_product_final (no pack entry) 340 / 0.85M
   both. These are also the no-pack call counts 6.1 asks for. Tetsudo already draws 0.64 to 1.0M without the pack.
   Frame time met its budget on every measured map.
2. `map.propInstances` stock rows carry `source: 'stock'` with their Source origin under `origin`; PAK rows are
   unchanged. `map.props()` gains a `stock` sub-object only while stock props are drawn.
3. Stock mode reads VMTs through `scripts/assets/lib/vmt.mjs` (2.6, alpha-test reference 0.5); the PAK path keeps its
   own reader.
4. Stock mode excludes models below 90 % winding agreement, 1 to 4 per map; rock006c's 25 instances on tetsudo and 9
   on eruption stay a gap.
5. Unnamed, unparented, non-animated stock `prop_dynamic` entities are included by the PAK rule.
6. Clusters of one or two lit instances join the merged exact-VHV batch.
7. Manifest `stats` hold counts and `inputKey` only; timings go to `reports/maps/<folder>.json`.
8. `mapdyn.surface` and `map.status` differ with the pack; `map.nodes` and `map.meta` are identical.
9. Textures grow by 2 per map reload with and without the pack, outside M3-props' files (pre-existing).
10. A forced `scene.map` switch to a map other than the demo's own loads empty world and props roots, already on
    `a06e4c7`. It matters only to probes and test plans; measure on the demo's own map.

---

## 12. Wave 2 (v2.0)

Wave 2 starts phase 2 (M3-world, M3-props2) and phase 3 (W-pack, W-buildings, W-projectiles, W-items). It replaces
the phase 2 and 3 outlines of section 10 where they differ: M3-blend folds into M3-world as an option, M3-proptex
and M3-lod become M3-props2, and W-mapitems and W-cart become W-items. Sections 1 to 8 still bind. Viewmodels,
overlays and the 3D skybox stay later.

### 12.1 Order and tracks

- Map track: M3-world, then M3-props2 (both edit World, `bspMaterials.ts` and the maps stage, so never at once).
- Model track: W-pack, then W-buildings, W-projectiles and W-items in parallel. The two tracks run in parallel.
- Integrators merge one branch at a time into `assets`. A task based on an older `assets` rebases before merge.
- bsp-to-glb patches: M3-world ships `0004-*.patch`, M3-props2 `0005-*.patch` and W-pack `0006-*.patch` when they
  need one. Each patch applies with `git am` on top of every lower number that exists, from a worktree branched off
  `as/exporter`; the integrator rebases a patch whose lower neighbour merged after it was cut.

### 12.2 File ownership

A task edits only its rows. Rows name new files where a shared one would otherwise be touched.

| task | owns |
|---|---|
| M3-world | patch 0004; `scripts/convert-bsp.mjs`; `scripts/assets/maps/**`; new `scripts/assets/lib/texture-export.mjs` (VTF to DDS/WebP, 2.5); `src/components/Scene/World.tsx`; `src/highlander/map/bspMaterials.ts`; `src/assetpack/{types.ts, pack.ts, probes.ts, AssetSettingsSection.tsx}`; new `src/assetpack/textures.ts` (12.3) |
| M3-props2 | after M3-world: patch 0005; `scripts/lib/static-props.mjs`; `scripts/assets/maps/**`; `src/highlander/map/StaticProps.tsx`; `src/highlander/map/probes.ts` |
| W-pack | patch 0006; `scripts/assets/lib/model-export.mjs`; new `scripts/assets/models/**`; `src/assetpack/loaders.ts`; new `src/assetpack/models.ts` (12.4) |
| W-buildings | `src/highlander/buildings/**`; `src/highlander/scene/layers/BuildingsLayer.tsx` |
| W-projectiles | `src/highlander/combat/**`; `src/highlander/scene/layers/ProjectilesExtraLayer.tsx` |
| W-items | `src/highlander/mapdyn/**`; `src/highlander/objectives/**` (only `probes.ts` and new cart files); `src/highlander/scene/layers/{MapDynamicsLayer.tsx, ObjectivesLayer.tsx}` (in `ObjectivesLayer.tsx` only `CartObject` and its helpers) |

- Nobody in wave 2 edits `src/assetpack/{items.ts, hooks.ts, settings.ts, config.ts, index.ts}`, the store,
  `SettingsPanel.tsx`, `main.tsx`, `HighlanderScene.tsx` or `scripts/assets/build-pack.mjs`. Import from the module
  paths (`@pack/textures`, `@pack/models`), not from `@pack/index`. A task that needs one of these files stops and asks.
- `AssetSettingsSection.tsx` has one owner, M3-world. It adds the `assets.mapTextures` row (shown when a manifest
  map entry has `files.world`) and the `assets.models` row (shown when the manifest has a `kind: 'model'` item).
- Hooks across tracks: W-pack calls `bindPackTextures` from `@pack/textures`. If M3-world is not on `assets` when
  W-pack starts, W-pack writes `src/assetpack/modelTextures.ts` with exactly the 12.3 exports and imports from it;
  the integrator who merges the second of the two turns `modelTextures.ts` into `export * from './textures'` (or
  deletes it and fixes the import). The same applies to `scripts/assets/lib/texture-export.mjs`: W-pack then ships
  `scripts/assets/models/texture-export.mjs` with the same exports, and the integrator dedupes.
- The feature tasks touch no pack code. They read `@pack/models` and keep every placeholder as the fallback per item.

### 12.3 Texture binding API (`src/assetpack/textures.ts`, M3-world)

Manifest texture item, key = the VMT texture name lower case without extension (`models/buildables/sentry1`):
`{ kind: 'texture', file: 'textures/<key>.dds' | null, webp: 'textures/<key>.webp' | null, bytes, sha256,
stage, srgb, oneBitAlpha, alpha: 'opaque' | 'test' | 'blend', alphaCutoff, width, height, mips, frames? }`. At least
one of `file` and `webp` is set. A key listed by two stages is written by the first stage in `STAGE_ORDER`; a later
stage reuses that item when its input key matches and never writes the file again.

GLB materials carry `extras.dribble.texture = { key, uv, skins? }` (three exposes it as `material.userData`);
`skins[i]` is the key for skin `i` when it differs from `key`. Exports:

```ts
export type PackTextureFormat = 'dds' | 'webp' | null
export function packTextureFormat(renderer: WebGLRenderer): PackTextureFormat   // 3.6 extension checks, cached per renderer
export function acquirePackTexture(key: string, renderer: WebGLRenderer): Promise<Texture | null>
export function releasePackTexture(key: string): void
export interface PackTextureBinding { bound: number; failed: number; release(): void }
export function bindPackTextures(root: Object3D, renderer: WebGLRenderer, opts?: { skin?: number }): Promise<PackTextureBinding>
```

- `acquirePackTexture` is reference-counted per key and disposes the texture at zero. It never rejects: `null`
  means absent, unsupported or failed (3.6 warning once). DDS goes through `DDSLoader` by dynamic import, with the
  DXT1 override of 4.6; a DDS without mips gets `LinearFilter`. Loads go through `loadPackItem`, so items show in
  `assets.items`.
- `bindPackTextures` walks the meshes, sets `map`, `colorSpace`, `channel` and the alpha rule of 2.6
  (`alphaTest = alphaCutoff` for `test`, `transparent` with `depthWrite = false` for `blend`), sets `needsUpdate`
  and resolves once every texture loaded or failed. A failed one keeps that material's flat albedo. The caller then
  runs `warmUpObject` (4.3) and only then shows the object. `release()` releases every key it acquired.
- Materials stay owned by their object; textures are shared and owned by this module.

### 12.4 Model API (`src/assetpack/models.ts`, W-pack)

Manifest model item, key = the model string lower case with `/` (`models/buildables/sentry1.mdl`), also for BSP PAK
models (tetsudo `models/props_tow/tow_cart.mdl`, with `source: 'pak:<folder>'`). Fields:
`{ kind: 'model', file: 'models/<path>.glb', bytes, sha256, stage: 'models', source: 'vpk' | 'pak:<folder>',
textures: string[], skins: number, attachments: { [name]: { bone, pos: [x,y,z], quat: [x,y,z,w] } },
sequences: [{ name, frames, fps, clip }], poseParams: { [name]: { min, max } }, bodygroups?, bounds: [min, max] }`.
Numbers in the manifest are pack data, never committed (D19). Units are Source units, +X forward, as the GLB.

```ts
export interface PackModelHandle {
  key: string; info: PackModelItem; clips: AnimationClip[]
  instantiate(skin?: number): Object3D   // shared geometry; materials shared per (model, skin); own bones when skinned
  release(copy: Object3D): void
}
export function packModelListed(key: string): boolean            // sync: pack ready, assets.enabled and assets.models on, item listed and not failed
export function acquirePackModel(key: string, renderer: WebGLRenderer, scene: Scene, camera: Camera): Promise<PackModelHandle | null>
export function releasePackModel(key: string): void
export function usePackModel(key: string | null): PackModelHandle | null   // acquire on mount, release on unmount; null until loaded, bound and compiled
export function attachmentMatrix(copy: Object3D, name: string, out: Matrix4): boolean   // world matrix of an attachment, false when missing
```

- One cache entry per key, reference-counted; at zero it disposes geometry, materials and its texture binding.
- `usePackModel` returns `null` while loading, on failure, when the item is absent and whenever `packModelListed`
  is false, so a feature draws `handle ? pack : placeholder` and falls back per item (5 cases 4 and 5).
  Turning `assets.models` off switches every copy back to its placeholder in the same frame.
- Team skin: skin 0 RED, 1 BLU unless the item says otherwise (`teamSkins: [red, blu]`).
- Animation follows 4.4: one `AnimationMixer` per copy, `setTime` from tick arithmetic. Pose parameters map the
  networked value to the manifest range directly (4.1). Clips the items do not use are pruned at build time.

### 12.5 Task notes

- M3-world: the pack map entry gains `files.{conversion, world, lightmap}` and `textures: string[]`. With
  `assets.mapTextures` on and the entry valid (3.5), World loads the pack `world.glb` instead of the public one on
  the next map load; `mapNodes` must deep-equal the public load. `scene.mode` untextured and wireframe keep the
  public path's look. The public `bspSha256` of section 10 is deferred, because DoD forbids `public/` changes; 3.5's
  `mapName` and `publicProps` check stays. WorldVertexTransition blends and TextureScroll from `tickF` are optional.
  Report texture GPU memory (12.6) on 1434434 (vigil) and 1428628 (tetsudo).
- M3-props2: textured stock props from `props-stock.glb` and textured PAK props from a new pack file
  `maps/<folder>/props-pak.glb` (public `props.glb` stays as it is and keeps drawing without the pack). VTX LOD1 or
  lower at distance; sprp fades in POV and spectator only (4.5). Record RTS draw calls and triangles per map.
- W-pack: buildings (sentry 1 to 3 and mini, dispenser, teleporter, sapper, blueprints), extras projectile models,
  kits, ammo, plates, lockers and the carts (`bomb_cart` variants and tetsudo's PAK `tow_cart`). LOD0. No layer edits.
- W-buildings: 4.1 binds; `sentryMuzzleAt` reads `attachmentMatrix` when a pack sentry is drawn. Probe rows of pack
  copies add `source: 'pack'` (4.2).
- W-projectiles: flares, arrows, bolts, jars, cleavers, balls, cannonballs, syringes. Energy ring, fireball and orb
  keep placeholders; base rocket, pipe and sticky are unchanged.
- W-items: kits, ammo, lunchbox plates, drops and lockers by model string; the cart oriented by the train transform
  `CartObject` already computes.

### 12.6 Checks and budgets

- Budgets are 6.2. RTS draw calls at most 600 with textures (M3-props2 records the measured value). Triangles at most
  1.2M in RTS on downfall, eruption, divulgence and tetsudo after M3-props2 (11.3 item 1).
- Texture GPU memory per map = sum over the entry's textures of the bytes with mips: DDS as stored, WebP as
  `width x height x 4 x 4/3`. Computed from the manifest; at most 256 MB per map and 320 MB per page.
- Every task: section 7, plus 5.1 N1 against REF once, and pack harness shots on two or three representative
  maps or demos (1434434 vigil, 1438891 koth_product for models, one tetsudo). With `assets.mapTextures` and
  `assets.models` off, the pack page draws as on `assets` before the task. No per-map sweeps or repeated perf runs
  are required; gaps go to the task's `notDone`.
- Disposal (3.10): `renderer.info.memory` stays flat over two map reloads and one `assets.models` off and on cycle.

---

## 13. Viewmodels (v2.1, wave 3)

Phase 4 replaces the outline of section 10 where they differ. V-pack builds the pack side; V-provider owns the
runtime (`src/highlander/scene/viewmodel/**`, `ViewmodelLayer.tsx`) and reads only what 13.3 lists.

### 13.1 Stage

- `scripts/assets/viewmodels/` (`stage.mjs`, `list.mjs`), run by `--stages viewmodels`. Options: `--set
  itemsGame=<items_game.txt>` (default `<tf dir>/scripts/items/items_game.txt`, which the VPK copy lacks; without
  a schema only the arms are built, with a warning), `viewmodelClasses=[...]`, `textureMaxSize` (1024, 6.2).
- Arms: `models/weapons/c_models/c_<class>_arms.mdl` for the nine classes (`c_demo_arms`, `c_heavy_arms`, ...).
- Weapons: `list.mjs` `WEAPON_DEFS` = the stock defs and their Upgradeable copies plus every def the local HL
  demos hold or fire (extras `players.weapon.def`, `players.vm0.weaponDef`, `players.fire.weaponDef`). Def ids are
  public schema numbers. The stage resolves each (def, class) through the schema with prefabs merged
  (`build-items.mjs`'s `parseKeyValues` and `mergeDefinition`): `model_player_per_class[class]`, else
  `model_player`, and keeps it only with `attach_to_hands` or `attach_to_hands_vm_only` = 1. Skipped pairs (no
  model, not attached to hands, model missing) go to `reports/viewmodels/summary.json`.
- Export as the models stage (patch 0003, LOD 0, meshopt, flat albedo plus `extras.dribble.texture`). A weapon
  model another stage owns (a throwable) is reused as it is; textures follow 12.3, reuse included.

### 13.2 Sequence order and clips

`vm0.seq` indexes the arms' virtual model. The stage rebuilds it as Source's `virtualmodel_t::AppendModels`
does: the arms' own sequences, then each `$includemodel` depth first (recursively). A name already present
(case-insensitive) is skipped, unless the present one has `STUDIO_OVERRIDE` (0x800, a `$declaresequence`), which
the include's sequence replaces at the same index. Names only in an include are appended, which is where the
indices that the arms do not declare come from (contract 10: soldier 57, 59, 66; heavy 42).

- `sequences[i]` is index i: `{ name, frames, fps, clip, loop, activity, from }` (`from` = 0 for the arms, else
  the position in `includeModels`). `clip` is null for index 0 (the reference pose), delta and still-declared
  sequences, undecoded animations and names matching `inspect|^passtime_|taunt|^r_handposes$`; every other
  sequence keeps its first animation, copied from the include GLB onto the arms' bones by name.
- Blend sequences keep their first animation; the `r_handposes` finger layer is dropped (a gap).

### 13.3 Manifest items

- Arms, key = the arms model path: the 12.4 model fields plus `role: 'viewmodel:arms'`, `class`, `sequences`
  (13.2), `sequenceIndex { name: index }` for the sequences with a clip, `includeModels`, `bones` (names) and
  `weapons { <def>: <weapon model key> }` for that class.
- Weapon, key = the c_model path: the 12.4 fields with `sequences: []` and no clips (rest pose from its first
  sequence), `role: 'viewmodel:weapon'`, `bones`, and `viewmodel { defs, classes, mergeBones { <class>: names } }`.
  `mergeBones` are the weapon bones whose names (case-insensitive) exist in that class's arms: TF2 draws the
  c_model bone-merged, so those bones copy the arms bone's transform every frame and the rest keep the weapon's
  own pose. Attachments (`muzzle`, `weapon_bone` and the rest) are in `attachments`, relative to their bone.
- Team skin 0 RED, 1 BLU as in 12.4; `bodygroups` lists names and counts.

### 13.4 Budget, measurements and checks

- Per class (6.2, DDS at most 10 MB): measured on the experiment pack, the arms with the stock loadout take 3.6
  (scout) to 8.2 MB (engineer), GLB and DDS together. A class with every weapon of `weapons` takes 11.9 (spy) to
  24.3 MB (pyro); a page downloads only what it draws, so that is a worst case no viewer reaches. Weapon textures
  are capped at 512 (`weaponTextureMaxSize`) and exported for skins 0 and 1 only; other skins draw flat albedo.
  DXT textures have no WebP copy (2.5), so the WebP column stays 0.
- The indices contract 10 left open are include-only sequences: soldier 57, 59 and 66 are inspects (no clip;
  the provider holds idle), heavy 42 is a melee draw with a clip.
- `mapdyn` Drops (W-items) draws any listed pack model by model string, so with this stage dropped weapons draw
  their c_model in the rest pose instead of the placeholder.
- No `src/` change; `@pack/models` loads both kinds. D21 holds: without a pack or with `assets.viewmodels` off
  the placeholder provider draws exactly as before.
