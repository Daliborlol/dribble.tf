// Third-person animation input from the demo (as/tpanim): what src/assetpack/playerAnim.ts needs to pose a pack
// player model at a frame time, read from the base caches and the extras only, so the pose is a pure function of
// tickF (D12). Seeking to the same tick twice gives the same pose.
//
// - Velocity: the base positions 2 ticks either side; the move_x/move_y pose parameters are its direction relative
//   to the eye yaw (Source's yaw is counter-clockwise, so move_y = -sin) scaled by speed / the run's ground speed.
// - Run cycle: the horizontal distance travelled since the first tick divided by the run clip's stride, so the feet
//   stay planted at any speed. Distances are summed per block of 64 ticks and cached per demo and player.
// - Crouch: the base duck bit, faded over the 0.2 s TF2 fades a sequence change; air: the height's second difference
//   over 6 ticks either side below half of sv_gravity (800) or a vertical speed above 300 units/s, faded the same way.
//   Players have no networked ground flag, so the start and end of a jump lag by about 6 ticks.
// - Slot: the anim slot of the held item (the disguise weapon while drawn as the disguise); deployed: TF_COND_AIMING
//   (heavy's revved minigun, the sniper's zoom).
// - Pitch: body_pitch = -eye pitch; attack gestures restart at each ATTACK_PRIMARY animation event.

import type { AsyncParser } from '@components/Analyse/Data/AsyncParser'
import { HL } from '@highlander/extras/enums'
import { animEvents, flagsAt } from '@highlander/extras/getters'
import type { HighlanderExtras } from '@highlander/extras/types'
import type { PlayerAnimInput, PlayerModelItem } from '@pack/playerAnim'
import { playerSlot } from '@pack/playerAnim'

const BLOCK = 64
const FADE_TICKS = 13 // 0.2 s at 66 tick
const AIR_HALF = 6
const ATTACK_PRIMARY = 0
/** gestures look back at most this many ticks (the longest attack gesture lasts under 3 s) */
const GESTURE_WINDOW = 200

interface DistanceCache {
  /** cumulative distance at the start of each block, NaN while not computed */
  prefix: Float64Array
  filled: number
}

const distances = new WeakMap<object, Map<number, DistanceCache>>()

type Demo = Pick<AsyncParser, 'playerCache' | 'ticks' | 'intervalPerTick'>

function px(demo: Demo, p: number, tick: number, axis: number): number {
  const cache = demo.playerCache.positionCache
  return (cache.get(p, tick, axis) | 0) / cache.scale
}

const clampTick = (demo: Demo, t: number) => Math.min(Math.max(t, 0), Math.max(0, demo.ticks - 1))

/** Horizontal step between ticks t and t + 1, 0 across teleports and respawns. */
function step(demo: Demo, p: number, t: number): number {
  const d = Math.hypot(px(demo, p, t + 1, 0) - px(demo, p, t, 0), px(demo, p, t + 1, 1) - px(demo, p, t, 1))
  return d > 60 ? 0 : d
}

/** Horizontal distance from tick 0 to tickF. */
function distanceAt(demo: Demo, p: number, tickF: number): number {
  let perDemo = distances.get(demo.playerCache)
  if (!perDemo) {
    perDemo = new Map()
    distances.set(demo.playerCache, perDemo)
  }
  let cache = perDemo.get(p)
  if (!cache) {
    cache = { prefix: new Float64Array(Math.ceil(demo.ticks / BLOCK) + 1), filled: 0 }
    perDemo.set(p, cache)
  }
  const t = Math.min(Math.max(Math.floor(tickF), 0), Math.max(0, demo.ticks - 2))
  const block = Math.floor(t / BLOCK)
  while (cache.filled < block) {
    const b = cache.filled
    let sum = 0
    for (let k = b * BLOCK; k < (b + 1) * BLOCK; k++) sum += step(demo, p, k)
    cache.prefix[b + 1] = cache.prefix[b] + sum
    cache.filled++
  }
  let d = cache.prefix[block]
  for (let k = block * BLOCK; k < t; k++) d += step(demo, p, k)
  return d + step(demo, p, t) * (tickF - Math.floor(tickF))
}

function airborne(demo: Demo, p: number, t: number, interval: number): boolean {
  const z0 = px(demo, p, clampTick(demo, t - AIR_HALF), 2)
  const z1 = px(demo, p, clampTick(demo, t), 2)
  const z2 = px(demo, p, clampTick(demo, t + AIR_HALF), 2)
  const dt = AIR_HALF * interval
  if (z0 - 2 * z1 + z2 < -0.5 * 800 * dt * dt) return true
  const vz = (px(demo, p, clampTick(demo, t + 2), 2) - px(demo, p, clampTick(demo, t - 2), 2)) / (4 * interval)
  return Math.abs(vz) > 300
}

/** Weight of a binary state at tickF with a fade of FADE_TICKS after each change (pure: scans back). */
function faded(now: (t: number) => boolean, tickF: number): number {
  const t = Math.floor(tickF)
  const cur = now(t)
  for (let k = 1; k <= FADE_TICKS; k++) {
    if (now(t - k) !== cur) {
      const f = Math.min(1, (k - 1 + (tickF - t)) / FADE_TICKS)
      return cur ? f : 1 - f
    }
  }
  return cur ? 1 : 0
}

export interface AnimStateOptions {
  demo: Demo
  extras: HighlanderExtras | undefined
  p: number
  tickF: number
  item: PlayerModelItem
  /** item def of the held weapon as drawn, -1 none */
  weaponDef: number
}

const _gestureCache = new WeakMap<object, { p: number; from: number; events: { tick: number; event: number }[] }>()

/** Fills `out` (see the header). */
export function playerAnimInput(o: AnimStateOptions, out: PlayerAnimInput): PlayerAnimInput {
  const { demo, extras, p, tickF, item } = o
  const interval = demo.intervalPerTick || 0.015
  const t = clampTick(demo, Math.floor(tickF))
  const a = clampTick(demo, t - 2)
  const b = clampTick(demo, t + 2)
  const span = Math.max(1, b - a) * interval
  let vx = (px(demo, p, b, 0) - px(demo, p, a, 0)) / span
  let vy = (px(demo, p, b, 1) - px(demo, p, a, 1)) / span
  let speed = Math.hypot(vx, vy)
  if (speed > 1500) { vx = 0; vy = 0; speed = 0 }

  const angles = demo.playerCache.viewAnglesCache.getAngles(p, t)
  const eyeYaw = (angles.y * Math.PI) / 180
  out.pitch = Math.min(90, Math.max(-90, -angles.x))

  out.slot = playerSlot(item, o.weaponDef)
  const slot = item.anim.slots[out.slot]
  out.deployed = !!(slot?.deployed && extras && (flagsAt(extras, p, t) & HL.AIMING) !== 0)
  const run = (out.deployed ? slot?.deployed?.run : undefined) ?? slot?.run
  const groundSpeed = run?.speed && run.speed > 1 ? run.speed : 300
  const m = Math.min(1, speed / groundSpeed)
  const rel = Math.atan2(vy, vx) - eyeYaw
  out.moveX = speed > 1 ? Math.cos(rel) * m : 0
  out.moveY = speed > 1 ? -Math.sin(rel) * m : 0
  out.move = Math.min(1, speed / 40)
  out.distance = distanceAt(demo, p, tickF)
  out.time = tickF * interval
  out.crouch = faded(k => (demo.playerCache.getDuck(p, clampTick(demo, k)) & 1) !== 0, tickF)
  out.air = faded(k => airborne(demo, p, clampTick(demo, k), interval), tickF)

  out.gesture = null
  if (extras && extras.meta.available.anim) {
    const duration = Math.max(slot?.attackStand?.duration ?? 0, slot?.attackCrouch?.duration ?? 0)
    const from = t - Math.min(GESTURE_WINDOW, Math.ceil(duration / interval) + 1)
    // events of [t - GESTURE_WINDOW - 16, t + 48): a superset of what the lookup reads, so the result never
    // depends on what an earlier frame cached
    let cached = _gestureCache.get(out)
    if (!cached || cached.p !== p || t - GESTURE_WINDOW < cached.from || t + 1 > cached.from + GESTURE_WINDOW + 64) {
      cached = { p, from: t - GESTURE_WINDOW - 16, events: animEvents(extras, p, t - GESTURE_WINDOW - 16, t + 48) }
      _gestureCache.set(out, cached)
    }
    for (let i = cached.events.length - 1; i >= 0; i--) {
      const e = cached.events[i]
      if (e.tick > tickF) continue
      if (e.tick < from) break
      if (e.event !== ATTACK_PRIMARY) continue
      const crouch = (demo.playerCache.getDuck(p, clampTick(demo, e.tick)) & 1) !== 0
      out.gesture = { crouch, t: (tickF - e.tick) * interval }
      break
    }
  }
  return out
}

export function createAnimInput(): PlayerAnimInput {
  return { slot: 'PRIMARY', deployed: false, crouch: 0, move: 0, air: 0, moveX: 0, moveY: 0, distance: 0, time: 0, pitch: 0, gesture: null }
}
