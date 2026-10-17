// Memory plan for the extras worker (contract sections 2.8 and 8).
//
// The extras parse runs after the base parse, in its own worker (D4). Its peak is the demo file in wasm memory,
// the parser state, the output builders and the JS copy of the output (D18). P1 measured that peak in the Node
// checker (scripts/hl/check-extras.mjs, VmHWM of the whole process) and fitted peakMB = a * fileMB + b.
// The Node runtime is inside b, so the fit overestimates the browser worker slightly, which is the safe side.
//
// planExtrasGroups predicts the peak for a file. While the prediction exceeds the budget it drops the largest
// optional output group (by the measured size per demo minute) and subtracts what that saves. It never drops
// players, objectives, buildings or projectiles. When even the smallest plan is too big it skips the extras.

/**
 * peakMB = a * fileMB + b (fileMB = bytes / 1e6, peak in MiB). P1 fitted it over 10 checker runs (5.5 to 123 MB,
 * 3.8 to 34 demo minutes): least squares a = 1.616, b = 107.8, residuals -10.8 to +15.6 MB. b here is the
 * least-squares b plus the largest residual, so the line lies above every measured peak.
 */
export const EXTRAS_PEAK = { a: 1.62, b: 124 }

/**
 * Output typed-array MB per demo minute per group: the median over the same 10 runs (hl_extras and the checker
 * produce the same bytes). `GROUP_MB_PER_MINUTE_MAX` holds the largest value seen and its demo.
 */
export const GROUP_MB_PER_MINUTE: Record<string, number> = {
  players: 0.176,
  drops: 0.157,
  projectiles: 0.142,
  movers: 0.114,
  flames: 0.07,
  dots: 0.045,
  buildings: 0.033,
  tempents: 0.015,
  objectives: 0.01,
  hurts: 0.003,
  ragdolls: 0.0006,
  pickups: 0.0004,
  weapons: 0.0003,
}

export const GROUP_MB_PER_MINUTE_MAX: Record<string, { mbPerMinute: number; demo: string }> = {
  players: { mbPerMinute: 0.201, demo: '1438891 koth_product_final' },
  drops: { mbPerMinute: 0.213, demo: '1428628 tow_tetsudo_b10c' },
  projectiles: { mbPerMinute: 0.497, demo: 'i52_snakewater_gc (6v6, 33 Hz)' },
  movers: { mbPerMinute: 0.597, demo: '1440442 cp_steel_f12' },
  flames: { mbPerMinute: 0.094, demo: '1433815 koth_ashville_final1' },
  dots: { mbPerMinute: 0.073, demo: '1432698 pl_vigil_rc10' },
  buildings: { mbPerMinute: 0.194, demo: '1428628 tow_tetsudo_b10c' },
  tempents: { mbPerMinute: 0.018, demo: '1432698 pl_vigil_rc10' },
  objectives: { mbPerMinute: 0.018, demo: '1440442 cp_steel_f12' },
  hurts: { mbPerMinute: 0.0036, demo: '1428628 tow_tetsudo_b10c' },
}

/** SourceTV file MB per demo minute on the local 9v9 demos (median of 9, range 3.5 to 4.0). */
export const FILE_MB_PER_MINUTE = 3.7

/**
 * Peak MiB saved per MB of dropped output. Measured: excluding the six optional groups on 1429417 (22.7 MB of
 * output) lowered the checker peak from 322 to 295 MB.
 */
export const DROP_PEAK_FACTOR = 1.2

/** Optional groups in the order the plan may drop them; the plan sorts them by size per minute, largest first. */
export const OPTIONAL_GROUPS = ['movers', 'drops', 'ragdolls', 'flames', 'tempents', 'pickups'] as const

/** Every group name the extras parser accepts in `options.groups` (meta, strings and alignment are always emitted). */
export const EXTRAS_GROUPS = [
  'players', 'weapons', 'buildings', 'projectiles', 'flames', 'dots', 'objectives',
  'movers', 'pickups', 'ragdolls', 'drops', 'tempents', 'hurts', 'events',
] as const

const lowMemoryDevice = (): boolean => {
  try {
    const memory = typeof navigator !== 'undefined' ? (navigator as { deviceMemory?: number }).deviceMemory : undefined
    return typeof memory === 'number' && memory <= 4
  } catch {
    return false
  }
}

/** 600 MB, or 300 MB when navigator.deviceMemory is defined and at most 4. */
export const EXTRAS_BUDGET_MB = lowMemoryDevice() ? 300 : 600

export interface ExtrasPlan {
  /** Allow-list for options.groups; undefined means every group. */
  groups?: string[]
  excluded: string[]
  skip: boolean
  reason?: string
  /** Diagnostics: predicted peak before and after the drops, the budget and the demo minutes used. */
  predictedMB?: number
  plannedMB?: number
  budgetMB?: number
  minutes?: number
}

/** Predicted worker peak in MiB for a file, before any group is dropped. */
export function predictExtrasPeakMB(fileBytes: number): number {
  return EXTRAS_PEAK.a * (fileBytes / 1e6) + EXTRAS_PEAK.b
}

/**
 * Section 8. `opts.seconds` is the demo length (ticks x interval); without it the length is estimated from the
 * file size. `opts.budgetMB` overrides EXTRAS_BUDGET_MB (tests, the bridge probe).
 */
export function planExtrasGroups(fileBytes: number, opts: { seconds?: number; budgetMB?: number } = {}): ExtrasPlan {
  const budgetMB = opts.budgetMB ?? EXTRAS_BUDGET_MB
  const fileMB = Math.max(0, fileBytes) / 1e6
  const minutes =
    opts.seconds !== undefined && Number.isFinite(opts.seconds) && opts.seconds > 0
      ? opts.seconds / 60
      : fileMB / FILE_MB_PER_MINUTE
  const predictedMB = predictExtrasPeakMB(fileBytes)
  const round = (v: number) => Math.round(v * 10) / 10

  let plannedMB = predictedMB
  if (plannedMB <= budgetMB) {
    return { excluded: [], skip: false, predictedMB: round(predictedMB), plannedMB: round(plannedMB), budgetMB, minutes: round(minutes) }
  }

  const candidates = [...OPTIONAL_GROUPS].sort(
    (a, b) => (GROUP_MB_PER_MINUTE[b] ?? 0) - (GROUP_MB_PER_MINUTE[a] ?? 0)
  )
  const excluded: string[] = []
  for (const group of candidates) {
    excluded.push(group)
    plannedMB -= (GROUP_MB_PER_MINUTE[group] ?? 0) * minutes * DROP_PEAK_FACTOR
    if (plannedMB <= budgetMB) {
      return {
        groups: EXTRAS_GROUPS.filter(g => !excluded.includes(g)),
        excluded,
        skip: false,
        predictedMB: round(predictedMB),
        plannedMB: round(plannedMB),
        budgetMB,
        minutes: round(minutes),
      }
    }
  }

  return {
    excluded: [],
    skip: true,
    reason: 'demo too large for Highlander data on this device',
    predictedMB: round(predictedMB),
    plannedMB: round(plannedMB),
    budgetMB,
    minutes: round(minutes),
  }
}
