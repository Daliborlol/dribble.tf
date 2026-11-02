#!/usr/bin/env node
// Exports one model from the VPKs through lib/model-export.mjs: bsp-to-glb --studio-*, then the
// post stage (LOD 0, clip pruning, no empty weights, plain meshopt). For checks and later stages;
// the output goes where --out says, never into the repository.
//
//   node scripts/assets/tools/export-model.mjs --tf2 <dir> [--hl2 <dir>] --model models/buildables/sentry1.mdl
//     --work <dir> --out <file.glb> [--keep-clips <regex>] [--skin n] [--no-meshopt] [--bsp-to-glb <bin>]

import path from 'node:path'
import { openVpkSet, locateTf2Vpks } from '../lib/vpk.mjs'
import { exportStudioModel, postProcessModel, findBspToGlb } from '../lib/model-export.mjs'
import { outDirProblem } from '../lib/fsutil.mjs'

const argv = process.argv.slice(2)
const o = { meshopt: true }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--no-meshopt') { o.meshopt = false; continue }
  const k = a.replace(/^--/, '')
  if (!['tf2', 'hl2', 'model', 'work', 'out', 'keep-clips', 'skin', 'bsp-to-glb'].includes(k) || argv[i + 1] === undefined) {
    console.error('usage: export-model.mjs --tf2 <dir> [--hl2 <dir>] --model <models/x.mdl> --work <dir> --out <file.glb> [--keep-clips re] [--skin n] [--no-meshopt] [--bsp-to-glb bin]')
    process.exit(2)
  }
  o[k] = argv[++i]
}
if (!o.model || !o.work || !o.out) { console.error('--model, --work and --out are required'); process.exit(2) }
const problem = outDirProblem(path.dirname(path.resolve(o.out)))
if (problem) { console.error(`refusing --out: ${problem}`); process.exit(2) }
const located = locateTf2Vpks(o.tf2, o.hl2)
const vpk = openVpkSet(located.files, { labels: located.labels })
const bspToGlb = findBspToGlb(o['bsp-to-glb'])
const t0 = performance.now()
const exported = exportStudioModel({ bspToGlb, source: vpk, modelPath: o.model, workDir: o.work, skin: o.skin === undefined ? undefined : Number(o.skin) })
const t1 = performance.now()
const result = await postProcessModel({
  input: exported.glbPath,
  output: o.out,
  keepClip: o['keep-clips'] ? new RegExp(o['keep-clips']) : true,
  meshopt: o.meshopt,
  studioManifest: exported.manifest,
})
console.log(JSON.stringify({ model: o.model, out: o.out, exportMs: Math.round(t1 - t0), postMs: Math.round(performance.now() - t1), rawBytes: exported.manifest.glbBytes ?? null, ...result }, null, 1))
vpk.close()
