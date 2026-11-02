#!/usr/bin/env node
// Compares lib/vpk.mjs reads with a second, independent reader (the research tool `vpk.py extract`,
// python3 stdlib) byte for byte.
//
//   node scripts/assets/tools/check-vpk-read.mjs --tf2 <dir> [--hl2 <dir>] --reference <vpk.py> --tmp <dir> [--count 20]
//
// The sample is deterministic: per directory file, entries spread over its archives, plus every kind
// of special entry that exists (data embedded in the _dir file, preload bytes, empty files), up to
// --count in total. Exit 1 on any difference.

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { openVpkSet, locateTf2Vpks, sha256 } from '../lib/vpk.mjs'

const opts = { count: '20' }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 2) {
  const key = argv[i]?.replace(/^--/, '')
  if (!['tf2', 'hl2', 'reference', 'tmp', 'count'].includes(key) || argv[i + 1] === undefined) {
    console.error('usage: check-vpk-read.mjs --tf2 <dir> [--hl2 <dir>] --reference <vpk.py> --tmp <dir> [--count n]')
    process.exit(2)
  }
  opts[key] = argv[i + 1]
}
if (!opts.reference || !opts.tmp) { console.error('--reference and --tmp are required'); process.exit(2) }
const located = locateTf2Vpks(opts.tf2, opts.hl2)
const set = openVpkSet(located.files, { labels: located.labels })
const count = Number(opts.count)

const picks = [] // { vpkIndex, path, why }
const perVpk = Math.max(1, Math.floor(count / set.vpks.length))
set.vpks.forEach((v, vi) => {
  const keys = [...v.entries.keys()].sort()
  const special = []
  const embedded = keys.find(k => v.entries.get(k).archive === 0x7fff && v.entries.get(k).length > 0)
  if (embedded) special.push([embedded, 'embedded in _dir'])
  const preload = keys.find(k => v.entries.get(k).preloadBytes > 0)
  if (preload) special.push([preload, 'preload bytes'])
  // The highest archive index and the largest entry.
  const maxArchive = Math.max(...keys.map(k => (v.entries.get(k).archive === 0x7fff ? -1 : v.entries.get(k).archive)))
  const lastArchive = keys.find(k => v.entries.get(k).archive === maxArchive)
  if (lastArchive) special.push([lastArchive, `last archive ${maxArchive}`])
  const largest = keys.reduce((a, k) => (v.entries.get(k).length > v.entries.get(a).length ? k : a), keys[0])
  special.push([largest, 'largest entry'])
  const chosen = new Map(special)
  for (let i = 0; chosen.size < perVpk + special.length && i < perVpk * 4; i++) {
    const k = keys[Math.floor(((i + 0.5) / (perVpk * 4)) * keys.length)]
    // Only entries this file serves in the set (an earlier file could shadow it).
    if (set.stat(k).vpk === v.file && !chosen.has(k)) chosen.set(k, `spread, archive ${v.entries.get(k).archive}`)
  }
  for (const [k, why] of chosen) if (set.stat(k).vpk === v.file) picks.push({ vi, path: k, why })
})
const sample = picks.slice(0, Math.max(count, picks.length))

fs.mkdirSync(opts.tmp, { recursive: true })
let bad = 0
for (const [vi, v] of set.vpks.entries()) {
  const mine = sample.filter(p => p.vi === vi)
  if (!mine.length) continue
  const outDir = path.join(opts.tmp, `ref-${vi}`)
  fs.rmSync(outDir, { recursive: true, force: true })
  const r = spawnSync('python3', ['-I', opts.reference, v.file, 'extract', outDir, ...mine.map(p => p.path)], { encoding: 'utf8', maxBuffer: 64 << 20 })
  if (r.status !== 0) { console.error(r.stderr); process.exit(1) }
  for (const p of mine) {
    const ours = set.read(p.path)
    const theirs = fs.readFileSync(path.join(outDir, p.path))
    const same = ours.equals(theirs)
    if (!same) bad++
    const st = set.stat(p.path)
    console.log(`${same ? 'same' : 'DIFF'}  ${located.labels[vi]}  ${p.path}  ${ours.length} B  archive ${st.archive ?? 'dir'}  preload ${st.preloadBytes}  sha256 ${sha256(ours).slice(0, 12)}  (${p.why})`)
  }
  fs.rmSync(outDir, { recursive: true, force: true })
}
console.log(`${sample.length} files compared, ${bad} differ`)
set.close()
process.exit(bad ? 1 : 0)
