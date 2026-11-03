// Third-person weapons for the models stage (as/tpweapons): which model each (def, class) holds in third person,
// the world models the other stages do not export, and per class the pose of the public player model, so the
// runtime can bone-merge those models onto a player GLB that has no skeleton (src/assetpack/thirdPerson.ts).
//
// Model choice: lib/schema.mjs `resolveWorld` (model_world, else model_player_per_class, else model_player) for
// viewmodels/list.mjs's WEAPON_DEFS, the defs the viewmodels stage exports too. Most are c_models with
// attach_to_hands, which the viewmodels stage exports (its `viewmodel:weapon` items serve both views); this
// stage exports the rest as role `weapon:world` through the same path as every other model (worldWeaponEntries).
//
// Poses (thirdPersonPoses): `createPoseFitter` (playerPose.mjs) pairs the public GLB's vertices with the pack's
// player model and finds the animation frame it was baked in. The item `thirdperson:<class>` is a small GLB with
// one node per bone (matrices in the pack copy's Source axes) under a root `pose` whose matrix maps that space
// into the public GLB, plus `weapons { <def>: <model key> }` and `wearables { <def>: <model key> }`. All of it is
// pack data (D19); nothing here is committed.

import fs from 'node:fs'
import path from 'node:path'
import { Document } from '@gltf-transform/core'
import draco3d from 'draco3dgltf'
import { exportStudioModel, createModelIo } from '../lib/model-export.mjs'
import { sha256 } from '../lib/vpk.mjs'
import { writeFileAtomic } from '../lib/fsutil.mjs'
import { WEAPON_DEFS } from '../viewmodels/list.mjs'
import { createPoseFitter } from './playerPose.mjs'

const POSE_VERSION = 2 // 2: GLB scene renamed (the root node keeps 'pose')
const lower = s => String(s).toLowerCase()

// The model each public player GLB was made from. The public pyro is the MvM robot pyro (its materials are
// models/bots/pyro/...); the others are the class models. Keys are the public file names (CLASS_MAP).
export const PLAYER_MODELS = {
  scout: 'models/player/scout.mdl',
  soldier: 'models/player/soldier.mdl',
  pyro: 'models/bots/pyro/bot_pyro.mdl',
  demoman: 'models/player/demo.mdl',
  heavy: 'models/player/heavy.mdl',
  engineer: 'models/player/engineer.mdl',
  medic: 'models/player/medic.mdl',
  sniper: 'models/player/sniper.mdl',
  spy: 'models/player/spy.mdl',
}
// Schema class names (used_by_classes) of the public file names
const SCHEMA_CLASS = { scout: 'scout', soldier: 'soldier', pyro: 'pyro', demoman: 'demoman', heavy: 'heavy', engineer: 'engineer', medic: 'medic', sniper: 'sniper', spy: 'spy' }

/**
 * Per class { weapons: { def: model }, wearables: { def: model } } and the models the viewmodels stage owns.
 * Only models the VPKs hold are listed.
 */
export function thirdPersonModels(schema, vpk) {
  const owned = new Set() // c_models the viewmodels stage exports for the same defs
  const perClass = {}
  const skipped = []
  for (const cls of Object.keys(PLAYER_MODELS)) {
    const sc = SCHEMA_CLASS[cls]
    const weapons = {}, wearables = {}
    for (const d of WEAPON_DEFS) {
      const vm = schema.resolve(d, sc)
      if (vm && !vm.skip && vpk.has(vm.model)) owned.add(vm.model)
      const r = schema.resolveWorld(d, sc)
      if (!r) continue
      if (r.extra && vpk.has(r.extra)) wearables[d] = r.extra
      if (r.skip) { skipped.push({ def: d, class: cls, reason: r.skip }); continue }
      if (!vpk.has(r.model)) { skipped.push({ def: d, class: cls, reason: 'model not in the VPKs', model: r.model }); continue }
      weapons[d] = r.model
    }
    perClass[cls] = { weapons, wearables }
  }
  return { perClass, owned, skipped }
}

/** models-stage list entries for the third-person models no other entry or stage exports. */
export function worldWeaponEntries(models, listed) {
  const keys = new Set()
  for (const { weapons, wearables } of Object.values(models.perClass)) {
    for (const k of [...Object.values(weapons), ...Object.values(wearables)]) keys.add(k)
  }
  return [...keys]
    .filter(k => !models.owned.has(k) && !listed.has(k))
    .sort()
    .map(model => ({ model, role: 'weapon:world', clips: 'none', textureMaxSize: 512, textureSkins: 2 }))
}

function filesOf(vpk, key) {
  const base = key.slice(0, -4)
  return [key, ...['.mdl', '.vvd', '.dx90.vtx', '.ani'].map(ext => { const d = vpk.read(base + ext); return d ? sha256(d) : null })]
}

async function poseGlb(io, fit) {
  const doc = new Document()
  doc.createBuffer()
  const scene = doc.createScene('thirdperson')
  const root = doc.createNode('pose').setMatrix(fit.fit)
  scene.addChild(root)
  for (const name of Object.keys(fit.bones).sort()) root.addChild(doc.createNode(name).setMatrix(fit.bones[name]))
  return Buffer.from(await io.writeBinary(doc))
}

/**
 * Builds or keeps the `thirdperson:<class>` items. `models` from thirdPersonModels; `exported(key)` says
 * whether the pack lists a model (any stage). Returns per-class stats.
 */
export async function thirdPersonPoses(ctx, { bspToGlb, tool, models, wanted }) {
  // the public player GLBs are Draco compressed
  const io = (await createModelIo()).registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule() })
  const stats = {}
  for (const [cls, modelKey] of Object.entries(PLAYER_MODELS)) {
    const key = `thirdperson:${cls}`
    const file = `models/thirdperson/${cls}.pose.glb`
    wanted.add(key)
    const publicFile = path.join(ctx.checkout, 'public', 'models', 'players', `${cls}_red.glb`)
    const { weapons, wearables } = models.perClass[cls]
    const extra = { class: cls, weapons, wearables }
    if (!fs.existsSync(publicFile) || !ctx.vpk.has(modelKey)) {
      stats[cls] = { error: !ctx.vpk.has(modelKey) ? `${modelKey} not in the VPKs` : `${publicFile} missing` }
      ctx.removeItem(key)
      continue
    }
    const publicSha = sha256(fs.readFileSync(publicFile))
    const work = path.join(ctx.tmp, `pose-${cls}`)
    fs.rmSync(work, { recursive: true, force: true })
    try {
      const player = exportStudioModel({ bspToGlb, source: ctx.vpk, modelPath: modelKey, workDir: path.join(work, 'player') })
      const includes = (player.manifest.includeModels ?? []).map(lower).filter(k => ctx.vpk.has(k))
      const inputKey = ctx.inputKey({ pose: cls, files: [filesOf(ctx.vpk, modelKey), ...includes.map(k => filesOf(ctx.vpk, k))], publicSha, tool, poseVersion: POSE_VERSION })
      const prev = ctx.previous?.items?.[key]
      if (!ctx.options.force && prev?.inputKey === inputKey && ctx.manifest.items[key] && ctx.hasPackFile(file)) {
        ctx.addItem(key, { ...ctx.manifest.items[key], ...extra })
        stats[cls] = { skipped: true }
        continue
      }
      const fitter = createPoseFitter({ publicDoc: await io.read(publicFile), playerDoc: await io.read(player.glbPath) })
      for (const [i, inc] of includes.entries()) {
        const dir = path.join(work, `inc${i}`)
        const e = exportStudioModel({ bspToGlb, source: ctx.vpk, modelPath: inc, workDir: dir })
        fitter.addAnimations(await io.read(e.glbPath))
        fs.rmSync(dir, { recursive: true, force: true })
      }
      const fit = fitter.result()
      const bytes = await poseGlb(io, fit)
      writeFileAtomic(ctx.stagePath(file), bytes)
      ctx.addItem(key, {
        kind: 'model',
        file,
        bytes: bytes.length,
        sha256: sha256(bytes),
        source: 'vpk',
        role: 'player:pose',
        textures: [],
        skins: 1,
        attachments: {},
        sequences: [],
        poseParams: {},
        bounds: [[0, 0, 0], [0, 0, 0]],
        pose: { model: modelKey, publicModel: `public/models/players/${cls}_red.glb`, publicSha256: publicSha, clip: fit.clip, frame: fit.frame, rms: fit.rms, handRms: fit.handRms, scale: fit.scale, pairs: fit.pairs },
        bones: Object.keys(fit.bones).sort(),
        ...extra,
        inputKey,
      })
      stats[cls] = { clip: fit.clip, frame: fit.frame, rms: fit.rms, handRms: fit.handRms, pairs: fit.pairs }
    } catch (error) {
      stats[cls] = { error: error.message.split('\n')[0] }
      ctx.removeItem(key)
    } finally {
      fs.rmSync(work, { recursive: true, force: true })
    }
  }
  return stats
}
