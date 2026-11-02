#!/usr/bin/env node
// Parses every VMT of one VPK with lib/vmt.mjs and reports what the rules of contract 2.6 met.
//
//   node scripts/assets/tools/vmt-survey.mjs --tf2 <dir> [--hl2 <dir>] [--vpk tf/tf2_misc_dir.vpk] [--prefix materials/] [--out f.json]
//
// --vpk names the directory file to survey (its manifest label, default tf/tf2_misc_dir.vpk); the
// whole set is still used to check that each $basetexture exists. Exit 1 when any file throws.

import fs from 'node:fs'
import { openVpkSet, locateTf2Vpks } from '../lib/vpk.mjs'
import { parseVmt, readMaterialFile, vmtBaseTexture, vmtAlpha, vmtTruthy } from '../lib/vmt.mjs'

const argv = process.argv.slice(2)
const opts = { vpk: 'tf/tf2_misc_dir.vpk', prefix: 'materials/' }
for (let i = 0; i < argv.length; i += 2) {
  const k = argv[i]?.replace(/^--/, '')
  if (!['tf2', 'hl2', 'vpk', 'prefix', 'out'].includes(k) || argv[i + 1] === undefined) {
    console.error('usage: vmt-survey.mjs --tf2 <dir> [--hl2 <dir>] [--vpk <label>] [--prefix materials/] [--out f.json]')
    process.exit(2)
  }
  opts[k] = argv[i + 1]
}
const located = locateTf2Vpks(opts.tf2, opts.hl2)
const set = openVpkSet(located.files, { labels: located.labels })
const vi = set.labels.indexOf(opts.vpk)
if (vi < 0) { console.error(`--vpk ${opts.vpk} is not one of ${set.labels.join(', ')}`); process.exit(2) }
const vpk = set.vpks[vi]

const t0 = performance.now()
const c = {
  vmts: 0, modelVmts: 0, exceptions: 0,
  conditional: 0, conditionalChangesBaseTexture: 0,
  dxBlocks: 0, dxBlocksApplied: 0, fallbackBlocks: 0, fallbackBlocksApplied: 0, prefixedKeys: 0, prefixedApplied: 0, platformConditions: 0,
  repeatedBaseTexture: 0, missingBaseTexture: 0, missingBaseTextureModel: 0, baseTextureNotInVpks: 0,
  patch: 0, patchResolved: 0,
  alphaTest: 0, translucent: 0, alphaTestModel: 0, translucentModel: 0, phongModel: 0, blendTintByBaseAlphaModel: 0,
}
const shaders = new Map()
const unknown = new Map()
const examples = {}
const example = (k, p) => { (examples[k] ??= []).length < 5 && examples[k].push(p) }
const errors = []

// The $basetexture a reader would get by taking the first occurrence and ignoring every condition.
function naiveBaseTexture(text) {
  const m = /"?\$basetexture"?\s+"?([^"\s}]+)"?/i.exec(text)
  return m ? vmtBaseTexture({ $basetexture: m[1] }) : null
}

for (const p of [...vpk.entries.keys()].sort()) {
  if (!p.endsWith('.vmt') || !p.startsWith(opts.prefix)) continue
  c.vmts++
  const model = p.startsWith('materials/models/')
  if (model) c.modelVmts++
  try {
    const data = vpk.read(p)
    const text = data.toString('latin1')
    const vmt = parseVmt(text)
    const cond = vmt.conditions
    shaders.set(vmt.shader, (shaders.get(vmt.shader) ?? 0) + 1)
    let params = vmt.params
    if (vmt.shader === 'patch') {
      c.patch++
      example('patch', p)
      const resolved = readMaterialFile(set, p)
      if (resolved?.patch?.resolved) c.patchResolved++
      params = resolved?.params ?? {}
    }
    const isConditional = cond.blocks.length || cond.fallbacks.length || cond.prefixed.length || cond.platform
    if (isConditional) {
      c.conditional++
      const resolvedTex = vmtBaseTexture(params)
      if (resolvedTex !== naiveBaseTexture(text)) { c.conditionalChangesBaseTexture++; example('conditionalChangesBaseTexture', p) }
    }
    c.dxBlocks += cond.blocks.length
    c.dxBlocksApplied += cond.blocks.filter(b => b.applied).length
    c.fallbackBlocks += cond.fallbacks.length
    c.fallbackBlocksApplied += cond.fallbacks.filter(b => b.applied).length
    c.prefixedKeys += cond.prefixed.length
    c.prefixedApplied += cond.prefixed.filter(b => b.applied).length
    c.platformConditions += cond.platform
    for (const u of cond.unknown) { unknown.set(u, (unknown.get(u) ?? 0) + 1); example(`unknown ${u}`, p) }
    // $basetexture as a key (at the start of a line), in any block, conditional or not.
    if ((text.match(/^[ \t]*"?\$basetexture"?[ \t]+\S/gim) ?? []).length > 1) { c.repeatedBaseTexture++; example('repeatedBaseTexture', p) }
    const tex = vmtBaseTexture(params)
    if (!tex && vmt.shader !== 'patch') {
      c.missingBaseTexture++
      if (model) c.missingBaseTextureModel++
      example('missingBaseTexture', p)
    }
    if (tex && !set.has(tex)) { c.baseTextureNotInVpks++; example('baseTextureNotInVpks', `${p} -> ${tex}`) }
    const a = vmtAlpha(params)
    if (a.alpha === 'test') { c.alphaTest++; if (model) c.alphaTestModel++ }
    if (a.alpha === 'blend') { c.translucent++; if (model) c.translucentModel++ }
    if (model && vmtTruthy(params.$phong)) c.phongModel++
    if (model && vmtTruthy(params.$blendtintbybasealpha)) c.blendTintByBaseAlphaModel++
  } catch (error) {
    c.exceptions++
    errors.push(`${p}: ${error.stack}`)
  }
}
const ms = Math.round(performance.now() - t0)
const result = {
  vpk: opts.vpk,
  prefix: opts.prefix,
  ms,
  counts: c,
  shaders: Object.fromEntries([...shaders].sort((a, b) => b[1] - a[1]).slice(0, 15)),
  unknownConditions: Object.fromEntries([...unknown].sort()),
  examples,
  errors: errors.slice(0, 20),
}
if (opts.out) fs.writeFileSync(opts.out, `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify({ vpk: result.vpk, ms, counts: c, shaders: result.shaders, unknownConditions: result.unknownConditions }, null, 1))
for (const e of errors.slice(0, 5)) console.error(e)
set.close()
process.exit(c.exceptions ? 1 : 0)
