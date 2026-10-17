// Track and event helpers for the extras containers of section 2.4 (contract section 3.7.1).
// Every function is a pure function of its arguments, so callers stay seek-deterministic (D12).

import * as THREE from 'three'

import type { ByPlayer, EventList, Track, U32, XformTrack } from './types'

const _quat = new THREE.Quaternion()

/** Index of the entry of `key` in effect at `tick`, or -1. */
export function trackIndexAt(t: Track, key: number, tick: number): number {
  const lo0 = t.offsets[key], hi0 = t.offsets[key + 1]
  if (lo0 === undefined || hi0 === undefined || lo0 === hi0) return -1
  let lo = lo0, hi = hi0
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (t.ticks[mid] <= tick) lo = mid + 1; else hi = mid }
  return lo - 1 >= lo0 ? lo - 1 : -1
}

/** Tick of the first entry of `key` after `tick`, or Infinity. */
export function trackNextTick(t: Track, key: number, tick: number): number {
  const lo0 = t.offsets[key], hi0 = t.offsets[key + 1]
  if (lo0 === undefined || hi0 === undefined || lo0 >= hi0) return Infinity
  let lo = lo0, hi = hi0
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (t.ticks[mid] <= tick) lo = mid + 1
    else hi = mid
  }
  return lo < hi0 ? t.ticks[lo] : Infinity
}

/** [start, end) global entry range of `key`. */
export function trackRange(t: Track, key: number): [number, number] {
  const lo = t.offsets[key], hi = t.offsets[key + 1]
  if (lo === undefined || hi === undefined) return [0, 0]
  return [lo, hi]
}

/** First index i in sorted `ticks` with ticks[i] >= tick. */
export function lowerBound(ticks: U32, tick: number, lo = 0, hi = ticks.length): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (ticks[mid] < tick) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** [start, end) of events with from <= tick < to. */
export function eventRange(ticks: U32, from: number, to: number): [number, number] {
  const start = lowerBound(ticks, from)
  if (!(to > from)) return [start, start]
  return [start, lowerBound(ticks, to, start)]
}

/** Rows of a ByPlayer list for key p with from <= tick < to, as indices into the global list. */
export function byPlayerRange(idx: ByPlayer, list: EventList, p: number, from: number, to: number): number[] {
  const lo0 = idx.offsets[p], hi0 = idx.offsets[p + 1]
  if (lo0 === undefined || hi0 === undefined || lo0 >= hi0 || !(to > from)) return []

  // Rows keep tick order, so binary-search on the tick of each row.
  const firstAtOrAfter = (target: number) => {
    let lo = lo0, hi = hi0
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (list.tick[idx.rows[mid]] < target) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  const start = firstAtOrAfter(from)
  const end = firstAtOrAfter(to)
  const rows: number[] = []
  for (let k = start; k < end; k++) rows.push(idx.rows[k])
  return rows
}

/** Walk back from the entry in effect at `tick` while `test(entry)` holds; returns the tick where it started, or null. */
export function sinceTick(t: Track, key: number, tick: number, test: (i: number) => boolean, maxSteps = 256): number | null {
  const i = trackIndexAt(t, key, tick)
  if (i < 0 || !test(i)) return null
  const lo0 = t.offsets[key]
  let j = i
  for (let steps = 0; steps < maxSteps && j - 1 >= lo0 && test(j - 1); steps++) j--
  return t.ticks[j]
}

/**
 * Linear interpolation of a Float32 field between the entry in effect at tickF and the next one, only when the next entry is at most maxGap ticks later.
 * `field` also takes the fixed-point integer fields that 3.7.2 interpolates, such as the U16 `objectives.cp.progress.p`
 * (capProgressAt); the result is then in raw units (0..65535 there) and the caller scales it.
 */
export function lerpField(t: Track, field: ArrayLike<number>, key: number, tickF: number, maxGap = 1): number {
  const i = trackIndexAt(t, key, Math.floor(tickF))
  if (i < 0) return NaN
  const value = field[i]
  const j = i + 1
  if (j >= t.offsets[key + 1]) return value

  const t0 = t.ticks[i]
  const gap = t.ticks[j] - t0
  if (!(gap > 0) || gap > maxGap) return value // a longer gap means the value held

  const a = (tickF - t0) / gap
  if (!(a > 0)) return value
  return value + (field[j] - value) * Math.min(1, a)
}

/** Same for xform tracks: writes position and slerped quaternion into the outputs. */
export function xformAt(t: XformTrack, key: number, tickF: number, outPos: THREE.Vector3, outQuat: THREE.Quaternion, maxGap = 1): boolean {
  const i = trackIndexAt(t, key, Math.floor(tickF))
  if (i < 0) return false

  outPos.set(t.x[i], t.y[i], t.z[i])
  outQuat.set(t.qx[i], t.qy[i], t.qz[i], t.qw[i])

  const j = i + 1
  if (j >= t.offsets[key + 1]) return true

  const t0 = t.ticks[i]
  const gap = t.ticks[j] - t0
  if (!(gap > 0) || gap > maxGap) return true

  const a = (tickF - t0) / gap
  if (!(a > 0)) return true

  const s = Math.min(1, a)
  outPos.set(
    outPos.x + (t.x[j] - outPos.x) * s,
    outPos.y + (t.y[j] - outPos.y) * s,
    outPos.z + (t.z[j] - outPos.z) * s
  )
  outQuat.slerp(_quat.set(t.qx[j], t.qy[j], t.qz[j], t.qw[j]), s)
  return true
}
