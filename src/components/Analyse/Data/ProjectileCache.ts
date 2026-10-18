import { Vector } from './Types'

import { SparseDataCache } from './SparseDataCache'
import { VectorCache } from './VectorCache'
import { POSITION_FIXED_SCALE } from './PositionEncoding'

export interface CachedProjectile {
  entityId: number
  type: string
  position: Vector
  rotation: Vector
  teamNumber: number
}

/** Base cache type codes (`typeCache` values) and the names readers get. */
export const ProjectileTypeMap: Record<number, string> = {
  1: 'rocket',
  2: 'pipebomb',
  3: 'stickybomb',
  4: 'healingBolt',
}

/**
 * Read access to the base projectile rows: one slot per entity id (`projectileIds`), at most one row per slot and
 * tick. The cache implements it, and so does the compact copy that replaces it once the Highlander extras serve the
 * projectiles (task X2: AsyncParser.releaseProjectileCache, src/highlander/memory/projectileAdapter.ts).
 */
export interface ProjectileReader {
  readonly projectileIds: readonly number[]
  /** The row of slot `index` at `tick`, null when the slot holds no typed projectile then. */
  getProjectile(tick: number, index: number): CachedProjectile | null
  /** Every row at `tick`, in slot order. */
  getProjectiles(tick: number): CachedProjectile[]
  /** The type code (a ProjectileTypeMap key) of slot `index` at `tick`; meaningful where getProjectile is not null. */
  getTypeCode(tick: number, index: number): number
}

export class ProjectileCache implements ProjectileReader {
  positionCache: VectorCache
  rotationCache: VectorCache
  teamNumberCache: SparseDataCache
  typeCache: SparseDataCache
  projectileCount: number = 0
  projectileIds: number[]

  constructor(tickCount: number, positionOffset: Vector) {
    this.positionCache = new VectorCache(tickCount, positionOffset, POSITION_FIXED_SCALE)
    this.rotationCache = new VectorCache(tickCount)
    this.teamNumberCache = new SparseDataCache(tickCount, 1, 8, 6)
    this.typeCache = new SparseDataCache(tickCount, 1, 8, 6)
    this.projectileIds = []
  }

  setProjectileIds(ids: number[]) {
    this.projectileIds = ids
    this.projectileCount = ids.length
  }

  getProjectile(tick: number, index: number): CachedProjectile | null {
    const entityId = this.projectileIds[index]
    if (entityId === undefined) {
      return null
    }

    const x = this.positionCache.get(index, tick, 0)
    const y = this.positionCache.get(index, tick, 1)
    const z = this.positionCache.get(index, tick, 2)
    if ((x | y | z) === 0) {
      return null
    }
    const type = ProjectileTypeMap[this.typeCache.get(index, tick)]

    if (!type) {
      return null
    }

    return {
      entityId: entityId,
      position: this.positionCache.getVector(index, tick),
      rotation: this.rotationCache.getVector(index, tick),
      teamNumber: this.teamNumberCache.get(index, tick),
      type: type,
    }
  }

  getTypeCode(tick: number, index: number): number {
    return this.typeCache.get(index, tick)
  }

  getProjectiles(tick: number) {
    let projectiles: CachedProjectile[] = []

    for (let index = 0; index < this.projectileIds.length; index++) {
      const projectile = this.getProjectile(tick, index)
      if (projectile) {
        projectiles.push(projectile)
      }
    }

    return projectiles
  }

  static rehydrate(data: ProjectileCache) {
    VectorCache.rehydrate(data.positionCache)
    VectorCache.rehydrate(data.rotationCache)
    SparseDataCache.rehydrate(data.teamNumberCache)
    SparseDataCache.rehydrate(data.typeCache)

    if (!data.projectileIds) {
      data.projectileIds = []
    }
    data.projectileCount = data.projectileIds.length

    Object.setPrototypeOf(data, ProjectileCache.prototype)
  }
}
