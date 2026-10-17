// Frame helpers and the drawn-state record the F6 probes report.

import { useRef } from 'react'

import { useInstance } from '@zus/store'

/** renderTick as a ref, so useFrame callbacks read the latest prop without re-subscribing. */
export function useRenderTickRef(renderTick: number) {
  const ref = useRef(renderTick)
  ref.current = renderTick
  return ref
}

/** tickF = renderTick + frameProgress (contract section 1.2); frameProgress is 0 while paused. */
export function tickFOf(renderTick: number): number {
  return renderTick + (useInstance.getState().frameProgress || 0)
}

export type KitMode = 'full' | 'overlay' | 'none'

/**
 * How pickups draw on the loaded map. bsp-to-glb maps have no kit geometry, so F6 draws the placeholders
 * ('full'); textured GLBs (koth_product_final, the 6v6 maps) bake the kits in, so F6 only overlays the taken
 * state ('overlay'). A missing map draws placeholders too; nothing while the map is still loading.
 */
export function kitModeOf(state: string | undefined, pipeline: string | undefined): KitMode {
  if (state === 'ready') return pipeline === 'bsp-to-glb' ? 'full' : 'overlay'
  if (state === 'missing' || state === 'error') return 'full'
  return 'none'
}

/** What the mounted F6 components drew in their last update (read by the `mapdyn.state` probe). */
export const drawn = {
  kitMode: 'none' as KitMode,
  pickupSource: 'none' as 'extras' | 'meta' | 'none',
  kits: 0,
  wires: 0,
  rings: 0,
  slabs: 0,
  lockers: 0,
  markers: 0,
  dropsAmmo: 0,
  dropsGib: 0,
  dropsWeapon: 0,
  tickF: NaN,
}
