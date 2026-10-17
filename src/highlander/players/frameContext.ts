// Per-frame inputs shared by every PlayerFxLayer overlay (and the fx.overlays probe): extras, base demo, settings,
// the POV subject and the actor rendered from his own povCamera. Built once per frame by whichever overlay asks
// first, so 18 actors do not each recompute the POV subject.

import type { AsyncParser } from '@components/Analyse/Data/AsyncParser'
import { getState, useInstance } from '@zus/store'
import type { HighlanderExtras } from '@highlander/extras/types'

import { readFxSettings, type FxSettings } from './fxSettings'
import { currentPovSubject, povCameraOwnerEntityId, povInfoOf, type PovInfo } from './pov'

export interface FxFrameContext {
  x: HighlanderExtras
  demo: AsyncParser
  /** renderTick and renderTick + frameProgress (frameProgress is 0 while paused) */
  tick: number
  tickF: number
  settings: FxSettings
  pov: PovInfo | null
  /** entity id of the actor whose own povCamera renders the scene, if any */
  povOwner: number | undefined
  /** changes whenever an input of the per-tick overlay state changes (tick, extras, settings, POV) */
  version: number
}

let cache: { tick: number; store: unknown; inst: unknown; ctx: FxFrameContext | null } | null = null
let key: unknown[] = []
let version = 0

function sameKey(next: unknown[]): boolean {
  if (next.length !== key.length) return false
  for (let i = 0; i < next.length; i++) if (next[i] !== key[i]) return false
  return true
}

/** The frame context at `renderTick`, or null while the extras or the demo are missing. */
export function fxFrameContext(renderTick: number): FxFrameContext | null {
  const inst = useInstance.getState()
  const store = getState()
  if (cache && cache.tick === renderTick && cache.store === store && cache.inst === inst) return cache.ctx

  let ctx: FxFrameContext | null = null
  const x = inst.extrasStatus === 'ready' ? inst.extras : undefined
  const demo = inst.parsedDemo
  if (x && demo) {
    const settings = readFxSettings()
    const pov = povInfoOf(demo, currentPovSubject(x, demo, renderTick), renderTick)
    const povOwner = povCameraOwnerEntityId()
    const nextKey = [renderTick, x, demo, store.settings, pov?.p ?? -2, pov?.entityId ?? -2, pov?.team ?? -2, povOwner ?? -2]
    if (!sameKey(nextKey)) {
      key = nextKey
      version++
    }
    const progress = inst.frameProgress
    const tickF = renderTick + (progress > 0 && progress < 1 ? progress : 0)
    ctx = { x, demo, tick: renderTick, tickF, settings, pov, povOwner, version }
  }
  cache = { tick: renderTick, store, inst, ctx }
  return ctx
}
