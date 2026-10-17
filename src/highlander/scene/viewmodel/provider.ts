// Viewmodel provider interface (contract section 5 F4, written verbatim by S0) with an empty registry.
// F4 registers the placeholder provider (priority 0, supports everything); a GLB provider could follow.

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

/** Registered providers, highest priority first. Empty until F4 registers its placeholder provider. */
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
