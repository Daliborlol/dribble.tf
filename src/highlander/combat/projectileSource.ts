// Projectile source split (contract D13 and section 5 F3; owner F3, read by X2).
//
// An extras projectile instance belongs to Projectiles.tsx exactly when its entity has a typed base slot at the
// instance's start: the base projectile cache returns a projectile for that slot at t = min(created + 2, hidden - 1).
// Every other instance is drawn by ProjectilesExtraLayer, whatever its kind. X2 reads this table before it frees the
// base cache, so the split stays the same afterwards.

import type { AsyncParser } from '@components/Analyse/Data/AsyncParser'
import { BASE_TYPE_KINDS } from '@highlander/extras/enums'
import type { HighlanderExtras } from '@highlander/extras/types'

export interface ProjectileSource { servedByBase: Uint8Array; baseType: Uint8Array; mismatches: number }

/** Diagnostics next to the contract fields (the `projectiles.source` probe reports them). */
export interface ProjectileSourceStats {
  served: number
  extrasOnly: number
  /** served by the base with a base type the kind table does not expect */
  wrongType: number
  /** a kind the table expects in the base cache, but the base has no slot or no sample */
  missedByBase: number
  /** a kind the table does not expect in the base cache (cannonballs, flares ...) that the base serves */
  unexpectedBase: number
  /** per extras kind: [instances, served by base] */
  byKind: Record<number, [number, number]>
  /** per `kind:baseType` pair of the served instances */
  pairs: Record<string, number>
}

const NONE_U32 = 0xffffffff

/** Base cache type the table of contract 2.5.4 expects for an extras kind, 0 for none. */
export function expectedBaseType(kind: number): number {
  for (const type in BASE_TYPE_KINDS) {
    if (BASE_TYPE_KINDS[type].includes(kind)) return Number(type)
  }
  return 0
}

const cache = new WeakMap<HighlanderExtras, WeakMap<AsyncParser, ProjectileSource>>()
const statsCache = new WeakMap<ProjectileSource, ProjectileSourceStats>()

/** Built once per (extras, demo), cached. */
export function getProjectileSource(x: HighlanderExtras, demo: AsyncParser): ProjectileSource {
  let perDemo = cache.get(x)
  if (!perDemo) {
    perDemo = new WeakMap()
    cache.set(x, perDemo)
  }
  const cached = perDemo.get(demo)
  if (cached) return cached

  const pj = x.projectiles
  const n = pj.count
  const servedByBase = new Uint8Array(n)
  const baseType = new Uint8Array(n)
  // the base cache, or after X2 released it the adapter, which serves the same rows (memory/projectileAdapter.ts)
  const pc = demo.projectileReader()

  if (pc && Array.isArray(pc.projectileIds) && pc.projectileIds.length > 0) {
    // one base slot per entity id (lib.rs ensure_projectile), reused across lifetimes
    const slotOf = new Map<number, number>()
    pc.projectileIds.forEach((entityId, slot) => {
      if (!slotOf.has(entityId)) slotOf.set(entityId, slot)
    })
    const lastTick = Math.max(0, Math.min(demo.ticks, x.meta.ticks) - 1)
    for (let j = 0; j < n; j++) {
      const slot = slotOf.get(pj.entityId[j])
      if (slot === undefined) continue
      const created = pj.created[j]
      const hidden = pj.hidden[j]
      let t = created + 2
      if (hidden !== NONE_U32) t = Math.min(t, hidden - 1)
      t = Math.min(Math.max(t, created), lastTick)
      if (!pc.getProjectile(t, slot)) continue
      servedByBase[j] = 1
      baseType[j] = pc.getTypeCode(t, slot)
    }
  }

  const stats: ProjectileSourceStats = { served: 0, extrasOnly: 0, wrongType: 0, missedByBase: 0, unexpectedBase: 0, byKind: {}, pairs: {} }
  let mismatches = 0
  for (let j = 0; j < n; j++) {
    const kind = pj.kind[j]
    const expected = expectedBaseType(kind)
    const row = (stats.byKind[kind] ??= [0, 0])
    row[0]++
    if (servedByBase[j]) {
      stats.served++
      row[1]++
      const pair = `${kind}:${baseType[j]}`
      stats.pairs[pair] = (stats.pairs[pair] ?? 0) + 1
      if (expected === 0) {
        stats.unexpectedBase++
        mismatches++
      } else if (baseType[j] !== expected) {
        stats.wrongType++
        mismatches++
      }
    } else {
      stats.extrasOnly++
      if (expected !== 0) {
        stats.missedByBase++
        mismatches++
      }
    }
  }

  const source: ProjectileSource = { servedByBase, baseType, mismatches }
  statsCache.set(source, stats)
  perDemo.set(demo, source)
  return source
}

/** Diagnostics of a source built by getProjectileSource. */
export function projectileSourceStats(source: ProjectileSource): ProjectileSourceStats | undefined {
  return statsCache.get(source)
}
