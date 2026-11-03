// The `viewmodels` stage (asset contract 13): per class the c_arms model with the sequences of the models it
// includes, and the c_model weapons that TF2 bone-merges onto those arms, plus their base textures as DDS or
// WebP sidecars through the models stage's path (contract 2.5, 12.3).
//
// Arms: `bsp-to-glb --studio-*` exports the arms and, separately, every model they include. The sequences are
// merged in Source's virtual-model order (contract 13.2), so `sequences[i]` is networked sequence index i
// (`vm0.seq`). Clips of the kept sequences are copied from the include GLBs onto the arms' bones by name.
// Weapons: LOD 0, no clips, rest pose from their first sequence; `viewmodel.mergeBones` lists, per class, the
// weapon bones that follow the arms bone of the same name.
//
// Every number written here comes from the user's own files and stays in the pack (D19).
//
// Options (--set): itemsGame=<items_game.txt> (default <tf dir>/scripts/items/items_game.txt; without a schema
// only the arms are built), viewmodelClasses=["scout", ...] (tests), textureMaxSize=<px> (arms, 1024, the 6.2
// cap) and weaponTextureMaxSize=<px> (512, so a class with all its weapons stays near the 10 MB of 6.2).
// Weapon textures are exported for the team skins 0 and 1 only; other skins (australium, festive) draw their
// flat albedo.

import fs from 'node:fs'
import path from 'node:path'
import { exportStudioModel, postProcessModel, findBspToGlb, bspToGlbVersion, createModelIo } from '../lib/model-export.mjs'
import { parseVtfHeader, VTF_FLAGS } from '../lib/vtf.mjs'
import { sha256 } from '../lib/vpk.mjs'
import { loadSchema } from '../lib/schema.mjs'
import { readFirst, quatOf, studioMaterials } from '../models/stage.mjs'
import { mdlPoseParams } from '../models/mdl.mjs'
import { exportVtf } from '../models/texture-export.mjs'
import { ARMS, STANDALONE, WEAPON_DEFS } from './list.mjs'

const TEXTURE_EXPORT_VERSION = 1
const VIEWMODEL_EXPORT_VERSION = 2 // 2: triangle winding reversed
const STUDIO_LOOPING = 0x1
const STUDIO_DELTA = 0x4
const STUDIO_OVERRIDE = 0x800 // $declaresequence: a forward declaration an include replaces
// Sequences the viewmodel never plays: inspects, PASS Time, taunts and the hand-pose layer.
const SKIP_SEQUENCE = /inspect|^passtime_|taunt|^r_handposes$/i
const round = v => Math.round(v * 1e5) / 1e5
const lower = s => String(s).toLowerCase()

function attachmentsOf(studio) {
  const bones = studio.bones ?? []
  const out = {}
  for (const a of studio.attachments ?? []) {
    const l = a.local
    out[a.name] = { bone: bones[a.bone]?.name ?? null, pos: [l[3], l[7], l[11]].map(round), quat: quatOf([l[0], l[1], l[2], l[4], l[5], l[6], l[8], l[9], l[10]]) }
  }
  return out
}

/** Texture keys of the first `skins` skin families (all by default); `materials` from studioMaterials. */
function textureKeys(studio, materials, skins = Infinity) {
  const families = (studio.skinFamilies ?? []).slice(0, skins).map(f => f.textureIndices)
  const keys = new Set()
  for (const f of families.length ? families : [materials.map((_, i) => i)]) for (const i of f) if (materials[i]?.key) keys.add(materials[i].key)
  return [...keys].sort()
}

/** The models stage's material hook: flat albedo plus `extras.dribble.texture` (contract 12.3). */
function materialHook(studio, materials) {
  const families = (studio.skinFamilies ?? []).map(f => f.textureIndices)
  const byName = new Map(materials.map((m, i) => [m.name, i]))
  return doc => {
    for (const material of doc.getRoot().listMaterials()) {
      const t = byName.get(material.getName())
      if (t === undefined) continue
      const m = materials[t]
      if (m.albedo) material.setBaseColorFactor([...m.albedo.map(round), 1])
      if (!m.key) continue
      const slot = families[0] ? families[0].indexOf(t) : -1
      const skins = slot >= 0 ? families.map(f => materials[f[slot]]?.key ?? m.key) : []
      const texture = { key: m.key, uv: 0, ...(skins.some(k => k !== m.key) ? { skins } : {}) }
      material.setExtras({ ...(material.getExtras() ?? {}), dribble: { texture } })
    }
  }
}

/**
 * Source's virtual model (studio.cpp `virtualmodel_t::AppendModels` and `AppendSequences`): the model's own
 * sequences, then each include depth first; a name already present (case-insensitive) is skipped unless the
 * present one is a $declaresequence (STUDIO_OVERRIDE), which the include replaces in place.
 * `groups[g]` = { key, studio }; returns [{ name, group, seq }] in networked index order.
 */
export function mergeSequences(groups) {
  const out = []
  const at = new Map()
  for (let g = 0; g < groups.length; g++) {
    for (const seq of groups[g].studio.sequences ?? []) {
      const k = lower(seq.name)
      const i = at.get(k)
      if (i === undefined) { at.set(k, out.length); out.push({ name: seq.name, group: g, seq }) }
      else if (out[i].seq.flags & STUDIO_OVERRIDE) out[i] = { name: out[i].name, group: g, seq }
    }
  }
  return out
}

/** Exports `key` and its includes depth first: [{ key, studio, glbPath }], the model itself first. */
function exportWithIncludes(ctx, bspToGlb, key, work, seen = new Set()) {
  if (seen.has(key)) return []
  seen.add(key)
  const dir = path.join(work, String(seen.size))
  fs.mkdirSync(dir, { recursive: true })
  const exported = exportStudioModel({ bspToGlb, source: ctx.vpk, modelPath: key, workDir: dir })
  const list = [{ key, studio: exported.manifest, glbPath: exported.glbPath }]
  for (const inc of exported.manifest.includeModels ?? []) {
    const incKey = lower(inc)
    if (!ctx.vpk.has(incKey)) throw new Error(`${key}: include ${incKey} not in the VPKs`)
    list.push(...exportWithIncludes(ctx, bspToGlb, incKey, work, seen))
  }
  return list
}

/** Copies one animation of `srcDoc` into `doc`, channels retargeted to `doc`'s nodes by name. */
function copyAnimation(doc, src, name, nodeByName) {
  const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer()
  const accessors = new Map()
  const copy = a => {
    if (!accessors.has(a)) accessors.set(a, doc.createAccessor().setType(a.getType()).setArray(a.getArray().slice()).setNormalized(a.getNormalized()).setBuffer(buffer))
    return accessors.get(a)
  }
  const anim = doc.createAnimation(name)
  let channels = 0
  for (const ch of src.listChannels()) {
    const node = nodeByName.get(lower(ch.getTargetNode()?.getName() ?? ''))
    const s = ch.getSampler()
    if (!node || !s || ch.getTargetPath() === 'weights') continue
    const sampler = doc.createAnimationSampler().setInput(copy(s.getInput())).setOutput(copy(s.getOutput())).setInterpolation(s.getInterpolation())
    anim.addSampler(sampler)
    anim.addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath(ch.getTargetPath()).setSampler(sampler))
    channels++
  }
  return channels
}

export async function run(ctx) {
  const set = ctx.options.set
  const classes = Array.isArray(set.viewmodelClasses) ? Object.keys(ARMS).filter(c => set.viewmodelClasses.includes(c)) : Object.keys(ARMS)
  const maxSize = Number(set.textureMaxSize ?? 1024)
  const weaponMaxSize = Number(set.weaponTextureMaxSize ?? 512)
  const tfDir = path.dirname(ctx.vpk.vpks?.[1]?.file ?? '.')
  const schemaFile = set.itemsGame ? path.resolve(String(set.itemsGame)) : path.join(tfDir, 'scripts', 'items', 'items_game.txt')
  const schema = loadSchema(schemaFile)
  if (!schema) ctx.log(`no item schema at ${schemaFile} (pass --set itemsGame=<items_game.txt>); building the arms only`)
  const bspToGlb = findBspToGlb(ctx.options.bspToGlb)
  const tool = bspToGlbVersion(bspToGlb)
  ctx.setOptions({ classes, textureMaxSize: maxSize, weaponTextureMaxSize: weaponMaxSize, weaponDefs: schema ? WEAPON_DEFS : [] })
  const io = await createModelIo()
  const wanted = new Set()
  const stats = { arms: {}, watches: {}, standalone: {}, weapons: { built: 0, skipped: 0, reused: 0, failed: [] }, defs: { resolved: 0, skipped: [] }, textures: { built: 0, skipped: 0, reused: 0, unsupported: [] }, perClass: {} }
  const armsBones = {}
  const texturesOf = new Map() // model key -> texture keys (for the size report)

  // ---- weapons: def -> model per class -----------------------------------------------------------------
  const weaponModels = new Map() // model key -> { defs: Set, classes: Set }
  const weaponsOfClass = Object.fromEntries(classes.map(c => [c, {}]))
  if (schema) {
    for (const d of WEAPON_DEFS) {
      for (const cls of classes) {
        const r = schema.resolve(d, cls)
        if (!r) continue
        if (r.skip) { stats.defs.skipped.push({ def: d, class: cls, reason: r.skip, ...(r.model ? { model: r.model } : {}) }); continue }
        if (!ctx.vpk.has(r.model)) { stats.defs.skipped.push({ def: d, class: cls, reason: 'model not in the VPKs', model: r.model }); continue }
        weaponsOfClass[cls][d] = r.model
        const w = weaponModels.get(r.model) ?? { defs: new Set(), classes: new Set() }
        w.defs.add(d); w.classes.add(cls)
        weaponModels.set(r.model, w)
        stats.defs.resolved++
      }
    }
  }

  // ---- arms, and the spy's watch viewmodels (viewmodel 1: legacy v_models with their own hands) ------------
  const armsJobs = classes.map(cls => ({ cls, key: ARMS[cls], role: 'viewmodel:arms' }))
  if (schema && classes.includes('spy')) {
    for (const key of schema.watchModels()) if (ctx.vpk.has(key)) armsJobs.push({ cls: 'spy', key, role: 'viewmodel:watch' })
  }
  // Standalone viewmodels (the Gunslinger arms, the disguise kit): need the schema for their defs
  if (schema) {
    for (const s of STANDALONE) {
      if (!classes.includes(s.cls)) continue
      const defs = schema.defsOfClass(s.itemClass, s.cls)
      if (!ctx.vpk.has(s.key)) { stats.standalone[s.key] = { error: 'not in the VPKs' }; continue }
      if (defs.length) armsJobs.push({ cls: s.cls, key: s.key, role: 'viewmodel:standalone', defs, ownSequences: s.ownSequences, armsOverride: s.armsOverride === true })
    }
  }
  for (const { cls, key, role, defs: standaloneDefs, ownSequences, armsOverride } of armsJobs) {
    const watch = role === 'viewmodel:watch'
    const standalone = role === 'viewmodel:standalone'
    // an item that is not a class's c_arms (watches, standalone viewmodels) lists no weapons, except an arms override
    const extra = watch || standalone
    const listsWeapons = !extra || armsOverride === true
    const own = watch || ownSequences === true
    const record = watch ? stats.watches : standalone ? stats.standalone : stats.arms
    const slot = extra ? key : cls
    wanted.add(key)
    const file = `${key.slice(0, -4)}.glb`
    const work = path.join(ctx.tmp, extra ? `${standalone ? 'standalone' : 'watch'}-${key.replace(/[^a-z0-9]+/g, '_')}` : `arms-${cls}`)
    let armsMaterials = null
    fs.rmSync(work, { recursive: true, force: true })
    try {
      // The include list comes from the export, so the arms and their includes are always exported (about
      // 0.3 s per class); the post stage is skipped when the input key matches.
      const groups = exportWithIncludes(ctx, bspToGlb, key, work)
      const files = groups.map(g => [g.key, ...['.mdl', '.vvd', '.dx90.vtx', '.ani'].map(ext => { const b = ctx.vpk.read(g.key.slice(0, -4) + ext); return b ? sha256(b) : null })])
      const inputKey = ctx.inputKey({ arms: key, role, files, tool, maxSize, textureExport: TEXTURE_EXPORT_VERSION, viewmodelExport: VIEWMODEL_EXPORT_VERSION, ...(standalone ? { defs: standaloneDefs, own, armsOverride: armsOverride === true } : {}) })
      const studio = groups[0].studio
      if (!extra) armsBones[cls] = new Set((studio.bones ?? []).map(b => lower(b.name)))
      const materials = studioMaterials([ctx.vpk], studio)
      armsMaterials = materials
      texturesOf.set(key, textureKeys(studio, materials))
      const prev = ctx.previous?.items?.[key]
      if (!ctx.options.force && prev?.inputKey === inputKey && ctx.manifest.items[key] && ctx.hasPackFile(file)) {
        ctx.addItem(key, listsWeapons ? { ...ctx.manifest.items[key], weapons: weaponsOfClass[cls] } : { ...ctx.manifest.items[key] })
        record[slot] = { skipped: true }
      } else {
        const merged = mergeSequences(groups)
        const sequences = []
        const copies = [] // { group, anim, clip }
        const clipNames = new Set()
        for (let i = 0; i < merged.length; i++) {
          const { name, group, seq } = merged[i]
          const anims = groups[group].studio.animations ?? []
          const anim = anims[seq.animationIndices?.[0]]
          // Arms: only the include models' sequences (the arms' own are the reference pose). A watch model and the
          // disguise kit's v_model carry their sequences themselves.
          const keep = (own || (i > 0 && group > 0)) && anim && anim.decodeStatus === 'supported' && !(seq.flags & (STUDIO_DELTA | STUDIO_OVERRIDE)) && !SKIP_SEQUENCE.test(name)
          let clip = null
          if (keep) {
            clip = clipNames.has(anim.name) ? `${anim.name}#${group}` : anim.name
            clipNames.add(clip)
            copies.push({ group, anim: anim.name, clip })
          }
          sequences.push({ name, frames: anim?.frameCount ?? 0, fps: anim?.fps ?? 30, clip, loop: Boolean(seq.flags & STUDIO_LOOPING), activity: seq.activityName || null, from: group })
        }
        const docs = new Map()
        for (const c of copies) if (!docs.has(c.group)) docs.set(c.group, await io.read(groups[c.group].glbPath))
        const restPoseClip = (studio.animations ?? [])[studio.sequences?.[0]?.animationIndices?.[0]]?.name ?? null
        const hook = materialHook(studio, materials)
        let copied = 0
        const result = await postProcessModel({
          restPoseClip,
          input: groups[0].glbPath,
          output: ctx.stagePath(file),
          keepClip: false,
          studioManifest: studio,
          transform: doc => {
            hook(doc)
            const nodeByName = new Map(doc.getRoot().listNodes().map(n => [lower(n.getName()), n]))
            for (const c of copies) {
              const src = docs.get(c.group).getRoot().listAnimations().find(a => a.getName() === c.anim)
              if (src && copyAnimation(doc, src, c.clip, nodeByName)) copied++
              else sequences.find(s => s.clip === c.clip).clip = null
            }
          },
        })
        const sequenceIndex = {}
        sequences.forEach((s, i) => { if (s.clip) sequenceIndex[s.name] = i })
        ctx.addItem(key, {
          kind: 'model',
          file,
          bytes: result.bytes,
          sha256: result.sha256,
          source: 'vpk',
          role,
          class: cls,
          textures: texturesOf.get(key),
          skins: Math.max(1, (studio.skinFamilies ?? []).length),
          attachments: attachmentsOf(studio),
          sequences,
          sequenceIndex,
          includeModels: groups.slice(1).map(g => g.key),
          poseParams: Object.fromEntries(Object.entries(mdlPoseParams(ctx.vpk.read(key))).map(([n, p]) => [n, { min: p.min, max: p.max }])),
          bodygroups: (studio.bodyParts ?? []).map(b => ({ name: b.name, models: b.models?.length ?? 0 })),
          bounds: [studio.bounds?.hullMin ?? [0, 0, 0], studio.bounds?.hullMax ?? [0, 0, 0]].map(v => v.map(round)),
          bones: (studio.bones ?? []).map(b => b.name),
          triangles: result.stats.after.triangles,
          ...(listsWeapons ? { weapons: weaponsOfClass[cls] } : {}),
          ...(standalone ? { defs: standaloneDefs } : {}),
          inputKey,
        })
        record[slot] = { sequences: sequences.length, clips: copied, bytes: result.bytes }
      }
    } catch (error) {
      record[slot] = { error: error.message.split('\n')[0] }
      ctx.removeItem(key)
    } finally {
      fs.rmSync(work, { recursive: true, force: true })
    }
    await exportTextures(ctx, texturesOf.get(key) ?? [], armsMaterials, wanted, stats, maxSize)
  }

  // ---- weapon c_models ------------------------------------------------------------------------------------
  for (const [key, use] of [...weaponModels].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const owner = ctx.manifest.items[key]?.stage
    if (owner && owner !== ctx.stage) {
      // Another stage owns this model (a throwable that is also a projectile): reuse its file as it is.
      stats.weapons.reused++
      texturesOf.set(key, ctx.manifest.items[key].textures ?? [])
      continue
    }
    wanted.add(key)
    const base = key.slice(0, -4)
    const file = `${base}.glb`
    const mdl = ctx.vpk.read(key)
    const parts = ['.vvd', '.dx90.vtx', '.ani'].map(ext => { const d = ctx.vpk.read(base + ext); return d ? sha256(d) : null })
    const classesOf = [...use.classes].sort()
    const inputKey = ctx.inputKey({ weapon: key, mdl: sha256(mdl), parts, tool, maxSize: weaponMaxSize, classes: classesOf, textureExport: TEXTURE_EXPORT_VERSION, viewmodelExport: VIEWMODEL_EXPORT_VERSION })
    const prev = ctx.previous?.items?.[key]
    const viewmodel = studio => ({
      defs: [...use.defs].sort((a, b) => a - b),
      classes: classesOf,
      mergeBones: Object.fromEntries(classesOf.map(c => [c, (studio?.bones ?? prev?.bones ?? []).map(b => (typeof b === 'string' ? b : b.name)).filter(n => armsBones[c]?.has(lower(n)))])),
    })
    let materials = null
    if (!ctx.options.force && prev?.inputKey === inputKey && ctx.manifest.items[key] && ctx.hasPackFile(file)) {
      ctx.addItem(key, { ...ctx.manifest.items[key], viewmodel: viewmodel(null) })
      stats.weapons.skipped++
    } else {
      const work = path.join(ctx.tmp, key.replace(/[^a-z0-9]+/g, '_'))
      fs.mkdirSync(work, { recursive: true })
      try {
        const exported = exportStudioModel({ bspToGlb, source: ctx.vpk, modelPath: key, workDir: work })
        const studio = exported.manifest
        materials = studioMaterials([ctx.vpk], studio)
        const anims = studio.animations ?? []
        const restPoseClip = anims[studio.sequences?.[0]?.animationIndices?.[0]]?.name ?? null
        const result = await postProcessModel({ restPoseClip, input: exported.glbPath, output: ctx.stagePath(file), keepClip: false, studioManifest: studio, transform: materialHook(studio, materials) })
        ctx.addItem(key, {
          kind: 'model',
          file,
          bytes: result.bytes,
          sha256: result.sha256,
          source: 'vpk',
          role: 'viewmodel:weapon',
          textures: textureKeys(studio, materials, 2),
          skins: Math.max(1, (studio.skinFamilies ?? []).length),
          attachments: attachmentsOf(studio),
          sequences: [],
          poseParams: Object.fromEntries(Object.entries(mdlPoseParams(mdl)).map(([n, p]) => [n, { min: p.min, max: p.max }])),
          bodygroups: (studio.bodyParts ?? []).map(b => ({ name: b.name, models: b.models?.length ?? 0 })),
          bounds: [studio.bounds?.hullMin ?? [0, 0, 0], studio.bounds?.hullMax ?? [0, 0, 0]].map(v => v.map(round)),
          bones: (studio.bones ?? []).map(b => b.name),
          triangles: result.stats.after.triangles,
          viewmodel: viewmodel(studio),
          inputKey,
        })
        stats.weapons.built++
      } catch (error) {
        stats.weapons.failed.push({ model: key, error: error.message.split('\n')[0] })
        ctx.removeItem(key)
        continue
      } finally {
        fs.rmSync(work, { recursive: true, force: true })
      }
    }
    texturesOf.set(key, ctx.manifest.items[key]?.textures ?? [])
    await exportTextures(ctx, texturesOf.get(key), materials, wanted, stats, weaponMaxSize)
  }

  for (const [k, item] of Object.entries(ctx.manifest.items)) if (item.stage === ctx.stage && !wanted.has(k)) ctx.removeItem(k)

  // ---- per-class download (contract 6.2: at most 10 MB DDS) ----------------------------------------------
  // Bytes of a pack file: the staged copy when this build wrote it, else the pack's.
  const fileBytes = rel => {
    for (const f of [ctx.stagePath(rel), path.join(ctx.out, rel)]) if (fs.existsSync(f)) return fs.statSync(f).size
    return 0
  }
  const itemBytes = k => (ctx.manifest.items[k]?.file ? fileBytes(ctx.manifest.items[k].file) : 0)
  const ddsOf = k => (ctx.manifest.items[k]?.file?.endsWith('.dds') ? itemBytes(k) : 0)
  const webpOf = k => (ctx.manifest.items[k]?.webp ? fileBytes(ctx.manifest.items[k].webp) : 0)
  for (const cls of classes) {
    const arms = ARMS[cls]
    const models = [arms, ...STANDALONE.filter(s => s.cls === cls).map(s => s.key), ...new Set(Object.values(weaponsOfClass[cls]))].filter(k => ctx.manifest.items[k])
    const textures = new Set(models.flatMap(k => texturesOf.get(k) ?? []))
    const armsTextures = texturesOf.get(arms) ?? []
    stats.perClass[cls] = {
      weapons: Object.keys(weaponsOfClass[cls]).length,
      models: models.length,
      textures: textures.size,
      glbBytes: models.reduce((s, k) => s + itemBytes(k), 0),
      ddsBytes: [...textures].reduce((s, k) => s + ddsOf(k), 0),
      webpBytes: [...textures].reduce((s, k) => s + webpOf(k), 0),
      armsBytes: itemBytes(arms) + armsTextures.reduce((s, k) => s + ddsOf(k), 0),
    }
  }
  const armsBuilt = Object.values(stats.arms).filter(a => !a.error).length
  ctx.log(`${armsBuilt} of ${classes.length} arms; weapons ${stats.weapons.built} built, ${stats.weapons.skipped} unchanged, ${stats.weapons.reused} reused, ${stats.weapons.failed.length} failed; ${stats.defs.resolved} def/class pairs, ${stats.defs.skipped.length} skipped; textures ${stats.textures.built} built, ${stats.textures.skipped} unchanged, ${stats.textures.reused} reused, ${stats.textures.unsupported.length} unsupported`)
  for (const [cls, a] of Object.entries(stats.arms)) if (a.error) ctx.log(`arms ${cls} failed: ${a.error}`)
  for (const [k, a] of Object.entries(stats.standalone)) ctx.log(a.error ? `standalone ${k} failed: ${a.error}` : `standalone ${k}: ${a.skipped ? 'unchanged' : `${a.clips} clips of ${a.sequences} sequences`}`)
  for (const [k, a] of Object.entries(stats.watches)) ctx.log(a.error ? `watch ${k} failed: ${a.error}` : `watch ${k}: ${a.skipped ? 'unchanged' : `${a.clips} clips of ${a.sequences} sequences`}`)
  for (const f of stats.weapons.failed) ctx.log(`failed ${f.model}: ${f.error}`)
  for (const [cls, p] of Object.entries(stats.perClass)) ctx.log(`${cls}: ${p.models} models, glb ${(p.glbBytes / 1e6).toFixed(2)} MB, dds ${(p.ddsBytes / 1e6).toFixed(2)} MB, webp ${(p.webpBytes / 1e6).toFixed(2)} MB`)
  ctx.writeFile('reports/viewmodels/summary.json', JSON.stringify(stats, null, 1) + '\n')
  if (armsBuilt < classes.length) throw new Error(`viewmodels: ${classes.length - armsBuilt} arms failed`)
  return { arms: stats.arms, watches: stats.watches, standalone: stats.standalone, weapons: { ...stats.weapons }, perClass: stats.perClass }
}

/** Texture items for `keys`, as the models stage writes them (contract 12.3); reuses other stages' items. */
async function exportTextures(ctx, keys, materials, wanted, stats, maxSize) {
  for (const tkey of keys) {
    if (wanted.has(tkey)) continue
    wanted.add(tkey)
    const existing = ctx.manifest.items[tkey]
    if (existing && existing.stage && existing.stage !== ctx.stage) { stats.textures.reused++; continue }
    const vtf = ctx.vpk.read(`materials/${tkey}.vtf`)
    if (!vtf) { stats.textures.unsupported.push({ key: tkey, reason: 'missing' }); ctx.removeItem(tkey); continue }
    const tInputKey = ctx.inputKey({ texture: tkey, vtf: sha256(vtf), maxSize, textureExport: TEXTURE_EXPORT_VERSION })
    const prevT = ctx.previous?.items?.[tkey]
    if (!ctx.options.force && prevT?.inputKey === tInputKey && existing && ctx.hasPackFile(existing.file)) { stats.textures.skipped++; continue }
    let out
    try { out = await exportVtf(vtf, { maxSize }) } catch (error) {
      stats.textures.unsupported.push({ key: tkey, reason: error.message }); ctx.removeItem(tkey); continue
    }
    const header = parseVtfHeader(vtf)
    if (!out.info) { stats.textures.unsupported.push({ key: tkey, reason: header.formatName ?? '?' }); ctx.removeItem(tkey); continue }
    const usedBy = (materials ?? []).find(m => m.key === tkey)
    const ddsPath = out.dds ? ctx.writeFile(`textures/${tkey}.dds`, out.dds) : null
    const webpPath = out.webp ? ctx.writeFile(`textures/${tkey}.webp`, out.webp) : null
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
