#!/usr/bin/env node
/**
 * convert-bsp.mjs — asset-less BSP → dribble.tf map package (prototype).
 *
 * Replaces the BSPSource → VMF → Blender/Plumber → chunk → lightmap-inject pipeline with
 * Hona/bsp-to-glb (direct compiled-BSP export, patched with scripts/bsp-to-glb/*.patch) plus a
 * Node post-process. Needs NO game assets: surfaces get their compile-time average albedo
 * (texdata reflectivity) as vertex colours and the BSP's own baked lightmap.
 *
 * Output (default public/models/maps/<map>/):
 *   world.glb        brush geometry; worldspawn split into chunk_<i>_<j> nodes, brush entities
 *                    (func_door, func_brush, func_tracktrain, ...) as separately addressable nodes,
 *                    optional skybox_3d node. Materials carry extras.dribble = { kind, lightmap }.
 *   lightmap.webp    sRGB 8-bit lightmap atlas (TEXCOORD_0 of lit primitives), exposure baked in.
 *   visibility.json  MapVisibilityMetadata v2 (exact PVS → chunk mapping) for World.tsx culling.
 *   map-meta.json    spawns, control points, capture areas, payload paths, doors, lights, sky...
 *   conversion.json  worldBounds, lightEnvironment (Lights.tsx shape), skybox, camera defaults,
 *                    files.props and props { pak, stock, stockSolid } (static prop counts).
 *   props.glb        static props whose models ship in the BSP's PAK (scripts/lib/static-props.mjs):
 *                    EXT_mesh_gpu_instancing nodes plus one merged batch, vertex colours = PAK texture
 *                    albedo x the PAK's per-vertex prop lighting. Stock props are game assets: not drawn.
 *   ../../skybox/<skyname>/<skyname>_<side>.png when the BSP PAK embeds the sky faces.
 *
 * All of it is staged in the temp dir and moved into place only after every step succeeded, each file
 * by rename and conversion.json last, so a failed run leaves the previous package as it was. The temp
 * dir is removed on success and on failure unless --keep-temp true.
 *
 * Usage:
 *   node scripts/convert-bsp.mjs --bsp <map.bsp> [--map <name>] [--out-dir <dir>]
 *        [--bsp-to-glb <binary>] [--chunk-grid 4] [--lightmap-format webp|png]
 *        [--meshopt true|false] [--skybox-dir public/models/skybox] [--keep-temp true]
 *        [--only-meta true] [--overwrite-sky true] [--props false]
 *
 *   --only-meta true runs both bsp-to-glb passes into the temp dir (the brush-model bounds and the
 *   camera occlusion test need the render export) but writes only map-meta.json. Used for maps that
 *   keep an older textured GLB and conversion.json, such as koth_product_final.
 *
 *   --props false skips the static-prop pass (no props.glb, no props fields in conversion.json).
 *
 *   PAK skies: when public/models/skybox/<skyname>/ already exists with different pixels (another map
 *   ships or uses the same sky name), it is left alone and this map's faces go to <skyname>_<map>/;
 *   point MAP_SKYBOX_MAP at that folder. --overwrite-sky true replaces the shared folder instead.
 *
 * Dependencies: patched bsp-to-glb (see scripts/setup-bsp-to-glb.mjs), Node 18+,
 * @gltf-transform/{core,extensions,functions}, meshoptimizer, sharp.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildMapMeta } from './lib/map-meta.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

// ─── args ────────────────────────────────────────────────────────────────────

const args = new Map()
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i]
  if (!arg.startsWith('--')) continue
  const next = process.argv[i + 1]
  if (next !== undefined && !next.startsWith('--')) {
    args.set(arg.slice(2), next)
    i++
  } else {
    args.set(arg.slice(2), 'true')
  }
}
const flag = (name, fallback) => (args.has(name) ? args.get(name) : fallback)
const bool = (name, fallback) => String(flag(name, fallback)) === 'true'

const bspPath = flag('bsp')
if (!bspPath) {
  console.error('Usage: node scripts/convert-bsp.mjs --bsp <map.bsp> [--map <name>] [--out-dir <dir>]')
  process.exit(1)
}
const mapName = flag('map', path.basename(bspPath).replace(/\.bsp$/i, ''))
const outDir = path.resolve(flag('out-dir', path.join(repoRoot, 'public', 'models', 'maps', mapName)))
const skyboxRoot = path.resolve(flag('skybox-dir', path.join(repoRoot, 'public', 'models', 'skybox')))
const chunkGrid = Math.max(1, Number(flag('chunk-grid', '4')))
const lightmapFormat = flag('lightmap-format', 'webp')
const useMeshopt = bool('meshopt', 'true')
const keepTemp = bool('keep-temp', 'false')
const onlyMeta = bool('only-meta', 'false')
const overwriteSky = bool('overwrite-sky', 'false')
const withProps = bool('props', 'true')
const tempDir = fs.mkdtempSync(path.join(flag('temp-dir', os.tmpdir()), `dribble-bsp-${mapName}-`))
// Every output is written into stageDir first and moved into outDir (and the skybox folder) only after
// the last step that can fail, conversion.json last (see commitOutputs). A failure therefore leaves the
// previous package untouched. The temp dir is removed on every exit, failures included, unless
// --keep-temp true.
const stageDir = path.join(tempDir, 'out')
fs.mkdirSync(stageDir, { recursive: true })
let commitState = 'staging' // 'staging' | 'moving' | 'done'
process.on('exit', code => {
  if (commitState === 'staging') console.error(`Conversion failed (exit ${code}); nothing in ${outDir} was changed`)
  else if (commitState === 'moving') console.error(`Conversion failed (exit ${code}) while moving the outputs; ${outDir} is partly updated, rerun the conversion`)
  if (keepTemp) console.log(`Temp kept: ${tempDir}`)
  else fs.rmSync(tempDir, { recursive: true, force: true })
})
/** Pending skybox face copies: [staged png, destination], applied by commitOutputs. */
const skyCopies = []
/**
 * Moves the staged outputs into place. Each file is copied next to its destination under a temporary
 * name and renamed over it, so every file is replaced atomically even when the temp dir sits on another
 * filesystem. `files` is applied in order; callers put conversion.json last. `remove` lists outDir
 * files the new package no longer has (props.glb after a failed or empty props pass).
 */
const commitOutputs = (files, remove = []) => {
  const place = (from, to) => {
    fs.mkdirSync(path.dirname(to), { recursive: true })
    const partial = path.join(path.dirname(to), `.${path.basename(to)}.${process.pid}.partial`)
    fs.copyFileSync(from, partial)
    fs.renameSync(partial, to)
  }
  commitState = 'moving'
  for (const [from, to] of skyCopies) place(from, to)
  for (const file of files) place(path.join(stageDir, file), path.join(outDir, file))
  for (const file of remove) {
    const stale = path.join(outDir, file)
    if (fs.existsSync(stale)) {
      fs.rmSync(stale)
      console.warn(`  removed ${stale}; conversion.json does not list it`)
    }
  }
  commitState = 'done'
}

// Lightmap encoding: stored = sRGB(clamp(linear * exposure / LIGHTMAP_RANGE)). At runtime
// MeshBasicMaterial.lightMapIntensity = LIGHTMAP_RANGE * PI (three divides lightmaps by PI).
const LIGHTMAP_RANGE = 4
// Small linear lift so faces lit only by dark/off styles (or deep interiors) stay readable.
const LIGHTMAP_FLOOR = Number(flag('lightmap-floor', '0.015'))
const SURF = { SKY2D: 0x2, SKY: 0x4, WARP: 0x8, TRANS: 0x10, NODRAW: 0x80, NOLIGHT: 0x400 }

// ─── deps ────────────────────────────────────────────────────────────────────

const importOrExplain = async name => {
  try {
    return await import(name)
  } catch (error) {
    console.error(`Missing dependency ${name}: npm i -D ${name.split('/').slice(0, name.startsWith('@') ? 2 : 1).join('/')}`)
    throw error
  }
}
const { NodeIO, Document } = await importOrExplain('@gltf-transform/core')
const { ALL_EXTENSIONS, KHRMaterialsUnlit } = await importOrExplain('@gltf-transform/extensions')
const { meshopt, quantize, prune } = await importOrExplain('@gltf-transform/functions')
const { MeshoptEncoder } = await importOrExplain('meshoptimizer')
const sharp = (await importOrExplain('sharp')).default

// ─── bsp-to-glb ──────────────────────────────────────────────────────────────

const resolveTool = name => {
  const exe = process.platform === 'win32' ? `${name}.exe` : name
  const candidates = [
    name === 'bsp-to-glb' ? flag('bsp-to-glb') : flag('bsp-to-glb') && path.join(path.dirname(flag('bsp-to-glb')), exe),
    process.env.BSP_TO_GLB_DIR && path.join(process.env.BSP_TO_GLB_DIR, 'target', 'release', exe),
    path.resolve(repoRoot, '..', 'bsp-to-glb', 'target', 'release', exe),
  ].filter(Boolean)
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate
  throw new Error(`${name} not found (tried ${candidates.join(', ')}). Run node scripts/setup-bsp-to-glb.mjs`)
}
const bspToGlb = resolveTool('bsp-to-glb')
const vtfToPng = (() => {
  try {
    return resolveTool('vtf-to-png')
  } catch {
    return null
  }
})()

const run = (binary, argv, label) => {
  const started = performance.now()
  const result = spawnSync(binary, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const ms = Math.round(performance.now() - started)
  if (result.status !== 0) {
    throw new Error(`${label} failed (${result.status}): ${result.stderr || result.stdout}`)
  }
  console.log(`  ${label}: ${ms} ms`)
  return { stdout: result.stdout, ms }
}

const versionInfo = JSON.parse(run(bspToGlb, ['--version-json'], 'bsp-to-glb --version-json').stdout)
// The binary reports no source commit; record the checkout it was built from (target/release/..).
const checkoutCommit = (() => {
  const result = spawnSync('git', ['-C', path.resolve(path.dirname(bspToGlb), '..', '..'), 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
})()
console.log(`Converting ${mapName} with ${versionInfo.name} ${versionInfo.version} (${bspToGlb})`)

// Pass 1: entity graph + embedded PAK resources (fast, no geometry).
const entitiesPath = path.join(tempDir, 'entities.json')
const pakDir = path.join(tempDir, 'pak')
run(bspToGlb, ['--bsp', bspPath, '--entities-out', entitiesPath, '--pak-output', pakDir, '--pak-manifest', path.join(tempDir, 'pak.json')], 'entities + PAK')
const entityGraph = JSON.parse(fs.readFileSync(entitiesPath, 'utf8'))
const entities = entityGraph.entities.map(entity => {
  const kv = {}
  for (const { key, value } of entity.keyValues) {
    const lower = key.toLowerCase()
    if (!(lower in kv)) kv[lower] = value
  }
  return { ...entity, kv }
})
const worldspawn = entities.find(entity => entity.classname === 'worldspawn')
const vec3 = (value, fallback = [0, 0, 0]) => {
  const parts = String(value ?? '').trim().split(/\s+/).map(Number)
  return parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite) ? parts.slice(0, 3) : fallback
}
const worldMins = vec3(worldspawn.kv.world_mins, null)
const worldMaxs = vec3(worldspawn.kv.world_maxs, null)
if (!worldMins || !worldMaxs) throw new Error('worldspawn lacks world_mins/world_maxs')

// Initially-on light styles: 0..31 (static + animated presets) plus every named light (style 32+)
// that does not start dark (spawnflags & 1). Faces lit only by dark styles come out black.
const enabledStyles = new Set(Array.from({ length: 32 }, (_, i) => i))
const lightStyles = []
for (const entity of entities) {
  if (!/^light/.test(entity.classname ?? '') || entity.kv.style === undefined) continue
  const style = Number(entity.kv.style)
  if (!Number.isInteger(style) || style < 32) continue
  const startsDark = (Number(entity.kv.spawnflags || 0) & 1) !== 0
  lightStyles.push({ style, targetname: entity.kv.targetname, startsDark })
  if (!startsDark) enabledStyles.add(style)
}

// Pass 2: render export.
const rawGlbPath = path.join(tempDir, 'raw.glb')
const rawAtlasPath = path.join(tempDir, 'lightmap-rgbe.png')
const lightmapManifestPath = path.join(tempDir, 'lightmaps.json')
const rawVisibilityPath = path.join(tempDir, 'visibility.json')
const exportRun = run(
  bspToGlb,
  [
    '--bsp', bspPath,
    '--out', rawGlbPath,
    '--lightmap-set', 'auto',
    '--lightmap-styles', [...enabledStyles].sort((a, b) => a - b).join(','),
    '--allow-unresolved-patch-includes', 'true',
    '--lightmap-atlas', rawAtlasPath,
    '--lightmap-manifest', lightmapManifestPath,
    '--visibility-out', rawVisibilityPath,
    '--material-manifest', path.join(tempDir, 'materials.json'),
    '--props-out', path.join(tempDir, 'props.json'), // static prop lump for the props pass (M2)
  ],
  'render export'
)
const exportStats = JSON.parse(exportRun.stdout)
const lightmapManifest = JSON.parse(fs.readFileSync(lightmapManifestPath, 'utf8'))
const visibility = JSON.parse(fs.readFileSync(rawVisibilityPath, 'utf8'))

// ─── geometry post-process ───────────────────────────────────────────────────

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
await MeshoptEncoder.ready
io.registerDependencies({ 'meshopt.encoder': MeshoptEncoder })
const raw = await io.read(rawGlbPath)
const rawRoot = raw.getRoot()

// Brush entities that never render (or only ship tool faces); their data goes to map-meta.
const HIDDEN_BRUSH_CLASSES = /^trigger_|^func_(areaportal|areaportalwindow|occluder|precipitation|dustmotes|dustcloud|smokevolume|nobuild|regenerate|respawnroom|capturezone|ladder|clip_vphysics|viscluster|nogrenades|nav_\w+|flagdetectionzone|upgradestation|suggested_build|passtime\w*|croc|powerupvolume|bomb_target|vehicleclip|fish_pool|proprrespawnzone|tfbot_hint)$|^dispenser_touch_trigger$/i
const isHiddenMaterial = name => {
  const base = name.toLowerCase().split('/').pop()
  if (base === 'toolsblack' || base === 'toolsblack_nofog') return false
  return /^tools?(invisible|nodraw|clip|playerclip|npcclip|trigger|areaportal|hint|skip|skybox|fog|blocklight|block_?los|blockbullets|occluder|origin|dotted)/.test(base) ||
    /toolsinvisible/.test(base)
}
const CUTOUT_NAME = /chicken_?wire|chain_?link|fence|grate|grating|mesh|railing|wire|ladder|grill|lattice|catwalk_?floor/i
const classifyMaterial = (material, surfaceFlags, hasLightmap) => {
  const name = material.getName()
  const extras = material.getExtras() || {}
  const lower = name.toLowerCase()
  if (surfaceFlags & SURF.WARP || /(^|\/)water/.test(lower) && !/waterfall/.test(lower)) return { kind: 'water', alpha: 0.65 }
  const blend = material.getAlphaMode() === 'BLEND' || (surfaceFlags & SURF.TRANS) !== 0
  if (/glass|window/.test(lower) && (blend || /glass/.test(lower))) return { kind: 'translucent', alpha: 0.3 }
  if (material.getAlphaMode() === 'MASK' || CUTOUT_NAME.test(lower)) return { kind: 'translucent', alpha: 0.55 }
  if (blend) return { kind: 'translucent', alpha: /sprites\/|overlay/.test(lower) ? 0.85 : 0.5 }
  if (!hasLightmap || (surfaceFlags & SURF.NOLIGHT) !== 0 || extras.sourceShaderFamily === 'unlitGeneric') return { kind: 'unlit', alpha: 1 }
  return { kind: 'opaque', alpha: 1 }
}
const albedoFor = (material, kind) => {
  const extras = material.getExtras() || {}
  const lower = material.getName().toLowerCase()
  let color = Array.isArray(extras.sourceReflectivity) ? extras.sourceReflectivity.map(v => Math.min(1, Math.max(0, v))) : [0.5, 0.5, 0.5]
  if (/toolsblack/.test(lower)) color = [0, 0, 0]
  if (kind === 'water') color = [0.06, 0.13, 0.17]
  // Self-lit panels often compile with ~0 reflectivity; render them as light sources.
  if (kind === 'unlit' && Math.max(...color) < 0.05) color = [0.9, 0.88, 0.8]
  return color
}

const toSource = (x, y, z) => [x, -z, y] // glTF (Y-up) → Source (Z-up)
// Brush entities that keep a (possibly mesh-less) node so runtime code can attach placeholders,
// move doors/trains, or toggle visualizers.
const ADDRESSABLE = /^func_(door|door_rotating|movelinear|tracktrain|train|rotating|respawnroomvisualizer|brush|wall_toggle)$/i
const respawnRoomTeam = new Map(entities.filter(e => e.classname === 'func_respawnroom' && e.kv.targetname).map(e => [e.kv.targetname.toLowerCase(), Number(e.kv.teamnum || 0)]))
const TEAM_TINT = { 2: [0.48, 0.04, 0.045], 3: [0.1, 0.23, 0.37], 0: [0.4, 0.4, 0.4] } // linear RED #b8383b / BLU #5885a2
const margin = 64
const outsideWorld = p =>
  p[0] < worldMins[0] - margin || p[1] < worldMins[1] - margin || p[2] < worldMins[2] - margin ||
  p[0] > worldMaxs[0] + margin || p[1] > worldMaxs[1] + margin || p[2] > worldMaxs[2] + margin
const chunkOf = p => {
  const fx = (p[0] - worldMins[0]) / Math.max(1, worldMaxs[0] - worldMins[0])
  const fy = (p[1] - worldMins[1]) / Math.max(1, worldMaxs[1] - worldMins[1])
  const i = Math.min(chunkGrid - 1, Math.max(0, Math.floor(fx * chunkGrid)))
  const j = Math.min(chunkGrid - 1, Math.max(0, Math.floor(fy * chunkGrid)))
  return `chunk_${i}_${j}`
}

// Output accumulation: group name → { extras, matrix, buckets: key → arrays }
const groups = new Map()
const getGroup = (name, init) => {
  if (!groups.has(name)) groups.set(name, { name, buckets: new Map(), faces: [], ...init })
  return groups.get(name)
}
const getBucket = (group, kind, lit) => {
  const key = `${kind}:${lit ? 'lit' : 'unlit'}`
  if (!group.buckets.has(key)) {
    group.buckets.set(key, { kind, lit, positions: [], normals: [], uvs: [], colors: [], indices: [], vertexCount: 0 })
  }
  return group.buckets.get(key)
}

const counters = { droppedPrimitives: 0, droppedTriangles: 0, keptTriangles: 0, skyboxFaces: 0, worldFaces: 0, hiddenEntityNodes: 0 }
const brushNodes = []
const materialStats = new Map()

for (const node of rawRoot.listNodes()) {
  const extras = node.getExtras() || {}
  const mesh = node.getMesh()
  if (extras.bspModelIndex === undefined || !mesh) continue
  const classname = extras.classname || 'brush_model'
  const isWorld = extras.bspModelIndex === 0
  const m = node.getMatrix() // column-major; brush-entity vertices are model-local
  const xf = (x, y, z) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]]
  const xn = (x, y, z) => [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z]
  const hiddenClass = !isWorld && HIDDEN_BRUSH_CLASSES.test(classname)
  // Addressable brush entities that start hidden (func_brush StartDisabled, rendermode 10 doors and
  // trains) keep their geometry, so a gate that appears mid-round has a mesh; their node gets
  // extras.dribble.initiallyVisible = false and runtime code shows it when the demo says so.
  const startsHidden = !isWorld && !hiddenClass && !extras.initiallyRendered && ADDRESSABLE.test(classname)
  const entityHidden = hiddenClass || (!isWorld && !extras.initiallyRendered && !startsHidden)
  brushNodes.push({ node, extras, hidden: entityHidden, startsHidden })
  if (entityHidden) {
    counters.hiddenEntityNodes++
    continue
  }
  for (const prim of mesh.listPrimitives()) {
    const pe = prim.getExtras() || {}
    const material = prim.getMaterial()
    const indices = prim.getIndices()?.getArray()
    const triangleCount = indices ? indices.length / 3 : 0
    const visualizer = /^func_respawnroomvisualizer$/i.test(classname)
    // Visualizer faces (overlays/no_entry) compile with SURF_TRIGGER; keep them for that class only.
    if ((!pe.surfaceInitiallyRendered && !visualizer) || !material || (!visualizer && isHiddenMaterial(material.getName())) || !indices) {
      counters.droppedPrimitives++
      counters.droppedTriangles += triangleCount
      continue
    }
    const lit = Boolean(pe.hasLightmap && prim.getAttribute('TEXCOORD_1')) && !/^func_respawnroomvisualizer$/i.test(classname)
    const { kind, alpha } = visualizer ? { kind: 'visualizer', alpha: 0.35 } : classifyMaterial(material, pe.surfaceFlags | 0, lit)
    const entityKv = entities[extras.entityIndex]?.kv ?? {}
    const albedo = visualizer ? TEAM_TINT[respawnRoomTeam.get(String(entityKv.respawnroomname).toLowerCase()) ?? 0] : albedoFor(material, kind)
    const stat = materialStats.get(material.getName()) || { triangles: 0, kind, albedo, mins: [Infinity, Infinity, Infinity], maxs: [-Infinity, -Infinity, -Infinity] }
    stat.triangles += triangleCount
    materialStats.set(material.getName(), stat)

    const pos = prim.getAttribute('POSITION').getArray()
    const nrm = prim.getAttribute('NORMAL').getArray()
    const uv1 = lit ? prim.getAttribute('TEXCOORD_1').getArray() : null
    const counts = pe.bspFaceVertexCounts
    const faceIndices = pe.bspFaceIndices
    const starts = []
    let cursor = 0
    for (const count of counts) {
      starts.push(cursor)
      cursor += count
    }
    // Triangles are emitted per face in order; split them back into faces.
    const faceTriangles = counts.map(() => [])
    let f = 0
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t]
      while (f < counts.length - 1 && a >= starts[f] + counts[f]) f++
      faceTriangles[f].push(t)
    }
    for (let k = 0; k < counts.length; k++) {
      if (faceTriangles[k].length === 0) continue
      const v0 = starts[k]
      const vn = counts[k]
      let cx = 0, cy = 0, cz = 0
      for (let v = v0; v < v0 + vn; v++) {
        cx += pos[v * 3]
        cy += pos[v * 3 + 1]
        cz += pos[v * 3 + 2]
      }
      const centroid = toSource(...xf(cx / vn, cy / vn, cz / vn))
      if (kind === 'water' && !outsideWorld(centroid)) {
        for (let v = v0; v < v0 + vn; v++) {
          const p = toSource(...xf(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]))
          for (let axis = 0; axis < 3; axis++) {
            stat.mins[axis] = Math.min(stat.mins[axis], p[axis])
            stat.maxs[axis] = Math.max(stat.maxs[axis], p[axis])
          }
        }
      }
      let group
      // 3D-skybox faces (world or brush entity) lie outside world_mins/maxs, which VBSP computes
      // without sky areas. They are re-expressed in world space inside the skybox_3d node.
      const toSkybox = outsideWorld(centroid)
      if (toSkybox) {
        counters.skyboxFaces++
        group = getGroup('skybox_3d', { kind: 'skybox3d' })
      } else if (isWorld) {
        counters.worldFaces++
        group = getGroup(chunkOf(centroid), { kind: 'worldChunk' })
        group.faces.push(faceIndices[k])
      } else {
        group = getGroup(node.getName(), { kind: 'brushEntity', node, extras })
      }
      const bake = toSkybox && !isWorld
      const bucket = getBucket(group, kind, lit)
      const base = bucket.vertexCount
      for (let v = v0; v < v0 + vn; v++) {
        if (bake) {
          bucket.positions.push(...xf(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]))
          bucket.normals.push(...xn(nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]))
        } else {
          bucket.positions.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2])
          bucket.normals.push(nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2])
        }
        if (lit) bucket.uvs.push(uv1[v * 2], uv1[v * 2 + 1])
        bucket.colors.push(albedo[0], albedo[1], albedo[2], alpha)
      }
      bucket.vertexCount += vn
      for (const t of faceTriangles[k]) {
        bucket.indices.push(indices[t] - v0 + base, indices[t + 1] - v0 + base, indices[t + 2] - v0 + base)
      }
      counters.keptTriangles += faceTriangles[k].length
    }
  }
}

// ─── build output document ───────────────────────────────────────────────────

const doc = new Document()
const buffer = doc.createBuffer()
const unlitExt = doc.createExtension(KHRMaterialsUnlit)
const scene = doc.createScene('map')
const materialCache = new Map()
const getMaterial = (kind, lit) => {
  const key = `${kind}:${lit}`
  if (materialCache.has(key)) return materialCache.get(key)
  const material = doc.createMaterial(`dribble_${kind}${lit ? '_lit' : ''}`)
    .setBaseColorFactor([1, 1, 1, 1])
    .setMetallicFactor(0)
    .setRoughnessFactor(1)
    .setExtras({ dribble: { kind, lightmap: lit } })
  if (kind !== 'opaque' && kind !== 'unlit') material.setAlphaMode('BLEND')
  if (kind === 'visualizer') material.setDoubleSided(true).setExtras({ dribble: { kind, lightmap: false, hiddenByDefault: true } })
  if (kind === 'water') material.setDoubleSided(true)
  if (!lit) material.setExtension('KHR_materials_unlit', unlitExt.createUnlit())
  materialCache.set(key, material)
  return material
}
const accessor = (array, type) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer)
const boundsOf = group => {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const bucket of group.buckets.values()) {
    for (let i = 0; i < bucket.positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], bucket.positions[i + axis])
        max[axis] = Math.max(max[axis], bucket.positions[i + axis])
      }
    }
  }
  return { min, max }
}
// Mesh lives on a child node: quantize() folds its dequantisation transform into the mesh node, so
// keeping the named parent mesh-less preserves clean entity transforms (doors/trains can be moved by
// setting the parent's position/rotation) and chunk roots for visibility toggling.
const meshChild = (name, mesh) => doc.createNode(`${name}_mesh`).setMesh(mesh)
const buildMesh = (name, group) => {
  const mesh = doc.createMesh(name)
  for (const bucket of group.buckets.values()) {
    if (bucket.indices.length === 0) continue
    const translucent = bucket.kind !== 'opaque' && bucket.kind !== 'unlit' // translucent | water | visualizer
    let colors = Float32Array.from(bucket.colors)
    if (!translucent) colors = Float32Array.from(colors.filter((_, i) => i % 4 !== 3))
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', accessor(Float32Array.from(bucket.positions), 'VEC3'))
      .setAttribute('NORMAL', accessor(Float32Array.from(bucket.normals), 'VEC3'))
      .setAttribute('COLOR_0', accessor(colors, translucent ? 'VEC4' : 'VEC3'))
      .setIndices(accessor(Uint32Array.from(bucket.indices), 'SCALAR'))
      .setMaterial(getMaterial(bucket.kind, bucket.lit))
    // Lightmap UVs become TEXCOORD_0 (no texture UVs are kept); lightMap.channel = 0 at runtime.
    if (bucket.lit) prim.setAttribute('TEXCOORD_0', accessor(Float32Array.from(bucket.uvs), 'VEC2'))
    mesh.addPrimitive(prim)
  }
  return mesh.listPrimitives().length ? mesh : null
}

const worldNode = doc.createNode('worldspawn').setExtras({ dribble: { kind: 'world', bspModelIndex: 0 } })
scene.addChild(worldNode)
const chunkNames = []
const chunkFaceLists = []
const chunkBounds = []
for (const group of [...groups.values()].filter(g => g.kind === 'worldChunk').sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))) {
  const bounds = boundsOf(group)
  const mesh = buildMesh(group.name, group)
  if (!mesh) continue
  worldNode.addChild(doc.createNode(group.name).addChild(meshChild(group.name, mesh)).setExtras({ dribble: { kind: 'worldChunk' } }))
  chunkNames.push(group.name)
  chunkFaceLists.push(group.faces)
  chunkBounds.push(bounds)
}

const skyCamera = entities.find(entity => entity.classname === 'sky_camera')
const skyGroup = groups.get('skybox_3d')
if (skyGroup) {
  const mesh = buildMesh('skybox_3d', skyGroup)
  if (mesh) {
    // In-game the 3D skybox is drawn scaled by `scale` around sky_camera; bake that transform so the
    // node can simply be shown. glTF(p) → glTF((p - cam) * scale).
    const scale = Number(skyCamera?.kv.scale || 16)
    const cam = vec3(skyCamera?.kv.origin)
    const camGltf = [cam[0], cam[2], -cam[1]]
    scene.addChild(
      doc.createNode('skybox_3d')
        .addChild(meshChild('skybox_3d', mesh))
        .setScale([scale, scale, scale])
        .setTranslation(camGltf.map(v => -v * scale))
        .setExtras({ dribble: { kind: 'skybox3d', skyCameraOrigin: cam, scale, hiddenByDefault: true } })
    )
  }
}

const entityNodes = []
for (const { node, extras: e, startsHidden } of brushNodes) {
  if (e.bspModelIndex === 0) continue
  const name = node.getName()
  const group = groups.get(name)
  const mesh = group ? buildMesh(name, group) : null
  if (!mesh && !ADDRESSABLE.test(e.classname || '')) continue
  const entity = entities[e.entityIndex] || { kv: {} }
  const out = doc.createNode(name)
    .setMatrix(node.getMatrix())
    .setExtras({
      dribble: {
        kind: /^func_respawnroomvisualizer$/i.test(e.classname) ? 'respawnVisualizer' : 'brushEntity',
        classname: e.classname,
        targetname: e.targetname ?? null,
        parentname: entity.kv.parentname ?? null,
        team: /^func_respawnroomvisualizer$/i.test(e.classname) ? respawnRoomTeam.get(String(entity.kv.respawnroomname).toLowerCase()) ?? 0 : Number(entity.kv.teamnum || 0) || undefined,
        bspModelIndex: e.bspModelIndex,
        entityIndex: e.entityIndex,
        origin: e.entityOrigin,
        angles: e.entityAngles,
        localMins: e.sourceMins, // Source units, model-local (placeholder boxes for prop-only doors)
        localMaxs: e.sourceMaxs,
        hasGeometry: Boolean(mesh),
        // false: the entity starts hidden (func_brush StartDisabled, rendermode 6/10); World.tsx hides
        // the node until runtime code shows it.
        initiallyVisible: !startsHidden,
        renderMode: Number(e.rendermode) || 0, // 10 = never drawn in game (collision brush of a prop door)
        startDisabled: e.startDisabled === '1',
      },
    })
  if (mesh) out.addChild(meshChild(name, mesh))
  scene.addChild(out)
  entityNodes.push({ name, classname: e.classname, targetname: e.targetname ?? null, hasGeometry: Boolean(mesh), initiallyVisible: !startsHidden })
}

const glbOutPath = path.join(stageDir, 'world.glb')
if (!onlyMeta) {
  // keepAttributes: lightmap UVs have no texture reference; keepLeaves: mesh-less entity anchors.
  await doc.transform(prune({ keepAttributes: true, keepLeaves: true }))
  const quantizeOptions = {
    quantizationVolume: 'scene', // one grid for all chunks → shared edges stay crack-free
    quantizePosition: 16,
    quantizeNormal: 8,
    quantizeTexcoord: 16, // 1/65535 of a 4096 px atlas ≈ 0.06 px
    quantizeColor: 12,
  }
  if (useMeshopt) {
    await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'high', ...quantizeOptions }))
  } else {
    await doc.transform(quantize(quantizeOptions))
  }
  await io.write(glbOutPath, doc)
}

// ─── lightmap atlas ──────────────────────────────────────────────────────────

let lightmapInfo = null
if (!onlyMeta && fs.existsSync(rawAtlasPath)) {
  const { data, info } = await sharp(rawAtlasPath).raw().toBuffer({ resolveWithObject: true })
  if (info.channels !== 4) throw new Error(`unexpected lightmap channels ${info.channels}`)
  // Exposure: TF2 auto-exposure clamps roughly to [0.5, 2]; aim the 90th percentile luminance at 1.25.
  const lum = []
  for (const face of lightmapManifest.faces) {
    for (let y = 0; y < face.height; y += 2) {
      for (let x = 0; x < face.width; x += 2) {
        const o = ((face.atlasY + y) * info.width + face.atlasX + x) * 4
        const s = Math.pow(2, (data[o + 3] << 24) >> 24) / 255
        lum.push((0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2]) * s)
      }
    }
  }
  lum.sort((a, b) => a - b)
  const p90 = lum[Math.floor(0.9 * (lum.length - 1))] || 1
  const exposure = Math.min(2, Math.max(0.5, 1.25 / p90))
  const toSrgb8 = linear => {
    const v = Math.min(1, Math.max(0, linear))
    const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
    return Math.round(s * 255)
  }
  const lut = new Map()
  const rgb = Buffer.alloc(info.width * info.height * 3)
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    const e = (data[i + 3] << 24) >> 24
    let scale = lut.get(e)
    if (scale === undefined) {
      scale = (Math.pow(2, e) / 255) * exposure / LIGHTMAP_RANGE
      lut.set(e, scale)
    }
    const lift = LIGHTMAP_FLOOR / LIGHTMAP_RANGE
    rgb[j] = toSrgb8(data[i] * scale + lift)
    rgb[j + 1] = toSrgb8(data[i + 1] * scale + lift)
    rgb[j + 2] = toSrgb8(data[i + 2] * scale + lift)
  }
  const image = sharp(rgb, { raw: { width: info.width, height: info.height, channels: 3 } })
  const file = `lightmap.${lightmapFormat}`
  if (lightmapFormat === 'webp') await image.webp({ lossless: true, effort: 6 }).toFile(path.join(stageDir, file))
  else await image.png({ compressionLevel: 9 }).toFile(path.join(stageDir, file))
  lightmapInfo = {
    file,
    width: info.width,
    height: info.height,
    set: lightmapManifest.source.lightingSet,
    exposure: +exposure.toFixed(4),
    floor: LIGHTMAP_FLOOR,
    p90Luminance: +p90.toFixed(4),
    range: LIGHTMAP_RANGE,
    colorSpace: 'srgb',
    uvChannel: 0,
    filter: 'linear-no-mipmaps',
    runtimeIntensity: 'range * PI for MeshBasicMaterial',
    styles: lightmapManifest.styles.composition,
    enabledNamedStyles: lightStyles.filter(s => !s.startsDark).map(s => s.style),
    darkNamedStyles: lightStyles.filter(s => s.startsDark).map(s => s.style),
  }
}

// ─── visibility (dribble MapVisibilityMetadata v2, exact) ────────────────────

let visibilityInfo = null
if (!onlyMeta) {
  const W = visibility.clusterWordCount
  const faceSlot = new Map(visibility.worldFaceIndices.map((face, n) => [face, n]))
  const chunkWords = chunkFaceLists.map(faces => {
    const words = new Uint32Array(W)
    for (const face of faces) {
      const n = faceSlot.get(face)
      if (n === undefined) continue
      for (let w = 0; w < W; w++) words[w] |= visibility.worldFaceClusterWords[n * W + w]
    }
    return words
  })
  const visibleChunksByCluster = []
  for (let c = 0; c < visibility.clusterCount; c++) {
    const visible = []
    chunkWords.forEach((words, k) => {
      for (let w = 0; w < W; w++) {
        if (words[w] & visibility.pvsWords[c * W + w]) {
          visible.push(k)
          break
        }
      }
    })
    visibleChunksByCluster.push(visible)
  }
  const metadata = {
    version: 2,
    transform: 'gltf-to-source:x,-z,y',
    source: 'bsp-to-glb visibility sidecar v2 (exact LEAFFACES/PVS)',
    chunkNames,
    chunkBounds: chunkBounds.map(b => ({ min: b.min.map(v => +v.toFixed(1)), max: b.max.map(v => +v.toFixed(1)) })),
    planes: visibility.planes.map(p => [p.normal[0], p.normal[1], p.normal[2], p.distance]),
    nodes: visibility.nodes.map(n => [n.planeIndex, n.children[0], n.children[1]]),
    leafClusters: visibility.leaves.map(l => l.cluster),
    visibleChunksByCluster,
  }
  fs.writeFileSync(path.join(stageDir, 'visibility.json'), JSON.stringify(metadata))
  visibilityInfo = { clusters: visibility.clusterCount, chunks: chunkNames.length, leaves: visibility.leaves.length }
}

// ─── skybox (PAK-embedded faces only; stock skies must already exist) ────────

const skyname = worldspawn.kv.skyname || null
let skyboxInfo = { name: skyname, source: null }
if (skyname && !onlyMeta) {
  const existing = fs.existsSync(path.join(skyboxRoot, skyname))
  const pakSkyDir = path.join(pakDir, 'materials', 'skybox')
  const pakFiles = fs.existsSync(pakSkyDir) ? fs.readdirSync(pakSkyDir) : []
  const findFace = side => pakFiles.find(file => file.toLowerCase() === `${skyname}${side}.vtf`.toLowerCase())
  const sides = ['bk', 'dn', 'ft', 'lf', 'rt', 'up']
  // The map's own PAK faces are used whenever the BSP ships all six, so the result does not depend on
  // whether an earlier run already wrote them. They are rendered into the temp dir first, because
  // another map may use the same sky name: an existing folder whose pixels differ is never replaced
  // silently (--overwrite-sky true replaces it); this map's faces go to <skyname>_<map> instead.
  if (vtfToPng && sides.every(findFace)) {
    const staged = path.join(tempDir, 'sky')
    fs.mkdirSync(staged, { recursive: true })
    for (const side of sides) {
      const decoded = path.join(tempDir, `sky_${side}.png`)
      const face = path.join(staged, `${side}.png`)
      run(vtfToPng, [path.join(pakSkyDir, findFace(side)), decoded], `sky ${side}`)
      const image = sharp(decoded)
      const meta = await image.metadata()
      // Source side faces are often 2:1 (upper half only); pad to square with the bottom row colour
      // instead of letting Skybox.tsx stretch them.
      if (meta.width === 2 * meta.height && side !== 'up' && side !== 'dn') {
        const { data } = await sharp(decoded).extract({ left: 0, top: meta.height - 1, width: meta.width, height: 1 }).raw().toBuffer({ resolveWithObject: true })
        let r = 0, g = 0, b = 0
        for (let i = 0; i < data.length; i += 4) {
          r += data[i]
          g += data[i + 1]
          b += data[i + 2]
        }
        const n = data.length / 4
        await sharp(decoded)
          .extend({ bottom: meta.height, background: { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n), alpha: 1 } })
          .png()
          .toFile(face)
      } else {
        await sharp(decoded).png().toFile(face)
      }
    }

    const pixels = async file => {
      const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true })
      return { data, key: `${info.width}x${info.height}x${info.channels}` }
    }
    const sameFaces = async folder => {
      for (const side of sides) {
        const file = path.join(skyboxRoot, folder, `${folder}_${side}.png`)
        if (!fs.existsSync(file)) return false
        const [a, b] = await Promise.all([pixels(file), pixels(path.join(staged, `${side}.png`))])
        if (a.key !== b.key || !a.data.equals(b.data)) return false
      }
      return true
    }
    const unchanged = existing && (await sameFaces(skyname))
    const folder = existing && !unchanged && !overwriteSky ? `${skyname}_${mapName}` : skyname
    if (!unchanged) {
      for (const side of sides) skyCopies.push([path.join(staged, `${side}.png`), path.join(skyboxRoot, folder, `${folder}_${side}.png`)])
    }
    skyboxInfo = { name: skyname, source: 'bsp-pak', ...(folder !== skyname ? { folder } : {}) }
    if (folder !== skyname) {
      console.warn(`  sky ${skyname}: ${path.join(skyboxRoot, skyname)} holds different faces (another map's sky), ` +
        `so this map's PAK faces went to ${folder}. Point MAP_SKYBOX_MAP (src/constants/mappings.ts) at '${folder}', ` +
        'or rerun with --overwrite-sky true to replace the shared folder.')
    } else {
      console.log(`  sky ${skyname}: PAK faces ${unchanged ? 'match the existing folder (unchanged)' : existing ? 'replace the existing folder (--overwrite-sky)' : 'staged'}`)
    }
  } else if (existing) {
    skyboxInfo = { name: skyname, source: 'existing' }
  } else {
    // Stock skies we cannot ship: point at the closest look-alike already in public/models/skybox.
    const SKY_FALLBACKS = { sky_badlands_01: 'sky_dustbowl_01', sky_upward: 'sky_tf2_04', sky_goldrush_01: 'sky_dustbowl_01', sky_alpinestorm_01: 'sky_morningsnow_01', sky_harvest_01: 'sky_granary_01', sky_night_01: 'sky_night_01' }
    skyboxInfo = { name: skyname, source: 'missing', fallback: SKY_FALLBACKS[skyname.toLowerCase()] ?? 'sky_tf2_04' }
  }
}

// ─── map metadata ────────────────────────────────────────────────────────────

const modelBounds = new Map()
for (const { extras } of brushNodes) {
  modelBounds.set(extras.bspModelIndex, { mins: extras.sourceMins, maxs: extras.sourceMaxs, origin: extras.entityOrigin, angles: extras.entityAngles, node: null })
}
for (const entityNode of entityNodes) {
  const match = brushNodes.find(b => b.node.getName() === entityNode.name)
  if (match) modelBounds.get(match.extras.bspModelIndex).node = entityNode.name
}
const waterSurfaces = []
for (const [name, stat] of materialStats) {
  if (stat.kind !== 'water' || !Number.isFinite(stat.mins[0])) continue
  waterSurfaces.push({ material: name, triangles: stat.triangles, mins: stat.mins.map(v => +v.toFixed(1)), maxs: stat.maxs.map(v => +v.toFixed(1)), surfaceZ: +stat.maxs[2].toFixed(1) })
}
const meta = buildMapMeta({ mapName, entities, modelBounds, worldMins, worldMaxs, waterSurfaces, bspVersion: lightmapManifest.source.bspVersion })

// Occlusion-aware RTS camera. map-meta.mjs picks the focus (the objective named by camera.method) and a
// default offset; keep them unless opaque world geometry blocks the line of sight from the camera to
// the focus (64 units above it). Search order: the original focus first, at the default distance and
// then a shorter one, elevations 58/66/74/82 degrees and 8 azimuths (the base side and its quarter
// turns first). If the focus is enclosed (an indoor point, a tunnel), slide it along the objective:
// along the payload path for payload / tug of war, on rings around the point otherwise. Only when
// every candidate is blocked does it fall back to a near top-down view over the roofs.
{
  const triangles = []
  for (const group of groups.values()) {
    if (group.kind !== 'worldChunk') continue
    for (const bucket of group.buckets.values()) {
      if (bucket.kind !== 'opaque') continue
      const P = bucket.positions
      for (let t = 0; t < bucket.indices.length; t += 3) {
        for (let k = 0; k < 3; k++) {
          const i = bucket.indices[t + k]
          triangles.push(...toSource(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]))
        }
      }
    }
  }
  const T = Float64Array.from(triangles)
  const triCount = T.length / 9
  const B = new Float64Array(triCount * 6) // per-triangle AABB for a cheap reject
  for (let n = 0; n < triCount; n++) {
    for (let axis = 0; axis < 3; axis++) {
      const a = T[n * 9 + axis], b = T[n * 9 + 3 + axis], c = T[n * 9 + 6 + axis]
      B[n * 6 + axis] = Math.min(a, b, c)
      B[n * 6 + 3 + axis] = Math.max(a, b, c)
    }
  }
  const blocked = (from, to) => {
    const lo = [0, 1, 2].map(axis => Math.min(from[axis], to[axis]))
    const hi = [0, 1, 2].map(axis => Math.max(from[axis], to[axis]))
    const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2]
    for (let n = 0; n < triCount; n++) {
      const b = n * 6
      if (B[b] > hi[0] || B[b + 3] < lo[0] || B[b + 1] > hi[1] || B[b + 4] < lo[1] || B[b + 2] > hi[2] || B[b + 5] < lo[2]) continue
      const o = n * 9
      const e1x = T[o + 3] - T[o], e1y = T[o + 4] - T[o + 1], e1z = T[o + 5] - T[o + 2]
      const e2x = T[o + 6] - T[o], e2y = T[o + 7] - T[o + 1], e2z = T[o + 8] - T[o + 2]
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x
      const det = e1x * px + e1y * py + e1z * pz
      if (Math.abs(det) < 1e-9) continue
      const tx = from[0] - T[o], ty = from[1] - T[o + 1], tz = from[2] - T[o + 2]
      const u = (tx * px + ty * py + tz * pz) / det
      if (u < 0 || u > 1) continue
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x
      const v = (dx * qx + dy * qy + dz * qz) / det
      if (v < 0 || u + v > 1) continue
      const t = (e2x * qx + e2y * qy + e2z * qz) / det
      if (t > 0.02 && t < 1) return true
    }
    return false
  }

  const c = meta.camera
  const original = c.focusSource
  const base = [c.cameraOffset.x, c.cameraOffset.y, c.cameraOffset.z]
  const distance = Math.hypot(...base)
  const baseAzimuth = Math.atan2(base[1], base[0])

  // Focus candidates, nearest the original first.
  const focusCandidates = [original]
  const pathPoint = (path, at) => {
    const i = path.findIndex(node => node.distance >= at)
    if (i <= 0) return path[Math.max(0, i)].origin
    const [a, b] = [path[i - 1], path[i]]
    const f = b.distance > a.distance ? (at - a.distance) / (b.distance - a.distance) : 0
    return a.origin.map((value, k) => value + (b.origin[k] - value) * f)
  }
  const route = meta.payload[0]
  if (route?.path?.length > 1 && (c.method === 'payload-first-push' || c.method === 'tug-of-war-centre')) {
    const firstCheckpoint = route.linked.map(l => l.distance).filter(d => d !== null && d > 0).sort((a, b) => a - b)[0] ?? route.length
    const centre = c.method === 'payload-first-push' ? firstCheckpoint / 2 : route.length / 2
    const span = c.method === 'payload-first-push' ? 0.4 * firstCheckpoint : 0.25 * route.length
    for (let shift = 128; shift <= span; shift += 128) {
      for (const at of [centre + shift, centre - shift]) {
        if (at >= 0 && at <= route.length) focusCandidates.push(pathPoint(route.path, at))
      }
    }
  } else {
    for (const radius of [192, 384, 576]) {
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4
        focusCandidates.push([original[0] + radius * Math.cos(a), original[1] + radius * Math.sin(a), original[2]])
      }
    }
  }
  const azimuthSteps = [0, 2, 6, 4, 1, 7, 3, 5] // quarter turns first, then the diagonals
  let chosen = null
  search: for (const focusPoint of focusCandidates) {
    const eye = [focusPoint[0], focusPoint[1], focusPoint[2] + 64]
    for (const reach of [distance, Math.max(1100, 0.7 * distance)]) {
      for (const elevationDeg of [58, 66, 74, 82]) {
        for (const step of azimuthSteps) {
          const az = baseAzimuth + (step * Math.PI) / 4, el = (elevationDeg * Math.PI) / 180
          const offset = [reach * Math.cos(el) * Math.cos(az), reach * Math.cos(el) * Math.sin(az), reach * Math.sin(el)]
          if (!blocked(eye, eye.map((v, i) => v + offset[i]))) {
            chosen = { focusPoint, offset, elevationDeg, step, reach }
            break search
          }
        }
      }
    }
  }
  if (chosen) {
    const focus = chosen.focusPoint.map(v => +v.toFixed(1))
    const shift = Math.round(Math.hypot(focus[0] - original[0], focus[1] - original[1], focus[2] - original[2]))
    c.focusSource = focus
    c.rtsCenter = { x: Math.round(focus[0] - worldMins[0]), y: Math.round(focus[1] - worldMins[1]), z: Math.round(focus[2] - worldMins[2]) }
    c.cameraOffset = { x: Math.round(chosen.offset[0]), y: Math.round(chosen.offset[1]), z: Math.round(chosen.offset[2]) }
    c.occlusion = {
      clear: true,
      elevationDeg: chosen.elevationDeg,
      ...(chosen.step % 2 === 0 ? { quarterTurns: chosen.step / 2 } : {}),
      azimuthDeg: chosen.step * 45, // relative to the default side
      distance: Math.round(chosen.reach),
      focusShift: shift, // units between the objective focus and the framed point
    }
  } else {
    // Enclosed everywhere: fall back to a near top-down view over the roofs.
    const el = (82 * Math.PI) / 180
    c.cameraOffset = { x: Math.round(distance * Math.cos(el) * Math.cos(baseAzimuth)), y: Math.round(distance * Math.cos(el) * Math.sin(baseAzimuth)), z: Math.round(distance * Math.sin(el)) }
    c.occlusion = { clear: false, elevationDeg: 82 }
  }
}
fs.writeFileSync(path.join(stageDir, 'map-meta.json'), JSON.stringify(meta, null, 1))

if (onlyMeta) {
  commitOutputs(['map-meta.json'])
  console.log(`  map-meta.json only (${meta.gameMode}, camera ${meta.camera.method}); world.glb, lightmap, visibility and conversion.json untouched`)
  console.log(`Done → ${outDir}`)
  process.exit(0)
}

// ─── PAK static props (task M2, scripts/lib/static-props.mjs) ────────────────
// Static props whose models ship in the PAK become props.glb, lit by the PAK's per-vertex lighting in
// the lightmap's exposure. Stock props are game assets and are only counted (props.stock).

let propsResult = null
let propsError = null
if (withProps) {
  // A failing props pass is reported and the conversion goes on without props: commitOutputs then
  // removes the old props.glb, because conversion.json no longer lists it.
  try {
    const { convertStaticProps } = await import('./lib/static-props.mjs')
    propsResult = await convertStaticProps({
      bspToGlb,
      vtfToPng,
      pakDir,
      props: JSON.parse(fs.readFileSync(path.join(tempDir, 'props.json'), 'utf8')),
      workDir: path.join(tempDir, 'props'),
      outPath: path.join(stageDir, 'props.glb'),
      worldMins,
      worldMaxs,
      lighting: { set: lightmapInfo?.set ?? 'hdr', exposure: lightmapInfo?.exposure ?? 1, floor: lightmapInfo?.floor ?? 0 },
      sunDirection: meta.light?.environment?.direction ?? null,
      meshopt: useMeshopt,
      log: message => console.log(message),
    })
    const p = propsResult.props
    const l = propsResult.stats.lighting
    console.log(`  props.glb ${(propsResult.stats.bytes / 1048576).toFixed(2)} MB: ${p.pak} PAK static props` +
      `${p.dynamic ? ` and ${p.dynamic} unnamed prop_dynamic` : ''} of ${propsResult.stats.models} models ` +
      `(${l.exact} with their VHV, ${l.baked} of them baked exactly and ${l.shared} on a shared pattern that misses theirs; ${l.estimated} estimated), ` +
      `${propsResult.stats.skybox} in the 3D skybox skipped, winding ${(propsResult.stats.winding.agree * 100).toFixed(2)} %; ` +
      `${p.stock} stock props not rendered (${p.stockSolid} solid)`)
  } catch (error) {
    propsResult = null
    propsError = error instanceof Error ? error.message : String(error)
    console.warn(`  WARNING: static props skipped: ${propsError}`)
    fs.rmSync(path.join(stageDir, 'props.glb'), { force: true })
  }
}

// ─── conversion.json ─────────────────────────────────────────────────────────

const env = meta.light?.environment
const conversion = {
  mapName,
  timestamp: new Date().toISOString(),
  pipeline: 'bsp-to-glb',
  converter: { name: versionInfo.name, version: versionInfo.version, target: versionInfo.target, sourceCommit: versionInfo.sourceCommit ?? checkoutCommit, patches: 'scripts/bsp-to-glb/*.patch' },
  worldBounds: {
    boundaryMin: { x: worldMins[0], y: worldMins[1], z: worldMins[2] },
    boundaryMax: { x: worldMaxs[0], y: worldMaxs[1], z: worldMaxs[2] },
  },
  files: {
    model: 'world.glb',
    lightmap: lightmapInfo?.file ?? null,
    visibility: 'visibility.json',
    meta: 'map-meta.json',
    ...(propsResult?.file ? { props: propsResult.file } : {}),
  },
  lightmap: lightmapInfo,
  // Static props: rendered from the PAK, stock (game assets, not rendered), stock and solid.
  ...(propsResult ? { props: propsResult.props } : {}),
  // Same shape convert-map.mjs wrote, so Lights.tsx keeps working unchanged.
  lightEnvironment: env
    ? {
        ambient: env.ambient ? { color: env.ambient.color, brightness: env.ambient.brightness } : null,
        sun: env.sun ? { color: env.sun.color, brightness: env.sun.brightness } : null,
        pitch: env.pitch,
        yaw: env.yaw,
        sunSpreadAngle: env.sunSpreadAngle,
        direction: env.direction,
      }
    : null,
  fog: meta.fog,
  skyboxName: skyboxInfo.name,
  skybox: skyboxInfo,
  camera: meta.camera,
  chunking: { grid: chunkGrid, chunks: chunkNames.length },
  visibility: visibilityInfo,
  stats: {
    exportMs: exportRun.ms,
    sourceFaces: exportStats.faces,
    sourceTriangles: exportStats.triangles,
    keptTriangles: counters.keptTriangles,
    droppedTriangles: counters.droppedTriangles,
    worldFaces: counters.worldFaces,
    skyboxFaces: counters.skyboxFaces,
    brushEntityNodes: entityNodes.length,
    brushEntityNodesWithGeometry: entityNodes.filter(n => n.hasGeometry).length,
    brushEntityNodesInitiallyHidden: entityNodes.filter(n => !n.initiallyVisible).length,
    hiddenBrushEntities: counters.hiddenEntityNodes,
    displacementFaces: exportStats.displacementFaces,
    staticProps: exportStats.staticProps,
    solidStaticProps: exportStats.solidStaticProps,
    dynamicProps: exportStats.dynamicProps,
    sanitizedDisplacementAlphas: exportStats.sanitizedDisplacementAlphas,
    unresolvedMaterialAssets: exportStats.unresolvedMaterialAssets,
    glbBytes: fs.statSync(glbOutPath).size,
    lightmapBytes: lightmapInfo ? fs.statSync(path.join(stageDir, lightmapInfo.file)).size : 0,
    metaBytes: fs.statSync(path.join(stageDir, 'map-meta.json')).size,
    visibilityBytes: fs.statSync(path.join(stageDir, 'visibility.json')).size,
    ...(propsResult ? { props: propsResult.stats } : propsError ? { props: { error: propsError } } : {}),
  },
  materials: Object.fromEntries([...materialStats].sort((a, b) => b[1].triangles - a[1].triangles).map(([name, s]) => [name, { kind: s.kind, triangles: s.triangles, albedo: s.albedo.map(v => +v.toFixed(4)) }])),
  success: true,
}
fs.writeFileSync(path.join(stageDir, 'conversion.json'), JSON.stringify(conversion, null, 1))

// Every step succeeded: move the package into place, conversion.json last.
commitOutputs(
  ['world.glb', ...(lightmapInfo ? [lightmapInfo.file] : []), 'visibility.json', ...(propsResult?.file ? [propsResult.file] : []), 'map-meta.json', 'conversion.json'],
  withProps && !propsResult?.file ? ['props.glb'] : []
)

console.log(`  world.glb ${(conversion.stats.glbBytes / 1048576).toFixed(2)} MB, lightmap ${(conversion.stats.lightmapBytes / 1048576).toFixed(2)} MB, ` +
  `${counters.keptTriangles} tris kept / ${counters.droppedTriangles} dropped, ${chunkNames.length} chunks, ${entityNodes.length} brush entities, ` +
  `${counters.skyboxFaces} skybox faces, sky=${skyboxInfo.name} (${skyboxInfo.source})`)
console.log(`Done → ${outDir}`)
