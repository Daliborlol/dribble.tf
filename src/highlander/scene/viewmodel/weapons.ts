// Placeholder weapon models, one builder per items.json kind `k` (tf2-reference section 10.4), with a few variants
// by item class (bat, bottle, shovel, axe, bonesaw, sword; flare gun; jar, milk, cleaver; tablet, disguise kit,
// wrangler, toolbox ...). Low-poly primitives in METAL, DARK_METAL, wood and team accents.
//
// Rig space: +X forward along the barrel, +Y left, +Z up, origin at the right hand's grip, Hammer units (inches).
// `anchor` puts that origin in eye space (forward, right, up); the contract anchors are the starting point and were
// tuned on screenshots at viewmodel FOV 70.

import * as THREE from 'three'

import { NEUTRAL, TEAM_DARK, TEAM_FX, TEAM_HUD } from '@highlander/constants'
import { itemInfo } from '@highlander/items'

import { radialTexture } from './textures'

import {
  accent,
  armStyle,
  BRASS,
  glow,
  mats,
  ownGlow,
  ownSolid,
  Rig,
  solid,
  unitBoxGeometry,
  unitConeGeometry,
  bladeGeometry,
  type ArmStyle,
  type TeamKey,
  type V3,
} from './kit'

export interface WeaponModel {
  rig: Rig
  /** Eye-space (forward, right, up) of the rig origin. */
  anchor: V3
  /** Resting rotation at the anchor in degrees: roll (+ clockwise), pitch (+ nose down), yaw (+ left). */
  aim: V3
  /** Rig-space point the draw, kick, reload and swing rotations turn about (the elbow region). */
  pivot: V3
  /** Fire kick multipliers: back distance and pitch-up. */
  kick: [number, number]
  /** Muzzle flash on fire events. */
  flash: boolean
  /** Swings on ATTACK_PRIMARY instead of kicking. */
  melee: boolean
  /** Uses the reload dip. */
  reloads: boolean
  /** Builder id actually used (kind or kind/variant), reported by the probe. */
  shape: string
  /** Uniform scale of rig.root (see VM_SCALE). */
  scale: number
}

const FLARE_ORANGE = '#c4602d'
const JARATE_YELLOW = '#d9b62c'
const MILK_WHITE = '#e8e6df'
const GLASS_GREEN = '#3d6b3f'
const ICE_BLUE = '#9fd3e6'
const SLEEPER_YELLOW = '#e8d34a'
const BLACK = '#111111'

/** Model scale inside the rig (kept for providers that want to shrink a set of models). */
export const VM_SCALE = 1

interface Ctx { rig: Rig; team: TeamKey; arms: ArmStyle; classId: number; def: number; itemClass: string; weaponMode: number }

type Builder = (c: Ctx) => Omit<WeaponModel, 'rig' | 'shape' | 'scale'> & { scale?: number }

/** Two-handed long guns: grip low right, muzzle a little right of and below the crosshair. */
const LONG = { anchor: [20, 10, -8] as V3, aim: [0, 2, 2.5] as V3, pivot: [-12, -3, -6] as V3, kick: [1, 1] as [number, number], flash: true, melee: false, reloads: true }
/** One-handed guns: a little closer and higher. */
const SHORT = { ...LONG, anchor: [18, 8.5, -7.2] as V3, aim: [0, 3, 3] as V3 }

// ─── guns ──────────────────────────────────────────────────────────────────────

const rocketLauncher: Builder = ({ rig, team }) => {
  const { metal, dark, light } = mats
  rig.cyl(3.0, 38, metal(), [6, 0, 5.4], { segs: 10 })                         // tube on the shoulder
  rig.cyl(3.0, 4.5, dark(), [-15, 0, 5.4], { segs: 10 })
  rig.cyl(3.8, 2.5, dark(), [-17.5, 0, 5.4], { segs: 10, r2: 3.2 })            // rear flare
  rig.cyl(3.5, 2.6, dark(), [24.1, 0, 5.4], { segs: 10 })                      // front ring
  rig.cyl(2.4, 0.6, solid(BLACK, 0), [25.5, 0, 5.4], { segs: 10 })              // bore
  rig.cyl(3.15, 2.0, accent(team), [9, 0, 5.4], { segs: 10 })                   // team band
  rig.cyl(3.15, 0.9, light(), [16, 0, 5.4], { segs: 10 })
  rig.box([2.6, 2.0, 6.2], dark(), [0, 0, 0.5], { rot: [0, -14, 0] })          // pistol grip
  rig.box([5, 1.6, 0.7], dark(), [1.8, 0, -1.8])                               // trigger guard
  rig.box([2.4, 2.0, 5.0], dark(), [12, 0, 1.4], { rot: [0, -6, 0] })          // front grip
  rig.box([4.2, 1.1, 2.0], dark(), [13, 2.8, 8.9])                             // sight
  rig.box([0.9, 0.6, 1.6], light(), [15, 2.8, 10.3])
  rig.setMuzzle([26, 0, 5.4])
  rig.hand([0, 0, 0.2], 'right')
  rig.hand([12, 0, 0.4], 'left')
  return { ...LONG, anchor: [19, 11.5, -9], aim: [0, 1, 4], kick: [1.6, 1.4] }
}

const shotgun: Builder = ({ rig, team }) => {
  const { metal, dark, wood, darkWood, light } = mats
  rig.box([10, 2.8, 3.8], metal(), [2.6, 0, 3.0])                              // receiver
  rig.box([3.4, 0.35, 1.6], accent(team), [3, 1.55, 3.2])                      // side plate
  rig.cyl(1.05, 22, dark(), [18.6, 0, 4.0], { segs: 8 })                       // barrel
  rig.cyl(0.95, 16, dark(), [14.4, 0, 2.0], { segs: 8 })                       // magazine tube
  rig.box([1.2, 1.4, 1.0], light(), [29, 0, 4.9])                              // bead sight
  const pump = rig.group([0, 0, 0], { name: 'pump' })
  rig.box([7, 3.0, 2.8], wood(), [14.4, 0, 2.0], { parent: pump })
  rig.bar([-2.4, 0, 2.6], [-13, 0, -1.8], 2.6, wood(), { h: 4.2 })             // stock
  rig.box([1.4, 2.8, 4.8], darkWood(), [-13.5, 0, -1.9], { rot: [0, -18, 0] }) // butt
  rig.box([2.6, 2.0, 4.6], darkWood(), [-0.2, 0, 0.2], { rot: [0, -18, 0] })  // grip
  rig.setMuzzle([30, 0, 4.0])
  rig.hand([0, 0, 0.2], 'right')
  rig.hand([14.4, 0, 0.6], 'left', pump)
  return { ...LONG, kick: [1.3, 1.6] }
}

const scattergun: Builder = ({ rig, team }) => {
  const { metal, dark, wood, darkWood, light } = mats
  const barrels = rig.group([4.5, 0, 3.0], { name: 'barrels' })                // hinge
  rig.cyl(1.3, 21, dark(), [11, 1.35, 1.0], { parent: barrels, segs: 8 })
  rig.cyl(1.3, 21, dark(), [11, -1.35, 1.0], { parent: barrels, segs: 8 })
  rig.box([1.6, 5.4, 3.0], light(), [21.2, 0, 1.0], { parent: barrels })        // muzzle band
  rig.box([9, 3.8, 2.2], wood(), [7, 0, -1.0], { parent: barrels })             // fore-end
  rig.box([1.6, 0.5, 1.6], accent(team), [3, 2.0, -1.0], { parent: barrels })
  rig.box([6.5, 3.8, 4.4], metal(), [1.5, 0, 2.8])                             // receiver
  rig.bar([-1.8, 0, 2.2], [-12, 0, -2.0], 3.0, wood(), { h: 4.4 })
  rig.box([1.4, 3.2, 5.0], darkWood(), [-12.4, 0, -2.0], { rot: [0, -18, 0] })
  rig.box([2.6, 2.1, 4.6], darkWood(), [-0.2, 0, 0.2], { rot: [0, -18, 0] })
  rig.setMuzzle([22.4, 0, 1.0], barrels)
  rig.hand([0, 0, 0.2], 'right')
  rig.hand([11.5, 0, -0.6], 'left', barrels)
  return { ...LONG, kick: [1.4, 1.8] }
}

const pistol: Builder = ({ rig, team, itemClass }) => {
  const { metal, dark, light } = mats
  if (itemClass === 'tf_weapon_flaregun' || itemClass === 'tf_weapon_flaregun_revenge') {
    const orange = solid(FLARE_ORANGE, 0.3)
    rig.cyl(1.35, 8.5, orange, [5, 0, 2.9], { segs: 8 })                       // fat barrel
    rig.cyl(1.6, 1.4, dark(), [9.4, 0, 2.9], { segs: 8 })
    rig.box([5, 1.9, 2.4], orange, [1, 0, 2.4])
    rig.box([2.4, 1.8, 5], dark(), [-0.6, 0, -0.4], { rot: [0, -20, 0] })
    rig.box([1.0, 0.8, 1.0], accent(team), [0.8, 0, 4.0])
    rig.setMuzzle([10.2, 0, 2.9])
  } else {
    rig.box([10, 1.8, 2.4], metal(), [3.8, 0, 2.7])                            // slide
    rig.box([7.5, 1.6, 1.5], dark(), [3.4, 0, 1.1])                            // frame
    rig.box([2.4, 1.8, 5.2], dark(), [-0.3, 0, -0.6], { rot: [0, -16, 0] })   // grip
    rig.box([3, 0.35, 1.0], accent(team), [-0.2, 0.95, -0.6], { rot: [0, -16, 0] })
    rig.cyl(0.45, 0.8, light(), [9.2, 0, 2.8], { segs: 6 })
    rig.box([0.6, 0.5, 0.6], light(), [8.2, 0, 4.1])
    rig.setMuzzle([9.8, 0, 2.8])
  }
  rig.hand([-0.6, 0, -0.9], 'right')
  return { ...SHORT, kick: [0.9, 1.6] }
}

const revolver: Builder = ({ rig, team }) => {
  const { metal, dark, wood, light } = mats
  rig.cyl(0.8, 8, metal(), [6.4, 0, 3.0], { segs: 8 })                         // barrel
  rig.box([8, 0.6, 0.6], light(), [6.4, 0, 3.8])                               // rib
  rig.cyl(1.75, 2.8, dark(), [1.8, 0, 2.3], { segs: 6, name: 'cylinder' })     // drum
  rig.box([5, 1.4, 2.0], metal(), [1.8, 0, 3.3])                               // frame
  rig.box([1.4, 0.8, 1.9], dark(), [-1.0, 0, 3.8], { rot: [0, -30, 0], name: 'hammer' })
  rig.box([2.4, 1.9, 5], wood(), [-1.0, 0, -0.5], { rot: [0, -24, 0] })      // grip
  rig.box([0.6, 2.0, 1.2], accent(team), [-0.2, 0, 1.4])
  rig.setMuzzle([10.6, 0, 3.0])
  rig.hand([-1.0, 0, -0.8], 'right')
  return { ...SHORT, kick: [1.0, 2.8] }
}

const smg: Builder = ({ rig, team }) => {
  const { metal, dark, light } = mats
  rig.box([12, 2.4, 3.2], metal(), [3.8, 0, 2.4])                              // receiver
  rig.cyl(0.7, 6, dark(), [12.6, 0, 3.0], { segs: 8 })
  rig.cyl(1.1, 2.6, dark(), [10.4, 0, 3.0], { segs: 8 })                       // shroud
  rig.box([1.7, 1.5, 6.5], dark(), [6, 0, -1.6], { rot: [0, 12, 0] })          // magazine
  rig.box([2.3, 1.8, 4.6], dark(), [0, 0, -0.3], { rot: [0, -16, 0] })
  rig.bar([-2, 0, 3.2], [-10, 0, 1.8], 0.7, dark())                            // wire stock
  rig.bar([-2, 0, 1.4], [-10, 0, 0.8], 0.7, dark())
  rig.box([0.8, 2.0, 3.0], dark(), [-10.2, 0, 1.3])
  rig.box([4, 1.2, 1.1], light(), [3.4, 0, 4.4])                               // sight rail
  rig.box([4, 0.35, 1.3], accent(team), [4.4, 1.25, 2.4])
  rig.setMuzzle([15.8, 0, 3.0])
  rig.hand([-0.2, 0, -0.4], 'right')
  rig.hand([6.4, 0, -3.0], 'left')
  return { ...LONG, anchor: [19.5, 9, -7.6], kick: [0.7, 0.9] }
}

const sniperRifle: Builder = ({ rig, team, weaponMode }) => {
  const { metal, dark, wood, darkWood, light } = mats
  const lens = weaponMode === 1 ? solid(SLEEPER_YELLOW, 0.65) : accent(team)
  rig.cyl(0.85, 28, dark(), [21, 0, 3.4], { segs: 8 })                         // barrel
  rig.cyl(1.25, 2.4, metal(), [35.6, 0, 3.4], { segs: 8 })                     // muzzle brake
  rig.box([12, 2.6, 3.2], metal(), [3.4, 0, 2.7])                              // receiver
  rig.box([14, 2.8, 2.4], wood(), [14, 0, 1.9])                                // fore-end
  rig.cyl(1.1, 13, dark(), [4.6, 0, 5.8], { segs: 8 })                         // scope
  rig.cyl(1.1, 2.4, dark(), [12.2, 0, 5.8], { segs: 8, r2: 1.55 })
  rig.cyl(1.1, 2.0, dark(), [-2.8, 0, 5.8], { segs: 8, r2: 1.3 })
  rig.cyl(1.45, 0.35, lens, [13.5, 0, 5.8], { segs: 8 })                        // lens
  rig.box([1.4, 1.2, 1.4], metal(), [1.4, 0, 4.5])                             // mounts
  rig.box([1.4, 1.2, 1.4], metal(), [8, 0, 4.5])
  rig.bar([-2.4, 0, 2.2], [-14, 0, -1.0], 2.6, wood(), { h: 4.4 })             // stock
  rig.box([1.6, 2.8, 5.2], darkWood(), [-14.4, 0, -1.1], { rot: [0, -14, 0] })
  rig.box([2.6, 2.0, 4.6], darkWood(), [-0.2, 0, 0.1], { rot: [0, -18, 0] })
  const bolt = rig.group([1.6, 0, 3.6], { name: 'bolt' })
  rig.cylY(0.45, 3.6, light(), [0, -1.8, 0], { parent: bolt })
  rig.ball(0.9, light(), [0, -3.6, -0.2], { parent: bolt })
  rig.setMuzzle([37, 0, 3.4])
  rig.hand([0, 0, 0.1], 'right')
  rig.hand([14, 0, 0.4], 'left')
  return { ...LONG, anchor: [19, 10, -8.4], kick: [1.8, 2.2] }
}

const bow: Builder = ({ rig, team }) => {
  const { wood, darkWood, light } = mats
  // Held upright by the left hand at the riser (the rig origin); the right hand draws the string back to the nock.
  rig.box([1.8, 1.8, 6.4], darkWood(), [0, 0, 0])
  rig.box([2.0, 2.0, 2.2], solid(TEAM_HUD[team], 0.3), [0, 0, 0])               // grip wrap
  rig.bar([0, 0, 3], [-3.4, 0, 11.5], 1.2, wood(), { h: 1.6 })
  rig.bar([-3.4, 0, 11.5], [-1.8, 0, 14.5], 0.9, wood())
  rig.bar([0, 0, -3], [-3.4, 0, -11.5], 1.2, wood(), { h: 1.6 })
  rig.bar([-3.4, 0, -11.5], [-1.8, 0, -14.5], 0.9, wood())
  const stringMat = solid(NEUTRAL, 0.5)
  for (const name of ['stringTop', 'stringBottom']) {
    const s = new THREE.Mesh(unitBoxGeometry(), stringMat)
    s.name = name
    rig.root.add(s)
    rig.parts[name] = s
  }
  rig.parts.stringTop.userData.tip = [-1.8, 0, 14.5]
  rig.parts.stringBottom.userData.tip = [-1.8, 0, -14.5]
  // The arrow and the right hand ride on the nock group, which the provider pulls back with the draw
  const rest: V3 = [-3, -0.9, 0.4]
  const nock = rig.group(rest, { name: 'nock' })
  nock.userData.rest = rest
  const arrow = rig.group([0, 0, 0], { parent: nock, name: 'arrow' })
  rig.cyl(0.5, 24, wood(), [12, 0, 0], { parent: arrow, segs: 6 })
  rig.cyl(1.1, 3.2, light(), [25.6, 0, 0], { parent: arrow, segs: 6, r2: 0.05 })
  rig.box([3.6, 0.2, 1.8], accent(team), [1.9, 0, 0.9], { parent: arrow })
  rig.box([3.6, 1.8, 0.2], accent(team), [1.9, -0.9, -0.4], { parent: arrow })
  rig.setMuzzle([27.2, 0, 0], arrow)
  rig.hand([0, 0.4, -0.6], 'left', undefined, { elbowEye: [14, -16, -22] })
  rig.hand([-1.4, -0.7, -0.8], 'right', nock, { elbowEye: [4, 18, -16] })
  return { ...LONG, anchor: [27, -4, -6.5], aim: [24, -3, -8], pivot: [-10, -4, -6], kick: [0.4, 0.6], flash: false, reloads: false }
}

const minigun: Builder = ({ rig, team }) => {
  const { metal, dark, light } = mats
  rig.box([13, 9, 8.5], metal(), [-1, 0, 1.8])                                 // housing
  rig.box([4, 7.5, 6], dark(), [-9, 0, 1.6])
  rig.cyl(3.8, 4.5, dark(), [7.6, 0, 2.0], { segs: 10 })                       // motor
  rig.box([3.4, 0.4, 5], accent(team), [-1, 4.6, 1.8])                         // side plate
  rig.box([8, 3, 4], dark(), [0, 5.8, -0.8])                                   // ammo box
  rig.bar([-6, 0, 6.6], [3, 0, 6.6], 1.2, dark())                              // carry handle
  rig.bar([-5, 0, 6.0], [-5, 0, 7.6], 1.2, dark())
  rig.bar([2, 0, 6.0], [2, 0, 7.6], 1.2, dark())
  const barrels = rig.group([8.5, 0, 2.0], { name: 'barrels' })
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3
    rig.cyl(0.9, 24, dark(), [12, Math.cos(a) * 2.4, Math.sin(a) * 2.4], { parent: barrels, segs: 6 })
  }
  rig.cyl(3.7, 1.4, light(), [22.5, 0, 0], { parent: barrels, segs: 6 })
  rig.cyl(3.5, 1.2, metal(), [12, 0, 0], { parent: barrels, segs: 6 })
  rig.cyl(1.1, 24, dark(), [12, 0, 0], { parent: barrels, segs: 6 })
  rig.box([2.4, 2.2, 5.6], dark(), [-8, 0, -2.6], { rot: [0, -10, 0] })        // rear grip
  rig.setMuzzle([33.5, 0, 2.0])
  rig.hand([-8, 0, -3.2], 'right', undefined, { thick: 1.1, elbowEye: [8, 22, -24] })
  rig.hand([0, 6.4, 1.6], 'left', undefined, { thick: 1.1, elbowEye: [14, -4, -26] })
  return { ...LONG, anchor: [27, 10, -12.5], aim: [0, 1, 4], pivot: [-16, -2, -10], kick: [0.15, 0.2], reloads: false }
}

const flamethrower: Builder = ({ rig, team }) => {
  const { metal, dark, light } = mats
  rig.cyl(1.9, 27, metal(), [11, 0, 3.0], { segs: 10 })                        // main tube
  rig.cyl(2.0, 4.4, dark(), [26.6, 0, 3.0], { segs: 10, r2: 2.8 })             // nozzle
  rig.cyl(2.9, 0.9, light(), [29.2, 0, 3.0], { segs: 10 })
  rig.cyl(2.2, 1.4, dark(), [18, 0, 3.0], { segs: 10 })
  rig.cyl(3.2, 11, solid(TEAM_HUD[team], 0.25), [3, 0, -1.8], { segs: 10 })    // team fuel tank
  rig.cyl(3.3, 0.9, dark(), [8.8, 0, -1.8], { segs: 10 })
  rig.cyl(3.3, 0.9, dark(), [-2.8, 0, -1.8], { segs: 10 })
  rig.bar([-3, 0, 3.0], [-9.5, 0, 0], 1.6, dark())                             // rear handle
  rig.box([2.6, 2.0, 4.8], dark(), [0, 0, 0.4], { rot: [0, -12, 0] })
  rig.box([2.4, 2.0, 4.6], dark(), [15, 0, 0.8], { rot: [0, -8, 0] })           // front grip
  // Pilot light, always on, and the flame cone and airblast puff that the provider drives
  rig.ball(0.55, glow('#6cc7ff', 0.9), [27.8, 0, 1.0], { name: 'pilot' })
  const flame = rig.group([29.6, 0, 3.0], { name: 'flame' })
  const outer = new THREE.Mesh(unitConeGeometry(10), rig.own(ownGlow('#ff7a26', 0.55)))
  outer.name = 'flameOuter'
  flame.add(outer)
  const inner = new THREE.Mesh(unitConeGeometry(8), rig.own(ownGlow('#ffd27a', 0.7)))
  inner.name = 'flameInner'
  flame.add(inner)
  for (const name of ['tongue0', 'tongue1']) {
    const tongue = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialTexture(), color: '#ff8a3a', transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false }))
    rig.own(tongue.material)
    tongue.name = name
    flame.add(tongue)
  }
  const puff = new THREE.Mesh(unitConeGeometry(12), rig.own(ownGlow('#cfe9ff', 0.35)))
  puff.name = 'puff'
  puff.position.set(29.6, 0, 3.0)
  rig.root.add(puff)
  rig.parts.puff = puff
  rig.setMuzzle([29.6, 0, 3.0])
  rig.hand([0, 0, 0], 'right')
  rig.hand([15, 0, 0.2], 'left')
  return { ...LONG, anchor: [20.5, 9, -10.5], kick: [0.2, 0.2], flash: false, reloads: false }
}

const grenadeLauncher: Builder = ({ rig, team, itemClass }) => {
  const { metal, dark, wood, darkWood, light } = mats
  const cannon = itemClass === 'tf_weapon_cannon'
  rig.cyl(cannon ? 2.6 : 1.9, 17, dark(), [13.5, 0, 3.4], { segs: 8 })
  rig.cyl(cannon ? 3.1 : 2.4, 1.6, light(), [22, 0, 3.4], { segs: 8 })
  const drum = rig.group([3.2, 0, 2.6], { name: 'drum' })
  rig.cyl(3.5, 5.6, metal(), [0, 0, 0], { parent: drum, segs: 6 })
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3 + Math.PI / 6
    rig.cyl(0.9, 5.8, dark(), [0, Math.cos(a) * 2.2, Math.sin(a) * 2.2], { parent: drum, segs: 6 })
  }
  rig.box([1.8, 0.5, 1.8], accent(team), [0, 3.4, 0], { parent: drum })
  rig.bar([-1.4, 0, 2.2], [-11, 0, -1.0], 2.4, wood(), { h: 4.0 })
  rig.box([1.4, 2.6, 4.6], darkWood(), [-11.4, 0, -1.1], { rot: [0, -16, 0] })
  rig.box([2.6, 2.0, 4.6], darkWood(), [-0.2, 0, 0], { rot: [0, -18, 0] })
  rig.setMuzzle([23, 0, 3.4])
  rig.hand([0, 0, 0.1], 'right')
  rig.hand([12.5, 0, 1.2], 'left')
  return { ...LONG, kick: [1.3, 1.8] }
}

const stickyLauncher: Builder = ({ rig, team }) => {
  const { metal, dark, darkWood, light } = mats
  const tube = rig.group([0, 0, 0], { name: 'tube' })
  rig.cyl(2.2, 21, metal(), [12.5, 0, 3.6], { parent: tube, segs: 10 })
  rig.cyl(2.7, 3.4, dark(), [23.2, 0, 3.6], { parent: tube, segs: 10 })
  rig.cyl(2.3, 0.6, solid(BLACK, 0), [25, 0, 3.6], { parent: tube, segs: 10 })
  rig.cyl(2.35, 1.4, accent(team), [16.5, 0, 3.6], { parent: tube, segs: 10 })
  rig.box([9, 3.6, 4.4], metal(), [1.6, 0, 3.0])                               // body
  rig.box([5.4, 1.6, 1.2], light(), [2, 0, 5.6])                               // charge meter housing
  rig.box([4.6, 0.7, 0.6], accent(team), [2, 0, 6.3], { name: 'meter' })
  rig.bar([-2.8, 0, 2.8], [-10, 0, 0.2], 2.2, darkWood(), { h: 3.4 })
  rig.box([2.6, 2.0, 4.6], dark(), [-0.2, 0, -0.2], { rot: [0, -18, 0] })
  rig.setMuzzle([25.4, 0, 3.6], tube)
  rig.hand([0, 0, 0.1], 'right')
  rig.hand([10.5, 0, 0.8], 'left')
  return { ...LONG, kick: [1.2, 1.5] }
}

const medigun: Builder = ({ rig, team, def }) => {
  const { metal, dark, light } = mats
  rig.box([13, 4.2, 5.0], metal(), [3.8, 0, 2.6])                              // body
  rig.cyl(2.5, 3.8, metal(), [11.6, 0, 2.8], { segs: 8, r2: 1.7 })
  rig.cyl(1.0, 6.4, dark(), [15.8, 0, 3.0], { segs: 8 })                       // nozzle
  rig.cyl(1.6, 1.0, accent(team), [18.6, 0, 3.0], { segs: 10 })                // emitter ring
  rig.cyl(0.75, 1.1, light(), [19.6, 0, 3.0], { segs: 8 })
  // Glass canister on top that lights up with the uber charge (own material: the provider sets its emissive)
  const canisterColor = def === 35 ? '#ff7ad9' : TEAM_FX[team]                 // Kritzkrieg glows pink
  rig.cyl(1.45, 0.8, dark(), [-0.4, 0, 5.6], { segs: 8 })
  rig.cyl(1.45, 0.8, dark(), [5.4, 0, 5.6], { segs: 8 })
  rig.cyl(1.15, 5.0, rig.own(ownSolid(canisterColor, 0.3)), [2.5, 0, 5.6], { segs: 8, name: 'canister' })
  rig.bar([-3, 1.4, 0.8], [-12, 8, -9], 1.6, dark())                           // hose to the backpack
  rig.box([2.6, 2.0, 4.8], dark(), [0, 0, -0.2], { rot: [0, -14, 0] })
  rig.ball(1.6, rig.own(ownGlow(TEAM_FX[team], 0.9)), [20.4, 0, 3.0], { name: 'nozzleGlow' })
  rig.setMuzzle([20.4, 0, 3.0])
  rig.hand([0, 0, 0], 'right')
  return { ...LONG, anchor: [20, 9.5, -9.4], flash: false, reloads: false, kick: [0.3, 0.3] }
}

const syringeGun: Builder = ({ rig, team }) => {
  const { metal, dark, light } = mats
  rig.cyl(1.8, 17, metal(), [9, 0, 3.0], { segs: 8 })
  rig.cyl(2.2, 1.8, dark(), [17.8, 0, 3.0], { segs: 8 })
  rig.cyl(0.3, 3.2, light(), [20.2, 0, 3.0], { segs: 6 })                     // needle
  const vial = accent(team)
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + Math.PI / 4
    rig.cyl(0.7, 10, vial, [8.5, Math.cos(a) * 2.0, 3.0 + Math.sin(a) * 2.0], { segs: 6 })
  }
  rig.cyl(2.2, 1.6, dark(), [3, 0, 3.0], { segs: 8 })
  rig.bar([-1, 0, 3.0], [-9, 0, 0.6], 2.0, dark(), { h: 3.0 })
  rig.box([2.6, 2.0, 4.6], dark(), [-0.2, 0, -0.2], { rot: [0, -16, 0] })
  rig.setMuzzle([21.8, 0, 3.0])
  rig.hand([0, 0, 0], 'right')
  return { ...LONG, anchor: [20, 9.5, -8.6], kick: [0.6, 0.7] }
}

const crossbow: Builder = ({ rig, team }) => {
  const { metal, dark, wood, light } = mats
  rig.box([20, 2.2, 2.6], wood(), [7, 0, 2.0])                                 // stock
  rig.box([3, 1.8, 4.8], dark(), [0, 0, -0.2], { rot: [0, -16, 0] })
  rig.bar([15.6, 0, 2.6], [12, 12, 3.0], 1.2, metal(), { h: 1.8 })             // limbs
  rig.bar([15.6, 0, 2.6], [12, -12, 3.0], 1.2, metal(), { h: 1.8 })
  rig.box([2.4, 2.8, 3.0], dark(), [15.8, 0, 2.6])
  const stringMat = solid(NEUTRAL, 0.5)
  for (const name of ['stringTop', 'stringBottom']) {
    const s = new THREE.Mesh(unitBoxGeometry(), stringMat)
    s.name = name
    rig.root.add(s)
    rig.parts[name] = s
  }
  rig.parts.stringTop.userData.tip = [12, 12, 3.0]
  rig.parts.stringBottom.userData.tip = [12, -12, 3.0]
  rig.parts.stringTop.userData.cocked = [3.6, 0, 3.3]
  rig.parts.stringTop.userData.fired = [13, 0, 3.3]
  const bolt = rig.group([0, 0, 0], { name: 'loadedBolt' })
  rig.cyl(0.45, 14, light(), [10.4, 0, 3.8], { parent: bolt, segs: 6 })
  rig.ball(0.9, rig.own(ownGlow(TEAM_FX[team], 0.95)), [17.6, 0, 3.8], { parent: bolt })
  rig.box([2.4, 0.15, 1.1], accent(team), [4.4, 0, 4.3], { parent: bolt })
  rig.setMuzzle([17.8, 0, 3.8])
  rig.hand([0, 0, -0.2], 'right')
  rig.hand([9.5, 0, 0.4], 'left')
  return { ...LONG, kick: [0.8, 1.2], flash: false }
}

// ─── melee and tools ───────────────────────────────────────────────────────────

const MELEE = { ...LONG, anchor: [19, 10, -9] as V3, flash: false, melee: true, reloads: false, kick: [0, 0] as [number, number] }

const knife: Builder = ({ rig, team, def }) => {
  const { dark, light } = mats
  const bladeMat = def === 649 ? solid(ICE_BLUE, 0.35) : light()               // Spy-cicle
  rig.box([5, 1.3, 1.7], dark(), [0.7, 0, 0])                                  // handle
  rig.box([0.7, 1.8, 2.6], solid(BRASS, 0.3), [3.5, 0, 0.1])                    // guard
  rig.box([0.9, 1.4, 0.5], accent(team), [-1.4, 0, 0])
  const blade = rig.group([3.8, 0, 0.1], { name: 'blade' })
  rig.mesh(bladeGeometry(9.5, 1.9, 0.3, 2.8), bladeMat, [0, 0, 0], { parent: blade })
  rig.setMuzzle([9.5, 0, 0], blade)
  rig.hand([0.3, 0, -0.2], 'right')
  return { ...MELEE, anchor: [17, 8.5, -7], aim: [0, -16, 8], pivot: [-10, -3, -6] }
}

const melee: Builder = ({ rig, team, arms, itemClass }) => {
  const { metal, dark, wood, darkWood, light } = mats
  const grip = solid(arms.glove, 0.25)
  switch (itemClass) {
    case 'tf_weapon_bat':
    case 'tf_weapon_bat_wood':
    case 'tf_weapon_bat_fish':
    case 'tf_weapon_bat_giftwrap':
      rig.cyl(0.7, 8, darkWood(), [2, 0, 0], { segs: 8 })
      rig.cyl(0.85, 18, wood(), [14.6, 0, 0], { segs: 8, r2: 1.75 })
      rig.ball(1.0, darkWood(), [-2.3, 0, 0])
      rig.cyl(0.78, 2.4, accent(team), [5.6, 0, 0], { segs: 8 })
      rig.setMuzzle([23.5, 0, 0])
      break
    case 'tf_weapon_bottle':
    case 'tf_weapon_stickbomb':
      rig.cyl(0.7, 6, solid(GLASS_GREEN, 0.35), [2.5, 0, 0], { segs: 8, r2: 0.75 })
      rig.cyl(0.85, 2.2, solid(GLASS_GREEN, 0.35), [6.6, 0, 0], { segs: 8, r2: 1.9 })
      rig.cyl(1.95, 9, solid(GLASS_GREEN, 0.35), [12, 0, 0], { segs: 8 })
      rig.cyl(2.0, 3.4, solid('#d9c9a0', 0.3), [12, 0, 0], { segs: 8 })       // label
      rig.setMuzzle([16.5, 0, 0])
      break
    case 'tf_weapon_shovel':
      rig.cyl(0.65, 18, wood(), [7.5, 0, 0], { segs: 6 })
      rig.box([2.8, 3.8, 1.2], dark(), [-1.8, 0, 0])
      rig.box([7.5, 5.4, 0.5], metal(), [20, 0, 0])
      rig.box([2.4, 2.8, 0.7], metal(), [16, 0, 0])
      rig.box([1.1, 5.5, 0.25], accent(team), [23.4, 0, 0])
      rig.setMuzzle([24, 0, 0])
      break
    case 'tf_weapon_fireaxe':
      rig.cyl(0.7, 23, wood(), [9.5, 0, 0], { segs: 6 })
      rig.box([3.4, 1.0, 7.5], solid(TEAM_HUD[team], 0.3), [19.6, 0, 1.8])    // head
      rig.box([1.4, 0.6, 7.6], light(), [21.4, 0, 1.8])                         // edge
      rig.box([2.8, 0.9, 1.8], dark(), [18.8, 0, -2.8])                         // spike
      rig.setMuzzle([21.4, 0, 1.8])
      break
    case 'tf_weapon_bonesaw':
      rig.box([5.6, 1.5, 2.0], dark(), [1.6, 0, 0])
      rig.box([12.5, 0.35, 3.2], light(), [10.6, 0, 0.7])
      for (let i = 0; i < 7; i++) rig.box([1.0, 0.36, 1.0], light(), [5.4 + i * 1.8, 0, -1.0], { rot: [0, 0, 45] })
      rig.box([1.0, 1.8, 3.8], accent(team), [4.6, 0, 0.7])
      rig.setMuzzle([17, 0, 0.7])
      break
    case 'tf_weapon_sword':
    case 'tf_weapon_katana':
      rig.box([6, 1.4, 1.7], darkWood(), [1.3, 0, 0])
      rig.box([1.0, 2.2, 4.6], solid(BRASS, 0.3), [4.8, 0, 0])
      rig.mesh(bladeGeometry(28, 2.0, 0.32, 3.4), light(), [5.2, 0, 0])
      rig.setMuzzle([33, 0, 0])
      break
    case 'tf_weapon_club': // kukri and friends
      rig.box([5.4, 1.4, 1.8], darkWood(), [1.1, 0, 0])
      rig.mesh(bladeGeometry(13.5, 2.8, 0.35, 3.4), light(), [3.8, 0, 0.4], { rot: [0, -6, 0] })
      rig.setMuzzle([17, 0, 0.9])
      break
    default:
      if (itemClass.includes('wrench')) return wrench({ rig, team, arms, classId: 9, def: 7, itemClass, weaponMode: 0 })
      // Generic club: wrapped handle and a thicker head
      rig.cyl(0.75, 7, grip, [1.5, 0, 0], { segs: 6 })
      rig.cyl(0.95, 15, metal(), [12.5, 0, 0], { segs: 6, r2: 1.5 })
      rig.cyl(1.0, 1.3, accent(team), [5.6, 0, 0], { segs: 6 })
      rig.setMuzzle([20, 0, 0])
  }
  rig.hand([0.2, 0, -0.1], 'right')
  return { ...MELEE, anchor: [19, 11, -9.5], aim: [-18, -30, 8], pivot: [-12, -4, -8] }
}

const wrench: Builder = ({ rig, team }) => {
  const { metal, dark, light } = mats
  rig.cyl(0.9, 6, solid(TEAM_HUD[team], 0.3), [0.9, 0, 0], { segs: 8 })        // rubber grip
  rig.cyl(0.58, 12, metal(), [9.8, 0, 0], { segs: 6 })
  rig.box([3.2, 1.6, 4.2], metal(), [16.6, 0, 0.5])                            // head
  rig.box([3.0, 1.6, 1.2], metal(), [19.2, 0, 2.1])                            // upper jaw
  rig.box([2.0, 1.6, 1.2], light(), [18.6, 0, -1.1])                           // lower jaw
  rig.cylY(0.85, 1.8, dark(), [15.6, 0, -0.7], { segs: 8 })                    // adjuster
  rig.setMuzzle([20, 0, 0.7])
  rig.hand([0.4, 0, -0.1], 'right')
  return { ...MELEE, anchor: [19, 11, -9.5], aim: [-14, -32, 8], pivot: [-12, -4, -8] }
}

const fists: Builder = ({ rig, team, def }) => {
  const left = rig.group([0, 15, 0], { name: 'leftFist' })
  const right = rig.group([0, 0, 0], { name: 'rightFist' })
  rig.hand([0, 0, 0], 'right', right, { thick: 1.3, elbowEye: [8, 20, -22] })
  rig.hand([0, 0, 0], 'left', left, { thick: 1.3, elbowEye: [8, -14, -22] })
  if (def === 43 || def === 239 || def === 1084 || def === 1100) {             // boxing gloves
    rig.ball(3.8, accent(team), [1.4, 0, 0.4], { parent: right })
    rig.ball(3.8, accent(team), [1.4, 0, 0.4], { parent: left })
  }
  rig.setMuzzle([4, 0, 0], right)
  return { ...MELEE, anchor: [22, 8, -10], aim: [0, -8, 0], pivot: [-10, -3, -6] }
}

const watchWeapon: Builder = ({ rig, team, def }) => {
  // The watch as the active weapon (rare: it is normally viewmodel 1); same look as the spy watch hand
  buildWatch(rig, team, def)
  return { ...MELEE, melee: false, anchor: [18, -2, -8], aim: [22, -30, -8] }
}

const sapper: Builder = ({ rig, team }) => {
  const { dark, metal, light } = mats
  rig.box([5.4, 4.2, 3.8], dark(), [3.6, 0, 1.6])
  rig.box([0.5, 3.4, 2.8], accent(team), [6.4, 0, 1.6])
  rig.box([3.4, 1.4, 0.8], metal(), [3.4, 0, 3.8])
  rig.bar([2.2, -1.2, 3.4], [-0.5, -1.6, 8.6], 0.4, light())                   // antenna
  rig.ball(0.7, rig.own(ownGlow(TEAM_FX[team], 0.95)), [-0.5, -1.6, 9], { name: 'blink' })
  rig.setMuzzle([6.8, 0, 1.6])
  rig.hand([0.4, 0, 0.2], 'right')
  return { ...MELEE, melee: false, anchor: [17, 8, -8], aim: [0, -4, 12] }
}

const lunchbox: Builder = ({ rig, team, itemClass }) => {
  const { light } = mats
  if (itemClass === 'tf_weapon_lunchbox_drink') {
    rig.cylZ(1.8, 5.6, accent(team), [1.8, 0, 1.6], { segs: 10 })
    rig.cylZ(1.85, 0.7, light(), [1.8, 0, 4.6], { segs: 10 })
  } else {
    rig.box([4.6, 4.2, 1.2], solid('#d9b26a', 0.3), [1.8, 0, 0.5])             // bread
    rig.box([4.8, 4.4, 0.5], solid('#4f8a3a', 0.35), [1.8, 0, 1.3])            // lettuce
    rig.box([4.6, 4.2, 0.8], solid('#a8473b', 0.3), [1.8, 0, 1.9])             // meat
    rig.box([4.6, 4.2, 1.2], solid('#d9b26a', 0.3), [1.8, 0, 2.8])
  }
  rig.setMuzzle([3.4, 0, 1.8])
  rig.hand([-0.8, 0, 0.2], 'right')
  return { ...MELEE, melee: false, anchor: [18, 7, -7.6], aim: [0, 0, 10] }
}

const jar: Builder = ({ rig, team, itemClass }) => {
  const { dark, light, metal } = mats
  if (itemClass === 'tf_weapon_cleaver') {
    rig.box([4, 1.3, 1.6], dark(), [0.6, 0, 0])
    rig.box([7, 0.35, 5], light(), [6.2, 0, 1.6])
    rig.setMuzzle([9.4, 0, 1.6])
  } else if (itemClass === 'tf_weapon_jar_gas') {
    rig.cylZ(2.2, 7, solid(TEAM_HUD[team], 0.3), [1.6, 0, 1.8], { segs: 10 })
    rig.cylZ(0.7, 1.6, metal(), [1.6, 0, 6], { segs: 8 })
    rig.setMuzzle([1.6, 0, 6.8])
  } else {
    const liquid = solid(itemClass === 'tf_weapon_jar_milk' ? MILK_WHITE : JARATE_YELLOW, 0.4)
    rig.cylZ(2.4, 5.2, liquid, [1.6, 0, 1.6], { segs: 10 })
    rig.cylZ(2.5, 1.2, solid(GLASS_GREEN, 0.3), [1.6, 0, 4.6], { segs: 10, r2: 1.8 })
    rig.cylZ(1.6, 1.0, light(), [1.6, 0, 5.6], { segs: 10 })
    rig.setMuzzle([1.6, 0, 6])
  }
  rig.hand([-0.8, 0, 0.2], 'right')
  return { ...MELEE, melee: false, anchor: [18, 8, -8], aim: [0, 0, 8] }
}

const banner: Builder = ({ rig, team, def }) => {
  if (def === 354) {                                                           // Concheror
    rig.cyl(0.7, 4.6, mats.light(), [1.2, 0, 1.2], { segs: 6 })
    rig.cyl(3.0, 7, solid('#e2c9a6', 0.3), [7, 0, 1.2], { segs: 6, r2: 0.7 })
  } else {
    rig.cyl(0.6, 9, solid(BRASS, 0.35), [3.4, 0, 1.2], { segs: 8 })
    rig.cyl(0.7, 4.6, solid(BRASS, 0.35), [9.6, 0, 1.2], { segs: 8, r2: 2.7 })  // bell
    rig.cylY(1.2, 0.7, accent(team), [1.2, 0, 1.2], { segs: 8 })
  }
  rig.setMuzzle([12, 0, 1.2])
  rig.hand([0, 0, 0], 'right')
  return { ...MELEE, melee: false, anchor: [19, 7.5, -8], aim: [0, -8, 10] }
}

const pda: Builder = ({ rig, team, itemClass }) => {
  const { dark, metal, light } = mats
  if (itemClass === 'tf_weapon_laser_pointer') {                               // Wrangler
    rig.box([2.6, 2.0, 5.2], dark(), [0, 0, -0.4], { rot: [0, -16, 0] })
    rig.box([8, 2.8, 3.2], metal(), [3.2, 0, 2.6])
    rig.cyl(2.6, 1.4, solid(TEAM_HUD[team], 0.3), [7.6, 0, 3.0], { segs: 10, r2: 3.2 })
    rig.cyl(0.7, 0.6, rig.own(ownGlow('#ff3b2f', 1)), [8.6, 0, 3.0], { segs: 8 })
    rig.box([2.8, 0.5, 0.7], accent(team), [1.6, 1.4, 3.8])
    rig.setMuzzle([9, 0, 3.0])
    rig.hand([-0.2, 0, -0.6], 'right')
    return { ...SHORT, flash: false, reloads: false, kick: [0, 0] }
  }
  if (itemClass === 'tf_weapon_builder' || itemClass === 'tf_weapon_sapper') {  // toolbox while placing a building
    rig.box([11, 5.6, 7], solid(TEAM_HUD[team], 0.3), [3.4, 0, -2.4])
    rig.box([11.2, 5.8, 0.9], metal(), [3.4, 0, 1.5])
    rig.bar([0.8, 0, 1.6], [0.8, 0, 3.8], 0.7, dark())
    rig.bar([6, 0, 1.6], [6, 0, 3.8], 0.7, dark())
    rig.bar([0.8, 0, 3.8], [6, 0, 3.8], 0.7, dark())
    rig.setMuzzle([9, 0, 0])
    rig.hand([3.4, 0, 3.8], 'right')
    return { ...MELEE, melee: false, anchor: [21, 7, -9], aim: [0, 0, 8] }
  }
  if (itemClass === 'tf_weapon_pda_spy') {                                     // disguise kit: cigarette case, lid open
    const brass = solid(BRASS, 0.3)
    rig.box([5.2, 3.6, 0.7], brass, [2.6, 0, 0])
    rig.box([5.2, 3.6, 0.5], brass, [0.1, 0, 2.4], { rot: [0, -78, 0] })
    rig.box([4.4, 3.0, 0.3], solid(TEAM_HUD[team], 0.35), [2.6, 0, 0.45])
    for (let i = 0; i < 3; i++) rig.cyl(0.32, 3.6, solid('#e9e4d6', 0.4), [2.6, -1 + i, 0.8], { segs: 6 })
    rig.setMuzzle([5.2, 0, 0])
    rig.hand([-0.6, 0, -0.8], 'right')
    return { ...MELEE, melee: false, anchor: [18, 5, -7.5], aim: [0, 24, 6] }
  }
  // Engineer build / destroy PDA: a tablet held in both hands, screen toward the eye
  const tablet = rig.group([0, 5, 0], { rot: [0, 42, 0] })
  rig.box([0.9, 10, 6.6], dark(), [0, 0, 0], { parent: tablet })
  rig.box([0.3, 8.4, 5.0], solid(TEAM_DARK[team], 0.9), [-0.55, 0, 0.3], { parent: tablet })   // screen
  rig.box([0.32, 3.2, 0.5], accent(team), [-0.72, -1.6, 1.4], { parent: tablet })               // building glyphs
  rig.box([0.32, 2.0, 0.5], accent(team), [-0.72, 1.8, 1.4], { parent: tablet })
  for (let i = 0; i < 3; i++) rig.box([0.4, 1.6, 0.9], light(), [-0.55, -2.6 + i * 2.6, -2.9], { parent: tablet })
  rig.setMuzzle([0, 0, 3], tablet)
  rig.hand([0, 0, -1.4], 'right')
  rig.hand([0, 10, -1.4], 'left')
  return { ...MELEE, melee: false, anchor: [19, 6, -9], aim: [0, 0, 4] }
}

const generic: Builder = ({ rig, team }) => {
  const { metal, dark } = mats
  rig.box([10, 2.4, 3.4], metal(), [3.4, 0, 2.4])
  rig.cyl(0.9, 10, dark(), [12.4, 0, 2.8], { segs: 8 })
  rig.box([2.4, 1.8, 4.8], dark(), [0, 0, -0.4], { rot: [0, -16, 0] })
  rig.box([3.4, 0.35, 1.2], accent(team), [3.4, 1.25, 2.4])
  rig.setMuzzle([17.4, 0, 2.8])
  rig.hand([0, 0, -0.2], 'right')
  return { ...SHORT, flash: false }
}

/** The spy's watch on the left wrist (viewmodel 1). Rig origin at the wrist; the hand points forward. */
export function buildWatch(rig: Rig, team: TeamKey, def: number): void {
  const deadRinger = def === 59 || def === 947
  rig.hand([4, 0, 0], 'left', undefined, { elbowEye: [8, -16, -26] })
  rig.cylZ(2.0, 0.9, deadRinger ? solid(BRASS, 0.35) : mats.dark(), [0, 0, 2.4], { segs: deadRinger ? 12 : 8 })
  rig.cylZ(1.55, 0.35, deadRinger ? solid('#efe6c8', 0.4) : accent(team), [0, 0, 2.95], { segs: deadRinger ? 12 : 8 })
  rig.box([1.1, 0.25, 0.25], mats.dark(), [0.45, 0, 3.2])
  rig.box([4.6, 3.6, 0.6], mats.dark(), [0, 0, 1.9])                           // strap
}

const BUILDERS: Record<string, Builder> = {
  rocket_launcher: rocketLauncher,
  shotgun,
  scattergun,
  pistol,
  revolver,
  smg,
  sniper_rifle: sniperRifle,
  bow,
  minigun,
  flamethrower,
  grenade_launcher: grenadeLauncher,
  sticky_launcher: stickyLauncher,
  medigun,
  syringe_gun: syringeGun,
  crossbow,
  knife,
  melee_blunt: melee,
  melee_blade: melee,
  wrench,
  fists,
  watch: watchWeapon,
  sapper,
  lunchbox,
  jar,
  banner,
  pda,
}

/** Kinds for weapons items.json does not know, from the server class of the active weapon. */
const KIND_BY_SERVER_CLASS: Record<string, string> = {
  CTFRocketLauncher: 'rocket_launcher', CTFRocketLauncher_DirectHit: 'rocket_launcher', CTFRocketLauncher_AirStrike: 'rocket_launcher',
  CTFParticleCannon: 'rocket_launcher', CTFShotgun: 'shotgun', CTFShotgun_Soldier: 'shotgun', CTFShotgun_HWG: 'shotgun',
  CTFShotgun_Pyro: 'shotgun', CTFShotgunBuildingRescue: 'shotgun', CTFScatterGun: 'scattergun', CTFSodaPopper: 'scattergun',
  CTFPEPBrawlerBlaster: 'scattergun', CTFPistol: 'pistol', CTFPistol_Scout: 'pistol', CTFPistol_ScoutPrimary: 'pistol',
  CTFPistol_ScoutSecondary: 'pistol', CTFFlareGun: 'pistol', CTFFlareGun_Revenge: 'pistol', CTFRevolver: 'revolver',
  CTFSMG: 'smg', CTFChargedSMG: 'smg', CTFSniperRifle: 'sniper_rifle', CTFSniperRifleDecap: 'sniper_rifle',
  CTFSniperRifleClassic: 'sniper_rifle', CTFCompoundBow: 'bow', CTFMinigun: 'minigun', CTFFlameThrower: 'flamethrower',
  CTFGrenadeLauncher: 'grenade_launcher', CTFCannon: 'grenade_launcher', CTFPipebombLauncher: 'sticky_launcher',
  CWeaponMedigun: 'medigun', CTFSyringeGun: 'syringe_gun', CTFCrossbow: 'crossbow', CTFKnife: 'knife', CTFWrench: 'wrench',
  CTFRobotArm: 'fists', CTFFists: 'fists', CTFBat: 'melee_blunt', CTFBat_Wood: 'melee_blunt', CTFBat_Fish: 'melee_blunt',
  CTFBottle: 'melee_blunt', CTFShovel: 'melee_blunt', CTFFireAxe: 'melee_blade', CTFBonesaw: 'melee_blade',
  CTFClub: 'melee_blade', CTFSword: 'melee_blade', CTFKatana: 'melee_blade', CTFStickBomb: 'melee_blunt',
  CTFWeaponBuilder: 'pda', CTFWeaponSapper: 'sapper', CTFWeaponPDA_Engineer_Build: 'pda', CTFWeaponPDA_Engineer_Destroy: 'pda',
  CTFWeaponPDA_Spy: 'pda', CTFLaserPointer: 'pda', CTFJar: 'jar', CTFJarMilk: 'jar', CTFJarGas: 'jar', CTFCleaver: 'jar',
  CTFLunchBox: 'lunchbox', CTFLunchBox_Drink: 'lunchbox', CTFBuffItem: 'banner', CTFWeaponInvis: 'watch',
}

/** The builder kind for an input kind, with the server-class fallback for unknown items. */
export function resolveKind(kind: string, serverClass?: string): string {
  if (BUILDERS[kind]) return kind
  const byClass = serverClass ? KIND_BY_SERVER_CLASS[serverClass] : undefined
  return byClass ?? 'other'
}

/** Item class used for variants: items.json `c`, else a guess from the server class. */
function itemClassOf(def: number, serverClass?: string): string {
  const c = itemInfo(def)?.itemClass
  if (c) return c
  if (serverClass === 'CTFWeaponBuilder') return 'tf_weapon_builder'
  if (serverClass === 'CTFLaserPointer') return 'tf_weapon_laser_pointer'
  if (serverClass === 'CTFWeaponPDA_Spy') return 'tf_weapon_pda_spy'
  return ''
}

export function buildWeaponModel(kind: string, def: number, team: TeamKey, classId: number, serverClass?: string): WeaponModel {
  const resolved = resolveKind(kind, serverClass)
  const itemClass = itemClassOf(def, serverClass)
  const rig = new Rig(team)
  const builder = BUILDERS[resolved] ?? generic
  const arms = armStyle(classId, team)
  const model = builder({ rig, team, arms, classId, def, itemClass, weaponMode: itemInfo(def)?.weaponMode ?? 0 })
  const scale = model.scale ?? VM_SCALE
  rig.finishArms(model.anchor, model.aim, scale, arms)
  rig.root.scale.setScalar(scale)
  const variant = itemClass && (resolved.startsWith('melee') || resolved === 'pistol' || resolved === 'jar' || resolved === 'pda' || resolved === 'lunchbox') ? `/${itemClass.replace(/^tf_weapon_/, '')}` : ''
  return { rig, ...model, scale, shape: (BUILDERS[resolved] ? resolved : 'generic') + variant }
}
