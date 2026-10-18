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

import type { DataArray } from '@components/Analyse/Data/DataCache'
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

  /** Calls `fn` with the slot and the tick range [start, end) of every track, in slot order. */
  forEachTrack(fn: (slot: number, start: number, end: number) => void): void {
    for (let track = 0; track < this.trackSlot.length; track++) fn(this.trackSlot[track], this.trackStart[track], this.trackEnd[track])
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

/** Where the build finds a slot's values (DataCache.getOffset): vectors at tick * 3 + c, team and type per bucket. */
interface CacheLayout {
  pv: number
  rv: number
  teamShift: number
  teamStride: number
  typeShift: number
  typeStride: number
}

/**
 * The adapter's arrays while the build fills them. The per-slot scan is a method of its own: a small function with
 * monomorphic arrays that the JIT optimizes within the first slot. As one large function, the build's first call ran
 * about 30 ms slower than later calls, while V8 compiled it twice (17 and 11 ms) and deoptimized it twice.
 */
class AdapterBuilder {
  readonly runTick: Uint32Array
  readonly runPos: Int32Array
  readonly runRot: Int32Array
  readonly runTeam: Uint8Array
  readonly runCode: Uint8Array
  runs = 0
  trackSlot: Uint32Array
  trackStart: Uint32Array
  trackEnd: Uint32Array
  trackType: Uint8Array
  trackRun: Uint32Array
  tracks = 0
  rows = 0
  orphanRows = 0
  orphanTracks = 0
  typeOverrides = 0
  /** owned[j] = 1 when served instance j owns a track. */
  readonly owned: Uint8Array
  private readonly created: Uint32Array
  private readonly deleted: Uint32Array
  private readonly served: Uint8Array
  private readonly baseType: Uint8Array

  /** `maxRows` bounds the rows and so the runs (a run starts at a row); the track arrays grow when they must. */
  constructor(maxRows: number, trackCapacity: number, x: HighlanderExtras, source: ProjectileSource) {
    this.runTick = new Uint32Array(maxRows)
    this.runPos = new Int32Array(maxRows * 3)
    this.runRot = new Int32Array(maxRows * 3)
    this.runTeam = new Uint8Array(maxRows)
    this.runCode = new Uint8Array(maxRows)
    this.trackSlot = new Uint32Array(trackCapacity)
    this.trackStart = new Uint32Array(trackCapacity)
    this.trackEnd = new Uint32Array(trackCapacity)
    this.trackType = new Uint8Array(trackCapacity)
    this.trackRun = new Uint32Array(trackCapacity + 1)
    this.owned = new Uint8Array(x.projectiles.count)
    this.created = x.projectiles.created
    this.deleted = x.projectiles.deleted
    this.served = source.servedByBase
    this.baseType = source.baseType
  }

  /**
   * Copies the rows of `slot` in its typed buckets `buckets[from .. to)` (ascending bucket indices). The ticks of the
   * buckets between two that are not adjacent hold no row, so the open track ends there. `list` holds the extras
   * instances of the slot's entity id, by creation tick.
   */
  scanSlot(
    slot: number, pos: DataArray, rot: DataArray | undefined, team: DataArray | undefined, type: DataArray,
    end: number, list: readonly number[], buckets: Uint32Array, from: number, to: number, layout: CacheLayout
  ): void {
    const { pv, rv, teamShift, teamStride, typeShift, typeStride } = layout
    const bucketTicks = 1 << typeShift
    const { created, deleted, served, runTick, runPos, runRot, runTeam, runCode } = this
    let runs = this.runs
    let rows = this.rows
    let orphanRows = this.orphanRows
    let typeOverrides = this.typeOverrides
    let k = -1 // list[k]: the newest instance of this entity created at or before t
    let open = -1 // the track that ends at t, -1 after a tick without a row
    let openOwner = -1
    let previous = -2
    for (let n = from; n < to; n++) {
      const b = buckets[n]
      if (b !== previous + 1) open = -1
      previous = b
      const code = type[b * typeStride]
      for (let t = b << typeShift, t1 = Math.min(end, t + bucketTicks); t < t1; t++) {
        const i = t * pv
        const px = pos[i] | 0
        const py = pos[i + 1] | 0
        const pz = pos[i + 2] | 0
        if ((px | py | pz) === 0) {
          open = -1
          continue
        }
        while (k + 1 < list.length && created[list[k + 1]] <= t) k++
        let owner = -1
        if (k >= 0) {
          const j = list[k]
          const gone = deleted[j]
          if (served[j] && (gone === NONE_U32 || t < gone)) owner = j
        }
        if (open < 0 || owner !== openOwner) {
          open = this.openTrack(slot, t, owner, runs)
          openOwner = owner
        }
        this.trackEnd[open] = t + 1
        rows++
        if (owner < 0) orphanRows++
        else if (code !== this.trackType[open]) typeOverrides++

        const ri = t * rv
        const rx = rot ? rot[ri] | 0 : 0
        const ry = rot ? rot[ri + 1] | 0 : 0
        const rz = rot ? rot[ri + 2] | 0 : 0
        // An index past the team array would make the cache's team undefined. That can only happen at a slot's last
        // ticks, and releaseSelfCheck compares every track's last row, so the release would refuse.
        const tm = team ? team[(t >> teamShift) * teamStride] ?? 0 : 0
        const last = runs - 1
        const r = last * 3
        if (
          last >= this.trackRun[open] &&
          runPos[r] === px && runPos[r + 1] === py && runPos[r + 2] === pz &&
          runRot[r] === rx && runRot[r + 1] === ry && runRot[r + 2] === rz &&
          runTeam[last] === tm && runCode[last] === code
        ) {
          continue // the same row as the tick before: the run goes on
        }
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
    this.runs = runs
    this.rows = rows
    this.orphanRows = orphanRows
    this.typeOverrides = typeOverrides
  }

  /** Starts a track of `slot` at tick `t`, owned by served instance `owner` (-1: an orphan), whose runs start at `run`. */
  private openTrack(slot: number, t: number, owner: number, run: number): number {
    if (this.tracks + 2 > this.trackRun.length) this.growTracks()
    const track = this.tracks++
    this.trackSlot[track] = slot
    this.trackStart[track] = t
    this.trackType[track] = owner >= 0 ? this.baseType[owner] : 0
    this.trackRun[track] = run
    if (owner >= 0) this.owned[owner] = 1
    else this.orphanTracks++
    return track
  }

  private growTracks(): void {
    const capacity = this.trackSlot.length * 2
    const copy = <T extends Uint32Array | Uint8Array>(array: T, next: T): T => (next.set(array), next)
    this.trackSlot = copy(this.trackSlot, new Uint32Array(capacity))
    this.trackStart = copy(this.trackStart, new Uint32Array(capacity))
    this.trackEnd = copy(this.trackEnd, new Uint32Array(capacity))
    this.trackType = copy(this.trackType, new Uint8Array(capacity))
    this.trackRun = copy(this.trackRun, new Uint32Array(capacity + 1))
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
  const layout: CacheLayout = {
    pv: cache.positionCache.valuesPerPlayer,
    rv: cache.rotationCache.valuesPerPlayer,
    teamShift: cache.teamNumberCache.sparse,
    teamStride: cache.teamNumberCache.valuesPerPlayer,
    typeShift: cache.typeCache.sparse,
    typeStride: cache.typeCache.valuesPerPlayer,
  }
  const bucketTicks = 1 << layout.typeShift

  // ProjectileCache.getProjectile has no row where the bucket's type code has no name or the position is (0, 0, 0).
  // The code is stored once per bucket of 2^typeShift ticks (SparseDataCache), and only 1.6 to 13 % of the buckets
  // hold a named one on the measured demos. So this pass lists the typed buckets of every slot, and only their ticks
  // are scanned: the same rows as a scan of every tick, found 3 to 4 times faster on the first, cold call (19 instead
  // of 63 ms on 1438891, 32 instead of 135 on 1429417) and 2 to 7 times once optimized.
  let span = Math.max(0, ticks)
  let bucketCount = 0
  for (let slot = 0; slot < slots; slot++) {
    const pos = cache.positionCache.data[slot]
    if (!pos) continue
    // the cache reads index tick * 3, so its rows end where the slot's array ends
    const end = Math.floor(pos.length / layout.pv)
    span = Math.max(span, end)
    if (cache.typeCache.data[slot]) bucketCount += Math.ceil(end / bucketTicks)
  }
  const buckets = new Uint32Array(bucketCount)
  const slotBucket = new Uint32Array(slots + 1)
  let typed = 0
  let maxRows = 0
  for (let slot = 0; slot < slots; slot++) {
    slotBucket[slot] = typed
    const pos = cache.positionCache.data[slot]
    // without a type array every type code is undefined, and the cache has no row in this slot
    const type = cache.typeCache.data[slot]
    if (!pos || !type) continue
    const end = Math.floor(pos.length / layout.pv)
    for (let b = 0, t0 = 0; t0 < end; b++, t0 += bucketTicks) {
      const code = type[b * layout.typeStride]
      if (code === undefined || !ProjectileTypeMap[code]) continue
      buckets[typed++] = b
      maxRows += Math.min(bucketTicks, end - t0)
    }
  }
  slotBucket[slots] = typed

  const builder = new AdapterBuilder(maxRows, 1024, x, source)
  const slotTrack = new Uint32Array(slots + 1)
  for (let slot = 0; slot < slots; slot++) {
    slotTrack[slot] = builder.tracks
    if (slotBucket[slot] === slotBucket[slot + 1]) continue
    const pos = cache.positionCache.data[slot]
    builder.scanSlot(
      slot, pos, cache.rotationCache.data[slot], cache.teamNumberCache.data[slot], cache.typeCache.data[slot],
      Math.floor(pos.length / layout.pv), byEntity.get(ids[slot]) ?? EMPTY, buckets, slotBucket[slot], slotBucket[slot + 1], layout
    )
  }
  const { tracks, runs, rows, orphanRows, orphanTracks, typeOverrides, owned, trackStart, trackEnd } = builder
  slotTrack[slots] = tracks
  builder.trackRun[tracks] = runs

  // bucket index, filled in track order, so every bucket lists its tracks in slot order
  const indexBuckets = (span >> BUCKET_SHIFT) + 1
  const bucketOffset = new Uint32Array(indexBuckets + 1)
  for (let tr = 0; tr < tracks; tr++) {
    for (let b = trackStart[tr] >> BUCKET_SHIFT, last = (trackEnd[tr] - 1) >> BUCKET_SHIFT; b <= last; b++) bucketOffset[b + 1]++
  }
  for (let b = 0; b < indexBuckets; b++) bucketOffset[b + 1] += bucketOffset[b]
  const bucketTrack = new Uint32Array(bucketOffset[indexBuckets])
  const fill = bucketOffset.slice(0, indexBuckets)
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
    trackSlot: builder.trackSlot.slice(0, tracks),
    trackStart: trackStart.slice(0, tracks),
    trackEnd: trackEnd.slice(0, tracks),
    trackType: builder.trackType.slice(0, tracks),
    trackRun: builder.trackRun.slice(0, tracks + 1),
    slotTrack,
    runTick: builder.runTick.slice(0, runs),
    runPos: builder.runPos.slice(0, runs * 3),
    runRot: builder.runRot.slice(0, runs * 3),
    runTeam: builder.runTeam.slice(0, runs),
    runCode: builder.runCode.slice(0, runs),
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
  /** Slot rows compared at track edges (releaseSelfCheck). */
  edges?: number
  first?: { tick: number; slot?: number; field: string; cache: unknown; adapter: unknown }
}

const sameVector = (a: CachedProjectile['position'], b: CachedProjectile['position']) =>
  Object.is(a.x, b.x) && Object.is(a.y, b.y) && Object.is(a.z, b.z)

/** The first field in which two rows differ ('row' when only one of them exists), or null when they are the same. */
function rowDifference(a: CachedProjectile | null, b: CachedProjectile | null): string | null {
  if (a === null || b === null) return a === b ? null : 'row'
  if (a.entityId !== b.entityId) return 'entityId'
  if (a.type !== b.type) return 'type'
  if (a.teamNumber !== b.teamNumber) return 'teamNumber'
  if (!sameVector(a.position, b.position)) return 'position'
  if (!sameVector(a.rotation, b.rotation)) return 'rotation'
  return null
}

function noteDifference(result: ReaderComparison, tick: number, slot: number | undefined, field: string, a: unknown, b: unknown) {
  result.mismatches++
  result.first ??= { tick, slot, field, cache: a, adapter: b }
}

/**
 * Compares the adapter's exact rows (bucket types) with a reader (the cache before its release) at `ticks`: the same
 * rows in the same order with the same entity ids, types, teams, positions and rotations.
 */
export function compareWithReader(adapter: ProjectileAdapter, reader: ProjectileReader, ticks: Iterable<number>): ReaderComparison {
  const result: ReaderComparison = { ticks: 0, rows: 0, mismatches: 0 }
  for (const tick of ticks) {
    result.ticks++
    const want = reader.getProjectiles(tick)
    const got = adapter.getProjectiles(tick, true)
    result.rows += want.length
    if (want.length !== got.length) {
      noteDifference(result, tick, undefined, 'count', want.length, got.length)
      continue
    }
    for (let i = 0; i < want.length; i++) {
      const field = rowDifference(want[i], got[i])
      if (field) noteDifference(result, tick, undefined, field, want[i], got[i])
    }
  }
  return result
}

/**
 * The release self-check. compareWithReader at `count` ticks spread over the demo plus its first and last tick, then
 * for every track the slot's row at the tick before it, its first and last tick and the tick after it. The edges
 * cover every slot's last row, so they reach the last, partial 64-tick bucket of the slot's team and type arrays
 * wherever it holds a row, which the even sample can miss (1438891's last bucket starts at 54400, its sample ends at
 * 54335). The edges cost one slot lookup each, not a scan of every slot.
 */
export function releaseSelfCheck(adapter: ProjectileAdapter, reader: ProjectileReader, ticks: number, count: number): ReaderComparison {
  const sample = new Set(sampleTicks(ticks, count))
  if (ticks > 0) sample.add(0).add(ticks - 1)
  const result = compareWithReader(adapter, reader, Array.from(sample).sort((a, b) => a - b))
  let edges = 0
  const edge = (slot: number, tick: number) => {
    if (tick < 0) return
    edges++
    const a = reader.getProjectile(tick, slot)
    const b = adapter.getProjectile(tick, slot, true)
    const field = rowDifference(a, b)
    if (field) noteDifference(result, tick, slot, field, a, b)
  }
  adapter.forEachTrack((slot, start, end) => {
    edge(slot, start - 1)
    edge(slot, start)
    edge(slot, end - 1)
    edge(slot, end)
  })
  result.edges = edges
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
