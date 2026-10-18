// Landed bolts (contract 5 F3, review fix). When a crossbow bolt lands, the server stops it, sets EF_NODRAW and
// deletes it 3 s later (CTFProjectile_Arrow::FadeOut, tf_projectile_arrow.cpp:1014), so the entity leaves the
// snapshots and the extras instance hides. The game client keeps showing the bolt: a stuck-bolt model where it hit
// the world (TFBoltImpact, c_tf_stickybolt.cpp CreateCrossbowBoltTF) or a copy on the bone of the player it hit
// (arrow_impact, tf_hud_bowcharge.cpp). The extras carry neither effect, so F3 rebuilds the pose from the flight
// samples and the base player caches, for the landed phase [hidden, landedEnd):
//
// - a living player whose hull the last flight step passes within HIT_MARGIN of was hit: the bolt rides on him,
//   at the hit point pulled in to BODY_RADIUS from his axis, turning with his yaw, while he is alive;
// - otherwise it hit the world (or a prop): it stays half a flight step past the last sample, along the last flight
//   direction. Measured on 1438891 and 1442753 the map lies a median 0.83 to 0.86 steps past the last sample (p10
//   0.28 to 0.34), and half a step keeps the bolt in front of the wall in most cases.
//
// Measured: 133 of 141 healing bolts on 1438891 and 154 of 163 on 1442753 hide 200 ticks before they are deleted;
// 81 and 99 of them hit a player (mostly teammates they heal). Arrows and repair bolts rest visibly instead (their
// hidden tick is their delete tick), so their landed phase is empty and the alive drawing already covers them.
//
// Everything is a pure function of the extras, the base player caches and tickF (D12); the per-instance landing is
// computed once and cached per (extras, demo).

import * as THREE from 'three'

import type { AsyncParser } from '@components/Analyse/Data/AsyncParser'
import { PROJ } from '@highlander/extras/enums'
import type { HighlanderExtras } from '@highlander/extras/types'

import type { ViewResolver } from './combatData'
import { directionAt, landedEnd, NONE_U32, projectileTeamAt } from './projectileData'
import { makePlayerView } from './view'

const DEG = Math.PI / 180
/** Half the 48-unit player hull, and its standing height. */
const HULL_HALF = 24
const HULL_HEIGHT = 82
/** A flight path within this many units of a living player's hull counts as a hit on him. */
const HIT_MARGIN = 4
/** The path tested past the last sample, in flight steps (one step = one tick of flight). */
const PATH_STEPS = 1.25
const PATH_SAMPLES = 10
/** The hull is wider than the player model: an attached bolt sits at most this far from the victim's axis. */
const BODY_RADIUS = 10
const BODY_Z_MIN = 12
const BODY_Z_MAX = 76
/** World hits: the bolt rests this fraction of a flight step past the last sample. */
const WORLD_STEP_FRACTION = 0.5

export interface BoltLanding {
  instance: number
  mode: 'world' | 'player'
  /** Player index the bolt hit (mode 'player'), else -1. */
  victim: number
  /** The landed phase [from, to): hidden tick, then deleted capped at hidden + 3 s. */
  from: number
  to: number
  /** World: the resting position (scene space). Player: the hit point minus the victim's feet at `from`. */
  offset: THREE.Vector3
  /** Unit flight direction at the hit (for a player hit, in world axes at `from`). */
  dir: THREE.Vector3
  /** Victim's view yaw at the hit, degrees (mode 'player'). */
  yaw: number
}

const cache = new WeakMap<HighlanderExtras, WeakMap<AsyncParser, Map<number, BoltLanding | null>>>()

const _s = new THREE.Vector3()
const _step = new THREE.Vector3()
const _q = new THREE.Vector3()
const _hit = new THREE.Vector3()

/** Distance from point q to the axis-aligned box lo..hi. */
function boxDistance(q: THREE.Vector3, lx: number, ly: number, lz: number, hx: number, hy: number, hz: number): number {
  const dx = q.x < lx ? lx - q.x : q.x > hx ? q.x - hx : 0
  const dy = q.y < ly ? ly - q.y : q.y > hy ? q.y - hy : 0
  const dz = q.z < lz ? lz - q.z : q.z > hz ? q.z - hz : 0
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

/** The flight step (one tick of travel) at the end of instance j's samples: the last non-zero delta, else v * dt. */
function lastStep(x: HighlanderExtras, j: number, out: THREE.Vector3): THREE.Vector3 {
  const pj = x.projectiles
  const n = pj.posCount[j]
  const p = pj.pos
  const start = pj.posStart[j]
  for (let k = n - 1, steps = 0; k >= 1 && steps < 16; k--, steps++) {
    const i = (start + k) * 3
    out.set(p[i] - p[i - 3], p[i + 1] - p[i - 2], p[i + 2] - p[i - 1])
    const lenSq = out.lengthSq()
    if (lenSq > 1e-4 && Number.isFinite(lenSq)) return out
  }
  // one sample only (a point-blank hit): the initial velocity over one tick, else no step
  const dt = x.meta.intervalPerTick || 0.015
  out.set(pj.vx[j], pj.vy[j], pj.vz[j]).multiplyScalar(dt)
  if (out.lengthSq() > 1e-4 && Number.isFinite(out.lengthSq())) return out
  return out.set(0, 0, 0)
}

function computeLanding(x: HighlanderExtras, demo: AsyncParser, j: number): BoltLanding | null {
  const pj = x.projectiles
  const from = pj.hidden[j]
  if (from === NONE_U32) return null
  const to = landedEnd(x, j)
  const n = pj.posCount[j]
  if (to <= from || n === 0) return null
  const i = (pj.posStart[j] + n - 1) * 3
  _s.set(pj.pos[i], pj.pos[i + 1], pj.pos[i + 2])
  if (!Number.isFinite(_s.x + _s.y + _s.z)) return null
  lastStep(x, j, _step)
  const dir = new THREE.Vector3()
  if (_step.lengthSq() > 1e-4) dir.copy(_step).normalize()
  else directionAt(x, j, from - 1, dir)

  // the first living player along the last flight step (healing bolts also hit teammates; other bolts pass through)
  const team = projectileTeamAt(x, j, from)
  const owner = pj.owner[j]
  const mates = pj.kind[j] === PROJ.HEALING_BOLT
  const pc = demo.playerCache
  const last = Math.max(0, demo.ticks - 1)
  const t0 = Math.min(Math.max(from - 1, 0), last)
  let victim = -1
  let bestF = Infinity
  let bestDist = Infinity
  let victimTick = t0
  for (const p of demo.entityPlayerMap.keys()) {
    if (p === owner) continue
    if (!pc.connectedCache.get(p, t0) || !(pc.healthCache.get(p, t0) > 0)) continue
    const playerTeam = pc.metaCache.getMeta(p, t0).teamId
    if (playerTeam !== 2 && playerTeam !== 3) continue
    if (!mates && playerTeam === team) continue
    for (const t of [t0, Math.min(from, last)]) {
      const pos = pc.positionCache.getPosition(p, t)
      for (let k = 0; k <= PATH_SAMPLES; k++) {
        const f = (PATH_STEPS * k) / PATH_SAMPLES
        if (f > bestF) break
        _q.copy(_s).addScaledVector(_step, f)
        const dist = boxDistance(_q, pos.x - HULL_HALF, pos.y - HULL_HALF, pos.z, pos.x + HULL_HALF, pos.y + HULL_HALF, pos.z + HULL_HEIGHT)
        if (dist > HIT_MARGIN) continue
        if (f < bestF || (f === bestF && dist < bestDist)) {
          bestF = f
          bestDist = dist
          victim = p
          victimTick = t
          _hit.copy(_q)
        }
        break
      }
    }
  }

  if (victim >= 0) {
    const pos = pc.positionCache.getPosition(victim, victimTick)
    const offset = new THREE.Vector3(_hit.x - pos.x, _hit.y - pos.y, _hit.z - pos.z)
    const radial = Math.hypot(offset.x, offset.y)
    if (radial > BODY_RADIUS) {
      offset.x *= BODY_RADIUS / radial
      offset.y *= BODY_RADIUS / radial
    }
    offset.z = Math.min(BODY_Z_MAX, Math.max(BODY_Z_MIN, offset.z))
    const yaw = pc.viewAnglesCache.getAngles(victim, victimTick).y
    return { instance: j, mode: 'player', victim, from, to, offset, dir, yaw }
  }
  const offset = _s.clone().addScaledVector(_step, WORLD_STEP_FRACTION)
  return { instance: j, mode: 'world', victim: -1, from, to, offset, dir, yaw: 0 }
}

/** How instance j landed, or null when it has no landed phase. Built once per (extras, demo, instance). */
export function boltLanding(x: HighlanderExtras, demo: AsyncParser, j: number): BoltLanding | null {
  let perDemo = cache.get(x)
  if (!perDemo) cache.set(x, (perDemo = new WeakMap()))
  let map = perDemo.get(demo)
  if (!map) perDemo.set(demo, (map = new Map()))
  let landing = map.get(j)
  if (landing === undefined) map.set(j, (landing = computeLanding(x, demo, j)))
  return landing
}

const _view = makePlayerView()

/**
 * Pose of a landed instance at tickF (its landed phase holds the integer tick): the resting point of a world hit,
 * or the point on its victim, who must be drawn and alive. Returns the landing, or null when nothing is drawn.
 * `resolve` places the victim (base data for probes, the drawn actor for rendering). `ownEyes`: the entity id of
 * the player whose own eyes the camera uses; bolts on him are not drawn (the game hides first-person attachments).
 */
export function landedPoseAt(
  x: HighlanderExtras,
  demo: AsyncParser,
  j: number,
  tickF: number,
  resolve: ViewResolver,
  outPos: THREE.Vector3,
  outDir: THREE.Vector3,
  ownEyes: number | null = null
): BoltLanding | null {
  const landing = boltLanding(x, demo, j)
  const tick = Math.floor(tickF)
  if (!landing || tick < landing.from || tick >= landing.to) return null
  if (landing.mode === 'world') {
    outPos.copy(landing.offset)
    outDir.copy(landing.dir)
    return landing
  }
  if (!resolve(landing.victim, tickF, _view) || !_view.alive || !_view.drawn) return null
  if (ownEyes !== null && _view.entityId === ownEyes) return null
  const a = (_view.yaw - landing.yaw) * DEG
  const c = Math.cos(a), s = Math.sin(a)
  const o = landing.offset, d = landing.dir
  outPos.set(o.x * c - o.y * s, o.x * s + o.y * c, o.z).add(_view.pos)
  outDir.set(d.x * c - d.y * s, d.x * s + d.y * c, d.z)
  return landing
}
