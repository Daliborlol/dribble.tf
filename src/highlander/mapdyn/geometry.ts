// Shared geometries and materials of the F6 layer (created once at module scope, contract section 1.6
// rule 6). Every placeholder is a unit shape scaled per instance.

import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

import { DARK_METAL, METAL, NEUTRAL } from '@highlander/constants'

import {
  AMMO_BAND_COLOR,
  AMMO_BODY_COLOR,
  DROP_AMMO_COLOR,
  HEALTH_BODY_COLOR,
  HEALTH_CROSS_COLOR,
  LOCKER_OPACITY,
  RING_FILL_OPACITY,
  RING_TRACK_OPACITY,
  SLAB_OPACITY,
  WIRE_OPACITY,
} from './constants'

/** Unit cube centred on the origin. */
export const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1)

/** Edges of a unit cube as 12 thin bars (bar thickness `t` of the unit size), centred on the origin. */
function boxFrameGeometry(t: number): THREE.BufferGeometry {
  const bars: THREE.BufferGeometry[] = []
  const h = 0.5
  for (const a of [-h, h]) {
    for (const b of [-h, h]) {
      bars.push(new THREE.BoxGeometry(1 + t, t, t).translate(0, a, b)) // along X
      bars.push(new THREE.BoxGeometry(t, 1 + t, t).translate(a, 0, b)) // along Y
      bars.push(new THREE.BoxGeometry(t, t, 1 + t).translate(a, b, 0)) // along Z
    }
  }
  const merged = mergeGeometries(bars, false)
  bars.forEach(bar => bar.dispose())
  return merged ?? new THREE.BoxGeometry(1, 1, 1)
}
export const UNIT_BOX_FRAME = boxFrameGeometry(0.07)

const lambert = (color: string, opacity = 1) =>
  new THREE.MeshLambertMaterial({
    color,
    transparent: opacity < 1,
    opacity,
  })

export const MATERIALS = {
  slab: lambert(NEUTRAL, SLAB_OPACITY),
  locker: new THREE.MeshLambertMaterial({ color: '#ffffff', transparent: true, opacity: LOCKER_OPACITY }),
  healthBody: lambert(HEALTH_BODY_COLOR),
  healthCross: new THREE.MeshBasicMaterial({ color: HEALTH_CROSS_COLOR }),
  ammoBody: lambert(AMMO_BODY_COLOR),
  ammoBand: new THREE.MeshBasicMaterial({ color: AMMO_BAND_COLOR }),
  /** Taken kit ghost; colour per instance. */
  wire: new THREE.MeshBasicMaterial({
    color: '#ffffff',
    transparent: true,
    opacity: WIRE_OPACITY,
    depthWrite: false,
  }),
  /** Death marker bars; colour per instance (victim TEAM_DARK, gib red). */
  marker: new THREE.MeshBasicMaterial({ color: '#ffffff' }),
  dropAmmo: lambert(DROP_AMMO_COLOR),
  dropGib: lambert(METAL),
  dropWeapon: lambert(DARK_METAL),
}

// Respawn ring: a flat annulus whose fill sweeps clockwise from +Y by the per-instance `aProgress`.
// The unfilled part stays as a faint track so an empty ring still marks where the kit returns.
const RING_VERTEX = /* glsl */ `
attribute float aProgress;
varying vec2 vLocal;
varying float vProgress;
varying vec3 vColor;
void main() {
  vLocal = position.xy;
  vProgress = aProgress;
  #ifdef USE_INSTANCING_COLOR
    vColor = instanceColor;
  #else
    vColor = vec3(1.0);
  #endif
  vec4 p = vec4(position, 1.0);
  #ifdef USE_INSTANCING
    p = instanceMatrix * p;
  #endif
  gl_Position = projectionMatrix * modelViewMatrix * p;
}
`
const RING_FRAGMENT = /* glsl */ `
uniform float uFill;
uniform float uTrack;
varying vec2 vLocal;
varying float vProgress;
varying vec3 vColor;
void main() {
  float turn = fract(atan(vLocal.x, vLocal.y) / 6.283185307179586 + 1.0);
  float filled = step(turn, vProgress);
  gl_FragColor = vec4(vColor * mix(0.55, 1.0, filled), mix(uTrack, uFill, filled));
  #include <colorspace_fragment>
}
`

export function createRingMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: RING_VERTEX,
    fragmentShader: RING_FRAGMENT,
    uniforms: { uFill: { value: RING_FILL_OPACITY }, uTrack: { value: RING_TRACK_OPACITY } },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
}
export const RING_MATERIAL = createRingMaterial()

/** Unit annulus (outer radius 1) in the XY plane with an instanced `aProgress` attribute. */
export function createRingGeometry(capacity: number): THREE.BufferGeometry {
  const geometry = new THREE.RingGeometry(0.72, 1, 48, 1)
  geometry.setAttribute(
    'aProgress',
    new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, capacity)), 1)
  )
  return geometry
}
