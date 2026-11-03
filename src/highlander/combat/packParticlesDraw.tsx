// TF2 particle effects from the asset pack (as/particles, as/particles2), the part packParticles.tsx loads on
// demand: explosions (TETFExplosion rows and building explosions), flamethrower streams, the trails of base rockets,
// pipes and stickies, muzzle flashes, hitscan and sentry tracers, airblasts, the medigun's full-charge sparks and
// the crit-boost sparks on weapons, played by the evaluator in src/assetpack/particles/ from the pack's
// systems.json. While the definitions and their textures are ready and hold a system, the placeholder it replaces
// stands down (packDraws); without a pack, with assets.particles off or before the files load nothing here runs or
// requests anything (D21).
//
// Every effect is a pure function of the extras, the base caches and tickF: instance seeds come from the event row
// or instance index, birth times from the emitters, control points from base data at the birth time (D12).
// Effects on a weapon start at its muzzle (weaponAnchors.ts): the pack third-person weapon's attachment, a constant
// of the model, or in POV the drawn viewmodel's muzzle as an offset from the eye measured in the last frame.

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

import { getHlSetting } from '@highlander/extras/hooks'
import { byPlayerRange, trackIndexAt } from '@highlander/extras/track'
import type { Track } from '@highlander/extras/types'
import { itemKind } from '@highlander/items'
import { crouchScaleAt } from '@highlander/players/fxState'

import { hitscanAt, readCombatSettings, sentryTracersAt, type CombatSettings } from './combatData'
import { MUZZLE_SYSTEMS } from './packParticles'
import { directionAt, drawEnd, positionAt, projectilesDrawnIn, projectileTeamAt } from './projectileData'
import { getProjectileSource, type ProjectileSource } from './projectileSource'
import { frameTime, readyExtras } from './time'
import { gunMuzzle, makePlayerView, playerViewAt, povCameraOwner, pyroMuzzle, viewmodelMuzzleAt, type PlayerView } from './view'
import { thirdPersonAnchor } from './weaponAnchors'

/** Particles drawn per frame at most. */
export const PARTICLE_BUDGET = 9000
/** Flames and airblasts of the player whose eyes the camera uses draw at this alpha (TF2 draws them in full). */
const OWN_EYES_ALPHA = 1
const FLARE_WEAPON_IDS = new Set([58, 84])
const NO_PARTICLE = 0xffff

export type PackEffectKind = 'explosion' | 'building' | 'flame' | 'trail' | 'muzzle' | 'tracer' | 'airblast' | 'charge' | 'crit'
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

/** The drawn viewmodel's muzzle as an offset from the eye along the base view axes (forward, right, up). */
export interface PovAnchor { entityId: number; f: number; r: number; u: number }

/**
 * Where a weapon effect sits: 'flame' (flamethrower: flames, airblast), 'gun' (muzzle flashes of the fired weapon),
 * 'medigun' (full charge) or 'crit' (the held weapon's centre, oriented by the body yaw).
 */
export type AnchorKind = 'flame' | 'gun' | 'medigun' | 'crit'
const ANCHOR_INDEX: Record<AnchorKind, number> = { flame: 0, gun: 1, medigun: 2, crit: 3 }
const acceptFlame = (def: number) => itemKind(def) === 'flamethrower'
const acceptMedigun = (def: number) => itemKind(def) === 'medigun'
const acceptAny = () => true

/** Writes the anchor of player p (view in `view`, base data at tickF) into cp; false when none. */
function anchorAt(x: HighlanderExtras, demo: AsyncParser, view: PlayerView, tickF: number, kind: AnchorKind, accept: (def: number) => boolean, pov: PovAnchor | null, cp: ControlPoint): boolean {
  const f = view.forward
  if (pov && kind !== 'crit' && pov.entityId === view.entityId) {
    orientControlPoint(cp, f.x, f.y, f.z)
    cp.pos.copy(view.pos).addScaledVector(f, pov.f).addScaledVector(view.right, pov.r).addScaledVector(view.up, pov.u)
    cp.pos.z += view.eye
    return true
  }
  const a = thirdPersonAnchor(view.entityId, accept)
  const local = a ? (kind === 'crit' ? a.center : a.muzzle) : null
  const yaw = (view.yaw * Math.PI) / 180
  const c = Math.cos(yaw), s = Math.sin(yaw)
  if (kind === 'crit') orientControlPoint(cp, c, s, 0)
  else orientControlPoint(cp, f.x, f.y, f.z)
  if (local) {
    // the playerBody frame: feet origin, turned by the yaw, z scaled by the crouch
    const scaleZ = crouchScaleAt(x, demo, view.p, Math.floor(tickF))
    cp.pos.set(view.pos.x + c * local.x - s * local.y, view.pos.y + s * local.x + c * local.y, view.pos.z + local.z * scaleZ)
    return true
  }
  if (kind === 'flame' || kind === 'medigun') pyroMuzzle(view, cp.pos)
  else gunMuzzle(view, cp.pos)
  // the crit box centre: half a weapon back from the muzzle
  if (kind === 'crit') cp.pos.set(cp.pos.x - c * CRIT_BOX[0], cp.pos.y - s * CRIT_BOX[0], cp.pos.z)
  return true
}

/**
 * A player's weapon anchor at birth (base data, quantized to 1/8 tick and memoised for the frame); no particles
 * are born while he is not drawn or dead.
 */
function playerPoint(x: HighlanderExtras, demo: AsyncParser, p: number, ipt: number, memos: Map<number, Map<number, ControlPoint | null>>, kind: AnchorKind, pov: PovAnchor | null, accept: (def: number) => boolean = acceptAny): ControlPointSource {
  const key = p * 4 + ANCHOR_INDEX[kind]
  let memo = memos.get(key)
  if (!memo) memos.set(key, (memo = new Map()))
  const m = memo
  return (t, out) => {
    const q = Math.round((t / ipt) * 8)
    let cp = m.get(q)
    if (cp === undefined) {
      cp = null
      if (playerViewAt(demo, p, q / 8, _view) && _view.drawn && _view.alive) {
        cp = makeControlPoint()
        if (!anchorAt(x, demo, _view, q / 8, kind, accept, pov, cp)) cp = null
      }
      m.set(q, cp)
    }
    if (!cp) return false
    out.pos.copy(cp.pos)
    out.fwd.copy(cp.fwd)
    out.left.copy(cp.left)
    out.up.copy(cp.up)
    return true
  }
}

const _pov = makePlayerView()
const _vm = new THREE.Vector3()

/** The POV owner's viewmodel muzzle as an offset from his base eye at tickF, rounded to 1/4 unit; null: none. */
export function measurePovAnchor(demo: AsyncParser, ownEyes: number | null, tickF: number): PovAnchor | null {
  if (ownEyes === null || !viewmodelMuzzleAt(ownEyes, _vm)) return null
  const p = demo.playerIndexOfEntity(ownEyes)
  if (!(p >= 0) || !playerViewAt(demo, p, tickF, _pov)) return null
  _vm.sub(_pov.pos)
  _vm.z -= _pov.eye
  const q = (v: number) => Math.round(v * 4) / 4
  return { entityId: ownEyes, f: q(_vm.dot(_pov.forward)), r: q(_vm.dot(_pov.right)), u: q(_vm.dot(_pov.up)) }
}

// ─── runs of a per-player track state ────────────────────────────────────────

interface Run { p: number; start: number; end: number }
interface Runs { runs: Run[]; maxLength: number }
const runCache = new WeakMap<HighlanderExtras, Map<string, Runs>>()

/** Runs [start, end) of the entries of track t that pass `test`, per player, sorted by start (end Infinity: open). */
function trackRuns(x: HighlanderExtras, name: string, t: Track, test: (i: number) => boolean): Runs {
  let m = runCache.get(x)
  if (!m) runCache.set(x, (m = new Map()))
  const hit = m.get(name)
  if (hit) return hit
  const runs: Run[] = []
  const players = t.offsets.length - 1
  for (let p = 0; p < players; p++) {
    let start = -1
    for (let i = t.offsets[p]; i < t.offsets[p + 1]; i++) {
      const on = test(i)
      if (on && start < 0) start = t.ticks[i]
      else if (!on && start >= 0) {
        runs.push({ p, start, end: t.ticks[i] })
        start = -1
      }
    }
    if (start >= 0) runs.push({ p, start, end: Infinity })
  }
  runs.sort((a, b) => a.start - b.start || a.p - b.p)
  let maxLength = 0
  for (const r of runs) if (Number.isFinite(r.end)) maxLength = Math.max(maxLength, r.end - r.start)
  const out = { runs, maxLength }
  m.set(name, out)
  return out
}

/** Runs alive at tickF (started, and ended less than `linger` ticks ago), in start order. */
function runsAt({ runs }: Runs, tickF: number, linger: number): Run[] {
  const out: Run[] = []
  for (const r of runs) {
    if (r.start > tickF) break
    if (r.end + linger >= tickF) out.push(r)
  }
  return out
}

/** Fire rows of miniguns closer than this many ticks belong to one firing run. */
const MINIGUN_RUN_GAP = 8
const minigunRunCache = new WeakMap<HighlanderExtras, Runs>()

/** Firing runs of miniguns from the players.fire rows: [first shot, last shot + MINIGUN_RUN_GAP / 2). */
function minigunRuns(x: HighlanderExtras): Runs {
  const hit = minigunRunCache.get(x)
  if (hit) return hit
  const fire = x.players.fire
  const open = new Map<number, Run>()
  const runs: Run[] = []
  for (let i = 0; i < fire.tick.length; i++) {
    if (itemKind(fire.weaponDef[i]) !== 'minigun') continue
    const p = fire.player[i]
    const t = fire.tick[i]
    const r = open.get(p)
    if (r && t - (r.end - MINIGUN_RUN_GAP / 2) <= MINIGUN_RUN_GAP) r.end = t + MINIGUN_RUN_GAP / 2
    else {
      const run = { p, start: t, end: t + MINIGUN_RUN_GAP / 2 }
      runs.push(run)
      open.set(p, run)
    }
  }
  runs.sort((a, b) => a.start - b.start || a.p - b.p)
  let maxLength = 0
  for (const r of runs) maxLength = Math.max(maxLength, r.end - r.start)
  const out = { runs, maxLength }
  minigunRunCache.set(x, out)
  return out
}

// ─── airblast onsets ─────────────────────────────────────────────────────────

/**
 * Airblast onsets of flamethrower holders within `window` ticks before tickF: ATTACK_SECONDARY anim events and
 * rising edges of wstate.state 3, one onset per airblast (edges within 4 ticks of an anim event merge).
 */
function airblastOnsets(x: HighlanderExtras, tickF: number, window: number): { p: number; tick: number }[] {
  const out: { p: number; tick: number }[] = []
  if (!x.meta.available.weapon || !(x.meta.available.wstate || x.meta.available.anim)) return out
  const tick = Math.floor(tickF)
  const from = Math.floor(tickF - window) + 1
  const w = x.players.weapon
  const ws = x.players.wstate
  const anim = x.players.anim
  for (let p = 0; p < x.players.count; p++) {
    const onsets: number[] = []
    if (x.meta.available.anim) {
      for (const k of byPlayerRange(x.derived.animByPlayer, anim, p, from, tick + 1)) if (anim.event[k] === 1) onsets.push(anim.tick[k])
    }
    if (x.meta.available.wstate) {
      const lo = ws.offsets[p]
      for (let i = trackIndexAt(ws, p, tick); i >= lo && i >= 0 && ws.ticks[i] >= from; i--) {
        if (ws.state[i] === 3 && (i === lo || ws.state[i - 1] !== 3) && !onsets.some(o => Math.abs(o - ws.ticks[i]) <= 4)) onsets.push(ws.ticks[i])
      }
    }
    for (const t of onsets.sort((a, b) => a - b)) {
      const wi = trackIndexAt(w, p, t)
      if (wi >= 0 && itemKind(w.def[wi]) === 'flamethrower') out.push({ p, tick: t })
    }
  }
  return out
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

interface Spans { explosion: number; building: number; flame: number; trail: number; muzzle: number; tracer: number; airblast: number; charge: number; crit: number }
const TRACER_FAMILIES = ['bullet_tracer01', 'bullet_scattergun_tracer01', 'bullet_shotgun_tracer01', 'bullet_pistol_tracer01']
const TRACER_SYSTEMS = TRACER_FAMILIES.flatMap(f => [`${f}_red`, `${f}_blue`, `${f}_red_crit`, `${f}_blue_crit`])
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
    muzzle: span(Object.values(MUZZLE_SYSTEMS), n => (n === MUZZLE_SYSTEMS.minigun ? treeMaxLife(sys(n)) : effectSpan(sys(n)))),
    tracer: span(TRACER_SYSTEMS, n => treeMaxLife(sys(n))),
    airblast: span(['pyro_blast'], n => effectSpan(sys(n))),
    charge: span(['medicgun_invulnstatus_fullcharge_red', 'medicgun_invulnstatus_fullcharge_blue'], n => treeMaxLife(sys(n))),
    crit: span(['critgun_weaponmodel_red', 'critgun_weaponmodel_blu'], n => treeMaxLife(sys(n))),
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
  memo: Map<number, Map<number, ControlPoint | null>> = new Map(),
  pov: PovAnchor | null = null
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
      const entityId = demo.entityPlayerMap.get(r.owner)?.user.entityId ?? 0
      out.push({
        kind: 'flame', ref: r.j, system: name, seed: hash32(r.j, r.start, 2), start: r.start * ipt, stop: r.end * ipt,
        cp: playerPoint(x, demo, r.owner, ipt, memo, 'flame', pov, acceptFlame), alpha: ownEyes !== null && entityId === ownEyes ? OWN_EYES_ALPHA : 1,
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
  if (settings.tracers) {
    // muzzle flashes of the fired weapon (the POV owner's own flash is the viewmodel's)
    if (x.meta.available.fire && sp.muzzle > 0) {
      const fire = x.players.fire
      const life = Math.ceil(sp.muzzle / ipt) + 1
      const [from, to] = eventRange(fire.tick, tick - life + 1, tick + 1)
      for (let i = from; i < to; i++) {
        const name = MUZZLE_SYSTEMS[itemKind(fire.weaponDef[i])]
        if (!name || name === MUZZLE_SYSTEMS.minigun || !compiled.systems.has(name)) continue
        const p = fire.player[i]
        if (ownEyes !== null && demo.entityPlayerMap.get(p)?.user.entityId === ownEyes) continue
        const def = fire.weaponDef[i]
        const kind = itemKind(def)
        out.push({ kind: 'muzzle', ref: i, system: name, seed: hash32(i, fire.tick[i], 6), start: fire.tick[i] * ipt, stop: Infinity, cp: playerPoint(x, demo, p, ipt, memo, 'gun', pov, d => itemKind(d) === kind) })
      }
    }
    // the minigun's looping flash over each firing run
    const minigun = MUZZLE_SYSTEMS.minigun
    if (x.meta.available.fire && compiled.systems.has(minigun)) {
      const linger = Math.ceil(sp.muzzle / ipt) + 1
      for (const r of runsAt(minigunRuns(x), tickF, linger)) {
        if (ownEyes !== null && demo.entityPlayerMap.get(r.p)?.user.entityId === ownEyes) continue
        out.push({ kind: 'muzzle', ref: r.p, system: minigun, seed: hash32(r.p, r.start, 11), start: r.start * ipt, stop: r.end * ipt, cp: playerPoint(x, demo, r.p, ipt, memo, 'gun', pov, d => itemKind(d) === 'minigun') })
      }
    }
    // hitscan tracers, one per pellet, from the bullet origin (the POV owner's from his viewmodel muzzle)
    if (sp.tracer > 0) {
      const life = Math.ceil(sp.tracer / ipt) + 1
      const w = x.players.weapon
      for (const t of hitscanAt(x, demo, tickF, null, undefined, life)) {
        const p = t.player
        const wi = p < 255 ? trackIndexAt(w, p, t.tick) : -1
        const kind = wi >= 0 ? itemKind(w.def[wi]) : ''
        const family = kind === 'scattergun' ? 'bullet_scattergun_tracer01' : kind === 'shotgun' ? 'bullet_shotgun_tracer01' : kind === 'pistol' ? 'bullet_pistol_tracer01' : 'bullet_tracer01'
        const team = p < 255 && demo.entityPlayerMap.has(p) ? demo.playerCache.metaCache.getMeta(p, Math.min(t.tick, demo.ticks - 1)).teamId : 2
        const name = `${family}_${teamName(team)}${t.crit ? '_crit' : ''}`
        if (!compiled.systems.has(name)) continue
        let sx = t.start[0], sy = t.start[1], sz = t.start[2]
        if (pov && p < 255 && demo.entityPlayerMap.get(p)?.user.entityId === pov.entityId && playerViewAt(demo, p, t.tick, _view)) {
          const cp = makeControlPoint()
          anchorAt(x, demo, _view, t.tick, 'gun', acceptAny, pov, cp)
          sx = cp.pos.x
          sy = cp.pos.y
          sz = cp.pos.z
        }
        t.ends.forEach((e, k) => {
          out.push({
            kind: 'tracer', ref: t.row * 16 + k, system: name, seed: hash32(t.row, k, 5), start: t.tick * ipt, stop: Infinity,
            cp: fixedPoint(sx, sy, sz, e[0] - sx, e[1] - sy, e[2] - sz), cp1: fixedPoint(e[0], e[1], e[2], sx - e[0], sy - e[1], sz - e[2]),
          })
        })
      }
      for (const t of sentryTracersAt(x, tickF, life)) {
        const team = x.buildings.team[t.sentry]
        const name = `bullet_tracer01_${teamName(team)}`
        if (!compiled.systems.has(name)) continue
        const [sx, sy, sz] = t.start
        const [ex, ey, ez] = t.end
        out.push({
          kind: 'tracer', ref: -1 - t.row, system: name, seed: hash32(t.row, t.tick, 7), start: t.tick * ipt, stop: Infinity,
          cp: fixedPoint(sx, sy, sz, ex - sx, ey - sy, ez - sz), cp1: fixedPoint(ex, ey, ez, sx - ex, sy - ey, sz - ez),
        })
      }
    }
  }
  if (settings.airblast && sp.airblast > 0 && compiled.systems.has('pyro_blast')) {
    for (const a of airblastOnsets(x, tickF, Math.ceil(sp.airblast / ipt) + 1)) {
      const entityId = demo.entityPlayerMap.get(a.p)?.user.entityId ?? 0
      out.push({
        kind: 'airblast', ref: a.p, system: 'pyro_blast', seed: hash32(a.p, a.tick, 8), start: a.tick * ipt, stop: Infinity,
        cp: playerPoint(x, demo, a.p, ipt, memo, 'flame', pov, acceptFlame), alpha: ownEyes !== null && entityId === ownEyes ? OWN_EYES_ALPHA : 1,
      })
    }
  }
  const conditions = getHlSetting<boolean>('players.conditions') !== false
  // the medigun's full-charge sparks (C_WeaponMedigun: charged, not released, not holstered)
  if (conditions && getHlSetting<boolean>('players.fxUber') !== false && x.meta.available.medigun && sp.charge > 0) {
    const mg = x.players.medigun
    const runs = trackRuns(x, 'charge', mg, i => mg.def[i] !== 0xffff && mg.charge[i] >= 1000 && (mg.flags[i] & (4 | 8)) === 0)
    for (const r of runsAt(runs, tickF, Math.ceil(sp.charge / ipt) + 1)) {
      if (!playerViewAt(demo, r.p, r.start, _view)) continue
      const name = `medicgun_invulnstatus_fullcharge_${teamName(_view.team)}`
      if (!compiled.systems.has(name)) continue
      out.push({ kind: 'charge', ref: r.p, system: name, seed: hash32(r.p, r.start, 9), start: r.start * ipt, stop: r.end * ipt, cp: playerPoint(x, demo, r.p, ipt, memo, 'medigun', pov, acceptMedigun) })
    }
  }
  // crit-boost sparks on the held weapon (not on the POV owner's own viewmodel)
  if (conditions && getHlSetting<boolean>('players.fxCrit') !== false && x.meta.available.cond && sp.crit > 0) {
    const flags = x.derived.flags
    const runs = trackRuns(x, 'crit', x.players.cond, i => (flags[i] & HL.CRIT) !== 0)
    for (const r of runsAt(runs, tickF, Math.ceil(sp.crit / ipt) + 1)) {
      if (!playerViewAt(demo, r.p, r.start, _view)) continue
      if (ownEyes !== null && _view.entityId === ownEyes) continue
      const name = `critgun_weaponmodel_${team3(_view.team)}`
      if (!compiled.systems.has(name)) continue
      const a = thirdPersonAnchor(_view.entityId, acceptAny)
      out.push({
        kind: 'crit', ref: r.p, system: name, seed: hash32(r.p, r.start, 10), start: r.start * ipt, stop: r.end * ipt,
        cp: playerPoint(x, demo, r.p, ipt, memo, 'crit', null), box: a ? [a.half.x, a.half.y, a.half.z] : CRIT_BOX,
      })
    }
  }
  return out
}

/** The crit system's team suffix ('blu', as in critgun_weaponmodel_blu). */
const team3 = (team: number) => (team === 3 ? 'blu' : 'red')
/** Half extents of the held weapon stand-in without a pack third-person weapon (forward, left, up). */
const CRIT_BOX: [number, number, number] = [12, 3, 3]

import { packParticlesDrawing, setPackParticleRenderer } from './packParticles'

interface FrameStats { tickF: number; effects: number; particles: number; dropped: number; batches: Record<string, number>; ms: number }
let lastFrame: FrameStats | null = null
/** The POV anchor measured in the last drawn frame (the probe reads the same one). */
let lastPov: PovAnchor | null = null

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
    const state = {
      get ready() {
        return renderer.ready
      },
      systems: defs.compiled.systems,
    }
    setPackParticleRenderer(state)
    return () => {
      setPackParticleRenderer(null, state)
      renderer.dispose()
      lastPov = null
    }
  }, [renderer, defs])
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
      const ownEyes = povCameraOwner()
      lastPov = measurePovAnchor(demo, ownEyes, tickF)
      const list = packEffectsAt(x, demo, getProjectileSource(x, demo), defs.compiled, tickF, readCombatSettings(), ownEyes, s.memo, lastPov)
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
  const list = packEffectsAt(x, demo, getProjectileSource(x, demo), pack.compiled, tickF, readCombatSettings(), povCameraOwner(), new Map(), lastPov)
  const all = new DigestSink()
  const effects = list.map(e => {
    const one = new DigestSink()
    evaluateEffect(pack.compiled, e, tickF * ipt, one)
    evaluateEffect(pack.compiled, e, tickF * ipt, all)
    return { kind: e.kind, ref: e.ref, system: e.system, seed: e.seed, box: e.box, startTick: Math.round((e.start / ipt) * 100) / 100, stopTick: Number.isFinite(e.stop) ? Math.round((e.stop / ipt) * 100) / 100 : null, alpha: e.alpha ?? 1, particles: one.count, digest: one.h.toString(16) }
  })
  const batches: Record<string, number> = {}
  for (const [k, v] of Object.entries(all.perBatch)) batches[pack.compiled.batches[Number(k)]?.key ?? k] = v
  return { ...base, tickF, systems: pack.compiled.systems.size, pov: lastPov, effects, particles: all.count, batches, digest: all.h.toString(16) }
}

let probeRegistered = false
/** Registered once a pack with particles has loaded, so pages without one list the probes they always did. */
function registerParticleProbe() {
  if (probeRegistered) return
  probeRegistered = true
  registerHlProbe('particles.state', particlesState)
}
