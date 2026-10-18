// Base projectile adapter (contract section 5 X2, 12.3, 13.4).
//
// parser2 (and the fork's fallback builder) store the base projectile cache densely: for every slot (one per
// projectile entity id) a position and a rotation vector at every tick of the demo, plus a team and a type per
// 64-tick bucket. That is 205 MB on 1438891 and 641 MB on 1429417, while the slots hold a row at only 0.1 to 1.3 % of
// their ticks. Once the Highlander extras serve the projectiles, X2 copies the rows into this adapter and releases
// the dense arrays (AsyncParser.releaseProjectileCache).
//
// The copy is exact. Every row keeps the raw fixed-point position and rotation values, the bucket team and type, and
// decodes them with the cache's own scales (positionScale 1024 for parser2, 32 for the fallback; rotations 256), so
// a reader gets the same numbers, the same rows and the same order (slot order) as from the cache. The rows are
// grouped into tracks: a track is a run of consecutive ticks of one slot with a row at every tick, owned by one
// extras instance with servedByBase[j] === 1 (F3's source split), whose type is baseType[j]. Its rows cover the
// instance's whole life [created, deleted), the landed phase [hidden, deleted) included, because the cache has a row
// there. A row outside every served instance's life would go to an orphan track that keeps its bucket type; on the
// measured demos (1434434, 1438891, 1428628, 1429417, the 6v6 sample) there are none, and every served instance has
// a row at every tick of its life. Within a track, consecutive identical rows form one run, which folds resting
// stickies: 55,299 runs for 153,780 rows on 1438891, 33,543 for 291,122 on the 6v6 sample.
//
// The adapter holds only its own typed arrays and a copy of the slot entity ids: no demo, extras or store reference
// (12.3), so an extras restart, reload or error after the release changes nothing it serves.

import { ProjectileTypeMap } from '@components/Analyse/Data/ProjectileCache'
import type { CachedProjectile, ProjectileCache, ProjectileReader } from '@components/Analyse/Data/ProjectileCache'
import type { ProjectileSource } from '@highlander/combat/projectileSource'
import type { HighlanderExtras } from '@highlander/extras/types'

const NONE_U32 = 0xffffffff
/** The bucket index of getProjectiles: 128-tick buckets. */
const BUCKET_SHIFT = 7
const EMPTY: readonly number[] = []

export interface ProjectileAdapterStats {
  slots: number
  tracks: number
  /** Tracks of rows outside every served instance's life. */
  orphanTracks: number
  /** Rows served (base rows copied). */
  rows: number
  orphanRows: number
  runs: number
  /** Rows whose bucket type differs from their instance's baseType (served with baseType). */
  typeOverrides: number
  /** Served instances (servedByBase 1) and how many of them own at least one track. */
  servedInstances: number
  servedWithRows: number
  /** Ticks of served lives [created, min(deleted, ticks)) without a base row. */
  servedTicksWithoutRow: number
  /** Bytes of the adapter's typed arrays and id copy. */
  bytes: number
  positionScale: number
  rotationScale: number
}

/** `array`, or a copy at least `need` long (doubling) while the build does not know the final sizes. */
function grow<T extends Uint32Array | Int32Array | Uint8Array>(array: T, need: number): T {
  if (need <= array.length) return array
  const next = new (array.constructor as new (length: number) => T)(Math.max(need, array.length * 2))
  next.set(array)
  return next
}

export class ProjectileAdapter implements ProjectileReader {
  readonly projectileIds: readonly number[]
  readonly stats: ProjectileAdapterStats
  private readonly positionScale: number
  private readonly rotationScale: number
  // tracks: slot, [start, end), served type (0: an orphan track, use the run's code), runs [run[t], run[t + 1])
  private readonly trackSlot: Uint32Array
  private readonly trackStart: Uint32Array
  private readonly trackEnd: Uint32Array
  private readonly trackType: Uint8Array
  private readonly trackRun: Uint32Array
  /** The tracks of slot s are slotTrack[s] .. slotTrack[s + 1] - 1, by start. */
  private readonly slotTrack: Uint32Array
  // runs: first tick, raw position and rotation, bucket team and type code
  private readonly runTick: Uint32Array
  private readonly runPos: Int32Array
  private readonly runRot: Int32Array
  private readonly runTeam: Uint8Array
  private readonly runCode: Uint8Array
  /** Tracks overlapping bucket b: bucketTrack[bucketOffset[b] .. bucketOffset[b + 1]), in slot order. */
  private readonly bucketOffset: Uint32Array
  private readonly bucketTrack: Uint32Array

  constructor(parts: {
    projectileIds: readonly number[]
    positionScale: number
    rotationScale: number
    trackSlot: Uint32Array
    trackStart: Uint32Array
    trackEnd: Uint32Array
    trackType: Uint8Array
    trackRun: Uint32Array
    slotTrack: Uint32Array
    runTick: Uint32Array
    runPos: Int32Array
    runRot: Int32Array
    runTeam: Uint8Array
    runCode: Uint8Array
    bucketOffset: Uint32Array
    bucketTrack: Uint32Array
    stats: Omit<ProjectileAdapterStats, 'bytes'>
  }) {
    this.projectileIds = parts.projectileIds
    this.positionScale = parts.positionScale
    this.rotationScale = parts.rotationScale
    this.trackSlot = parts.trackSlot
    this.trackStart = parts.trackStart
    this.trackEnd = parts.trackEnd
    this.trackType = parts.trackType
    this.trackRun = parts.trackRun
    this.slotTrack = parts.slotTrack
    this.runTick = parts.runTick
    this.runPos = parts.runPos
    this.runRot = parts.runRot
    this.runTeam = parts.runTeam
    this.runCode = parts.runCode
    this.bucketOffset = parts.bucketOffset
    this.bucketTrack = parts.bucketTrack
    let bytes = this.projectileIds.length * 8
    for (const array of [
      this.trackSlot, this.trackStart, this.trackEnd, this.trackType, this.trackRun, this.slotTrack,
      this.runTick, this.runPos, this.runRot, this.runTeam, this.runCode, this.bucketOffset, this.bucketTrack,
    ]) {
      bytes += array.byteLength
    }
    this.stats = { ...parts.stats, bytes }
  }

  /**
   * Every row at `tick` in slot order, as ProjectileCache.getProjectiles returns it. `exactType` serves the bucket
   * type instead of the instance's baseType (the release self-check compares that against the cache).
   */
  getProjectiles(tick: number, exactType = false): CachedProjectile[] {
    const out: CachedProjectile[] = []
    // the cache has no row at a negative or fractional tick (its arrays have no such index)
    if (!Number.isInteger(tick) || tick < 0) return out
    const b = tick >> BUCKET_SHIFT
    if (b + 1 >= this.bucketOffset.length) return out
    for (let k = this.bucketOffset[b], end = this.bucketOffset[b + 1]; k < end; k++) {
      const track = this.bucketTrack[k]
      if (tick < this.trackStart[track] || tick >= this.trackEnd[track]) continue
      out.push(this.row(track, this.runAt(track, tick), exactType))
    }
    return out
  }

  getProjectile(tick: number, index: number, exactType = false): CachedProjectile | null {
    const track = this.trackAt(tick, index)
    return track < 0 ? null : this.row(track, this.runAt(track, tick), exactType)
  }

  getTypeCode(tick: number, index: number): number {
    const track = this.trackAt(tick, index)
    return track < 0 ? 0 : this.trackType[track] || this.runCode[this.runAt(track, tick)]
  }

  /** The track of slot `index` with a row at `tick`, or -1. */
  private trackAt(tick: number, index: number): number {
    if (!Number.isInteger(tick) || tick < 0 || !Number.isInteger(index) || index < 0 || index >= this.projectileIds.length) return -1
    let lo = this.slotTrack[index]
    let hi = this.slotTrack[index + 1] - 1
    if (hi < lo) return -1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.trackStart[mid] <= tick) lo = mid
      else hi = mid - 1
    }
    return this.trackStart[lo] <= tick && tick < this.trackEnd[lo] ? lo : -1
  }

  /** The run of `track` holding `tick` (start <= tick < end). */
  private runAt(track: number, tick: number): number {
    let lo = this.trackRun[track]
    let hi = this.trackRun[track + 1] - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.runTick[mid] <= tick) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  private row(track: number, run: number, exactType: boolean): CachedProjectile {
    const p = this.positionScale
    const r = this.rotationScale
    const i = run * 3
    // the cache's key order and VectorCache's decoding: (raw | 0) / scale
    return {
      entityId: this.projectileIds[this.trackSlot[track]],
      position: { x: this.runPos[i] / p, y: this.runPos[i + 1] / p, z: this.runPos[i + 2] / p },
      rotation: { x: this.runRot[i] / r, y: this.runRot[i + 1] / r, z: this.runRot[i + 2] / r },
      teamNumber: this.runTeam[run],
      type: ProjectileTypeMap[exactType ? this.runCode[run] : this.trackType[track] || this.runCode[run]],
    }
  }
}

/**
 * Copies every row of the base cache into an adapter (call it while the cache still holds its arrays). `source` is
 * F3's split for these extras (getProjectileSource), which assigns the rows to served instances and their type.
 */
export function buildProjectileAdapter(cache: ProjectileCache, ticks: number, x: HighlanderExtras, source: ProjectileSource): ProjectileAdapter {
  const ids = cache.projectileIds
  const slots = ids.length
  const pj = x.projectiles
  const byEntity = x.derived.projectilesByEntity
  const served = source.servedByBase
  const baseType = source.baseType

  let runTick = new Uint32Array(4096)
  let runPos = new Int32Array(4096 * 3)
  let runRot = new Int32Array(4096 * 3)
  let runTeam = new Uint8Array(4096)
  let runCode = new Uint8Array(4096)
  let runs = 0
  let trackSlot = new Uint32Array(1024)
  let trackStart = new Uint32Array(1024)
  let trackEnd = new Uint32Array(1024)
  let trackType = new Uint8Array(1024)
  let trackRun = new Uint32Array(1025)
  let tracks = 0
  const slotTrack = new Uint32Array(slots + 1)
  const owned = new Uint8Array(pj.count)
  let rows = 0
  let orphanRows = 0
  let orphanTracks = 0
  let typeOverrides = 0
  let span = Math.max(0, ticks)
  // the cache's own layout (DataCache.getOffset): vectors at tick * 3 + c, team and type at (tick >> 6) * 1
  const pv = cache.positionCache.valuesPerPlayer
  const rv = cache.rotationCache.valuesPerPlayer
  const teamShift = cache.teamNumberCache.sparse
  const teamStride = cache.teamNumberCache.valuesPerPlayer
  const typeShift = cache.typeCache.sparse
  const typeStride = cache.typeCache.valuesPerPlayer

  for (let slot = 0; slot < slots; slot++) {
    slotTrack[slot] = tracks
    const pos = cache.positionCache.data[slot]
    if (!pos) continue
    const rot = cache.rotationCache.data[slot]
    const team = cache.teamNumberCache.data[slot]
    const type = cache.typeCache.data[slot]
    const list = byEntity.get(ids[slot]) ?? EMPTY
    // the cache reads index tick * 3, so its rows end where the slot's array ends
    const end = Math.floor(pos.length / pv)
    span = Math.max(span, end)
    let k = -1 // list[k]: the newest instance of this entity created at or before t
    let open = -1 // the track that ends at t, -1 after a tick without a row
    let openOwner = -1
    for (let t = 0; t < end; t++) {
      const i = t * pv
      const px = pos[i] | 0
      const py = pos[i + 1] | 0
      const pz = pos[i + 2] | 0
      // ProjectileCache.getProjectile: no row while the position is (0, 0, 0) or the bucket type has no name
      if ((px | py | pz) === 0) {
        open = -1
        continue
      }
      const code = type ? type[(t >> typeShift) * typeStride] : undefined
      if (code === undefined || !ProjectileTypeMap[code]) {
        open = -1
        continue
      }
      while (k + 1 < list.length && pj.created[list[k + 1]] <= t) k++
      let owner = -1
      if (k >= 0) {
        const j = list[k]
        const deleted = pj.deleted[j]
        if (served[j] && (deleted === NONE_U32 || t < deleted)) owner = j
      }
      if (open < 0 || owner !== openOwner) {
        trackSlot = grow(trackSlot, tracks + 1)
        trackStart = grow(trackStart, tracks + 1)
        trackEnd = grow(trackEnd, tracks + 1)
        trackType = grow(trackType, tracks + 1)
        trackRun = grow(trackRun, tracks + 2)
        open = tracks++
        openOwner = owner
        trackSlot[open] = slot
        trackStart[open] = t
        trackType[open] = owner >= 0 ? baseType[owner] : 0
        trackRun[open] = runs
        if (owner >= 0) owned[owner] = 1
        else orphanTracks++
      }
      trackEnd[open] = t + 1
      rows++
      if (owner < 0) orphanRows++
      else if (code !== trackType[open]) typeOverrides++

      const ri = t * rv
      const rx = rot ? rot[ri] | 0 : 0
      const ry = rot ? rot[ri + 1] | 0 : 0
      const rz = rot ? rot[ri + 2] | 0 : 0
      // an index past the bucket array would make the cache's team undefined; the release self-check would see it
      const tm = team ? team[(t >> teamShift) * teamStride] ?? 0 : 0
      const last = runs - 1
      const r = last * 3
      if (
        last >= trackRun[open] &&
        runPos[r] === px && runPos[r + 1] === py && runPos[r + 2] === pz &&
        runRot[r] === rx && runRot[r + 1] === ry && runRot[r + 2] === rz &&
        runTeam[last] === tm && runCode[last] === code
      ) {
        continue // the same row as the tick before: the run goes on
      }
      runTick = grow(runTick, runs + 1)
      runPos = grow(runPos, (runs + 1) * 3)
      runRot = grow(runRot, (runs + 1) * 3)
      runTeam = grow(runTeam, runs + 1)
      runCode = grow(runCode, runs + 1)
      const w = runs * 3
      runTick[runs] = t
      runPos[w] = px
      runPos[w + 1] = py
      runPos[w + 2] = pz
      runRot[w] = rx
      runRot[w + 1] = ry
      runRot[w + 2] = rz
      runTeam[runs] = tm
      runCode[runs] = code
      runs++
    }
  }
  slotTrack[slots] = tracks
  trackRun = grow(trackRun, tracks + 1)
  trackRun[tracks] = runs

  // bucket index, filled in track order, so every bucket lists its tracks in slot order
  const bucketCount = (span >> BUCKET_SHIFT) + 1
  const bucketOffset = new Uint32Array(bucketCount + 1)
  for (let tr = 0; tr < tracks; tr++) {
    for (let b = trackStart[tr] >> BUCKET_SHIFT, last = (trackEnd[tr] - 1) >> BUCKET_SHIFT; b <= last; b++) bucketOffset[b + 1]++
  }
  for (let b = 0; b < bucketCount; b++) bucketOffset[b + 1] += bucketOffset[b]
  const bucketTrack = new Uint32Array(bucketOffset[bucketCount])
  const fill = bucketOffset.slice(0, bucketCount)
  for (let tr = 0; tr < tracks; tr++) {
    for (let b = trackStart[tr] >> BUCKET_SHIFT, last = (trackEnd[tr] - 1) >> BUCKET_SHIFT; b <= last; b++) bucketTrack[fill[b]++] = tr
  }

  let servedInstances = 0
  let servedWithRows = 0
  let servedTicksWithoutRow = 0
  for (let j = 0; j < pj.count; j++) {
    if (!served[j]) continue
    servedInstances++
    servedWithRows += owned[j]
    const deleted = pj.deleted[j]
    const lifeEnd = Math.min(deleted === NONE_U32 ? ticks : deleted, ticks)
    servedTicksWithoutRow += Math.max(0, lifeEnd - pj.created[j])
  }
  servedTicksWithoutRow -= rows - orphanRows

  return new ProjectileAdapter({
    projectileIds: ids.slice(),
    positionScale: cache.positionCache.scale,
    rotationScale: cache.rotationCache.scale,
    trackSlot: trackSlot.slice(0, tracks),
    trackStart: trackStart.slice(0, tracks),
    trackEnd: trackEnd.slice(0, tracks),
    trackType: trackType.slice(0, tracks),
    trackRun: trackRun.slice(0, tracks + 1),
    slotTrack,
    runTick: runTick.slice(0, runs),
    runPos: runPos.slice(0, runs * 3),
    runRot: runRot.slice(0, runs * 3),
    runTeam: runTeam.slice(0, runs),
    runCode: runCode.slice(0, runs),
    bucketOffset,
    bucketTrack,
    stats: {
      slots,
      tracks,
      orphanTracks,
      rows,
      orphanRows,
      runs,
      typeOverrides,
      servedInstances,
      servedWithRows,
      servedTicksWithoutRow,
      positionScale: cache.positionCache.scale,
      rotationScale: cache.rotationCache.scale,
    },
  })
}

export interface ReaderComparison {
  ticks: number
  rows: number
  mismatches: number
  first?: { tick: number; field: string; cache: unknown; adapter: unknown }
}

/**
 * Compares the adapter's exact rows (bucket types) with a reader (the cache before its release) at `ticks`: the same
 * rows in the same order with the same entity ids, types, teams, positions and rotations.
 */
export function compareWithReader(adapter: ProjectileAdapter, reader: ProjectileReader, ticks: Iterable<number>): ReaderComparison {
  const result: ReaderComparison = { ticks: 0, rows: 0, mismatches: 0 }
  const note = (tick: number, field: string, a: unknown, b: unknown) => {
    result.mismatches++
    result.first ??= { tick, field, cache: a, adapter: b }
  }
  for (const tick of ticks) {
    result.ticks++
    const want = reader.getProjectiles(tick)
    const got = adapter.getProjectiles(tick, true)
    result.rows += want.length
    if (want.length !== got.length) {
      note(tick, 'count', want.length, got.length)
      continue
    }
    for (let i = 0; i < want.length; i++) {
      const a = want[i]
      const b = got[i]
      if (a.entityId !== b.entityId) note(tick, 'entityId', a.entityId, b.entityId)
      else if (a.type !== b.type) note(tick, 'type', a.type, b.type)
      else if (a.teamNumber !== b.teamNumber) note(tick, 'teamNumber', a.teamNumber, b.teamNumber)
      else if (!Object.is(a.position.x, b.position.x) || !Object.is(a.position.y, b.position.y) || !Object.is(a.position.z, b.position.z)) {
        note(tick, 'position', a.position, b.position)
      } else if (!Object.is(a.rotation.x, b.rotation.x) || !Object.is(a.rotation.y, b.rotation.y) || !Object.is(a.rotation.z, b.rotation.z)) {
        note(tick, 'rotation', a.rotation, b.rotation)
      }
    }
  }
  return result
}

/** `count` ticks spread evenly over [0, ticks), the release self-check's sample. */
export function sampleTicks(ticks: number, count: number): number[] {
  const out: number[] = []
  if (ticks <= 0) return out
  const n = Math.min(count, ticks)
  for (let k = 0; k < n; k++) out.push(Math.min(ticks - 1, Math.floor(((k + 0.5) * ticks) / n)))
  return out
}
