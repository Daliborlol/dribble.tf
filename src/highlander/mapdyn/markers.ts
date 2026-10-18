// Death markers and dropped items (contract section 5 F6): pure state at a tick.

import * as THREE from 'three'

import { NEUTRAL, TEAM_DARK, teamKey } from '@highlander/constants'
import { RAG } from '@highlander/extras/enums'
import { lowerBound, xformAt } from '@highlander/extras/track'
import type { HighlanderExtras } from '@highlander/extras/types'

import {
  DEATH_MARKER_DROP,
  DEATH_MARKER_GIB_COLOR,
  DEATH_MARKER_GROW_TICKS,
  DEATH_MARKER_SHRINK_TICKS,
  DEATH_MARKER_TICKS,
} from './constants'
import { isAlive } from './movers'
import type { Spot, SpotSurface, SurfaceOptions } from './surface'

export interface DeathMarker {
  instance: number
  player: number
  team: number
  gib: boolean
  x: number
  y: number
  /** where the marker lies: the floor under a mid-air death, else the ragdoll origin */
  z: number
  /** m_vecRagdollOrigin z */
  originZ: number
  /** true when z is the floor below a mid-air death (RAG.ON_GROUND clear) */
  dropped: boolean
  /** ticks since the ragdoll appeared */
  age: number
  /** 0..1 presentation scale (grow in, shrink away) */
  scale: number
}

/** Ragdolls that get a marker: not a Dead Ringer fake and not already there when the recording started. */
export const isMarkedRagdoll = (x: HighlanderExtras, j: number) =>
  x.ragdolls.created[j] !== 0 && (x.ragdolls.flags[j] & RAG.FEIGN) === 0

/**
 * Ragdolls created in (tickF - 330, tickF], newest last (see isMarkedRagdoll). `ground` (per ragdoll, NaN to
 * keep the origin) holds the floor under mid-air deaths, see airborneMarkerSpots.
 */
export function deathMarkersAt(
  x: HighlanderExtras,
  tickF: number,
  out: DeathMarker[] = [],
  ground?: Float32Array | null
): DeathMarker[] {
  out.length = 0
  const r = x.ragdolls
  if (!r.count) return out
  const tick = Math.floor(tickF)
  const end = lowerBound(r.created, tick + 1)
  const start = lowerBound(r.created, tick - DEATH_MARKER_TICKS + 1, 0, end)
  for (let j = start; j < end; j++) {
    if (!isMarkedRagdoll(x, j)) continue
    const age = tickF - r.created[j]
    if (age < 0 || age >= DEATH_MARKER_TICKS) continue
    const grow = Math.min(1, (age + 1) / DEATH_MARKER_GROW_TICKS)
    const shrink = Math.min(1, (DEATH_MARKER_TICKS - age) / DEATH_MARKER_SHRINK_TICKS)
    const floor = ground ? ground[j] : NaN
    const dropped = !Number.isNaN(floor)
    out.push({
      instance: j,
      player: r.player[j],
      team: r.team[j],
      gib: (r.flags[j] & RAG.GIB) !== 0,
      x: r.x[j],
      y: r.y[j],
      z: dropped ? floor : r.z[j],
      originZ: r.z[j],
      dropped,
      age,
      scale: Math.max(0, Math.min(grow, shrink)),
    })
  }
  return out
}

/** Floor search for mid-air deaths: the highest upward-facing map triangle up to 1500 units below. */
export const MARKER_SURFACE: SurfaceOptions = { below: DEATH_MARKER_DROP, above: 2, upwardOnly: true, detectBaked: false }

export interface AirborneSpots {
  /** ragdoll instance per spot */
  ragdolls: number[]
  spots: Spot[]
}
const airborneCache = new WeakMap<HighlanderExtras, AirborneSpots>()

/**
 * Marked ragdolls whose player died in the air (RAG.ON_GROUND clear): their origin is the death point, not a
 * floor, so the marker drops to the floor below it. Deaths on the ground keep their origin (feet on a
 * surface, perhaps a stock prop that is not drawn). One stable object per extras.
 */
export function airborneMarkerSpots(x: HighlanderExtras): AirborneSpots {
  const cached = airborneCache.get(x)
  if (cached) return cached
  const r = x.ragdolls
  const result: AirborneSpots = { ragdolls: [], spots: [] }
  for (let j = 0; j < r.count; j++) {
    if (!isMarkedRagdoll(x, j) || (r.flags[j] & RAG.ON_GROUND) !== 0) continue
    result.ragdolls.push(j)
    result.spots.push({ x: r.x[j], y: r.y[j], z: r.z[j] })
  }
  airborneCache.set(x, result)
  return result
}

/** Floor per ragdoll (NaN: keep the origin) from the analysis of airborneMarkerSpots. */
export function markerGround(x: HighlanderExtras, airborne: AirborneSpots, surface: SpotSurface | null): Float32Array {
  const ground = new Float32Array(x.ragdolls.count).fill(NaN)
  if (surface) airborne.ragdolls.forEach((j, k) => (ground[j] = surface.floor[k]))
  return ground
}

const GIB = new THREE.Color(DEATH_MARKER_GIB_COLOR)
const TEAM_COLORS = {
  red: new THREE.Color(TEAM_DARK.red),
  blue: new THREE.Color(TEAM_DARK.blue),
  none: new THREE.Color(NEUTRAL),
}
export function deathMarkerColor(marker: { gib: boolean; team: number }): THREE.Color {
  if (marker.gib) return GIB
  const key = teamKey(marker.team)
  return key ? TEAM_COLORS[key] : TEAM_COLORS.none
}

/** Most ragdolls whose 330-tick windows overlap, for the instanced capacity. */
export function maxConcurrentMarkers(x: HighlanderExtras): number {
  const created = x.ragdolls.created
  let best = 0
  let lo = 0
  for (let hi = 0; hi < created.length; hi++) {
    while (created[hi] - created[lo] >= DEATH_MARKER_TICKS) lo++
    best = Math.max(best, hi - lo + 1)
  }
  return best
}

const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()

/** Visits every drop instance alive at tickF with its interpolated transform (scene space). */
export function forEachDropAt(
  x: HighlanderExtras,
  tickF: number,
  visit: (j: number, kind: number, pos: THREE.Vector3, quat: THREE.Quaternion) => void
): void {
  const d = x.drops
  const tick = Math.floor(tickF)
  const gap = Math.max(1, x.meta.snapshotInterval || 1)
  const end = lowerBound(d.created, tick + 1)
  for (let j = 0; j < end; j++) {
    if (!isAlive(d.created, d.deleted, j, tick)) continue
    if (!xformAt(d.xform, j, tickF, _pos, _quat, gap)) continue
    visit(j, d.kind[j], _pos, _quat)
  }
}
