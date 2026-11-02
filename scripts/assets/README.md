# TF2 asset pack builder

**Personal use only.** These scripts convert the TF2 game files of your own Steam install into a local asset
pack for your own viewing. The pack is a derivative of Valve content: the Steam Subscriber Agreement licenses
that content for personal, non-commercial use (section 2.A) and forbids distributing derivative works without
Valve's written consent (section 2.G). Keep the pack on your machine, outside every repository. Do not upload,
host or share it, and never commit it, its files, screenshots of it or numbers copied out of it. Hosting a pack
would be a separate decision recorded in `specs/assets/contract.md`; no committed file sets
`VITE_ASSET_PACK_URL`.

The binding rules are in `specs/assets/contract.md` (sections 2 and 9 "A0-pack").

## Build

```sh
flock <lock> npm run assets:build -- --tf2 /home/dalibor/tf2-assets/tf --hl2 /home/dalibor/tf2-assets/hl2 --out /home/dalibor/tf2-pack
```

`--tf2` may also be the folder that holds `tf/` and `hl2/` (`--tf2 /home/dalibor/tf2-assets`). The builder opens
`tf2_textures_dir.vpk`, `tf2_misc_dir.vpk`, `hl2_textures_dir.vpk` and `hl2_misc_dir.vpk`, in that mount order
(an earlier file wins).

| option | meaning |
|---|---|
| `--out <dir>` | pack directory, default `~/tf2-pack`. Refused inside any git work tree, under `/tmp`, and when the directory is not empty but holds no pack. |
| `--stages maps,models,viewmodels` | stages to run, always in that order; `none` runs none. `--only` is the same option. Default: every stage that exists. |
| `--maps <folder,...>` / `all` | folders for the maps stage. `all` (default) is the bsp-to-glb folders under `public/models/maps/` (`conversion.json` `pipeline: 'bsp-to-glb'`) plus `koth_product_final` (`PACK_WORLD_ONLY_MAPS`: its public folder keeps the older textured GLB, its pack entry gets a bsp-to-glb world, lightmap, `conversion.json`, `props-stock.glb` and `props-pak.glb`, without `publicProps`). An unknown folder exits 2. |
| `--bsp-dir <dir>` | map BSPs, default the Steam install's `tf/maps/`. |
| `--tmp <dir>` | scratch dir, default `<out>/.tmp`, removed after the build. Never under `/tmp`. |
| `--force` | ignore the previous manifest and rebuild every item. |
| `--prune` | delete pack files the new manifest does not list. |
| `--keep-tmp` | keep the scratch dir. |
| `--bsp-to-glb <binary>` | the patched bsp-to-glb; default `$BSP_TO_GLB`, `$BSP_TO_GLB_DIR/target/release/bsp-to-glb`, or `../bsp-to-glb` next to this checkout or next to the main checkout of a worktree. |
| `--set key=value` | a stage option (repeatable); the value is parsed as JSON when it can be. |
| `--stage-dir <dir>` | load `<stage>/stage.mjs` from another folder (tests, `tools/fixture-stages`). |

Exit codes: 0 built, 1 a stage or the final check failed, 2 a usage error or a refused option, 130 interrupted.

Run big builds under the shared lock (`flock <lock> ...`, called directly) and check `df -h /home` first.

### What a build guarantees

- Stages write into a staging folder under the scratch dir. After every stage succeeded, the builder fills sizes and
  hashes (from the staged file when one is staged, else from the pack file), validates the new manifest and checks
  every listed file against that overlay of staged and existing files. Only then are the files moved into place,
  each by an atomic rename (`.<name>.partial` and a rename when the scratch dir is on another filesystem).
  `reports/build/last-build.json` comes next and `manifest.json` last. A failed or interrupted build prints the step
  it was in; up to the first rename it leaves the previous `manifest.json` and the files it lists as they were. Only
  a failure of a rename or of the manifest write itself can leave replaced files under the old manifest, and the
  message then says so.
- One build at a time per pack: `<out>/.build.lock` holds the builder's pid.
- Incremental: each manifest section has an owner. `maps` and `options.maps` belong to the maps stage, an item to
  the stage that added it (the builder records it as the item's `stage` field) and `options.<stage>` to that stage.
  The previous entries of a stage that runs carry over when the VPK fingerprint and the generator version equal the
  current ones and `--force` is not given; the stage then rebuilds only items whose input key changed
  (`ctx.inputKey(parts)`: the VPK fingerprint, `GENERATOR_VERSION`, the stage and whatever else changes its output).
  The entries of stages that do not run, and the map entries of folders that `--maps` does not select, carry over
  whenever the VPK fingerprint is the same, so `--force --stages maps` keeps the model items. After a generator
  bump they are kept with a warning naming the stages to rebuild; built from other VPKs they are dropped, again
  with a warning.

## Layout and manifest

```
<pack>/
  manifest.json                    v1 (contract 2.3)
  maps/<folder>/props-stock.glb    maps stage (M3-props)
  models/<path minus .mdl>.glb     models stage (phase 3)
  textures/<path minus .vtf>.dds   later (phase 2)
  reports/<stage>/<name>.json      build stats, never read at runtime
  .dribble-asset-pack              marks the folder as a pack
```

`lib/manifest.mjs` creates, reads, validates, merges and writes the manifest. The top-level keys follow the order
of contract 2.3 (`format`, `version`, `generator`, `builtFrom`, `options`, `maps`, `items`), map entries and items
put their contract keys first, and every other object is sorted by key. The manifest has no timestamps and no
absolute paths, so equal inputs give equal bytes. `builtFrom.fingerprint` is the sha256 of the canonical JSON
(sorted keys, no whitespace) of `builtFrom.vpks`, whose records hold each directory file's size, tree CRC32,
archive count and total archive bytes, never mtimes. `generator.commit` is the HEAD of the checkout that ran the
build, so packs built from two commits differ in that one line.

## Writing a stage

A stage is `scripts/assets/<stage>/stage.mjs` exporting `async run(ctx)`. It may return an object, which goes into
`reports/build/last-build.json`.

| `ctx` field | |
|---|---|
| `vpk` | the VPK set: `has(path)`, `read(path)` (CRC checked), `readHead(path, n)`, `stat(path)`, `list(prefix)`, `fingerprint()` |
| `out`, `tmp`, `checkout` | pack dir, this stage's scratch dir, the repository checkout |
| `options` | `{ stages, maps, bspDir, force, set, bspToGlb }`; `force` is true when this stage must rebuild everything (`--force`, other VPKs or another generator version) |
| `manifest`, `previous` | the manifest being built (carry-over included) and the previous valid manifest or null |
| `stagePath(rel)`, `writeFile(rel, data)` | where to write pack file `rel`; it is moved into place at the end |
| `setMap(folder, entry)`, `removeMap(folder)` | manifest `maps` entries; `sizes` are taken from the staged file, else filled from the pack file when missing |
| `addItem(key, item)`, `removeItem(key)` | manifest `items`, with `stage` set to this stage; `bytes` and `sha256` are taken from the staged file, else filled from the pack file when missing |
| `setOptions(obj)` | this stage's entry of manifest `options` (only what changes output) |
| `inputKey(parts)`, `hasPackFile(rel)` | incremental builds |
| `publicMapInfo(folder)` | `mapName`, `props` and the whole public `conversion.json` of a map folder |
| `log`, `generatorVersion`, `fingerprint` | |

Put timings in the stage's return value or in `reports/<stage>/`, not in the manifest: `check-determinism.mjs`
compares the manifest byte for byte. Contract 2.3 still lists `ms` among the map `stats`, which would break that;
the orchestrator was asked to amend it so map timings go to `reports/<stage>/`.

## Viewmodels stage

`viewmodels/stage.mjs` (contract 13) builds the c_arms model of each class and the c_model weapons that TF2
bone-merges onto them, from `viewmodels/list.mjs` (arms paths and item def indices). Weapons are resolved through
the item schema, `--set itemsGame=<items_game.txt>` (default `<tf dir>/scripts/items/items_game.txt`); without one
only the arms are built. The arms sequences follow Source's virtual-model order, so `sequences[i]` is the
networked sequence index. `reports/viewmodels/summary.json` lists skipped defs, unsupported textures and the
bytes per class. Other options: `viewmodelClasses=[...]`, `textureMaxSize` (arms, 1024), `weaponTextureMaxSize`
(512).

## Libraries

- `lib/vpk.mjs`: VPK v1 and v2 directory files, split archives, data embedded in `_dir.vpk`, preload bytes, CRC32
  checks on every `read()`. `openVpkSet(files)` is the search path, `locateTf2Vpks(tf2, hl2)` finds the four files.
  Indexing the four directory files takes about 0.5 s.
- `lib/vmt.mjs`: `parseVmt(text)` and `resolveMaterial(source, name, searchDirs)` with the rules of contract 2.6.
  Keys are case-insensitive and the last one in a block wins. The PC DirectX 9 path at DX level 95 with HDR and
  sRGB applies `>=dx90`, `>dx90_20b`, `srgb?`, `!360?`, `GPU>=n?` and the material's own `<shader>_dx9` and
  `<shader>_hdr_dx9` fallback blocks, and skips `<dx90`, `360?`, `ps3?`, `GPU<n?`, `lowfill?`, `_dx8` and older
  fallback blocks and blocks named after another shader. A key in an applying block overrides the same key outside
  it. Unquoted `[.25 .5 1]` vectors are values; `[$X360]` after a pair is a platform condition. `patch` materials
  apply `insert` (add or overwrite) and then `replace` (existing keys only) to the raw tree of the include, nested
  blocks merged recursively, before conditions are evaluated: bsp-to-glb's order (`src/materials.rs`) and
  Source's. Contract 2.6 still says "replace then insert"; the orchestrator was asked to amend it. In a patch of a
  patch the outer patch applies last and wins, as in Source (bsp-to-glb accumulates the chain outer first). `vmtAlpha(params)` gives `test` only with `$alphatest`
  (cutoff `$alphatestreference`, default 0.5), `blend` only with `$translucent`, else `opaque`.
  `vmtBaseTexture(params)` gives the `.vtf` path, and a material without one draws `NEUTRAL` (`#8a8a8a`).
- `lib/vtf.mjs`: VTF 7.0 to 7.5 headers (format, flags, frames, faces, depth, mips, low-res thumbnail, resources),
  `vtfReflectivity` with the validity rule of `scripts/lib/static-props.mjs`, and `vtfMipLayout`, the byte offsets
  of the high-res mip chain that the phase-2 DDS rewrap will slice.
- `lib/model-export.mjs`: `exportStudioModel` reads a model and its `.vvd`, `.dx90.vtx` (else `.dx80`, `.sw`),
  `.ani` and optionally `.phy` from the VPKs into a work dir and runs `bsp-to-glb --studio-*`. `postProcessModel`
  keeps LOD 0, removes clips that `keepClip` (boolean, RegExp, list of names or function) rejects, drops default
  `mesh.weights` (empty or all zero; non-zero weights stay), drops textures, prunes with leaves and extras kept (bones and attachment nodes stay), copies the
  studio facts (attachments, sequences, skins, bodygroups, include models) into `extras.dribble.studio` and runs
  plain `meshopt` (level `high`, as `static-props.mjs`). It never runs the full `optimize`.
  For phase 3: meshopt's quantization gives each mesh of a skinned model its own skin, so `models/player/heavy.mdl`
  has 1 skin before the post stage and 7 after it. A runtime that binds one skeleton per skin pays for that.
- `lib/manifest.mjs`, `lib/fsutil.mjs` (atomic writes, sha256, the out-dir rules), `version.mjs`
  (`GENERATOR_VERSION`; bump it when output changes).

## Checks and tools

| command | what it checks |
|---|---|
| `node scripts/assets/check-determinism.mjs <packA> <packB> [--include-reports] [--ignore-timing] [--json f]` | file lists and sha256 of two packs; exit 1 with the differing files. Skips dot entries and `reports/` unless `--include-reports`. For differing JSON it lists the JSON paths; `--ignore-timing` accepts files whose only differences are `ms`, `*Ms` or `seconds` keys. |
| `node scripts/assets/tools/vpk.mjs stats\|list\|extract\|verify --tf2 <dir>` | entry counts, tree CRCs and the fingerprint; listing; extraction; CRC check of every entry under a prefix |
| `node scripts/assets/tools/check-vpk-read.mjs --tf2 <dir> --reference <vpk.py> --tmp <dir>` | 20+ sampled reads (spread over archives, the largest entry, the last archive of each file) against a second reader, byte for byte |
| `node scripts/assets/tools/test-vpk.mjs --tmp <dir> [--reference <vpk.py>]` | synthetic v1 and v2 files with split archives, embedded data, preload bytes and a bad CRC |
| `node scripts/assets/tools/vmt-survey.mjs --tf2 <dir> [--vpk tf/tf2_misc_dir.vpk] [--out f]` | parses every VMT of one VPK; counts conditionals, repeated and missing `$basetexture`, patches, alpha kinds; exit 1 on any exception |
| `node scripts/assets/tools/test-vmt.mjs` | the VMT rules on hand-written materials, patches included |
| `node scripts/assets/tools/vtf-survey.mjs --tf2 <dir>` | every VTF header, and the computed mip-chain size against the file size |
| `node scripts/assets/tools/export-model.mjs --tf2 <dir> --model <mdl> --work <dir> --out <glb>` | one model through the export and the post stage |
| `node scripts/assets/tools/test-build.mjs --tf2 <dir> --base <dir outside git and /tmp>` | the builder end to end: refusals, empty builds, fixture builds twice, incremental rebuild, planted failure, `--force`, failures in the last step (unwritten listed file, absolute path in stats) with replaced files staged, `--force` of one stage, a rewritten carried map file, SIGINT |

`tools/fixture-stages/` holds a `models` stage that exports real models through `lib/model-export.mjs` and a `maps`
stage that writes placeholder GLBs with real manifest map entries. They load only through `--stage-dir` and exist
for tests; never serve a pack built with them.

## Determinism (measured 2026-11-02)

- Two builds without stages: identical manifests (`check-determinism` exit 0).
- Two fixture builds (6 models, 2 map entries), one with the scratch dir elsewhere: identical.
- All 77 `models/buildables/` models built twice: 72 exported (the 5 sappers are MDL version 47, which the
  current bsp-to-glb refuses; A0-exporter fixes that), 73 files identical. All 326 `models/weapons/c_models/`
  models: 323 exported (3 fail with "MDL sequence layer start is not finite"), 324 files identical, 29 to 34 s.
- So bsp-to-glb's studio export, the gltf-transform post stage and meshopt gave byte-identical output on these
  inputs. `reports/build/last-build.json` differs between builds by its timings and is skipped by default.
