// A deterministic evaluator for the subset of Source particle systems the pack's systems.json carries
// (as/particles). Every particle is a pure function of its effect instance (system, seed, start, stop, control
// point history) and the time: its birth time follows from the emitter, its initial values from a seeded random
// stream (instance seed, system, particle index), and its state at age a from closed forms of the operators.
// Nothing is integrated frame by frame, so seeking to a time twice gives the same particles (D12).
//
// Implemented (names as in the .pcf files):
//   emitters      emit_instantaneously, emit_continuously, initial_particles
//   initializers  Lifetime Random, lifetime from sequence, Radius Random, Alpha Random, Color Random,
//                 Rotation Random, Rotation Speed Random, Sequence Random, Trail Length Random,
//                 Position Within Sphere Random (distance, bias, speed, local speed), Position Within Box Random,
//                 Position Modify Offset Random, Velocity Random
//   operators     Movement Basic (gravity, drag per 1/30 s), Radius Scale, Color Fade, Alpha Fade and Decay,
//                 Alpha Fade In Random, Alpha Fade Out Random, Rotation Spin Roll, Rotation Basic,
//                 Movement Lock to Control Point (translation, followed until the middle of the fade window),
//                 Lifespan Decay
//   forces        random force (a constant per-particle acceleration drawn from the range, scaled)
//   renderers     render_animated_sprites (sheet sequences, fit-to-lifetime, FPS, frame blending),
//                 render_sprite_trail (length = trail length x speed, min/max, length fade-in)
//   constraints   Collision via traces: only against the surface an explosion hit (EffectInstance.surface)
// Ignored: Oscillate Vector/Scalar, Pull towards control point, Rotation Yaw Flip Random, collisions with the rest
// of the world, tinting from lighting, depth blending.

import * as THREE from 'three'

import type { PcfFile, PcfMaterial, PcfOperator, PcfSystem } from './types'

const DEG = Math.PI / 180
/** Share of a random force's range used as a constant per-particle acceleration (Source rerolls it per step). */
const RANDOM_FORCE_SCALE = 0.3
/** Emitters without an end inside a finite effect stop after this many seconds. */
const OPEN_EMITTER_SECONDS = 5

export interface ControlPoint {
  pos: THREE.Vector3
  fwd: THREE.Vector3
  left: THREE.Vector3
  up: THREE.Vector3
}

export function makeControlPoint(): ControlPoint {
  return { pos: new THREE.Vector3(), fwd: new THREE.Vector3(1, 0, 0), left: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 0, 1) }
}

/** Sets fwd/left/up from a forward direction (Source VectorAngles with roll 0: up as close to +z as possible). */
export function orientControlPoint(cp: ControlPoint, fx: number, fy: number, fz: number): ControlPoint {
  const len = Math.hypot(fx, fy, fz)
  if (!(len > 1e-6)) {
    cp.fwd.set(1, 0, 0)
    cp.left.set(0, 1, 0)
    cp.up.set(0, 0, 1)
    return cp
  }
  cp.fwd.set(fx / len, fy / len, fz / len)
  const h = Math.hypot(cp.fwd.x, cp.fwd.y)
  if (h < 1e-4) {
    // straight up or down: yaw 0
    cp.left.set(0, 1, 0)
    cp.up.set(-Math.sign(cp.fwd.z), 0, 0)
  } else {
    cp.left.set(-cp.fwd.y / h, cp.fwd.x / h, 0)
    cp.up.crossVectors(cp.fwd, cp.left)
  }
  return cp
}

/** Control point at absolute time t (seconds); false when there is none then (no particle is born). */
export type ControlPointSource = (t: number, out: ControlPoint) => boolean

export interface EffectInstance {
  system: string
  seed: number
  /** seconds */
  start: number
  /** seconds: continuous emitters stop here (Infinity while the effect runs) */
  stop: number
  cp: ControlPointSource
  /** alpha multiplier (POV readability) */
  alpha?: number
  /**
   * The control point sits on a surface whose normal is its forward axis (a wall or floor explosion): particles of
   * systems with a collision constraint stay on its front side instead of tracing the world.
   */
  surface?: boolean
}

/** One particle as the renderers draw it; colours are sRGB 0..1 before the material's overbright factor. */
export interface ParticleOut {
  x: number; y: number; z: number
  radius: number
  rotation: number
  r: number; g: number; b: number; a: number
  /** sheet rectangles (u0, v0, u1, v1) of this and the next frame, and the blend between them */
  uv0: [number, number, number, number]
  uv1: [number, number, number, number]
  blend: number
  /** trails: unit direction toward the head and the length; sprites: length 0 */
  dx: number; dy: number; dz: number
  length: number
}

export interface ParticleSink {
  push(batch: number, p: ParticleOut): void
}

export interface BatchInfo { key: string; material: string; kind: 'sprite' | 'trail'; order: number }

// ─── random numbers ──────────────────────────────────────────────────────────

export function hash32(a: number, b = 0, c = 0): number {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77) ^ Math.imul(c | 0, 0xc2b2ae3d)) >>> 0
  h ^= h >>> 16
  h = Math.imul(h, 0x7feb352d) >>> 0
  h ^= h >>> 15
  h = Math.imul(h, 0x846ca68b) >>> 0
  h ^= h >>> 16
  return h >>> 0
}

class Rng {
  s = 1
  seed(v: number) {
    this.s = v >>> 0 || 0x6d2b79f5
  }
  next(): number {
    // mulberry32
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  exp(min: number, max: number, exponent = 1): number {
    const r = this.next()
    return min + (max - min) * (exponent === 1 ? r : Math.pow(r, exponent))
  }
}

// ─── compiled systems ────────────────────────────────────────────────────────

const n = (o: PcfOperator, k: string, d = 0): number => {
  const v = o[k]
  return typeof v === 'number' && Number.isFinite(v) ? v : d
}
const b = (o: PcfOperator, k: string, d = false): boolean => {
  const v = o[k]
  return typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : d
}
const v3 = (o: PcfOperator, k: string, d: [number, number, number] = [0, 0, 0]): [number, number, number] => {
  const v = o[k]
  return Array.isArray(v) && v.length >= 3 && v.every(x => typeof x === 'number') ? [v[0] as number, v[1] as number, v[2] as number] : d
}
const c4 = (o: PcfOperator, k: string): [number, number, number, number] => {
  const v = o[k]
  return Array.isArray(v) && v.length >= 3 ? [Number(v[0]) / 255, Number(v[1]) / 255, Number(v[2]) / 255, Number(v[3] ?? 255) / 255] : [1, 1, 1, 1]
}

type Init =
  | { t: 'life'; min: number; max: number; exp: number }
  | { t: 'lifeSeq'; fps: number }
  | { t: 'radius'; min: number; max: number; exp: number }
  | { t: 'alpha'; min: number; max: number; exp: number }
  | { t: 'color'; c1: number[]; c2: number[] }
  | { t: 'rot'; base: number; min: number; max: number; exp: number }
  | { t: 'rotSpeed'; base: number; min: number; max: number; exp: number; flip: boolean }
  | { t: 'seq'; min: number; max: number }
  | { t: 'trail'; min: number; max: number; exp: number }
  | { t: 'sphere'; dmin: number; dmax: number; bias: number[]; biasAbs: number[]; biasLocal: boolean; smin: number; smax: number; sexp: number; lmin: number[]; lmax: number[] }
  | { t: 'box'; min: number[]; max: number[] }
  | { t: 'offset'; min: number[]; max: number[]; local: boolean; prop: boolean }
  | { t: 'velocity'; smin: number; smax: number; lmin: number[]; lmax: number[] }
  | { t: 'skip' }

interface Fade { s: number; e: number; ease: boolean }
interface RadiusOp extends Fade { from: number; to: number; bias: number }
interface ColorOp extends Fade { color: number[] }
interface AlphaOp { a0: number; a1: number; fis: number; fie: number; fos: number; foe: number }
interface AlphaRandomOp { inMin: number; inMax: number; outMin: number; outMax: number; fadeIn: boolean; proportional: boolean }
interface Renderer { kind: 'sprite' | 'trail'; batch: number; rate: number; fit: boolean; fps: boolean; minLen: number; maxLen: number; fadeIn: number }

export interface CompiledSystem {
  name: string
  index: number
  max: number
  radius: number
  color: number[]
  rotation: number
  rotationSpeed: number
  sequence: number
  material: PcfMaterial | null
  instants: { at: number; count: number }[]
  continuous: { start: number; duration: number; rate: number }[]
  inits: Init[]
  gravity: [number, number, number]
  /** Movement Basic drag as a continuous decay rate (1/s) */
  lambda: number
  moves: boolean
  randomForce: { min: number[]; max: number[] } | null
  lock: { sMin: number; sMax: number; eMin: number; eMax: number } | null
  /** has Collision via traces or a plane constraint */
  collides: boolean
  radiusOps: RadiusOp[]
  colorOps: ColorOp[]
  alphaOps: AlphaOp[]
  alphaRandomOps: AlphaRandomOp[]
  spin: { rate: number; min: number; stop: number } | null
  rotBasic: boolean
  renderers: Renderer[]
  children: { system: CompiledSystem; delay: number }[]
  maxLife: number
  meanLife: number
  /** seconds from the system's start until its last particle dies (finite emitters), else Infinity */
  span: number
  /** the same without the children */
  ownSpan: number
}

export interface CompiledParticles {
  systems: Map<string, CompiledSystem>
  batches: BatchInfo[]
}

function lifeRange(sys: PcfSystem, material: PcfMaterial | null): [number, number] {
  let range: [number, number] = [1, 1]
  for (const o of sys.initializers) {
    if (o.fn === 'Lifetime Random' || o.fn === 'lifetime_random') range = [n(o, 'lifetime_min', 1), n(o, 'lifetime_max', 1)]
    if (o.fn === 'lifetime from sequence' || o.fn === 'Lifetime From Sequence') {
      const fps = n(o, 'Frames Per Second', 30) || 30
      const totals = (material?.sheet ?? []).filter(Boolean).map(s => s!.total / fps)
      if (totals.length) range = [Math.min(...totals), Math.max(...totals)]
    }
  }
  return range
}

function compileInit(o: PcfOperator): Init {
  switch (o.fn) {
    case 'Lifetime Random':
    case 'lifetime_random':
      return { t: 'life', min: n(o, 'lifetime_min', 1), max: n(o, 'lifetime_max', 1), exp: n(o, 'lifetime_random_exponent', 1) }
    case 'lifetime from sequence':
    case 'Lifetime From Sequence':
      return { t: 'lifeSeq', fps: n(o, 'Frames Per Second', 30) || 30 }
    case 'Radius Random':
    case 'radius_random':
      return { t: 'radius', min: n(o, 'radius_min', 1), max: n(o, 'radius_max', 1), exp: n(o, 'radius_random_exponent', 1) }
    case 'Alpha Random':
    case 'alpha_random':
      return { t: 'alpha', min: n(o, 'alpha_min', 255), max: n(o, 'alpha_max', 255), exp: n(o, 'alpha_random_exponent', 1) }
    case 'Color Random':
    case 'color_random':
      return { t: 'color', c1: c4(o, 'color1'), c2: c4(o, 'color2') }
    case 'Rotation Random':
    case 'rotation_random':
      return { t: 'rot', base: n(o, 'rotation_initial'), min: n(o, 'rotation_offset_min'), max: n(o, 'rotation_offset_max', 360), exp: n(o, 'rotation_random_exponent', 1) }
    case 'Rotation Speed Random':
      return {
        t: 'rotSpeed', base: n(o, 'rotation_speed_constant'), min: n(o, 'rotation_speed_random_min'), max: n(o, 'rotation_speed_random_max', 360),
        exp: n(o, 'rotation_speed_random_exponent', 1), flip: b(o, 'randomly_flip_direction', true),
      }
    case 'Sequence Random':
      return { t: 'seq', min: n(o, 'sequence_min'), max: n(o, 'sequence_max') }
    case 'Trail Length Random':
    case 'trail_length_random':
      return { t: 'trail', min: n(o, 'length_min', 0.1), max: n(o, 'length_max', 0.1), exp: n(o, 'length_random_exponent', 1) }
    case 'Position Within Sphere Random':
    case 'position_within_sphere':
      return {
        t: 'sphere', dmin: n(o, 'distance_min'), dmax: n(o, 'distance_max'), bias: v3(o, 'distance_bias', [1, 1, 1]),
        biasAbs: v3(o, 'distance_bias_absolute_value'), biasLocal: b(o, 'bias in local system'), smin: n(o, 'speed_min'), smax: n(o, 'speed_max'),
        sexp: n(o, 'speed_random_exponent', 1), lmin: v3(o, 'speed_in_local_coordinate_system_min'), lmax: v3(o, 'speed_in_local_coordinate_system_max'),
      }
    case 'Position Within Box Random':
      return { t: 'box', min: v3(o, 'min'), max: v3(o, 'max') }
    case 'Position Modify Offset Random':
      return { t: 'offset', min: v3(o, 'offset min'), max: v3(o, 'offset max'), local: b(o, 'offset in local space 0/1'), prop: b(o, 'offset proportional to radius 0/1') }
    case 'Velocity Random':
      return { t: 'velocity', smin: n(o, 'random_speed_min'), smax: n(o, 'random_speed_max'), lmin: v3(o, 'speed_in_local_coordinate_system_min'), lmax: v3(o, 'speed_in_local_coordinate_system_max') }
    default:
      return { t: 'skip' }
  }
}

export function compileParticles(file: PcfFile): CompiledParticles {
  const systems = new Map<string, CompiledSystem>()
  const batches: BatchInfo[] = []
  const batchIndex = new Map<string, number>()
  const batchOf = (material: string, kind: 'sprite' | 'trail') => {
    const key = `${material}|${kind}`
    let i = batchIndex.get(key)
    if (i === undefined) {
      i = batches.length
      batchIndex.set(key, i)
      batches.push({ key, material, kind, order: i })
    }
    return i
  }
  let index = 0
  const build = (name: string, depth: number): CompiledSystem | null => {
    const existing = systems.get(name)
    if (existing) return existing
    const sys = file.systems[name]
    if (!sys || depth > 8) return null
    const material = file.materials[sys.material] ?? null
    const [lmin, lmax] = lifeRange(sys, material)
    const c: CompiledSystem = {
      name, index: index++, max: Math.max(0, sys.maxParticles || 0) || 1000, radius: sys.radius, color: [sys.color[0] / 255, sys.color[1] / 255, sys.color[2] / 255, (sys.color[3] ?? 255) / 255],
      rotation: sys.rotation * DEG, rotationSpeed: sys.rotationSpeed * DEG, sequence: sys.sequence, material,
      instants: [], continuous: [], inits: sys.initializers.map(compileInit), gravity: [0, 0, 0], lambda: 0, moves: false,
      randomForce: null, lock: null, collides: false, radiusOps: [], colorOps: [], alphaOps: [], alphaRandomOps: [], spin: null, rotBasic: false,
      renderers: [], children: [], maxLife: Math.max(lmin, lmax), meanLife: Math.max(1e-3, (lmin + lmax) / 2), span: 0, ownSpan: 0,
    }
    systems.set(name, c)
    if (sys.initialParticles > 0) c.instants.push({ at: 0, count: sys.initialParticles })
    for (const o of sys.emitters) {
      if (o.fn === 'emit_instantaneously') {
        c.instants.push({ at: n(o, 'emission_start_time'), count: Math.max(0, Math.round(n(o, 'num_to_emit'))) })
      } else if (o.fn === 'emit_continuously') {
        c.continuous.push({ start: n(o, 'emission_start_time'), duration: n(o, 'emission_duration'), rate: Math.max(0, n(o, 'emission_rate')) })
      }
    }
    for (const o of sys.operators) {
      switch (o.fn) {
        case 'Movement Basic':
        case 'basic_movement': {
          c.moves = true
          const g = v3(o, 'gravity')
          c.gravity = [c.gravity[0] + g[0], c.gravity[1] + g[1], c.gravity[2] + g[2]]
          const drag = n(o, 'drag')
          // ExponentialDecay(1 - drag, 1/30, dt): the velocity keeps (1 - drag) per 1/30 s
          c.lambda = drag !== 0 && drag < 1 ? -30 * Math.log(1 - drag) : drag >= 1 ? 1e3 : 0
          break
        }
        case 'Radius Scale':
        case 'radius_scale':
          c.radiusOps.push({ s: n(o, 'start_time'), e: n(o, 'end_time', 1), ease: b(o, 'ease_in_and_out'), from: n(o, 'radius_start_scale', 1), to: n(o, 'radius_end_scale', 1), bias: n(o, 'scale_bias', 0.5) })
          break
        case 'Color Fade':
        case 'color_fade':
          c.colorOps.push({ s: n(o, 'fade_start_time'), e: n(o, 'fade_end_time', 1), ease: b(o, 'ease_in_and_out', true), color: c4(o, 'color_fade') })
          break
        case 'Alpha Fade and Decay':
          c.alphaOps.push({ a0: n(o, 'start_alpha', 1), a1: n(o, 'end_alpha', 0), fis: n(o, 'start_fade_in_time'), fie: n(o, 'end_fade_in_time'), fos: n(o, 'start_fade_out_time', 0.5), foe: n(o, 'end_fade_out_time', 1) })
          break
        case 'Alpha Fade In Random':
        case 'alpha_fade_in_random':
          c.alphaRandomOps.push({ inMin: n(o, 'fade in time min', 0.25), inMax: n(o, 'fade in time max', 0.25), outMin: 0, outMax: 0, fadeIn: true, proportional: b(o, 'proportional 0/1', true) })
          break
        case 'Alpha Fade Out Random':
        case 'alpha_fade_out_random':
          c.alphaRandomOps.push({ inMin: 0, inMax: 0, outMin: n(o, 'fade out time min', 0.25), outMax: n(o, 'fade out time max', 0.25), fadeIn: false, proportional: b(o, 'proportional 0/1', true) })
          break
        case 'Rotation Spin Roll':
          c.spin = { rate: n(o, 'spin_rate_degrees') * DEG, min: n(o, 'spin_rate_min') * DEG, stop: n(o, 'spin_stop_time') }
          break
        case 'Rotation Basic':
          c.rotBasic = true
          break
        case 'Movement Lock to Control Point':
        case 'postion_lock_to_controlpoint':
          c.lock = { sMin: n(o, 'start_fadeout_min', 1), sMax: n(o, 'start_fadeout_max', 1), eMin: n(o, 'end_fadeout_min', 1), eMax: n(o, 'end_fadeout_max', 1) }
          break
      }
    }
    c.collides = sys.constraints.some(o => o.fn === 'Collision via traces' || o.fn === 'Prevent passing through a plane')
    for (const o of sys.forces) if (o.fn === 'random force') c.randomForce = { min: v3(o, 'min force'), max: v3(o, 'max force') }
    for (const o of sys.renderers) {
      if (o.fn === 'render_animated_sprites') {
        c.renderers.push({ kind: 'sprite', batch: batchOf(sys.material, 'sprite'), rate: n(o, 'animation rate', 0.1), fit: b(o, 'animation_fit_lifetime'), fps: b(o, 'use animation rate as FPS'), minLen: 0, maxLen: 0, fadeIn: 0 })
      } else if (o.fn === 'render_sprite_trail') {
        c.renderers.push({ kind: 'trail', batch: batchOf(sys.material, 'trail'), rate: n(o, 'animation rate', 0.1), fit: false, fps: false, minLen: n(o, 'min length'), maxLen: n(o, 'max length', 2000), fadeIn: n(o, 'length fade in time') })
      }
    }
    if (!c.material) c.renderers = []
    for (const child of sys.children) {
      const built = build(child.system, depth + 1)
      if (built) c.children.push({ system: built, delay: child.delay })
    }
    let own = 0
    for (const e of c.instants) own = Math.max(own, e.at + c.maxLife)
    for (const e of c.continuous) own = Math.max(own, e.duration > 0 ? e.start + e.duration + c.maxLife : Infinity)
    c.span = own
    c.ownSpan = own
    for (const ch of c.children) c.span = Math.max(c.span, ch.delay + ch.system.span)
    return c
  }
  for (const name of Object.keys(file.systems)) build(name, 0)
  return { systems, batches }
}

/** Seconds from an effect's start until its last particle dies; open emitters count OPEN_EMITTER_SECONDS. */
export function effectSpan(sys: CompiledSystem): number {
  return Number.isFinite(sys.span) ? sys.span : spanCapped(sys)
}
function spanCapped(sys: CompiledSystem): number {
  let own = 0
  for (const e of sys.instants) own = Math.max(own, e.at + sys.maxLife)
  for (const e of sys.continuous) own = Math.max(own, (e.duration > 0 ? e.start + e.duration : OPEN_EMITTER_SECONDS) + sys.maxLife)
  for (const ch of sys.children) own = Math.max(own, ch.delay + spanCapped(ch.system))
  return own
}

/** Longest particle life in a system tree (continuous effects linger this long after they stop). */
export function treeMaxLife(sys: CompiledSystem): number {
  let m = sys.maxLife
  for (const ch of sys.children) m = Math.max(m, ch.delay + treeMaxLife(ch.system))
  return m
}

// ─── evaluation ──────────────────────────────────────────────────────────────

const rng = new Rng()
const cpBirth = makeControlPoint()
const cpLock = makeControlPoint()
const out: ParticleOut = {
  x: 0, y: 0, z: 0, radius: 0, rotation: 0, r: 1, g: 1, b: 1, a: 1, uv0: [0, 0, 1, 1], uv1: [0, 0, 1, 1], blend: 0, dx: 0, dy: 0, dz: 0, length: 0,
}
const FULL: [number, number, number, number] = [0, 0, 1, 1]

interface P {
  life: number; radius: number; alpha: number; r: number; g: number; b: number
  rot: number; rotSpeed: number; seq: number; trail: number
  px: number; py: number; pz: number; vx: number; vy: number; vz: number
  ax: number; ay: number; az: number; lockT: number
}
const p: P = { life: 1, radius: 1, alpha: 1, r: 1, g: 1, b: 1, rot: 0, rotSpeed: 0, seq: 0, trail: 0.1, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, ax: 0, ay: 0, az: 0, lockT: 0 }

const lerp = (a: number, c: number, t: number) => a + (c - a) * t
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const spline = (t: number) => t * t * (3 - 2 * t)
const biasFn = (x: number, amt: number) => (amt > 0 && amt !== 0.5 ? x / ((1 / amt - 2) * (1 - x) + 1) : x)

function localToWorld(cp: ControlPoint, lx: number, ly: number, lz: number, res: number[]) {
  res[0] = cp.fwd.x * lx + cp.left.x * ly + cp.up.x * lz
  res[1] = cp.fwd.y * lx + cp.left.y * ly + cp.up.y * lz
  res[2] = cp.fwd.z * lx + cp.left.z * ly + cp.up.z * lz
}
const tmp = [0, 0, 0]

function initParticle(sys: CompiledSystem, cp: ControlPoint): void {
  p.life = 1
  p.radius = sys.radius
  p.alpha = sys.color[3]
  p.r = sys.color[0]
  p.g = sys.color[1]
  p.b = sys.color[2]
  p.rot = sys.rotation
  p.rotSpeed = sys.rotationSpeed
  p.seq = sys.sequence
  p.trail = 0.1
  p.px = cp.pos.x
  p.py = cp.pos.y
  p.pz = cp.pos.z
  p.vx = p.vy = p.vz = 0
  for (const it of sys.inits) {
    switch (it.t) {
      case 'life':
        p.life = rng.exp(it.min, it.max, it.exp)
        break
      case 'lifeSeq': {
        const seq = sheetSequence(sys.material, p.seq)
        if (seq) p.life = seq.total / it.fps
        break
      }
      case 'radius':
        p.radius = rng.exp(it.min, it.max, it.exp)
        break
      case 'alpha':
        p.alpha = rng.exp(it.min, it.max, it.exp) / 255
        break
      case 'color': {
        const t = rng.next()
        p.r = lerp(it.c1[0], it.c2[0], t)
        p.g = lerp(it.c1[1], it.c2[1], t)
        p.b = lerp(it.c1[2], it.c2[2], t)
        break
      }
      case 'rot':
        p.rot = (it.base + rng.exp(it.min, it.max, it.exp)) * DEG
        break
      case 'rotSpeed': {
        let s = (it.base + rng.exp(it.min, it.max, it.exp)) * DEG
        if (it.flip && rng.next() < 0.5) s = -s
        p.rotSpeed = s
        break
      }
      case 'seq':
        p.seq = Math.min(it.max, it.min + Math.floor(rng.next() * (it.max - it.min + 1)))
        break
      case 'trail':
        p.trail = rng.exp(it.min, it.max, it.exp)
        break
      case 'sphere': {
        // a random direction (uniform on the sphere), biased per axis, at a distance between min and max
        const z = rng.next() * 2 - 1
        const phi = rng.next() * Math.PI * 2
        const s = Math.sqrt(Math.max(0, 1 - z * z))
        let dx = s * Math.cos(phi), dy = s * Math.sin(phi), dz = z
        if (it.biasAbs[0]) dx = Math.abs(dx)
        if (it.biasAbs[1]) dy = Math.abs(dy)
        if (it.biasAbs[2]) dz = Math.abs(dz)
        dx *= it.bias[0]
        dy *= it.bias[1]
        dz *= it.bias[2]
        if (it.biasLocal) {
          localToWorld(cp, dx, dy, dz, tmp)
          dx = tmp[0]
          dy = tmp[1]
          dz = tmp[2]
        }
        const len = Math.hypot(dx, dy, dz) || 1
        const dist = lerp(it.dmin, it.dmax, Math.cbrt(rng.next()))
        p.px = cp.pos.x + (dx / len) * dist
        p.py = cp.pos.y + (dy / len) * dist
        p.pz = cp.pos.z + (dz / len) * dist
        const speed = rng.exp(it.smin, it.smax, it.sexp)
        localToWorld(cp, lerp(it.lmin[0], it.lmax[0], rng.next()), lerp(it.lmin[1], it.lmax[1], rng.next()), lerp(it.lmin[2], it.lmax[2], rng.next()), tmp)
        p.vx += (dx / len) * speed + tmp[0]
        p.vy += (dy / len) * speed + tmp[1]
        p.vz += (dz / len) * speed + tmp[2]
        break
      }
      case 'box':
        p.px = cp.pos.x + lerp(it.min[0], it.max[0], rng.next())
        p.py = cp.pos.y + lerp(it.min[1], it.max[1], rng.next())
        p.pz = cp.pos.z + lerp(it.min[2], it.max[2], rng.next())
        break
      case 'offset': {
        let ox = lerp(it.min[0], it.max[0], rng.next()), oy = lerp(it.min[1], it.max[1], rng.next()), oz = lerp(it.min[2], it.max[2], rng.next())
        if (it.prop) {
          ox *= p.radius
          oy *= p.radius
          oz *= p.radius
        }
        if (it.local) {
          localToWorld(cp, ox, oy, oz, tmp)
          ox = tmp[0]
          oy = tmp[1]
          oz = tmp[2]
        }
        p.px += ox
        p.py += oy
        p.pz += oz
        break
      }
      case 'velocity': {
        const z = rng.next() * 2 - 1
        const phi = rng.next() * Math.PI * 2
        const s = Math.sqrt(Math.max(0, 1 - z * z))
        const speed = lerp(it.smin, it.smax, rng.next())
        localToWorld(cp, lerp(it.lmin[0], it.lmax[0], rng.next()), lerp(it.lmin[1], it.lmax[1], rng.next()), lerp(it.lmin[2], it.lmax[2], rng.next()), tmp)
        p.vx += s * Math.cos(phi) * speed + tmp[0]
        p.vy += s * Math.sin(phi) * speed + tmp[1]
        p.vz += z * speed + tmp[2]
        break
      }
      case 'skip':
        rng.next()
        break
    }
  }
  p.ax = sys.gravity[0]
  p.ay = sys.gravity[1]
  p.az = sys.gravity[2]
  const f = sys.randomForce
  if (f) {
    p.ax += lerp(f.min[0], f.max[0], rng.next()) * RANDOM_FORCE_SCALE
    p.ay += lerp(f.min[1], f.max[1], rng.next()) * RANDOM_FORCE_SCALE
    p.az += lerp(f.min[2], f.max[2], rng.next()) * RANDOM_FORCE_SCALE
  }
  if (sys.lock) {
    const s = lerp(sys.lock.sMin, sys.lock.sMax, rng.next())
    const e = lerp(sys.lock.eMin, sys.lock.eMax, rng.next())
    p.lockT = p.life * clamp01((s + Math.max(s, e)) / 2)
  }
}

function sheetSequence(material: PcfMaterial | null, seq: number) {
  const sheet = material?.sheet
  if (!sheet || !sheet.length) return null
  return sheet[((seq % sheet.length) + sheet.length) % sheet.length] ?? sheet.find(Boolean) ?? null
}

/** Position and velocity at age a: v' = A - lambda v (closed form). */
function motion(sys: CompiledSystem, a: number, res: number[], vel: number[]) {
  const l = sys.moves ? sys.lambda : 0
  const ax = sys.moves ? p.ax : 0, ay = sys.moves ? p.ay : 0, az = sys.moves ? p.az : 0
  if (Math.abs(l) < 1e-4) {
    res[0] = p.px + p.vx * a + 0.5 * ax * a * a
    res[1] = p.py + p.vy * a + 0.5 * ay * a * a
    res[2] = p.pz + p.vz * a + 0.5 * az * a * a
    vel[0] = p.vx + ax * a
    vel[1] = p.vy + ay * a
    vel[2] = p.vz + az * a
    return
  }
  const e = Math.exp(-l * a)
  const k = (1 - e) / l
  const tx = ax / l, ty = ay / l, tz = az / l
  res[0] = p.px + tx * a + (p.vx - tx) * k
  res[1] = p.py + ty * a + (p.vy - ty) * k
  res[2] = p.pz + tz * a + (p.vz - tz) * k
  vel[0] = tx + (p.vx - tx) * e
  vel[1] = ty + (p.vy - ty) * e
  vel[2] = tz + (p.vz - tz) * e
}

const posA = [0, 0, 0]
const velA = [0, 0, 0]

function frameOf(material: PcfMaterial | null, seq: number, cycle: number) {
  const s = sheetSequence(material, seq)
  if (!s || !s.frames.length || !(s.total > 0)) {
    out.uv0 = FULL
    out.uv1 = FULL
    out.blend = 0
    return
  }
  let c = s.clamp ? Math.min(cycle, 0.99999) : cycle - Math.floor(cycle)
  if (!(c >= 0)) c = 0
  const time = c * s.total
  let acc = 0
  let i = 0
  for (; i < s.frames.length - 1; i++) {
    if (time < acc + s.frames[i].duration) break
    acc += s.frames[i].duration
  }
  const f = s.frames[i]
  const next = i + 1 < s.frames.length ? s.frames[i + 1] : s.clamp ? f : s.frames[0]
  out.uv0 = f.rect as [number, number, number, number]
  out.uv1 = next.rect as [number, number, number, number]
  out.blend = material!.blendFrames && f.duration > 0 ? clamp01((time - acc) / f.duration) : 0
}

/** Writes one particle born at `birth` (absolute seconds) and drawn at `t`, if it is alive. Returns 1 if drawn. */
function particleAt(sys: CompiledSystem, inst: EffectInstance, seed: number, k: number, birth: number, t: number, sink: ParticleSink): number {
  const a = t - birth
  if (a < 0) return 0
  if (!inst.cp(birth, cpBirth)) return 0
  rng.seed(hash32(seed, sys.index, k))
  initParticle(sys, cpBirth)
  const life = p.life
  if (!(a < life) || !(life > 0)) return 0
  const tau = a / life
  motion(sys, a, posA, velA)
  if (sys.lock && p.lockT > 0) {
    const until = Math.min(a, p.lockT)
    if (until > 0 && inst.cp(birth + until, cpLock)) {
      posA[0] += cpLock.pos.x - cpBirth.pos.x
      posA[1] += cpLock.pos.y - cpBirth.pos.y
      posA[2] += cpLock.pos.z - cpBirth.pos.z
    }
  }
  if (inst.surface && sys.collides) {
    const f = cpBirth.fwd
    const d = (posA[0] - cpBirth.pos.x) * f.x + (posA[1] - cpBirth.pos.y) * f.y + (posA[2] - cpBirth.pos.z) * f.z
    if (d < 0) {
      posA[0] -= f.x * d
      posA[1] -= f.y * d
      posA[2] -= f.z * d
    }
  }
  let radius = p.radius
  for (const o of sys.radiusOps) {
    if (tau < o.s) continue
    let w = o.e > o.s ? clamp01((tau - o.s) / (o.e - o.s)) : 1
    if (o.ease) w = spline(w)
    radius *= lerp(o.from, o.to, biasFn(w, o.bias))
  }
  let r = p.r, g = p.g, bl = p.b
  for (const o of sys.colorOps) {
    if (tau < o.s) continue
    let w = o.e > o.s ? clamp01((tau - o.s) / (o.e - o.s)) : 1
    if (o.ease) w = spline(w)
    r = lerp(r, o.color[0], w)
    g = lerp(g, o.color[1], w)
    bl = lerp(bl, o.color[2], w)
  }
  let alpha = p.alpha
  for (const o of sys.alphaOps) {
    let f = 1
    if (o.fie > o.fis && tau < o.fie) f = lerp(o.a0, 1, clamp01((tau - o.fis) / (o.fie - o.fis)))
    else if (tau > o.fos) f = o.foe > o.fos ? lerp(1, o.a1, clamp01((tau - o.fos) / (o.foe - o.fos))) : o.a1
    alpha *= f
  }
  for (const o of sys.alphaRandomOps) {
    const d = o.fadeIn ? lerp(o.inMin, o.inMax, 0.5) : lerp(o.outMin, o.outMax, 0.5)
    const age = o.proportional ? tau : a
    const span = o.proportional ? 1 : life
    if (o.fadeIn) alpha *= d > 0 ? clamp01(age / d) : 1
    else alpha *= d > 0 ? clamp01((span - age) / d) : 1
  }
  alpha *= inst.alpha ?? 1
  if (!(alpha > 0.002) || !(radius > 0.01)) return 0
  let rot = p.rot
  if (sys.rotBasic) rot += p.rotSpeed * a
  if (sys.spin) {
    const s = sys.spin
    if (s.stop > 0 && a > 0) {
      const ta = Math.min(a, s.stop)
      rot += s.rate * ta + ((s.min - s.rate) * ta * ta) / (2 * s.stop) + (a > s.stop ? s.min * (a - s.stop) : 0)
    } else rot += s.rate * a
  }
  out.x = posA[0]
  out.y = posA[1]
  out.z = posA[2]
  out.radius = radius
  out.rotation = rot
  out.r = r
  out.g = g
  out.b = bl
  out.a = alpha
  for (const rd of sys.renderers) {
    const cycle = rd.fit ? tau : rd.fps ? (a * rd.rate) / Math.max(1e-3, sheetSequence(sys.material, p.seq)?.total ?? 1) : a * rd.rate
    frameOf(sys.material, p.seq, cycle)
    if (rd.kind === 'trail') {
      const speed = Math.hypot(velA[0], velA[1], velA[2])
      if (!(speed > 1e-3)) continue
      let length = Math.min(Math.max(p.trail * speed, rd.minLen), rd.maxLen)
      if (rd.fadeIn > 0) length *= clamp01(a / rd.fadeIn)
      out.dx = velA[0] / speed
      out.dy = velA[1] / speed
      out.dz = velA[2] / speed
      out.length = length
    } else {
      out.dx = out.dy = out.dz = 0
      out.length = 0
    }
    sink.push(rd.batch, out)
  }
  return 1
}

/**
 * Pushes every particle of `inst` (its system and the children) alive at time t (seconds) into the sink and
 * returns how many particles were drawn; `budget` caps the count.
 */
export function evaluateEffect(compiled: CompiledParticles, inst: EffectInstance, t: number, sink: ParticleSink, budget = Infinity): number {
  const root = compiled.systems.get(inst.system)
  if (!root) return 0
  return evaluateSystem(root, inst, inst.start, t, sink, budget, 0)
}

function evaluateSystem(sys: CompiledSystem, inst: EffectInstance, base: number, t: number, sink: ParticleSink, budget: number, depth: number): number {
  let drawn = 0
  const ownEnd = Number.isFinite(sys.ownSpan) ? base + sys.ownSpan : inst.stop + sys.maxLife
  if (t >= base && t < ownEnd + 1e-6) {
    const seed = hash32(inst.seed, depth, sys.index)
    let k = 0
    for (const e of sys.instants) {
      const birth = base + e.at
      const count = Math.min(e.count, sys.max)
      if (t >= birth && t < birth + sys.maxLife) {
        for (let i = 0; i < count && drawn < budget; i++) drawn += particleAt(sys, inst, seed, k + i, birth, t, sink)
      }
      k += count
    }
    for (const e of sys.continuous) {
      if (!(e.rate > 0)) continue
      const start = base + e.start
      const finite = e.duration > 0
      let end = finite ? start + e.duration : Infinity
      if (inst.stop < end) end = inst.stop
      // a finite burst keeps its first max particles; an open stream is thinned to what max_particles allows
      const rate = finite ? e.rate : Math.min(e.rate, sys.max / sys.meanLife)
      const total = finite ? Math.min(sys.max, Math.ceil(e.duration * e.rate)) : Infinity
      const lo = Math.max(0, Math.ceil((t - sys.maxLife - start) * rate))
      const hiTime = Math.min(t, end)
      if (hiTime >= start) {
        const hi = Math.min(total - 1, Math.ceil((hiTime - start) * rate) - 1)
        for (let i = lo; i <= hi && drawn < budget; i++) {
          const birth = start + i / rate
          if (birth >= end || birth > t) break
          drawn += particleAt(sys, inst, seed, k + i, birth, t, sink)
        }
      }
      k += 1 << 20
    }
  }
  for (const ch of sys.children) {
    if (drawn >= budget) break
    drawn += evaluateSystem(ch.system, inst, base + ch.delay, t, sink, budget - drawn, depth + 1)
  }
  return drawn
}
