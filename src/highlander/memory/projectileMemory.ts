// Release of the base projectile cache (contract section 5 X2, 12.3 and 13.4).
//
// When the extras are ready with `available.projectiles` true while Highlander is on, F3's source split is computed
// (it reads the cache), the cache's rows are copied into a ProjectileAdapter (projectileAdapter.ts), a sample of
// ticks is compared against the cache, and AsyncParser.releaseProjectileCache drops the dense typed arrays. From then
// on the adapter serves every base projectile read for the rest of the session: DemoViewer's getProjectilesAtTick
// calls and projectileSource's slot reads go to demo.projectileReader(). Turning Highlander off, an extras restart,
// reload or error change nothing it serves, because it holds its own copy and no extras reference. With Highlander
// off, extras unavailable, disabled or failed, or the projectiles group excluded or empty, nothing happens: the cache
// stays. A failed build or self-check also keeps the cache (and is not retried for that demo).
//
// `?hlProjectileRelease=manual` keeps the cache until the `memory.release` probe asks, so a harness run can measure
// both sides in one page. Imported for its side effects by Projectiles.tsx.

import type { AsyncParser } from '@components/Analyse/Data/AsyncParser'
import type { CachedProjectile } from '@components/Analyse/Data/ProjectileCache'
import { getProjectileSource, type ProjectileSource } from '@highlander/combat/projectileSource'
import { INTERP_DELAY_TICKS } from '@highlander/combat/time'
import { registerHlProbe } from '@highlander/debug'
import type { HighlanderExtras } from '@highlander/extras/types'
import { getState, useInstance, useStore } from '@zus/store'
import * as THREE from 'three'

import {
  buildProjectileAdapter,
  compareWithReader,
  sampleTicks,
  type ProjectileAdapterStats,
  type ReaderComparison,
} from './projectileAdapter'

/** Ticks the release compares between the adapter and the cache before it drops the cache. */
const SELF_CHECK_TICKS = 256

export interface ProjectileReleaseRecord {
  state: 'pending' | 'released' | 'failed'
  trigger: 'auto' | 'probe'
  stats?: ProjectileAdapterStats
  releasedBytes: number
  /** Split, build and self-check time (a measurement, not effect logic). */
  buildMs: number
  selfCheck?: ReaderComparison
  error?: string
}

/** Per demo (12.3: keyed by the demo, never a module-level demo reference). The adapter itself is the demo's reader. */
const records = new WeakMap<AsyncParser, ProjectileReleaseRecord>()

const manualRelease = (() => {
  try {
    return new URLSearchParams(window.location.search).get('hlProjectileRelease') === 'manual'
  } catch {
    return false
  }
})()

/** Why the cache of `demo` cannot be released now, or null. */
function releaseBlocker(demo: AsyncParser | undefined): string | null {
  const s = useInstance.getState()
  if (!demo) return 'no demo'
  if (demo.projectileCacheReleased) return 'already released'
  if (s.parsedDemo !== demo) return 'not the loaded demo'
  if (getState().settings.highlander?.enabled === false) return 'Highlander off'
  if (s.extrasStatus !== 'ready' || !s.extras) return `extras ${s.extrasStatus}`
  if (!s.extras.meta.available.projectiles) return 'extras without projectiles (excluded or empty)'
  return null
}

/** The same test without allocations, for the store listener (it runs on every store update). */
function canRelease(demo: AsyncParser): boolean {
  const s = useInstance.getState()
  return (
    !demo.projectileCacheReleased &&
    s.parsedDemo === demo &&
    s.extrasStatus === 'ready' &&
    !!s.extras &&
    s.extras.meta.available.projectiles &&
    getState().settings.highlander?.enabled !== false
  )
}

const mb = (bytes: number) => Math.round((bytes / 1048576) * 10) / 10

/**
 * Builds the adapter from the cache and releases the cache when the conditions hold; returns the demo's record (an
 * existing released or failed one unchanged). Never throws.
 */
export function releaseBaseProjectiles(demo: AsyncParser, trigger: 'auto' | 'probe'): ProjectileReleaseRecord | null {
  const existing = records.get(demo)
  if (existing && existing.state !== 'pending') return existing
  if (releaseBlocker(demo)) return null
  const x = useInstance.getState().extras as HighlanderExtras
  const record: ProjectileReleaseRecord = { state: 'failed', trigger, releasedBytes: 0, buildMs: 0 }
  const t0 = performance.now()
  try {
    // the split first: it reads the cache, and Projectiles.tsx and the F3 layers keep using it (cached per extras)
    const source = getProjectileSource(x, demo)
    const adapter = buildProjectileAdapter(demo.projectileCache, demo.ticks, x, source)
    record.stats = adapter.stats
    record.selfCheck = compareWithReader(adapter, demo.projectileCache, sampleTicks(demo.ticks, SELF_CHECK_TICKS))
    record.buildMs = Math.round((performance.now() - t0) * 10) / 10
    if (record.selfCheck.mismatches > 0) {
      record.error = `self-check found ${record.selfCheck.mismatches} differences (first ${JSON.stringify(record.selfCheck.first)})`
    } else {
      record.releasedBytes = demo.releaseProjectileCache(adapter)
      record.state = 'released'
    }
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error)
  }
  records.set(demo, record)
  if (record.state === 'released') {
    console.info('[HL] base projectile cache released', {
      releasedMB: mb(record.releasedBytes),
      adapterMB: mb(record.stats?.bytes ?? 0),
      rows: record.stats?.rows,
      runs: record.stats?.runs,
      tracks: record.stats?.tracks,
      orphanRows: record.stats?.orphanRows,
      typeOverrides: record.stats?.typeOverrides,
      buildMs: record.buildMs,
      trigger,
    })
  } else {
    console.warn(`[HL] base projectile cache kept: ${record.error}`)
  }
  return record
}

// The automatic release: checked on every store update, done once per demo in a microtask, outside the store
// listener that fired (loadExtras sets the status inside its own try block).
function onStoreChange(): void {
  if (manualRelease) return
  const demo = useInstance.getState().parsedDemo
  if (!demo || records.has(demo) || !canRelease(demo)) return
  records.set(demo, { state: 'pending', trigger: 'auto', releasedBytes: 0, buildMs: 0 })
  queueMicrotask(() => {
    if (records.get(demo)?.state !== 'pending') return
    records.delete(demo)
    if (canRelease(demo)) releaseBaseProjectiles(demo, 'auto')
  })
}

useInstance.subscribe(onStoreChange)
useStore.subscribe(onStoreChange)

//
// ─── PROBES ─────────────────────────────────────────────────────────────────────
//

function cacheBytes(demo: AsyncParser): number {
  const pc = demo.projectileCache
  let bytes = 0
  for (const cache of [pc.positionCache, pc.rotationCache, pc.teamNumberCache, pc.typeCache]) {
    for (const array of cache.data) bytes += array?.byteLength ?? 0
  }
  return bytes
}

function status() {
  const demo = useInstance.getState().parsedDemo
  if (!demo) return { error: 'no demo' }
  const record = records.get(demo) ?? null
  return {
    released: demo.projectileCacheReleased,
    reader: demo.projectileReader() === demo.projectileCache ? 'cache' : 'adapter',
    manual: manualRelease,
    blocker: releaseBlocker(demo),
    cacheMB: mb(cacheBytes(demo)),
    parsedCacheMB: mb(demo.perf?.projectileCacheBytes ?? 0),
    positionScale: demo.projectileCache.positionCache.scale,
    record: record && {
      ...record,
      releasedMB: mb(record.releasedBytes),
      adapterMB: mb(record.stats?.bytes ?? 0),
    },
  }
}

/** FNV-1a over numbers (their float64 bits) and strings. */
class Digest {
  private h = 0x811c9dc5
  private readonly f = new Float64Array(1)
  private readonly u = new Uint32Array(this.f.buffer)
  private mix(v: number) {
    this.h = Math.imul(this.h ^ v, 0x01000193) >>> 0
  }
  num(v: number) {
    this.f[0] = v
    this.mix(this.u[0])
    this.mix(this.u[1])
  }
  str(s: string) {
    for (let i = 0; i < s.length; i++) this.mix(s.charCodeAt(i))
    this.mix(0xff)
  }
  row(p: CachedProjectile) {
    this.num(p.entityId)
    this.str(p.type)
    this.num(p.teamNumber)
    this.num(p.position.x), this.num(p.position.y), this.num(p.position.z)
    this.num(p.rotation.x), this.num(p.rotation.y), this.num(p.rotation.z)
  }
  arrays(...arrays: ArrayLike<number>[]) {
    for (const a of arrays) for (let i = 0; i < a.length; i++) this.mix(a[i])
  }
  get hex() {
    return this.h.toString(16).padStart(8, '0')
  }
}

function splitDigest(source: ProjectileSource) {
  const d = new Digest()
  d.arrays(source.servedByBase, source.baseType)
  let served = 0
  for (let j = 0; j < source.servedByBase.length; j++) served += source.servedByBase[j]
  return { digest: d.hex, served, mismatches: source.mismatches }
}

const renderTickNow = () => Math.max(1, Math.floor(getState().playback.tick ?? 1) - INTERP_DELAY_TICKS)

/** The release state: released, which reader serves, the bytes, the adapter statistics and the self-check. */
registerHlProbe('memory.projectiles', status)

/** Releases now (also with ?hlProjectileRelease=manual) when the conditions hold; returns the state. */
registerHlProbe('memory.release', () => {
  const demo = useInstance.getState().parsedDemo
  if (!demo) return { error: 'no demo' }
  const blocker = releaseBlocker(demo)
  const record = releaseBaseProjectiles(demo, 'probe')
  return { ...status(), refused: record ? null : blocker }
})

/** What DemoViewer's projectile block reads at a render tick: the rows at tick and tick + 1. */
registerHlProbe('memory.base', (tick?: number) => {
  const demo = useInstance.getState().parsedDemo
  if (!demo) return { error: 'no demo' }
  const t = typeof tick === 'number' && Number.isFinite(tick) ? Math.floor(tick) : renderTickNow()
  return { tick: t, released: demo.projectileCacheReleased, current: demo.getProjectilesAtTick(t), next: demo.getProjectilesAtTick(t + 1) }
})

/** A digest of every row getProjectilesAtTick returns over [from, to) (default the whole demo). */
registerHlProbe('memory.digest', (from = 0, to?: number) => {
  const demo = useInstance.getState().parsedDemo
  if (!demo) return { error: 'no demo' }
  const end = Math.min(to ?? demo.ticks + 1, demo.ticks + 1)
  const d = new Digest()
  let rows = 0
  const t0 = performance.now()
  for (let t = Math.max(0, from); t < end; t++) {
    for (const p of demo.getProjectilesAtTick(t)) {
      d.row(p)
      rows++
    }
    d.num(-t)
  }
  return { from, to: end, rows, digest: d.hex, released: demo.projectileCacheReleased, ms: Math.round(performance.now() - t0) }
})

/**
 * F3's split as the layers use it (cached for the current extras) and computed again through the current reader for
 * a new extras identity, as after an extras restart: both must be the same before and after the release.
 */
registerHlProbe('memory.split', () => {
  const demo = useInstance.getState().parsedDemo
  const { extras, extrasStatus } = useInstance.getState()
  if (!demo || !extras || extrasStatus !== 'ready') return { error: 'extras not ready' }
  const cached = splitDigest(getProjectileSource(extras, demo))
  const fresh = splitDigest(getProjectileSource({ ...extras }, demo))
  return { released: demo.projectileCacheReleased, cached, fresh, same: cached.digest === fresh.digest }
})

const _p = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _s = new THREE.Vector3()

/** The base projectile groups drawn in the last frame (Projectiles.tsx): mode, entity id, world position. */
registerHlProbe('memory.drawn', () => {
  const scene = useInstance.getState().threeScene
  const rows: { entityId: number; mode: string; name: string; pos: number[]; quat: number[] }[] = []
  const round = (v: number) => Math.round(v * 100) / 100
  scene?.traverse(node => {
    const data = node.userData as { hlProjectile?: string; entityId?: number }
    if (!data?.hlProjectile || typeof data.entityId !== 'number') return
    for (let n: THREE.Object3D | null = node; n; n = n.parent) if (!n.visible) return
    node.matrixWorld.decompose(_p, _q, _s)
    rows.push({ entityId: data.entityId, mode: data.hlProjectile, name: node.name, pos: [round(_p.x), round(_p.y), round(_p.z)], quat: [round(_q.x), round(_q.y), round(_q.z), round(_q.w)] })
  })
  rows.sort((a, b) => a.entityId - b.entityId || a.mode.localeCompare(b.mode))
  return { tick: renderTickNow(), count: rows.length, rows }
})
