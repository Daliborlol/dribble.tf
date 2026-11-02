#!/usr/bin/env node
// Parses the header of every VTF in the VPK set with lib/vtf.mjs and checks the computed mip-chain
// layout against the file size: the high-res chain must end exactly at the end of the file (7.0 to
// 7.2) or at or before it (7.3+, where resources may follow). Reads only the first 512 bytes of each
// file. Exit 1 on any header that throws or any layout that runs past the file.
//
//   node scripts/assets/tools/vtf-survey.mjs --tf2 <dir> [--hl2 <dir>] [--prefix materials/] [--out f.json]

import fs from 'node:fs'
import { openVpkSet, locateTf2Vpks } from '../lib/vpk.mjs'
import { parseVtfHeader, vtfReflectivity } from '../lib/vtf.mjs'

const argv = process.argv.slice(2)
const opts = { prefix: 'materials/' }
for (let i = 0; i < argv.length; i += 2) {
  const k = argv[i]?.replace(/^--/, '')
  if (!['tf2', 'hl2', 'prefix', 'out'].includes(k) || argv[i + 1] === undefined) {
    console.error('usage: vtf-survey.mjs --tf2 <dir> [--hl2 <dir>] [--prefix materials/] [--out f.json]')
    process.exit(2)
  }
  opts[k] = argv[i + 1]
}
const located = locateTf2Vpks(opts.tf2, opts.hl2)
const set = openVpkSet(located.files, { labels: located.labels })
const t0 = performance.now()
const c = { vtfs: 0, exceptions: 0, exactEnd: 0, endsBefore: 0, overruns: 0, noReflectivity: 0, animated: 0, envmaps: 0, volume: 0, oneBitAlpha: 0, srgbFlag: 0, noMips: 0 }
const versions = new Map(), formats = new Map()
const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1)
const examples = {}
const example = (k, v) => { (examples[k] ??= []).length < 5 && examples[k].push(v) }
for (const p of set.list(opts.prefix)) {
  if (!p.endsWith('.vtf')) continue
  c.vtfs++
  try {
    const head = set.readHead(p, 512)
    const h = parseVtfHeader(head)
    const size = set.stat(p).size
    bump(versions, h.version.join('.'))
    bump(formats, h.formatName)
    const end = h.highResOffset + h.highResBytes
    if (end === size) c.exactEnd++
    else if (end < size && h.version[1] >= 3) { c.endsBefore++; example('endsBefore', `${p} ${end}/${size}`) }
    else { c.overruns++; example('overruns', `${p} v${h.version.join('.')} ${h.formatName} ${h.width}x${h.height} mips ${h.mips} frames ${h.frames} faces ${h.faces} end ${end} size ${size}`) }
    if (!vtfReflectivity(head)) c.noReflectivity++
    if (h.frames > 1) c.animated++
    if (h.faces > 1) c.envmaps++
    if (h.depth > 1) c.volume++
    if (h.oneBitAlpha) c.oneBitAlpha++
    if (h.srgbFlag) c.srgbFlag++
    if (h.mips <= 1) c.noMips++
  } catch (error) {
    c.exceptions++
    example('exceptions', `${p}: ${error.message}`)
  }
}
const result = {
  ms: Math.round(performance.now() - t0),
  counts: c,
  versions: Object.fromEntries([...versions].sort()),
  formats: Object.fromEntries([...formats].sort((a, b) => b[1] - a[1])),
  examples,
}
if (opts.out) fs.writeFileSync(opts.out, `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify(result, null, 1))
set.close()
process.exit(c.exceptions || c.overruns ? 1 : 0)
