// POV field of view on the server timeline (contract section 5 F4, FOV).
//
// fovAt (getters.ts, contract 3.7.2) starts the zoom spline at m_flFOVTime. The server sets that time while it runs
// the player's user command, in the player's own tickbase time, which runs ahead of the server tick: on 1438891 the
// FOV entries at cache ticks 1229, 1804, 1863 and 1926 carry m_flFOVTime 1233, 1807, 1867 and 1930. Read as server
// time, every zoom would start 3 to 4 ticks after HL.ZOOMED changed, so the scope overlay (which follows the flag)
// and the camera would disagree for those ticks, and at unzoom + 3 the camera would still show the full zoom.
//
// The change itself is networked with the entry, so the entry tick is when it happened on the server timeline.
// povFovAt is fovAt with the spline start at min(m_flFOVTime, entry tick); everything else is the contract formula.
// The player's own view (which predicts the zoom in his tickbase time) starts the transition at the same moment.

import { trackIndexAt } from '@highlander/extras/track'
import type { HighlanderExtras } from '@highlander/extras/types'

/** Source FOV (horizontal at 4:3) of player p at tickF, with the zoom transition on the server timeline. */
export function povFovAt(x: HighlanderExtras, p: number, tickF: number, defaultFov = 90): number {
  const t = x.players.fov
  const i = trackIndexAt(t, p, Math.floor(tickF))
  if (i < 0) return defaultFov
  const target = t.fov[i] || defaultFov, start = t.start[i] || defaultFov, rate = t.rate[i]
  if (!(rate > 0) || target === start) return target
  const fovTime = t.tick[i]
  const t0 = Number.isFinite(fovTime) ? Math.min(fovTime, t.ticks[i]) : t.ticks[i]
  const d = ((tickF - t0) * x.meta.intervalPerTick) / rate
  if (d >= 1) return target
  const s = Math.max(0, d)
  return start + (target - start) * (s * s * (3 - 2 * s)) // SimpleSpline
}
