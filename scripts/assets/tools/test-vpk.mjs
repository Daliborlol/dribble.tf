#!/usr/bin/env node
// Self-test of lib/vpk.mjs on synthetic VPKs, since the TF2 install has only v2 files without
// preload bytes or embedded data. Writes v1 and v2 directory files with: data in two split
// archives, data embedded in the _dir file, preload-only and preload-plus-archive entries, an empty
// file, a file without extension and a root-level file. Then checks read(), stat(), list(),
// set precedence, the CRC check and the fingerprint, and, with --reference <vpk.py>, the reads of a
// second reader.
//
//   node scripts/assets/tools/test-vpk.mjs --tmp <dir> [--reference <vpk.py>]

import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { openVpk, openVpkSet, crc32 } from '../lib/vpk.mjs'

const argv = process.argv.slice(2)
const opt = k => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined }
const tmp = opt('tmp')
if (!tmp) { console.error('usage: test-vpk.mjs --tmp <dir> [--reference <vpk.py>]'); process.exit(2) }
const reference = opt('reference')
fs.rmSync(tmp, { recursive: true, force: true })
fs.mkdirSync(tmp, { recursive: true })

const bytes = (n, seed) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + seed * 7) & 255))
const FILES = [
  { p: 'materials/a/one.vmt', data: Buffer.from('"VertexLitGeneric" { "$basetexture" "a/one" }'), where: 0 },
  { p: 'materials/a/two.vtf', data: bytes(5000, 1), where: 1 },
  { p: 'materials/b/emb.txt', data: Buffer.from('embedded in the dir file'), where: 'dir' },
  { p: 'models/pre.mdl', data: bytes(40, 2), where: 'preload' },
  { p: 'models/split.vvd', data: bytes(300, 3), where: 0, preload: 16 },
  { p: 'models/empty.vtx', data: Buffer.alloc(0), where: 0 },
  { p: 'scripts/noext', data: Buffer.from('no extension'), where: 1 },
  { p: 'root.txt', data: Buffer.from('root level'), where: 'dir' },
]

function writeVpk(base, version, files, { corrupt } = {}) {
  const byExt = new Map()
  for (const f of files) {
    const dot = f.p.lastIndexOf('.')
    const slash = f.p.lastIndexOf('/')
    const ext = dot > slash ? f.p.slice(dot + 1) : ' '
    const dir = slash >= 0 ? f.p.slice(0, slash) : ' '
    const name = f.p.slice(slash + 1, dot > slash ? dot : undefined)
    if (!byExt.has(ext)) byExt.set(ext, new Map())
    const dirs = byExt.get(ext)
    if (!dirs.has(dir)) dirs.set(dir, [])
    dirs.get(dir).push({ ...f, name })
  }
  const archives = [[], []]
  const archiveLen = [0, 0]
  const embedded = []
  let embeddedLen = 0
  const tree = []
  const cstr = s => Buffer.from(`${s}\0`, 'latin1')
  for (const [ext, dirs] of byExt) {
    tree.push(cstr(ext))
    for (const [dir, list] of dirs) {
      tree.push(cstr(dir))
      for (const f of list) {
        tree.push(cstr(f.name))
        const preloadBytes = f.where === 'preload' ? f.data.length : (f.preload ?? 0)
        const pre = f.data.subarray(0, preloadBytes)
        const rest = f.data.subarray(preloadBytes)
        let archive = 0x7fff, offset = 0
        if (rest.length && f.where === 'dir') { offset = embeddedLen; embedded.push(rest); embeddedLen += rest.length }
        else if (rest.length && typeof f.where === 'number') { archive = f.where; offset = archiveLen[archive]; archives[archive].push(rest); archiveLen[archive] += rest.length }
        else if (typeof f.where === 'number') archive = f.where
        const head = Buffer.alloc(18)
        const crc = crc32(f.data)
        head.writeUInt32LE(corrupt === f.p ? (crc ^ 1) >>> 0 : crc, 0)
        head.writeUInt16LE(preloadBytes, 4)
        head.writeUInt16LE(archive, 6)
        head.writeUInt32LE(offset, 8)
        head.writeUInt32LE(rest.length, 12)
        head.writeUInt16LE(0xffff, 16)
        tree.push(head, pre)
      }
      tree.push(cstr(''))
    }
    tree.push(cstr(''))
  }
  tree.push(cstr(''))
  const treeBuf = Buffer.concat(tree)
  const header = Buffer.alloc(version === 2 ? 28 : 12)
  header.writeUInt32LE(0x55aa1234, 0)
  header.writeUInt32LE(version, 4)
  header.writeUInt32LE(treeBuf.length, 8)
  if (version === 2) header.writeUInt32LE(embeddedLen, 12)
  fs.writeFileSync(`${base}_dir.vpk`, Buffer.concat([header, treeBuf, ...embedded]))
  archives.forEach((parts, i) => fs.writeFileSync(`${base}_${String(i).padStart(3, '0')}.vpk`, Buffer.concat(parts)))
  return `${base}_dir.vpk`
}

let checks = 0
for (const version of [1, 2]) {
  const dirFile = writeVpk(path.join(tmp, `v${version}`), version, FILES)
  const v = openVpk(dirFile)
  assert.equal(v.version, version)
  assert.equal(v.entries.size, FILES.length)
  for (const f of FILES) {
    assert.ok(v.read(f.p).equals(f.data), `v${version} ${f.p}`)
    assert.ok(v.read(f.p.toUpperCase().replace(/\//g, '\\')).equals(f.data), `v${version} case/backslash ${f.p}`)
    checks += 2
  }
  assert.equal(v.read('materials/missing.vmt'), null)
  assert.equal(v.stat('models/pre.mdl').preloadBytes, 40)
  assert.equal(v.stat('materials/b/emb.txt').archive, null)
  assert.equal(v.archives.length, 2)
  v.close()
  if (reference) {
    const out = path.join(tmp, `ref-v${version}`)
    // vpk.py names extension-less files differently; compare the others.
    const list = FILES.filter(f => f.p.includes('.')).map(f => f.p)
    const r = spawnSync('python3', ['-I', reference, dirFile, 'extract', out, ...list], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    for (const f of FILES.filter(f => f.p.includes('.'))) { assert.ok(fs.readFileSync(path.join(out, f.p)).equals(f.data), `reference v${version} ${f.p}`); checks++ }
  }
  // CRC mismatch is detected and named.
  const bad = writeVpk(path.join(tmp, `bad${version}`), version, FILES, { corrupt: 'materials/a/two.vtf' })
  const vb = openVpk(bad)
  assert.throws(() => vb.read('materials/a/two.vtf'), /CRC32 mismatch/)
  assert.ok(vb.read('materials/a/two.vtf', { verify: false }).equals(FILES[1].data))
  vb.close()
  checks += 2
}

// Set precedence: the first file wins, list() is sorted and unique, the fingerprint is stable.
const first = writeVpk(path.join(tmp, 'first'), 2, [{ p: 'materials/a/one.vmt', data: Buffer.from('first'), where: 0 }, { p: 'materials/z.vmt', data: Buffer.from('z'), where: 0 }])
const second = writeVpk(path.join(tmp, 'second'), 1, FILES)
const set = openVpkSet([first, second], { labels: ['x/first_dir.vpk', 'x/second_dir.vpk'] })
assert.equal(set.read('materials/a/one.vmt').toString(), 'first')
assert.ok(set.read('materials/a/two.vtf').equals(FILES[1].data))
assert.deepEqual(set.list('materials/a/'), ['materials/a/one.vmt', 'materials/a/two.vtf'])
const fp1 = set.fingerprint(), fp2 = set.fingerprint()
assert.deepEqual(fp1, fp2)
assert.equal(fp1.vpks.length, 2)
assert.match(fp1.fingerprint, /^[0-9a-f]{64}$/)
assert.match(fp1.vpks[0].treeCrc32, /^[0-9a-f]{8}$/)
set.close()
// mtime does not change the fingerprint.
fs.utimesSync(first, new Date(0), new Date(0))
const set2 = openVpkSet([first, second], { labels: ['x/first_dir.vpk', 'x/second_dir.vpk'] })
assert.equal(set2.fingerprint().fingerprint, fp1.fingerprint)
set2.close()
checks += 8

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`test-vpk: ${checks} checks passed (v1 and v2, split archives, embedded data, preload, CRC)`)
