// Death markers and dropped items (contract section 5 F6): pure state at a tick.

import * as THREE from 'three'

import { NEUTRAL, TEAM_DARK, teamKey } from '@highlander/constants'
import { RAG } from '@highlander/extras/enums'
import { lowerBound, xformAt } from '@highlander/extras/track'
import type { HighlanderExtras } from '@highlander/extras/types'

import {
  DEATH_MARKER_GIB_COLOR,
  DEATH_MARKER_GROW_TICKS,
  DEATH_MARKER_SHRINK_TICKS,
  DEATH_MARKER_TICKS,
} from './constants'
import { isAlive } from './movers'

export interface DeathMarker {
  instance: number
  player: number
  team: number
  gib: boolean
  x: number
  y: number
  z: number
  /** ticks since the ragdoll appeared */
  age: number
  /** 0..1 presentation scale (grow in, shrink away) */
  scale: number
}

/**
 * Ragdolls created in (tickF - 330, tickF], newest last. Skips Dead Ringer fakes (RAG.FEIGN) and ragdolls
 * that already existed when the recording started (created 0: deaths from before the demo).
 */
export function deathMarkersAt(x: HighlanderExtras, tickF: number, out: DeathMarker[] = []): DeathMarker[] {
  out.length = 0
  const r = x.ragdolls
  if (!r.count) return out
  const tick = Math.floor(tickF)
  const end = lowerBound(r.created, tick + 1)
  const start = lowerBound(r.created, tick - DEATH_MARKER_TICKS + 1, 0, end)
  for (let j = start; j < end; j++) {
    const created = r.created[j]
    if (created === 0 || (r.flags[j] & RAG.FEIGN) !== 0) continue
    const age = tickF - created
    if (age < 0 || age >= DEATH_MARKER_TICKS) continue
    const grow = Math.min(1, (age + 1) / DEATH_MARKER_GROW_TICKS)
    const shrink = Math.min(1, (DEATH_MARKER_TICKS - age) / DEATH_MARKER_SHRINK_TICKS)
    out.push({
      instance: j,
      player: r.player[j],
      team: r.team[j],
      gib: (r.flags[j] & RAG.GIB) !== 0,
      x: r.x[j],
      y: r.y[j],
      z: r.z[j],
      age,
      scale: Math.max(0, Math.min(grow, shrink)),
    })
  }
  return out
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
