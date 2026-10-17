# Highlander maps without game assets: bsp-to-glb pipeline

Status: prototype done, verified on all 11 HL BSPs. Nothing in `src/` was changed. Nothing was committed.

## TL;DR

- **Recommendation: replace BSPSource → VMF → Blender/Plumber → chunk → lightmap-inject with
  Hona/bsp-to-glb plus a small Node post-process.** It reads the compiled BSP directly. One map
  takes 6–13 s, and the output is 1.2–4.4 MB per map instead of 14–46 MB.
- **Upstream bsp-to-glb fails on all 11 maps**, because its error handling fails closed. Two small patches fix
  it (`scripts/bsp-to-glb/*.patch`). With them, **all 11 maps convert**. The output passes glTF-Validator with
  0 errors and 0 warnings. It loads in three.js. It renders correctly in headless Chromium with baked lightmaps and
  per-material flat colours.
- **Alignment is exact.** A demo position plus `world.boundaryMin` gives the Source position. Demo `m_WorldMins` is
  the BSP worldspawn `world_mins`. In `1434434.dem`, 29 respawns land on `info_player_teamspawn` XY origins with
  0.0-unit error. The GLB is in absolute Source units (glTF axes), so **World.tsx can keep its placement as it is**:
  rotation `[π/2,0,0]`, position `-boundaryMin`.
- **Brush entities stay separate nodes** (`model_<N>_<class>[_<targetname>]`). The demo-to-GLB join key is the
  brush model index `*N`, which parser-probe.md §9 confirms.
- **map-meta.json v1** was produced for all 11 maps. It holds spawns, control points, capture areas, payload path
  chains with checkpoint distances, cart models, doors, respawn rooms and visualizers, resupply, items, teleports,
  sun and ambient light, shadow direction, sky, fog, water, round timers, game mode, and an automatic RTS camera.
- **The in-browser path is feasible.** The library compiles to `wasm32-unknown-unknown` without code changes. A
  100-line wasm-bindgen wrapper converts pl_vigil in 7.5 s in Node, and its geometry is byte-identical to native.
  Estimated effort: about 2–3 days.
- **Biggest remaining gap: static props.** Each map has 549–1887 props and none have geometry without assets. On
  some maps up to a third of them are embedded in the BSP PAK (proot 36%, tetsudo 28%, ashville 20%), and
  bsp-to-glb's StudioModel export converts those (tested). That work is phase 2.

## 1. bsp-to-glb (Hona, MIT, Rust 2024)

Pinned at `7b7f7fc803b65e53791d3fc6eab04c0a2e355c6c` (main, tag `poc-final-2026-07-16`). There are **no tagged
release archives** (the releases API is empty), so it has to be built from source. `cargo build --release` takes
about 22 s with `CARGO_BUILD_JOBS=4` on Rust 1.88.

CLI (`src/main.rs`): `--bsp`, `--out`, `--lightmap-set auto|ldr|hdr|none`, `--lightmap-atlas`,
`--lightmap-manifest`, `--atlas-width`, `--material-manifest`, `--material-mount-plan`, `--texture-output`/
`--texture-manifest` (VTF→PNG), `--entities-out`, `--visibility-out`, `--props-out`, `--decal-overlays-out`,
`--collision-out`, `--physics-manifest/--physics-binary`, `--pak-output/--pak-manifest`, and `--studio-*`
(MDL/VVD/VTX → GLB).

Output formats, as found in `src/lib.rs`:

| Output | Content |
|---|---|
| GLB nodes | One node per BSP model: `worldspawn`, `model_<N>_<classname>[_<targetname>]`. `matrix` = entity origin/angles. Vertices are model-local in glTF axes `(x, z, -y)` of Source. Node extras: `bspModelIndex, entityIndex, classname, targetname, initiallyRendered, sourceMins/Maxs, entityOrigin/Angles, startDisabled, rendermode`. Also mesh-less `static_prop_<i>` and `dynamic_prop_<entity>_<name>` nodes, which are references only. |
| Primitives | Grouped by (material, hasLightmap, surface-rendered, triangulation, texinfo flags, displacement). Attributes: `POSITION, NORMAL, TEXCOORD_0` (texture UV), `TEXCOORD_1` (lightmap UV, atlas-normalised, luxel-centred) and `_DISPLACEMENT_ALPHA`. Extras: `bspFaceIndices`, `bspFaceVertexCounts`, styles, `surfaceFlags`, `surfaceInitiallyRendered`, `initiallyRendered`, `visibilityChunkIndex`. **Sky, nodraw, trigger, hint and skip faces are kept but flagged**, not removed. |
| Materials | One per texdata entry (plus decal materials), `baseColorFactor` white, no textures. Extras: `sourceMaterial`, shader family (PAK VMTs only), additive, proxies. |
| Lightmap | PNG atlas, RGBA = raw `ColorRGBExp32` (decode: `rgb * 2^int8(a) / 255`, linear), rows packed without padding, `.bump-0..2.png` directional atlases. The manifest (`https://tf2jump.xyz/schemas/bsp-lightmaps/v1`) lists per-face atlas rects, styles and offsets. Auto mode prefers HDR. |
| Entity graph | `bsp-to-glb.entity-graph` v1. Entities keep BSP order: `{index, classname, bspModelIndex, keyValues[], connections[]}` with parsed I/O. |
| Visibility | `bsp-to-glb.visibility` v2: planes, nodes (`worldHeadNode` = 0 on all 11 maps), leaves (cluster, bounds), PVS bitsets, exact world-face→leaf/cluster sets from LEAFFACES, chunk = primitive ownership. dribble's `MapVisibilityMetadata` v2 (sampled chunk boxes) can be derived exactly from it (done in §3). |
| Props | `bsp-to-glb.props`: sprp v10 instances (model path, origin, angles, solidity, fade, leaves) and dynamic prop key/values. No geometry. |
| PAK | Bounded zip reader (LZMA entries ok). `--pak-output` extracts `materials/**.vmt/vtf`. VTF 7.0–7.5 decode supports DXT1/3/5, BGR(A)8888 and others. |

### 1.1 Upstream result on the 11 HL BSPs (no game dirs)

All 11 fail. Each failure is one of the following:

1. **Every map (11/11).** `Patch VMT materials/maps/<map>/..._x_y_z.vmt includes unavailable dependency
   materials/....vmt`. VBSP cubemap patch materials include stock VMTs that are not mounted. The material manifest
   is always built, even without `--material-manifest`, so the whole export aborts.
2. **Multi-style lightmaps (5/11).** `face N uses multiple light styles [32, 33]` / `[0, 33, 32]` on ashville,
   product, warmtic, upward and vigil. These come from switchable named lights. pl_vigil, for example, has
   `__vis_disp_off` (style 32, on) and `__vis_disp_on` (style 33, starts dark).
3. **NaN displacement alpha (1/11).** pl_eruption_b15 DISPINFO 56 has 2 verts whose blend alpha is NaN. The
   positions are finite, and the engine renders the map fine.

All lumps in all 11 maps are LZMA-compressed (bspzip -repack). bsp-to-glb handles that, so Node-side lump
parsing is not needed.

### 1.2 The patch (`scripts/bsp-to-glb/0001-*.patch`, `0002-*.patch`, about 460 added lines incl. tests)

Committed on branch `dribble-assetless` in the scratch clone only (nothing in dribble.tf). `git apply --check`
against the pinned commit is clean.

- `--allow-unresolved-patch-includes true`. A missing Patch include becomes an `unresolvedAssets` entry with
  role `patchInclude` and `metadata: null`. The library API gains `MaterialBuildPolicy` and
  `build_source_material_{manifest,package}_with_policy`.
- `--lightmap-styles strict|first|all|N,N,...` (`ExportOptions::lightmap_styles`). It sums the decoded
  ColorRGBExp32 samples of the selected styles per luxel, flat and bump channels alike, re-encodes them, and records
  `composedStyles` in the manifest. The default stays `strict`. The converter passes styles 0–31 plus every named
  light whose `spawnflags & 1` is clear (its initial state).
- `materials[].extras.sourceReflectivity`: texdata reflectivity, which is the compile-time average linear albedo
  of `$basetexture`. **This is the flat colour source, and it exists for every material, stock ones included.**
- Non-finite **displacement alphas** become 0 and are counted in `stats.sanitizedDisplacementAlphas`. Non-finite
  positions still fail closed.
- New bin `vtf-to-png <in.vtf> <out.png>`, used for PAK-embedded skybox faces.
- Tests: 137 pass, including new composition and patch-include tests. The one golden GLB hash was updated for the
  new extra. `cargo fmt` is clean. The only clippy errors are the same 3 that exist upstream with clippy 1.88.

**Where it lives.** `scripts/setup-bsp-to-glb.mjs` clones `https://github.com/Hona/bsp-to-glb` into **`../bsp-to-glb`**
(override with `--dir` or `BSP_TO_GLB_DIR`). It checks out the pinned commit on a local `dribble` branch, applies
the patches with `git am`, runs `cargo build --release --locked`, and verifies that the patched flags exist. It was
tested end to end into the scratchpad (23 s). Long term: send the 2 patches upstream as a PR to Hona, then pin a
release archive by SHA-256 as described in bsp-to-glb's `docs/DRIBBLE_RELEASES.md`.

## 2. How dribble.tf consumes maps today (findings)

- `World.tsx` loads `/models/maps/<folder>/textured_compressed.glb`. The folder comes from `MAP_NAME_SEARCH_MAP`
  by prefix. World.tsx hides tool materials by name and `team_control_point*` nodes, forces
  `material.vertexColors = false`, freezes matrices, and places the group at `rotation [π/2,0,0]` and
  `position = -bounds.min`. `parseMapBoundaries` gives `center = ((max-min)/2, …, -min.z-41.5)`, and the formula
  in World.tsx reduces exactly to `-boundaryMin`.
- **Lightmaps are not applied at runtime.** No code in `src/` references `lightMap`. `inject-glb-lightmaps.mjs`
  adds TEXCOORD_1 and an unbound atlas image that nothing uses. Old maps are lit by `Lights.tsx` (ambient plus 2
  directional lights at a fixed `[100,100,100]`) and by IBL from `Skybox.tsx` (`scene.environment`).
- `conversion.json` is read by `fetchMapWorldBounds` for `worldBounds`, by `Lights.tsx` for `lightEnvironment`
  (ambient and sun colour/brightness heuristics only, no direction), and for nothing else.
  `worldBounds` = worldspawn `world_mins/maxs` (`update-map-bounds.mjs`, `convert-map.mjs`).
- `OVERWRITE_MAP_BOUNDARIES` holds hand-tuned `rtsCenter`/`cameraOffset`. `rtsCenter` is relative to
  `worldBounds.boundaryMin` (`translatePointBetweenBoundaryMins`). When an override exists, `ParseWorker` shifts
  every position by `world.boundaryMin - override.boundaryMin`.
- `visibility.json` (`MapVisibilityMetadata` v2) is only used when `mapChunking.json enabled` is true (it is
  false). It needs `chunk_<i>_<j>` nodes, and chunk→cluster is sampled at chunk-box corners.
- `getMapSkyboxUrls` reads `/models/skybox/<sky>/<sky>_{lf,rt,ft,bk,up,dn}.png` from `MAP_SKYBOX_MAP`. The faces are
  raw VTF faces, and 2:1 side faces get stretched.

## 3. Prototype converter: `scripts/convert-bsp.mjs` (+ `scripts/lib/map-meta.mjs`)

```bash
node scripts/setup-bsp-to-glb.mjs                       # once: ../bsp-to-glb, patched + built
node scripts/convert-bsp.mjs --bsp "$TF/maps/pl_vigil_rc10.bsp"   # → public/models/maps/pl_vigil_rc10/
#   [--map name] [--out-dir dir] [--chunk-grid 4] [--lightmap-format webp|png] [--meshopt true|false]
#   [--lightmap-floor 0.015] [--skybox-dir public/models/skybox] [--bsp-to-glb bin] [--keep-temp true]
```

Node dependencies are already in `node_modules` transitively through `@gltf-transform/cli`: `@gltf-transform/{core,
extensions,functions}`, `meshoptimizer` and `sharp`. They should be declared as devDependencies. Suggested
`package.json` scripts: `"setup:bsp": "node scripts/setup-bsp-to-glb.mjs"` and
`"convert:bsp": "node scripts/convert-bsp.mjs"`.

Steps:
1. bsp-to-glb pass 1 writes `--entities-out` and `--pak-output`. The script computes the enabled light styles
   (0–31 plus named lights that do not start dark).
2. bsp-to-glb pass 2 writes the GLB, lightmap atlas and manifest, and the visibility and material sidecars. It
   runs with `--allow-unresolved-patch-includes true --lightmap-styles <list>`.
3. Post-process with gltf-transform. Each face is split back out using `bspFaceVertexCounts`.
   - **Drop** a primitive when `!surfaceInitiallyRendered` (sky, sky2d, nodraw, trigger, hint, skip flags) or when
     its basename matches `tool(s)invisible*|nodraw|clip|trigger|areaportal|hint|skip|skybox|fog|blocklight|
     block_los|blockbullets|occluder…`. `toolsblack` is kept. Also drop hidden brush classes (`trigger_*`,
     `func_respawnroom`, `func_regenerate`, `func_nobuild`, areaportals, occluders, nogrenades and similar) and
     entities with `initiallyRendered=false`.
   - **Classify** each surface as `opaque`; `translucent` (texinfo `SURF_TRANS` 0x10, BLEND/MASK in a PAK VMT, or
     a glass/window name, alpha 0.3; cutout names like chicken_wire, fence or grate, alpha 0.55); `water`
     (`SURF_WARP` 0x8, fixed dark teal, alpha 0.65, double-sided); `unlit` (no lightmap or `SURF_NOLIGHT`;
     near-zero reflectivity becomes light-panel white); or `visualizer`.
   - **Colour**: `COLOR_0` = `sourceReflectivity`, linear, clamped, with toolsblack set to 0. Translucent kinds
     use VEC4 with the alpha above.
   - **Lightmap UV**: TEXCOORD_1 is renamed to **TEXCOORD_0**. Texture UVs and displacement alpha are dropped.
   - **3D skybox**: faces whose world-space centroid lies outside `world_mins/maxs ± 64` go to node `skybox_3d`.
     VBSP computes those bounds excluding sky areas. That node carries the in-game transform `(p - sky_camera) ×
     scale`, its brush-entity faces are baked to world space, and it has `extras.dribble.hiddenByDefault`.
   - **Chunks**: worldspawn faces are bucketed on an N×N XY grid over world bounds into `chunk_<i>_<j>` parent
     nodes, each with a `<name>_mesh` child. The mesh sits on a child because quantize() folds its dequantisation
     transform into the mesh node, and this keeps the named parents' transforms clean.
   - **Brush entities**: `model_<N>_<class>[_<target>]` parent node (entity matrix) plus a `_mesh` child. Extras:
     `dribble = {kind:'brushEntity'|'respawnVisualizer', classname, targetname, parentname, team, bspModelIndex,
     entityIndex, origin, angles, localMins, localMaxs, hasGeometry}`. **func_door\*, func_movelinear,
     func_tracktrain, func_train, func_rotating, func_brush, func_wall_toggle and func_respawnroomvisualizer always
     get a node, even when they have no visible faces.** Many spawn doors and the cart are props, so these nodes
     serve as anchors for placeholders and movers. Visualizers keep their `overlays/no_entry` faces (which compile
     with SURF_TRIGGER) as a team-tinted translucent mesh with `hiddenByDefault`.
   - **Materials** collapse to at most 7 shared ones: `dribble_{opaque,translucent,water,unlit,visualizer}[_lit]`,
     with `extras.dribble = {kind, lightmap, hiddenByDefault?}`; unlit ones use `KHR_materials_unlit`.
   - **Compression**: `meshopt` level high plus quantize with `quantizationVolume:'scene'` (one grid, so chunk
     seams stay closed), 16-bit positions, 8-bit normals, 16-bit lightmap UVs (0.06 px) and 12-bit colours. This
     needs `EXT_meshopt_compression` and `KHR_mesh_quantization`. `--meshopt false` gives quantize only, which is
     about 3× bigger and needs no decoder.
4. **Lightmap atlas.** Decode RGBE to linear. Multiply by exposure, where exposure = `clamp(1.25 / p90 luminance,
   0.5, 2)` (TF2-like auto-exposure range, 0.5–2.0 on these maps). Add a 0.015 floor, divide by `range = 4`, encode
   sRGB, and write 8-bit RGB **lossless WebP** (lossy would bleed between unpadded atlas rects). Bump atlases are
   not used.
5. **visibility.json**, dribble v2 format, **exact**. Chunk clusters = OR of `worldFaceClusterWords` over the
   chunk's faces. `visibleChunksByCluster[c]` = chunks that intersect PVS row c. planes/nodes/leafClusters are
   copied as is.
6. **Skybox.** If `public/models/skybox/<skyname>` exists, it is used. If not, and the PAK has
   `materials/skybox/<sky>{bk,dn,ft,lf,rt,up}.vtf`, the faces go through `vtf-to-png` →
   `public/models/skybox/<sky>/<sky>_<side>.png`, with 2:1 side faces padded to square using the bottom-row colour.
   Otherwise conversion.json records a fallback.
7. **map-meta.json** (§6) and **conversion.json**: `pipeline:'bsp-to-glb'`, converter version, `worldBounds` (from
   `world_mins/maxs`), `files{model, lightmap, visibility, meta}`, `lightmap{file, width, height, set, exposure,
   floor, range, colorSpace:'srgb', uvChannel:0, enabled/dark named styles}`, `lightEnvironment` (the old
   Lights.tsx shape plus `direction`), `fog`, `skyboxName`/`skybox{source, fallback}`, `camera`, `chunking`,
   `visibility`, `stats`, per-material `{kind, triangles, albedo}`.

### 3.1 Results on all 11 maps

Outputs are in `scratchpad/converted/<map>/` (world.glb, lightmap.webp, visibility.json, map-meta.json,
conversion.json) and `scratchpad/skybox-out/<sky>/`. Timings are pass 1 (entities + PAK) and pass 2 (render
export). The whole script takes 5.7–12.6 s per map, about 95 s for all 11.

| map | BSP MB | mode | pass1 ms | pass2 ms | world.glb MB | lightmap MB | vis MB | meta | tris | entity nodes/with geometry | skybox faces | static props | sky |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| cp_steel_f12 | 22.8 | attack-defend | 2545 | 1815 | 1.22 | 0.90 (4096x1135, exp 1.37) | 0.87 | 44 KB | 61,767 | 382/230 | 29 | 1455 (654 solid) | sky_dustbowl_01, existing |
| koth_ashville_final1 | 38.1 | koth | 2768 | 2500 | 0.41 | 0.47 (4096x572, exp 2) | 0.22 | 12 KB | 23,243 | 89/79 | 9 | 1045 (558 solid) | sky_midnight_01, from PAK |
| koth_product_final | 17.3 | koth | 1615 | 1250 | 0.83 | 0.57 (4096x1003, exp 0.60) | 0.51 | 11 KB | 55,986 | 157/150 | 0 | 942 (410 solid) | sky_trainyard_01, existing |
| koth_proot_b5b | 21.3 | koth | 1709 | 1487 | 0.50 | 0.43 (4094x645, exp 1.52) | 0.23 | 14 KB | 36,521 | 57/51 | 48 | 549 (307 solid) | sky_eveningtoast_01, from PAK |
| koth_warmtic_f10 | 17.7 | koth | 1680 | 1346 | 0.54 | 0.58 (4096x869, exp 0.94) | 0.33 | 12 KB | 38,777 | 35/31 | 8 | 1078 (473 solid) | sky_trainyard_01, existing |
| pl_divulgence_b4b | 23.2 | payload | 2484 | 1844 | 1.18 | 0.93 (4096x1460, exp 1.86) | 0.87 | 51 KB | 74,560 | 187/172 | 67 | 1592 (458 solid) | sky_badlands_01 missing, fallback sky_dustbowl_01 |
| pl_downfall_b13 | 38.1 | payload | 3628 | 2837 | 1.91 | 1.26 (4096x1807, exp 2) | 1.06 | 64 KB | 291,874 | 99/73 | 5 | 1887 (855 solid) | sky_badlands90_01, from PAK |
| pl_eruption_b15 | 34.8 | payload | 3486 | 2669 | 1.72 | 0.97 (4096x1287, exp 0.99) | 0.79 | 59 KB | 241,910 | 47/32 | 311 | 1597 (620 solid) | sky_tf2_04, existing |
| pl_upward_f12 | 24.1 | payload | 2160 | 1760 | 0.96 | 0.79 (4096x1356, exp 0.5) | 0.63 | 62 KB | 66,741 | 123/111 | 733 | 1107 (397 solid) | sky_upward missing, fallback sky_tf2_04 |
| pl_vigil_rc10 | 29.2 | payload | 3197 | 2463 | 1.05 | 1.51 (4096x2090, exp 1.08) | 0.83 | 62 KB | 88,689 | 95/73 | 385 | 1522 (409 solid) | sky_vigil_01, from PAK |
| tow_tetsudo_b10c | 32.5 | tug-of-war | 2335 | 2089 | 0.60 | 0.82 (4096x990, exp 0.5) | 0.40 | 42 KB | 49,687 | 44/21 | 0 | 1715 (614 solid) | sky_trainyard_01, existing |

Totals for all 11 maps: GLB 10.9 MB, lightmaps 9.2 MB, visibility 6.8 MB and meta 0.4 MB, about **27 MB**. The 4 skies
converted from PAK add 3.7 MB (as PNG). For comparison, the old textured GLBs are 14–46 MB **each**. Gzip shrinks
world.glb by about 45% and visibility.json by about 75%; WebP does not shrink further. Draw calls are 51–308 per map,
and there are 2–7 materials.

Verification:
- **glTF-Validator: 0 errors and 0 warnings on all 11.** The only infos are "EXT_meshopt not validatable" and
  "TEXCOORD_0 unused", because the lightmap is bound at runtime. The `--meshopt false` variant validates with no
  infos besides unused UVs.
- **three r0.163 GLTFLoader + MeshoptDecoder in Node** (`scratchpad/node-tools/three-check.mjs`). The script
  places the GLB exactly as World.tsx does. Scene bounds converted back to Source match `world_mins/maxs` within
  the 64-unit skybox margin. **A downward raycast from every `info_player_teamspawn` hits floor on 11/11 maps**
  (595/595 spawns), with a per-map median drop of 0–48 units. Most control point origins sit within 8 units of
  the floor.
- **Headless Chromium renders** (swiftshader, ACES like R3F, MeshBasicMaterial + lightMap, see §5) of top and RTS
  views for all 11 maps: `scratchpad/shots-maps/sheet_{top,rts}_{1,2}.png` and per map `*_top.png`/`*_rts.png`.
  Shadows line up with the geometry, so the lightmap UVs are correct.

### 3.2 Decisions on the points in the brief

- **Flat colours.** Texdata reflectivity is the authoritative average texture colour that VBSP computed from the
  VTF. It covers stock materials, and `sourceReflectivity` exposes it.
- **Tool/nodraw/sky/trigger filtering.** Texinfo flags do most of it. A name list catches the invisible-tool
  materials that are not flagged (for example `*/toolsinvisibledisplacement*`, which compiles as `SURF_TRANS`).
- **PAK custom textures: not for world surfaces in v1.** Only 12 of vigil's 241 materials have a PAK base texture
  (81/205 on ashville, 20/131 on tetsudo). Mixing textured and flat surfaces looks patchy and adds MB. PAK *is* used
  for skies (4/11 maps). It is worth revisiting later for overlays and signage, and for custom props (§8).
- **Bounds.** `worldBounds` comes from `world_mins/maxs` and is identical to the demo's `m_WorldMins/m_WorldMaxs`
  (`CWorld::KeyValue`). **Do not add `OVERWRITE_MAP_BOUNDARIES` entries for HL maps.**
- **Automatic camera** (map-meta `camera`, also copied to conversion.json). The focus depends on game mode: KOTH
  point; payload halfway from the cart start to the first checkpoint; tug-of-war centre; A/D first unlocked point;
  5CP middle point; otherwise the centre of the bounds. Offset distance is `clamp(0.22·span, 1400, 3200)` at 58°
  elevation, perpendicular to the long axis. The converter then raycasts the focus→camera segment against world
  triangles, tries 58/66/74/82° on all 4 sides, and falls back to 82° for an enclosed focus (cp_steel A, divulgence,
  tetsudo centre). It is expressed exactly like `MapBoundaries.rtsCenter/cameraOffset`, relative to
  `worldBounds.boundaryMin`.

## 4. Coordinate alignment (verified)

- Demo world bounds equal BSP `world_mins/maxs` exactly: pl_vigil_rc10 is `(-3120,-4352,-1536)..(6656,8192,324)` in
  both. `m_WorldMins` comes from the worldspawn keyvalue (`world.cpp:432`), and VBSP's `ComputeBoundsNoSkybox`
  writes that keyvalue.
- `1434434.dem` was parsed with the committed parser2 (`scratchpad/tools/spawn-align3.mjs`). Respawn teleports
  were matched to `info_player_teamspawn`: **29 respawns at XY error 0.000–0.5 units**, with z = spawn z − 15.9
  (the player drops to the floor; for example kanon `(-712,760,-575.88)` vs spawn `(-712,760,-560)`). The demo train
  origin `(64.03,128,-624)` in parser-probe.md §8.1 equals the BSP `func_tracktrain` origin `64 128 -624`.
- **Placement rule.** The GLB is in absolute Source units, glTF axes `(x, z, -y)`. Keep World.tsx as is: group
  `rotation=[π/2,0,0]` (glTF→Source axes), `position=-scene.bounds.min`. Use the **demo's** boundaryMin (or the
  override, when one exists), which ParseWorker also subtracts from positions. This holds for any map version whose
  geometry did not move. Scene = Source − boundaryMin, and Source axes equal scene axes, so a brush entity node,
  which lives in glTF space under the rotated group, moves by Source delta `(dx,dy,dz)` as
  `node.position += (dx, dz, -dy)`.
- All 133 HL demos use exactly these 11 BSP versions (65 are pl_vigil_rc10).

## 5. Runtime integration (concrete changes, about 150 lines in total)

1. **`src/components/Scene/World.tsx`**
   - `new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)` (`three/examples/jsm/libs/meshopt_decoder.module.js`).
   - Fetch conversion.json once per map. Ideally use a shared cached `fetchMapConversion(map)` in `utils/game.ts`,
     because Lights.tsx and actions.ts already fetch it. If `pipeline === 'bsp-to-glb'`, load `files.model`
     (`world.glb`) and `files.lightmap`.
   - Lightmap texture: `flipY=false`, `colorSpace=SRGBColorSpace`, `channel=lightmap.uvChannel` (0),
     `generateMipmaps=false`, `min/magFilter=LinearFilter`. The atlas has no padding, so mipmaps would bleed.
   - Replace materials by `userData.dribble.kind`. Use one shared material per kind:
     `new MeshBasicMaterial({vertexColors:true, lightMap: d.lightmap ? lm : null, lightMapIntensity:
     lightmap.range*Math.PI /* three divides lightmaps by π */, transparent: kind!=='opaque'&&kind!=='unlit',
     depthWrite: !transparent, side: water||visualizer ? DoubleSide : FrontSide})`. This exact code is in
     `scratchpad/render/index.html`.
   - For this pipeline, **skip** `INVISIBLE_TOOL_MATERIALS`, `isInvisibleEntityNode`, and especially
     `material.vertexColors = false`, because vertex colours are the albedo. Set `visible=false` for `skybox_3d`
     and for meshes whose material is `hiddenByDefault` (visualizers). Settings toggles can come later.
   - `untextured` mode: `MeshLambertMaterial({vertexColors:true})`. `wireframe` mode stays as it is.
   - `freezeStaticMapSubtree` turns off `matrixAutoUpdate`. Movers (doors, trains) must turn it back on or call
     `updateMatrix()` themselves.
2. **`src/constants/mappings.ts`.** Add `MAP_NAME_SEARCH_MAP` entries: `cp_steel→cp_steel_f12`,
   `koth_ashville→koth_ashville_final1`, `koth_proot→koth_proot_b5b`, `koth_warmtic→koth_warmtic_f10`,
   `pl_divulgence→pl_divulgence_b4b`, `pl_downfall→pl_downfall_b13`, `pl_eruption→pl_eruption_b15`,
   `pl_upward→pl_upward_f12`, `pl_vigil→pl_vigil_rc10`, `tow_tetsudo→tow_tetsudo_b10c`. Add `MAP_SKYBOX_MAP`:
   steel `sky_dustbowl_01`, ashville `sky_midnight_01`, proot `sky_eveningtoast_01`, warmtic `sky_trainyard_01`,
   divulgence `sky_dustbowl_01` (fallback), downfall `sky_badlands90_01`, eruption `sky_tf2_04`, upward
   `sky_tf2_04` (fallback), vigil `sky_vigil_01`, tetsudo `sky_trainyard_01`. A later cleanup could have the
   converter write `public/models/maps/index.json` and drop the hard-coded tables.
3. **`src/utils/game.ts` / `src/zustand/actions.ts` / `src/utils/scene.ts`.** `fetchMapWorldBounds` should also
   return `camera`. In `loadSceneFromDemoAction` / `loadEmptySceneMapAction` use
   `rtsCenter = saved ?? override.rtsCenter ?? conversion.camera.rtsCenter` and
   `cameraOffset = override.cameraOffset ?? conversion.camera.cameraOffset`, keeping the
   `translatePointBetweenBoundaryMins(rtsCenter, conversion.worldBounds.boundaryMin, scene.boundaryMin)` that
   already exists.
4. **`src/components/Scene/Lights.tsx`.** Keep the colour heuristics. Point the key light along the real sun:
   `keyDirection = lightEnvironment.direction.map(v => -v * 1000)` (scene axes = Source axes). This only affects
   players, projectiles and placeholders; the map itself is lit only by its lightmap.
5. Optional: `THREE.Fog` from `conversion.fog` (start/end) to soften the void around the maps. Enable chunk culling
   per map (`conversion.chunking`) instead of the global flag, since the visibility data is now exact.
6. Copy outputs: `node scripts/convert-bsp.mjs` for the 10 new maps writes into `public/models/maps/<map>/` and
   `public/models/skybox/`. **koth_product_final already has a textured GLB.** Running the converter into the
   same folder overwrites `conversion.json`, so either skip it or keep the old one.
7. AGENTS.md: document `setup:bsp` and `convert:bsp`, the `../bsp-to-glb` location and the patch files.

## 6. map-meta.json schema v1 (all 11 produced: `scratchpad/converted/<map>/map-meta.json`, 11–64 KB)

All positions are in **raw Source units, Z-up**. Scene = Source − `worldBounds.boundaryMin`.

```jsonc
{
  "schema": "dribble.map-meta", "version": 1, "map": "pl_vigil_rc10", "bspVersion": 20,
  "coordinateSpace": "source", "sceneTransform": "scene = source - worldBounds.boundaryMin",
  "worldBounds": { "boundaryMin": {x,y,z}, "boundaryMax": {x,y,z} },
  "gameMode": "koth" | "payload" | "payload-race" | "tug-of-war" | "attack-defend" | "control-points" | "unknown",
  "camera": { "rtsCenter": {x,y,z}, "cameraOffset": {x,y,z}, "focusSource": [x,y,z], "method": "...",
              "occlusion": { "clear": bool, "elevationDeg": n } },          // conversion.json copy has occlusion
  "spawns": [ { "team": 2|3, "origin": [x,y,z], "yaw": deg, "name"?, "controlPoint"?, "disabled"?, "roundRed"?, "roundBlue"? } ],
  "controlPoints": [ { "name", "index" (point_index), "printName", "origin", "defaultOwner", "startLocked", "group", "hidden",
                       "captureAreas": [indices into captureAreas] } ],
  "captureAreas": [ { "name"|null, "capPoint", "timeToCap", "canCap": {"2","3"}, "numCappers": {"2","3"}, "parent"
                      (e.g. the train for payload), "startDisabled", "bspModelIndex", "node", "mins", "maxs" } ],
  "koth": { "timerLength", "unlockPoint" } | null,
  "roundTimers": [ { "name", "timerLength", "setupLength", "maxLength", "startPaused", "showInHud" } ],
  "payload": [ { "watcher", "team", "train", "startNode", "goalNode", "canRecede",
                 "path": [ { "name", "origin", "distance" (cumulative), "next", "alt"?, "speed"?, "flags"? } ],
                 "length", "linked": [ { "pathTrack", "controlPoint", "pathIndex", "distance" } ],
                 "cart": { "origin", "brush": {bspModelIndex,node,mins,maxs}, "models": ["models/props_trainyard/bomb_cart.mdl"],
                           "attached": [ {classname,name} ] } } ],                 // parentname OR phys_constraint attach
  "doors": [ { "name", "classname", "origin", "moveDir" (unit vector), "lip", "speed", "spawnflags",
               "props": [door models parented to it], "bspModelIndex", "node", "mins", "maxs" } ],
  "respawnRooms": [ { "name", "team", "bspModelIndex", "node", "mins", "maxs" } ],
  "respawnVisualizers": [ { "room", "team", "solidToEnemies", "bspModelIndex", "node", "mins", "maxs" } ],
  "resupply": [ { "team", "locker", "bspModelIndex", "node", "mins", "maxs" } ],
  "items": [ { "kind": "health"|"ammo", "size": "small"|"medium"|"full", "origin", "team"?, "disabled"? } ],
  "teleports": [ { "name", "team"?, "destination", "mins", "maxs", ... } ],
  "gameplayProps": [ { "model", "name"?, "parent"?, "origin", "angles", "skin"? } ],  // lockers, carts, cap bases, door models
  "light": { "environment": { "sun", "sunHDR", "ambient", "ambientHDR" ({color[0-255], brightness}),
                               "pitch", "yaw", "sunSpreadAngle", "direction": [x,y,z] /* sunlight travel, VRAD SetupLightNormalFromProps */ },
             "shadow": { "direction", "color", "distance" } /* shadow_control */, "sunSprite": {...} | null },
  "sky": { "name", "camera": { "origin", "scale" } },
  "fog": { "enabled", "color", "start", "end", "maxDensity", "farZ" },
  "water": [ { "material", "triangles", "mins", "maxs", "surfaceZ" } ]
}
```

Notes:
- Game modes come out right on all 11: steel is A/D (5 points), 4 KOTH maps, 5 payload maps, and tetsudo is
  tug-of-war. In tug-of-war the cart areas let both teams cap. Payload watchers have `TeamNum 0` on these maps, so
  the team field cannot be used to detect the mode.
- Payload checkpoint distances (vigil: 2912/5243/8319/11623 of 11623 units) match
  `CTFObjectiveResource.m_flPathDistance` (0.251/0.451/0.718/1) from parser-probe.md. The HUD progress bar and the
  cart placeholder can use `path` directly.
- **Join demo entities to geometry by brush model:** network `m_nModelIndex` → `modelprecache` `"*N"` →
  map-meta/GLB `bspModelIndex N` → node `model_N_*`. That covers doors, the train, func_brush toggles
  (Enter/Leave = visible) and visualizers. Entity indices in the demo are *not* BSP entity order.
- The cart visual is a `prop_physics_override` bomb_cart tied to the train by `phys_constraint` (48 units below the
  train origin). The prop has no geometry, so render a procedural cart at the demo's CPhysicsProp origin and angles.

## 7. In-browser conversion (wasm32)

- `cargo build --lib --release --target wasm32-unknown-unknown` **compiles unchanged** in 15 s. Every dependency
  (zip/deflate/lzma, png, sha2, serde) is pure Rust, and `std::fs` is only touched by the CLI and mount resolver.
- Prototype wrapper `scratchpad/bsp-wasm` (wasm-bindgen 0.2.108, the same version as the parser fork) exposes
  `entityGraph(bsp) → json` and `convert(bsp, enabledStyles) → {glb, atlasRgbe, atlasWidth/Height,
  lightmapManifest, visibility, stats}`. Module size: 1.06 MB raw, 391 KB gzip, 298 KB brotli (no wasm-opt).
- Node run on pl_vigil_rc10: entityGraph 1.7 s, convert 7.5 s (native: 2.4 s), RSS about 570 MB. **Its GLB
  BIN chunk is byte-identical to the native one.** The JSON differs only in the last float bits of a few static-prop
  matrices, because wasm and native libm compute sin/cos differently.
- Blockers: none fundamental. Risks are peak memory (34 MB RGBA atlas, a 9.5 MB visibility JSON string, and the
  BSP plus decompressed lumps, so it is tight on mobile) and the fact that the user has to supply the `.bsp`.
  Options: drag-drop from `tf/maps`, or fetch `<fastdl>/maps/<map>.bsp.bz2`, which needs CORS and a bzip2 decoder.
- Effort, about 2–3 days:
  - Worker wrapper plus wasm-pack build into `src/libs/bsp2glb` like parser2 (0.5 d).
  - Port the post-process to the worker. It is the same logic as convert-bsp.mjs, minus sharp and meshopt; the RGBE
    decode goes straight to a `DataTexture`, and typed arrays are transferred instead of re-encoding a GLB (1 d).
  - `buildMapMeta` runs unchanged in the browser.
  - Cache results in IndexedDB through the existing `localforage` (0.5 d).
  - Return visibility as typed arrays to cut memory (0.5 d).

## 8. Things not covered yet (the "anything I've forgotten?" list)

1. **Static props have no geometry** (549–1887 per map, 307–855 solid). Players will sometimes stand on invisible
   crates or rocks, though their shadows are in the lightmap. Partial fix: models **embedded in the PAK** convert
   with `bsp-to-glb --studio-mdl … --studio-vvd … --studio-vtx …`; 25/25 proot models were tested OK. PAK models
   cover 0–473 instances per map: tetsudo 473, ashville 204, proot 196, eruption 145+56 dynamic, divulgence 105,
   vigil 94; steel 5, warmtic 0. They can be instanced from the sprp transforms. VHV per-vertex lighting is in the
   PAK too. Stock props stay missing. A fallback could draw grey origin markers for solid props. About 1.5–2 days.
2. **Spawn doors are mostly props.** func_door nodes are always emitted (bounds in `localMins/localMaxs` and
   map-meta `doors[]`), so procedural door slabs can be attached and moved with the demo's `CBaseDoor`
   origin/angles (parser-probe.md §9).
3. **Overlays and decals** (arrows, signs, cap letters, dirt) are not rendered. bsp-to-glb's `--decal-overlays-out`
   holds clipped fragments with lightmap UVs, and PAK textures could cover the custom signage.
4. **Displacement texture blending** (WorldVertexTransition) uses only the base texture's reflectivity. The second
   texture's colour is unknown unless it is in the PAK.
5. **The 3D skybox** is exported (`skybox_3d`, scale ×16 around sky_camera) but hidden. At ×16 it mostly lies
   beyond the 15000-unit far plane.
6. Light styles use their *initial* on/off state. Lights that toggle during a round (rare in comp) are not animated.
7. The default lightmap exposure is per-map automatic. Interiors read a bit dark under ACES, so a user brightness
   slider (`lightMapIntensity` multiplier) is cheap and useful.
8. **koth_product_final** gets a new flat version too (`scratchpad/converted/koth_product_final`). Decide whether to
   keep the old textured GLB.
9. Map versions: demos name exact BSP versions, and prefix lookup in `MAP_NAME_SEARCH_MAP` reuses a converted version
   for newer ones. That is safe because placement uses the demo's own `m_WorldMins`, as long as the geometry did not
   change between versions.
10. Fog, water and respawn visualizers are exported, but their rendering is toggles and settings for the frontend.

## 9. Files

Repo (uncommitted):
- `scripts/convert-bsp.mjs`: converter (prototype)
- `scripts/lib/map-meta.mjs`: map-meta builder; pure JS, so it can be reused in the browser and the worker
- `scripts/setup-bsp-to-glb.mjs`: clone, patch, build and verify bsp-to-glb
- `scripts/bsp-to-glb/0001-feat-support-asset-less-export-of-shipped-TF2-maps.patch`,
  `0002-feat-add-vtf-to-png-helper-binary.patch`
- `specs/highlander/maps.md`: this file

Scratchpad (`/tmp/claude-1000/-home-dalibor-programming-personal-dribble-tf/bbe6eb71-192d-40ae-b6da-70834234db27/scratchpad/`):
- `converted/<map>/{world.glb, lightmap.webp, visibility.json, map-meta.json, conversion.json}` and `converted/<map>.log`
  for all 11 maps; `skybox-out/<sky>/` for the 4 PAK skies; `converted-nomeshopt/pl_vigil_rc10` (quantize only)
- `bsp-to-glb/` (branch `dribble-assetless`, built); `setup-test-bsp/` (clean clone made by the setup script)
- `survey-strict/`, `survey-lenient/`, `survey-all/`: raw bsp-to-glb outputs (upstream, lenient only, patched)
- `bsp-wasm/` (wasm wrapper crate, `pkg/`, `test-node.mjs`)
- `node-tools/` (`three-check.mjs`, `validate.mjs`, `convert-all.sh`, `contact.mjs`, `meta-from-survey.mjs`);
  `render/` (`index.html`, `render.mjs`, `render-all.sh`); `shots-maps/` (screenshots and contact sheets)
- `tools/spawn-align3.mjs` (demo vs spawn alignment), `tools/bsp-lumps.mjs`, `tools/dispcheck.py`
