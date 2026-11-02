#!/usr/bin/env node
// VPK command line over lib/vpk.mjs.
//
//   node scripts/assets/tools/vpk.mjs stats   --tf2 <dir> [--hl2 <dir>]
//   node scripts/assets/tools/vpk.mjs list    --tf2 <dir> [--hl2 <dir>] [prefix]
//   node scripts/assets/tools/vpk.mjs extract --tf2 <dir> [--hl2 <dir>] --out <dir> <path> ...
//   node scripts/assets/tools/vpk.mjs verify  --tf2 <dir> [--hl2 <dir>] [prefix] [--limit n]
//
// Instead of --tf2/--hl2, `--vpk <x_dir.vpk>` (repeatable) opens exactly those files in that order.
// `verify` reads every entry under the prefix and checks its CRC32; exit 1 on any mismatch.

import fs from 'node:fs'
import path from 'node:path'
import { openVpkSet, locateTf2Vpks, normalizeVpkPath } from '../lib/vpk.mjs'

const USAGE = 'usage: vpk.mjs stats|list|extract|verify (--tf2 <dir> [--hl2 <dir>] | --vpk <x_dir.vpk> ...) [--out <dir>] [--limit n] [args]'
const [cmd, ...rest] = process.argv.slice(2)
const opts = { vpk: [] }
const args = []
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]
  if (a.startsWith('--')) {
    const key = a.slice(2)
    const value = rest[i + 1]
    if (value === undefined || value.startsWith('--')) { console.error(`${a} needs a value\n${USAGE}`); process.exit(2) }
    i++
    if (key === 'vpk') opts.vpk.push(value)
    else if (['tf2', 'hl2', 'out', 'limit'].includes(key)) opts[key] = value
    else { console.error(`unknown option ${a}\n${USAGE}`); process.exit(2) }
  } else args.push(a)
}
if (!['stats', 'list', 'extract', 'verify'].includes(cmd)) { console.error(USAGE); process.exit(2) }

const t0 = performance.now()
const located = opts.vpk.length ? { files: opts.vpk, labels: undefined } : locateTf2Vpks(opts.tf2, opts.hl2)
const set = openVpkSet(located.files, { labels: located.labels })
const indexMs = performance.now() - t0

if (cmd === 'stats') {
  const fp = set.fingerprint()
  for (const row of set.stats()) {
    const rec = fp.vpks.find(r => r.file === row.file)
    console.log(`${row.file}  v${row.version}  entries ${row.entries}  archives ${row.archives}  treeCrc32 ${rec.treeCrc32}  archiveBytes ${rec.archiveBytes}`)
  }
  console.log(`indexMs ${indexMs.toFixed(0)}  fingerprint ${fp.fingerprint}`)
} else if (cmd === 'list') {
  for (const p of set.list(args[0] ?? '')) console.log(p, set.stat(p).size)
} else if (cmd === 'extract') {
  if (!opts.out) { console.error('extract needs --out'); process.exit(2) }
  let missing = 0
  for (const p of args) {
    const data = set.read(p)
    if (!data) { console.error(`missing ${p}`); missing++; continue }
    const target = path.join(opts.out, normalizeVpkPath(p))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, data)
    console.log(normalizeVpkPath(p), data.length)
  }
  if (missing) process.exitCode = 1
} else if (cmd === 'verify') {
  const limit = opts.limit ? Number(opts.limit) : Infinity
  let n = 0, bytes = 0, bad = 0
  const t1 = performance.now()
  for (const p of set.list(args[0] ?? '')) {
    if (n >= limit) break
    try { bytes += set.read(p).length } catch (error) { bad++; console.error(error.message) }
    n++
  }
  console.log(`verified ${n} entries, ${(bytes / 1e6).toFixed(1)} MB, ${bad} CRC failures, ${((performance.now() - t1) / 1000).toFixed(1)} s`)
  if (bad) process.exitCode = 1
}
set.close()
