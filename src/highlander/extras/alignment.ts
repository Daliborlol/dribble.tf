// Alignment check between the extras and the base parse (contract section 3.6).
//
// The extras parser writes 16 sample ticks that received a PacketEntities message, plus every player's origin at
// those ticks (`alignment.pos`, scene space after hydration). The base caches hold the same moment at the same
// cache tick, so with the right start tick, tick base and player mapping the two agree to the fixed-point
// rounding of parser2 (well under a unit). `checkAlignmentWith` is the pure rule; the Node checker
// (scripts/hl/check-extras.mjs) runs it against base samples written by scripts/hl/base-values.mjs.

import type { AsyncParser } from '@components/Analyse/Data/AsyncParser'

import type { HighlanderExtras } from './types'

export interface AlignmentResult {
  ok: boolean
  reason?: string
  pairs: number
  within: number
  /** Diagnostics (optional fields): alive base samples, the `need` threshold and the largest distance seen. */
  aliveBase?: number
  need?: number
  maxDistance?: number
}

export interface AlignmentBaseSample {
  x: number
  y: number
  z: number
  health: number
}

/** The base values the rule reads. `sample` returns scene coordinates and health at a cache tick, or null. */
export interface AlignmentBase {
  startTick: number
  tickBase: number
  ticks: number
  nextMappedPlayer: number
  sample(p: number, tick: number): AlignmentBaseSample | null
}

export const ALIGNMENT_MAX_DISTANCE = 4
const SAMPLE_COUNT = 16

/** Section 3.6 against any base source. */
export function checkAlignmentWith(x: HighlanderExtras, base: AlignmentBase): AlignmentResult {
  const meta = x.meta
  const fields: [string, number, number][] = [
    ['startTick', meta.startTick, base.startTick],
    ['tickBase', meta.tickBase, base.tickBase],
    ['ticks', meta.ticks, base.ticks],
    ['playerCount', meta.playerCount, base.nextMappedPlayer],
  ]
  for (const [name, got, want] of fields) {
    if (got !== want) return { ok: false, reason: `${name} ${got} != base ${want}`, pairs: 0, within: 0 }
  }

  const { ticks: sampleTicks, pos } = x.alignment
  const playerCount = meta.playerCount
  if (sampleTicks.length !== SAMPLE_COUNT || pos.length !== playerCount * SAMPLE_COUNT * 3) {
    return { ok: false, reason: 'alignment arrays have the wrong length', pairs: 0, within: 0 }
  }

  let aliveBase = 0
  let pairs = 0
  let within = 0
  let maxDistance = 0
  for (let k = 0; k < SAMPLE_COUNT; k++) {
    const tick = sampleTicks[k]
    if (tick >= base.ticks) continue
    for (let p = 0; p < playerCount; p++) {
      const b = base.sample(p, tick)
      const baseAlive = !!b && !(b.x === 0 && b.y === 0 && b.z === 0) && b.health > 0
      if (baseAlive) aliveBase++
      const o = (p * SAMPLE_COUNT + k) * 3
      const ex = pos[o], ey = pos[o + 1], ez = pos[o + 2]
      if (!b || !baseAlive || Number.isNaN(ex) || Number.isNaN(ey) || Number.isNaN(ez)) continue
      pairs++
      const d = Math.hypot(ex - b.x, ey - b.y, ez - b.z)
      if (d > maxDistance) maxDistance = d
      if (d <= ALIGNMENT_MAX_DISTANCE) within++
    }
  }

  if (aliveBase === 0) {
    console.warn('[HL] alignment: no alive samples in the base parse, nothing to compare')
    return { ok: true, reason: 'no alive samples', pairs, within, aliveBase, need: 0, maxDistance }
  }

  const need = Math.min(20, Math.ceil(aliveBase / 2))
  const ok = pairs >= need && (pairs >= 20 ? within / pairs >= 0.9 : within === pairs)
  const result: AlignmentResult = { ok, pairs, within, aliveBase, need, maxDistance }
  if (!ok) {
    result.reason =
      pairs < need
        ? `${pairs} comparable samples, need ${need} (${aliveBase} alive in the base)`
        : `${within} of ${pairs} samples within ${ALIGNMENT_MAX_DISTANCE} units (max ${maxDistance.toFixed(1)})`
  }
  return result
}

/** Base samples straight from the parsed demo's caches (scene space, the values the actors are drawn from). */
export function alignmentBaseOf(d: AsyncParser): AlignmentBase {
  return {
    startTick: d.startTick,
    tickBase: d.tickBase,
    ticks: d.ticks,
    nextMappedPlayer: d.nextMappedPlayer,
    sample(p, tick) {
      const cache = d.playerCache
      if (!cache) return null
      const position = cache.positionCache.getPosition(p, tick)
      return { x: position.x, y: position.y, z: position.z, health: cache.healthCache.get(p, tick) }
    },
  }
}

/** Section 3.6: the extras must describe the same ticks and players as the base parse. */
export function checkAlignment(x: HighlanderExtras, d: AsyncParser): AlignmentResult {
  return checkAlignmentWith(x, alignmentBaseOf(d))
}
