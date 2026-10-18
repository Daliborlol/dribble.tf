// Small formatting helpers shared by the objective HUD, the player list, the scoreboard and the killfeed.

const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n))

/** mm:ss with the seconds floored (TF2's round timer floors). Negative values read 00:00. */
export function formatClock(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds + 1e-6)) : 0
  return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`
}

/** m:ss for durations shown as "ago" (1:05, 12:40). */
export function formatAgo(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`
}

/** 8400 -> "8.4k", 950 -> "950", 12345 -> "12.3k". */
export function formatK(value: number): string {
  if (!Number.isFinite(value)) return '0'
  if (Math.abs(value) < 1000) return String(Math.round(value))
  const k = value / 1000
  return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`
}

/** "1 point" / "3 points". */
export const points = (n: number) => `${n} ${n === 1 ? 'point' : 'points'}`

/** JSON-safe copy for probes: NaN and Infinity become null, typed arrays become plain arrays. */
export function jsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, v) => {
      if (typeof v === 'number' && !Number.isFinite(v)) return null
      if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>)
      return v
    })
  )
}

/**
 * Control point names arrive as map strings, often localization tokens: "#Badwater_cap_2" reads "point 2",
 * "#koth_viaduct_cap" reads "the point"; plain names ("Cap A, The front door dock") stay as they are.
 */
export function prettyPointName(raw: string | undefined, index?: number): string {
  const name = (raw ?? '').trim()
  if (!name) return index !== undefined ? `point ${index + 1}` : 'the point'
  if (!name.startsWith('#')) return name
  const token = name.slice(1)
  const numbered = token.match(/cap(?:ture)?_?(\d+)$/i) ?? token.match(/_(\d+)$/)
  if (numbered) return `point ${Number(numbered[1])}`
  if (/koth/i.test(token)) return 'the point'
  return token.replace(/_/g, ' ')
}
