#!/usr/bin/env node
// Compares two pack directories built from the same inputs (contract 2.4): the file lists and the
// sha256 of every file. Exit 0 when they are identical, 1 with the differing files, 2 on a usage error.
//
//   node scripts/assets/check-determinism.mjs <packA> <packB> [--include-reports] [--ignore-timing] [--json <out.json>]
//
// Skipped: dot entries at any level (`.tmp/`, `.build.lock`, `.<name>.partial`) and, unless
// --include-reports, `reports/` (build statistics with timings, never read at runtime). For a JSON
// file that differs, the differing JSON paths are listed; when every one of them ends in a timing key
// (`ms`, `*Ms`, `seconds`), the file is a timing-only difference, which --ignore-timing accepts.

import fs from 'node:fs'
import path from 'node:path'
import { sha256File, walkFiles } from './lib/fsutil.mjs'

const argv = process.argv.slice(2)
const flags = new Set()
const dirs = []
let jsonOut = null
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--include-reports' || a === '--ignore-timing') flags.add(a)
  else if (a === '--json') { jsonOut = argv[++i]; if (!jsonOut) { console.error('--json needs a file'); process.exit(2) } }
  else if (a.startsWith('--')) { console.error(`unknown option ${a}`); process.exit(2) }
  else dirs.push(a)
}
if (dirs.length !== 2) {
  console.error('usage: check-determinism.mjs <packA> <packB> [--include-reports] [--ignore-timing] [--json <out.json>]')
  process.exit(2)
}
for (const d of dirs) if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) { console.error(`${d} is not a directory`); process.exit(2) }
const [a, b] = dirs.map(d => path.resolve(d))
if (a === b) { console.error('the two packs are the same directory'); process.exit(2) }

const includeReports = flags.has('--include-reports')
const skip = rel => rel.split('/').some(seg => seg.startsWith('.')) || (!includeReports && (rel === 'reports' || rel.startsWith('reports/')))
const listA = walkFiles(a, skip)
const listB = walkFiles(b, skip)
const setA = new Set(listA), setB = new Set(listB)
const onlyA = listA.filter(f => !setB.has(f))
const onlyB = listB.filter(f => !setA.has(f))
const TIMING = /^(ms|.*Ms|seconds|elapsed.*)$/

function jsonDiff(x, y, at = '', out = []) {
  if (out.length > 50) return out
  if (typeof x !== typeof y || Array.isArray(x) !== Array.isArray(y) || (x === null) !== (y === null)) { out.push(at || '/'); return out }
  if (x && typeof x === 'object') {
    const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])]
    // Key order counts too: equal values in another order are different bytes.
    if (!Array.isArray(x) && Object.keys(x).join('\0') !== Object.keys(y).join('\0') && keys.every(k => k in x && k in y)) out.push(`${at || '/'} (key order)`)
    for (const k of keys) {
      if (!(k in x) || !(k in y)) out.push(`${at}/${k}`)
      else jsonDiff(x[k], y[k], `${at}/${k}`, out)
    }
    return out
  }
  if (x !== y) out.push(at || '/')
  return out
}

const differ = []
let timingOnly = 0
for (const rel of listA.filter(f => setB.has(f))) {
  const fa = path.join(a, rel), fb = path.join(b, rel)
  if (fs.statSync(fa).size === fs.statSync(fb).size && sha256File(fa) === sha256File(fb)) continue
  const row = { file: rel, bytes: [fs.statSync(fa).size, fs.statSync(fb).size], sha256: [sha256File(fa), sha256File(fb)] }
  if (rel.endsWith('.json')) {
    try {
      const paths = jsonDiff(JSON.parse(fs.readFileSync(fa, 'utf8')), JSON.parse(fs.readFileSync(fb, 'utf8')))
      row.jsonPaths = paths.slice(0, 20)
      row.timingOnly = paths.length > 0 && paths.every(p => TIMING.test(p.split('/').pop()))
      if (paths.length === 0) row.note = 'same JSON value, different bytes (formatting)'
    } catch (error) { row.note = `not JSON: ${error.message}` }
  }
  if (row.timingOnly) timingOnly++
  differ.push(row)
}

const failing = differ.filter(r => !(r.timingOnly && flags.has('--ignore-timing')))
const result = {
  packs: [a, b],
  files: [listA.length, listB.length],
  skipped: includeReports ? 'dot entries' : 'dot entries and reports/',
  onlyInA: onlyA,
  onlyInB: onlyB,
  differ,
  identical: onlyA.length === 0 && onlyB.length === 0 && differ.length === 0,
  pass: onlyA.length === 0 && onlyB.length === 0 && failing.length === 0,
}
if (jsonOut) fs.writeFileSync(jsonOut, `${JSON.stringify(result, null, 2)}\n`)
console.log(`A ${a}: ${listA.length} files`)
console.log(`B ${b}: ${listB.length} files (skipped: ${result.skipped})`)
for (const f of onlyA) console.log(`only in A  ${f}`)
for (const f of onlyB) console.log(`only in B  ${f}`)
for (const r of differ) {
  console.log(`differs    ${r.file}  ${r.bytes[0]} / ${r.bytes[1]} bytes${r.timingOnly ? '  (timing only)' : ''}${r.note ? `  (${r.note})` : ''}`)
  for (const p of r.jsonPaths ?? []) console.log(`             ${p}`)
}
console.log(result.identical ? 'identical' : result.pass ? `pass with --ignore-timing (${timingOnly} timing-only files)` : `FAIL: ${onlyA.length + onlyB.length} files on one side only, ${failing.length} files differ`)
process.exit(result.pass ? 0 : 1)
