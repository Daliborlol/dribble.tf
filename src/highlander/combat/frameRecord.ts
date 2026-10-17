// What the F3 layers drew in the last frame, for the probes (`combat.critGlow`, `projectiles.trails`,
// `projectiles.meshes`). Recording only runs while the debug bridge is installed (`?debug=1`), so normal playback
// allocates nothing for it.

export type Vec3 = [number, number, number]

export interface DrawnTrail {
  /** `base:<instance>` or `extras:<instance>` */
  key: string
  instance: number
  source: 'base' | 'extras'
  width: number
  color: string
  /** head first, rounded to 0.01 */
  points: Vec3[]
}

export interface FrameRecord {
  tickF: number
  frame: number
  meshes: Map<number, Vec3>
  glows: Map<number, Vec3>
  trails: DrawnTrail[]
  smoke: number
  counts: Record<string, number>
}

const makeRecord = (): FrameRecord => ({ tickF: NaN, frame: 0, meshes: new Map(), glows: new Map(), trails: [], smoke: 0, counts: {} })

/** ProjectilesExtraLayer (meshes and ribbons of extras-drawn instances). */
export const extrasRecord = makeRecord()
/** Projectiles.tsx in extras mode (base-drawn trails and smoke). */
export const baseRecord = makeRecord()
/** CombatFxLayer (glows of extras-drawn crit instances and effect counts). */
export const combatRecord = makeRecord()

let frameCounter = 0

export function recordingEnabled(): boolean {
  return typeof window !== 'undefined' && !!(window as unknown as { __dribble?: unknown }).__dribble
}

/** Starts a record for this frame. */
export function resetRecord(record: FrameRecord, tickF: number): void {
  record.tickF = tickF
  record.frame = ++frameCounter
  record.meshes.clear()
  record.glows.clear()
  record.trails.length = 0
  record.smoke = 0
  for (const key of Object.keys(record.counts)) delete record.counts[key]
}

const r2 = (v: number) => Math.round(v * 100) / 100

/** Copies `count` flat xyz points into a rounded point list. */
export function pointList(points: ArrayLike<number>, count: number): Vec3[] {
  const out: Vec3[] = []
  for (let k = 0; k < count; k++) out.push([r2(points[k * 3]), r2(points[k * 3 + 1]), r2(points[k * 3 + 2])])
  return out
}

export function roundVec(x: number, y: number, z: number): Vec3 {
  return [r2(x), r2(y), r2(z)]
}
