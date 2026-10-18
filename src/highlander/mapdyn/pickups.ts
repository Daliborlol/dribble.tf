// Health and ammo pickups (contract section 5 F6): which pickup instances are map kits, grouped by kit spot,
// and the pure state of a spot at a tick.
//
// Map kits only. Besides the map's item_healthkit_* and item_ammopack_* entities, the extras `pickups` group
// holds every entity whose model matches the contract's plate pattern (2.5.7): thrown lunchbox items
// (models/items/plate.mdl, the banana, chocolate and other workshop plates) and props such as pl_divulgence's
// door_grate002_floorplate.mdl. The extras keep a pickup's origin at creation only, and a thrown lunchbox
// item leaves the thrower's eyes at 500 u/s (tf_weapon_lunchbox.cpp:215-285), so F6 cannot place it on the
// ground. F6 therefore draws only models/items/{medkit,ammopack}_{small,medium,large}.mdl. Kits that a Candy
// Cane kill drops (tf_player.cpp DropHealthPack: an item_healthkit_small thrown up from the victim's centre)
// share that model and are told apart by their spot: a map kit exists when the recording starts, shares its
// origin with another instance (every round restart re-creates it), respawns (vis 0, then 1), outlives a
// thrown kit (30 s) or stands on a map-meta item.
//
// Spots. Instances at one origin are one kit spot. At tick T a spot shows only its newest instance created at
// or before T: an entity that leaves the snapshot at a round restart without a delete stays a dormant
// instance until the demo ends, while the restart's new instance stands at the same origin.
//
// Taken and back. A kit is taken when its entity leaves the snapshot (vis 0) and back when it re-enters
// (vis 1). The respawn ring fills by (tickF - takenTick) / (nextTick - takenTick), where nextTick is the next
// vis entry. Without a next entry the kit would return ITEM_RESPAWN_SECONDS after the take. When the instance
// ends first (round restart, demo end), the ring fills toward that estimate and stops with the instance, so
// an estimated ring never shows full. An instance that lives on past the estimate without coming back left
// for good (stale) and draws nothing.

import { trackIndexAt, trackNextTick } from '@highlander/extras/track'
import type { HighlanderExtras } from '@highlander/extras/types'
import type { MapMeta } from '@highlander/map/mapMeta'

import {
  DROPPED_KIT_MAX_SECONDS,
  ITEM_RESPAWN_SECONDS,
  ITEM_RESPAWN_SLACK_SECONDS,
  KIT_SPOT_RADIUS,
  META_ITEM_RADIUS,
} from './constants'
import { NONE_U32, isAlive } from './movers'

export const PICKUP_KIND_NAMES = ['health', 'ammo'] as const
export const PICKUP_SIZE_NAMES = ['small', 'medium', 'large'] as const

/** The map kit models: contract 2.5.7 without the plate rule. */
export const MAP_KIT_MODEL = /(^|\/)models\/items\/(medkit|ammopack)_(small|medium|large)\.mdl$/

/** Why a pickup instance draws nothing: not a kit model (plates, props), or a kit a player threw or dropped. */
export type SkipReason = 'model' | 'dropped'

/** One kit spot: map kit instances at one origin, or a map-meta item when the extras have no pickups. */
export interface KitEntry {
  /** pickup instances at this spot, oldest first; empty for a map-meta item (always visible) */
  instances: number[]
  kind: number // 0 health, 1 ammo
  size: number // 0 small, 1 medium, 2 large
  x: number // scene space, entity origin
  y: number
  z: number
}

export interface SkippedPickup {
  instance: number
  reason: SkipReason
  model: string
}

export interface KitEntries {
  source: 'extras' | 'meta' | 'none'
  entries: KitEntry[]
  skipped: SkippedPickup[]
}

const intervalOf = (x: HighlanderExtras) => x.meta.intervalPerTick || 0.015

/** Model path of pickup instance j, lower case with forward slashes ('' when unknown). */
export function pickupModel(x: HighlanderExtras, j: number): string {
  return (x.strings.models[x.pickups.model[j]] ?? '').replace(/\\/g, '/').toLowerCase()
}

/** True when the instance's vis track re-enters after a leave (a map kit respawning). */
function respawned(x: HighlanderExtras, j: number): boolean {
  const vis = x.pickups.vis
  let left = false
  for (let i = vis.offsets[j]; i < vis.offsets[j + 1]; i++) {
    if (vis.v[i] === 0) left = true
    else if (left) return true
  }
  return false
}

/**
 * Map kit spots from the extras pickups when available, else the map-meta items (contract F6 fallback).
 * `meta` is optional with extras pickups: its items only confirm spots the other rules may miss.
 */
export function buildKitEntries(x: HighlanderExtras, meta: MapMeta | null, allowMeta: boolean): KitEntries {
  const p = x.pickups
  const o = x.derived.sceneOrigin
  if (x.meta.available.pickups && p.count > 0) {
    const skipped: SkippedPickup[] = []
    const spots: { x: number; y: number; z: number; members: number[] }[] = []
    const r2 = KIT_SPOT_RADIUS * KIT_SPOT_RADIUS
    for (let j = 0; j < p.count; j++) {
      const model = pickupModel(x, j)
      if (!MAP_KIT_MODEL.test(model)) {
        skipped.push({ instance: j, reason: 'model', model })
        continue
      }
      let spot = spots.find(s => (s.x - p.x[j]) ** 2 + (s.y - p.y[j]) ** 2 + (s.z - p.z[j]) ** 2 <= r2)
      if (!spot) {
        spot = { x: p.x[j], y: p.y[j], z: p.z[j], members: [] }
        spots.push(spot)
      }
      spot.members.push(j)
    }

    const metaItems = (meta?.items ?? [])
      .filter(item => Array.isArray(item.origin))
      .map(item => [item.origin[0] - o.x, item.origin[1] - o.y, item.origin[2] - o.z])
    const m2 = META_ITEM_RADIUS * META_ITEM_RADIUS
    const lifetimeLimit = Math.round(DROPPED_KIT_MAX_SECONDS / intervalOf(x))
    const entries: KitEntry[] = []
    for (const spot of spots) {
      const shared = spot.members.length > 1
      const onMetaItem = metaItems.some(([mx, my, mz]) => (mx - spot.x) ** 2 + (my - spot.y) ** 2 + (mz - spot.z) ** 2 <= m2)
      const kept = spot.members.filter(j => {
        const end = p.deleted[j] === NONE_U32 ? x.meta.ticks : p.deleted[j]
        if (shared || onMetaItem || p.created[j] === 0 || end - p.created[j] > lifetimeLimit || respawned(x, j))
          return true
        skipped.push({ instance: j, reason: 'dropped', model: pickupModel(x, j) })
        return false
      })
      if (kept.length === 0) continue
      entries.push({
        instances: kept,
        kind: p.kind[kept[0]] === 1 ? 1 : 0,
        size: Math.min(2, p.size[kept[0]]),
        x: spot.x,
        y: spot.y,
        z: spot.z,
      })
    }
    skipped.sort((a, b) => a.instance - b.instance)
    return { source: 'extras', entries, skipped }
  }
  if (!allowMeta || !meta || meta.items.length === 0) return { source: 'none', entries: [], skipped: [] }
  const entries = meta.items
    .filter(item => !item.disabled && Array.isArray(item.origin))
    .map(item => ({
      instances: [] as number[],
      kind: item.kind === 'ammo' ? 1 : 0,
      size: item.size === 'small' ? 0 : item.size === 'full' ? 2 : 1,
      x: item.origin[0] - o.x,
      y: item.origin[1] - o.y,
      z: item.origin[2] - o.z,
    }))
  return { source: 'meta', entries, skipped: [] }
}

export interface PickupSample {
  /** the sampled pickup instance (for a spot: its newest instance created at or before the tick), -1 none */
  instance: number
  /** the instance draws at the tick: created <= tick < deleted and not stale */
  alive: boolean
  /** vis 1: the kit is there */
  visible: boolean
  /** taken without a return before the instance outlived the estimate: it left for good, nothing draws */
  stale: boolean
  /** while taken: tick of the take, the expected return tick, fill 0..1 and seconds left */
  takenTick: number
  nextTick: number
  progress: number
  respawnIn: number
  /** true when nextTick is the TF2 delay instead of a demo entry (the instance ended first) */
  estimated: boolean
}

export const newPickupSample = (): PickupSample => ({
  instance: -1,
  alive: false,
  visible: false,
  stale: false,
  takenTick: NaN,
  nextTick: NaN,
  progress: 0,
  respawnIn: 0,
  estimated: false,
})

/** The spot's newest instance created at or before `tick`, -1 before the first one. */
export function spotInstanceAt(x: HighlanderExtras, instances: readonly number[], tick: number): number {
  const created = x.pickups.created
  for (let k = instances.length - 1; k >= 0; k--) if (created[instances[k]] <= tick) return instances[k]
  return -1
}

/** State of a kit spot at tickF (its newest instance created by then). Pure. */
export function sampleKitSpot(x: HighlanderExtras, entry: KitEntry, tickF: number, out: PickupSample): PickupSample {
  return samplePickup(x, spotInstanceAt(x, entry.instances, Math.floor(tickF)), tickF, out)
}

/** State of pickup instance j at tickF. Pure. */
export function samplePickup(x: HighlanderExtras, j: number, tickF: number, out: PickupSample): PickupSample {
  out.instance = j
  out.alive = false
  out.visible = false
  out.stale = false
  out.takenTick = NaN
  out.nextTick = NaN
  out.progress = 0
  out.respawnIn = 0
  out.estimated = false
  const p = x.pickups
  const tick = Math.floor(tickF)
  if (j < 0 || j >= p.count || !isAlive(p.created, p.deleted, j, tick)) return out
  const i = trackIndexAt(p.vis, j, tick)
  if (i < 0 || p.vis.v[i] !== 0) {
    out.alive = true
    out.visible = true
    return out
  }
  const ipt = intervalOf(x)
  const takenTick = p.vis.ticks[i]
  let nextTick = trackNextTick(p.vis, j, tick)
  if (!Number.isFinite(nextTick)) {
    const estimate = takenTick + Math.round(ITEM_RESPAWN_SECONDS / ipt)
    const end = p.deleted[j] === NONE_U32 ? x.meta.ticks : p.deleted[j]
    if (end > estimate + Math.round(ITEM_RESPAWN_SLACK_SECONDS / ipt)) {
      out.stale = true
      return out
    }
    if (tickF >= estimate) return out
    nextTick = estimate
    out.estimated = true
  }
  const span = Math.max(1, nextTick - takenTick)
  out.alive = true
  out.takenTick = takenTick
  out.nextTick = nextTick
  out.progress = Math.min(1, Math.max(0, (tickF - takenTick) / span))
  out.respawnIn = Math.max(0, (nextTick - tickF) * ipt)
  return out
}
