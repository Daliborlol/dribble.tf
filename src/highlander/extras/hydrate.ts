// Hydration of the raw extras output (contract section 3.5). Runs in the extras worker before the result is
// posted, and in the Node checker (scripts/hl/check-extras.mjs bundles this file with esbuild).
//
// `hydrate` is a pure function of its inputs: it shifts every position field from absolute Source coordinates
// to scene space in place, then adds `derived` (flag masks and index lists). Excluded groups arrive empty
// (section 2.2), so every step runs on them unchanged.

import { deriveFlags } from './enums'
import type { ByPlayer, ExtrasRaw, F32, HighlanderExtras, U8 } from './types'

export type SceneOrigin = { x: number; y: number; z: number }

/** Subtracts `o` from every element (NaN stays NaN). */
function shiftAxis(field: F32, o: number): void {
  if (o === 0) return
  for (let i = 0; i < field.length; i++) field[i] -= o
}

/** Subtracts the origin from an interleaved xyz array (stride 3). */
function shiftStride3(field: F32, origin: SceneOrigin): void {
  const { x, y, z } = origin
  if (x === 0 && y === 0 && z === 0) return
  for (let i = 0; i + 2 < field.length; i += 3) {
    field[i] -= x
    field[i + 1] -= y
    field[i + 2] -= z
  }
}

function shiftXyz(xs: F32, ys: F32, zs: F32, origin: SceneOrigin): void {
  shiftAxis(xs, origin.x)
  shiftAxis(ys, origin.y)
  shiftAxis(zs, origin.z)
}

/**
 * Index list of the rows of a global EventList grouped by `keys[row]` (counting sort, tick order kept).
 * Rows whose key is not below `keyCount` (255 = world or unknown) are left out.
 */
export function buildByPlayer(keys: U8, keyCount: number): ByPlayer {
  const offsets = new Uint32Array(keyCount + 1)
  const n = keys.length
  for (let i = 0; i < n; i++) {
    const k = keys[i]
    if (k < keyCount) offsets[k + 1]++
  }
  for (let k = 0; k < keyCount; k++) offsets[k + 1] += offsets[k]
  const rows = new Uint32Array(offsets[keyCount])
  const fill = offsets.slice(0, keyCount)
  for (let i = 0; i < n; i++) {
    const k = keys[i]
    if (k < keyCount) rows[fill[k]++] = i
  }
  return { offsets, rows }
}

/** entity id -> instance indices; tables are sorted by (created, entityId), so each list is sorted by created. */
function byEntity(entityId: Uint16Array, count: number): Map<number, number[]> {
  const map = new Map<number, number[]>()
  for (let j = 0; j < count; j++) {
    const e = entityId[j]
    const list = map.get(e)
    if (list) list.push(j)
    else map.set(e, [j])
  }
  return map
}

/** Section 3.5. Mutates `raw` (positions shift in place) and returns it with `derived` attached. */
export function hydrate(raw: ExtrasRaw, sceneOrigin: SceneOrigin): HighlanderExtras {
  const origin: SceneOrigin = { x: sceneOrigin.x || 0, y: sceneOrigin.y || 0, z: sceneOrigin.z || 0 }

  // 1. Absolute Source coordinates -> scene space. Velocities, normals, half extents and quaternions stay.
  shiftStride3(raw.alignment.pos, origin)
  shiftXyz(raw.buildings.xform.x, raw.buildings.xform.y, raw.buildings.xform.z, origin)
  shiftStride3(raw.projectiles.pos, origin)
  shiftXyz(raw.flames.box.cx, raw.flames.box.cy, raw.flames.box.cz, origin)
  shiftXyz(raw.dots.pos.x, raw.dots.pos.y, raw.dots.pos.z, origin)
  shiftStride3(raw.objectives.cp.pos, origin)
  shiftXyz(raw.movers.xform.x, raw.movers.xform.y, raw.movers.xform.z, origin)
  shiftXyz(raw.pickups.x, raw.pickups.y, raw.pickups.z, origin)
  shiftXyz(raw.pickups.xform.x, raw.pickups.xform.y, raw.pickups.xform.z, origin)
  shiftXyz(raw.ragdolls.x, raw.ragdolls.y, raw.ragdolls.z, origin)
  shiftXyz(raw.drops.xform.x, raw.drops.xform.y, raw.drops.xform.z, origin)
  const te = raw.tempents
  shiftXyz(te.bullets.x, te.bullets.y, te.bullets.z, origin)
  shiftXyz(te.explosions.x, te.explosions.y, te.explosions.z, origin)
  shiftXyz(te.tracers.sx, te.tracers.sy, te.tracers.sz, origin)
  shiftXyz(te.tracers.ex, te.tracers.ey, te.tracers.ez, origin)
  shiftXyz(te.particles.x, te.particles.y, te.particles.z, origin)
  shiftXyz(te.clientProjectiles.x, te.clientProjectiles.y, te.clientProjectiles.z, origin)

  // 2. HL flag mask per players.cond entry.
  const cond = raw.players.cond
  const n = cond.ticks.length
  const flags = new Uint32Array(n)
  for (let i = 0; i < n; i++) flags[i] = deriveFlags(cond.w0[i], cond.w1[i], cond.w2[i], cond.w3[i], cond.w4[i])

  // 3. entity id -> player index (first index wins, like AsyncParser.playerIndexOfEntity).
  const entityToPlayer = new Map<number, number>()
  const ids = raw.players.entityId
  for (let p = 0; p < ids.length; p++) {
    const e = ids[p]
    if (e !== 0 && !entityToPlayer.has(e)) entityToPlayer.set(e, p)
  }

  // 4. Per-player index lists.
  const playerCount = raw.players.count
  const fireByPlayer = buildByPlayer(raw.players.fire.player, playerCount)
  const animByPlayer = buildByPlayer(raw.players.anim.player, playerCount)
  const bulletsByPlayer = buildByPlayer(te.bullets.player, playerCount)
  const hurtsByVictim = buildByPlayer(raw.hurts.victim, playerCount)
  const hurtsByAttacker = buildByPlayer(raw.hurts.attacker, playerCount)

  // 5. Instance lookups by entity id.
  const projectilesByEntity = byEntity(raw.projectiles.entityId, raw.projectiles.count)
  const buildingsByEntity = byEntity(raw.buildings.entityId, raw.buildings.count)

  // 6. Event indices by type.
  const eventsByType: Record<string, number[]> = {}
  const events = raw.events
  for (let i = 0; i < events.length; i++) {
    const t = events[i].t
    const list = eventsByType[t]
    if (list) list.push(i)
    else eventsByType[t] = [i]
  }

  const extras = raw as HighlanderExtras
  extras.derived = {
    sceneOrigin: origin,
    flags,
    entityToPlayer,
    fireByPlayer,
    animByPlayer,
    bulletsByPlayer,
    hurtsByVictim,
    hurtsByAttacker,
    projectilesByEntity,
    buildingsByEntity,
    eventsByType,
  }
  return extras
}

/**
 * Every typed array's buffer below `value`, deduplicated (a buffer listed twice makes postMessage throw).
 * Plain arrays (events, convars, strings) and Maps hold no typed arrays in this schema and are skipped.
 */
export function collectBuffers(value: unknown): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>()
  const walk = (v: unknown) => {
    if (v === null || typeof v !== 'object') return
    if (ArrayBuffer.isView(v)) {
      if (v.buffer instanceof ArrayBuffer) out.add(v.buffer)
      return
    }
    if (Array.isArray(v) || v instanceof Map || v instanceof Set) return
    for (const key of Object.keys(v)) walk((v as Record<string, unknown>)[key])
  }
  walk(value)
  return Array.from(out)
}

/** Sum of the byteLength of every typed array below `value` (same walk as collectBuffers). */
export function typedArrayBytes(value: unknown): number {
  let total = 0
  const seen = new Set<object>()
  const walk = (v: unknown) => {
    if (v === null || typeof v !== 'object') return
    if (ArrayBuffer.isView(v)) {
      total += v.byteLength
      return
    }
    if (seen.has(v) || Array.isArray(v) || v instanceof Map || v instanceof Set) return
    seen.add(v)
    for (const key of Object.keys(v)) walk((v as Record<string, unknown>)[key])
  }
  walk(value)
  return total
}
