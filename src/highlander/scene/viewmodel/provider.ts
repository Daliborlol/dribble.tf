// Viewmodel provider interface (contract section 5 F4, written verbatim by S0). F4 registers the placeholder provider
// (priority 0, supports everything); a GLB provider (priority 10) can register later and take over the classes and
// weapons it has models for.
//
// What a provider gets and returns:
// - `create(input)` builds one instance for (classId, weaponDef, team); ViewmodelLayer recreates it whenever one of
//   the three changes and calls `dispose()` on the old one.
// - `object` is in eye space with three.js camera axes: +x right, +y up, -z forward, origin at the eye, units in
//   Hammer units (TF2 viewmodel models use the same frame, so a GLB viewmodel can be added as is). ViewmodelLayer
//   parents it under the POV camera, applies the viewmodel FOV scale, the left-handed mirror and the minimal-viewmodel
//   offset, adds the depth clear and forces the render order and material flags on every mesh after `create`.
// - `muzzle` is where the muzzle flash and the POV medic beam start.
// - `update(input)` runs every frame and must be a pure function of the input (D12): no clocks, no frame counting.
//
// The fields after `vm1` are optional additions by F4 (allowed inside the owner's folder); ViewmodelLayer always
// fills them in.

import * as THREE from 'three'

import type { MedigunState, VmState, WeaponState } from '@highlander/extras/getters'

export interface ViewmodelInput {
  p: number; classId: number; team: 'red' | 'blue'
  weaponDef: number; kind: string            // items.json `k`, 'other' fallback
  tickF: number
  drawTick: number                           // tick the current weapon became active
  fireTicks: number[]                        // fire events of p within [tickF - 40, tickF]
  anim: { tick: number; event: number; data: number }[]   // anim events of p within [tickF - 60, tickF]
  wstate: WeaponState | null
  medigun: MedigunState | null
  sniperCharge: number
  flags: number
  flip: boolean
  vm0: VmState | null
  vm1: VmState | null
  /** Seconds per tick (charge times of bows and sticky launchers). */
  interval?: number
  /** Tick the current `wstate.reload` phase 1 or 2 began (only while reloading). */
  reloadSince?: number
  /** Tick the latest reload phase ended (`wstate.reload` left 1 and 2), when that was within the last 60 ticks. */
  reloadEnd?: number
  /** Tick the current `wstate.state` value began (minigun spin, airblast puff). */
  stateSince?: number
  /** Ticks within [tickF - 12, tickF] where the clip grew by one (shell-by-shell reloads). */
  clipUpTicks?: number[]
  /** Server class name of the active weapon, for weapons items.json does not know. */
  weaponClass?: string
}
export interface ViewmodelInstance { object: THREE.Object3D; muzzle: THREE.Object3D; update(input: ViewmodelInput): void; dispose(): void }
export interface ViewmodelProvider { id: string; priority: number; supports(input: ViewmodelInput): boolean; create(input: ViewmodelInput): ViewmodelInstance }
export function registerViewmodelProvider(provider: ViewmodelProvider): void {
  const index = providers.findIndex(({ id }) => id === provider.id)
  if (index >= 0) providers.splice(index, 1)
  providers.push(provider)
  providers.sort((a, b) => b.priority - a.priority)
}
export function pickViewmodelProvider(input: ViewmodelInput): ViewmodelProvider {
  return providers.find(provider => provider.supports(input)) ?? EMPTY_PROVIDER
}

/** Ids of the registered providers, highest priority first (probes). */
export function listViewmodelProviders(): string[] {
  return providers.map(({ id }) => id)
}

/** Registered providers, highest priority first. */
const providers: ViewmodelProvider[] = []

/** Fallback while no provider supports the input: an empty object, so callers never need a null check. */
const EMPTY_PROVIDER: ViewmodelProvider = {
  id: 'empty',
  priority: -Infinity,
  supports: () => true,
  create: () => {
    const object = new THREE.Group()
    const muzzle = new THREE.Object3D()
    object.add(muzzle)
    return { object, muzzle, update: () => {}, dispose: () => {} }
  },
}
