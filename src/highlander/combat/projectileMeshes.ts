// Placeholder meshes of the projectiles ProjectilesExtraLayer draws (contract 5 F3 table). Each part is one
// InstancedMesh shared by every instance of its kinds, modelled with +X forward and +Z up around the projectile
// origin (contract 1.4). Team-coloured parts take a per-instance colour.

import * as THREE from 'three'

import { DARK_METAL, METAL, NEUTRAL, TEAM_DARK, TEAM_FX, teamKey } from '@highlander/constants'
import { PROJ } from '@highlander/extras/enums'

import { coneX, cylinderX, FxInstances, makeFxMaterial } from './fx'

type MaterialKind = 'lambert' | 'basic' | 'additive' | 'glow'

interface PartDef {
  name: string
  kinds: number[]
  geometry: () => THREE.BufferGeometry
  material: MaterialKind
  /** fixed colour; parts without one take a per-instance colour from `instanceColor` */
  color?: string
  /** per-instance colour: the team's TEAM_FX or TEAM_DARK, or a colour per kind */
  instanceColor?: 'teamFx' | 'teamDark' | Record<number, string>
  opacity?: number
  softness?: number
  capacity?: number
}

const sphere = (r: number, w = 12, h = 8) => () => new THREE.SphereGeometry(r, w, h)

function fletchings(): THREE.BufferGeometry {
  // three 4 x 2 quads at the tail, radial at 0, 120 and 240 degrees around the shaft
  const parts: THREE.BufferGeometry[] = []
  for (let k = 0; k < 3; k++) {
    const quad = new THREE.PlaneGeometry(4, 2) // in XY
    quad.rotateX(Math.PI / 2) // into XZ: width along X, height along Z
    quad.translate(-13, 0, 1.5) // tail, 0.5..2.5 from the axis
    quad.rotateX((k * 2 * Math.PI) / 3)
    parts.push(quad)
  }
  return mergeGeometries(parts)
}

function ornamentCap(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.8, 0.8, 1, 8)
  g.rotateX(Math.PI / 2) // axis Y -> Z
  g.translate(0, 0, 2.7)
  return g
}

function jar(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(3, 3, 8, 12)
  g.rotateX(Math.PI / 2) // upright: axis along local Z
  return g
}

function energyRing(): THREE.BufferGeometry {
  const g = new THREE.TorusGeometry(8, 1.5, 8, 24)
  g.rotateY(Math.PI / 2) // ring axis along X: it faces the flight direction
  return g
}

function box(w: number, d: number, h: number, x0: number): () => THREE.BufferGeometry {
  return () => {
    const g = new THREE.BoxGeometry(w, d, h)
    g.translate(x0, 0, 0)
    return g
  }
}

/** Minimal geometry merge (positions, normals, uvs, indices) so the module needs no three/addons import. */
function mergeGeometries(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  let offset = 0
  for (const geo of list) {
    const pos = geo.getAttribute('position')
    const nor = geo.getAttribute('normal')
    for (let i = 0; i < pos.count; i++) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i))
      normals.push(nor.getX(i), nor.getY(i), nor.getZ(i))
    }
    if (geo.index) for (let i = 0; i < geo.index.count; i++) indices.push(geo.index.getX(i) + offset)
    else for (let i = 0; i < pos.count; i++) indices.push(i + offset)
    offset += pos.count
    geo.dispose()
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  out.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  out.setIndex(indices)
  return out
}

const PARTS: PartDef[] = [
  // 1 / 6 rocket (only when the base missed it): DARK_METAL body with a TEAM_FX cone tip
  { name: 'rocket-body', kinds: [PROJ.ROCKET, PROJ.SENTRY_ROCKET], geometry: () => cylinderX(2, 16, -8), material: 'lambert', color: DARK_METAL },
  { name: 'rocket-tip', kinds: [PROJ.ROCKET, PROJ.SENTRY_ROCKET], geometry: () => coneX(2, 5, 8), material: 'basic', instanceColor: 'teamFx' },
  // 2 pipe, 3 / 4 sticky (only when the base missed it)
  { name: 'pipe', kinds: [PROJ.PIPE, PROJ.STICKY, PROJ.PRACTICE_STICKY], geometry: sphere(3), material: 'lambert', instanceColor: 'teamDark' },
  // 5 cannonball
  { name: 'cannonball', kinds: [PROJ.CANNONBALL], geometry: sphere(4), material: 'lambert', color: DARK_METAL },
  // 7 flare: orange body plus an additive glow
  { name: 'flare', kinds: [PROJ.FLARE], geometry: () => cylinderX(1, 6, -3, 8), material: 'basic', color: '#ff8c1a' },
  { name: 'flare-glow', kinds: [PROJ.FLARE], geometry: sphere(6, 16, 12), material: 'glow', color: '#ff8c1a', opacity: 0.85, softness: 1.4 },
  // 8 arrow: shaft, metal head, team fletching
  { name: 'arrow-shaft', kinds: [PROJ.ARROW], geometry: () => cylinderX(0.5, 30, -15, 6), material: 'lambert', color: '#c8b48a' },
  { name: 'arrow-head', kinds: [PROJ.ARROW], geometry: () => coneX(1.2, 3, 15, 8), material: 'lambert', color: METAL },
  { name: 'arrow-fletching', kinds: [PROJ.ARROW], geometry: fletchings, material: 'basic', instanceColor: 'teamFx' },
  // 9 repair bolt
  { name: 'repair-bolt', kinds: [PROJ.REPAIR_BOLT], geometry: () => cylinderX(1, 12, -6, 8), material: 'lambert', color: METAL },
  { name: 'repair-bolt-tip', kinds: [PROJ.REPAIR_BOLT], geometry: () => coneX(1, 3, 6, 8), material: 'basic', instanceColor: 'teamFx' },
  // 10 healing bolt (only when the base missed it)
  { name: 'healing-bolt', kinds: [PROJ.HEALING_BOLT], geometry: () => cylinderX(0.6, 14, -7, 6), material: 'lambert', color: '#e8d44d' },
  // 11 / 12 / 13 jars
  { name: 'jar', kinds: [PROJ.JARATE, PROJ.MILK, PROJ.GAS], geometry: jar, material: 'lambert', instanceColor: { [PROJ.JARATE]: '#e8d34a', [PROJ.MILK]: '#f2f2f2', [PROJ.GAS]: '#7a8a5a' }, opacity: 0.85 },
  // 14 cleaver
  { name: 'cleaver-blade', kinds: [PROJ.CLEAVER], geometry: box(16, 1, 6, 0), material: 'lambert', color: METAL },
  { name: 'cleaver-handle', kinds: [PROJ.CLEAVER], geometry: box(6, 1.5, 1.5, -11), material: 'lambert', color: '#6b4a2b' },
  // 15 stun ball
  { name: 'stun-ball', kinds: [PROJ.STUN_BALL], geometry: sphere(1.5, 10, 8), material: 'lambert', color: '#f0f0f0' },
  // 16 ornament with a gold cap
  { name: 'ornament', kinds: [PROJ.ORNAMENT], geometry: sphere(2.5, 12, 8), material: 'lambert', color: '#d03030' },
  { name: 'ornament-cap', kinds: [PROJ.ORNAMENT], geometry: ornamentCap, material: 'lambert', color: '#d4af37' },
  // 17 energy ring
  { name: 'energy-ring', kinds: [PROJ.ENERGY_RING], geometry: energyRing, material: 'additive', instanceColor: 'teamFx' },
  // 18 energy ball with a white core
  { name: 'energy-ball', kinds: [PROJ.ENERGY_BALL], geometry: sphere(4, 16, 12), material: 'additive', instanceColor: 'teamFx' },
  { name: 'energy-ball-core', kinds: [PROJ.ENERGY_BALL], geometry: sphere(2, 10, 8), material: 'basic', color: '#ffffff' },
  // 19 Dragon's Fury fireball
  { name: 'fireball', kinds: [PROJ.FIREBALL], geometry: sphere(18, 20, 14), material: 'glow', color: '#ff8a2e', opacity: 0.5, softness: 1.2 },
  // 20 Short Circuit orb
  { name: 'mech-orb', kinds: [PROJ.MECH_ORB], geometry: sphere(5, 16, 12), material: 'additive', color: '#9fd7ff' },
  // 0 unknown
  { name: 'unknown', kinds: [PROJ.UNKNOWN], geometry: sphere(3), material: 'lambert', color: NEUTRAL },
]

function makeMaterial(def: PartDef): THREE.Material {
  const color = def.color ?? '#ffffff'
  switch (def.material) {
    case 'lambert':
      return new THREE.MeshLambertMaterial({ color, transparent: def.opacity !== undefined && def.opacity < 1, opacity: def.opacity ?? 1 })
    case 'basic':
      return new THREE.MeshBasicMaterial({ color, side: def.name === 'arrow-fletching' ? THREE.DoubleSide : THREE.FrontSide })
    case 'additive':
      return new THREE.MeshBasicMaterial({ color, transparent: true, opacity: def.opacity ?? 0.9, blending: THREE.AdditiveBlending, depthWrite: false })
    case 'glow':
    default:
      return makeFxMaterial({ color, opacity: def.opacity ?? 0.8, softness: def.softness ?? 1.2 })
  }
}

export interface ProjectilePart {
  def: PartDef
  instances: FxInstances
}

/** One InstancedMesh per part; dispose with disposeProjectileParts. */
export function createProjectileParts(): { parts: ProjectilePart[]; byKind: ProjectilePart[][] } {
  const parts = PARTS.map(def => {
    const instances = new FxInstances(def.geometry(), makeMaterial(def), def.capacity ?? 96, { color: !!def.instanceColor, name: `hl-proj-${def.name}` })
    return { def, instances }
  })
  const byKind: ProjectilePart[][] = []
  for (const part of parts) for (const kind of part.def.kinds) (byKind[kind] ??= []).push(part)
  return { parts, byKind }
}

export function disposeProjectileParts(parts: ProjectilePart[]): void {
  for (const part of parts) {
    const mesh = part.instances.mesh
    mesh.geometry.dispose()
    ;(mesh.material as THREE.Material).dispose()
    mesh.dispose()
  }
}

const _c = new THREE.Color()

/** Per-instance colour of a part for a projectile of `kind` on `team`. */
export function partColor(part: ProjectilePart, kind: number, team: number): THREE.Color | undefined {
  const mode = part.def.instanceColor
  if (!mode) return undefined
  const key = teamKey(team)
  if (mode === 'teamFx') return _c.set(key ? TEAM_FX[key] : NEUTRAL)
  if (mode === 'teamDark') return _c.set(key ? TEAM_DARK[key] : NEUTRAL)
  return _c.set(mode[kind] ?? NEUTRAL)
}

/** Parts that draw a kind (unknown kinds use the kind-0 sphere). */
export function partsForKind(byKind: ProjectilePart[][], kind: number): ProjectilePart[] {
  return byKind[kind] ?? byKind[PROJ.UNKNOWN] ?? []
}
