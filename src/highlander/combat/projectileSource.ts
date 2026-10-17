// Projectile source split (contract D13 and section 5 F3; owner F3, read by X2). S0 writes the types and a stub.

import type { AsyncParser } from '@components/Analyse/Data/AsyncParser'
import type { HighlanderExtras } from '@highlander/extras/types'

export interface ProjectileSource { servedByBase: Uint8Array; baseType: Uint8Array; mismatches: number }
/** Built once per (extras, demo), cached. S0 stub: empty arrays, so nothing counts as served by the base cache. */
export function getProjectileSource(_x: HighlanderExtras, _demo: AsyncParser): ProjectileSource {
  return { servedByBase: new Uint8Array(0), baseType: new Uint8Array(0), mismatches: 0 }
}
