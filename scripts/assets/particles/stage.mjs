// The `particles` stage (as/particles): TF2's particle systems for explosions, the flamethrower and projectile
// trails, read from the user's own .pcf files (binary DMX) into one JSON file, plus the sprite textures their
// materials use as WebP with the VTF's sprite-sheet sequences.
//
//   particles/systems.json            item `particles/systems` (kind `particles`)
//   particles/textures/<path>.webp    items `particles/<path>` (kind `texture`, `srgb: false`: the runtime samples
//                                      them raw and blends in gamma space as Source does)
//
// systems.json: { version, systems: { <name>: { maxParticles, initialParticles, material, radius, color, rotation,
// rotationSpeed, sequence, emitters, initializers, operators, forces, constraints, renderers, children } },
// materials: { <material>: { shader, blend, overbright, addself, blendFrames, maxSize, minSize, startFadeSize,
// endFadeSize, texture, width, height, sheet } } }. Each operator keeps its DMX attributes verbatim under their
// own names plus `fn`, the function name; the runtime (src/assetpack/particles/) interprets the subset it knows.
// Every number comes from the user's files and stays in the pack (D19).
//
// Options (--set): particleTextureMaxSize=<px> (1024; textures with a sheet of more than 16 frames keep it, the
// others are capped at 512).

import { parseDmx } from './dmx.mjs'
import { PCF_FILES, ROOT_SYSTEMS } from './list.mjs'
import { readMaterialFile, vmtBaseTexture, vmtTruthy } from '../lib/vmt.mjs'
import { parseVtfHeader } from '../lib/vtf.mjs'
import { exportVtf } from '../lib/texture-export.mjs'
import { sha256 } from '../lib/vpk.mjs'

const PARTICLES_VERSION = 1
const OPERATOR_GROUPS = ['emitters', 'initializers', 'operators', 'forces', 'constraints', 'renderers']
// Editor-only attributes of every operator.
const SKIP_ATTR = /^(functionName|operator (start|end) fade(in|out)|operator fade oscillate|Visibility .*)$/

const roundNum = v => (Number.isFinite(v) ? Number(v.toPrecision(6)) : 0)
function plain(value) {
  if (typeof value === 'number') return roundNum(value)
  if (typeof value === 'boolean' || typeof value === 'string') return value
  if (Array.isArray(value)) return value.every(v => typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') ? value.map(plain) : undefined
  return undefined
}

function operatorOf(el) {
  const out = { fn: String(el.attrs.functionName ?? '') }
  for (const [k, v] of Object.entries(el.attrs)) {
    if (SKIP_ATTR.test(k)) continue
    const p = plain(v)
    if (p !== undefined) out[k] = p
  }
  return out
}

const materialKey = m => String(m ?? '').trim().replace(/\\/g, '/').toLowerCase().replace(/^materials\//, '').replace(/\.vmt$/, '')

function systemOf(def) {
  const a = def.attrs
  const out = {
    maxParticles: a.max_particles ?? 1000,
    initialParticles: a.initial_particles ?? 0,
    material: materialKey(a.material),
    radius: roundNum(a.radius ?? 5),
    color: a.color ?? [255, 255, 255, 255],
    rotation: roundNum(a.rotation ?? 0),
    rotationSpeed: roundNum(a.rotation_speed ?? 0),
    sequence: a.sequence_number ?? 0,
  }
  for (const g of OPERATOR_GROUPS) out[g] = (a[g] ?? []).filter(Boolean).map(operatorOf)
  out.children = (a.children ?? []).filter(c => c?.attrs?.child).map(c => ({ system: c.attrs.child.name, delay: roundNum(c.attrs.delay ?? 0) }))
  return out
}

/** VTF sheet resource (tag 0x10): sequences of frames with their duration and the first image rectangle. */
export function readSheet(vtf, header) {
  const res = header.resources.find(r => r.tag === '100000')
  if (!res) return null
  let o = res.data
  const size = vtf.readUInt32LE(o)
  const end = o + 4 + size
  o += 4
  const version = vtf.readInt32LE(o)
  const count = vtf.readInt32LE(o + 4)
  o += 8
  const perFrame = version ? 4 : 1
  const sequences = []
  for (let s = 0; s < count; s++) {
    const number = vtf.readInt32LE(o)
    const clamp = vtf.readInt32LE(o + 4) !== 0
    const frames = vtf.readInt32LE(o + 8)
    const total = vtf.readFloatLE(o + 12)
    o += 16
    const list = []
    for (let f = 0; f < frames; f++) {
      const duration = vtf.readFloatLE(o)
      const rect = [vtf.readFloatLE(o + 4), vtf.readFloatLE(o + 8), vtf.readFloatLE(o + 12), vtf.readFloatLE(o + 16)].map(roundNum)
      o += 4 + perFrame * 16
      list.push({ duration: roundNum(duration), rect })
    }
    sequences[number] = { clamp, total: roundNum(total), frames: list }
  }
  if (o !== end) throw new Error(`sheet resource ends at ${o}, expected ${end}`)
  for (let i = 0; i < sequences.length; i++) if (!sequences[i]) sequences[i] = null
  return sequences
}

const num = (v, d) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

function materialOf(vmt) {
  const p = vmt.params
  const shader = String(vmt.shader).toLowerCase()
  const additive = vmtTruthy(p.$additive)
  return {
    shader,
    blend: additive ? 'additive' : 'blend',
    overbright: num(p.$overbrightfactor, 1),
    addself: num(p.$addself, 0),
    // SpriteCard blends adjacent sheet frames unless told not to
    blendFrames: shader === 'spritecard' ? p.$blendframes === undefined || vmtTruthy(p.$blendframes) : false,
    maxSize: num(p.$maxsize, 20),
    minSize: num(p.$minsize, 0),
    startFadeSize: num(p.$startfadesize, 10),
    endFadeSize: num(p.$endfadesize, 20),
    texture: null,
    width: 0,
    height: 0,
    sheet: null,
  }
}

export async function run(ctx) {
  const t0 = performance.now()
  const maxSize = Number(ctx.options.set?.particleTextureMaxSize ?? 1024)
  const defs = new Map()
  const pcfHashes = {}
  for (const file of PCF_FILES) {
    const buf = ctx.vpk.read(file)
    if (!buf) { ctx.log(`particles: ${file} missing`); continue }
    pcfHashes[file] = sha256(buf)
    const dmx = parseDmx(buf)
    for (const def of dmx.root.attrs.particleSystemDefinitions ?? []) if (def && !defs.has(def.name)) defs.set(def.name, def)
  }
  const systems = {}
  const missing = []
  const queue = [...ROOT_SYSTEMS]
  while (queue.length) {
    const name = queue.shift()
    if (name in systems) continue
    const def = defs.get(name)
    if (!def) { missing.push(name); continue }
    systems[name] = systemOf(def)
    for (const c of systems[name].children) queue.push(c.system)
  }
  const materials = {}
  const textures = { written: 0, unsupported: [] }
  for (const key of [...new Set(Object.values(systems).map(s => s.material))].sort()) {
    if (!key) continue
    const vmt = readMaterialFile(ctx.vpk, `materials/${key}.vmt`)
    if (!vmt) { missing.push(`materials/${key}.vmt`); continue }
    const mat = materialOf(vmt)
    materials[key] = mat
    const vtfPath = vmtBaseTexture(vmt.params)
    const vtf = vtfPath ? ctx.vpk.read(vtfPath) : null
    if (!vtf) { textures.unsupported.push({ key, reason: 'missing' }); continue }
    const header = parseVtfHeader(vtf)
    const sheet = readSheet(vtf, header)
    const frames = (sheet ?? []).reduce((n, s) => n + (s?.frames.length ?? 0), 0)
    const cap = frames > 16 ? maxSize : Math.min(maxSize, 512)
    const out = await exportVtf(vtf, { maxSize: cap, webpMaxSize: cap, webp: true })
    if (!out.webp) { textures.unsupported.push({ key, reason: out.unsupported ?? 'no image' }); continue }
    const tkey = `particles/${vtfPath.slice('materials/'.length, -'.vtf'.length)}`
    const file = ctx.writeFile(`${tkey.replace(/^particles\//, 'particles/textures/')}.webp`, out.webp)
    ctx.addItem(tkey, {
      kind: 'texture', file, webp: file, srgb: false, oneBitAlpha: !!out.info.oneBitAlpha, alpha: 'blend', alphaCutoff: null,
      width: out.info.webpWidth ?? out.info.width, height: out.info.webpHeight ?? out.info.height, mips: 1, role: 'particle',
    })
    textures.written++
    mat.texture = tkey
    mat.width = out.info.webpWidth ?? out.info.width
    mat.height = out.info.webpHeight ?? out.info.height
    mat.sheet = sheet
  }
  const json = Buffer.from(JSON.stringify({ version: PARTICLES_VERSION, systems, materials }))
  const file = ctx.writeFile('particles/systems.json', json)
  ctx.addItem('particles/systems', {
    kind: 'particles', file, systems: Object.keys(systems).length, materials: Object.keys(materials).length,
    inputKey: ctx.inputKey({ particles: PARTICLES_VERSION, pcf: pcfHashes, roots: ROOT_SYSTEMS, maxSize }),
  })
  ctx.setOptions({ roots: ROOT_SYSTEMS.length, particleTextureMaxSize: maxSize })
  if (missing.length) ctx.log(`particles: missing ${missing.join(', ')}`)
  ctx.log(`particles: ${Object.keys(systems).length} systems, ${Object.keys(materials).length} materials, ${textures.written} textures`)
  return { ms: Math.round(performance.now() - t0), systems: Object.keys(systems).length, materials: Object.keys(materials).length, textures, missing }
}
