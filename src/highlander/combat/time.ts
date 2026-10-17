// Frame time for the F3 layers (contract sections 1.2 and D12).
//
// Every F3 effect is a pure function of the extras, the base caches, the render tick, frameProgress and the settings.
// The render tick is read from the store inside useFrame instead of from the `renderTick` prop: DemoViewer advances
// `playback.tick` and `frameProgress` in the same requestAnimationFrame callback, while the prop reaches React a
// frame later. Reading both from the store keeps `tickF` monotonic at tick boundaries (no one-frame step back, the
// problem `guardedLerpProgress` works around in the base components). While paused frameProgress is 0, so
// tickF equals renderTick exactly and every probe can reproduce what was drawn.

import { getState, useInstance } from '@zus/store'
import type { HighlanderExtras } from '@highlander/extras/types'

/** DemoViewer INTERP_DELAY_TICKS: renderTick = max(1, playback.tick - 2). */
export const INTERP_DELAY_TICKS = 2

export interface FrameTime {
  /** Integer cache tick that DemoViewer renders. */
  tick: number
  /** tick + frameProgress (0 while paused or with frame interpolation off). */
  tickF: number
}

/** The render tick and tickF of the current frame (call inside useFrame or a probe). */
export function frameTime(out: FrameTime = { tick: 0, tickF: 0 }): FrameTime {
  const state = getState()
  const tick = Math.max(1, Math.floor(state.playback.tick) - INTERP_DELAY_TICKS)
  const interpolate = state.settings.scene.interpolateFrames !== false && state.playback.playing
  const progress = interpolate ? useInstance.getState().frameProgress : 0
  out.tick = tick
  out.tickF = tick + Math.min(Math.max(progress, 0), 0.999)
  return out
}

/** The extras when they are ready, else undefined (for useFrame callbacks and probes). */
export function readyExtras(): HighlanderExtras | undefined {
  const { extras, extrasStatus } = useInstance.getState()
  return extrasStatus === 'ready' ? extras : undefined
}

/** Deterministic noise of contract Appendix B.6: fract(sin(n * 12.9898) * 43758.5453). */
export function hash(n: number): number {
  const s = Math.sin(n * 12.9898) * 43758.5453
  return s - Math.floor(s)
}
