// Pure accessors over `extras.projectiles` (contract sections 2.5.4 and 5 F3). Every function here is a pure
// function of the extras and its tick arguments, so the layers and probes that use them stay seek-deterministic.
//
// Sample s of instance j is tick created[j] + s, at pos[(posStart[j] + s) * 3]. Samples cover created..hidden-1
// (to ticks-1 when the projectile was never hidden).

import * as THREE from 'three'

import { PROJ } from '@highlander/extras/enums'
import { trackIndexAt } from '@highlander/extras/track'
import type { HighlanderExtras } from '@highlander/extras/types'

export const NONE_U32 = 0xffffffff
const EPS_SQ = 1e-4
/** Look back this many samples for a non-zero delta before falling back to the initial velocity. */
const DIRECTION_LOOKBACK = 16

/** First tick the instance is no longer drawn: hidden, or the end of the demo when it never hid. */
export function drawEnd(x: HighlanderExtras, j: number): number {
  const hidden = x.projectiles.hidden[j]
  return hidden === NONE_U32 ? x.meta.ticks : Math.min(hidden, x.meta.ticks)
}

/** created <= tick < hidden */
export function isDrawnAt(x: HighlanderExtras, j: number, tick: number): boolean {
  return x.projectiles.created[j] <= tick && tick < drawEnd(x, j)
}

/** Sample index (into pos / 3) of instance j at an integer tick, clamped to the instance's samples; -1 without samples. */
export function sampleIndex(x: HighlanderExtras, j: number, tick: number): number {
  const pj = x.projectiles
  const n = pj.posCount[j]
  if (n === 0) return -1
  const s = Math.min(Math.max(tick - pj.created[j], 0), n - 1)
  return pj.posStart[j] + s
}

/**
 * Interpolated position of instance j at tickF (lerp between consecutive samples, clamped to the first and last
 * sample). Returns false when the instance has no finite sample.
 */
export function positionAt(x: HighlanderExtras, j: number, tickF: number, out: THREE.Vector3): boolean {
  const pj = x.projectiles
  const n = pj.posCount[j]
  if (n === 0) return false
  const base = Math.floor(tickF)
  let s = base - pj.created[j]
  let a = tickF - base
  if (s < 0) {
    s = 0
    a = 0
  } else if (s >= n - 1) {
    s = n - 1
    a = 0
  }
  const p = pj.pos
  const i = (pj.posStart[j] + s) * 3
  let px = p[i], py = p[i + 1], pz = p[i + 2]
  if (a > 0) {
    px += (p[i + 3] - px) * a
    py += (p[i + 4] - py) * a
    pz += (p[i + 5] - pz) * a
  }
  if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) return false
  out.set(px, py, pz)
  return true
}

/** Position of sample index k (global, as returned by sampleIndex). */
export function samplePosition(x: HighlanderExtras, k: number, out: THREE.Vector3): THREE.Vector3 {
  const p = x.projectiles.pos
  return out.set(p[k * 3], p[k * 3 + 1], p[k * 3 + 2])
}

/**
 * Unit flight direction of instance j at tickF: the delta of the sample segment being flown (or the last two
 * samples), else the last non-zero delta within 16 samples, else the initial velocity, else +X.
 */
export function directionAt(x: HighlanderExtras, j: number, tickF: number, out: THREE.Vector3): THREE.Vector3 {
  const pj = x.projectiles
  const n = pj.posCount[j]
  const p = pj.pos
  if (n > 1) {
    const s = Math.min(Math.max(Math.floor(tickF) - pj.created[j], 0), n - 1)
    const start = pj.posStart[j]
    // the segment s -> s + 1 (the one tickF interpolates along), then backwards
    const first = Math.min(s + 1, n - 1)
    for (let k = first, steps = 0; k >= 1 && steps <= DIRECTION_LOOKBACK; k--, steps++) {
      const i = (start + k) * 3
      const dx = p[i] - p[i - 3], dy = p[i + 1] - p[i - 2], dz = p[i + 2] - p[i - 1]
      const lenSq = dx * dx + dy * dy + dz * dz
      if (lenSq > EPS_SQ && Number.isFinite(lenSq)) return out.set(dx, dy, dz).multiplyScalar(1 / Math.sqrt(lenSq))
    }
  }
  const vx = pj.vx[j], vy = pj.vy[j], vz = pj.vz[j]
  const vSq = vx * vx + vy * vy + vz * vz
  if (vSq > EPS_SQ && Number.isFinite(vSq)) return out.set(vx, vy, vz).multiplyScalar(1 / Math.sqrt(vSq))
  return out.set(1, 0, 0)
}

/** The deflects entry in effect at tick (index into deflects arrays), -1 when not deflected yet. */
export function deflectIndexAt(x: HighlanderExtras, j: number, tick: number): number {
  const d = x.projectiles.deflects
  if (d.ticks.length === 0) return -1
  return trackIndexAt(d, j, tick)
}

/** Team of instance j at tick: the team of the latest deflect, else the team at creation. */
export function projectileTeamAt(x: HighlanderExtras, j: number, tick: number): number {
  const i = deflectIndexAt(x, j, tick)
  return i >= 0 ? x.projectiles.deflects.team[i] : x.projectiles.team[j]
}

/** Lookup result for a base projectile's entity id at a tick. */
export interface EntityMatch {
  /** Instance with created <= tick < hidden, or -1. */
  drawn: number
  /** True when an instance of this entity exists at the tick but is hidden (hidden <= tick < deleted). */
  hidden: boolean
  /** That hidden instance, or -1. */
  hiddenInstance: number
}

export function makeEntityMatch(): EntityMatch {
  return { drawn: -1, hidden: false, hiddenInstance: -1 }
}

/** The extras instance of entity id `entityId` at `tick` (contract 5 F3 Projectiles.tsx edit 1). */
export function matchEntity(x: HighlanderExtras, entityId: number, tick: number, out: EntityMatch = makeEntityMatch()): EntityMatch {
  out.drawn = -1
  out.hidden = false
  out.hiddenInstance = -1
  const list = x.derived.projectilesByEntity.get(entityId)
  if (!list) return out
  const pj = x.projectiles
  // sorted by created: the newest instance created at or before tick is the only candidate
  for (let k = list.length - 1; k >= 0; k--) {
    const j = list[k]
    if (pj.created[j] > tick) continue
    if (tick < drawEnd(x, j)) out.drawn = j
    else {
      const deleted = pj.deleted[j]
      out.hidden = deleted === NONE_U32 || tick < deleted
      if (out.hidden) out.hiddenInstance = j
    }
    break
  }
  return out
}

// ─── Landed phase: hidden but not deleted yet ──────────────────────────────────

/**
 * Kinds the server stops, hides (EF_NODRAW) and deletes 3 s later when they land: every CTFProjectile_Arrow
 * (FadeOut, tf_projectile_arrow.cpp:1014). On the measured demos only healing bolts hide before they are deleted;
 * arrows and repair bolts stay networked while they rest, so their resting phase is already drawn as alive.
 */
export const LANDING_KINDS: ReadonlySet<number> = new Set([PROJ.ARROW, PROJ.REPAIR_BOLT, PROJ.HEALING_BOLT])
/** FadeOut(3.0): the server deletes a landed bolt 3 s after it hid. */
export const LANDED_SECONDS = 3

/**
 * Exclusive end of instance j's landed phase [hidden, end): deleted, capped at hidden + 3 s and at the demo end.
 * The phase is empty (end <= hidden) for kinds without one and 0 for instances that never hid.
 */
export function landedEnd(x: HighlanderExtras, j: number): number {
  const pj = x.projectiles
  const hidden = pj.hidden[j]
  if (hidden === NONE_U32) return 0
  if (!LANDING_KINDS.has(pj.kind[j])) return hidden
  const cap = hidden + Math.round(LANDED_SECONDS / (x.meta.intervalPerTick || 0.015))
  const deleted = pj.deleted[j]
  return Math.min(deleted === NONE_U32 ? cap : deleted, cap, x.meta.ticks)
}

// ─── Interval index: instances drawn at a tick ────────────────────────────────

const BUCKET_SHIFT = 7 // 128-tick buckets

interface IntervalIndex {
  starts: Uint32Array
  ends: Uint32Array // exclusive
  offsets: Uint32Array
  rows: Uint32Array
}

function buildIntervalIndex(starts: ArrayLike<number>, endOf: (j: number) => number, count: number, ticks: number): IntervalIndex {
  const bucketCount = (Math.max(1, ticks) >> BUCKET_SHIFT) + 1
  const s = new Uint32Array(count)
  const e = new Uint32Array(count)
  const sizes = new Uint32Array(bucketCount + 1)
  for (let j = 0; j < count; j++) {
    const start = Math.max(0, starts[j])
    const end = Math.min(endOf(j), ticks)
    s[j] = start
    e[j] = end
    if (end <= start) continue
    const b0 = start >> BUCKET_SHIFT, b1 = Math.min((end - 1) >> BUCKET_SHIFT, bucketCount - 1)
    for (let b = b0; b <= b1; b++) sizes[b + 1]++
  }
  for (let b = 0; b < bucketCount; b++) sizes[b + 1] += sizes[b]
  const rows = new Uint32Array(sizes[bucketCount])
  const fill = sizes.slice(0, bucketCount)
  for (let j = 0; j < count; j++) {
    if (e[j] <= s[j]) continue
    const b0 = s[j] >> BUCKET_SHIFT, b1 = Math.min((e[j] - 1) >> BUCKET_SHIFT, bucketCount - 1)
    for (let b = b0; b <= b1; b++) rows[fill[b]++] = j
  }
  return { starts: s, ends: e, offsets: sizes, rows }
}

/** Every instance with start <= tick < end, ascending. */
function queryAt(index: IntervalIndex, tick: number, out: number[]): number[] {
  out.length = 0
  const b = tick >> BUCKET_SHIFT
  if (b < 0 || b + 1 >= index.offsets.length) return out
  for (let k = index.offsets[b]; k < index.offsets[b + 1]; k++) {
    const j = index.rows[k]
    if (index.starts[j] <= tick && tick < index.ends[j]) out.push(j)
  }
  return out
}

/** Every instance whose [start, end) overlaps [from, to] (inclusive), each once. */
function queryRange(index: IntervalIndex, from: number, to: number, out: number[]): number[] {
  out.length = 0
  const last = index.offsets.length - 2
  const b0 = Math.max(0, from >> BUCKET_SHIFT), b1 = Math.min(last, to >> BUCKET_SHIFT)
  for (let b = b0; b <= b1; b++) {
    for (let k = index.offsets[b]; k < index.offsets[b + 1]; k++) {
      const j = index.rows[k]
      if (index.starts[j] > to || index.ends[j] <= from) continue
      // emit once: in the first bucket of the queried range that holds it
      if (Math.max(b0, index.starts[j] >> BUCKET_SHIFT) !== b) continue
      out.push(j)
    }
  }
  return out
}

const projectileIndexes = new WeakMap<HighlanderExtras, IntervalIndex>()
const landedIndexes = new WeakMap<HighlanderExtras, IntervalIndex>()
const flameIndexes = new WeakMap<HighlanderExtras, IntervalIndex>()

/** Instances in their landed phase at tick (hidden <= tick < landedEnd), ascending. */
export function projectilesLandedAt(x: HighlanderExtras, tick: number, out: number[] = []): number[] {
  let index = landedIndexes.get(x)
  if (!index) {
    const pj = x.projectiles
    // [hidden, landedEnd); never-hidden instances and kinds without a landed phase get an empty interval
    const starts = Uint32Array.from(pj.hidden, h => (h === NONE_U32 ? 0 : h))
    index = buildIntervalIndex(starts, j => landedEnd(x, j), pj.count, x.meta.ticks)
    landedIndexes.set(x, index)
  }
  return queryAt(index, tick, out)
}

function projectileIndex(x: HighlanderExtras): IntervalIndex {
  let index = projectileIndexes.get(x)
  if (!index) {
    index = buildIntervalIndex(x.projectiles.created, j => drawEnd(x, j), x.projectiles.count, x.meta.ticks)
    projectileIndexes.set(x, index)
  }
  return index
}

/** Projectile instances drawn at tick (created <= tick < hidden), ascending. */
export function projectilesDrawnAt(x: HighlanderExtras, tick: number, out: number[] = []): number[] {
  return queryAt(projectileIndex(x), tick, out)
}

/** Projectile instances drawn at some tick in [from, to]. */
export function projectilesDrawnIn(x: HighlanderExtras, from: number, to: number, out: number[] = []): number[] {
  return queryRange(projectileIndex(x), from, to, out)
}

/** Flame manager instances alive at tick (created <= tick < deleted). */
export function flamesAliveAt(x: HighlanderExtras, tick: number, out: number[] = []): number[] {
  let index = flameIndexes.get(x)
  if (!index) {
    const f = x.flames
    index = buildIntervalIndex(f.created, j => (f.deleted[j] === NONE_U32 ? x.meta.ticks : f.deleted[j]), f.count, x.meta.ticks)
    flameIndexes.set(x, index)
  }
  return queryAt(index, tick, out)
}

// ─── Orientation helpers ─────────────────────────────────────────────────────

const _x = new THREE.Vector3()
const _y = new THREE.Vector3()
const _z = new THREE.Vector3()
const _m = new THREE.Matrix4()
const UP = new THREE.Vector3(0, 0, 1)
const ALT_UP = new THREE.Vector3(1, 0, 0)

/** Rotation that maps local +X to `dir` with local +Z as close to world up as possible (placeholders, 1.4). */
export function quatForwardX(dir: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  _x.copy(dir)
  const up = Math.abs(_x.z) > 0.999 ? ALT_UP : UP
  _y.crossVectors(up, _x).normalize()
  _z.crossVectors(_x, _y)
  _m.makeBasis(_x, _y, _z)
  return out.setFromRotationMatrix(_m)
}

/**
 * Rotation whose local +Z points against `dir`, as Object3D.lookAt(previousPosition) did for the base rocket model
 * in Projectiles.tsx (its GLB is modelled along -Z).
 */
export function quatLookBack(dir: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  _z.copy(dir).negate()
  const up = Math.abs(_z.z) > 0.999 ? ALT_UP : UP
  _x.crossVectors(up, _z).normalize()
  _y.crossVectors(_z, _x)
  _m.makeBasis(_x, _y, _z)
  return out.setFromRotationMatrix(_m)
}
