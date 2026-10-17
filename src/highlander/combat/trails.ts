// Seek-deterministic projectile trails (contract 5 F3): ribbons through the last samples of an instance, rocket
// smoke puffs from the samples of the last 48 ticks, and the despawn explosions that stand in for TETFExplosion
// when the tempents group is missing. Everything is a pure function of the extras and tickF, so a trail after a
// seek is identical to the same trail during playback (D12).

import * as THREE from 'three'

import { NEUTRAL, TEAM_FX, TEAM_TRAIL, teamKey } from '@highlander/constants'
import type { HighlanderExtras } from '@highlander/extras/types'

import { drawEnd, NONE_U32, positionAt, projectileTeamAt } from './projectileData'
import type { ProjectileSource } from './projectileSource'

/** Ribbon samples of the instances ProjectilesExtraLayer draws, and of the base pipes, stickies and bolts. */
export const TRAIL_SAMPLES = 6
/** Base rockets use a longer ribbon. */
export const ROCKET_TRAIL_SAMPLES = 12
export const TRAIL_WIDTH = 3
export const CRIT_TRAIL_WIDTH = 6
/** Ribbon opacity at the head; it falls to 0 at the tail. */
export const TRAIL_HEAD_ALPHA = 0.85
/** Ribbons never get thinner than this on screen, so far trails stay readable in the RTS overview. */
export const TRAIL_MIN_PIXELS = 1.5

export const SMOKE_TICKS = 48
export const SMOKE_COLOR = '#9a9a9a'

/** Despawn explosions (Projectiles.tsx fallback): 200 ms at 66 ticks/s, radius 40, opacity 0.4, #cccccc. */
export const DESPAWN_EXPLOSION_TICKS = 14
export const DESPAWN_EXPLOSION_RADIUS = 40
export const DESPAWN_EXPLOSION_OPACITY = 0.4
export const DESPAWN_EXPLOSION_COLOR = '#cccccc'

const MIN_POINT_GAP_SQ = 0.25 * 0.25
const _p = new THREE.Vector3()

/**
 * Ribbon points of instance j at tickF, head first, into `out` (flat xyz): the interpolated position at tickF,
 * then the samples at floor(tickF), floor(tickF) - 1, ... (`samples` of them, never before `created`). Points
 * closer than 0.25 units to the previous one are skipped, so a resting sticky has no ribbon. Returns the count.
 */
export function trailPoints(x: HighlanderExtras, j: number, tickF: number, samples: number, out: Float32Array): number {
  const pj = x.projectiles
  if (!positionAt(x, j, tickF, _p)) return 0
  let count = 0
  out[0] = _p.x
  out[1] = _p.y
  out[2] = _p.z
  count = 1
  const created = pj.created[j]
  const n = pj.posCount[j]
  const start = pj.posStart[j]
  const p = pj.pos
  const base = Math.floor(tickF)
  for (let k = 0; k < samples && count * 3 + 3 <= out.length; k++) {
    const s = base - k - created
    if (s < 0) break
    if (s >= n) continue
    const i = (start + s) * 3
    const px = p[i], py = p[i + 1], pz = p[i + 2]
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) break
    const lx = out[count * 3 - 3], ly = out[count * 3 - 2], lz = out[count * 3 - 1]
    const dx = px - lx, dy = py - ly, dz = pz - lz
    if (dx * dx + dy * dy + dz * dz < MIN_POINT_GAP_SQ) continue
    out[count * 3] = px
    out[count * 3 + 1] = py
    out[count * 3 + 2] = pz
    count++
  }
  return count
}

export interface TrailStyle { width: number; color: string; crit: boolean; team: number }

/** Width 3 in TEAM_TRAIL, or width 6 in TEAM_FX for crit projectiles; the team after any deflect. */
export function trailStyle(x: HighlanderExtras, j: number, tick: number, out?: TrailStyle): TrailStyle {
  const team = projectileTeamAt(x, j, tick)
  const key = teamKey(team)
  const crit = x.projectiles.crit[j] !== 0
  const style = out ?? { width: 0, color: '', crit: false, team: 0 }
  style.team = team
  style.crit = crit
  style.width = crit ? CRIT_TRAIL_WIDTH : TRAIL_WIDTH
  style.color = key ? (crit ? TEAM_FX[key] : TEAM_TRAIL[key]) : NEUTRAL
  return style
}

/**
 * Smoke puffs of one rocket instance at tickF: one per sample of the last 48 ticks at pos[sampleTick], size
 * 4 + 10 * age / 48, opacity 0.35 * (1 - age / 48), with age = tickF - sampleTick. Puffs outlive the rocket.
 */
export function forEachSmokePuff(
  x: HighlanderExtras,
  j: number,
  tickF: number,
  emit: (px: number, py: number, pz: number, size: number, opacity: number, sampleTick: number) => void
): void {
  const pj = x.projectiles
  const created = pj.created[j]
  const n = pj.posCount[j]
  if (n === 0) return
  const end = Math.min(drawEnd(x, j), created + n)
  const newest = Math.min(Math.floor(tickF), end - 1)
  const oldest = Math.max(created, Math.floor(tickF) - (SMOKE_TICKS - 1))
  const p = pj.pos
  const start = pj.posStart[j]
  for (let t = newest; t >= oldest; t--) {
    const age = tickF - t
    if (age < 0 || age >= SMOKE_TICKS) continue
    const i = (start + (t - created)) * 3
    const px = p[i], py = p[i + 1], pz = p[i + 2]
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) continue
    const a = age / SMOKE_TICKS
    emit(px, py, pz, 4 + 10 * a, 0.35 * (1 - a), t)
  }
}

// ─── Despawn explosions (no TETFExplosion data) ─────────────────────────────────

interface HiddenIndex { ticks: Uint32Array; rows: Uint32Array }
const hiddenIndexes = new WeakMap<ProjectileSource, HiddenIndex>()

/** Base-drawn rockets, pipes and stickies sorted by the tick they hid (detonated), built once per source. */
function hiddenIndex(x: HighlanderExtras, source: ProjectileSource): HiddenIndex {
  let index = hiddenIndexes.get(source)
  if (!index) {
    const pj = x.projectiles
    const rows: number[] = []
    for (let j = 0; j < pj.count; j++) {
      const type = source.baseType[j]
      if (!source.servedByBase[j] || type < 1 || type > 3) continue
      if (pj.hidden[j] === NONE_U32 || pj.posCount[j] === 0) continue
      rows.push(j)
    }
    rows.sort((a, b) => pj.hidden[a] - pj.hidden[b] || a - b)
    index = { ticks: Uint32Array.from(rows, j => pj.hidden[j]), rows: Uint32Array.from(rows) }
    hiddenIndexes.set(source, index)
  }
  return index
}

export interface DespawnExplosion { instance: number; tick: number; age: number; x: number; y: number; z: number; radius: number; opacity: number }

/** Explosions at the last position of base rockets, pipes and stickies that hid within the last 14 ticks. */
export function despawnExplosionsAt(x: HighlanderExtras, source: ProjectileSource, tickF: number): DespawnExplosion[] {
  const index = hiddenIndex(x, source)
  const out: DespawnExplosion[] = []
  const from = Math.floor(tickF - DESPAWN_EXPLOSION_TICKS) + 1
  const to = Math.floor(tickF)
  // binary search for the first hidden tick >= from
  let lo = 0, hi = index.ticks.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (index.ticks[mid] < from) lo = mid + 1
    else hi = mid
  }
  for (let k = lo; k < index.ticks.length && index.ticks[k] <= to; k++) {
    const j = index.rows[k]
    const tick = index.ticks[k]
    const age = tickF - tick
    if (age < 0 || age >= DESPAWN_EXPLOSION_TICKS) continue
    if (!positionAt(x, j, tick - 1, _p)) continue
    const a = age / DESPAWN_EXPLOSION_TICKS
    out.push({
      instance: j,
      tick,
      age,
      x: _p.x,
      y: _p.y,
      z: _p.z,
      radius: DESPAWN_EXPLOSION_RADIUS * (1 - (1 - a) ** 3),
      opacity: DESPAWN_EXPLOSION_OPACITY * (1 - a),
    })
  }
  return out
}
