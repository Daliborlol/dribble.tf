// The `shading` stage (as/shading): TF2's VertexLitGeneric character look for the pack models.
//
// After the models and viewmodels stages, it reads the materials of every pack model item from its MDL (names and
// $cdmaterials), resolves their VMTs from the VPKs and writes `shading/materials.json` (item `shading/materials`,
// kind `shading`): per base texture key the parameters the runtime shader uses (src/assetpack/characterShading.ts):
//
//   p  [phongexponent, phongboost, fresnel low, mid, high]   ($phong only)
//   m  phong mask: 0 none, 1 normal map alpha, 2 base map alpha;  inv 1 = $invertphongmask
//   at 1 = $phongalbedotint (exponent texture green);  t [r, g, b] = $phongtint
//   b  $bumpmap texture key;  e  $phongexponenttexture key, ef its factor ($phongexponentfactor, else 149)
//   ex 1 when $phongexponent is set explicitly (it then overrides the exponent texture)
//   w  $lightwarptexture key;  hl 1 = half-Lambert ($halflambert, or any $phong material)
//   r  [rimlightexponent, rimlightboost, rimmask]   ($rimlight only)
//
// The bump, exponent and light-warp textures become texture items (srgb false, at most 512 px, light warps at their
// size). Every number stays in the pack (D19). Without VPKs nothing runs; the stage owns only its own items.

import { resolveMaterial, vmtBaseTexture, vmtTruthy } from '../lib/vmt.mjs'
import { parseVtfHeader } from '../lib/vtf.mjs'
import { sha256 } from '../lib/vpk.mjs'
import { mdlMaterials } from '../models/mdl.mjs'
import { exportVtf } from '../models/texture-export.mjs'
import { textureKeyOf } from '../models/stage.mjs'

const SHADING_VERSION = 1
const TEXTURE_EXPORT_VERSION = 1
const round = v => Math.round(v * 1e4) / 1e4

const num = (v, fallback) => {
  const n = Number(String(v ?? '').trim())
  return v !== undefined && Number.isFinite(n) ? n : fallback
}

/** "[a b c]" (0..1) or "{r g b}" (0..255) to three numbers, else the fallback. */
function vec3(v, fallback) {
  if (typeof v !== 'string') return fallback
  const s = v.trim()
  const parts = s.replace(/^[[{]|[\]}]$/g, '').trim().split(/\s+/).map(Number)
  if (parts.length < 3 || !parts.slice(0, 3).every(Number.isFinite)) {
    const one = Number(s)
    return Number.isFinite(one) ? [one, one, one] : fallback
  }
  const scale = s.startsWith('{') ? 1 / 255 : 1
  return parts.slice(0, 3).map(x => round(x * scale))
}

const keyOf = (params, name) => {
  const vtf = vmtBaseTexture(params, name)
  return vtf ? textureKeyOf(vtf) : null
}

/** The shading entry of one resolved VMT, or null when it is not a lit VertexLitGeneric material. */
export function shadingEntry(vmt) {
  if (!vmt || String(vmt.shader).toLowerCase() !== 'vertexlitgeneric') return null
  const p = vmt.params
  const entry = {}
  const phong = vmtTruthy(p.$phong)
  const bump = keyOf(p, '$bumpmap')
  const warp = keyOf(p, '$lightwarptexture')
  if (bump) entry.b = bump
  if (warp) entry.w = warp
  if (phong || vmtTruthy(p.$halflambert)) entry.hl = 1
  if (phong) {
    entry.p = [round(num(p.$phongexponent, 5)), round(num(p.$phongboost, 1)), ...vec3(p.$phongfresnelranges, [0, 0.5, 1])]
    if (p.$phongexponent !== undefined) entry.ex = 1
    const exp = keyOf(p, '$phongexponenttexture')
    if (exp) {
      entry.e = exp
      entry.ef = round(num(p.$phongexponentfactor, 149))
      if (vmtTruthy(p.$phongalbedotint)) entry.at = 1
    }
    entry.m = vmtTruthy(p.$basemapalphaphongmask) ? 2 : bump ? 1 : 0
    if (vmtTruthy(p.$invertphongmask)) entry.inv = 1
    const tint = vec3(p.$phongtint, null)
    if (tint && tint.some(x => x !== 1)) entry.t = tint
    if (vmtTruthy(p.$rimlight)) entry.r = [round(num(p.$rimlightexponent, 4)), round(num(p.$rimlightboost, 1)), vmtTruthy(p.$rimmask) && exp ? 1 : 0]
  }
  return Object.keys(entry).length ? entry : null
}

export async function run(ctx) {
  const t0 = performance.now()
  const maxSize = Number(ctx.options.set.shadingTextureMaxSize ?? 512)
  const models = Object.entries(ctx.manifest.items)
    .filter(([key, it]) => it.kind === 'model' && key.endsWith('.mdl') && !String(it.source ?? '').startsWith('pak:'))
    .map(([key]) => key)
    .sort()
  const materials = {}
  const textureKeys = new Map() // key -> 'bump' | 'exp' | 'warp'
  const stats = { models: 0, unreadable: [], vmts: 0, entries: 0, textures: { built: 0, skipped: 0, reused: 0, unsupported: [] } }
  const seenVmt = new Set()
  for (const key of models) {
    const buf = ctx.vpk.read(key)
    if (!buf) { stats.unreadable.push(key); continue }
    let mats
    try { mats = mdlMaterials(buf) } catch { stats.unreadable.push(key); continue }
    stats.models++
    for (const name of mats.names) {
      const vmt = resolveMaterial(ctx.vpk, name, mats.dirs)
      if (!vmt || seenVmt.has(vmt.file)) continue
      seenVmt.add(vmt.file)
      stats.vmts++
      const base = keyOf(vmt.params, '$basetexture')
      if (!base || materials[base]) continue
      const entry = shadingEntry(vmt)
      if (!entry) continue
      materials[base] = entry
      if (entry.b) textureKeys.set(entry.b, 'bump')
      if (entry.e) textureKeys.set(entry.e, 'exp')
      if (entry.w) textureKeys.set(entry.w, 'warp')
    }
  }
  // Textures: linear data (normals, exponents, warp ramps). A key another stage owns is reused as it is.
  const owned = new Set()
  for (const [tkey, use] of [...textureKeys.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const existing = ctx.manifest.items[tkey]
    if (existing && existing.stage && existing.stage !== ctx.stage) { stats.textures.reused++; continue }
    owned.add(tkey)
    const vtf = ctx.vpk.read(`materials/${tkey}.vtf`)
    if (!vtf) { stats.textures.unsupported.push({ key: tkey, reason: 'missing' }); ctx.removeItem(tkey); owned.delete(tkey); continue }
    const size = use === 'warp' ? 4096 : maxSize
    const inputKey = ctx.inputKey({ shadingTexture: tkey, vtf: sha256(vtf), maxSize: size, textureExport: TEXTURE_EXPORT_VERSION })
    const prev = ctx.previous?.items?.[tkey]
    if (!ctx.options.force && prev?.inputKey === inputKey && existing && ctx.hasPackFile(existing.file)) { stats.textures.skipped++; continue }
    let out
    try { out = await exportVtf(vtf, { maxSize: size }) } catch (error) {
      stats.textures.unsupported.push({ key: tkey, reason: error.message }); ctx.removeItem(tkey); owned.delete(tkey); continue
    }
    if (!out.info) {
      let format = '?'
      try { format = parseVtfHeader(vtf).formatName } catch {}
      stats.textures.unsupported.push({ key: tkey, reason: format }); ctx.removeItem(tkey); owned.delete(tkey); continue
    }
    const ddsPath = out.dds ? ctx.writeFile(`textures/${tkey}.dds`, out.dds) : null
    const webpPath = out.webp ? ctx.writeFile(`textures/${tkey}.webp`, out.webp) : null
    ctx.addItem(tkey, {
      kind: 'texture',
      file: ddsPath ?? webpPath,
      webp: webpPath,
      srgb: false,
      oneBitAlpha: out.info.oneBitAlpha,
      alpha: 'opaque',
      alphaCutoff: null,
      width: out.info.width,
      height: out.info.height,
      mips: out.info.mips,
      role: `shading:${use}`,
      inputKey,
    })
    stats.textures.built++
  }
  // Entries whose texture failed lose that texture (the shader then runs without it).
  const available = k => !!ctx.manifest.items[k]
  for (const entry of Object.values(materials)) {
    if (entry.b && !available(entry.b)) { delete entry.b; if (entry.m === 1) entry.m = 0 }
    if (entry.e && !available(entry.e)) { delete entry.e; delete entry.ef; delete entry.at; if (entry.r) entry.r[2] = 0 }
    if (entry.w && !available(entry.w)) delete entry.w
  }
  const sorted = Object.fromEntries(Object.entries(materials).sort(([a], [b]) => (a < b ? -1 : 1)))
  stats.entries = Object.keys(sorted).length
  const file = ctx.writeFile('shading/materials.json', Buffer.from(JSON.stringify({ version: SHADING_VERSION, materials: sorted })))
  ctx.addItem('shading/materials', { kind: 'shading', file, materials: stats.entries, inputKey: ctx.inputKey({ shading: SHADING_VERSION, materials: sorted }) })
  for (const [k, item] of Object.entries(ctx.manifest.items)) if (item.stage === ctx.stage && k !== 'shading/materials' && !owned.has(k)) ctx.removeItem(k)
  ctx.setOptions({ shadingTextureMaxSize: maxSize })
  ctx.log(`${stats.models} models, ${stats.vmts} VMTs, ${stats.entries} shaded materials; textures ${stats.textures.built} built, ${stats.textures.skipped} unchanged, ${stats.textures.reused} reused, ${stats.textures.unsupported.length} unsupported`)
  for (const u of stats.textures.unsupported) ctx.log(`texture ${u.key}: ${u.reason}`)
  return { ms: Math.round(performance.now() - t0), ...stats }
}
