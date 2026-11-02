// VPK v1 and v2 reader: directory index, split archives, data embedded in the _dir file, preload
// bytes and CRC32 checks. No dependencies beyond node:fs and node:zlib.
//
//   const vpk = openVpkSet(['/x/tf/tf2_textures_dir.vpk', '/x/tf/tf2_misc_dir.vpk'])
//   vpk.has('materials/models/buildables/sentry1/sentry1.vmt')
//   vpk.read('models/buildables/sentry1.mdl')       // Buffer, CRC checked
//   vpk.stat(path), vpk.list('materials/models/'), vpk.fingerprint()
//
// Paths are case-insensitive: they are lower-cased, backslashes become slashes and leading `./` or `/`
// are dropped. In a set, an earlier directory file wins over a later one (tf before hl2, as the engine
// mounts them).

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'

const SIGNATURE = 0x55aa1234
const EMBEDDED = 0x7fff
const TERMINATOR = 0xffff

/** Canonical VPK entry path: lower case, forward slashes, no leading `./` or `/`. */
export function normalizeVpkPath(p) {
  return String(p).replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '').replace(/\/{2,}/g, '/').toLowerCase()
}

export const crc32 = buf => zlib.crc32(buf) >>> 0
const hex8 = n => (n >>> 0).toString(16).padStart(8, '0')

/**
 * Opens one `_dir.vpk` and indexes its tree.
 * @returns {{ file, version, entries: Map<string, object>, treeCrc32, treeSize, read, stat, close, archives }}
 */
export function openVpk(dirFile) {
  dirFile = path.resolve(dirFile)
  const buf = fs.readFileSync(dirFile)
  if (buf.length < 12 || buf.readUInt32LE(0) !== SIGNATURE) throw new Error(`${dirFile}: not a VPK directory file`)
  const version = buf.readUInt32LE(4)
  if (version !== 1 && version !== 2) throw new Error(`${dirFile}: VPK version ${version} is not supported`)
  const treeSize = buf.readUInt32LE(8)
  const headerSize = version === 2 ? 28 : 12
  if (buf.length < headerSize + treeSize) throw new Error(`${dirFile}: tree runs past the end of the file`)
  const v2 = version === 2
    ? {
        fileDataSize: buf.readUInt32LE(12),
        archiveMd5Size: buf.readUInt32LE(16),
        otherMd5Size: buf.readUInt32LE(20),
        signatureSize: buf.readUInt32LE(24),
      }
    : null
  const treeEnd = headerSize + treeSize
  const dataStart = treeEnd // embedded (0x7fff) data follows the tree
  const entries = new Map()
  const archiveIndices = new Set()
  let o = headerSize
  const str = () => {
    const end = buf.indexOf(0, o)
    if (end < 0 || end >= treeEnd) throw new Error(`${dirFile}: unterminated string in the tree at ${o}`)
    const s = buf.latin1Slice(o, end)
    o = end + 1
    return s
  }
  let hasPreload = false
  for (;;) {
    const ext = str()
    if (!ext) break
    for (;;) {
      const dir = str()
      if (!dir) break
      for (;;) {
        const name = str()
        if (!name) break
        if (o + 18 > treeEnd) throw new Error(`${dirFile}: truncated entry ${dir}/${name}.${ext}`)
        const crc = buf.readUInt32LE(o)
        const preloadBytes = buf.readUInt16LE(o + 4)
        const archive = buf.readUInt16LE(o + 6)
        const offset = buf.readUInt32LE(o + 8)
        const length = buf.readUInt32LE(o + 12)
        const terminator = buf.readUInt16LE(o + 16)
        if (terminator !== TERMINATOR) throw new Error(`${dirFile}: bad entry terminator for ${dir}/${name}.${ext}`)
        o += 18
        const preloadOffset = o
        o += preloadBytes
        if (preloadBytes) hasPreload = true
        const full = normalizeVpkPath(`${dir === ' ' ? '' : `${dir}/`}${name === ' ' ? '' : name}${ext === ' ' ? '' : `.${ext}`}`)
        if (archive !== EMBEDDED) archiveIndices.add(archive)
        if (!entries.has(full)) entries.set(full, { crc, preloadBytes, preloadOffset, archive, offset, length })
      }
    }
  }
  const treeCrc32 = crc32(buf.subarray(headerSize, treeEnd))
  // Preload bytes live in the tree; keep the buffer only when some entry has them.
  const preloadBuf = hasPreload ? buf : null
  const base = dirFile.replace(/_dir\.vpk$/i, '')
  const archivePath = index => `${base}_${String(index).padStart(3, '0')}.vpk`
  const archives = [...archiveIndices].sort((a, b) => a - b).map(index => {
    const file = archivePath(index)
    let bytes = null
    try { bytes = fs.statSync(file).size } catch { bytes = null }
    return { index, file, bytes }
  })

  const fds = new Map()
  const fdOf = file => {
    let fd = fds.get(file)
    if (fd === undefined) {
      fd = fs.openSync(file, 'r')
      fds.set(file, fd)
    }
    return fd
  }
  const readEntry = (key, e, { verify = true } = {}) => {
    const out = Buffer.allocUnsafe(e.preloadBytes + e.length)
    if (e.preloadBytes) preloadBuf.copy(out, 0, e.preloadOffset, e.preloadOffset + e.preloadBytes)
    if (e.length) {
      const embedded = e.archive === EMBEDDED
      const file = embedded ? dirFile : archivePath(e.archive)
      const position = embedded ? dataStart + e.offset : e.offset
      const got = fs.readSync(fdOf(file), out, e.preloadBytes, e.length, position)
      if (got !== e.length) throw new Error(`${key}: short read from ${path.basename(file)} (${got} of ${e.length} bytes)`)
    }
    if (verify) {
      const actual = crc32(out)
      if (actual !== e.crc >>> 0) throw new Error(`${key}: CRC32 mismatch (${hex8(actual)}, directory says ${hex8(e.crc)})`)
    }
    return out
  }
  // The first `n` bytes of an entry (headers), without the CRC check.
  const readEntryHead = (key, e, n) => {
    const size = e.preloadBytes + e.length
    const want = Math.min(n, size)
    const out = Buffer.allocUnsafe(want)
    const fromPreload = Math.min(want, e.preloadBytes)
    if (fromPreload) preloadBuf.copy(out, 0, e.preloadOffset, e.preloadOffset + fromPreload)
    const rest = want - fromPreload
    if (rest > 0) {
      const embedded = e.archive === EMBEDDED
      const file = embedded ? dirFile : archivePath(e.archive)
      const got = fs.readSync(fdOf(file), out, fromPreload, rest, embedded ? dataStart + e.offset : e.offset)
      if (got !== rest) throw new Error(`${key}: short read from ${path.basename(file)}`)
    }
    return out
  }
  return {
    file: dirFile,
    version,
    treeSize,
    treeCrc32,
    v2,
    entries,
    archives,
    read(p, opts) {
      const key = normalizeVpkPath(p)
      const e = entries.get(key)
      return e ? readEntry(key, e, opts) : null
    },
    readEntry,
    readEntryHead,
    readHead(p, n) {
      const key = normalizeVpkPath(p)
      const e = entries.get(key)
      return e ? readEntryHead(key, e, n) : null
    },
    stat(p) {
      const key = normalizeVpkPath(p)
      const e = entries.get(key)
      return e ? entryStat(this, key, e) : null
    },
    close() {
      for (const fd of fds.values()) fs.closeSync(fd)
      fds.clear()
    },
  }
}

function entryStat(vpk, key, e) {
  return {
    path: key,
    vpk: vpk.file,
    size: e.preloadBytes + e.length,
    crc32: hex8(e.crc),
    archive: e.archive === EMBEDDED ? null : e.archive,
    offset: e.offset,
    preloadBytes: e.preloadBytes,
  }
}

/**
 * Fingerprint record of one directory file (contract 2.3): sizes, the tree CRC32, the archive
 * count and the total archive bytes, never mtimes. `label` is the file name as the manifest shows it,
 * e.g. `tf/tf2_misc_dir.vpk`.
 */
export function vpkFingerprintRecord(vpk, label) {
  const missing = vpk.archives.filter(a => a.bytes === null)
  if (missing.length) throw new Error(`${vpk.file}: missing archives ${missing.map(a => path.basename(a.file)).join(', ')}`)
  return {
    file: label,
    bytes: fs.statSync(vpk.file).size,
    treeCrc32: hex8(vpk.treeCrc32),
    archives: vpk.archives.length,
    archiveBytes: vpk.archives.reduce((sum, a) => sum + a.bytes, 0),
  }
}

/** JSON with object keys sorted at every level and no whitespace: the input of every hash. */
export function canonicalJson(value) {
  return JSON.stringify(sortKeysDeep(value))
}
export function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) if (value[key] !== undefined) out[key] = sortKeysDeep(value[key])
    return out
  }
  return value
}
export const sha256 = data => crypto.createHash('sha256').update(data).digest('hex')

/**
 * Opens several directory files as one search path. The first file that has a path wins.
 * @param {string[]} dirFiles
 * @param {{ labels?: string[] }} [opts] manifest labels, one per file (default: parent folder/file name)
 */
export function openVpkSet(dirFiles, opts = {}) {
  const vpks = dirFiles.map(f => openVpk(f))
  const labels = opts.labels ?? vpks.map(v => `${path.basename(path.dirname(v.file))}/${path.basename(v.file)}`)
  const find = p => {
    const key = normalizeVpkPath(p)
    for (const v of vpks) {
      const e = v.entries.get(key)
      if (e) return { v, key, e }
    }
    return null
  }
  let fingerprintCache = null
  return {
    vpks,
    labels,
    has: p => find(p) !== null,
    read(p, readOpts) {
      const hit = find(p)
      return hit ? hit.v.readEntry(hit.key, hit.e, readOpts) : null
    },
    /** The first `n` bytes (a header), without the CRC check. */
    readHead(p, n) {
      const hit = find(p)
      return hit ? hit.v.readEntryHead(hit.key, hit.e, n) : null
    },
    stat(p) {
      const hit = find(p)
      return hit ? entryStat(hit.v, hit.key, hit.e) : null
    },
    /** Sorted paths that start with `prefix` (already normalised), each once. */
    list(prefix = '') {
      const want = normalizeVpkPath(prefix)
      const seen = new Set()
      for (const v of vpks) for (const key of v.entries.keys()) if (key.startsWith(want)) seen.add(key)
      return [...seen].sort()
    },
    /** `{ vpks: [...records], fingerprint }`, the manifest's `builtFrom`. */
    fingerprint() {
      if (!fingerprintCache) {
        const records = vpks.map((v, i) => vpkFingerprintRecord(v, labels[i]))
        fingerprintCache = { vpks: records, fingerprint: sha256(canonicalJson(records)) }
      }
      return structuredClone(fingerprintCache)
    },
    stats() {
      return vpks.map((v, i) => ({ file: labels[i], version: v.version, entries: v.entries.size, archives: v.archives.length }))
    },
    close() {
      for (const v of vpks) v.close()
    },
  }
}

/** The VPK directory files the engine mounts for TF2 materials and models, in mount order. */
export const TF2_VPKS = [
  { root: 'tf', file: 'tf2_textures_dir.vpk' },
  { root: 'tf', file: 'tf2_misc_dir.vpk' },
  { root: 'hl2', file: 'hl2_textures_dir.vpk' },
  { root: 'hl2', file: 'hl2_misc_dir.vpk' },
]

/**
 * Finds the four directory files from `--tf2` and `--hl2`. `tf2` may be the `tf` folder itself or a
 * folder that holds `tf/` and `hl2/` (then `hl2` defaults to its `hl2/`).
 * @returns {{ files: string[], labels: string[] }}
 */
export function locateTf2Vpks(tf2, hl2) {
  if (!tf2) throw new Error('--tf2 is required')
  let tfDir = path.resolve(tf2)
  if (!fs.existsSync(path.join(tfDir, 'tf2_misc_dir.vpk')) && fs.existsSync(path.join(tfDir, 'tf', 'tf2_misc_dir.vpk'))) {
    if (!hl2 && fs.existsSync(path.join(tfDir, 'hl2'))) hl2 = path.join(tfDir, 'hl2')
    tfDir = path.join(tfDir, 'tf')
  }
  const hl2Dir = hl2 ? path.resolve(hl2) : null
  const files = [], labels = []
  for (const { root, file } of TF2_VPKS) {
    const dir = root === 'tf' ? tfDir : hl2Dir
    if (!dir) throw new Error(`--hl2 is required (looking for ${file})`)
    const full = path.join(dir, file)
    if (!fs.existsSync(full)) throw new Error(`missing ${full}`)
    files.push(full)
    labels.push(`${root}/${file}`)
  }
  return { files, labels }
}
