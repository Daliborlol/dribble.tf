// Per-frame inputs shared by every PlayerFxLayer overlay: extras, base demo, settings, the POV subject and the
// actor rendered from his own povCamera. PlayerFxLayer owns one FxFrameCache and hands it to its overlays: the
// first overlay that asks in a frame builds the context, and the other 17 reuse it instead of each recomputing
// the POV subject.
//
// The cache keeps only the inputs it compares, never a store or instance snapshot, and PlayerFxLayer clears it
// whenever the extras change, while the overlays are off and when it unmounts. So it never keeps a previous demo
// alive, for example through the next demo's extras parse or after a load with Highlander off.

import type * as THREE from 'three'

import type { AsyncParser } from '@components/Analyse/Data/AsyncParser'
import { getState, useInstance } from '@zus/store'
import { frameTime, type FrameTime } from '@highlander/combat/time'
import type { HighlanderExtras } from '@highlander/extras/types'

import { readFxSettings, type FxSettings } from './fxSettings'
import { currentPovSubject, povCameraOwnerEntityId, povInfoOf, type PovInfo } from './pov'

export interface FxFrameContext {
  x: HighlanderExtras
  demo: AsyncParser
  /**
   * Render tick and tick + frameProgress of the frame, both read from the store (frameTime in combat/time.ts):
   * frameProgress counts only while playing with scene.interpolateFrames on. The renderTick prop would lag
   * playback.tick by a frame and step back at every tick boundary.
   */
  tick: number
  tickF: number
  settings: FxSettings
  pov: PovInfo | null
  /** entity id of the actor whose own povCamera renders the scene, if any */
  povOwner: number | undefined
  /** changes whenever an input of the per-tick overlay state changes (tick, extras, settings, POV) */
  version: number
}

/** Last version handed out. Module-wide, so a new or cleared cache never repeats a version an overlay holds. */
let lastVersion = 0
/** Caches that hold a context right now (the fx.frameCache probe); 0 once the overlays are gone. */
let heldContexts = 0
export const heldFxFrameContexts = () => heldContexts

type Settings = ReturnType<typeof getState>['settings']

const _time: FrameTime = { tick: 0, tickF: 0 }

export class FxFrameCache {
  private ctx: FxFrameContext | null = null
  // What `ctx` was built from. povSubjectAt is a pure function of (extras, demo, focused entity, tick, pov
  // settings), and povCameraOwnerEntityId reads the controls mode, the focused object and the camera override.
  private tickF = 0
  private settingsRef: Settings | null = null
  private mode: string | null = null
  private focused: THREE.Object3D | undefined = undefined
  private override: THREE.Object3D | undefined = undefined

  /** The frame context of the current frame, or null while the extras or the demo are missing. */
  get(): FxFrameContext | null {
    const inst = useInstance.getState()
    const x = inst.extrasStatus === 'ready' ? inst.extras : undefined
    const demo = inst.parsedDemo
    if (!x || !demo) {
      this.clear()
      return null
    }

    const store = getState()
    const settingsRef = store.settings
    const mode = store.scene.controls.mode
    const { focusedObject: focused, povCameraOverride: override } = inst
    const { tick: renderTick, tickF } = frameTime(_time)
    const prev = this.ctx
    if (
      prev &&
      prev.tick === renderTick &&
      prev.x === x &&
      prev.demo === demo &&
      this.tickF === tickF &&
      this.settingsRef === settingsRef &&
      this.mode === mode &&
      this.focused === focused &&
      this.override === override
    ) {
      return prev
    }

    const settings = readFxSettings()
    const pov = povInfoOf(demo, currentPovSubject(x, demo, renderTick), renderTick)
    const povOwner = povCameraOwnerEntityId()
    // The per-tick overlay state depends on the tick, the extras, the demo, the settings, the POV subject and
    // his team, and the POV owner; frames that only move frameProgress keep the version
    const sameState =
      !!prev &&
      prev.tick === renderTick &&
      prev.x === x &&
      prev.demo === demo &&
      this.settingsRef === settingsRef &&
      (prev.pov?.p ?? -2) === (pov?.p ?? -2) &&
      (prev.pov?.entityId ?? -2) === (pov?.entityId ?? -2) &&
      (prev.pov?.team ?? -2) === (pov?.team ?? -2) &&
      prev.povOwner === povOwner
    const version = sameState && prev ? prev.version : ++lastVersion

    if (!prev) heldContexts++
    this.tickF = tickF
    this.settingsRef = settingsRef
    this.mode = mode
    this.focused = focused
    this.override = override
    this.ctx = { x, demo, tick: renderTick, tickF, settings, pov, povOwner, version }
    return this.ctx
  }

  /** Drops the context and every input it holds (extras, demo, settings, scene objects). */
  clear(): void {
    if (this.ctx) heldContexts--
    this.ctx = null
    this.tickF = 0
    this.settingsRef = null
    this.mode = null
    this.focused = undefined
    this.override = undefined
  }
}
