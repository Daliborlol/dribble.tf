// Health and ammo pickups (contract section 5 F6): pure state per instance at a tick.
//
// A map pickup is taken when its entity leaves the SourceTV snapshot (vis 0) and back when it re-enters
// (vis 1, same serial). The respawn ring fills by (tickF - takenTick) / (nextTick - takenTick), where
// nextTick is the next vis entry. When the demo ends before the kit returns, the TF2 respawn delay
// (10 s) stands in for the missing entry.

import { trackIndexAt, trackNextTick } from '@highlander/extras/track'
import type { HighlanderExtras } from '@highlander/extras/types'
import type { MapMeta } from '@highlander/map/mapMeta'

import { ITEM_RESPAWN_SECONDS } from './constants'
import { isAlive } from './movers'

export const PICKUP_KIND_NAMES = ['health', 'ammo'] as const
export const PICKUP_SIZE_NAMES = ['small', 'medium', 'large'] as const

/** One kit spot: an extras pickup instance, or a map-meta item when the extras have no pickups. */
export interface KitEntry {
  /** pickups instance index, -1 for a map-meta item (always visible) */
  instance: number
  kind: number // 0 health, 1 ammo
  size: number // 0 small, 1 medium, 2 large
  x: number // scene space, entity origin
  y: number
  z: number
}

/** Extras pickup instances when available, else the map-meta items (contract F6 fallback). */
export function buildKitEntries(
  x: HighlanderExtras,
  meta: MapMeta | null,
  allowMeta: boolean
): { source: 'extras' | 'meta' | 'none'; entries: KitEntry[] } {
  const p = x.pickups
  if (x.meta.available.pickups && p.count > 0) {
    const entries: KitEntry[] = []
    for (let j = 0; j < p.count; j++) {
      entries.push({
        instance: j,
        kind: p.kind[j] === 1 ? 1 : 0,
        size: Math.min(2, p.size[j]),
        x: p.x[j],
        y: p.y[j],
        z: p.z[j],
      })
    }
    return { source: 'extras', entries }
  }
  if (!allowMeta || !meta || meta.items.length === 0) return { source: 'none', entries: [] }
  const o = x.derived.sceneOrigin
  const entries = meta.items
    .filter(item => !item.disabled && Array.isArray(item.origin))
    .map(item => ({
      instance: -1,
      kind: item.kind === 'ammo' ? 1 : 0,
      size: item.size === 'small' ? 0 : item.size === 'full' ? 2 : 1,
      x: item.origin[0] - o.x,
      y: item.origin[1] - o.y,
      z: item.origin[2] - o.z,
    }))
  return { source: 'meta', entries }
}

export interface PickupSample {
  /** created <= tick < deleted */
  alive: boolean
  /** vis 1: the kit is there */
  visible: boolean
  /** while taken: tick of the take, the expected return tick, fill 0..1 and seconds left */
  takenTick: number
  nextTick: number
  progress: number
  respawnIn: number
  /** true when nextTick is the TF2 delay instead of a demo entry (demo ended first) */
  estimated: boolean
}

/** State of pickup instance j at tickF. Pure. */
export function samplePickup(x: HighlanderExtras, j: number, tickF: number, out: PickupSample): PickupSample {
  const p = x.pickups
  const tick = Math.floor(tickF)
  out.alive = isAlive(p.created, p.deleted, j, tick)
  out.visible = false
  out.takenTick = NaN
  out.nextTick = NaN
  out.progress = 0
  out.respawnIn = 0
  out.estimated = false
  if (!out.alive) return out
  const i = trackIndexAt(p.vis, j, tick)
  if (i < 0 || p.vis.v[i] !== 0) {
    out.visible = true
    return out
  }
  const takenTick = p.vis.ticks[i]
  let nextTick = trackNextTick(p.vis, j, tick)
  if (!Number.isFinite(nextTick)) {
    nextTick = takenTick + Math.round(ITEM_RESPAWN_SECONDS / (x.meta.intervalPerTick || 0.015))
    out.estimated = true
  }
  const span = Math.max(1, nextTick - takenTick)
  out.takenTick = takenTick
  out.nextTick = nextTick
  out.progress = Math.min(1, Math.max(0, (tickF - takenTick) / span))
  out.respawnIn = Math.max(0, (nextTick - tickF) * (x.meta.intervalPerTick || 0.015))
  return out
}
