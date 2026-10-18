// Runtime state the viewmodel layer shares with PovLayer (POV medic beam origin) and the probes.

import * as THREE from 'three'

export interface VmLive {
  subjectEntityId: number
  provider: string
  kind: string
  weaponDef: number
  /** Muzzle object of the mounted instance and its world position, updated every frame. */
  muzzle: THREE.Object3D
  muzzleWorld: THREE.Vector3
  /** Viewmodel FOV scale k of the last frame. */
  scale: number
  flip: boolean
  /** Render tick and tick + frameProgress the viewmodel was posed at in the last frame. */
  tick: number
  tickF: number
}

export const vmShared: { live: VmLive | null; debug: { flip: boolean | null; def: number | null; noDepthClear: boolean; push: number }; beamOrigin: THREE.Vector3 } = {
  live: null,
  /** Debug overrides (probe viewmodel.debug): left-handed mirror, another weapon def, depth clear off, push. */
  debug: { flip: null, def: null, noDepthClear: false, push: 0 },
  /** POV medic beam origin (HealBeam adds 41.5): PovLayer writes the eye fallback, ViewmodelLayer the muzzle. */
  beamOrigin: new THREE.Vector3(),
}
