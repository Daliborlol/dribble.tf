// Fixture `models` stage for tests of the builder (loaded only with `--stage-dir`). It exports a few
// models through lib/model-export.mjs, so a test build exercises the real export, the post stage,
// staging, incremental skips and the manifest items. Phase 3's real models stage replaces it.
//
// Options (--set): fixtureModels=["models/...mdl", ...] or fixtureModels="<vpk prefix>" (every .mdl
// under it), fixtureKeepClips="<regex>", fixtureSkipFailures=true (count export failures instead of
// failing), fixtureFail=true (throws after writing its outputs, to test that a failed build changes
// nothing).

import fs from 'node:fs'
import path from 'node:path'
import { exportStudioModel, postProcessModel, findBspToGlb, bspToGlbVersion } from '../../../lib/model-export.mjs'

const DEFAULT_MODELS = [
  'models/buildables/sentry1.mdl',
  'models/buildables/dispenser_light.mdl',
  'models/buildables/teleporter_light.mdl',
  'models/weapons/w_models/w_rocket.mdl',
  'models/weapons/c_models/c_scattergun.mdl',
  'models/items/medkit_medium.mdl',
]

export async function run(ctx) {
  const set = ctx.options.set
  const models = typeof set.fixtureModels === 'string'
    ? ctx.vpk.list(set.fixtureModels).filter(p => p.endsWith('.mdl'))
    : (set.fixtureModels ?? DEFAULT_MODELS)
  const keepClips = set.fixtureKeepClips ?? null
  const bspToGlb = findBspToGlb(ctx.options.bspToGlb)
  const tool = bspToGlbVersion(bspToGlb)
  ctx.setOptions({ keepClips, models: [...models].sort() })
  let built = 0, skipped = 0
  const failed = []
  const wanted = new Set()
  for (const model of models) {
    const key = model.toLowerCase()
    wanted.add(key)
    const file = `${key.replace(/\.mdl$/, '')}.glb`
    const stat = ['.mdl', '.vvd', '.dx90.vtx'].map(ext => ctx.vpk.stat(key.replace(/\.mdl$/, ext))?.crc32 ?? null)
    const inputKey = ctx.inputKey({ model: key, sources: stat, tool, keepClips, post: { lod0: true, meshopt: 'high' } })
    const prev = ctx.previous?.items?.[key]
    if (!ctx.options.force && prev?.inputKey === inputKey && ctx.manifest.items[key] && ctx.hasPackFile(file)) { skipped++; continue }
    const work = path.join(ctx.tmp, key.replace(/[^a-z0-9]+/g, '_'))
    fs.mkdirSync(work, { recursive: true })
    let exported, result
    try {
      exported = exportStudioModel({ bspToGlb, source: ctx.vpk, modelPath: key, workDir: work })
      result = await postProcessModel({
        input: exported.glbPath,
        output: ctx.stagePath(file),
        keepClip: keepClips ? new RegExp(keepClips) : true,
        studioManifest: exported.manifest,
      })
    } catch (error) {
      if (!set.fixtureSkipFailures) throw error
      failed.push({ model: key, error: error.message.split('\n')[0] })
      ctx.removeItem(key)
      continue
    }
    ctx.addItem(key, { kind: 'model', file, bytes: result.bytes, sha256: result.sha256, inputKey, triangles: result.stats.after.triangles })
    built++
  }
  for (const [key, item] of Object.entries(ctx.manifest.items)) if (item.kind === 'model' && !wanted.has(key)) ctx.removeItem(key)
  if (set.fixtureFail) throw new Error('fixtureFail: planted failure after the outputs were staged')
  ctx.log(`${built} built, ${skipped} unchanged${failed.length ? `, ${failed.length} failed` : ''}`)
  for (const f of failed) ctx.log(`failed ${f.model}: ${f.error}`)
  return { built, skipped, failed }
}
