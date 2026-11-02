/**
 * static-props.mjs: PAK static props -> props.glb (contract section 4.8, task M2).
 *
 * Stock static props are TF2 game assets and stay invisible (decision D1/D7). Many community maps
 * ship some of their prop models inside the BSP's PAK lump (cliff walls, terrain patches, custom
 * buildings); those are map data on disk and are converted here.
 *
 * Inputs come from the two bsp-to-glb passes that scripts/convert-bsp.mjs already runs:
 *   pakDir      pass 1 --pak-output: every PAK file (models/**.mdl/.vvd/.vtx, materials/**, sp_*.vhv)
 *   propsJson   pass 2 --props-out:  the static prop lump (sprp) and the prop_dynamic entities
 * Each PAK model converts once with `bsp-to-glb --studio-*`; its LOD 0 meshes of the default body
 * group become one glTF mesh per (model, skin, lighting cluster). Instances use EXT_mesh_gpu_instancing
 * (three r163's GLTFLoader turns them into InstancedMesh): TRANSLATION, ROTATION (and SCALE) in glTF
 * axes, so the file mounts under the same rotated `world` group as world.glb, and `_COLOR_0` (three:
 * instanceColor). Instances inside the 3D skybox are left out (the runtime hides skybox_3d).
 *
 * prop_dynamic entities with PAK models are included when they are static in practice: no targetname,
 * no parent, enabled, drawn, and a model without animation (eruption's terrain rocks).
 *
 * Colour. Vertex colour = flat albedo x lighting, as on world.glb (albedo vertex colours x lightmap):
 *   albedo    the PAK texture's average linear colour (VTF reflectivity, the value VBSP uses for brush
 *             texdata), else NEUTRAL (#8a8a8a) when the material or texture is not in the PAK.
 *             $alphatest and $translucent materials decode the texture instead: a cutout takes the mean
 *             colour of the texels that pass the alpha test and draws opaque when at least
 *             OPAQUE_COVERAGE of them pass (tarps, dense pine cards), else with that share as its
 *             alpha (sparse leaf cards); a blend takes the alpha-weighted colour and the texture's
 *             mean alpha. Without the texture in the PAK, cutouts keep ALPHA_CUTOUT.
 *   lighting  the PAK's per-vertex lighting (VRAD's sp[_hdr]_<prop>.vhv, one file per instance), in the
 *             world lightmap's scale: linear * exposure + floor (conversion.json lightmap).
 * Instances of one model share the vertex data, so lighting is factored as instanceLight x shading:
 * the instance colour carries the instance's mean light, the vertex colour carries the albedo and a
 * shading pattern shared by a cluster of instances that see the sun from a similar direction in model
 * space (mean of each member's light / its mean). A model with one instance gets its exact VHV.
 * Instances whose cluster pattern misses their own VHV by more than BAKE_ERROR keep their exact
 * lighting in one merged, pre-transformed batch (one draw call per material kind) while the per-map
 * vertex budget lasts. When the budget is short, those clusters are first split by lighting pattern
 * (props in a row along one wall share a shadow); the instances left over after both keep a shared
 * pattern and are tagged lighting 'shared'.
 * Instances without a VHV borrow the light of the nearest lit PAK instances.
 *
 * Winding. Studio models have clockwise front faces (the VTX order bsp-to-glb's studio export keeps);
 * every triangle is reversed for glTF, and a check fails the pass when the result does not face along
 * the vertex normals (WINDING_MIN_AGREEMENT).
 *
 * Materials carry extras.dribble = { kind, lightmap: false } like world.glb, so the runtime applies the
 * same shared bsp-to-glb material rules (src/highlander/map/bspMaterials.ts).
 *
 * Stock props (asset contract 9 "M3-props", task M3-props). With `stockSource` (the A0-pack VPK set of
 * scripts/assets/lib/vpk.mjs) a model, material or texture missing from the PAK is read from the user's
 * own VPKs; the PAK wins. A stock source always means stock-only output: the file holds the stock
 * instances alone (props-stock.glb of the local asset pack, never public/): every prop_static whose model is not in the PAK, plus unnamed, unparented,
 * non-animated prop_dynamic entities with stock models (the PAK rule). Their light is the same VRAD
 * per-vertex lighting from the PAK's sp[_hdr]_<prop>.vhv, so they look exactly like the PAK props. In
 * stock mode VMTs follow asset contract 2.6 through scripts/assets/lib/vmt.mjs (last key wins, DX9
 * conditionals, patches, alpha-test reference 0.5), and models whose winding agreement is below
 * WINDING_MIN_AGREEMENT are left out and listed in stats.excludedModels. Without `stockSource` nothing of
 * this runs and props.glb is byte-identical to the M2 output.
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { NodeIO, Document, Logger } from '@gltf-transform/core'
import { ALL_EXTENSIONS, EXTMeshGPUInstancing, KHRMaterialsUnlit } from '@gltf-transform/extensions'
import { meshopt, quantize, prune } from '@gltf-transform/functions'
import { MeshoptEncoder } from 'meshoptimizer'

import * as vmtRules from '../assets/lib/vmt.mjs'

// ─── constants ───────────────────────────────────────────────────────────────

/** NEUTRAL of src/highlander/constants.ts (#8a8a8a) as a linear colour. */
const NEUTRAL_LINEAR = srgbToLinear(0x8a / 255)
/** Origins this far outside world_mins/maxs belong to the 3D skybox (drawn x16 in game; hidden here). */
const SKYBOX_MARGIN = 64
/** Instances whose model-space sun directions are within about 25 degrees share one shading pattern. */
const CLUSTER_COS = 0.9
/** Relative RMS error (luminance) of the shared shading above which an instance keeps its exact VHV. */
const BAKE_ERROR = 0.2
/**
 * Vertices per map that the merged exact-VHV batch may hold (about 12 bytes each in props.glb). 250k
 * bakes every candidate on all maps but tetsudo, whose candidates would need about 560k.
 */
const BAKE_VERTEX_BUDGET = 250_000
/** Most lighting patterns one sun cluster splits into when the bake budget is short (step 4b). */
const PATTERN_SPLITS = 16
/** Alpha of see-through prop surfaces (same values as the world converter's cutouts and blends). */
const ALPHA_CUTOUT = 0.55
const ALPHA_BLEND = 0.5
/**
 * $alphatest materials whose PAK texture passes the test on at least this share of its texels draw
 * opaque: a tarp (DXT1, no alpha at all) or a dense pine card is a solid surface in game. Sparser
 * cutouts draw at their coverage (bamboo 14 to 17 %, oak 26 %), the share of the card that blocks the
 * view, so looking through three layers of bamboo leaves hides about 43 % of what is behind them as in
 * game, instead of 91 % at ALPHA_CUTOUT. MIN_CUTOUT_ALPHA keeps the sparsest cards visible.
 */
const OPAQUE_COVERAGE = 0.85
const MIN_CUTOUT_ALPHA = 0.15
/** Alpha-test reference when the VMT sets none (the shader API's default GEQUAL reference). */
const DEFAULT_ALPHA_REF = 0.7
/** Alpha range of $translucent prop surfaces whose opacity comes from the texture's mean alpha. */
const BLEND_ALPHA_RANGE = [0.15, 0.9]
/**
 * Triangle winding check. Source draws studio models with clockwise front faces, the reverse of glTF,
 * so loadStudioModel reverses every triangle. Afterwards, for nearly every drawn triangle, the face
 * normal of its counter-clockwise order points the same way as its vertex normals. The pass fails when
 * fewer than this share of the drawn triangles agree (an inside-out props.glb draws the inner faces of
 * closed props and culls one-sided ones such as cliff faces), and warns about single models below it
 * (two-sided foliage cards, models authored with inverted normals).
 */
const WINDING_MIN_AGREEMENT = 0.9
/** sprp flags (public/gamebspfile.h). */
const STATIC_PROP_NO_PER_VERTEX_LIGHTING = 0x40
/** VTX layout of TF2-era models (studio v44-v48), the sizes bsp-to-glb's own VTX reader uses. */
const VTX = { header: 36, bodyPart: 8, model: 8, lod: 12, mesh: 9, stripGroup: 25 }

// ─── small helpers ───────────────────────────────────────────────────────────

function srgbToLinear(v) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}
const clamp01 = v => Math.min(1, Math.max(0, v))
const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b
const normalizePath = p => String(p ?? '').replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
const round = (v, n = 4) => +Number(v).toFixed(n)

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return []
  const out = []
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else out.push(full)
    }
  }
  return out
}

/** Case-insensitive index of the extracted PAK: lowercased archive path -> file on disk. */
export function indexPak(pakDir) {
  const index = new Map()
  for (const file of walkFiles(pakDir)) {
    index.set(normalizePath(path.relative(pakDir, file)), file)
  }
  return index
}

/**
 * The PAK index with the VPKs behind it (stock mode): get(key) returns the PAK file, else the VPK file
 * extracted once under `dir`; has(key) is true for either. Keys are lower case archive paths.
 */
function stockFiles(pakIndex, source, dir) {
  const extracted = new Map()
  const get = key => {
    const inPak = pakIndex.get(key)
    if (inPak) return inPak
    if (extracted.has(key)) return extracted.get(key)
    let file
    if (!key.split('/').some(seg => seg === '..' || seg === '') && source.has(key)) {
      const data = source.read(key)
      if (data) {
        file = path.join(dir, key)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, data)
      }
    }
    extracted.set(key, file)
    return file
  }
  return { get, has: key => pakIndex.has(key) || source.has(key) }
}

// ─── binary formats ──────────────────────────────────────────────────────────

/** studiohdr_t.checksum (MDL header: id, version, checksum). */
export function mdlChecksum(buf) {
  return buf.length >= 12 ? buf.readInt32LE(8) >>> 0 : null
}

/**
 * Strip-group vertex counts of a .vtx file, nested [bodyPart][model][lod][mesh][stripGroup].
 * VRAD writes one VHV entry per strip group in exactly this order (vradstaticprops.cpp
 * ApplyLightingToStaticProp), and bsp-to-glb emits a mesh's vertices strip group by strip group.
 */
export function parseVtxStripGroups(buf) {
  const i32 = offset => {
    if (offset < 0 || offset + 4 > buf.length) throw new Error(`VTX read out of range at ${offset}`)
    return buf.readInt32LE(offset)
  }
  const checksum = i32(16) >>> 0
  const numLods = i32(20)
  const numBodyParts = i32(28)
  const bodyPartOffset = i32(32)
  const bodyParts = []
  for (let b = 0; b < numBodyParts; b++) {
    const bp = bodyPartOffset + b * VTX.bodyPart
    const numModels = i32(bp)
    const modelOffset = i32(bp + 4)
    const models = []
    for (let m = 0; m < numModels; m++) {
      const mo = bp + modelOffset + m * VTX.model
      const lodCount = i32(mo)
      const lodOffset = i32(mo + 4)
      const lods = []
      for (let l = 0; l < lodCount; l++) {
        const lo = mo + lodOffset + l * VTX.lod
        const numMeshes = i32(lo)
        const meshOffset = i32(lo + 4)
        const meshes = []
        for (let k = 0; k < numMeshes; k++) {
          const me = lo + meshOffset + k * VTX.mesh
          const numGroups = i32(me)
          const groupOffset = i32(me + 4)
          const groups = []
          for (let g = 0; g < numGroups; g++) groups.push(i32(me + groupOffset + g * VTX.stripGroup))
          meshes.push(groups)
        }
        lods.push(meshes)
      }
      models.push(lods)
    }
    bodyParts.push(models)
  }
  return { checksum, numLods, bodyParts }
}

/**
 * HardwareVerts file (materialsystem/hardwareverts.h, VHV_VERSION 2): a 40-byte header, 28-byte mesh
 * headers, then per mesh `count` BGRA8888 colours at `offset`.
 */
export function parseVhv(buf) {
  if (buf.length < 40) return null
  const header = {
    version: buf.readInt32LE(0),
    checksum: buf.readUInt32LE(4),
    vertexFlags: buf.readUInt32LE(8),
    vertexSize: buf.readUInt32LE(12),
    vertexes: buf.readUInt32LE(16),
    meshCount: buf.readInt32LE(20),
  }
  if (header.meshCount < 0 || 40 + header.meshCount * 28 > buf.length) return null
  const meshes = []
  for (let n = 0; n < header.meshCount; n++) {
    const o = 40 + n * 28
    meshes.push({ lod: buf.readUInt32LE(o), count: buf.readUInt32LE(o + 4), offset: buf.readUInt32LE(o + 8) })
  }
  return { ...header, meshes, buf }
}

/**
 * VRAD stores vertex light as ConvertRGBExp32ToRGBA8888: v = min(1, 0.5 * linear^(1/2.2)) per channel
 * (MathLib_Init(2.2, 2.2, 0, 2): gamma 2.2, overbright 2), bytes in b, g, r, a order.
 */
const VHV_TO_LINEAR = Float32Array.from({ length: 256 }, (_, b) => Math.pow((2 * b) / 255, 2.2))

/** VTF 7.x header reflectivity (float[3] at byte 32): the texture's average linear colour. */
export function vtfReflectivity(buf) {
  if (buf.length < 44 || buf.toString('latin1', 0, 3) !== 'VTF') return null
  const r = [buf.readFloatLE(32), buf.readFloatLE(36), buf.readFloatLE(40)]
  if (!r.every(Number.isFinite) || r.some(v => v < 0 || v > 4) || r[0] + r[1] + r[2] < 1e-4) return null
  return r.map(clamp01)
}

// ─── KeyValues (VMT) ─────────────────────────────────────────────────────────

/** Tolerant KeyValues reader: returns { name, body } with lowercased keys (first occurrence wins). */
export function parseKeyValues(text) {
  const tokens = []
  for (let i = 0; i < text.length; ) {
    const c = text[i]
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (c === '{' || c === '}') {
      tokens.push(c)
      i++
    } else if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"' && text[j] !== '\n') j++
      tokens.push({ s: text.slice(i + 1, j) })
      i = j + 1
    } else if (/\s/.test(c)) {
      i++
    } else {
      let j = i
      while (j < text.length && !/[\s{}"]/.test(text[j])) j++
      const word = text.slice(i, j)
      if (!/^\[.*\]$/.test(word)) tokens.push({ s: word }) // [$X360]-style conditionals are dropped
      i = j
    }
  }
  let p = 0
  const block = () => {
    const body = {}
    while (p < tokens.length && tokens[p] !== '}') {
      const key = tokens[p++]
      if (typeof key !== 'object') continue
      const next = tokens[p]
      const name = key.s.toLowerCase()
      if (next === '{') {
        p++
        const child = block()
        p++
        if (!(name in body)) body[name] = child
      } else if (next && typeof next === 'object') {
        p++
        if (!(name in body)) body[name] = next.s
      }
    }
    return body
  }
  while (p < tokens.length && typeof tokens[p] !== 'object') p++
  const name = tokens[p++]?.s ?? ''
  while (p < tokens.length && tokens[p] !== '{') p++
  p++
  return { name: name.toLowerCase(), body: block() }
}

const parseVmtColor = value => {
  if (typeof value !== 'string') return null
  const braces = value.trim().startsWith('{')
  const parts = value.replace(/[[\]{}]/g, ' ').trim().split(/\s+/).map(Number)
  if (parts.length < 3 || !parts.slice(0, 3).every(Number.isFinite)) return null
  return parts.slice(0, 3).map(v => (braces ? v / 255 : v))
}
const truthy = value => value !== undefined && value !== '0' && String(value).toLowerCase() !== 'false'
const truthyM2 = truthy

// ─── geometry helpers ────────────────────────────────────────────────────────

/** Source AngleMatrix (mathlib): rows are the world x, y, z of the prop's forward, left, up axes. */
export function angleMatrix([pitch, yaw, roll]) {
  const rad = Math.PI / 180
  const sp = Math.sin(pitch * rad), cp = Math.cos(pitch * rad)
  const sy = Math.sin(yaw * rad), cy = Math.cos(yaw * rad)
  const sr = Math.sin(roll * rad), cr = Math.cos(roll * rad)
  return [
    [cp * cy, sp * sr * cy - cr * sy, sp * cr * cy + sr * sy],
    [cp * sy, sp * sr * sy + cr * cy, sp * cr * sy - sr * cy],
    [-sp, sr * cp, cr * cp],
  ]
}
/** Source (x, y, z) -> glTF (x, z, -y). */
export const toGltf = v => [v[0], v[2], -v[1]]
/** The same change of basis for a rotation: C * M * C^T. */
export function rotationToGltf(m) {
  const C = [[1, 0, 0], [0, 0, 1], [0, -1, 0]]
  const mul = (a, b) => a.map((row, r) => [0, 1, 2].map(c => row[0] * b[0][c] + row[1] * b[1][c] + row[2] * b[2][c]))
  const Ct = [[1, 0, 0], [0, 0, -1], [0, 1, 0]]
  return mul(mul(C, m), Ct)
}
/** Unit quaternion [x, y, z, w] of a row-major rotation matrix (three.js setFromRotationMatrix). */
export function quaternionOf(m) {
  const [[m11, m12, m13], [m21, m22, m23], [m31, m32, m33]] = m
  const trace = m11 + m22 + m33
  let x, y, z, w
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1)
    w = 0.25 / s
    x = (m32 - m23) * s
    y = (m13 - m31) * s
    z = (m21 - m12) * s
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33)
    w = (m32 - m23) / s
    x = 0.25 * s
    y = (m12 + m21) / s
    z = (m13 + m31) / s
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33)
    w = (m13 - m31) / s
    x = (m12 + m21) / s
    y = 0.25 * s
    z = (m23 + m32) / s
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22)
    w = (m21 - m12) / s
    x = (m13 + m31) / s
    y = (m23 + m32) / s
    z = 0.25 * s
  }
  const n = Math.hypot(x, y, z, w) || 1
  return [x / n, y / n, z / n, w / n]
}

// ─── model conversion ────────────────────────────────────────────────────────

const VTX_SUFFIXES = ['.dx90.vtx', '.vtx', '.dx80.vtx', '.sw.vtx']

/** PAK files of a model path, or null when the MDL or its VVD/VTX companions are missing. */
function modelFiles(pak, modelPath) {
  const key = normalizePath(modelPath)
  const mdl = pak.get(key)
  if (!mdl || !key.endsWith('.mdl')) return null
  const base = key.slice(0, -4)
  const vvd = pak.get(`${base}.vvd`)
  const vtx = VTX_SUFFIXES.map(suffix => pak.get(`${base}${suffix}`)).find(Boolean)
  return vvd && vtx ? { key, mdl, vvd, vtx } : null
}

/**
 * Runs `bsp-to-glb --studio-*` on one PAK model and reads back the LOD 0 meshes of each body part's
 * default model, in Source model space (static props have one identity `static_prop` bone).
 */
async function loadStudioModel({ bspToGlb, io, files, modelPath, workDir, ordinal }) {
  const out = path.join(workDir, `model_${String(ordinal).padStart(3, '0')}`)
  const result = spawnSync(bspToGlb, [
    '--studio-source-path', modelPath,
    '--studio-mdl', files.mdl,
    '--studio-vvd', files.vvd,
    '--studio-vtx', files.vtx,
    '--studio-out', `${out}.glb`,
    '--studio-manifest', `${out}.json`,
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'studio export failed').trim().split('\n')[0])
  const manifest = JSON.parse(fs.readFileSync(`${out}.json`, 'utf8'))
  const doc = await io.read(`${out}.glb`)

  // Bake a non-identity single bone (bone pose x poseToBone); identity on every PAK prop seen so far.
  let boneMatrix = null
  if (manifest.bones.length > 1) throw new Error(`${manifest.bones.length} bones (a static prop has one)`)
  if (manifest.bones.length === 1) {
    const bone = manifest.bones[0]
    const [qx, qy, qz, qw] = bone.quaternion
    const R = [
      [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
      [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
      [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)],
    ]
    const P = bone.poseToBone // 3x4 row-major
    const B = [0, 1, 2].map(r => [0, 1, 2, 3].map(c => R[r][0] * P[c] + R[r][1] * P[4 + c] + R[r][2] * P[8 + c] + (c === 3 ? bone.position[r] : 0)))
    const identity = B.every((row, r) => row.every((v, c) => Math.abs(v - (r === c ? 1 : 0)) < 1e-5))
    if (!identity) boneMatrix = B
  }

  // bsp-to-glb's studio export keeps the VTX triangle order, which is clockwise seen from the front
  // (Direct3D's front face, the way the engine draws studio models). glTF and three.js take
  // counter-clockwise as the front, so every triangle is reversed once, here. A mirroring bone matrix
  // (never seen on a static prop) already reverses the winding itself.
  const reverse = !boneMatrix || determinant3(boneMatrix) > 0
  const primitives = []
  for (const mesh of doc.getRoot().listMeshes()) {
    const extras = mesh.getExtras() || {}
    if (extras.sourceLod !== 0 || extras.sourceModel !== 0) continue
    const prim = mesh.listPrimitives()[0]
    const position = prim?.getAttribute('POSITION')?.getArray()
    const normal = prim?.getAttribute('NORMAL')?.getArray()
    const indices = prim?.getIndices()?.getArray()
    if (!position || !normal || !indices || indices.length === 0) continue
    const positions = Float32Array.from(position)
    const normals = Float32Array.from(normal)
    const triangles = Uint32Array.from(indices)
    if (reverse) {
      for (let t = 0; t + 2 < triangles.length; t += 3) {
        const second = triangles[t + 1]
        triangles[t + 1] = triangles[t + 2]
        triangles[t + 2] = second
      }
    }
    if (boneMatrix) {
      for (let v = 0; v < positions.length; v += 3) {
        const [x, y, z] = [positions[v], positions[v + 1], positions[v + 2]]
        const [nx, ny, nz] = [normals[v], normals[v + 1], normals[v + 2]]
        for (let r = 0; r < 3; r++) {
          positions[v + r] = boneMatrix[r][0] * x + boneMatrix[r][1] * y + boneMatrix[r][2] * z + boneMatrix[r][3]
          normals[v + r] = boneMatrix[r][0] * nx + boneMatrix[r][1] * ny + boneMatrix[r][2] * nz
        }
      }
    }
    primitives.push({
      bodyPart: extras.sourceBodyPart,
      mesh: extras.sourceMesh,
      materialSlot: extras.sourceMaterialSlot,
      positions,
      normals,
      indices: triangles, // counter-clockwise front faces (glTF)
      vertexCount: positions.length / 3,
    })
  }
  primitives.sort((a, b) => a.bodyPart - b.bodyPart || a.mesh - b.mesh)
  return { manifest, primitives }
}

function determinant3(m) {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  )
}

/**
 * Triangles of a primitive whose counter-clockwise face normal points the same way as the sum of
 * their three vertex normals (degenerate triangles and ones with cancelling normals are not counted).
 */
export function windingAgreement({ positions, normals, indices }) {
  let agree = 0, counted = 0
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2]
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2]
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx
    const nx = normals[a] + normals[b] + normals[c]
    const ny = normals[a + 1] + normals[b + 1] + normals[c + 1]
    const nz = normals[a + 2] + normals[b + 2] + normals[c + 2]
    const d = fx * nx + fy * ny + fz * nz
    if (Math.hypot(fx, fy, fz) < 1e-9 || Math.hypot(nx, ny, nz) < 1e-6 || d === 0) continue
    counted++
    if (d > 0) agree++
  }
  return { agree, counted }
}

/**
 * For each LOD 0 primitive of the default models, the VHV entry indices of its strip groups and the
 * vertex count they cover. Null when the VTX and the converted meshes disagree.
 */
function vhvLayout(vtx, primitives) {
  let entry = 0
  const ranges = new Map() // `${bodyPart}:${mesh}` -> { first, count, vertices }
  vtx.bodyParts.forEach((models, b) => {
    models.forEach((lods, m) => {
      lods.forEach((meshes, l) => {
        meshes.forEach((groups, k) => {
          if (m === 0 && l === 0) ranges.set(`${b}:${k}`, { first: entry, count: groups.length, vertices: groups.reduce((a, n) => a + n, 0) })
          entry += groups.length
        })
      })
    })
  })
  for (const prim of primitives) {
    const range = ranges.get(`${prim.bodyPart}:${prim.mesh}`)
    if (!range || range.vertices !== prim.vertexCount) return null
    prim.vhv = range
  }
  return { entries: entry, groupCounts: vtx.bodyParts.flat(4) }
}

// ─── materials ───────────────────────────────────────────────────────────────

/** Material info of a surface without a usable VMT: NEUTRAL, opaque, lit. */
function neutralMaterialInfo(name) {
  const albedo = [NEUTRAL_LINEAR, NEUTRAL_LINEAR, NEUTRAL_LINEAR]
  return { name: String(name).toLowerCase(), vmt: null, shader: null, source: 'neutral', albedo, kind: 'opaque', alpha: 1, unlit: false, skip: null, doubleSided: false }
}

function createMaterialResolver({ pak, vtfToPng, workDir, warn, stock = null }) {
  const vmtCache = new Map()
  const textureCache = new Map()
  let decodeOrdinal = 0
  // Stock mode reads VMTs with the asset contract 2.6 rules (scripts/assets/lib/vmt.mjs), PAK first.
  const truthy = stock ? vmtRules.vmtTruthy : truthyM2
  const defaultAlphaRef = stock ? vmtRules.DEFAULT_ALPHA_TEST_REFERENCE : DEFAULT_ALPHA_REF
  const vmtReaders = stock
    ? [{ read: key => (stock.pakIndex.get(key) ? fs.readFileSync(stock.pakIndex.get(key)) : null) }, stock.source]
    : null

  const readVmt = (key, depth = 0) => {
    if (stock) {
      if (vmtCache.has(key)) return vmtCache.get(key)
      const m = vmtRules.readMaterialFile(vmtReaders, key)
      const result = m ? { shader: String(m.shader ?? '').toLowerCase(), params: m.params, file: key } : null
      vmtCache.set(key, result)
      return result
    }
    if (vmtCache.has(key)) return vmtCache.get(key)
    let result = null
    const file = pak.get(key)
    if (file && depth < 4) {
      const kv = parseKeyValues(fs.readFileSync(file, 'latin1'))
      if (kv.name === 'patch') {
        const base = typeof kv.body.include === 'string' ? readVmt(normalizePath(kv.body.include), depth + 1) : null
        const params = { ...(base?.params ?? {}) }
        for (const section of ['insert', 'replace']) {
          const values = kv.body[section]
          if (values && typeof values === 'object') Object.assign(params, values)
        }
        result = { shader: base?.shader ?? 'patch', params, file: key }
      } else {
        result = { shader: kv.name, params: kv.body, file: key }
      }
    }
    vmtCache.set(key, result)
    return result
  }

  // Top mip of a PAK texture decoded to PNG by the vtf-to-png helper (once per texture), or null.
  const decodeCache = new Map()
  const decodeTexture = key => {
    if (decodeCache.has(key)) return decodeCache.get(key)
    let png = null
    const file = pak.get(key)
    if (file && vtfToPng) {
      const out = path.join(workDir, `tex_${decodeOrdinal++}.png`)
      const result = spawnSync(vtfToPng, [file, out], { encoding: 'utf8' })
      if (result.status === 0 && fs.existsSync(out)) png = out
    }
    decodeCache.set(key, png)
    return png
  }

  // Average linear colour of a PAK texture: the VTF's own reflectivity (what VBSP uses for brush
  // texdata), else the decoded top mip (alpha-weighted), else null.
  const textureColor = key => {
    if (textureCache.has(key)) return textureCache.get(key)
    let color = null
    // Stock mode reads a VPK texture's header only; the file is extracted when it must be decoded.
    const header = stock && !stock.pakIndex.has(key) && stock.source.has(key) ? stock.source.readHead(key, 64) : null
    const file = header ? key : pak.get(key)
    if (file) {
      color = vtfReflectivity(header ?? fs.readFileSync(file))
      if (!color && vtfToPng) {
        const png = decodeTexture(key)
        if (png) color = { png }
        else warn(`texture ${key}: no reflectivity and vtf-to-png failed`)
      }
    }
    textureCache.set(key, color)
    return color
  }

  // Alpha statistics of a see-through PAK texture's top mip: the share of texels that pass an alpha
  // test at `ref`, the mean alpha, the mean linear colour of the passing texels (what an alpha-tested
  // surface shows) and the alpha-weighted mean colour (what a blended surface shows). The VTF
  // reflectivity averages the colour under transparent texels too, which is wrong for sparse cards.
  const alphaCache = new Map()
  const alphaStats = async (key, ref) => {
    const cacheKey = `${key}@${ref}`
    if (alphaCache.has(cacheKey)) return alphaCache.get(cacheKey)
    let stats = null
    const png = decodeTexture(key)
    if (png) {
      try {
        const sharp = (await import('sharp')).default
        const { data, info: meta } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
        const threshold = ref * 255
        const covered = [0, 0, 0], weighted = [0, 0, 0]
        let passing = 0, alphaSum = 0, texels = 0
        for (let i = 0; i < data.length; i += meta.channels, texels++) {
          const a = data[i + 3] / 255
          alphaSum += a
          const rgb = [srgbToLinear(data[i] / 255), srgbToLinear(data[i + 1] / 255), srgbToLinear(data[i + 2] / 255)]
          for (let c = 0; c < 3; c++) weighted[c] += rgb[c] * a
          if (data[i + 3] >= threshold) {
            passing++
            for (let c = 0; c < 3; c++) covered[c] += rgb[c]
          }
        }
        if (texels > 0) {
          stats = {
            coverage: passing / texels,
            meanAlpha: alphaSum / texels,
            coveredColor: passing > 0 ? covered.map(v => v / passing) : null,
            weightedColor: alphaSum > 0 ? weighted.map(v => v / alphaSum) : null,
          }
        }
      } catch (error) {
        warn(`texture ${key}: alpha decode failed (${error.message}); the material keeps its default alpha`)
        stats = null
      }
    }
    alphaCache.set(cacheKey, stats)
    return stats
  }

  // Alpha-weighted mean linear colour of a decoded texture (textures without reflectivity), or null.
  const pngColor = async (key, png) => {
    try {
      const sharp = (await import('sharp')).default
      const { data, info: meta } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      let r = 0, g = 0, b = 0, w = 0
      for (let i = 0; i < data.length; i += meta.channels) {
        const a = data[i + 3] / 255
        if (a < 0.05) continue
        r += srgbToLinear(data[i] / 255) * a
        g += srgbToLinear(data[i + 1] / 255) * a
        b += srgbToLinear(data[i + 2] / 255) * a
        w += a
      }
      return w > 0 ? [r / w, g / w, b / w] : null
    } catch (error) {
      warn(`texture ${key}: colour decode failed (${error.message}); NEUTRAL`)
      return null
    }
  }

  /** Material info for a model material: { name, source, albedo, kind, alpha, unlit, skip, doubleSided }. */
  return async function resolve(materialName, searchPaths, candidates) {
    const tried = [...(candidates ?? [])]
    for (const dir of searchPaths ?? []) tried.push(`materials/${dir}${materialName}.vmt`)
    tried.push(`materials/${materialName}.vmt`)
    let vmt = null
    for (const candidate of tried) {
      vmt = readVmt(normalizePath(candidate))
      if (vmt) break
    }
    const name = materialName.toLowerCase()
    const info = { ...neutralMaterialInfo(name), vmt: vmt?.file ?? null, shader: vmt?.shader ?? null }
    if (/(^|\/)tools?nodraw|(^|\/)nodraw/.test(name)) return { ...info, skip: 'nodraw' }
    if (!vmt) return info
    const p = vmt.params
    if (truthy(p.$additive)) return { ...info, skip: 'additive' }
    if (/^(refract|water|eyerefract|eyes|sprite|spritecard)/.test(vmt.shader)) return { ...info, skip: vmt.shader }
    info.unlit = /^unlitgeneric/.test(vmt.shader)
    info.doubleSided = truthy(p.$nocull)
    if (truthy(p.$alphatest)) Object.assign(info, { kind: 'translucent', alpha: ALPHA_CUTOUT })
    else if (truthy(p.$translucent)) Object.assign(info, { kind: 'translucent', alpha: Math.min(ALPHA_BLEND, Number(p.$alpha) || ALPHA_BLEND) })
    else if (p.$alpha !== undefined && Number(p.$alpha) < 1) Object.assign(info, { kind: 'translucent', alpha: clamp01(Number(p.$alpha)) })
    if (typeof p.$basetexture === 'string') {
      const texture = normalizePath(`materials/${p.$basetexture.replace(/^materials[\\/]/i, '').replace(/\.vtf$/i, '')}.vtf`)
      // See-through materials take their opacity and colour from the texture's alpha when it is in
      // the PAK: dense cutouts draw opaque, blends use the mean alpha.
      const alphaTest = truthy(p.$alphatest)
      if (alphaTest || truthy(p.$translucent)) {
        const ref = Number(p.$alphatestreference) > 0 ? Number(p.$alphatestreference) : defaultAlphaRef
        const stats = await alphaStats(texture, ref)
        if (stats) {
          info.coverage = round(stats.coverage, 3)
          if (alphaTest) {
            if (stats.coverage >= OPAQUE_COVERAGE) Object.assign(info, { kind: 'opaque', alpha: 1 })
            else info.alpha = round(Math.max(MIN_CUTOUT_ALPHA, stats.coverage), 3)
            if (stats.coveredColor) Object.assign(info, { source: 'pak', albedo: stats.coveredColor })
          } else {
            const scale = p.$alpha !== undefined && Number.isFinite(Number(p.$alpha)) ? clamp01(Number(p.$alpha)) : 1
            info.alpha = round(Math.min(BLEND_ALPHA_RANGE[1], Math.max(BLEND_ALPHA_RANGE[0], stats.meanAlpha * scale)), 3)
            if (stats.weightedColor) Object.assign(info, { source: 'pak', albedo: stats.weightedColor })
          }
        }
      }
      let color = info.source === 'pak' ? null : textureColor(texture)
      if (color?.png) {
        color = await pngColor(texture, color.png)
        textureCache.set(texture, color)
      }
      if (color) Object.assign(info, { source: 'pak', albedo: color.slice(0, 3) })
    }
    for (const tint of [parseVmtColor(p.$color2), parseVmtColor(p.$color)]) {
      if (tint) info.albedo = info.albedo.map((v, i) => clamp01(v * tint[i]))
    }
    return info
  }
}

// ─── main ────────────────────────────────────────────────────────────────────

/**
 * Converts the PAK static props of one map into `outPath` (props.glb).
 *
 * @param {object} o
 * @param {string} o.bspToGlb      bsp-to-glb binary
 * @param {string|null} o.vtfToPng vtf-to-png helper (textures without reflectivity, and the alpha of
 *                                 see-through textures)
 * @param {string} o.pakDir        pass-1 PAK extraction
 * @param {object} o.props         pass-2 `--props-out` JSON (schema bsp-to-glb.props)
 * @param {string} o.workDir       scratch directory
 * @param {string} o.outPath       props.glb path
 * @param {number[]} o.worldMins   worldspawn world_mins (Source)
 * @param {number[]} o.worldMaxs   worldspawn world_maxs (Source)
 * @param {{ set: string, exposure: number, floor: number }} o.lighting  world lightmap scale
 * @param {number[]|null} [o.sunDirection] light_environment direction (Source, the way light travels)
 * @param {boolean} [o.meshopt]    meshopt + quantization (default true), else quantization only
 * @param {number} [o.bakeVertexBudget] vertices the merged exact-VHV batch may hold (BAKE_VERTEX_BUDGET)
 * @param {(msg: string) => void} [o.log]
 * @returns {Promise<object>} conversion.json `props` counts plus `stats`
 */
export async function convertStaticProps(o) {
  const started = performance.now()
  const log = o.log ?? (() => {})
  const warnings = []
  const warn = message => {
    warnings.push(message)
    log(`  props: ${message}`)
  }
  fs.mkdirSync(o.workDir, { recursive: true })
  const pakIndex = indexPak(o.pakDir)
  const stockMode = Boolean(o.stockSource)
  // In stock mode a file missing from the PAK comes from the VPKs, extracted once into the work dir
  // (bsp-to-glb and vtf-to-png read files on disk). Without a stock source `pak` is the PAK index itself.
  const pak = stockMode ? stockFiles(pakIndex, o.stockSource, path.join(o.workDir, 'stock')) : pakIndex
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  await MeshoptEncoder.ready
  io.registerDependencies({ 'meshopt.encoder': MeshoptEncoder })

  const exposure = Number(o.lighting?.exposure) || 1
  const floor = Number(o.lighting?.floor) || 0
  const preferHdr = o.lighting?.set !== 'ldr'
  const inSkybox = origin =>
    [0, 1, 2].some(axis => origin[axis] < o.worldMins[axis] - SKYBOX_MARGIN || origin[axis] > o.worldMaxs[axis] + SKYBOX_MARGIN)

  // 1. Split the static prop lump into PAK and stock instances.
  const statics = o.props.staticProps ?? []
  const counts = { pak: 0, dynamic: 0, stock: 0, stockSolid: 0, skybox: 0, unconvertible: 0, dynamicSkipped: {} }
  if (stockMode) Object.assign(counts, { pakModel: 0, missing: 0, skyboxStatic: 0 })
  const byModel = new Map()
  const addInstance = (files, prop) => {
    if (!byModel.has(files.key)) byModel.set(files.key, { modelPath: prop.modelPath, files, instances: [] })
    byModel.get(files.key).instances.push(prop)
  }
  for (const prop of statics) {
    if (stockMode) {
      // Stock mode: PAK models belong to props.glb; `pak` here also resolves VPK files.
      const inPak = modelFiles(pakIndex, prop.modelPath)
      if (inPak) {
        counts.pakModel++
        continue
      }
      const files = modelFiles(pak, prop.modelPath)
      if (!files) {
        counts.missing++
        continue
      }
      if (inSkybox(prop.sourceOrigin)) {
        counts.skybox++
        counts.skyboxStatic++
        continue
      }
      addInstance(files, { ...prop, id: `sp:${prop.staticPropIndex}`, order: prop.staticPropIndex, dynamic: false, scale: 1, stock: true })
      continue
    }
    const files = modelFiles(pak, prop.modelPath)
    if (!files) {
      counts.stock++
      if (prop.solidity) counts.stockSolid++
      if (pak.has(normalizePath(prop.modelPath))) counts.unconvertible++
      continue
    }
    if (inSkybox(prop.sourceOrigin)) {
      counts.skybox++
      continue
    }
    addInstance(files, { ...prop, id: `sp:${prop.staticPropIndex}`, order: prop.staticPropIndex, dynamic: false, scale: 1 })
  }
  // prop_dynamic entities with PAK models that are static in practice: no targetname (no I/O reaches
  // them), no parent, enabled, drawn, and (checked after conversion) a model that does not animate.
  // eruption's terrain rocks are such entities (modelscale 0.17 to 0.7). They have no VHV (the engine
  // lights dynamic props at run time), so they take the estimated light.
  const skipDynamic = reason => {
    counts.dynamicSkipped[reason] = (counts.dynamicSkipped[reason] ?? 0) + 1
  }
  for (const entity of o.props.dynamicProps ?? []) {
    if (!/^prop_dynamic(_override)?$/i.test(entity.classname ?? '')) continue
    if (stockMode && modelFiles(pakIndex, entity.modelPath)) continue // a PAK model: props.glb's
    const files = modelFiles(pak, entity.modelPath)
    if (!files) continue
    const kv = {}
    for (const { key, value } of entity.keyValues ?? []) {
      const name = String(key).toLowerCase()
      if (!(name in kv)) kv[name] = value
    }
    const reason = entity.targetname || kv.targetname ? 'named'
      : kv.parentname ? 'parented'
      : truthy(kv.startdisabled) ? 'disabled'
      : kv.rendermode === '10' || kv.renderamt === '0' ? 'invisible'
      : !(Number(kv.modelscale ?? 1) > 0) ? 'scale'
      : !Array.isArray(entity.sourceOrigin) || !Array.isArray(entity.sourceAngles) ? 'placement'
      : null
    if (reason) {
      skipDynamic(reason)
      continue
    }
    if (inSkybox(entity.sourceOrigin)) {
      counts.skybox++
      continue
    }
    addInstance(files, {
      id: `ent:${entity.entityIndex}`,
      order: 1_000_000 + entity.entityIndex,
      dynamic: true,
      entityIndex: entity.entityIndex,
      staticPropIndex: -1,
      modelPath: entity.modelPath,
      sourceOrigin: entity.sourceOrigin,
      sourceAngles: entity.sourceAngles,
      skin: Number(kv.skin) || 0,
      solidity: Number(kv.solid) || 0,
      scale: Number(kv.modelscale ?? 1),
      flags: 0,
    })
  }

  // 2. Convert each model once and map its VHV layout.
  const models = []
  let ordinal = 0
  for (const [key, entry] of [...byModel].sort((a, b) => a[0].localeCompare(b[0]))) {
    try {
      const studio = await loadStudioModel({ bspToGlb: o.bspToGlb, io, files: entry.files, modelPath: entry.modelPath, workDir: o.workDir, ordinal: ordinal++ })
      if (studio.primitives.length === 0) throw new Error('no LOD 0 geometry')
      const vtx = parseVtxStripGroups(fs.readFileSync(entry.files.vtx))
      const checksum = mdlChecksum(fs.readFileSync(entry.files.mdl))
      const layout = vhvLayout(vtx, studio.primitives)
      if (!layout) warn(`${entry.modelPath}: VTX strip groups do not match the converted meshes; VHV ignored`)
      // A prop_dynamic whose model animates (fans, flags) would move in game: leave it out.
      if ((studio.manifest.animations ?? []).some(animation => animation.frameCount > 1)) {
        entry.instances = entry.instances.filter(prop => {
          if (prop.dynamic) skipDynamic('animated')
          return !prop.dynamic
        })
        if (entry.instances.length === 0) continue
      }
      const winding = studio.primitives.reduce((sum, prim) => {
        const { agree, counted } = windingAgreement(prim)
        return { agree: sum.agree + agree, counted: sum.counted + counted }
      }, { agree: 0, counted: 0 })
      models.push({ key, ...entry, ...studio, checksum, layout, winding })
    } catch (error) {
      if (entry.instances.every(prop => prop.dynamic)) {
        entry.instances.forEach(() => skipDynamic('unsupported')) // e.g. a skinned, animated prop_dynamic
        continue
      }
      warn(`${entry.modelPath}: ${error.message}; ${entry.instances.length} instance(s) skipped`)
      counts.unconvertible += entry.instances.length
    }
  }

  // 2b. Winding: the reversed triangles must face the way their vertex normals point. The gate counts
  //     drawn triangles (each model times its instances): a systematic inversion drives it towards 0,
  //     while a few models authored with inverted normals (eruption's war-room table and lamp, whose
  //     faces point outwards by ray parity) only lower it slightly and are reported per model.
  // Stock mode: a model below WINDING_MIN_AGREEMENT (inside-out or two-sided cards authored with
  // flipped normals) is left out and listed; the pass-level gate below still applies to the rest.
  const excludedModels = []
  if (stockMode) {
    for (let i = models.length - 1; i >= 0; i--) {
      const model = models[i]
      if (!model.winding.counted || model.winding.agree / model.winding.counted >= WINDING_MIN_AGREEMENT) continue
      excludedModels.push({ model: model.modelPath, agree: round(model.winding.agree / model.winding.counted, 3), triangles: model.winding.counted, instances: model.instances.length, staticInstances: model.instances.filter(prop => !prop.dynamic).length })
      models.splice(i, 1)
    }
    excludedModels.sort((a, b) => a.model.localeCompare(b.model))
  }
  const winding = { agree: 0, counted: 0, drawnAgree: 0, drawnCounted: 0 }
  for (const model of models) {
    winding.agree += model.winding.agree
    winding.counted += model.winding.counted
    winding.drawnAgree += model.winding.agree * model.instances.length
    winding.drawnCounted += model.winding.counted * model.instances.length
  }
  const windingShare = winding.drawnCounted ? winding.drawnAgree / winding.drawnCounted : 1
  const windingLow = models
    .filter(model => model.winding.counted && model.winding.agree / model.winding.counted < WINDING_MIN_AGREEMENT)
    .map(model => ({ model: model.modelPath, agree: round(model.winding.agree / model.winding.counted, 3), triangles: model.winding.counted, instances: model.instances.length }))
  for (const low of windingLow) warn(`${low.model}: only ${(low.agree * 100).toFixed(1)} % of ${low.triangles} triangles face along their vertex normals (${low.instances} instance(s))`)
  if (windingShare < WINDING_MIN_AGREEMENT) {
    throw new Error(`winding check failed: ${(windingShare * 100).toFixed(1)} % of ${winding.drawnCounted} drawn prop triangles face along their vertex normals (need ${WINDING_MIN_AGREEMENT * 100} %)`)
  }

  // 3. Per-instance vertex lighting from the VHV files (world lightmap scale).
  // exact: instances with a valid VHV; of those, baked ones carry it exactly in the merged batch and
  // shared ones are drawn with a cluster pattern that misses it by more than BAKE_ERROR (worstDrawnError
  // is the largest such miss). estimated: no usable VHV (mismatched counts invalid files).
  const vhvStats = { exact: 0, estimated: 0, mismatched: 0, baked: 0, shared: 0, worstDrawnError: 0, bakeVerticesLeft: 0, set: preferHdr ? 'hdr' : 'ldr' }
  const readInstanceLight = (model, prop) => {
    if (prop.dynamic || !model.layout || prop.flags & STATIC_PROP_NO_PER_VERTEX_LIGHTING) return null
    const names = preferHdr ? [`sp_hdr_${prop.staticPropIndex}.vhv`, `sp_${prop.staticPropIndex}.vhv`] : [`sp_${prop.staticPropIndex}.vhv`, `sp_hdr_${prop.staticPropIndex}.vhv`]
    const file = names.map(name => pak.get(name)).find(Boolean)
    if (!file) return null
    const vhv = parseVhv(fs.readFileSync(file))
    const valid = vhv && vhv.version === 2 && vhv.vertexSize === 4 && vhv.checksum === model.checksum &&
      vhv.meshes.length === model.layout.entries && vhv.meshes.every((mesh, n) => mesh.count === model.layout.groupCounts[n])
    if (!valid) {
      vhvStats.mismatched++
      return null
    }
    return model.primitives.map(prim => {
      const light = new Float32Array(prim.vertexCount * 3)
      let v = 0
      for (let g = prim.vhv.first; g < prim.vhv.first + prim.vhv.count; g++) {
        const mesh = vhv.meshes[g]
        for (let k = 0; k < mesh.count; k++, v++) {
          const o4 = mesh.offset + k * 4
          if (o4 + 3 > vhv.buf.length) return null
          light[v * 3] = VHV_TO_LINEAR[vhv.buf[o4 + 2]] * exposure + floor
          light[v * 3 + 1] = VHV_TO_LINEAR[vhv.buf[o4 + 1]] * exposure + floor
          light[v * 3 + 2] = VHV_TO_LINEAR[vhv.buf[o4]] * exposure + floor
        }
      }
      return light
    })
  }
  const lit = [] // { origin, mean } of every instance with its own VHV, for the neighbour estimate
  for (const model of models) {
    for (const prop of model.instances) {
      const light = readInstanceLight(model, prop)
      prop.light = light && light.every(Boolean) ? light : null
      if (prop.light) {
        const sum = [0, 0, 0]
        let n = 0
        for (const channel of prop.light) {
          for (let v = 0; v < channel.length; v += 3, n++) {
            sum[0] += channel[v]
            sum[1] += channel[v + 1]
            sum[2] += channel[v + 2]
          }
        }
        prop.mean = sum.map(s => s / Math.max(1, n))
        lit.push({ origin: prop.sourceOrigin, mean: prop.mean })
      }
    }
  }
  // Instances without a VHV (none written, or STATIC_PROP_NO_PER_VERTEX_LIGHTING): the inverse-distance
  // mean light of the 4 nearest lit PAK instances within 1024 units, else the median lit instance,
  // else the exposure target.
  const median = (() => {
    const sorted = [...lit].sort((a, b) => luminance(...a.mean) - luminance(...b.mean))
    return sorted.length ? sorted[sorted.length >> 1].mean : [1, 1, 1]
  })()
  const estimateLight = origin => {
    const near = lit
      .map(entry => ({ entry, d: Math.hypot(entry.origin[0] - origin[0], entry.origin[1] - origin[1], entry.origin[2] - origin[2]) }))
      .filter(({ d }) => d < 1024)
      .sort((a, b) => a.d - b.d)
      .slice(0, 4)
    if (near.length === 0) return median
    let w = 0
    const sum = [0, 0, 0]
    for (const { entry, d } of near) {
      const weight = 1 / Math.max(32, d)
      w += weight
      for (let c = 0; c < 3; c++) sum[c] += entry.mean[c] * weight
    }
    return sum.map(v => v / w)
  }

  // 4. Group the instances of each (model, skin) into clusters that see the sun from a similar
  //    direction in model space: their direct-light patterns, and so their shared shading, agree.
  const toSun = (() => {
    const d = o.sunDirection
    if (!Array.isArray(d) || d.length < 3 || !d.every(Number.isFinite)) return null
    const n = Math.hypot(d[0], d[1], d[2])
    return n > 0 ? [-d[0] / n, -d[1] / n, -d[2] / n] : null // light_environment direction is the way light travels
  })()
  const resolveMaterial = createMaterialResolver({ pak, vtfToPng: o.vtfToPng, workDir: o.workDir, warn, stock: stockMode ? { pakIndex, source: o.stockSource } : null })
  const materialStats = new Map()
  const stats = { models: 0, clusters: 0, patternSplits: 0, bakeDemand: null, nodes: 0, instancedNodes: 0, bakedInstances: 0, primitives: 0, vertices: 0, triangles: 0, renderedTriangles: 0, skippedPrimitives: 0, materials: { pak: 0, neutral: 0 }, worstSharedError: 0 }
  const materialFor = async (model, skin, prim) => {
    const families = model.manifest.skinFamilies ?? []
    const family = families[skin] ?? families[0]
    const textureIndex = family ? family.textureIndices[prim.materialSlot] : prim.materialSlot
    const mat = model.manifest.materials[textureIndex] ?? model.manifest.materials[prim.materialSlot]
    if (!mat) return { name: '?', skip: 'material' }
    if (!materialStats.has(mat.name)) {
      let info
      try {
        info = await resolveMaterial(mat.name, mat.searchPaths, mat.candidates)
      } catch (error) {
        // A broken VMT or texture must not abort the pass: the surface draws NEUTRAL and opaque.
        warn(`material ${mat.name}: ${error.message}; drawn NEUTRAL`)
        info = neutralMaterialInfo(mat.name)
      }
      materialStats.set(mat.name, info)
      if (!info.skip) stats.materials[info.source === 'pak' ? 'pak' : 'neutral']++
    }
    return materialStats.get(mat.name)
  }
  const relativeError = (prop, primIndex, shading) => {
    let se = 0, sl = 0, n = 0
    primIndex.forEach((pi, p) => {
      const L = prop.light[pi]
      for (let v = 0; v < L.length; v += 3, n++) {
        const actual = luminance(L[v], L[v + 1], L[v + 2])
        se += (actual - luminance(prop.mean[0] * shading[p][v], prop.mean[1] * shading[p][v + 1], prop.mean[2] * shading[p][v + 2])) ** 2
        sl += actual
      }
    })
    return Math.sqrt(se / Math.max(1, n)) / Math.max(1e-4, sl / Math.max(1, n))
  }
  // Shared shading of lit instances: the mean of light / instance mean, per vertex and channel.
  const meanShading = (model, primIndex, members) => {
    const shading = primIndex.map(pi => new Float32Array(model.primitives[pi].vertexCount * 3))
    for (const { prop } of members) {
      primIndex.forEach((pi, p) => {
        const L = prop.light[pi]
        for (let v = 0; v < L.length; v++) shading[p][v] += L[v] / Math.max(1e-4, prop.mean[v % 3]) / members.length
      })
    }
    return shading
  }

  const groups = []
  for (const model of models) {
    stats.models++
    let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
    for (const prim of model.primitives) {
      for (let v = 0; v < prim.positions.length; v += 3) {
        for (let a = 0; a < 3; a++) {
          min[a] = Math.min(min[a], prim.positions[v + a])
          max[a] = Math.max(max[a], prim.positions[v + a])
        }
      }
    }
    const radius = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2
    const bySkin = new Map()
    for (const prop of model.instances) {
      const skin = Number.isInteger(prop.skin) && prop.skin >= 0 ? prop.skin : 0
      if (!bySkin.has(skin)) bySkin.set(skin, [])
      bySkin.get(skin).push(prop)
    }
    for (const [skin, props] of [...bySkin].sort((a, b) => a[0] - b[0])) {
      props.sort((a, b) => a.order - b.order)
      const parts = []
      for (const prim of model.primitives) {
        const info = await materialFor(model, skin, prim)
        if (info.skip) stats.skippedPrimitives++
        else parts.push({ prim, info })
      }
      if (parts.length === 0) continue
      const primIndex = parts.map(part => model.primitives.indexOf(part.prim))
      const clusters = []
      for (const prop of props) {
        const R = angleMatrix(prop.sourceAngles)
        const entry = { prop, R, modelPath: model.modelPath, light: prop.light ? prop.mean : estimateLight(prop.sourceOrigin), lighting: prop.light ? 'vhv' : 'estimated', radius: radius * prop.scale }
        if (prop.light) vhvStats.exact++
        else vhvStats.estimated++
        // Sun direction in model space (R maps model to world, so R^T maps back); without a sun, the
        // orientation rounded to 45 degrees of yaw and 15 of pitch and roll.
        const key = toSun
          ? [0, 1, 2].map(c => R[0][c] * toSun[0] + R[1][c] * toSun[1] + R[2][c] * toSun[2])
          : `${Math.round(prop.sourceAngles[1] / 45) & 7}:${Math.round(prop.sourceAngles[0] / 15)}:${Math.round(prop.sourceAngles[2] / 15)}`
        const cluster = clusters.find(c => (toSun ? c.key[0] * key[0] + c.key[1] * key[1] + c.key[2] * key[2] > CLUSTER_COS : c.key === key))
        if (cluster) cluster.members.push(entry)
        else clusters.push({ key, members: [entry] })
      }
      for (const cluster of clusters) {
        const lit = cluster.members.filter(entry => entry.prop.light)
        if (lit.length) {
          cluster.shading = meanShading(model, primIndex, lit)
        } else {
          // No VHV in the cluster: a soft sky term (up-facing surfaces brighter), mean about 1.
          cluster.shading = primIndex.map(pi => {
            const normals = model.primitives[pi].normals
            const shading = new Float32Array(normals.length)
            for (let v = 0; v < normals.length; v += 3) shading[v] = shading[v + 1] = shading[v + 2] = 0.75 + 0.35 * normals[v + 2]
            return shading
          })
        }
        if (lit.length > 1) for (const entry of lit) entry.error = relativeError(entry.prop, primIndex, cluster.shading)
      }
      groups.push({ model, skin, parts, primIndex, clusters })
    }
  }

  // 4b. When the exact bake of step 5 cannot hold every instance that its cluster's shared pattern
  //     misses by more than BAKE_ERROR, those clusters are split by lighting pattern first. Props in a
  //     row along one wall share a shadow, so a few patterns serve many of them (tetsudo's bamboo
  //     barriers and roof tiles). k-means style: the worst-fitting instance seeds a new pattern, every
  //     instance moves to the pattern that fits it best, the patterns are recomputed (twice), until all
  //     fit or PATTERN_SPLITS patterns exist. A pattern must serve two instances or more; a lone
  //     instance joins its best shared pattern and stays a bake candidate when that misses it.
  const vertexCost = group => group.parts.reduce((a, part) => a + (part.info.unlit ? 0 : part.prim.vertexCount * (part.info.doubleSided ? 2 : 1)), 0)
  const bakeBudgetTotal = Number.isFinite(o.bakeVertexBudget) ? o.bakeVertexBudget : BAKE_VERTEX_BUDGET
  const bakeDemand = () => groups.reduce((sum, group) => sum + vertexCost(group) * group.clusters.reduce((n, cluster) => n + cluster.members.filter(entry => entry.error > BAKE_ERROR).length, 0), 0)
  const splitByPattern = ({ model, primIndex, clusters }) => {
    const refined = []
    for (const cluster of clusters) {
      const lit = cluster.members.filter(entry => entry.prop.light)
      if (lit.length < 4 || !lit.some(entry => entry.error > BAKE_ERROR)) {
        refined.push(cluster)
        continue
      }
      let patterns = [cluster.shading]
      let assign = lit.map(() => 0)
      const errors = lit.map(entry => entry.error)
      const limit = Math.min(PATTERN_SPLITS, Math.floor(lit.length / 2))
      while (patterns.length < limit) {
        let worst = -1
        errors.forEach((error, i) => {
          if (error > BAKE_ERROR && (worst < 0 || error > errors[worst])) worst = i
        })
        if (worst < 0) break
        patterns.push(meanShading(model, primIndex, [lit[worst]]))
        for (let pass = 0; pass < 2; pass++) {
          lit.forEach((entry, i) => {
            errors[i] = Infinity
            patterns.forEach((pattern, k) => {
              const error = relativeError(entry.prop, primIndex, pattern)
              if (error < errors[i]) {
                errors[i] = error
                assign[i] = k
              }
            })
          })
          const kept = []
          const remap = new Map()
          patterns.forEach((_, k) => {
            const members = lit.filter((_, i) => assign[i] === k)
            if (members.length === 0) return
            remap.set(k, kept.length)
            kept.push(meanShading(model, primIndex, members))
          })
          assign = assign.map(k => remap.get(k))
          patterns = kept
        }
      }
      const sizes = patterns.map((_, k) => assign.filter(a => a === k).length)
      const shared = patterns.map((_, k) => k).filter(k => sizes[k] > 1)
      if (shared.length <= 1) {
        refined.push(cluster)
        continue
      }
      lit.forEach((entry, i) => {
        if (sizes[assign[i]] > 1) return
        let bestError = Infinity
        assign[i] = shared[0]
        for (const k of shared) {
          const error = relativeError(entry.prop, primIndex, patterns[k])
          if (error < bestError) {
            bestError = error
            assign[i] = k
          }
        }
      })
      const subs = shared.map(k => ({ key: cluster.key, members: lit.filter((_, i) => assign[i] === k) }))
      subs.sort((a, b) => b.members.length - a.members.length)
      subs[0].members.push(...cluster.members.filter(entry => !entry.prop.light)) // estimated light
      for (const sub of subs) {
        const members = sub.members.filter(entry => entry.prop.light)
        sub.shading = meanShading(model, primIndex, members)
        for (const entry of members) entry.error = relativeError(entry.prop, primIndex, sub.shading)
        refined.push(sub)
      }
      stats.patternSplits += subs.length - 1
    }
    return refined
  }
  const demandBefore = bakeDemand()
  if (demandBefore > bakeBudgetTotal) {
    for (const group of groups) group.clusters = splitByPattern(group)
  }
  stats.bakeDemand = { before: demandBefore, after: bakeDemand(), budget: bakeBudgetTotal }
  for (const group of groups) {
    stats.clusters += group.clusters.length
    for (const cluster of group.clusters) {
      for (const entry of cluster.members) if (entry.error !== undefined) stats.worstSharedError = Math.max(stats.worstSharedError, entry.error)
    }
  }

  // 5. Instances whose cluster shading misses their own VHV by more than BAKE_ERROR keep their exact
  //    lighting in one merged batch, the largest errors on the largest models first, while the vertex
  //    budget lasts.
  let bakeBudget = bakeBudgetTotal
  // Stock mode: a cluster of one or two lit instances would be its own node and draw call. A single
  // instance's vertices are stored once either way, and a pair costs one extra copy, so both join the
  // merged exact-VHV batch without using the bake budget (vigil: about 480 fewer draw calls, downfall:
  // about 160; files grow by 0.1 to 1.3 MB).
  let singletonsBaked = 0
  let pairsBaked = 0
  if (stockMode) {
    for (const group of groups) {
      if (vertexCost(group) === 0) continue
      for (const cluster of group.clusters) {
        if (cluster.members.length > 2 || !cluster.members.every(entry => entry.prop.light)) continue
        for (const entry of cluster.members) {
          entry.baked = true
          vhvStats.baked++
        }
        if (cluster.members.length === 1) singletonsBaked++
        else pairsBaked++
      }
    }
  }
  const candidates = []
  for (const group of groups) {
    const cost = vertexCost(group)
    for (const cluster of group.clusters) {
      for (const entry of cluster.members) {
        if (entry.error > BAKE_ERROR && cost > 0 && !entry.baked) candidates.push({ entry, cost, priority: entry.error * entry.radius })
      }
    }
  }
  candidates.sort((a, b) => b.priority - a.priority || a.entry.prop.order - b.entry.prop.order)
  for (const { entry, cost } of candidates) {
    if (cost > bakeBudget) {
      // Out of budget: drawn with its cluster's shared pattern, which misses its own VHV by more than
      // BAKE_ERROR. Tagged so conversion.json and the map.props probe report it.
      entry.lighting = 'shared'
      vhvStats.shared++
      vhvStats.worstDrawnError = Math.max(vhvStats.worstDrawnError, round(entry.error, 3))
      continue
    }
    bakeBudget -= cost
    entry.baked = true
    vhvStats.baked++
  }
  vhvStats.bakeVerticesLeft = bakeBudget

  // 6. Build the document.
  const doc = new Document()
  doc.setLogger(new Logger(Logger.Verbosity.WARN))
  const buffer = doc.createBuffer()
  const unlitExtension = doc.createExtension(KHRMaterialsUnlit)
  const instancing = doc.createExtension(EXTMeshGPUInstancing).setRequired(true)
  const scene = doc.createScene('props')
  const root = doc.createNode('static_props')
  scene.addChild(root)
  const accessor = (array, type) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer)
  const materialCache = new Map()
  const getMaterial = kind => {
    if (materialCache.has(kind)) return materialCache.get(kind)
    const material = doc.createMaterial(`dribble_${kind}`)
      .setBaseColorFactor([1, 1, 1, 1])
      .setMetallicFactor(0)
      .setRoughnessFactor(1)
      .setExtras({ dribble: { kind, lightmap: false } })
      .setExtension('KHR_materials_unlit', unlitExtension.createUnlit())
    if (kind !== 'opaque') material.setAlphaMode('BLEND')
    materialCache.set(kind, material)
    return material
  }
  const rendered = new Map() // instance id -> dynamic, for every instance placed in some node

  // Vertex data of one model part, in glTF axes: optional transform (baked instances), colours = albedo x
  // shading / k, see-through parts with alpha, $nocull parts with a reversed back copy.
  const partArrays = (part, shading, k, transform) => {
    const { prim, info } = part
    const translucent = info.kind !== 'opaque'
    const stride = translucent ? 4 : 3
    const n = prim.vertexCount
    const total = info.doubleSided ? n * 2 : n
    const positions = new Float32Array(total * 3)
    const normals = new Float32Array(total * 3)
    const colors = new Float32Array(total * stride)
    for (let v = 0; v < n; v++) {
      let p = [prim.positions[v * 3], prim.positions[v * 3 + 1], prim.positions[v * 3 + 2]]
      let nn = [prim.normals[v * 3], prim.normals[v * 3 + 1], prim.normals[v * 3 + 2]]
      if (transform) {
        const { R, origin, scale } = transform
        p = [0, 1, 2].map(r => (R[r][0] * p[0] + R[r][1] * p[1] + R[r][2] * p[2]) * scale + origin[r])
        nn = [0, 1, 2].map(r => R[r][0] * nn[0] + R[r][1] * nn[1] + R[r][2] * nn[2])
      }
      const g = toGltf(p)
      const gn = toGltf(nn)
      for (const [slot, sign] of info.doubleSided ? [[v, 1], [v + n, -1]] : [[v, 1]]) {
        positions.set(g, slot * 3)
        normals.set([gn[0] * sign, gn[1] * sign, gn[2] * sign], slot * 3)
        for (let c = 0; c < 3; c++) colors[slot * stride + c] = clamp01((info.albedo[c] * (info.unlit ? 1 : shading[v * 3 + c])) / k)
        if (translucent) colors[slot * stride + 3] = info.alpha
      }
    }
    // prim.indices are counter-clockwise already (loadStudioModel); the $nocull back copy reverses them.
    const indices = new Uint32Array(info.doubleSided ? prim.indices.length * 2 : prim.indices.length)
    indices.set(prim.indices)
    if (info.doubleSided) {
      for (let t = 0; t < prim.indices.length; t += 3) {
        indices[prim.indices.length + t] = prim.indices[t] + n
        indices[prim.indices.length + t + 1] = prim.indices[t + 2] + n
        indices[prim.indices.length + t + 2] = prim.indices[t + 1] + n
      }
    }
    return { positions, normals, colors, indices, translucent }
  }
  const maxColor = (parts, shadings) => {
    let k = 0
    parts.forEach((part, p) => {
      if (part.info.unlit) {
        k = Math.max(k, ...part.info.albedo)
        return
      }
      const s = shadings[p]
      for (let v = 0; v < s.length; v++) k = Math.max(k, part.info.albedo[v % 3] * s[v])
    })
    return Math.max(k, 1e-4)
  }
  const addPrimitive = (mesh, arrays, kind, instances) => {
    mesh.addPrimitive(
      doc.createPrimitive()
        .setAttribute('POSITION', accessor(arrays.positions, 'VEC3'))
        .setAttribute('NORMAL', accessor(arrays.normals, 'VEC3'))
        .setAttribute('COLOR_0', accessor(arrays.colors, arrays.translucent ? 'VEC4' : 'VEC3'))
        .setIndices(accessor(arrays.indices, 'SCALAR'))
        .setMaterial(getMaterial(kind))
    )
    stats.primitives++
    stats.vertices += arrays.positions.length / 3
    stats.triangles += arrays.indices.length / 3
    stats.renderedTriangles += (arrays.indices.length / 3) * instances
  }
  // One instanced node: TRANSLATION and ROTATION in glTF axes and `_COLOR_0` = instance light x k.
  const emitNode = (name, mesh, placed, k, extras) => {
    const translation = new Float32Array(placed.length * 3)
    const rotation = new Float32Array(placed.length * 4)
    const instanceColor = new Float32Array(placed.length * 3)
    placed.forEach((entry, i) => {
      if (entry.prop) {
        translation.set(toGltf(entry.prop.sourceOrigin), i * 3)
        rotation.set(quaternionOf(rotationToGltf(entry.R)), i * 4)
      } else {
        rotation.set([0, 0, 0, 1], i * 4) // merged batch: vertices are already in place
      }
      instanceColor.set(entry.light.map(v => v * k), i * 3)
    })
    const batch = instancing.createInstancedMesh()
      .setAttribute('TRANSLATION', accessor(translation, 'VEC3'))
      .setAttribute('ROTATION', accessor(rotation, 'VEC4'))
      .setAttribute('_COLOR_0', accessor(instanceColor, 'VEC3'))
    if (placed.some(entry => entry.prop && entry.prop.scale !== 1)) {
      // prop_dynamic modelscale (uniform); static props have none in sprp v10.
      batch.setAttribute('SCALE', accessor(Float32Array.from(placed.flatMap(entry => [entry.prop.scale, entry.prop.scale, entry.prop.scale])), 'VEC3'))
    }
    root.addChild(doc.createNode(name).setMesh(mesh).setExtension('EXT_mesh_gpu_instancing', batch).setExtras({ dribble: { kind: 'staticProps', ...extras } }))
    stats.nodes++
    if (placed.length > 1) stats.instancedNodes++
  }
  const describe = entries => ({
    instances: entries.length,
    staticProps: entries.map(entry => entry.prop.staticPropIndex), // -1 for a prop_dynamic entity
    ...(entries.some(entry => entry.prop.dynamic) ? { entities: entries.map(entry => (entry.prop.dynamic ? entry.prop.entityIndex : -1)) } : {}),
    origins: entries.map(entry => entry.prop.sourceOrigin.map(v => round(v, 1))), // Source units
    solid: entries.map(entry => entry.prop.solidity > 0),
    lighting: entries.map(entry => entry.lighting),
  })

  const bakedByKind = new Map() // kind -> { chunks: arrays[], entries: Set }
  const bakedEntries = []
  for (const { model, skin, parts, primIndex, clusters } of groups) {
    const baseName = `prop_${model.key.replace(/^models\//, '').replace(/\.mdl$/, '').replace(/[^a-z0-9]+/g, '_')}${skin ? `_skin${skin}` : ''}`
    const litParts = parts.filter(part => !part.info.unlit)
    const unlitParts = parts.filter(part => part.info.unlit)
    const lit = p => !parts[p].info.unlit
    clusters.forEach((cluster, c) => {
      const placed = cluster.members.filter(entry => !entry.baked)
      if (litParts.length && placed.length) {
        const shadings = cluster.shading.filter((_, p) => lit(p))
        const k = maxColor(litParts, shadings)
        const mesh = doc.createMesh(`${baseName}_${c}`)
        litParts.forEach((part, p) => addPrimitive(mesh, partArrays(part, shadings[p], k), part.info.kind, placed.length))
        emitNode(clusters.length > 1 ? `${baseName}_${c}` : baseName, mesh, placed, k, { model: model.modelPath, skin, ...describe(placed) })
      }
      for (const entry of cluster.members) {
        rendered.set(entry.prop.id, entry.prop.dynamic)
        if (!entry.baked || !litParts.length) continue
        // Exact VHV: shading = the instance's own light / its mean, vertices moved into place.
        bakedEntries.push(entry)
        parts.forEach((part, p) => {
          if (part.info.unlit) return
          const L = entry.prop.light[primIndex[p]]
          const shading = new Float32Array(L.length)
          for (let v = 0; v < L.length; v++) shading[v] = L[v] / Math.max(1e-4, entry.prop.mean[v % 3])
          if (!bakedByKind.has(part.info.kind)) bakedByKind.set(part.info.kind, [])
          bakedByKind.get(part.info.kind).push({ part, shading, entry })
        })
      }
    })
    if (unlitParts.length) {
      const all = clusters.flatMap(cluster => cluster.members).map(entry => ({ ...entry, light: [1, 1, 1], lighting: 'unlit' }))
      const ones = unlitParts.map(part => new Float32Array(part.prim.vertexCount * 3).fill(1))
      const k = maxColor(unlitParts, ones)
      const mesh = doc.createMesh(`${baseName}_unlit`)
      unlitParts.forEach((part, p) => addPrimitive(mesh, partArrays(part, ones[p], k), part.info.kind, all.length))
      emitNode(`${baseName}_unlit`, mesh, all, k, { model: model.modelPath, skin, ...describe(all) })
    }
  }
  if (bakedByKind.size) {
    // One merged mesh, one primitive per material kind, shown through a single identity instance whose
    // colour carries k (the vertex colours stay in [0, 1]) and every baked instance's light (mean 1 x
    // its own mean is folded into the vertex colour below).
    let k = 0
    for (const items of bakedByKind.values()) {
      for (const { part, shading, entry } of items) {
        for (let v = 0; v < shading.length; v++) k = Math.max(k, part.info.albedo[v % 3] * shading[v] * entry.light[v % 3])
      }
    }
    k = Math.max(k, 1e-4)
    const mesh = doc.createMesh('static_props_baked')
    for (const [kind, items] of [...bakedByKind].sort((a, b) => a[0].localeCompare(b[0]))) {
      const chunks = items.map(({ part, shading, entry }) => {
        const light = new Float32Array(shading.length)
        for (let v = 0; v < shading.length; v++) light[v] = shading[v] * entry.light[v % 3]
        return partArrays(part, light, k, { R: entry.R, origin: entry.prop.sourceOrigin, scale: entry.prop.scale })
      })
      const concat = (key, Ctor) => {
        const out = new Ctor(chunks.reduce((a, chunk) => a + chunk[key].length, 0))
        let offset = 0
        for (const chunk of chunks) {
          out.set(chunk[key], offset)
          offset += chunk[key].length
        }
        return out
      }
      const indices = new Uint32Array(chunks.reduce((a, chunk) => a + chunk.indices.length, 0))
      let io3 = 0, base = 0
      for (const chunk of chunks) {
        for (let i = 0; i < chunk.indices.length; i++) indices[io3++] = chunk.indices[i] + base
        base += chunk.positions.length / 3
      }
      addPrimitive(mesh, { positions: concat('positions', Float32Array), normals: concat('normals', Float32Array), colors: concat('colors', Float32Array), indices, translucent: chunks[0].translucent }, kind, 1)
    }
    emitNode('static_props_baked', mesh, [{ light: [1, 1, 1] }], k, {
      model: null,
      merged: true,
      ...describe(bakedEntries),
      models: bakedEntries.map(entry => entry.modelPath),
    })
    stats.bakedInstances = bakedEntries.length
  }
  counts.pak = [...rendered.values()].filter(dynamic => !dynamic).length
  counts.dynamic = [...rendered.values()].filter(Boolean).length

  root.setExtras({
    dribble: stockMode
      ? { kind: 'staticPropsRoot', schema: 1, source: 'stock', stock: counts.pak, dynamic: counts.dynamic, models: stats.models, lighting: { set: vhvStats.set, exposure, floor } }
      : {
          kind: 'staticPropsRoot',
          schema: 1,
          pak: counts.pak,
          dynamic: counts.dynamic,
          models: stats.models,
          lighting: { set: vhvStats.set, exposure, floor },
        },
  })

  fs.mkdirSync(path.dirname(o.outPath), { recursive: true })
  const any = counts.pak + counts.dynamic > 0
  if (any) {
    await doc.transform(prune({ keepAttributes: true, keepLeaves: true }))
    const quantizeOptions = { quantizationVolume: 'mesh', quantizePosition: 16, quantizeNormal: 8, quantizeColor: 12 }
    if (o.meshopt !== false) await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'high', ...quantizeOptions }))
    else await doc.transform(quantize(quantizeOptions))
    // Written in the work dir first and renamed into place, so a failure never leaves half a file.
    const staged = path.join(o.workDir, 'props.glb')
    await io.write(staged, doc)
    const partial = `${o.outPath}.partial`
    fs.copyFileSync(staged, partial)
    fs.renameSync(partial, o.outPath)
  } else if (fs.existsSync(o.outPath)) {
    fs.rmSync(o.outPath)
  }

  const neutralMaterials = [...materialStats.values()].filter(info => !info.skip && info.source !== 'pak').map(info => info.name)
  if (stockMode) {
    // counts.pak counted the rendered static instances, which are all stock here.
    return {
      props: { stock: counts.pak, ...(counts.dynamic ? { dynamic: counts.dynamic } : {}) },
      file: any ? path.basename(o.outPath) : null,
      stats: {
        ms: Math.round(performance.now() - started),
        bytes: any ? fs.statSync(o.outPath).size : 0,
        instances: counts.pak + counts.dynamic,
        staticInstances: counts.pak,
        dynamicInstances: counts.dynamic,
        pakInstances: counts.pakModel,
        missing: counts.missing,
        skybox: counts.skybox,
        skyboxStatic: counts.skyboxStatic,
        dynamicSkipped: counts.dynamicSkipped,
        unconvertible: counts.unconvertible,
        excludedModels,
        models: stats.models,
        clusters: stats.clusters,
        patternSplits: stats.patternSplits,
        bakeDemand: stats.bakeDemand,
        nodes: stats.nodes,
        instancedNodes: stats.instancedNodes,
        bakedInstances: stats.bakedInstances,
        singletonsBaked,
        pairsBaked,
        primitives: stats.primitives,
        vertices: stats.vertices,
        triangles: stats.triangles,
        renderedTriangles: stats.renderedTriangles,
        skippedPrimitives: stats.skippedPrimitives,
        winding: { agree: round(windingShare, 4), drawnTriangles: winding.drawnCounted, modelAgree: round(winding.counted ? winding.agree / winding.counted : 1, 4), modelTriangles: winding.counted, ...(windingLow.length ? { low: windingLow } : {}) },
        lighting: { ...vhvStats, exposure, floor, worstSharedError: round(stats.worstSharedError, 3) },
        materials: {
          ...stats.materials,
          neutralNames: neutralMaterials,
        },
        warnings,
      },
    }
  }
  return {
    props: { pak: counts.pak, stock: counts.stock, stockSolid: counts.stockSolid, ...(counts.dynamic ? { dynamic: counts.dynamic } : {}) },
    file: any ? path.basename(o.outPath) : null,
    stats: {
      ms: Math.round(performance.now() - started),
      bytes: any ? fs.statSync(o.outPath).size : 0,
      skybox: counts.skybox,
      dynamicSkipped: counts.dynamicSkipped,
      unconvertible: counts.unconvertible,
      models: stats.models,
      clusters: stats.clusters,
      patternSplits: stats.patternSplits,
      bakeDemand: stats.bakeDemand,
      nodes: stats.nodes,
      instancedNodes: stats.instancedNodes,
      bakedInstances: stats.bakedInstances,
      primitives: stats.primitives,
      vertices: stats.vertices,
      triangles: stats.triangles,
      renderedTriangles: stats.renderedTriangles,
      skippedPrimitives: stats.skippedPrimitives,
      winding: { agree: round(windingShare, 4), drawnTriangles: winding.drawnCounted, modelAgree: round(winding.counted ? winding.agree / winding.counted : 1, 4), modelTriangles: winding.counted, ...(windingLow.length ? { low: windingLow } : {}) },
      lighting: { ...vhvStats, exposure, floor, worstSharedError: round(stats.worstSharedError, 3) },
      materials: {
        ...stats.materials,
        neutralNames: neutralMaterials,
        table: [...materialStats.values()].map(info => ({ name: info.name, source: info.source, kind: info.kind, ...(info.skip ? { skip: info.skip } : {}), ...(info.coverage !== undefined ? { coverage: info.coverage, alpha: info.alpha } : {}), albedo: info.albedo.map(v => round(v, 3)) })),
      },
      warnings,
    },
  }
}
