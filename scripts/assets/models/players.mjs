// Animated player models for the models stage (as/tpanim): the nine class models (`models/player/<class>.mdl`, the
// real pyro and not the MvM robot of the public GLB) with their skeleton, team skins and the clips of the sequences
// the runtime plays in third person (src/assetpack/playerAnim.ts).
//
// Sequences are found by activity, as TF2's CTFPlayerAnimState translates them for the weapon's anim slot
// (ACT_MP_STAND_<slot>, ACT_MP_RUN_<slot>, ...), across the player model and its include models in Source's
// virtual-model order (the model first, then each include depth first; the first match wins). Per slot the item
// lists stand, crouch, run, crouch walk and airwalk, heavy's and sniper's deployed variants, the aim matrix each one
// auto-layers (only the body_yaw = 0 column: the runtime keeps the feet under the eyes) and the attack gestures with
// their layers and per-bone weights. Clips are copied from the include GLBs onto the player's bones by name; tracks
// that never change are reduced to one key, and dropped when they equal the bone default (absolute clips) or the
// identity (delta clips), so a missing track always means "the default".
//
// Anim slots come from the item schema (anim_slot, else the class's loadout slot, else item_slot), per class for
// viewmodels/list.mjs's WEAPON_DEFS. Every number written here (pose keys, weights, motion) comes from the user's own
// files and stays in the pack (D19).

import fs from 'node:fs'
import path from 'node:path'
import { postProcessModel, createModelIo } from '../lib/model-export.mjs'
import { sha256 } from '../lib/vpk.mjs'
import { studioMaterials } from './stage.mjs'
import { mdlPoseParams, mdlSequences, mdlAnimMotion } from './mdl.mjs'
import { WEAPON_DEFS } from '../viewmodels/list.mjs'
import { attachmentsOf, textureKeys, materialHook, exportWithIncludes, copyAnimation, exportTextures } from '../viewmodels/stage.mjs'

const PLAYER_EXPORT_VERSION = 2 // 2: gesture layers of pose-driven auto layers
const STUDIO_DELTA = 0x4
const STUDIO_AL_POSE = 0x4000
const EPS = 1e-5
const lower = s => String(s).toLowerCase()

// CLASS_MAP file names -> class model and schema class name
export const PLAYER_CLASSES = {
  scout: { model: 'models/player/scout.mdl', schema: 'scout' },
  soldier: { model: 'models/player/soldier.mdl', schema: 'soldier' },
  pyro: { model: 'models/player/pyro.mdl', schema: 'pyro' },
  demoman: { model: 'models/player/demo.mdl', schema: 'demoman' },
  heavy: { model: 'models/player/heavy.mdl', schema: 'heavy' },
  engineer: { model: 'models/player/engineer.mdl', schema: 'engineer' },
  medic: { model: 'models/player/medic.mdl', schema: 'medic' },
  sniper: { model: 'models/player/sniper.mdl', schema: 'sniper' },
  spy: { model: 'models/player/spy.mdl', schema: 'spy' },
}

const BASE_SLOTS = ['PRIMARY', 'SECONDARY', 'MELEE']
// state -> activity of slot S
const STATES = {
  stand: S => `ACT_MP_STAND_${S}`,
  crouch: S => `ACT_MP_CROUCH_${S}`,
  run: S => `ACT_MP_RUN_${S}`,
  crouchWalk: S => `ACT_MP_CROUCHWALK_${S}`,
  air: S => `ACT_MP_AIRWALK_${S}`,
}
// heavy's revved minigun and the sniper's zoom (TF_COND_AIMING) for the primary slot
const DEPLOYED = { stand: 'ACT_MP_DEPLOYED_IDLE', crouch: 'ACT_MP_CROUCH_DEPLOYED_IDLE', run: 'ACT_MP_DEPLOYED_PRIMARY', crouchWalk: 'ACT_MP_CROUCH_DEPLOYED' }
const GESTURES = { attackStand: S => `ACT_MP_ATTACK_STAND_${S}`, attackCrouch: S => `ACT_MP_ATTACK_CROUCH_${S}` }

/** def -> anim slot ('PRIMARY', 'MELEE_ALLCLASS', ...) of the WEAPON_DEFS that `schemaClass` uses. */
export function animSlots(schema, schemaClass) {
  const out = {}
  for (const d of WEAPON_DEFS) {
    const s = schema.animSlot(d, schemaClass)
    if (s) out[d] = s
  }
  return out
}

/** Sequence lookup over the virtual model: groups[g] = { key, studio, mdl: { seqs, motion, poseNames } }. */
function sequenceIndex(groups) {
  const byActivity = new Map()
  const byName = new Map()
  groups.forEach((g, gi) => {
    ;(g.studio.sequences ?? []).forEach((seq, si) => {
      const ref = { g: gi, s: si }
      if (seq.activityName && !byActivity.has(seq.activityName.toUpperCase())) byActivity.set(seq.activityName.toUpperCase(), ref)
      if (!byName.has(lower(seq.name))) byName.set(lower(seq.name), ref)
    })
  })
  return { byActivity, byName }
}

function isConstant(arr, size) {
  for (let i = size; i < arr.length; i++) if (Math.abs(arr[i] - arr[i % size]) > EPS) return false
  return true
}

/** Constant tracks to one key; constant tracks equal to the default dropped (see the header). */
function pruneTracks(doc, deltaClips) {
  let dropped = 0, reduced = 0
  const buffer = doc.getRoot().listBuffers()[0]
  for (const anim of doc.getRoot().listAnimations()) {
    const delta = deltaClips.has(anim.getName())
    for (const ch of anim.listChannels()) {
      const s = ch.getSampler()
      const out = s.getOutput()
      const size = ch.getTargetPath() === 'rotation' ? 4 : 3
      const arr = out.getArray()
      if (!isConstant(arr, size)) continue
      const v = Array.from(arr.slice(0, size))
      const node = ch.getTargetNode()
      const def = delta ? (size === 4 ? [0, 0, 0, 1] : [0, 0, 0]) : size === 4 ? node.getRotation() : node.getTranslation()
      // q and -q are the same rotation
      const same = v.every((x, i) => Math.abs(x - def[i]) < 1e-4) || (size === 4 && v.every((x, i) => Math.abs(x + def[i]) < 1e-4))
      if (same) {
        ch.dispose()
        s.dispose()
        dropped++
        continue
      }
      s.setInput(doc.createAccessor().setType('SCALAR').setArray(new Float32Array([0])).setBuffer(buffer))
      s.setOutput(doc.createAccessor().setType(size === 4 ? 'VEC4' : 'VEC3').setArray(new Float32Array(v)).setBuffer(buffer))
      reduced++
    }
  }
  return { dropped, reduced }
}

/** The animation table of one class (see the header) plus the clips to copy. */
function animTable(groups, slots) {
  const { byActivity, byName } = sequenceIndex(groups)
  const clips = {} // clip name -> { g, anim, frames, fps, delta, motion }
  const clipOf = (g, ai) => {
    const anim = groups[g].studio.animations?.[ai]
    if (!anim) return null
    let name = anim.name
    const taken = clips[name]
    if (taken && (taken.g !== g || taken.anim !== anim.name)) name = `${anim.name}#${g}`
    if (!clips[name]) {
      const m = groups[g].mdl.motion[ai]
      const motion = m?.motion ? [m.motion[0], m.motion[1]].map(v => Math.round(v * 1000) / 1000) : null
      clips[name] = { g, anim: anim.name, frames: anim.frameCount, fps: anim.fps, delta: (anim.flags & STUDIO_DELTA) !== 0, ...(motion && (motion[0] || motion[1]) ? { motion } : {}) }
    }
    return name
  }
  const paramsOf = (g, si) => {
    const raw = groups[g].mdl.seqs[si]
    const names = groups[g].mdl.poseNames
    const gs = raw.groupSize
    return {
      raw,
      p: [names[raw.paramIndex[0]] ?? null, names[raw.paramIndex[1]] ?? null],
      k: [raw.poseKeys.slice(0, gs[0]), raw.poseKeys.slice(gs[0], gs[0] + gs[1])],
    }
  }
  // the body_yaw = 0 column of an aim matrix, rows sorted by body_pitch
  const aimOf = (g, si) => {
    const seq = groups[g].studio.sequences[si]
    const [g0, g1] = seq.groupSize
    const { p, k } = paramsOf(g, si)
    const yawDim = p[0] === 'body_yaw' ? 0 : p[1] === 'body_yaw' ? 1 : -1
    const pitchDim = p[0] === 'body_pitch' ? 0 : p[1] === 'body_pitch' ? 1 : -1
    if (yawDim < 0 || pitchDim < 0) return null
    const yawKeys = k[yawDim]
    let center = 0
    for (let i = 1; i < yawKeys.length; i++) if (Math.abs(yawKeys[i]) < Math.abs(yawKeys[center])) center = i
    const rows = []
    for (let j = 0; j < k[pitchDim].length; j++) {
      const i0 = yawDim === 0 ? center : j
      const i1 = yawDim === 0 ? j : center
      const clip = clipOf(g, seq.animationIndices[i0 + i1 * g0])
      if (clip) rows.push({ pitch: Math.round(k[pitchDim][j] * 1000) / 1000, clip })
    }
    rows.sort((a, b) => a.pitch - b.pitch)
    return rows.length && g1 ? { name: seq.name, rows } : null
  }
  const seqOf = ref => {
    if (!ref) return null
    const { g, s } = ref
    const seq = groups[g].studio.sequences[s]
    const out = { name: seq.name, clips: seq.animationIndices.map(ai => clipOf(g, ai)) }
    if (out.clips.some(c => !c)) return null
    const [g0, g1] = seq.groupSize
    if (g0 * g1 > 1) {
      const { p, k } = paramsOf(g, s)
      if (!p.includes('move_x') || !p.includes('move_y')) return null
      out.grid = { p, k: k.map(a => a.map(v => Math.round(v * 1000) / 1000)), size: [g0, g1] }
    }
    // movement of the forward clip (or the longest) per loop: stride and speed
    let best = null
    for (const c of out.clips) {
      const m = clips[c].motion
      if (!m) continue
      const len = Math.hypot(m[0], m[1])
      if (!best || (m[0] > 0 && Math.abs(m[1]) < 1e-3) || len > best.len) best = { len, frames: clips[c].frames, fps: clips[c].fps }
      if (m[0] > 0 && Math.abs(m[1]) < 1e-3) break
    }
    if (best && best.frames > 1) {
      out.stride = Math.round(best.len * 1000) / 1000
      out.speed = Math.round((best.len / ((best.frames - 1) / best.fps)) * 1000) / 1000
    }
    for (const al of seq.autoLayers ?? []) {
      const layer = groups[g].studio.sequences[al.sequence]
      if (!layer || !(layer.flags & STUDIO_DELTA) || layer.groupSize[0] * layer.groupSize[1] < 4) continue
      const aim = aimOf(g, al.sequence)
      if (aim) { out.aim = aim; break }
    }
    return out
  }
  const gestureOf = ref => {
    if (!ref) return null
    const { g, s } = ref
    const seqs = groups[g].studio.sequences
    const bones = (groups[g].studio.bones ?? []).map(b => b.name)
    const parts = []
    const add = si => {
      const seq = seqs[si]
      if (!seq || seq.groupSize[0] * seq.groupSize[1] !== 1) return
      const raw = groups[g].mdl.seqs[si]
      const w = raw.weights
      if (w.length && w.every(x => x === 0)) return
      const clip = clipOf(g, seq.animationIndices[0])
      if (!clip || clips[clip].frames < 2) return
      const part = { clip, delta: (seq.flags & STUDIO_DELTA) !== 0 }
      if (w.length && !w.every(x => x === 1)) {
        part.weights = {}
        w.forEach((x, b) => { if (x > 0 && bones[b]) part.weights[bones[b]] = Math.round(x * 1000) / 1000 })
      }
      parts.push(part)
    }
    // the sequence and its auto layers, recursively: every plain layer, and of pose-driven ones (forward and back
    // variants keyed on move_x) only the first per pose parameter
    const visit = (si, depth) => {
      add(si)
      if (depth > 3) return
      const posesSeen = new Set()
      for (const al of seqs[si]?.autoLayers ?? []) {
        if (al.flags & STUDIO_AL_POSE) {
          if (posesSeen.has(al.pose)) continue
          posesSeen.add(al.pose)
        }
        visit(al.sequence, depth + 1)
      }
    }
    visit(s, 0)
    if (!parts.length) return null
    const duration = Math.max(...parts.map(p => (clips[p.clip].frames - 1) / clips[p.clip].fps))
    return { name: seqs[s].name, duration: Math.round(duration * 1e4) / 1e4, parts }
  }

  const table = {}
  for (const S of slots) {
    const slot = {}
    for (const [state, act] of Object.entries(STATES)) {
      const seq = seqOf(byActivity.get(act(S)))
      if (seq) slot[state] = seq
    }
    if (!slot.stand) continue
    if (S === 'PRIMARY') {
      const dep = {}
      for (const [state, act] of Object.entries(DEPLOYED)) {
        const seq = seqOf(byActivity.get(act))
        if (seq) dep[state] = seq
      }
      if (dep.stand) slot.deployed = dep
    }
    for (const [state, act] of Object.entries(GESTURES)) {
      const gesture = gestureOf(byActivity.get(act(S)))
      if (gesture) slot[state] = gesture
    }
    table[S] = slot
  }
  void byName
  return { table, clips }
}

function partFiles(vpk, key) {
  return [key, ...['.mdl', '.vvd', '.dx90.vtx', '.ani'].map(ext => { const b = vpk.read(key.slice(0, -4) + ext); return b ? sha256(b) : null })]
}

/**
 * Builds or keeps the `models/player/<class>.mdl` items (role `player:model`). `schema` gives the anim slots; returns
 * per-class stats. Texture items follow the models stage's rules (512 px, skins 0 and 1).
 */
export async function buildPlayerModels(ctx, { bspToGlb, tool, schema, wanted, textureMaxSize = 1024 }) {
  const stats = {}
  const texStats = { textures: { built: 0, skipped: 0, reused: 0, unsupported: [] } }
  for (const [cls, { model: key, schema: schemaClass }] of Object.entries(PLAYER_CLASSES)) {
    wanted.add(key)
    const file = `${key.slice(0, -4)}.glb`
    const work = path.join(ctx.tmp, `player-${cls}`)
    fs.rmSync(work, { recursive: true, force: true })
    let materials = null
    try {
      if (!ctx.vpk.has(key)) throw new Error(`${key} not in the VPKs`)
      const defSlots = schema ? animSlots(schema, schemaClass) : {}
      const slots = [...new Set([...BASE_SLOTS, ...Object.values(defSlots)])].sort()
      const groups = exportWithIncludes(ctx, bspToGlb, key, work)
      const inputKey = ctx.inputKey({ player: key, files: groups.map(g => partFiles(ctx.vpk, g.key)), slots, defSlots, tool, maxSize: textureMaxSize, playerExport: PLAYER_EXPORT_VERSION })
      const studio = groups[0].studio
      materials = studioMaterials([ctx.vpk], studio)
      const textures = textureKeys(studio, materials, 2)
      const prev = ctx.previous?.items?.[key]
      if (!ctx.options.force && prev?.inputKey === inputKey && ctx.manifest.items[key] && ctx.hasPackFile(file)) {
        ctx.addItem(key, { ...ctx.manifest.items[key] })
        stats[cls] = { skipped: true }
      } else {
        for (const g of groups) {
          const buf = ctx.vpk.read(g.key)
          g.mdl = { seqs: mdlSequences(buf), motion: mdlAnimMotion(buf), poseNames: Object.keys(mdlPoseParams(buf)) }
        }
        const { table, clips } = animTable(groups, slots)
        const io = await createModelIo()
        const docs = new Map()
        let copied = 0
        const deltaClips = new Set(Object.entries(clips).filter(([, c]) => c.delta).map(([n]) => n))
        let pruned = null
        const hook = materialHook(studio, materials)
        for (const c of Object.values(clips)) if (!docs.has(c.g)) docs.set(c.g, await io.read(groups[c.g].glbPath))
        const result = await postProcessModel({
          restPoseClip: null,
          input: groups[0].glbPath,
          output: ctx.stagePath(file),
          keepClip: false,
          studioManifest: studio,
          transform: doc => {
            hook(doc)
            const nodeByName = new Map(doc.getRoot().listNodes().map(n => [lower(n.getName()), n]))
            for (const [name, c] of Object.entries(clips)) {
              const src = docs.get(c.g).getRoot().listAnimations().find(a => a.getName() === c.anim)
              if (src && copyAnimation(doc, src, name, nodeByName)) copied++
            }
            pruned = pruneTracks(doc, deltaClips)
            // a clip whose every track is the default has no channels left: the runtime treats a missing clip so
            for (const a of doc.getRoot().listAnimations()) if (!a.listChannels().length) { for (const s of a.listSamplers()) s.dispose(); a.dispose() }
          },
        })
        docs.clear()
        const clipInfo = Object.fromEntries(Object.entries(clips).sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, c]) => [n, { frames: c.frames, fps: c.fps, delta: c.delta, ...(c.motion ? { motion: c.motion } : {}) }]))
        ctx.addItem(key, {
          kind: 'model',
          file,
          bytes: result.bytes,
          sha256: result.sha256,
          source: 'vpk',
          role: 'player:model',
          class: cls,
          textures,
          skins: Math.max(1, (studio.skinFamilies ?? []).length),
          teamSkins: [0, 1],
          attachments: attachmentsOf(studio),
          sequences: [],
          poseParams: Object.fromEntries(Object.entries(mdlPoseParams(ctx.vpk.read(key))).map(([n, p]) => [n, { min: p.min, max: p.max }])),
          bodygroups: (studio.bodyParts ?? []).map(b => ({ name: b.name, models: b.models?.length ?? 0 })),
          bounds: [studio.bounds?.hullMin ?? [0, 0, 0], studio.bounds?.hullMax ?? [0, 0, 0]].map(v => v.map(x => Math.round(x * 1e5) / 1e5)),
          bones: (studio.bones ?? []).map(b => b.name),
          triangles: result.stats.after.triangles,
          anim: { version: 1, defSlots, slots: table, clips: clipInfo },
          inputKey,
        })
        stats[cls] = { slots: Object.keys(table), clips: Object.keys(clips).length, copied, pruned, bytes: result.bytes }
      }
    } catch (error) {
      stats[cls] = { error: error.message.split('\n')[0] }
      ctx.removeItem(key)
    } finally {
      fs.rmSync(work, { recursive: true, force: true })
    }
    await exportTextures(ctx, ctx.manifest.items[key]?.textures ?? [], materials, wanted, texStats, textureMaxSize)
  }
  return { players: stats, textures: texStats.textures }
}
