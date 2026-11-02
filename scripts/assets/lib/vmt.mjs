// VMT (KeyValues material) parser and resolver, following contract 2.6 for the PC DirectX 9 path.
//
//   parseVmt(text)                      -> { shader, params, conditions }
//   resolveMaterial(source, name, dirs) -> { file, shader, params } | null
//   vmtBaseTexture(params), vmtAlpha(params), vmtTruthy(value), NEUTRAL
//
// Rules:
// - Keys are case-insensitive (lower-cased). Inside one block the last occurrence of a key wins.
// - Conditional blocks follow the PC DirectX 9 path at DX level 95 with HDR and sRGB on:
//   `>=dx90`, `>dx90_20b`, `>=dx90_20b` apply; `<dx90`, `<dx90_20b` do not (any `<op>dxNN[_20b]`).
//   Key prefixes `srgb?`, `!360?`, `!ps3?`, `!lowfill?`, `hdr?` and `GPU>=n?` apply; `360?`, `ps3?`,
//   `!srgb?`, `lowfill?`, `ldr?` and `GPU<n?` do not. Unknown conditions do not apply and are
//   reported in `conditions.unknown`.
// - Shader fallback blocks (`<name>_dx<N>`, `<name>_hdr_dx9`, `<name>_nohdr`, ...) apply when they
//   are named after the material's own shader and are the DX9 HDR path
//   (`<shader>_dx9`, `<shader>_dx90`, `<shader>_hdr_dx9`), as the material system merges the block
//   of the fallback shader it picks. `_dx6`, `_dx60`, `_dx7`, `_dx8`, `_dx80`, `_dx81` and `_nohdr`
//   blocks do not apply, and neither do blocks named after another shader. None of these blocks is
//   kept as a nested param.
// - A key in an applying block (or with an applying prefix) overrides the same key outside it,
//   whatever the order; applying blocks are merged in file order.
// - `[$X360]`-style conditions after a key/value pair are evaluated for Windows PC ($WIN32,
//   $WINDOWS true; $X360, $PS3, $GAMECONSOLE, $OSX, $LINUX, $POSIX false). Unquoted bracket
//   tokens that are not conditions (`[.25 .5 1]`) are values.
// - `patch` materials read `include` from the same source and apply `replace` (existing keys only)
//   then `insert` (add or overwrite). A patch of a patch is followed up to 8 levels.
// - Alpha is opacity only with `$alphatest` (cutoff `$alphatestreference`, default 0.5) or
//   `$translucent`; otherwise the base alpha is a phong, tint or blend mask and is ignored.
// - Without `$basetexture` a material draws NEUTRAL (#8a8a8a), as scripts/lib/static-props.mjs does.

export const NEUTRAL = '#8a8a8a'
const srgbToLinear = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
export const NEUTRAL_LINEAR = srgbToLinear(0x8a / 255)
export const DEFAULT_ALPHA_TEST_REFERENCE = 0.5

const DX_LEVEL = 95 // PC DirectX 9 with shader model 3
const GPU_LEVEL = 3
const PLATFORM = { $win32: true, $windows: true, $x360: false, $ps3: false, $gameconsole: false, $osx: false, $linux: false, $posix: false }
const FLAGS = { srgb: true, hdr: true, ldr: false, 360: false, ps3: false, gameconsole: false, lowfill: false }

// ─── tokenizer ───────────────────────────────────────────────────────────────

function tokenize(text) {
  const tokens = []
  const n = text.length
  for (let i = 0; i < n; ) {
    const c = text[i]
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++
    } else if (c === '{' || c === '}') {
      tokens.push({ t: c })
      i++
    } else if (c === '"') {
      let j = i + 1
      while (j < n && text[j] !== '"' && text[j] !== '\n') j++
      tokens.push({ t: 's', s: text.slice(i + 1, j), quoted: true })
      i = j < n && text[j] === '"' ? j + 1 : j
    } else if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\v' || c === '﻿') {
      i++
    } else if (c === '[') {
      let j = i + 1
      while (j < n && text[j] !== ']' && text[j] !== '\n') j++
      const s = text.slice(i, j < n && text[j] === ']' ? j + 1 : j)
      tokens.push({ t: 's', s, bracket: true })
      i = j < n && text[j] === ']' ? j + 1 : j
    } else {
      let j = i
      while (j < n && !/[\s{}"]/.test(text[j])) j++
      tokens.push({ t: 's', s: text.slice(i, j) })
      i = j
    }
  }
  return tokens
}

const isPlatformCondition = tok => tok && tok.t === 's' && tok.bracket && /^\[\s*!?\$/.test(tok.s)

/** `[$WIN32]`, `[!$X360]`, `[$WIN32 && !$X360]`, `[$X360 || $PS3]` for Windows PC. */
function platformApplies(expr, unknown) {
  const body = expr.replace(/^\[|\]$/g, '').trim()
  const term = t => {
    t = t.trim()
    const neg = t.startsWith('!')
    const name = t.replace(/^!/, '').trim().toLowerCase()
    let v = PLATFORM[name]
    if (v === undefined) { unknown.add(`[${name}]`); v = false }
    return neg ? !v : v
  }
  return body.split('||').some(or => or.split('&&').every(term))
}

// Raw tree: { entries: [{ key, value? , children?, cond? }] }
function parseTree(tokens) {
  let p = 0
  const block = () => {
    const entries = []
    while (p < tokens.length && tokens[p].t !== '}') {
      const keyTok = tokens[p++]
      if (keyTok.t !== 's') continue // stray '{'
      let cond = null
      if (isPlatformCondition(tokens[p])) cond = tokens[p++].s
      const next = tokens[p]
      if (next && next.t === '{') {
        p++
        const children = block()
        if (tokens[p]?.t === '}') p++
        if (!cond && isPlatformCondition(tokens[p])) cond = tokens[p++].s
        entries.push({ key: keyTok.s, children, cond })
      } else if (next && next.t === 's') {
        p++
        if (!cond && isPlatformCondition(tokens[p])) cond = tokens[p++].s
        entries.push({ key: keyTok.s, value: next.s, cond })
      } else {
        // key at the end of a block without a value: ignored
      }
    }
    return entries
  }
  // Root: "<shader>" { ... }. Anything before the shader name that is not a string is skipped.
  while (p < tokens.length && tokens[p].t !== 's') p++
  const shader = tokens[p] ? tokens[p++].s : ''
  if (isPlatformCondition(tokens[p])) p++
  while (p < tokens.length && tokens[p].t !== '{') p++
  p++
  const entries = block()
  return { shader, entries }
}

// ─── conditions ──────────────────────────────────────────────────────────────

const DX_RE = /^(<=|>=|<|>|==|=)?dx(\d+)(?:_(\d+)b?)?$/

function dxLevel(major, minor) {
  // dx90_20b sits between dx90 and dx95: shader model 2.0b.
  const base = Number(major)
  return minor ? base + 0.5 : base
}

/** Block names like `>=dx90` or `<dx90_20b`: true/false, or null when the name is not a DX condition. */
export function dxConditionApplies(name) {
  const m = DX_RE.exec(name.toLowerCase())
  if (!m || !m[1]) return null
  const level = dxLevel(m[2], m[3])
  switch (m[1]) {
    case '<': return DX_LEVEL < level
    case '<=': return DX_LEVEL <= level
    case '>': return DX_LEVEL > level
    case '>=': return DX_LEVEL >= level
    default: return DX_LEVEL === level
  }
}

/** Key prefix condition (`srgb`, `!360`, `gpu>=2`, `>=dx90`): true/false; unknown names are false. */
export function prefixConditionApplies(cond, unknown) {
  let c = cond.toLowerCase().trim()
  const neg = c.startsWith('!')
  if (neg) c = c.slice(1)
  let v
  const gpu = /^gpu(<=|>=|<|>|==|=)(\d+)$/.exec(c)
  if (gpu) {
    const n = Number(gpu[2])
    v = { '<': GPU_LEVEL < n, '<=': GPU_LEVEL <= n, '>': GPU_LEVEL > n, '>=': GPU_LEVEL >= n }[gpu[1]] ?? GPU_LEVEL === n
  } else if (c in FLAGS) {
    v = FLAGS[c]
  } else {
    const dx = dxConditionApplies(c)
    if (dx !== null) v = dx
    else { unknown?.add(`${c}?`); v = false }
  }
  return neg ? !v : v
}

/** Shader fallback block (`VertexLitGeneric_DX9`): true/false, or null when not one. */
export function fallbackBlockApplies(name, shader) {
  const n = name.toLowerCase()
  const m = /^([a-z0-9]+?)_((?:[a-z0-9]+_)?(?:dx\d+|nohdr))$/.exec(n)
  if (!m) return null
  // A fallback block of another shader (`UnlitGeneric_DX6` in a Cable material) never applies.
  if (m[1] !== shader.toLowerCase()) return false
  return m[2] === 'dx9' || m[2] === 'dx90' || m[2] === 'hdr_dx9'
}

const PREFIX_RE = /^([^$?]+)\?(.+)$/

/**
 * Evaluates a raw block into params. `stats` collects conditional usage for surveys.
 * Nested blocks that are not conditions (Proxies, ...) become nested params objects.
 */
function evaluate(entries, shader, stats, depth = 0) {
  const base = {}
  const overrides = []
  for (const e of entries) {
    if (e.cond) {
      stats.platform++
      if (!platformApplies(e.cond, stats.unknown)) continue
    }
    const key = e.key.toLowerCase()
    if (e.children) {
      const dx = dxConditionApplies(key)
      if (dx !== null) {
        stats.blocks.push({ name: key, applied: dx })
        if (dx) overrides.push(evaluate(e.children, shader, stats, depth + 1))
        continue
      }
      const fb = depth === 0 ? fallbackBlockApplies(key, shader) : null
      if (fb !== null) {
        stats.fallbacks.push({ name: key, applied: fb })
        if (fb) overrides.push(evaluate(e.children, shader, stats, depth + 1))
        continue
      }
      base[key] = evaluate(e.children, shader, stats, depth + 1)
      continue
    }
    const m = PREFIX_RE.exec(key)
    if (m && !key.startsWith('$') && !key.startsWith('%')) {
      const applies = prefixConditionApplies(m[1], stats.unknown)
      stats.prefixed.push({ name: key, applied: applies })
      if (applies) overrides.push({ [m[2]]: e.value })
      continue
    }
    if (key === '$basetexture' && key in base) stats.repeatedBaseTexture++
    base[key] = e.value
  }
  for (const o of overrides) Object.assign(base, o)
  return base
}

/**
 * Parses VMT text. `params` keys are lower case; nested blocks are objects.
 * `conditions` lists what the rules above decided: { blocks, fallbacks, prefixed, platform, unknown,
 * repeatedBaseTexture }.
 */
export function parseVmt(text) {
  if (Buffer.isBuffer(text)) text = text.toString('latin1')
  const tree = parseTree(tokenize(text))
  const stats = { blocks: [], fallbacks: [], prefixed: [], platform: 0, unknown: new Set(), repeatedBaseTexture: 0 }
  const shader = tree.shader.toLowerCase()
  const params = evaluate(tree.entries, shader, stats)
  return {
    shader,
    params,
    conditions: { ...stats, unknown: [...stats.unknown].sort() },
  }
}

// ─── resolution ──────────────────────────────────────────────────────────────

/** `materials/<path>.vmt`, lower case, forward slashes. Accepts names with or without both. */
export function materialPath(name) {
  let n = String(name).replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
  n = n.replace(/^materials\//, '').replace(/\.vmt$/, '')
  return `materials/${n}.vmt`
}

const asReaders = source => (Array.isArray(source) ? source : [source]).filter(Boolean)
function readFrom(readers, file) {
  for (const r of readers) {
    const data = r.read(file)
    if (data) return data
  }
  return null
}

/** Reads one VMT file (no search paths) and resolves patches. Null when missing. */
export function readMaterialFile(source, file, depth = 0) {
  const readers = asReaders(source)
  const data = readFrom(readers, file)
  if (!data) return null
  const vmt = parseVmt(data)
  if (vmt.shader !== 'patch') return { file, shader: vmt.shader, params: vmt.params, conditions: vmt.conditions }
  const include = typeof vmt.params.include === 'string' ? vmt.params.include : null
  const base = include && depth < 8 ? readMaterialFile(readers, materialPath(include), depth + 1) : null
  const params = structuredClone(base?.params ?? {})
  const replace = vmt.params.replace
  if (replace && typeof replace === 'object') for (const [k, v] of Object.entries(replace)) if (k in params) params[k] = v
  const insert = vmt.params.insert
  if (insert && typeof insert === 'object') Object.assign(params, insert)
  return {
    file,
    shader: base?.shader ?? 'patch',
    params,
    conditions: vmt.conditions,
    patch: { include: include ? materialPath(include) : null, resolved: Boolean(base) },
  }
}

/**
 * Finds a material the way the engine does for a model: each `$cdmaterials` search dir + name, then
 * the name alone. `source` is a VPK set (or anything with `read(path)`) or an array of them, the
 * first one with the file winning (a BSP PAK before the VPKs).
 * @returns {{ file, shader, params, conditions, patch? } | null}
 */
export function resolveMaterial(source, name, searchDirs = []) {
  const readers = asReaders(source)
  const bare = materialPath(name).slice('materials/'.length, -'.vmt'.length)
  const candidates = []
  for (const dir of searchDirs ?? []) {
    let d = String(dir).replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase().replace(/^materials\//, '')
    if (d && !d.endsWith('/')) d += '/'
    candidates.push(`materials/${d}${bare}.vmt`)
  }
  candidates.push(`materials/${bare}.vmt`)
  for (const file of [...new Set(candidates)]) {
    const m = readMaterialFile(readers, file.replace(/\/{2,}/g, '/'))
    if (m) return m
  }
  return null
}

// ─── material semantics ──────────────────────────────────────────────────────

export const vmtTruthy = value =>
  value !== undefined && value !== null && typeof value !== 'object' && String(value).trim() !== '' &&
  !/^(0+(\.0*)?|false)$/i.test(String(value).trim())

/** The VTF path of a texture param (`$basetexture` by default), or null. */
export function vmtBaseTexture(params, key = '$basetexture') {
  const v = params?.[key]
  if (typeof v !== 'string' || !v.trim()) return null
  const n = v.trim().replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase().replace(/^materials\//, '').replace(/\.vtf$/, '')
  return `materials/${n}.vtf`
}

/** Opacity semantics of contract 2.6: { alpha: 'opaque' | 'test' | 'blend', cutoff }. */
export function vmtAlpha(params) {
  if (vmtTruthy(params?.$alphatest)) {
    const ref = Number(params.$alphatestreference)
    return { alpha: 'test', cutoff: Number.isFinite(ref) && ref > 0 ? ref : DEFAULT_ALPHA_TEST_REFERENCE }
  }
  if (vmtTruthy(params?.$translucent)) return { alpha: 'blend', cutoff: null }
  return { alpha: 'opaque', cutoff: null }
}
