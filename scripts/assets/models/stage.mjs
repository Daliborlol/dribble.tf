// The `models` stage (asset contract 12.4 and 12.5, W-pack): the world models of MODEL_LIST through
// `bsp-to-glb --studio-*` and lib/model-export.mjs's post stage (LOD0, unused clips pruned, no images,
// meshopt), plus their base textures as DDS or WebP sidecars (texture-export.mjs).
//
// Every GLB material gets `extras.dribble.texture = { key, uv: 0, skins? }` and its flat albedo (the VTF
// reflectivity) as base colour, so it draws before or without its texture. Manifest model items carry
// attachments, sequences, pose-parameter ranges, skins and bodygroups read from the model; those numbers are
// pack data and never enter git (D19).
//
// Options (--set): modelsOnly=["models/...mdl", ...] limits the list (tests), textureMaxSize=<px> (1024).

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { exportStudioModel, postProcessModel, findBspToGlb, bspToGlbVersion } from '../lib/model-export.mjs'
import { resolveMaterial, vmtBaseTexture, vmtAlpha } from '../lib/vmt.mjs'
import { vtfReflectivity, parseVtfHeader, VTF_FLAGS } from '../lib/vtf.mjs'
import { sha256 } from '../lib/vpk.mjs'
import { MODEL_LIST } from './list.mjs'
import { mdlPoseParams } from './mdl.mjs'
import { exportVtf } from './texture-export.mjs'

const TEXTURE_EXPORT_VERSION = 1
const MODEL_EXPORT_VERSION = 3 // 2: rest pose from the default sequence; 3: triangle winding reversed
const round = v => Math.round(v * 1e5) / 1e5

/** A `read(path)` source over a folder of extracted PAK files. */
function folderReader(dir) {
  return {
    read: p => {
      const file = path.join(dir, p.toLowerCase())
      return fs.existsSync(file) ? fs.readFileSync(file) : null
    },
  }
}

function extractPak(ctx, bspToGlb, folder) {
  const info = ctx.publicMapInfo(folder)
  const bsp = path.join(ctx.options.bspDir, `${info.mapName}.bsp`)
  if (!fs.existsSync(bsp)) throw new Error(`${folder}: ${bsp} not found (pass --bsp-dir)`)
  const dir = path.join(ctx.tmp, `pak-${folder}`)
  fs.rmSync(dir, { recursive: true, force: true })
  const r = spawnSync(bspToGlb, ['--bsp', bsp, '--pak-output', dir, '--pak-manifest', path.join(ctx.tmp, `pak-${folder}.json`)], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'ignore', 'pipe'] })
  if (r.status !== 0) throw new Error(`${folder}: PAK extraction failed: ${(r.stderr || '').trim().split('\n')[0]}`)
  return folderReader(dir)
}

export const readFirst = (sources, p) => {
  for (const s of sources) {
    const d = s.read(p)
    if (d) return d
  }
  return null
}

/** Rotation matrix (row major 3x3) to quaternion [x, y, z, w]. */
export function quatOf(m) {
  const [a, b, c, d, e, f, g, h, i] = m
  const tr = a + e + i
  let x, y, z, w
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2
    w = 0.25 * s; x = (h - f) / s; y = (c - g) / s; z = (d - b) / s
  } else if (a > e && a > i) {
    const s = Math.sqrt(1 + a - e - i) * 2
    w = (h - f) / s; x = 0.25 * s; y = (b + d) / s; z = (c + g) / s
  } else if (e > i) {
    const s = Math.sqrt(1 + e - a - i) * 2
    w = (c - g) / s; x = (b + d) / s; y = 0.25 * s; z = (f + h) / s
  } else {
    const s = Math.sqrt(1 + i - a - e) * 2
    w = (d - b) / s; x = (c + g) / s; y = (f + h) / s; z = 0.25 * s
  }
  return [x, y, z, w].map(round)
}

export const textureKeyOf = vtfPath => vtfPath.replace(/^materials\//, '').replace(/\.vtf$/, '')

/** Material facts of one studio model: per studio material { key, alpha, cutoff, albedo }. */
export function studioMaterials(sources, manifest) {
  return (manifest.materials ?? []).map(m => {
    const vmt = resolveMaterial(sources, m.name, m.searchPaths ?? [])
    const vtf = vmt ? vmtBaseTexture(vmt.params) : null
    const { alpha, cutoff } = vmt ? vmtAlpha(vmt.params) : { alpha: 'opaque', cutoff: null }
    const vtfData = vtf ? readFirst(sources, vtf) : null
    return { name: m.name, key: vtf ? textureKeyOf(vtf) : null, alpha, cutoff, albedo: vtfData ? vtfReflectivity(vtfData) : null, vtfData }
  })
}

export async function run(ctx) {
  const set = ctx.options.set
  const only = Array.isArray(set.modelsOnly) ? new Set(set.modelsOnly.map(s => s.toLowerCase())) : null
  const list = MODEL_LIST.filter(e => !only || only.has(e.model))
  const maxSize = Number(set.textureMaxSize ?? 1024)
  const bspToGlb = findBspToGlb(ctx.options.bspToGlb)
  const tool = bspToGlbVersion(bspToGlb)
  ctx.setOptions({ models: list.map(e => e.model).sort(), textureMaxSize: maxSize })
  const paks = new Map()
  const wanted = new Set()
  const stats = { built: 0, skipped: 0, failed: [], textures: { built: 0, skipped: 0, reused: 0, unsupported: [] } }

  for (const entry of list) {
    const key = entry.model.toLowerCase()
    wanted.add(key)
    let sources = [ctx.vpk]
    let source = 'vpk'
    if (entry.pak) {
      try {
        if (!paks.has(entry.pak)) paks.set(entry.pak, extractPak(ctx, bspToGlb, entry.pak))
      } catch (error) {
        stats.failed.push({ model: key, error: error.message })
        ctx.removeItem(key)
        continue
      }
      sources = [paks.get(entry.pak), ctx.vpk]
      source = `pak:${entry.pak}`
    }
    const base = key.slice(0, -4)
    const mdl = readFirst(sources, key)
    if (!mdl) { stats.failed.push({ model: key, error: 'not found' }); ctx.removeItem(key); continue }
    const parts = ['.vvd', '.dx90.vtx', '.ani'].map(ext => { const d = readFirst(sources, base + ext); return d ? sha256(d) : null })
    const inputKey = ctx.inputKey({ model: key, entry, mdl: sha256(mdl), parts, tool, maxSize, textureExport: TEXTURE_EXPORT_VERSION, modelExport: MODEL_EXPORT_VERSION })
    const file = `${base}.glb`
    const prev = ctx.previous?.items?.[key]
    let materials
    if (!ctx.options.force && prev?.inputKey === inputKey && ctx.manifest.items[key] && ctx.hasPackFile(file)) {
      stats.skipped++
      materials = null
    } else {
      const work = path.join(ctx.tmp, key.replace(/[^a-z0-9]+/g, '_'))
      fs.mkdirSync(work, { recursive: true })
      try {
        const exported = exportStudioModel({ bspToGlb, source: sources, modelPath: key, workDir: work })
        const studio = exported.manifest
        materials = studioMaterials(sources, studio)
        const families = (studio.skinFamilies ?? []).map(f => f.textureIndices)
        const byName = new Map(materials.map((m, i) => [m.name, i]))
        const keyOfIndex = i => materials[i]?.key ?? null
        const anims = studio.animations ?? []
        const clipNames = new Set()
        const sequences = []
        for (const seq of studio.sequences ?? []) {
          const anim = anims[seq.animationIndices?.[0]]
          const keep = entry.clips === 'sequences' && seq.name !== 'ref' && anim
          if (keep) for (const ai of seq.animationIndices ?? []) if (anims[ai]) clipNames.add(anims[ai].name)
          sequences.push({ name: seq.name, frames: anim?.frameCount ?? 0, fps: anim?.fps ?? 30, clip: keep ? anim.name : null })
        }
        const firstSeq = (studio.sequences ?? [])[0]
        const restPoseClip = anims[firstSeq?.animationIndices?.[0]]?.name ?? null
        const result = await postProcessModel({
          restPoseClip,
          input: exported.glbPath,
          output: ctx.stagePath(file),
          keepClip: name => clipNames.has(name),
          studioManifest: studio,
          transform: doc => {
            for (const material of doc.getRoot().listMaterials()) {
              const t = byName.get(material.getName())
              if (t === undefined) continue
              const m = materials[t]
              if (m.albedo) material.setBaseColorFactor([...m.albedo.map(round), 1])
              if (!m.key) continue
              const slot = families[0] ? families[0].indexOf(t) : -1
              const skins = slot >= 0 ? families.map(f => keyOfIndex(f[slot]) ?? m.key) : []
              const texture = { key: m.key, uv: 0, ...(skins.some(k => k !== m.key) ? { skins } : {}) }
              material.setExtras({ ...(material.getExtras() ?? {}), dribble: { texture } })
            }
          },
        })
        const bones = studio.bones ?? []
        const attachments = {}
        for (const a of studio.attachments ?? []) {
          const l = a.local
          attachments[a.name] = {
            bone: bones[a.bone]?.name ?? null,
            pos: [l[3], l[7], l[11]].map(round),
            quat: quatOf([l[0], l[1], l[2], l[4], l[5], l[6], l[8], l[9], l[10]]),
          }
        }
        const textures = new Set()
        for (const f of families.length ? families : [materials.map((_, i) => i)]) for (const i of f) if (keyOfIndex(i)) textures.add(keyOfIndex(i))
        const item = {
          kind: 'model',
          file,
          bytes: result.bytes,
          sha256: result.sha256,
          source,
          role: entry.role,
          textures: [...textures].sort(),
          skins: Math.max(1, families.length),
          attachments,
          sequences,
          poseParams: Object.fromEntries(Object.entries(mdlPoseParams(mdl)).map(([n, p]) => [n, { min: p.min, max: p.max }])),
          bodygroups: (studio.bodyParts ?? []).map(b => ({ name: b.name, models: b.models?.length ?? 0 })),
          bounds: [studio.bounds?.hullMin ?? [0, 0, 0], studio.bounds?.hullMax ?? [0, 0, 0]].map(v => v.map(round)),
          triangles: result.stats.after.triangles,
          inputKey,
        }
        if (entry.variants) item.variants = entry.variants
        ctx.addItem(key, item)
        stats.built++
      } catch (error) {
        stats.failed.push({ model: key, error: error.message.split('\n')[0] })
        ctx.removeItem(key)
        continue
      } finally {
        fs.rmSync(work, { recursive: true, force: true })
      }
    }

    // Texture items: every key the model lists (skins included).
    const keys = ctx.manifest.items[key]?.textures ?? []
    if (!keys.length) continue
    for (const tkey of keys) {
      if (wanted.has(tkey)) continue
      wanted.add(tkey)
      const existing = ctx.manifest.items[tkey]
      if (existing && existing.stage && existing.stage !== ctx.stage) { stats.textures.reused++; continue }
      const vtfPath = `materials/${tkey}.vtf`
      const vtf = readFirst(sources, vtfPath)
      if (!vtf) { stats.textures.unsupported.push({ key: tkey, reason: 'missing' }); ctx.removeItem(tkey); continue }
      const tInputKey = ctx.inputKey({ texture: tkey, vtf: sha256(vtf), maxSize, textureExport: TEXTURE_EXPORT_VERSION })
      const prevT = ctx.previous?.items?.[tkey]
      if (!ctx.options.force && prevT?.inputKey === tInputKey && existing && ctx.hasPackFile(existing.file)) { stats.textures.skipped++; continue }
      let out
      try {
        out = await exportVtf(vtf, { maxSize })
      } catch (error) {
        stats.textures.unsupported.push({ key: tkey, reason: error.message })
        ctx.removeItem(tkey)
        continue
      }
      if (!out.info) {
        let format = '?'
        try { format = parseVtfHeader(vtf).formatName } catch {}
        stats.textures.unsupported.push({ key: tkey, reason: format })
        ctx.removeItem(tkey)
        continue
      }
      const header = parseVtfHeader(vtf)
      const usedBy = (materials ?? []).find(m => m.key === tkey)
      const ddsPath = out.dds ? ctx.writeFile(`textures/${tkey}.dds`, out.dds) : null
      const webpPath = out.webp ? ctx.writeFile(`textures/${tkey}.webp`, out.webp) : null
      // manifest.mjs requires `file`: a WebP-only texture lists its WebP there too (contract 12.3 has null).
      ctx.addItem(tkey, {
        kind: 'texture',
        file: ddsPath ?? webpPath,
        webp: webpPath,
        srgb: (header.flags & VTF_FLAGS.NORMAL) === 0,
        oneBitAlpha: out.info.oneBitAlpha,
        alpha: usedBy?.alpha ?? 'opaque',
        alphaCutoff: usedBy?.cutoff ?? null,
        width: out.info.width,
        height: out.info.height,
        mips: out.info.mips,
        ...(out.info.frames > 1 ? { frames: out.info.frames } : {}),
        inputKey: tInputKey,
      })
      stats.textures.built++
    }
  }
  for (const [k, item] of Object.entries(ctx.manifest.items)) if (item.stage === ctx.stage && !wanted.has(k)) ctx.removeItem(k)
  ctx.log(`${stats.built} models built, ${stats.skipped} unchanged, ${stats.failed.length} failed; textures ${stats.textures.built} built, ${stats.textures.skipped} unchanged, ${stats.textures.reused} reused, ${stats.textures.unsupported.length} unsupported`)
  for (const f of stats.failed) ctx.log(`failed ${f.model}: ${f.error}`)
  for (const u of stats.textures.unsupported) ctx.log(`texture ${u.key}: ${u.reason}; flat albedo`)
  return stats
}
