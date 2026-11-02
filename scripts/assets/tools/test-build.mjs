#!/usr/bin/env node
// End-to-end test of build-pack.mjs. Every pack goes under --base (outside every git work tree and
// /tmp, e.g. /home/dalibor/tf2-pack-a0-test), which is deleted first and, without --keep, at the end.
//
//   node scripts/assets/tools/test-build.mjs --tf2 <dir> [--hl2 <dir>] --base <dir> [--keep] [--out f.json]
//
//   1. refusals (exit 2): --out in a git work tree, under /tmp, --tmp under /tmp, --maps
//      koth_product_final, an unknown option, a stage name, a non-pack directory
//   2. two builds without stages give a valid manifest and pass check-determinism
//   3. two builds with the fixture stages (tools/fixture-stages: real model exports through
//      lib/model-export.mjs, placeholder map entries) pass check-determinism
//   4. a rebuild of pack A skips every model (incremental) and leaves its manifest byte-identical
//   5. a planted stage failure exits 1 and leaves manifest.json and every listed file unchanged
//   6. --force rebuilds every model and still gives the same bytes

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { readManifest, verifyManifestFiles } from '../lib/manifest.mjs'
import { sha256File, walkFiles } from '../lib/fsutil.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ASSETS = path.resolve(HERE, '..')
const CHECKOUT = path.resolve(ASSETS, '..', '..')
const argv = process.argv.slice(2)
const opt = k => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined }
const tf2 = opt('tf2'), hl2 = opt('hl2'), base = opt('base')
if (!tf2 || !base) { console.error('usage: test-build.mjs --tf2 <dir> [--hl2 <dir>] --base <dir> [--keep] [--out f.json]'); process.exit(2) }
const absBase = path.resolve(base)
fs.rmSync(absBase, { recursive: true, force: true })
fs.mkdirSync(absBase, { recursive: true })

const vpkArgs = ['--tf2', tf2, ...(hl2 ? ['--hl2', hl2] : [])]
const results = []
function build(name, args) {
  const t0 = performance.now()
  const r = spawnSync(process.execPath, [path.join(ASSETS, 'build-pack.mjs'), ...args], { encoding: 'utf8', maxBuffer: 64 << 20 })
  const row = { name, status: r.status, seconds: +((performance.now() - t0) / 1000).toFixed(2), tail: (r.stdout + r.stderr).trim().split('\n').slice(-3) }
  results.push(row)
  console.log(`${String(r.status).padStart(3)}  ${row.seconds.toFixed(2).padStart(6)} s  ${name}`)
  return r
}
const determinism = (a, b) => spawnSync(process.execPath, [path.join(ASSETS, 'check-determinism.mjs'), a, b], { encoding: 'utf8' })
const fixture = ['--stage-dir', path.join(HERE, 'fixture-stages'), '--bsp-dir', opt('bsp-dir') ?? path.join(process.env.HOME, '.local/share/Steam/steamapps/common/Team Fortress 2/tf/maps')]
// reports/ holds build timings and is skipped, as check-determinism skips it.
const snapshot = dir => Object.fromEntries(walkFiles(dir, rel => rel.split('/').some(s => s.startsWith('.')) || rel === 'reports').map(f => [f, sha256File(path.join(dir, f))]))

// 1. refusals
const refusals = [
  ['out in a git work tree', [...vpkArgs, '--out', path.join(CHECKOUT, 'pack-test')]],
  ['out under /tmp', [...vpkArgs, '--out', '/tmp/pack-test']],
  ['tmp under /tmp', [...vpkArgs, '--out', path.join(absBase, 'r1'), '--tmp', '/tmp/pack-test-tmp']],
  ['koth_product_final', [...vpkArgs, '--out', path.join(absBase, 'r2'), '--maps', 'koth_product_final']],
  ['koth_product_final among others', [...vpkArgs, '--out', path.join(absBase, 'r2'), '--maps', 'pl_vigil_rc10,koth_product_final']],
  ['unknown map', [...vpkArgs, '--out', path.join(absBase, 'r2'), '--maps', 'cp_nowhere']],
  ['unknown option', [...vpkArgs, '--out', path.join(absBase, 'r3'), '--frobnicate']],
  ['unknown stage', [...vpkArgs, '--out', path.join(absBase, 'r4'), '--stages', 'maps,textures']],
  ['missing --tf2', ['--out', path.join(absBase, 'r5')]],
]
fs.mkdirSync(path.join(absBase, 'notapack'), { recursive: true })
fs.writeFileSync(path.join(absBase, 'notapack', 'precious.txt'), 'keep me\n')
refusals.push(['non-pack directory', [...vpkArgs, '--out', path.join(absBase, 'notapack')]])
for (const [name, args] of refusals) {
  const r = build(`refuse: ${name}`, args)
  assert.equal(r.status, 2, `${name}: exit ${r.status}\n${r.stderr}`)
}
assert.equal(fs.existsSync(path.join(CHECKOUT, 'pack-test')), false)
assert.equal(fs.readFileSync(path.join(absBase, 'notapack', 'precious.txt'), 'utf8'), 'keep me\n')
for (const r of ['r1', 'r2', 'r3', 'r4', 'r5']) assert.equal(fs.existsSync(path.join(absBase, r)), false, `${r} was created`)

// 2. no stages
const e1 = path.join(absBase, 'empty-a'), e2 = path.join(absBase, 'empty-b')
assert.equal(build('empty build A', [...vpkArgs, '--out', e1]).status, 0)
assert.equal(build('empty build B (--stages none)', [...vpkArgs, '--out', e2, '--stages', 'none']).status, 0)
for (const d of [e1, e2]) assert.deepEqual(readManifest(d).errors, [])
const d1 = determinism(e1, e2)
assert.equal(d1.status, 0, d1.stdout)
results.push({ name: 'determinism empty', status: d1.status, tail: d1.stdout.trim().split('\n').slice(-1) })

// 3. fixture stages, twice
const a = path.join(absBase, 'fixture-a'), b = path.join(absBase, 'fixture-b')
assert.equal(build('fixture build A', [...vpkArgs, ...fixture, '--out', a]).status, 0)
assert.equal(build('fixture build B (--tmp elsewhere)', [...vpkArgs, ...fixture, '--out', b, '--tmp', path.join(absBase, 'tmp-b')]).status, 0)
for (const d of [a, b]) {
  const m = readManifest(d)
  assert.deepEqual(m.errors, [])
  assert.deepEqual(verifyManifestFiles(d, m.manifest), [])
  assert.ok(Object.keys(m.manifest.items).length >= 6, 'items')
  assert.ok(Object.keys(m.manifest.maps).length >= 1, 'maps')
}
assert.equal(fs.existsSync(path.join(absBase, 'tmp-b', 'build')), false, 'tmp cleaned')
const d2 = determinism(a, b)
console.log(d2.stdout.trim().split('\n').slice(-1)[0])
results.push({ name: 'determinism fixture', status: d2.status, tail: d2.stdout.trim().split('\n') })
assert.equal(d2.status, 0, d2.stdout)

// 4. incremental rebuild
const before = snapshot(a)
const r4 = build('fixture rebuild A (incremental)', [...vpkArgs, ...fixture, '--out', a])
assert.equal(r4.status, 0)
assert.match(r4.stdout, /0 built, 6 unchanged/)
assert.deepEqual(snapshot(a), before)

// 5. planted failure
const r5 = build('fixture build A with a planted failure', [...vpkArgs, ...fixture, '--out', a, '--force', '--set', 'fixtureFail=true'])
assert.equal(r5.status, 1)
assert.match(r5.stderr, /build failed during stage models/)
assert.deepEqual(snapshot(a), before)
assert.equal(fs.existsSync(path.join(a, '.build.lock')), false, 'lock released')

// 6. --force
const r6 = build('fixture build A --force', [...vpkArgs, ...fixture, '--out', a, '--force'])
assert.equal(r6.status, 0)
assert.match(r6.stdout, /6 built, 0 unchanged/)
assert.deepEqual(snapshot(a), before)

if (opt('out')) fs.writeFileSync(opt('out'), `${JSON.stringify(results, null, 2)}\n`)
if (!argv.includes('--keep')) fs.rmSync(absBase, { recursive: true, force: true })
console.log('test-build: every check passed')
