// TF2 particle effects from the asset pack (as/particles), the part packParticles.tsx loads on demand: explosions (TETFExplosion rows and building
// explosions), flamethrower streams and the trails of base rockets, pipes and stickies, played by the evaluator in
// src/assetpack/particles/ from the pack's systems.json. While the definitions and their textures are ready, the
// placeholders they replace (CombatFxLayer's explosion spheres and flame cones, the base ribbons and smoke puffs
// of Projectiles.tsx) stand down; without a pack, with assets.particles off or before the files load nothing here
// runs or requests anything (D21).
//
// Every effect is a pure function of the extras, the base caches and tickF: instance seeds come from the event row
// or instance index, birth times from the emitters, control points from base data at the birth time (D12).

import { useEffect, useMemo } from 'react'

import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'

import type { AsyncParser } from '@components/Analyse/Data/AsyncParser'
import { useInstance } from '@zus/store'
import { registerHlProbe } from '@highlander/debug'
import { HL } from '@highlander/extras/enums'
import { flagsAt } from '@highlander/extras/getters'
import { eventRange } from '@highlander/extras/track'
import type { HighlanderExtras } from '@highlander/extras/types'
import { getLoadedPackParticles, usePackParticleDefs, type PackParticles } from '@pack/particles/load'
import { ParticleRenderer } from '@pack/particles/render'
import {
  effectSpan,
  evaluateEffect,
  hash32,
  makeControlPoint,
  orientControlPoint,
  treeMaxLife,
  type CompiledParticles,
  type ControlPoint,
  type ControlPointSource,
  type EffectInstance,
  type ParticleOut,
  type ParticleSink,
} from '@pack/particles/sim'

import { readCombatSettings, type CombatSettings } from './combatData'
import { directionAt, drawEnd, positionAt, projectilesDrawnIn, projectileTeamAt } from './projectileData'
import { getProjectileSource, type ProjectileSource } from './projectileSource'
import { frameTime, readyExtras } from './time'
import { makePlayerView, playerViewAt, povCameraOwner, pyroMuzzle } from './view'

/** Particles drawn per frame at most. */
export const PARTICLE_BUDGET = 9000
/** Flames and airblasts of the player whose eyes the camera uses draw at this alpha (as the placeholders do). */
const OWN_EYES_ALPHA = 0.5
const FLARE_WEAPON_IDS = new Set([58, 84])
const NO_PARTICLE = 0xffff

export type PackEffectKind = 'explosion' | 'building' | 'flame' | 'trail'
export interface PackEffect extends EffectInstance {
  kind: PackEffectKind
  /** event row, flame manager or projectile instance */
  ref: number
}

// ─── which systems ───────────────────────────────────────────────────────────

const teamName = (team: number) => (team === 3 ? 'blue' : 'red')

/** TFExplosionCallback: a custom particle, else the flare, mid-air (no normal or a player hit) or wall effect. */
export function explosionSystem(x: HighlanderExtras, compiled: CompiledParticles, row: number): string | null {
  const ex = x.tempents.explosions
  const custom = ex.particle?.[row]
  if (custom !== undefined && custom !== NO_PARTICLE) {
    const name = x.strings.particles[custom]
    if (name && compiled.systems.has(name)) return name
  }
  const weapon = ex.weaponId[row]
  const midAir = (Math.abs(ex.nx[row]) < 0.05 && Math.abs(ex.ny[row]) < 0.05 && Math.abs(ex.nz[row]) < 0.05) || x.derived.entityToPlayer.has(ex.entity[row])
  const name = FLARE_WEAPON_IDS.has(weapon) ? 'ExplosionCore_MidAir_Flare' : midAir ? 'ExplosionCore_MidAir' : 'ExplosionCore_Wall'
  return compiled.systems.has(name) ? name : null
}

// ─── per-extras caches ───────────────────────────────────────────────────────

interface FlameRun { j: number; owner: number; start: number; end: number }
interface FlameRuns { runs: FlameRun[]; maxLength: number }
const flameRunCache = new WeakMap<HighlanderExtras, FlameRuns>()

/** Firing runs of every flame manager, sorted by start: [start, end) in ticks. */
function flameRuns(x: HighlanderExtras): FlameRuns {
  let cached = flameRunCache.get(x)
  if (cached) return cached
  const fl = x.flames
  const box = fl.box
  const runs: FlameRun[] = []
  for (let j = 0; j < fl.count; j++) {
    const lo = box.offsets[j], hi = box.offsets[j + 1]
    let start = -1
    for (let i = lo; i < hi; i++) {
      const firing = box.firing[i] !== 0
      if (firing && start < 0) start = box.ticks[i]
      else if (!firing && start >= 0) {
        runs.push({ j, owner: fl.owner[j], start, end: box.ticks[i] })
        start = -1
      }
    }
    if (start >= 0) {
      const deleted = fl.deleted[j]
      const end = deleted !== 0xffffffff ? deleted : hi > lo ? box.ticks[hi - 1] + 1 : start + 1
      runs.push({ j, owner: fl.owner[j], start, end: Math.max(end, start + 1) })
    }
  }
  runs.sort((a, b) => a.start - b.start || a.j - b.j)
  let maxLength = 0
  for (const r of runs) maxLength = Math.max(maxLength, r.end - r.start)
  cached = { runs, maxLength }
  flameRunCache.set(x, cached)
  return cached
}

const restCache = new WeakMap<HighlanderExtras, Map<number, number>>()
/** First tick a sticky lies still (its trail stops emitting there), else its draw end. */
function stickyRestTick(x: HighlanderExtras, j: number): number {
  let m = restCache.get(x)
  if (!m) restCache.set(x, (m = new Map()))
  const hit = m.get(j)
  if (hit !== undefined) return hit
  const pj = x.projectiles
  const n = pj.posCount[j]
  const p = pj.pos
  let rest = drawEnd(x, j)
  for (let s = 1; s < n; s++) {
    const i = (pj.posStart[j] + s) * 3
    const dx = p[i] - p[i - 3], dy = p[i + 1] - p[i - 2], dz = p[i + 2] - p[i - 1]
    if (dx * dx + dy * dy + dz * dz < 0.01) {
      rest = Math.min(rest, pj.created[j] + s)
      break
    }
  }
  m.set(j, rest)
  return rest
}

// ─── control points ──────────────────────────────────────────────────────────

const _view = makePlayerView()
const _dir = new THREE.Vector3()

function fixedPoint(px: number, py: number, pz: number, fx: number, fy: number, fz: number): ControlPointSource {
  const cp = orientControlPoint(makeControlPoint(), fx, fy, fz)
  cp.pos.set(px, py, pz)
  return (_t, out) => {
    out.pos.copy(cp.pos)
    out.fwd.copy(cp.fwd)
    out.left.copy(cp.left)
    out.up.copy(cp.up)
    return true
  }
}

/** The pyro's flame muzzle and view at birth (base data, quantized to 1/8 tick and memoised for the frame). */
function pyroPoint(demo: AsyncParser, p: number, ipt: number, memo: Map<number, ControlPoint | null>): ControlPointSource {
  return (t, out) => {
    const q = Math.round((t / ipt) * 8)
    let cp = memo.get(q)
    if (cp === undefined) {
      cp = null
      if (playerViewAt(demo, p, q / 8, _view) && _view.drawn && _view.alive) {
        cp = orientControlPoint(makeControlPoint(), _view.forward.x, _view.forward.y, _view.forward.z)
        pyroMuzzle(_view, cp.pos)
      }
      memo.set(q, cp)
    }
    if (!cp) return false
    out.pos.copy(cp.pos)
    out.fwd.copy(cp.fwd)
    out.left.copy(cp.left)
    out.up.copy(cp.up)
    return true
  }
}

/** A projectile's position and flight direction while it is drawn. */
function projectilePoint(x: HighlanderExtras, j: number, ipt: number, oriented: boolean): ControlPointSource {
  const created = x.projectiles.created[j]
  const end = drawEnd(x, j)
  return (t, out) => {
    const tickF = t / ipt
    if (tickF < created || tickF >= end) return false
    if (!positionAt(x, j, tickF, out.pos)) return false
    if (oriented) {
      directionAt(x, j, tickF, _dir)
      orientControlPoint(out, _dir.x, _dir.y, _dir.z)
    } else orientControlPoint(out, 1, 0, 0)
    return true
  }
}

// ─── effects at a time ───────────────────────────────────────────────────────

interface Spans { explosion: number; building: number; flame: number; trail: number }
const spanCache = new WeakMap<CompiledParticles, Spans>()
function spans(compiled: CompiledParticles): Spans {
  let s = spanCache.get(compiled)
  if (s) return s
  const span = (names: string[], f: (n: string) => number) => Math.max(0, ...names.map(n => (compiled.systems.has(n) ? f(n) : 0)))
  const sys = (n: string) => compiled.systems.get(n)!
  s = {
    explosion: span(['ExplosionCore_Wall', 'ExplosionCore_MidAir', 'ExplosionCore_MidAir_Flare'], n => effectSpan(sys(n))),
    building: span(['ExplosionCore_buildings'], n => effectSpan(sys(n))),
    flame: span(['flamethrower', 'flamethrower_blue', 'flamethrower_crit_red', 'flamethrower_crit_blue'], n => treeMaxLife(sys(n))),
    trail: span(['rockettrail', 'critical_rocket_red', 'critical_rocket_blue', 'pipebombtrail_red', 'pipebombtrail_blue', 'critical_pipe_red', 'critical_pipe_blue', 'stickybombtrail_red', 'stickybombtrail_blue', 'critical_grenade_red', 'critical_grenade_blue'], n => treeMaxLife(sys(n))),
  }
  spanCache.set(compiled, s)
  return s
}

const buildingIds = new WeakMap<HighlanderExtras, Set<number>>()

/**
 * The effect instances drawn at tickF, in a fixed order (explosions by row, building explosions, flame runs by
 * start, trails by instance). `memo` holds the frame's control-point samples.
 */
export function packEffectsAt(
  x: HighlanderExtras,
  demo: AsyncParser,
  source: ProjectileSource,
  compiled: CompiledParticles,
  tickF: number,
  settings: CombatSettings,
  ownEyes: number | null,
  memo: Map<number, Map<number, ControlPoint | null>> = new Map()
): PackEffect[] {
  const out: PackEffect[] = []
  const ipt = x.meta.intervalPerTick || 0.015
  const sp = spans(compiled)
  const tick = Math.floor(tickF)
  if (settings.explosions && x.meta.available.explosions) {
    const ex = x.tempents.explosions
    const life = Math.ceil(sp.explosion / ipt) + 1
    const [from, to] = eventRange(ex.tick, tick - life + 1, tick + 1)
    for (let i = from; i < to; i++) {
      const name = explosionSystem(x, compiled, i)
      if (!name) continue
      // VectorAngles(normal); a normal under 0.05 per axis is no normal (angles 0, forward +x)
      const flat = Math.abs(ex.nx[i]) < 0.05 && Math.abs(ex.ny[i]) < 0.05 && Math.abs(ex.nz[i]) < 0.05
      out.push({
        kind: 'explosion', ref: i, system: name, seed: hash32(i, ex.tick[i], 1), start: ex.tick[i] * ipt, stop: Infinity,
        cp: flat ? fixedPoint(ex.x[i], ex.y[i], ex.z[i], 1, 0, 0) : fixedPoint(ex.x[i], ex.y[i], ex.z[i], ex.nx[i], ex.ny[i], ex.nz[i]),
        surface: !flat && name === 'ExplosionCore_Wall',
      })
    }
  }
  if (settings.explosions && x.meta.available.particles && compiled.systems.has('ExplosionCore_buildings')) {
    let ids = buildingIds.get(x)
    if (!ids) {
      ids = new Set()
      x.strings.particles.forEach((name, i) => {
        if (name === 'ExplosionCore_buildings') ids!.add(i)
      })
      buildingIds.set(x, ids)
    }
    if (ids.size) {
      const pt = x.tempents.particles
      const life = Math.ceil(sp.building / ipt) + 1
      const [from, to] = eventRange(pt.tick, tick - life + 1, tick + 1)
      for (let i = from; i < to; i++) {
        if (!ids.has(pt.name[i])) continue
        out.push({ kind: 'building', ref: i, system: 'ExplosionCore_buildings', seed: hash32(i, pt.tick[i], 4), start: pt.tick[i] * ipt, stop: Infinity, cp: fixedPoint(pt.x[i], pt.y[i], pt.z[i], 0, 0, 1) })
      }
    }
  }
  if (settings.flames && x.meta.available.flames) {
    const { runs, maxLength } = flameRuns(x)
    const linger = Math.ceil(sp.flame / ipt) + 1
    // runs with start <= tick, newest first, back to those that may still have live particles
    let hi = runs.length
    let lo = 0
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (runs[mid].start <= tickF) lo = mid + 1
      else hi = mid
    }
    const list: FlameRun[] = []
    for (let k = lo - 1; k >= 0 && runs[k].start >= tick - maxLength - linger; k--) {
      const r = runs[k]
      if (r.end + linger < tickF || r.owner >= 255) continue
      list.push(r)
    }
    list.reverse()
    for (const r of list) {
      if (!playerViewAt(demo, r.owner, r.start, _view)) continue
      const crit = (flagsAt(x, r.owner, r.start) & HL.CRIT) !== 0
      const team = _view.team
      const name = crit ? `flamethrower_crit_${teamName(team)}` : team === 3 ? 'flamethrower_blue' : 'flamethrower'
      if (!compiled.systems.has(name)) continue
      let m = memo.get(r.owner)
      if (!m) memo.set(r.owner, (m = new Map()))
      const entityId = demo.entityPlayerMap.get(r.owner)?.user.entityId ?? 0
      out.push({
        kind: 'flame', ref: r.j, system: name, seed: hash32(r.j, r.start, 2), start: r.start * ipt, stop: r.end * ipt,
        cp: pyroPoint(demo, r.owner, ipt, m), alpha: ownEyes !== null && entityId === ownEyes ? OWN_EYES_ALPHA : 1,
      })
    }
  }
  if (x.meta.available.projectiles) {
    const linger = Math.ceil(sp.trail / ipt) + 1
    const pj = x.projectiles
    for (const j of projectilesDrawnIn(x, tick - linger, tick, [])) {
      if (!source.servedByBase[j]) continue
      const type = source.baseType[j]
      if (type !== 1 && type !== 2 && type !== 3) continue
      const end = drawEnd(x, j)
      const stopTick = type === 3 ? stickyRestTick(x, j) : end
      if (tickF >= stopTick + linger) continue
      const team = teamName(projectileTeamAt(x, j, Math.min(tick, end - 1)))
      const crit = pj.crit[j] !== 0
      const names = type === 1 ? ['rockettrail', crit ? `critical_rocket_${team}` : ''] : type === 2 ? [`pipebombtrail_${team}`, crit ? `critical_pipe_${team}` : ''] : [`stickybombtrail_${team}`, crit ? `critical_grenade_${team}` : '']
      const cp = projectilePoint(x, j, ipt, type === 1)
      names.forEach((name, n) => {
        if (!name || !compiled.systems.has(name)) return
        out.push({ kind: 'trail', ref: j, system: name, seed: hash32(j, pj.created[j], 3 + n * 16), start: pj.created[j] * ipt, stop: stopTick * ipt, cp })
      })
    }
  }
  return out
}

import { packParticlesDrawing, setPackParticleRenderer } from './packParticles'

interface FrameStats { tickF: number; effects: number; particles: number; dropped: number; batches: Record<string, number>; ms: number }
let lastFrame: FrameStats | null = null

// ─── the layer ───────────────────────────────────────────────────────────────

/** The lazily loaded part of PackParticlesLayer (packParticles.tsx): loads the definitions, then draws. */
export default function PackParticlesLoaded({ x, demo }: { x: HighlanderExtras; demo: AsyncParser }) {
  const defs = usePackParticleDefs(true)
  if (!defs) return null
  return <PackParticlesDraw x={x} demo={demo} defs={defs} />
}

const PackParticlesDraw = ({ x, demo, defs }: { x: HighlanderExtras; demo: AsyncParser; defs: PackParticles }) => {
  const gl = useThree(state => state.gl)
  const renderer = useMemo(() => new ParticleRenderer(defs.compiled, defs.file.materials, gl), [defs, gl])
  useEffect(() => {
    registerParticleProbe()
    setPackParticleRenderer(renderer)
    return () => {
      setPackParticleRenderer(null, renderer)
      renderer.dispose()
    }
  }, [renderer])
  const s = useMemo(() => ({ time: { tick: 0, tickF: 0 }, memo: new Map<number, Map<number, ControlPoint | null>>() }), [])

  useFrame(({ camera }) => {
    const t0 = performance.now()
    const { tickF } = frameTime(s.time)
    renderer.begin(camera)
    let effects = 0
    let particles = 0
    if (renderer.ready) {
      const ipt = x.meta.intervalPerTick || 0.015
      s.memo.clear()
      const list = packEffectsAt(x, demo, getProjectileSource(x, demo), defs.compiled, tickF, readCombatSettings(), povCameraOwner(), s.memo)
      effects = list.length
      const t = tickF * ipt
      for (const e of list) {
        if (particles >= PARTICLE_BUDGET) break
        particles += evaluateEffect(defs.compiled, e, t, renderer, PARTICLE_BUDGET - particles)
      }
    }
    renderer.end()
    lastFrame = { tickF, effects, particles, dropped: renderer.dropped, batches: renderer.counts(), ms: Math.round((performance.now() - t0) * 100) / 100 }
  })

  return <primitive object={renderer.group} />
}

// ─── probe ───────────────────────────────────────────────────────────────────

/** Hashes every particle it receives (rounded to 1/100), counting per batch. */
class DigestSink implements ParticleSink {
  h = 0x811c9dc5
  count = 0
  perBatch: Record<number, number> = {}
  private mix(v: number) {
    this.h = Math.imul(this.h ^ (Math.round(v * 100) | 0), 0x01000193) >>> 0
  }
  push(batch: number, p: ParticleOut) {
    this.count++
    this.perBatch[batch] = (this.perBatch[batch] ?? 0) + 1
    this.mix(batch)
    this.mix(p.x)
    this.mix(p.y)
    this.mix(p.z)
    this.mix(p.radius)
    this.mix(p.a * 1000)
    this.mix(p.length)
    this.mix(p.uv0[0] * 1000)
  }
}

/**
 * `particles.state(tick?)`: whether the pack particles draw, the effect instances at the tick with their particle
 * counts and a digest of every particle (identical for the same tick, D12), and the last drawn frame's stats.
 */
function particlesState(tick?: number) {
  const pack = getLoadedPackParticles()
  const x = readyExtras()
  const demo = useInstance.getState().parsedDemo
  const base = { loaded: !!pack, drawing: packParticlesDrawing(), lastFrame }
  if (!pack || !x || !demo) return { ...base, effects: [] }
  const tickF = typeof tick === 'number' && Number.isFinite(tick) ? tick : frameTime().tickF
  const ipt = x.meta.intervalPerTick || 0.015
  const list = packEffectsAt(x, demo, getProjectileSource(x, demo), pack.compiled, tickF, readCombatSettings(), povCameraOwner())
  const all = new DigestSink()
  const effects = list.map(e => {
    const one = new DigestSink()
    evaluateEffect(pack.compiled, e, tickF * ipt, one)
    evaluateEffect(pack.compiled, e, tickF * ipt, all)
    return { kind: e.kind, ref: e.ref, system: e.system, seed: e.seed, startTick: Math.round((e.start / ipt) * 100) / 100, stopTick: Number.isFinite(e.stop) ? Math.round((e.stop / ipt) * 100) / 100 : null, alpha: e.alpha ?? 1, particles: one.count, digest: one.h.toString(16) }
  })
  const batches: Record<string, number> = {}
  for (const [k, v] of Object.entries(all.perBatch)) batches[pack.compiled.batches[Number(k)]?.key ?? k] = v
  return { ...base, tickF, systems: pack.compiled.systems.size, effects, particles: all.count, batches, digest: all.h.toString(16) }
}

let probeRegistered = false
/** Registered once a pack with particles has loaded, so pages without one list the probes they always did. */
function registerParticleProbe() {
  if (probeRegistered) return
  probeRegistered = true
  registerHlProbe('particles.state', particlesState)
}
