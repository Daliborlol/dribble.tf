// Model export for the pack: `bsp-to-glb --studio-*` on files read from the VPKs, then a
// gltf-transform post stage (contract 2.5 "Later, models"):
//
//   - LOD 0 only (meshes whose extras.sourceLod is not 0 are removed with their nodes)
//   - unused clips removed through a keepClip hook
//   - empty `mesh.weights` arrays removed
//   - no textures or images (the runtime binds sidecars, contract 2.5 and 4.6)
//   - plain `meshopt` (reorder + quantize + EXT_meshopt_compression), never the full `optimize`,
//     which drops TEXCOORD_0 and LODs
//   - studio facts (attachments, sequences, skins, bodygroups, include models) copied from the
//     bsp-to-glb package manifest into the GLB's root extras, `extras.dribble.studio`
//
//   findBspToGlb(explicit?)                -> absolute path of the binary
//   bspToGlbVersion(bspToGlb)              -> the binary's --version-json (or --version) output
//   exportStudioModel(o)                   -> { glbPath, manifestPath, manifest }
//   postProcessModel(o)                    -> { bytes, sha256, stats } (writes o.output atomically)
//   createModelIo()                        -> NodeIO with every extension and the meshopt codecs
//
// Nothing here writes into the repository; the caller passes a work dir and an output path.

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { NodeIO, Logger } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { prune, meshopt } from '@gltf-transform/functions'
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer'
import { normalizeVpkPath, sha256 } from './vpk.mjs'
import { writeFileAtomic } from './fsutil.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VTX_SUFFIXES = ['.dx90.vtx', '.dx80.vtx', '.sw.vtx', '.vtx']

/**
 * The bsp-to-glb binary: `explicit`, else $BSP_TO_GLB, else <BSP_TO_GLB_DIR>/target/release/bsp-to-glb,
 * else ../bsp-to-glb next to this checkout or next to the main checkout of a worktree.
 */
export function findBspToGlb(explicit) {
  const candidates = []
  if (explicit) candidates.push(path.resolve(explicit))
  if (process.env.BSP_TO_GLB) candidates.push(path.resolve(process.env.BSP_TO_GLB))
  const rel = path.join('target', 'release', 'bsp-to-glb')
  if (process.env.BSP_TO_GLB_DIR) candidates.push(path.join(path.resolve(process.env.BSP_TO_GLB_DIR), rel))
  const checkout = path.resolve(HERE, '..', '..', '..')
  candidates.push(path.join(checkout, '..', 'bsp-to-glb', rel))
  const common = spawnSync('git', ['-C', checkout, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' })
  if (common.status === 0) candidates.push(path.join(path.dirname(common.stdout.trim()), '..', 'bsp-to-glb', rel))
  for (const c of candidates) if (fs.existsSync(c)) return c
  if (explicit) throw new Error(`bsp-to-glb not found at ${explicit}`)
  throw new Error(`bsp-to-glb not found (tried ${candidates.join(', ')}); pass --bsp-to-glb or set BSP_TO_GLB_DIR`)
}

/** The tool version, for the input keys of incremental builds. */
export function bspToGlbVersion(bspToGlb) {
  for (const flag of ['--version-json', '--version']) {
    const r = spawnSync(bspToGlb, [flag], { encoding: 'utf8' })
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim()
  }
  return null
}

const asReaders = source => (Array.isArray(source) ? source : [source]).filter(Boolean)
function readFrom(readers, file) {
  for (const r of readers) {
    const data = r.read(file)
    if (data) return data
  }
  return null
}

/**
 * Reads `<model>.mdl` and its companions from the VPKs (or any `read(path)` sources, first wins),
 * writes them under `workDir` and runs `bsp-to-glb --studio-*`.
 *
 * @param {object} o
 * @param {string} o.bspToGlb
 * @param {object|object[]} o.source   VPK set, PAK reader, or an array of them
 * @param {string} o.modelPath         `models/buildables/sentry1.mdl`
 * @param {string} o.workDir           scratch dir on disk (never /tmp for large runs)
 * @param {number} [o.skin]            `--studio-skin`
 * @param {boolean} [o.ani=true]       pass `<model>.ani` when it exists
 * @param {boolean} [o.phy=false]      pass `<model>.phy` when it exists
 * @param {string} [o.name]            basename of the outputs (default: derived from modelPath)
 */
export function exportStudioModel(o) {
  const readers = asReaders(o.source)
  const modelPath = normalizeVpkPath(o.modelPath)
  if (!modelPath.endsWith('.mdl')) throw new Error(`${o.modelPath}: not an .mdl path`)
  const base = modelPath.slice(0, -4)
  const srcDir = path.join(o.workDir, 'src')
  const files = {}
  const put = (key, vpkPath) => {
    const data = readFrom(readers, vpkPath)
    if (!data) return false
    const target = path.join(srcDir, vpkPath)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, data)
    files[key] = target
    return true
  }
  if (!put('mdl', modelPath)) throw new Error(`${modelPath}: not in the VPKs`)
  const hasVvd = put('vvd', `${base}.vvd`)
  const hasVtx = VTX_SUFFIXES.some(suffix => put('vtx', `${base}${suffix}`))
  if (o.ani !== false) put('ani', `${base}.ani`)
  if (o.phy) put('phy', `${base}.phy`)
  const name = o.name ?? base.replace(/[^a-z0-9_.-]+/g, '_')
  const glbPath = path.join(o.workDir, `${name}.glb`)
  const manifestPath = path.join(o.workDir, `${name}.json`)
  const args = ['--studio-source-path', modelPath, '--studio-mdl', files.mdl]
  if (hasVvd && hasVtx) args.push('--studio-vvd', files.vvd, '--studio-vtx', files.vtx)
  if (files.ani) args.push('--studio-ani', files.ani)
  if (files.phy) args.push('--studio-phy', files.phy)
  if (o.skin !== undefined && o.skin !== null) args.push('--studio-skin', String(o.skin))
  args.push('--studio-out', glbPath, '--studio-manifest', manifestPath)
  const r = spawnSync(o.bspToGlb, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) {
    const message = (r.stderr || r.stdout || `exit ${r.status}`).trim().split('\n').find(Boolean)
    throw new Error(`${modelPath}: bsp-to-glb studio export failed: ${message}`)
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  return { glbPath, manifestPath, manifest, files, warnings: (r.stderr || '').trim().split('\n').filter(Boolean) }
}

let codecsReady = null
/** NodeIO with every gltf-transform extension and the meshopt encoder and decoder. */
export async function createModelIo() {
  codecsReady ??= Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready])
  await codecsReady
  return new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder })
}

/** Studio facts worth keeping beside the geometry; node indices are dropped (pruning renumbers). */
export function studioInfo(manifest) {
  if (!manifest) return null
  const strip = list => (Array.isArray(list) ? list.map(({ gltfNode, ...rest }) => rest) : [])
  return {
    sourcePath: manifest.sourcePath ?? null,
    mdlVersion: manifest.mdlVersion ?? null,
    checksum: manifest.checksum ?? null,
    bounds: manifest.bounds ?? null,
    materials: manifest.materials ?? [],
    skinFamilies: manifest.skinFamilies ?? [],
    bodyParts: manifest.bodyParts ?? [],
    attachments: strip(manifest.attachments),
    sequences: manifest.sequences ?? [],
    includeModels: manifest.includeModels ?? [],
  }
}

const clipPredicate = keep => {
  if (keep === undefined || keep === null || keep === true) return () => true
  if (keep === false) return () => false
  if (keep instanceof RegExp) return name => keep.test(name)
  if (Array.isArray(keep)) { const s = new Set(keep); return name => s.has(name) }
  if (typeof keep === 'function') return keep
  throw new Error('keepClip must be a boolean, RegExp, array of names or function')
}

/**
 * The post stage. Reads `o.input` (a bsp-to-glb studio GLB), writes `o.output` atomically.
 *
 * @param {object} o
 * @param {string} o.input
 * @param {string} o.output
 * @param {boolean} [o.lod0=true]
 * @param {boolean|RegExp|string[]|Function} [o.keepClip=true]  which animations stay (by name)
 * @param {boolean} [o.dropTextures=true]
 * @param {boolean} [o.meshopt=true]
 * @param {'high'|'medium'} [o.level='high']
 * @param {object} [o.studioManifest]  the bsp-to-glb package manifest, copied into extras.dribble.studio
 * @param {object} [o.extras]          more root extras under `dribble`
 * @param {(doc) => void|Promise<void>} [o.transform]  a hook that runs after pruning, before meshopt
 * @param {boolean} [o.verbose=false] gltf-transform's info log (prune and quantize notes)
 */
export async function postProcessModel(o) {
  const io = await createModelIo()
  const doc = await io.read(o.input)
  doc.setLogger(new Logger(o.verbose ? Logger.Verbosity.INFO : Logger.Verbosity.ERROR))
  const root = doc.getRoot()
  const before = countDoc(doc)
  let lodsRemoved = 0
  if (o.lod0 !== false) {
    for (const node of root.listNodes()) {
      const mesh = node.getMesh()
      if (!mesh) continue
      const lod = mesh.getExtras()?.sourceLod ?? node.getExtras()?.sourceLod
      if (lod !== undefined && lod !== 0) {
        node.setMesh(null)
        node.dispose()
        lodsRemoved++
      }
    }
    for (const mesh of root.listMeshes()) {
      const lod = mesh.getExtras()?.sourceLod
      if (lod !== undefined && lod !== 0) mesh.dispose()
    }
  }
  const keep = clipPredicate(o.keepClip)
  const clipsKept = [], clipsRemoved = []
  for (const animation of root.listAnimations()) {
    const name = animation.getName()
    if (keep(name)) { clipsKept.push(name); continue }
    clipsRemoved.push(name)
    for (const channel of animation.listChannels()) channel.dispose()
    for (const sampler of animation.listSamplers()) sampler.dispose()
    animation.dispose()
  }
  if (o.dropTextures !== false) for (const texture of root.listTextures()) texture.dispose()
  let emptyWeights = 0
  for (const mesh of root.listMeshes()) {
    if (mesh.getWeights().length === 0) emptyWeights++
    mesh.setWeights([])
  }
  // keepLeaves keeps attachment and bone leaf nodes; keepExtras keeps nodes that only carry extras.
  await doc.transform(prune({ keepLeaves: true, keepExtras: true, keepAttributes: true, keepIndices: true }))
  if (o.transform) await o.transform(doc)
  const info = studioInfo(o.studioManifest)
  if (info || o.extras) {
    const extras = root.getExtras() ?? {}
    root.setExtras({ ...extras, dribble: { ...(extras.dribble ?? {}), ...(info ? { studio: info } : {}), ...(o.extras ?? {}) } })
  }
  if (o.meshopt !== false) await doc.transform(meshopt({ encoder: MeshoptEncoder, level: o.level ?? 'high' }))
  const glb = Buffer.from(await io.writeBinary(doc))
  const json = glbJson(glb)
  const leftoverWeights = (json.meshes ?? []).filter(m => Array.isArray(m.weights) && m.weights.length === 0).length
  if (leftoverWeights) throw new Error(`${o.input}: ${leftoverWeights} meshes still carry empty weights`)
  writeFileAtomic(o.output, glb)
  return {
    bytes: glb.length,
    sha256: sha256(glb),
    stats: { before, after: countDoc(doc), lodsRemoved, clipsKept, clipsRemoved, emptyWeightsRemoved: emptyWeights },
  }
}

function countDoc(doc) {
  const root = doc.getRoot()
  let triangles = 0, vertices = 0
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices()
      const count = prim.getAttribute('POSITION')?.getCount() ?? 0
      vertices += count
      triangles += Math.floor((idx ? idx.getCount() : count) / 3)
    }
  }
  return { nodes: root.listNodes().length, meshes: root.listMeshes().length, animations: root.listAnimations().length, triangles, vertices }
}

/** The JSON chunk of a GLB. */
export function glbJson(glb) {
  if (glb.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB')
  const length = glb.readUInt32LE(12)
  return JSON.parse(glb.toString('utf8', 20, 20 + length))
}
