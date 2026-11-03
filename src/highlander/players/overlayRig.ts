// The overlay meshes of one actor (contract section 5 F1, PlayerFxLayer table). Built imperatively and lazily: a
// part is created the first time its effect shows and then only toggled, so a frame costs a few property writes.
// Geometries and fixed-opacity materials are shared module constants; materials whose opacity differs per actor
// (aura, teleport ring, plus signs, smoke, decloak ring) are owned by the rig and disposed with it.
//
// Units are Hammer units, z from the feet; the actor group carries position only, so +X and +Y are world axes.
// Every animation is a function of tickF (D12).

import * as THREE from 'three'

import { LEGACY_EYE_HEIGHT, TEAM_FX } from '@highlander/constants'
import { PACK_CRIT_PROBE, packDraws } from '@highlander/combat/packParticles'

import {
  BLEED_COLOR,
  DECLOAK_RING_TICKS,
  DISGUISE_SMOKE_TICKS,
  GAS_COLOR,
  JARATE_COLOR,
  MILK_COLOR,
  type OverlayState,
  type TeamName,
} from './fxState'

/** Deterministic noise (contract B.6). */
export const hash = (n: number) => {
  const s = Math.sin(n * 12.9898) * 43758.5453
  return s - Math.floor(s)
}

const TAU = Math.PI * 2

//
// ─── SHARED GEOMETRY AND MATERIALS ──────────────────────────────────────────────
//

/** Height of a flame tongue before the flicker scale (0.7 to 1.2). */
const FLAME_HEIGHT = 24

const flameGeometry = () => {
  // cone along +Z with its base at z 0 and the tip at z FLAME_HEIGHT
  const g = new THREE.ConeGeometry(5, FLAME_HEIGHT, 10, 4)
  g.rotateX(Math.PI / 2)
  g.translate(0, 0, FLAME_HEIGHT / 2)
  // A flame tongue: warm yellow at the base, the contract orange (#ff7a1a) halfway up, a transparent red tip.
  // Plain additive cones turn into flat pale-yellow shapes over the bright sand most maps have.
  const stops: [number, THREE.Color, number][] = [
    [0, new THREE.Color('#ffd27a'), 1],
    [0.5, new THREE.Color('#ff7a1a'), 0.85],
    [1, new THREE.Color('#d42400'), 0],
  ]
  const position = g.getAttribute('position')
  const colors = new Float32Array(position.count * 4)
  const color = new THREE.Color()
  for (let i = 0; i < position.count; i++) {
    const f = Math.min(1, Math.max(0, position.getZ(i) / FLAME_HEIGHT))
    const [f0, c0, a0] = stops[f < 0.5 ? 0 : 1]
    const [f1, c1, a1] = stops[f < 0.5 ? 1 : 2]
    const s = (f - f0) / (f1 - f0)
    color.copy(c0).lerp(c1, s)
    colors[i * 4] = color.r
    colors[i * 4 + 1] = color.g
    colors[i * 4 + 2] = color.b
    colors[i * 4 + 3] = a0 + (a1 - a0) * s
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 4))
  return g
}

const GEO = {
  quickfix: new THREE.TorusGeometry(30, 2, 8, 12),
  vacc: new THREE.SphereGeometry(46, 24, 16),
  aura: new THREE.SphereGeometry(42, 24, 16),
  orbiter: new THREE.OctahedronGeometry(2.5),
  buff: new THREE.TorusGeometry(22, 2, 8, 40),
  flame: flameGeometry(),
  drip: new THREE.SphereGeometry(1.5, 8, 6),
  star: new THREE.OctahedronGeometry(2),
  teleport: new THREE.TorusGeometry(26, 1.5, 8, 48),
  smoke: new THREE.SphereGeometry(1, 16, 12),
  /** decloak ring: radius 25 scaled in x and y, so the tube stays near 1.5 */
  ring: new THREE.TorusGeometry(25, 1.5, 6, 64),
}

const additive = (color: string, opacity: number) =>
  new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false })
const solid = (color: string) => new THREE.MeshBasicMaterial({ color })
const perTeam = <T>(make: (team: TeamName) => T): Record<TeamName, T> => ({ red: make('red'), blue: make('blue') })

const MAT = {
  quickfix: perTeam(t => additive(TEAM_FX[t], 0.6)),
  bonk: additive('#ffe14a', 0.12),
  orbiter: perTeam(t => solid(TEAM_FX[t])),
  buff: perTeam(t => additive(TEAM_FX[t], 0.5)),
  flame: new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.7, depthWrite: false }),
  bleeding: solid(BLEED_COLOR),
  jarate: solid(JARATE_COLOR),
  milk: solid(MILK_COLOR),
  gas: solid(GAS_COLOR),
  star: solid('#ffe14a'),
}
const vaccMaterials = new Map<string, THREE.MeshBasicMaterial>()
const vaccMaterial = (color: string) => {
  let m = vaccMaterials.get(color)
  if (!m) vaccMaterials.set(color, (m = additive(color, 0.15)))
  return m
}

let plusTexture: THREE.Texture | null = null
/** White plus sign: two crossed bars 8 x 2.5 in an 8 x 8 square. */
function getPlusTexture(): THREE.Texture {
  if (!plusTexture) {
    const size = 64
    const arm = Math.round((size * 2.5) / 8)
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = size
    const g = canvas.getContext('2d')
    if (g) {
      g.fillStyle = '#ffffff'
      g.fillRect(0, (size - arm) / 2, size, arm)
      g.fillRect((size - arm) / 2, 0, arm, size)
    }
    plusTexture = new THREE.CanvasTexture(canvas)
  }
  return plusTexture
}

const SKULL_URL = new URL('/src/assets/kill_icons/skull.png', import.meta.url).href
let skullMaterial: THREE.SpriteMaterial | null = null
/**
 * The marked-for-death sprite: the skull kill icon on a light disc with a dark rim, because the icon itself is a
 * dark silhouette that disappears against dark map geometry. The texture appears once the image has decoded.
 */
function getSkullMaterial(): THREE.SpriteMaterial {
  if (!skullMaterial) {
    const material = new THREE.SpriteMaterial({ transparent: true, depthWrite: false, opacity: 0 })
    skullMaterial = material
    const image = new Image()
    image.onload = () => {
      const size = 128
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = size
      const g = canvas.getContext('2d')
      if (!g) return
      g.beginPath()
      g.arc(size / 2, size / 2, size / 2 - 4, 0, TAU)
      g.fillStyle = '#f3ead4'
      g.fill()
      g.lineWidth = 6
      g.strokeStyle = '#1b1b1b'
      g.stroke()
      const w = size * 0.74
      const h = (w * image.height) / Math.max(1, image.width)
      g.drawImage(image, (size - w) / 2, (size - h) / 2, w, h)
      const texture = new THREE.CanvasTexture(canvas)
      texture.colorSpace = THREE.SRGBColorSpace
      material.map = texture
      material.opacity = 1
      material.needsUpdate = true
    }
    image.src = SKULL_URL
  }
  return skullMaterial
}

//
// ─── RIG ────────────────────────────────────────────────────────────────────────
//

type PartName =
  | 'quickfix' | 'vacc' | 'bonk' | 'aura' | 'orbiters' | 'soldierBuff' | 'burning'
  | 'bleeding' | 'jarate' | 'milk' | 'gas' | 'marked' | 'stun' | 'overheal' | 'teleport' | 'disguiseSmoke' | 'decloak'

/**
 * Flame tongues sit 13 units from the body axis instead of the contract's 10: at 10 they stay inside most player
 * models and only show as a faint glow. They are a little slimmer and taller than the contract's cones (r 5, h 24
 * instead of r 6, h 20) and lean outwards, so from the RTS camera they read as tongues of fire, not orange blobs.
 */
const FLAME_RADIUS = 13
const FLAME_LEAN = 0.24
const _flameAxis = new THREE.Vector3()

/** Stun stars: the contract's circle above the head (z 92, radius 10), or just under the nameplate, which covers it. */
const STUN = { z: 92, radius: 10, zUnderPlate: 64, radiusUnderPlate: 12 }

/**
 * Marked-for-death skull: 18 units at the contract's z 100 without nameplates. A nameplate grows upwards from
 * ActorDimensions.z * 0.85 (Actors.tsx, LEGACY_EYE_HEIGHT is ActorDimensions.z) and would cover it, so under a
 * plate the skull hangs from the plate's lower edge, right of the head. The sprite centre offsets it in screen
 * space, which clears the plate from every camera angle. (Plates with the Highlander items show a MARKED tag with
 * a skull instead, and computeOverlays then draws no skull at all.)
 */
const SKULL = { size: 18, z: 100, plateZ: LEGACY_EYE_HEIGHT * 0.85, centerUnderPlate: [-0.75, 1.05] as const }

const DRIP_ANGLE: Record<'bleeding' | 'jarate' | 'milk' | 'gas', number> = { bleeding: 0, jarate: 0.5, milk: 1, gas: 1.5 }

export class OverlayRig {
  readonly group = new THREE.Group()
  private readonly parts = new Map<PartName, THREE.Object3D>()
  private readonly owned: THREE.Material[] = []

  constructor(entityId: number) {
    this.group.name = 'playerFx'
    this.group.userData.entityId = entityId
    this.group.visible = false
  }

  private own<T extends THREE.Material>(material: T): T {
    this.owned.push(material)
    return material
  }

  /** The part, created on first use, made visible; or hidden and null when `on` is false. */
  private part<T extends THREE.Object3D>(name: PartName, on: boolean, create: () => T): T | null {
    let object = this.parts.get(name) as T | undefined
    if (!on) {
      if (object) object.visible = false
      return null
    }
    if (!object) {
      object = create()
      object.name = name
      this.parts.set(name, object)
      this.group.add(object)
    }
    object.visible = true
    return object
  }

  private drips(name: 'bleeding' | 'jarate' | 'milk' | 'gas', on: boolean, tickF: number) {
    const group = this.part(name, on, () => {
      const g = new THREE.Group()
      for (let i = 0; i < 3; i++) g.add(new THREE.Mesh(GEO.drip, MAT[name]))
      return g
    })
    if (!group) return
    // three drops falling from z 50 to the feet over 30 ticks, 10 ticks apart, just outside the body
    group.children.forEach((drop, i) => {
      const phase = (((tickF + 10 * i) % 30) + 30) % 30 / 30
      const angle = DRIP_ANGLE[name] + (i * TAU) / 3
      drop.position.set(14 * Math.cos(angle), 14 * Math.sin(angle), 50 * (1 - phase))
    })
  }

  /** Applies the overlay state at tickF; null hides everything. */
  update(o: OverlayState | null, tickF: number): void {
    if (!o) {
      this.group.visible = false
      return
    }
    this.group.visible = true
    this.group.scale.set(1, 1, o.scaleZ)
    const team = o.team

    // Quick-Fix uber: a turning ring at the feet
    const qf = this.part('quickfix', o.quickfix, () => new THREE.Mesh(GEO.quickfix, MAT.quickfix[team]))
    if (qf) {
      ;(qf as THREE.Mesh).material = MAT.quickfix[team]
      qf.position.set(0, 0, 2)
      qf.rotation.z = tickF * 0.1
    }

    // Vaccinator uber: a shell coloured by the resist type
    const vacc = this.part('vacc', !!o.vacc, () => new THREE.Mesh(GEO.vacc, vaccMaterial(o.vacc ?? '#ffffff')))
    if (vacc && o.vacc) {
      ;(vacc as THREE.Mesh).material = vaccMaterial(o.vacc)
      vacc.position.set(0, 0, 41)
    }

    // Bonk
    const bonk = this.part('bonk', o.bonk, () => new THREE.Mesh(GEO.aura, MAT.bonk))
    if (bonk) bonk.position.set(0, 0, 41)

    // Crit, crit bonus and minicrit aura
    const aura = this.part('aura', o.crit !== null, () => {
      const m = new THREE.Mesh(GEO.aura, this.own(additive(TEAM_FX[team], 0.1)))
      m.position.set(0, 0, 41)
      return m
    })
    if (aura) {
      const material = (aura as THREE.Mesh).material as THREE.MeshBasicMaterial
      material.color.set(TEAM_FX[team])
      material.opacity = o.crit === 'crit' ? 0.1 : o.crit === 'bonus' ? 0.05 : 0.06
    }

    // Kritz orbiters: six diamonds on a tilted orbit, radius 28, z 30 to 70
    // with the pack's crit-boost sparks drawing on the weapon, those replace the orbiters
    const orbiters = this.part('orbiters', o.crit === 'crit' && !packDraws(PACK_CRIT_PROBE), () => {
      const g = new THREE.Group()
      for (let i = 0; i < 6; i++) g.add(new THREE.Mesh(GEO.orbiter, MAT.orbiter[team]))
      return g
    })
    if (orbiters) {
      orbiters.children.forEach((child, i) => {
        const angle = tickF * 0.05 + (i * Math.PI) / 3
        child.position.set(28 * Math.cos(angle), 28 * Math.sin(angle), 50 + 20 * Math.sin(angle))
        child.rotation.z = angle * 2
        ;(child as THREE.Mesh).material = MAT.orbiter[team]
      })
    }

    // Soldier banner buff ring
    const buff = this.part('soldierBuff', o.soldierBuff, () => new THREE.Mesh(GEO.buff, MAT.buff[team]))
    if (buff) {
      ;(buff as THREE.Mesh).material = MAT.buff[team]
      buff.position.set(0, 0, 2)
    }

    // Burning: three flickering flame cones around the torso
    const burning = this.part('burning', o.burning, () => {
      const g = new THREE.Group()
      for (let i = 0; i < 3; i++) g.add(new THREE.Mesh(GEO.flame, MAT.flame))
      return g
    })
    if (burning) {
      const step = Math.floor(tickF / 3)
      burning.children.forEach((cone, i) => {
        const angle = (i * TAU) / 3
        const c = Math.cos(angle), s = Math.sin(angle)
        cone.position.set(FLAME_RADIUS * c, FLAME_RADIUS * s, 28 + 5 * i)
        // lean the tip away from the body: rotate about the horizontal tangent of the circle
        cone.quaternion.setFromAxisAngle(_flameAxis.set(-s, c, 0), FLAME_LEAN)
        const width = 0.85 + 0.3 * hash(step + i + 17.3)
        cone.scale.set(width, width, 0.7 + 0.5 * hash(step + i))
      })
    }

    this.drips('bleeding', o.bleeding, tickF)
    this.drips('jarate', o.jarate, tickF)
    this.drips('milk', o.milk, tickF)
    this.drips('gas', o.gas, tickF)

    // Marked for death: the skull above the head, or hanging from the nameplate's lower edge
    const marked = this.part('marked', o.marked, () => new THREE.Sprite(getSkullMaterial()))
    if (marked) {
      const sprite = marked as THREE.Sprite
      sprite.scale.set(SKULL.size, SKULL.size, 1)
      if (o.plates) {
        sprite.position.set(0, 0, SKULL.plateZ)
        sprite.center.set(SKULL.centerUnderPlate[0], SKULL.centerUnderPlate[1])
      } else {
        sprite.position.set(0, 0, SKULL.z)
        sprite.center.set(0.5, 0.5)
      }
    }

    // Stun: three stars circling over the head
    const stun = this.part('stun', o.stun, () => {
      const g = new THREE.Group()
      for (let i = 0; i < 3; i++) g.add(new THREE.Mesh(GEO.star, MAT.star))
      return g
    })
    if (stun) {
      const z = o.plates ? STUN.zUnderPlate : STUN.z
      const radius = o.plates ? STUN.radiusUnderPlate : STUN.radius
      stun.children.forEach((star, i) => {
        const angle = tickF * 0.12 + (i * TAU) / 3
        star.position.set(radius * Math.cos(angle), radius * Math.sin(angle), z)
        star.rotation.z = angle
      })
    }

    // Overheal: two plus signs rising from z 45 to 90 over 40 ticks, 20 ticks apart, fading out
    const overheal = this.part('overheal', o.overheal, () => {
      const g = new THREE.Group()
      for (let i = 0; i < 2; i++) {
        const sprite = new THREE.Sprite(
          this.own(new THREE.SpriteMaterial({ map: getPlusTexture(), color: TEAM_FX[team], transparent: true, depthWrite: false }))
        )
        sprite.scale.set(8, 8, 1)
        g.add(sprite)
      }
      return g
    })
    if (overheal) {
      overheal.children.forEach((sprite, i) => {
        const phase = (((tickF + 20 * i) % 40) + 40) % 40 / 40
        sprite.position.set(i === 0 ? 12 : -12, 0, 45 + 45 * phase)
        const material = (sprite as THREE.Sprite).material
        material.color.set(TEAM_FX[team])
        material.opacity = 0.8 * (1 - phase)
      })
    }

    // Teleport glow ring
    const teleport = this.part('teleport', o.teleport, () => new THREE.Mesh(GEO.teleport, this.own(additive(TEAM_FX[team], 0.2))))
    if (teleport) {
      teleport.position.set(0, 0, 2)
      const material = (teleport as THREE.Mesh).material as THREE.MeshBasicMaterial
      material.color.set(TEAM_FX[team])
      material.opacity = 0.2 + 0.1 * Math.sin(tickF * 0.2)
    }

    // Disguise smoke: four grey puffs growing from radius 10 to 40 over 30 ticks while they fade
    const smokeAge = o.smokeTick === null ? -1 : tickF - o.smokeTick
    const smokeOn = smokeAge >= 0 && smokeAge < DISGUISE_SMOKE_TICKS
    const smoke = this.part('disguiseSmoke', smokeOn, () => {
      const g = new THREE.Group()
      const material = this.own(new THREE.MeshBasicMaterial({ color: '#bbbbbb', transparent: true, opacity: 0.35, depthWrite: false }))
      for (let i = 0; i < 4; i++) g.add(new THREE.Mesh(GEO.smoke, material))
      return g
    })
    if (smoke) {
      const a = smokeAge / DISGUISE_SMOKE_TICKS
      const radius = 10 + 30 * a
      smoke.children.forEach((puff, i) => {
        const angle = Math.PI / 4 + (i * Math.PI) / 2
        puff.position.set(8 * Math.cos(angle), 8 * Math.sin(angle), 30 + (i % 2 ? 6 : -6))
        puff.scale.setScalar(radius)
      })
      ;((smoke.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.35 * (1 - a)
    }

    // Decloak cue: a ring at chest height expanding from radius 10 to 40 over 20 ticks
    const ringAge = o.decloakTick === null ? -1 : tickF - o.decloakTick
    const ringOn = ringAge >= 0 && ringAge < DECLOAK_RING_TICKS
    const ring = this.part('decloak', ringOn, () => new THREE.Mesh(GEO.ring, this.own(additive(TEAM_FX[team], 0.5))))
    if (ring) {
      const a = ringAge / DECLOAK_RING_TICKS
      const scale = (10 + 30 * a) / 25
      ring.position.set(0, 0, 41)
      ring.scale.set(scale, scale, 1)
      const material = (ring as THREE.Mesh).material as THREE.MeshBasicMaterial
      material.color.set(TEAM_FX[team])
      material.opacity = 0.5 * (1 - a)
    }
  }

  /** Names of the parts drawn right now (the fx.overlays probe reads the scene through this). */
  visibleParts(): string[] {
    if (!this.group.visible) return []
    const names: string[] = []
    for (const [name, object] of this.parts) if (object.visible) names.push(name)
    return names
  }

  dispose(): void {
    this.group.removeFromParent()
    for (const material of this.owned) material.dispose()
    this.owned.length = 0
    this.parts.clear()
  }
}
