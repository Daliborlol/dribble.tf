// manifest.json v1 (contract 2.3): create, read, validate, merge, serialise in canonical key order,
// and write atomically. No timestamps and no absolute paths, so equal inputs give equal bytes.

import fs from 'node:fs'
import path from 'node:path'
import { canonicalJson, sha256, sortKeysDeep } from './vpk.mjs'
import { writeFileAtomic, sha256File } from './fsutil.mjs'

export const MANIFEST_FORMAT = 'dribble-asset-pack'
export const MANIFEST_VERSION = 1
export const MANIFEST_FILE = 'manifest.json'
export const ITEM_KINDS = ['model', 'texture']

const TOP_ORDER = ['format', 'version', 'generator', 'builtFrom', 'options', 'maps', 'items']
const GENERATOR_ORDER = ['version', 'commit']
const BUILT_FROM_ORDER = ['vpks', 'fingerprint']
const VPK_ORDER = ['file', 'bytes', 'treeCrc32', 'archives', 'archiveBytes']
const MAP_ORDER = ['mapName', 'bspSha256', 'bspBytes', 'publicProps', 'files', 'sizes', 'stats']
const ITEM_ORDER = ['kind', 'file', 'bytes', 'sha256']

/** The given keys first in `order`, then every other key sorted; values via `inner`. */
function ordered(obj, order, inner = v => v) {
  const out = {}
  for (const k of order) if (obj[k] !== undefined) out[k] = inner(obj[k], k)
  for (const k of Object.keys(obj).filter(k => !order.includes(k)).sort()) if (obj[k] !== undefined) out[k] = sortKeysDeep(obj[k])
  return out
}
const sortedMap = (obj, each) => {
  const out = {}
  for (const k of Object.keys(obj ?? {}).sort()) out[k] = each(obj[k], k)
  return out
}

/** The manifest with the canonical key order of contract 2.3 (nested free-form objects sorted). */
export function canonicalManifest(m) {
  return ordered(m, TOP_ORDER, (v, k) => {
    switch (k) {
      case 'generator': return ordered(v, GENERATOR_ORDER)
      case 'builtFrom': return ordered(v, BUILT_FROM_ORDER, (x, kk) => (kk === 'vpks' ? x.map(r => ordered(r, VPK_ORDER)) : x))
      case 'options': return sortKeysDeep(v)
      case 'maps': return sortedMap(v, entry => ordered(entry, MAP_ORDER, x => sortKeysDeep(x)))
      case 'items': return sortedMap(v, item => ordered(item, ITEM_ORDER))
      default: return v
    }
  })
}

export function serializeManifest(m) {
  return `${JSON.stringify(canonicalManifest(m), null, 2)}\n`
}

/** A new, empty v1 manifest. */
export function createManifest({ generatorVersion, commit = null, builtFrom, options = {} }) {
  return {
    format: MANIFEST_FORMAT,
    version: MANIFEST_VERSION,
    generator: { version: generatorVersion, commit },
    builtFrom: structuredClone(builtFrom),
    options: structuredClone(options),
    maps: {},
    items: {},
  }
}

const HEX64 = /^[0-9a-f]{64}$/
const HEX8 = /^[0-9a-f]{8}$/
const isInt = v => Number.isInteger(v) && v >= 0
/** A pack-relative path: forward slashes, no leading slash, no `.` or `..` segment, no drive. */
export function isPackPath(p) {
  return typeof p === 'string' && p.length > 0 && !p.startsWith('/') && !p.includes('\\') && !/^[a-z]:/i.test(p) &&
    p.split('/').every(seg => seg && seg !== '.' && seg !== '..')
}
const looksAbsolute = s => typeof s === 'string' && (/^\/(home|tmp|usr|var|mnt|media|root|opt|etc|srv)\b/.test(s) || /^[a-z]:[\\/]/i.test(s))

/** Errors of a manifest object (empty when valid). Checks shapes, the fingerprint and paths. */
export function validateManifest(m) {
  const errors = []
  const err = msg => errors.push(msg)
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['manifest is not an object']
  if (m.format !== MANIFEST_FORMAT) err(`format is ${JSON.stringify(m.format)}, not "${MANIFEST_FORMAT}"`)
  if (m.version !== MANIFEST_VERSION) err(`version is ${JSON.stringify(m.version)}, not ${MANIFEST_VERSION}`)
  if (!m.generator || typeof m.generator.version !== 'string') err('generator.version is not a string')
  else if (!(m.generator.commit === null || /^[0-9a-f]{40}$/.test(m.generator.commit))) err('generator.commit is neither null nor a git sha')
  const bf = m.builtFrom
  if (!bf || !Array.isArray(bf.vpks)) err('builtFrom.vpks is not an array')
  else {
    bf.vpks.forEach((r, i) => {
      if (typeof r.file !== 'string' || !isPackPath(r.file)) err(`builtFrom.vpks[${i}].file is not a relative name`)
      if (!isInt(r.bytes)) err(`builtFrom.vpks[${i}].bytes is not a byte count`)
      if (!HEX8.test(r.treeCrc32 ?? '')) err(`builtFrom.vpks[${i}].treeCrc32 is not 8 hex digits`)
      if (!isInt(r.archives)) err(`builtFrom.vpks[${i}].archives is not a count`)
      if (!isInt(r.archiveBytes)) err(`builtFrom.vpks[${i}].archiveBytes is not a byte count`)
    })
    if (!HEX64.test(bf.fingerprint ?? '')) err('builtFrom.fingerprint is not a sha256')
    else if (bf.fingerprint !== sha256(canonicalJson(bf.vpks))) err('builtFrom.fingerprint does not match builtFrom.vpks')
  }
  if (!m.options || typeof m.options !== 'object' || Array.isArray(m.options)) err('options is not an object')
  if (!m.maps || typeof m.maps !== 'object' || Array.isArray(m.maps)) err('maps is not an object')
  else {
    for (const [folder, e] of Object.entries(m.maps)) {
      const at = `maps.${folder}`
      if (!/^[a-z0-9_.-]+$/i.test(folder)) err(`${at}: folder name has odd characters`)
      if (typeof e.mapName !== 'string') err(`${at}.mapName is not a string`)
      if (e.bspSha256 !== undefined && !HEX64.test(e.bspSha256)) err(`${at}.bspSha256 is not a sha256`)
      if (e.bspBytes !== undefined && !isInt(e.bspBytes)) err(`${at}.bspBytes is not a byte count`)
      if (e.publicProps !== undefined && (typeof e.publicProps !== 'object' || e.publicProps === null)) err(`${at}.publicProps is not an object`)
      if (!e.files || typeof e.files !== 'object') err(`${at}.files is not an object`)
      else for (const [k, f] of Object.entries(e.files)) {
        if (!isPackPath(f)) err(`${at}.files.${k} is not a pack path`)
        else if (!f.startsWith(`maps/${folder}/`)) err(`${at}.files.${k} is outside maps/${folder}/`)
        if (e.sizes && e.sizes[k] !== undefined && !isInt(e.sizes[k])) err(`${at}.sizes.${k} is not a byte count`)
      }
    }
  }
  if (!m.items || typeof m.items !== 'object' || Array.isArray(m.items)) err('items is not an object')
  else {
    for (const [key, it] of Object.entries(m.items)) {
      const at = `items[${JSON.stringify(key)}]`
      if (key !== key.toLowerCase() || key.includes('\\') || key.startsWith('/')) err(`${at}: source path is not lower case with forward slashes`)
      if (!ITEM_KINDS.includes(it.kind)) err(`${at}.kind is ${JSON.stringify(it.kind)}`)
      if (!isPackPath(it.file)) err(`${at}.file is not a pack path`)
      if (!isInt(it.bytes)) err(`${at}.bytes is not a byte count`)
      if (!HEX64.test(it.sha256 ?? '')) err(`${at}.sha256 is not a sha256`)
    }
  }
  // No absolute paths anywhere (contract 2.3).
  const walk = (v, at) => {
    if (typeof v === 'string') { if (looksAbsolute(v)) err(`${at} holds an absolute path`) }
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`))
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`)
  }
  walk(m, 'manifest')
  return errors
}

/** Every pack file the manifest lists: [{ path, bytes?, sha256?, from }]. */
export function listedFiles(m) {
  const out = []
  for (const [folder, e] of Object.entries(m.maps ?? {})) {
    for (const [k, f] of Object.entries(e.files ?? {})) out.push({ path: f, bytes: e.sizes?.[k], from: `maps.${folder}.files.${k}` })
  }
  for (const [key, it] of Object.entries(m.items ?? {})) out.push({ path: it.file, bytes: it.bytes, sha256: it.sha256, from: `items[${key}]` })
  return out
}

/**
 * Checks that every listed file exists under `dir` with the recorded size (and sha256 for items).
 * `resolve(rel)` maps a pack path to the file to check instead (the builder passes the overlay of
 * staged files over the pack, before anything is moved).
 * @returns {string[]} problems
 */
export function verifyManifestFiles(dir, m, { hash = true, resolve = null } = {}) {
  const problems = []
  for (const f of listedFiles(m)) {
    if (!isPackPath(f.path)) { problems.push(`${f.from}: ${JSON.stringify(f.path)} is not a pack path`); continue }
    const abs = resolve ? resolve(f.path) : path.join(dir, f.path)
    let st
    try { st = fs.statSync(abs) } catch { problems.push(`${f.from}: ${f.path} is missing`); continue }
    if (!st.isFile()) { problems.push(`${f.from}: ${f.path} is not a file`); continue }
    if (f.bytes !== undefined && st.size !== f.bytes) problems.push(`${f.from}: ${f.path} has ${st.size} bytes, the manifest says ${f.bytes}`)
    if (hash && f.sha256 && sha256File(abs) !== f.sha256) problems.push(`${f.from}: ${f.path} sha256 differs from the manifest`)
  }
  return problems
}

/**
 * Reads `<dir>/manifest.json`. Returns { manifest, errors }: manifest null when absent or not JSON.
 */
export function readManifest(dir) {
  const file = path.join(dir, MANIFEST_FILE)
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch (error) {
    return { manifest: null, errors: error.code === 'ENOENT' ? [] : [error.message], absent: error.code === 'ENOENT' }
  }
  let manifest
  try { manifest = JSON.parse(text) } catch (error) { return { manifest: null, errors: [`not JSON: ${error.message}`], absent: false } }
  return { manifest, errors: validateManifest(manifest), absent: false }
}

/**
 * Merges `patch` into `base` and returns a new manifest: maps and items by key (a null value
 * removes the key), options by top-level key; format, version, generator and builtFrom come from
 * `patch` when given.
 */
export function mergeManifest(base, patch) {
  const out = structuredClone(base)
  for (const k of ['format', 'version', 'generator', 'builtFrom']) if (patch[k] !== undefined) out[k] = structuredClone(patch[k])
  for (const k of ['options', 'maps', 'items']) {
    out[k] ??= {}
    for (const [key, v] of Object.entries(patch[k] ?? {})) {
      if (v === null) delete out[k][key]
      else out[k][key] = structuredClone(v)
    }
  }
  return out
}

/** Validates and writes `<dir>/manifest.json` atomically. Throws on an invalid manifest. */
export function writeManifest(dir, m) {
  const errors = validateManifest(m)
  if (errors.length) throw new Error(`refusing to write an invalid manifest:\n  ${errors.join('\n  ')}`)
  const text = serializeManifest(m)
  writeFileAtomic(path.join(dir, MANIFEST_FILE), text)
  return text
}
