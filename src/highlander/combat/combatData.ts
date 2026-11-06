// What CombatFxLayer draws at a tick (contract 5 F3), as plain descriptors. Every function is a pure function of
// (extras, base caches, tickF) plus a view resolver for player-attached effects, so the layer and the `combat.fx`
// probe agree and a seek always reproduces the same effects (D12). Event effects use age = tickF - eventTick and
// exist while 0 <= age < lifetime (section 1.2).

import * as THREE from 'three'

import type { AsyncParser } from '@components/Analyse/Data/AsyncParser'
import { TEAM_FX, TEAM_TRAIL, NEUTRAL, teamKey } from '@highlander/constants'
import { itemKind } from '@highlander/items'
import { getHlSetting } from '@highlander/extras/hooks'
import { byPlayerRange, eventRange, sinceTick, trackIndexAt, xformAt } from '@highlander/extras/track'
import type { HighlanderExtras } from '@highlander/extras/types'
import { sentryMuzzleAt, tracerBarrel } from '@highlander/buildings/render'
import { packMuzzleOf } from '@highlander/buildings/pack'

import { hash } from './time'
import { deflectIndexAt, directionAt, flamesAliveAt, positionAt, projectilesDrawnAt, projectileTeamAt } from './projectileData'
import type { ProjectileSource } from './projectileSource'
import { despawnExplosionsAt, type DespawnExplosion } from './trails'
import { gunMuzzle, makePlayerView, ownMuzzleAt, pyroMuzzle, setViewVectors, type PlayerView } from './view'

export type Vec3 = [number, number, number]
/** Resolves player p's view at tickF (base data for probes, drawn actor position for rendering). */
export type ViewResolver = (p: number, tickF: number, out: PlayerView) => boolean

const DEG = Math.PI / 180
const r2 = (v: number) => Math.round(v * 100) / 100
const vec = (v: THREE.Vector3): Vec3 => [r2(v.x), r2(v.y), r2(v.z)]
const teamFx = (team: number) => {
  const key = teamKey(team)
  return key ? TEAM_FX[key] : NEUTRAL
}

/** Event rows with 0 <= tickF - tick < lifetime: [start, end) of a sorted tick list. */
export function eventWindow(ticks: Uint32Array, tickF: number, lifetime: number): [number, number] {
  return eventRange(ticks, Math.floor(tickF - lifetime) + 1, Math.floor(tickF) + 1)
}

// ─── Explosions ───────────────────────────────────────────────────────────────

export const EXPLOSION_TICKS = 14
export const BUILDING_EXPLOSION_TICKS = 16
export const BUILDING_EXPLOSION_RADIUS = 140
export const SCORCH_TICKS = 200
const FLARE_WEAPON_IDS = new Set([58, 84])

/** Explosion radius by TF_WEAPON_ID (contract 5 F3). */
export function explosionRadius(weaponId: number): number {
  if (weaponId === 22 || weaponId === 65 || weaponId === 79 || weaponId === 55) return 110
  if (weaponId === 23 || weaponId === 24 || weaponId === 35 || weaponId === 53 || weaponId === 91) return 100
  if (FLARE_WEAPON_IDS.has(weaponId)) return 28
  return 70
}

export interface ExplosionFx { row: number; tick: number; age: number; weaponId: number; pos: Vec3; maxRadius: number; radius: number; opacity: number; color: string; source: 'explosion' | 'building' }
export interface ScorchFx { row: number; tick: number; age: number; pos: Vec3; normal: Vec3; radius: number; opacity: number }

function burst(a: number, maxRadius: number) {
  return { radius: maxRadius * (1 - (1 - a) ** 3), opacity: 0.5 * (1 - a) }
}

export function explosionsAt(x: HighlanderExtras, tickF: number): ExplosionFx[] {
  const ex = x.tempents.explosions
  const out: ExplosionFx[] = []
  if (!x.meta.available.explosions) return out
  const [from, to] = eventWindow(ex.tick, tickF, EXPLOSION_TICKS)
  for (let i = from; i < to; i++) {
    const age = tickF - ex.tick[i]
    if (age < 0 || age >= EXPLOSION_TICKS) continue
    const maxRadius = explosionRadius(ex.weaponId[i])
    const { radius, opacity } = burst(age / EXPLOSION_TICKS, maxRadius)
    out.push({
      row: i, tick: ex.tick[i], age, weaponId: ex.weaponId[i], pos: [ex.x[i], ex.y[i], ex.z[i]], maxRadius, radius, opacity,
      color: FLARE_WEAPON_IDS.has(ex.weaponId[i]) ? '#ff6a1a' : '#ff9a4a', source: 'explosion',
    })
  }
  return out
}

/** Dark discs where an explosion hit the world (entity 0) on a floor or ceiling (|normal.z| > 0.7). */
export function scorchesAt(x: HighlanderExtras, tickF: number): ScorchFx[] {
  const ex = x.tempents.explosions
  const out: ScorchFx[] = []
  if (!x.meta.available.explosions) return out
  const [from, to] = eventWindow(ex.tick, tickF, SCORCH_TICKS)
  for (let i = from; i < to; i++) {
    if (ex.entity[i] !== 0 || !(Math.abs(ex.nz[i]) > 0.7)) continue
    const age = tickF - ex.tick[i]
    if (age < 0 || age >= SCORCH_TICKS) continue
    out.push({
      row: i, tick: ex.tick[i], age, pos: [ex.x[i], ex.y[i], ex.z[i]], normal: [ex.nx[i], ex.ny[i], ex.nz[i]],
      radius: 0.4 * explosionRadius(ex.weaponId[i]), opacity: 0.35 * (1 - age / SCORCH_TICKS),
    })
  }
  return out
}

const buildingParticleIds = new WeakMap<HighlanderExtras, Set<number>>()

/** `particles` rows named ExplosionCore_buildings, as explosions with R 140. */
export function buildingExplosionsAt(x: HighlanderExtras, tickF: number): ExplosionFx[] {
  const out: ExplosionFx[] = []
  if (!x.meta.available.particles) return out
  let ids = buildingParticleIds.get(x)
  if (!ids) {
    ids = new Set()
    x.strings.particles.forEach((name, i) => {
      if (name === 'ExplosionCore_buildings') ids!.add(i)
    })
    buildingParticleIds.set(x, ids)
  }
  if (ids.size === 0) return out
  const pt = x.tempents.particles
  const [from, to] = eventWindow(pt.tick, tickF, BUILDING_EXPLOSION_TICKS)
  for (let i = from; i < to; i++) {
    if (!ids.has(pt.name[i])) continue
    const age = tickF - pt.tick[i]
    if (age < 0 || age >= BUILDING_EXPLOSION_TICKS) continue
    const { radius, opacity } = burst(age / BUILDING_EXPLOSION_TICKS, BUILDING_EXPLOSION_RADIUS)
    out.push({
      row: i, tick: pt.tick[i], age, weaponId: 0, pos: [pt.x[i], pt.y[i], pt.z[i]], maxRadius: BUILDING_EXPLOSION_RADIUS,
      radius, opacity, color: '#ff9a4a', source: 'building',
    })
  }
  return out
}

// ─── Hitscan and sentry tracers ───────────────────────────────────────────────

export const TRACER_TICKS = 4
export const SENTRY_TRACER_TICKS = 3
export const TRACER_WIDTH = 1.2
export const TRACER_COLOR = '#fff2b3'
const PELLETS_10 = new Set([12, 13, 14, 15, 16, 69, 76, 85])
const SNIPER_IDS = new Set([17, 77, 99])
/** tf_fx_shared.cpp fixed spread (contract Appendix B.5). */
const FIXED_SPREAD: [number, number][] = [[0, 0], [1, 0], [-1, 0], [0, -1], [0, 1], [0.85, -0.85], [0.85, 0.85], [-0.85, -0.85], [-0.85, 0.85], [0, 0]]
const HIT_CONE_COS = Math.cos(8 * DEG)
const VICTIM_CENTRE_Z = 41

export function pelletCount(weaponId: number): number {
  return PELLETS_10.has(weaponId) ? 10 : weaponId === 71 ? 4 : 1
}

export interface TracerFx {
  row: number; tick: number; age: number; player: number; weaponId: number; crit: boolean
  start: Vec3; ends: Vec3[]; length: number; victim: number; opacity: number; color: string; anglesFrom: 'base' | 'tempent'
}

const _view = makePlayerView()
const _ownView = makePlayerView()
const _ownMuzzle = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _end = new THREE.Vector3()
const _start = new THREE.Vector3()
const _to = new THREE.Vector3()

/**
 * TEFireBullets rows with age < 4: from the bullet origin along the shooter's base view angles at that tick (the
 * tempent angles are quantised to 2.8 degrees), one line per pellet, to the victim centre when a player_hurt of the
 * same tick and attacker lies within 8 degrees of the centre pellet, else 1500 units (4000 for sniper rifles).
 * `ownEyes`: the entity id of the actor whose povCamera renders the scene; his tracers start at his gun muzzle.
 */
export function hitscanAt(x: HighlanderExtras, demo: AsyncParser, tickF: number, ownEyes: number | null = null, resolve?: ViewResolver, lifetime = TRACER_TICKS): TracerFx[] {
  const b = x.tempents.bullets
  const out: TracerFx[] = []
  if (!x.meta.available.bullets) return out
  const [from, to] = eventWindow(b.tick, tickF, lifetime)
  const hurts = x.hurts
  for (let i = from; i < to; i++) {
    const tick = b.tick[i]
    const age = tickF - tick
    if (age < 0 || age >= lifetime) continue
    const p = b.player[i]
    const weaponId = b.weaponId[i]
    const crit = b.crit[i] !== 0

    // direction: base view angles of the shooter at that tick, else the tempent's own angles
    let anglesFrom: 'base' | 'tempent' = 'tempent'
    const angles = p < 255 && demo.entityPlayerMap.has(p) ? demo.playerCache.viewAnglesCache.getAngles(p, Math.min(tick, demo.ticks - 1)) : null
    if (angles && !(angles.x === 0 && angles.y === 0 && angles.z === 0)) {
      setViewVectors(_view, angles.x, angles.y)
      anglesFrom = 'base'
    } else setViewVectors(_view, b.pitch[i], b.yaw[i])
    _start.set(b.x[i], b.y[i], b.z[i])
    const forward = _view.forward

    // victim: a hurt row of this tick and attacker within 8 degrees of the centre pellet
    let length = SNIPER_IDS.has(weaponId) ? 4000 : 1500
    let victim = -1
    if (p < 255 && hurts.tick.length > 0) {
      let best = HIT_CONE_COS
      for (const h of byPlayerRange(x.derived.hurtsByAttacker, hurts, p, tick, tick + 1)) {
        const v = hurts.victim[h]
        if (!demo.entityPlayerMap.has(v)) continue
        const vp = demo.playerCache.positionCache.getPosition(v, Math.min(tick, demo.ticks - 1))
        _to.set(vp.x, vp.y, vp.z + VICTIM_CENTRE_Z).sub(_start)
        const dist = _to.length()
        if (!(dist > 1)) continue
        const cos = _to.dot(forward) / dist
        if (cos >= best) {
          best = cos
          victim = v
          length = dist
        }
      }
    }

    // the POV owner's own shots start at his gun (the drawn viewmodel's muzzle when one is registered), not inside his eye
    let startVec = _start
    if (ownEyes !== null && resolve && demo.entityPlayerMap.get(p)?.user.entityId === ownEyes && resolve(p, tickF, _ownView)) {
      startVec = ownMuzzleAt(ownEyes, _ownView, _ownMuzzle)
    }

    const pellets = pelletCount(weaponId)
    const spread = b.spread[i]
    const ends: Vec3[] = []
    for (let k = 0; k < pellets; k++) {
      if (pellets === 1) _dir.copy(forward)
      else {
        const [sx, sy] = FIXED_SPREAD[k % 10]
        _dir.copy(forward).addScaledVector(_view.right, sx * 0.5 * spread).addScaledVector(_view.up, sy * 0.5 * spread).normalize()
      }
      _end.copy(_start).addScaledVector(_dir, length)
      ends.push(vec(_end))
    }
    const key = teamKey(p < 255 && demo.entityPlayerMap.has(p) ? demo.playerCache.metaCache.getMeta(p, Math.min(tick, demo.ticks - 1)).teamId : 0)
    out.push({
      row: i, tick, age, player: p, weaponId, crit, start: vec(startVec), ends, length: r2(length), victim,
      opacity: 0.8 * Math.max(0, 1 - age / TRACER_TICKS), color: crit && key ? TEAM_FX[key] : TRACER_COLOR, anglesFrom,
    })
  }
  return out
}

export interface SentryTracerFx {
  row: number; tick: number; age: number; sentry: number; pivot: Vec3; start: Vec3; end: Vec3; opacity: number; color: string
  /** X1: 'barrel' when the line starts at F2's drawn barrel tip (sentryMuzzleAt), 'reach' for the constant fallback */
  startFrom?: 'barrel' | 'reach'
}

/** SENTRYGUN_EYE_OFFSET_LEVEL_1..3 (tf_shareddefs.h): the turret pivot above the sentry origin. */
const SENTRY_EYE = [32, 32, 40, 46]
const SENTRY_MINI_SCALE = 0.75
/**
 * Where a tracer leaves the gun: the barrel tip of F2's placeholder sentry (hl/f2 render.ts SENTRY: turret half
 * length plus barrel length, 11 + 18 at level 1 and 13 + 22 at levels 2 and 3, minis scaled 0.75), measured from
 * the pivot along the line to the tracer's end, which F2's pose-driven turret aim follows within a few degrees.
 * Levels 2 and 3 fire their twin barrels 3.5 units to either side in turn, in the order F2 flashes them (each
 * sentry's even shots on the right barrel, odd shots on the left).
 */
const SENTRY_BARREL_REACH = [29, 29, 35, 35]
const SENTRY_BARREL_SIDE = 3.5
const _q = new THREE.Quaternion()
const _pivot = new THREE.Vector3()
/**
 * A tracer row's muzzle: a pure function of the row's tick and barrel while the same pack sentry serves it. Asked twice
 * a frame for each live row (the placeholder pass and the pack particles); on a pack sentry each answer poses the copy
 * at the row's tick and back (about 40 us).
 */
const muzzleMemos = new WeakMap<HighlanderExtras, Map<number, { pack: unknown; ok: boolean; x: number; y: number; z: number }>>()
function tracerMuzzle(x: HighlanderExtras, row: number, sentry: number, tick: number, barrel: number, out: THREE.Vector3): boolean {
  let memo = muzzleMemos.get(x)
  if (!memo) muzzleMemos.set(x, (memo = new Map()))
  const pack = packMuzzleOf(x, sentry)
  let m = memo.get(row)
  if (!m || m.pack !== pack) {
    if (memo.size > 4096) memo.clear()
    const ok = sentryMuzzleAt(x, sentry, tick, barrel, out)
    m = { pack, ok, x: out.x, y: out.y, z: out.z }
    memo.set(row, m)
  }
  if (m.ok) out.set(m.x, m.y, m.z)
  return m.ok
}
const tracerOrdinals = new WeakMap<HighlanderExtras, Uint32Array>()

/** Per tracer row: how many earlier rows the same sentry fired (F2's twin-barrel parity). */
function tracerOrdinal(x: HighlanderExtras, row: number): number {
  let ordinals = tracerOrdinals.get(x)
  if (!ordinals) {
    const sentry = x.tempents.tracers.sentry
    ordinals = new Uint32Array(sentry.length)
    const counts = new Map<number, number>()
    for (let i = 0; i < sentry.length; i++) {
      const n = counts.get(sentry[i]) ?? 0
      ordinals[i] = n
      counts.set(sentry[i], n + 1)
    }
    tracerOrdinals.set(x, ordinals)
  }
  return ordinals[row] ?? 0
}

/**
 * Sentry "Tracer" effects with age < 3. The networked start is the dummy (999, 999, 999) of
 * CBaseEntity::ComputeTracerStartPosition (the client uses the muzzle attachment), so the line starts at the
 * barrel tip F2 draws at the tracer's tick: sentryMuzzleAt(x, sentry, tick, tracerBarrel(x, row)) (X1 wiring,
 * contract 12.4), the same point as F2's muzzle flash and the `buildings.tracerMuzzle` probe. When F2 does not draw
 * the sentry at that tick (sentryMuzzleAt returns false) the line falls back to F3's reach: from the pivot (origin +
 * (0, 0, 32 / 40 / 46 by level), x0.75 for minis) 29 or 35 units toward the end point, to the side of the firing
 * barrel at levels 2 and 3.
 */
export function sentryTracersAt(x: HighlanderExtras, tickF: number, lifetime = SENTRY_TRACER_TICKS): SentryTracerFx[] {
  const tr = x.tempents.tracers
  const out: SentryTracerFx[] = []
  if (!x.meta.available.tracers) return out
  const [from, to] = eventWindow(tr.tick, tickF, lifetime)
  const bl = x.buildings
  for (let i = from; i < to; i++) {
    const tick = tr.tick[i]
    const age = tickF - tick
    if (age < 0 || age >= lifetime) continue
    const j = tr.sentry[i]
    if (j === 65535 || j >= bl.count || !xformAt(bl.xform, j, tick, _pivot, _q)) continue
    const si = trackIndexAt(bl.state, j, tick)
    const mini = bl.mini[j] !== 0
    const level = mini ? 1 : Math.min(3, Math.max(1, si >= 0 ? bl.state.level[si] : 1))
    const scale = mini ? SENTRY_MINI_SCALE : 1
    _pivot.z += SENTRY_EYE[level] * scale
    let startFrom: 'barrel' | 'reach' = 'reach'
    const barrel = tracerBarrel(x, i)
    if (barrel >= 0 && tracerMuzzle(x, i, j, tick, barrel, _start)) {
      startFrom = 'barrel'
    } else {
      _start.copy(_pivot)
      _to.set(tr.ex[i], tr.ey[i], tr.ez[i]).sub(_pivot)
      const length = _to.length()
      if (length > 1) {
        _to.multiplyScalar(1 / length)
        _start.addScaledVector(_to, Math.min(SENTRY_BARREL_REACH[level] * scale, length))
        const horizontal = Math.hypot(_to.x, _to.y)
        if (level >= 2 && horizontal > 1e-6) {
          // the barrels sit along the turret's left axis, which stays horizontal while the turret pitches
          const side = (tracerOrdinal(x, i) % 2 === 0 ? -1 : 1) * SENTRY_BARREL_SIDE
          _start.x += (-_to.y / horizontal) * side
          _start.y += (_to.x / horizontal) * side
        }
      }
    }
    out.push({
      row: i, tick, age, sentry: j, pivot: vec(_pivot), start: vec(_start), end: [tr.ex[i], tr.ey[i], tr.ez[i]],
      opacity: 0.8 * Math.max(0, 1 - age / SENTRY_TRACER_TICKS), color: TRACER_COLOR, startFrom,
    })
  }
  return out
}

// ─── Flames and airblast ──────────────────────────────────────────────────────

export const FLAME_FADE_TICKS = 10
export const FLAME_MIN_LENGTH = 40
export const FLAME_MAX_LENGTH = 320
/** Cone growth per tick while the flame manager's box has no extent yet. */
export const FLAME_GROWTH_PER_TICK = 35

export interface FlameFx {
  instance: number; owner: number; entityId: number; firing: boolean; fade: number
  box: { center: Vec3; half: Vec3 }
  /** cone form: the pyro has a drawn, living actor */
  cone: null | { muzzle: Vec3; axis: Vec3; length: number; radius: number; flicker: number }
}

const _muzzle = new THREE.Vector3()
const _corner = new THREE.Vector3()

/**
 * Flame managers with a box entry at the tick, firing or within 10 ticks after firing dropped. With a drawn,
 * living pyro: an open cone from his muzzle along the view, as long as the farthest box corner along that axis
 * (40..320), end radius 0.38 * length, radius flicker 0.9 + 0.2 * hash(floor(tickF)). Otherwise an ellipsoid
 * filling the box.
 */
export function flamesAt(x: HighlanderExtras, demo: AsyncParser, tickF: number, resolve: ViewResolver): FlameFx[] {
  const out: FlameFx[] = []
  if (!x.meta.available.flames) return out
  const fl = x.flames
  const box = fl.box
  const tick = Math.floor(tickF)
  for (const j of flamesAliveAt(x, tick, _alive)) {
    const i = trackIndexAt(box, j, tick)
    if (i < 0) continue
    let fade = 1
    const firing = box.firing[i] !== 0
    if (!firing) {
      // entries are one tick apart at most, so a non-firing run older than the fade spans more than 11 entries
      const since = sinceTick(box, j, tick, k => box.firing[k] === 0, FLAME_FADE_TICKS + 2)
      if (since === null) continue
      const age = tickF - since
      if (age < 0 || age >= FLAME_FADE_TICKS) continue
      // only a manager that was firing right before fades; a fresh idle one draws nothing
      const before = trackIndexAt(box, j, since) - 1
      if (before < box.offsets[j] || box.firing[before] === 0) continue
      fade = 1 - age / FLAME_FADE_TICKS
    }
    const owner = fl.owner[j]
    const entityId = owner < 255 ? demo.entityPlayerMap.get(owner)?.user.entityId ?? 0 : 0
    const center: Vec3 = [box.cx[i], box.cy[i], box.cz[i]]
    const half: Vec3 = [box.hx[i], box.hy[i], box.hz[i]]
    // a manager whose collision box has no extent yet (the first ticks of firing) carries no flame volume
    const degenerate = Math.max(half[0], half[1], half[2]) < 1
    let cone: FlameFx['cone'] = null
    if (owner < 255 && resolve(owner, tickF, _view) && _view.drawn && _view.alive) {
      pyroMuzzle(_view, _muzzle)
      const axis = _view.forward
      let length: number
      if (degenerate) {
        // grow from the minimum while the box catches up: flame particles travel about 35 units per tick
        const start = firing ? sinceTick(box, j, tick, k => box.firing[k] !== 0, 64) : null
        length = FLAME_MIN_LENGTH + (start === null ? 0 : FLAME_GROWTH_PER_TICK * Math.max(0, tickF - start))
      } else {
        let far = -Infinity
        for (let c = 0; c < 8; c++) {
          _corner.set(
            center[0] + (c & 1 ? half[0] : -half[0]),
            center[1] + (c & 2 ? half[1] : -half[1]),
            center[2] + (c & 4 ? half[2] : -half[2])
          )
          far = Math.max(far, _corner.sub(_muzzle).dot(axis))
        }
        length = far
      }
      length = Math.min(FLAME_MAX_LENGTH, Math.max(FLAME_MIN_LENGTH, length))
      cone = { muzzle: vec(_muzzle), axis: vec(axis), length: r2(length), radius: r2(0.38 * length), flicker: r2(0.9 + 0.2 * hash(Math.floor(tickF))) }
    } else if (degenerate) continue
    out.push({ instance: j, owner, entityId, firing, fade, box: { center, half }, cone })
  }
  return out
}
const _alive: number[] = []

export const AIRBLAST_TICKS = 10
export const AIRBLAST_LENGTH = 260
export const AIRBLAST_HALF_ANGLE = 35

export interface AirblastFx { player: number; entityId: number; tick: number; age: number; trigger: 'wstate' | 'anim'; muzzle: Vec3; axis: Vec3; length: number; radius: number; opacity: number; ring: number }

/**
 * Airblasts with age < 10 of drawn, living players whose active weapon is a flamethrower: the onset of
 * wstate.state 3 or an ATTACK_SECONDARY anim event, whichever is newer. A cone along the view with a 35 degree
 * half angle grows to 260 units, plus a ring at the muzzle.
 */
export function airblastsAt(x: HighlanderExtras, tickF: number, resolve: ViewResolver): AirblastFx[] {
  const out: AirblastFx[] = []
  if (!x.meta.available.weapon || !(x.meta.available.wstate || x.meta.available.anim)) return out
  const tick = Math.floor(tickF)
  const w = x.players.weapon
  const ws = x.players.wstate
  const anim = x.players.anim
  const players = x.players.count
  for (let p = 0; p < players; p++) {
    const wi = trackIndexAt(w, p, tick)
    if (wi < 0 || itemKind(w.def[wi]) !== 'flamethrower') continue
    let onset = -Infinity
    let trigger: AirblastFx['trigger'] = 'wstate'
    const s = sinceTick(ws, p, tick, k => ws.state[k] === 3, 64)
    if (s !== null) onset = s
    const rows = byPlayerRange(x.derived.animByPlayer, anim, p, Math.floor(tickF - AIRBLAST_TICKS) + 1, tick + 1)
    for (let k = rows.length - 1; k >= 0; k--) {
      if (anim.event[rows[k]] === 1) {
        if (anim.tick[rows[k]] > onset) {
          onset = anim.tick[rows[k]]
          trigger = 'anim'
        }
        break
      }
    }
    const age = tickF - onset
    if (!(age >= 0 && age < AIRBLAST_TICKS)) continue
    if (!resolve(p, tickF, _view) || !_view.drawn || !_view.alive) continue
    const a = age / AIRBLAST_TICKS
    const length = AIRBLAST_LENGTH * (1 - (1 - a) * (1 - a))
    pyroMuzzle(_view, _muzzle)
    out.push({
      player: p, entityId: _view.entityId, tick: onset, age, trigger, muzzle: vec(_muzzle), axis: vec(_view.forward),
      length: r2(length), radius: r2(length * Math.tan(AIRBLAST_HALF_ANGLE * DEG)), opacity: 0.45 * (1 - a), ring: r2(8 + 22 * a),
    })
  }
  return out
}

// ─── Deflects, muzzle flashes, syringes ───────────────────────────────────────

export const DEFLECT_TICKS = 10
export interface DeflectFx { event: number; tick: number; age: number; pyro: number; projectile: number; pos: Vec3; radius: number; opacity: number }

const deflectTicks = new WeakMap<HighlanderExtras, Uint32Array>()

/** object_deflected events with age < 10: a white flash r 20 at the projectile (or the pyro's muzzle for a push). */
export function deflectFlashesAt(x: HighlanderExtras, tickF: number, resolve: ViewResolver): DeflectFx[] {
  const out: DeflectFx[] = []
  const rows = x.derived.eventsByType.deflect
  if (!rows || rows.length === 0) return out
  let ticks = deflectTicks.get(x)
  if (!ticks) {
    ticks = Uint32Array.from(rows, k => x.events[k].tick)
    deflectTicks.set(x, ticks)
  }
  const [from, to] = eventWindow(ticks, tickF, DEFLECT_TICKS)
  for (let r = from; r < to; r++) {
    const e = x.events[rows[r]]
    if (e.t !== 'deflect') continue
    const age = tickF - e.tick
    if (age < 0 || age >= DEFLECT_TICKS) continue
    let ok = false
    if (e.projectile >= 0 && e.projectile < x.projectiles.count) ok = positionAt(x, e.projectile, e.tick, _muzzle)
    if (!ok && e.pyro >= 0 && e.pyro < 255 && resolve(e.pyro, e.tick, _view)) {
      pyroMuzzle(_view, _muzzle)
      ok = true
    }
    if (!ok) continue
    out.push({ event: rows[r], tick: e.tick, age, pyro: e.pyro, projectile: e.projectile, pos: vec(_muzzle), radius: 20, opacity: 0.7 * (1 - age / DEFLECT_TICKS) })
  }
  return out
}

export const MUZZLE_TICKS = 2
export const MUZZLE_SIZE = 10
export const MUZZLE_COLOR = '#ffd27a'
/** Weapon kinds that flash: guns and launchers (no melee, medigun, flamethrower, bows, throwables or tools). */
const MUZZLE_KINDS = new Set(['shotgun', 'scattergun', 'sniper_rifle', 'minigun', 'smg', 'syringe_gun', 'rocket_launcher', 'grenade_launcher', 'sticky_launcher', 'pistol', 'revolver'])

export interface MuzzleFx { row: number; tick: number; age: number; player: number; entityId: number; weaponDef: number; pos: Vec3; size: number; opacity: number }

/** players.fire rows of guns with age < 2, at feet + (0, 0, eye - 10) + forward * 26 + right * 8. */
export function muzzleFlashesAt(x: HighlanderExtras, tickF: number, ownEyes: number | null, resolve: ViewResolver): MuzzleFx[] {
  const out: MuzzleFx[] = []
  if (!x.meta.available.fire) return out
  const fire = x.players.fire
  const [from, to] = eventWindow(fire.tick, tickF, MUZZLE_TICKS)
  for (let i = from; i < to; i++) {
    const age = tickF - fire.tick[i]
    if (age < 0 || age >= MUZZLE_TICKS) continue
    if (!MUZZLE_KINDS.has(itemKind(fire.weaponDef[i]))) continue
    const p = fire.player[i]
    if (!resolve(p, tickF, _view) || !_view.drawn || !_view.alive) continue
    if (ownEyes !== null && _view.entityId === ownEyes) continue
    gunMuzzle(_view, _muzzle)
    out.push({ row: i, tick: fire.tick[i], age, player: p, entityId: _view.entityId, weaponDef: fire.weaponDef[i], pos: vec(_muzzle), size: MUZZLE_SIZE, opacity: 1 - age / MUZZLE_TICKS })
  }
  return out
}

export const SYRINGE_SECONDS = 0.6
export const SYRINGE_GRAVITY = 240
/**
 * The game draws a short bright particle trail behind every syringe (nailtrails_medic_*). A 6-unit needle alone is
 * two or three pixels from the RTS camera, so each needle also gets a streak through its path over the last
 * 0.06 s (about 60 units at 1000 u/s), 3 units wide (crits 5) in TEAM_FX: TEAM_TRAIL blue is too dark to read on
 * dark interiors (luminance 0.22 against 0.35 for TEAM_FX blue). The needle itself stays TEAM_TRAIL.
 */
export const SYRINGE_TRAIL_SECONDS = 0.06
export const SYRINGE_TRAIL_POINTS = 3
export const SYRINGE_TRAIL_WIDTH = 3
export const SYRINGE_CRIT_TRAIL_WIDTH = 5
export interface SyringeFx {
  row: number; tick: number; t: number; player: number; team: number; crit: boolean; pos: Vec3; dir: Vec3; color: string
  /** streak points along the path, head first (at least the needle position) */
  trail: Vec3[]
  trailColor: string
  trailWidth: number
}

/**
 * ClientProjectile_Syringe rows: p0 + v t + 0.5 (0, 0, -240) t^2 for t in [0, 0.6 s], along the velocity, plus
 * the streak through the path over the last 0.06 s (never before the launch).
 */
export function syringesAt(x: HighlanderExtras, demo: AsyncParser, tickF: number): SyringeFx[] {
  const out: SyringeFx[] = []
  if (!x.meta.available.clientProjectiles) return out
  const cp = x.tempents.clientProjectiles
  const ipt = x.meta.intervalPerTick || 0.015
  const lifetime = SYRINGE_SECONDS / ipt
  const [from, to] = eventWindow(cp.tick, tickF, lifetime)
  for (let i = from; i < to; i++) {
    if (cp.kind[i] !== 21) continue
    const t = (tickF - cp.tick[i]) * ipt
    if (t < 0 || t >= SYRINGE_SECONDS) continue
    const vx = cp.vx[i], vy = cp.vy[i], vz = cp.vz[i] - SYRINGE_GRAVITY * t
    const p = cp.player[i]
    const team = p < 255 && demo.entityPlayerMap.has(p) ? demo.playerCache.metaCache.getMeta(p, Math.min(cp.tick[i], demo.ticks - 1)).teamId : 0
    const key = teamKey(team)
    const crit = cp.crit[i] !== 0
    _dir.set(vx, vy, vz)
    if (_dir.lengthSq() > 0) _dir.normalize()
    else _dir.set(1, 0, 0)
    const at = (s: number): Vec3 => [cp.x[i] + cp.vx[i] * s, cp.y[i] + cp.vy[i] * s, cp.z[i] + cp.vz[i] * s - 0.5 * SYRINGE_GRAVITY * s * s]
    const trail: Vec3[] = [at(t)]
    for (let k = 1; k < SYRINGE_TRAIL_POINTS && t > 0; k++) {
      const s = t - (k * SYRINGE_TRAIL_SECONDS) / (SYRINGE_TRAIL_POINTS - 1)
      trail.push(at(Math.max(0, s)))
      if (s <= 0) break
    }
    out.push({
      row: i, tick: cp.tick[i], t, player: p, team, crit, pos: trail[0], dir: vec(_dir), color: key ? TEAM_TRAIL[key] : NEUTRAL,
      trail: trail.map(v => [r2(v[0]), r2(v[1]), r2(v[2])] as Vec3),
      trailColor: key ? TEAM_FX[key] : NEUTRAL,
      trailWidth: crit ? SYRINGE_CRIT_TRAIL_WIDTH : SYRINGE_TRAIL_WIDTH,
    })
  }
  return out
}

// ─── Crit glows and deflect rings (instances the extras layer draws) ─────────────

export const CRIT_GLOW_RADIUS = 9
/** Edge falloff of the crit glow sphere (pow(n.v, k)): low, so the halo around the mesh stays visible. */
export const CRIT_GLOW_SOFTNESS = 0.6
export const DEFLECT_RING_RADIUS = 6

/** Crit glow opacity at tickF: 0.35 + 0.1 * sin(tickF * 0.4). */
export function critGlowOpacity(tickF: number): number {
  return 0.35 + 0.1 * Math.sin(tickF * 0.4)
}

export interface ProjectileMarkFx { instance: number; kind: number; team: number; color: string; pos: Vec3; dir: Vec3 }

const _pos = new THREE.Vector3()

/** Crit glows and deflect rings of the instances ProjectilesExtraLayer draws at tickF. */
export function extrasMarksAt(x: HighlanderExtras, source: ProjectileSource, tickF: number): { glows: ProjectileMarkFx[]; rings: ProjectileMarkFx[] } {
  const glows: ProjectileMarkFx[] = []
  const rings: ProjectileMarkFx[] = []
  if (!x.meta.available.projectiles) return { glows, rings }
  const tick = Math.floor(tickF)
  const pj = x.projectiles
  for (const j of projectilesDrawnAt(x, tick, _drawn)) {
    if (source.servedByBase[j]) continue
    const crit = pj.crit[j] !== 0
    const deflected = deflectIndexAt(x, j, tick) >= 0
    if (!crit && !deflected) continue
    if (!positionAt(x, j, tickF, _pos)) continue
    directionAt(x, j, tickF, _dir)
    const team = projectileTeamAt(x, j, tick)
    const mark: ProjectileMarkFx = { instance: j, kind: pj.kind[j], team, color: teamFx(team), pos: vec(_pos), dir: vec(_dir) }
    if (crit) glows.push(mark)
    if (deflected) rings.push(mark)
  }
  return { glows, rings }
}
const _drawn: number[] = []


// ─── Everything CombatFxLayer draws in one frame ──────────────────────────────

export interface CombatSettings { critGlow: boolean; explosions: boolean; tracers: boolean; flames: boolean; airblast: boolean; extraTypes: boolean }

/** The six F3 toggles of `settings.highlander.projectiles` (non-React: once per frame or per probe call). */
export function readCombatSettings(): CombatSettings {
  return {
    critGlow: getHlSetting<boolean>('projectiles.critGlow') !== false,
    explosions: getHlSetting<boolean>('projectiles.explosions') !== false,
    tracers: getHlSetting<boolean>('projectiles.tracers') !== false,
    flames: getHlSetting<boolean>('projectiles.flames') !== false,
    airblast: getHlSetting<boolean>('projectiles.airblast') !== false,
    extraTypes: getHlSetting<boolean>('projectiles.extraTypes') !== false,
  }
}

export interface CombatEffects {
  tickF: number
  explosions: ExplosionFx[]
  scorches: ScorchFx[]
  /** Projectiles.tsx stand-in explosions while the tempents group is missing */
  despawn: DespawnExplosion[]
  glows: ProjectileMarkFx[]
  rings: ProjectileMarkFx[]
  tracers: TracerFx[]
  sentryTracers: SentryTracerFx[]
  muzzle: MuzzleFx[]
  flames: FlameFx[]
  airblasts: AirblastFx[]
  deflects: DeflectFx[]
  syringes: SyringeFx[]
}

/**
 * The effects of one frame, gated by the F3 settings: explosions (TETFExplosion, building explosions, scorch marks,
 * or the despawn stand-ins), crit glows (critGlow; with extraTypes, as their projectiles), deflect rings (airblast
 * and extraTypes), deflect flashes and airblasts (airblast), hitscan and sentry tracers and muzzle flashes
 * (tracers), flames (flames) and syringes (extraTypes).
 */
export function combatEffectsAt(
  x: HighlanderExtras,
  demo: AsyncParser,
  source: ProjectileSource,
  tickF: number,
  resolve: ViewResolver,
  ownEyes: number | null,
  settings: CombatSettings
): CombatEffects {
  const fx: CombatEffects = {
    tickF, explosions: [], scorches: [], despawn: [], glows: [], rings: [], tracers: [], sentryTracers: [], muzzle: [],
    flames: [], airblasts: [], deflects: [], syringes: [],
  }
  if (settings.explosions) {
    if (x.meta.available.explosions) {
      fx.explosions = explosionsAt(x, tickF).concat(buildingExplosionsAt(x, tickF))
      fx.scorches = scorchesAt(x, tickF)
    } else if (x.meta.available.projectiles) {
      fx.despawn = despawnExplosionsAt(x, source, tickF)
    }
  }
  // glows and rings of the instances ProjectilesExtraLayer draws exist only while that layer draws them
  if (settings.extraTypes && (settings.critGlow || settings.airblast)) {
    const marks = extrasMarksAt(x, source, tickF)
    if (settings.critGlow) fx.glows = marks.glows
    if (settings.airblast) fx.rings = marks.rings
  }
  if (settings.tracers) {
    fx.tracers = hitscanAt(x, demo, tickF, ownEyes, resolve)
    fx.sentryTracers = sentryTracersAt(x, tickF)
    fx.muzzle = muzzleFlashesAt(x, tickF, ownEyes, resolve)
  }
  if (settings.flames) fx.flames = flamesAt(x, demo, tickF, resolve)
  if (settings.airblast) {
    fx.airblasts = airblastsAt(x, tickF, resolve)
    fx.deflects = deflectFlashesAt(x, tickF, resolve)
  }
  if (settings.extraTypes) fx.syringes = syringesAt(x, demo, tickF)
  return fx
}
