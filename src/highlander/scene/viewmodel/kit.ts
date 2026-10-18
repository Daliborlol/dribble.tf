// Building blocks of the placeholder viewmodels: cached materials and geometries, a small rig builder that models in
// Source eye axes (+X forward, +Y left, +Z up, Hammer units), and the forearms with team-coloured sleeves and gloves.
//
// Geometries and materials are cached at module level and shared by every instance, so swapping weapons (a spy
// quick-switching every few ticks) only allocates Object3Ds. Nothing here is ever disposed: the caches are bounded by
// the fixed set of shapes the builders use.

import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'

import { DARK_METAL, METAL, NEUTRAL, TEAM_DARK, TEAM_FX, TEAM_HUD } from '@highlander/constants'

export const DEPTH_CLEAR_ORDER = 1_000_000
export const VM_ORDER = 1_000_001
/** Additive viewmodel glows (flame, muzzle flash, nozzle) draw after the solid viewmodel meshes. */
export const VM_GLOW_ORDER = 1_000_002

/**
 * Forces the contract's viewmodel flags on every mesh and sprite under `object`: renderOrder VM_ORDER (VM_GLOW_ORDER
 * for additive glows), no frustum culling, and transparent solids with depth test and write, so they sort after the
 * depth clear and never clip into walls. ViewmodelLayer runs it on every provider instance after `create` (GLB
 * providers included); a provider that adds meshes later (the spy's watch hand) runs it on them itself.
 */
export function prepareViewmodelObject(object: THREE.Object3D): void {
  object.traverse(node => {
    const mesh = node as THREE.Mesh
    if (!(mesh as any).isMesh && !(node as THREE.Sprite).isSprite) return
    node.frustumCulled = false
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const additive = materials.some(m => m && m.blending === THREE.AdditiveBlending)
    node.renderOrder = additive ? VM_GLOW_ORDER : VM_ORDER
    if (additive) return
    for (const m of materials) {
      if (!m) continue
      m.transparent = true
      m.depthTest = true
      m.depthWrite = true
    }
  })
}

export const WOOD = '#6b4a2b'
export const DARK_WOOD = '#4a3220'
/** Shirt cuff of the spy and the medic. */
export const CUFF_WHITE = '#e6e1d3'
export const GLOVE_BLACK = '#1e1e1e'
export const ENGI_GLOVE = '#a8802e'
export const BRASS = '#a88a3c'

export type V3 = [number, number, number]

/** Eye-space (forward, right, up) elbows, below the bottom edge at the default viewmodel FOV. */
export const RIGHT_ELBOW_EYE: V3 = [10, 21, -20]
export const LEFT_ELBOW_EYE: V3 = [18, -2, -22]
export type TeamKey = 'red' | 'blue'

const DEG = Math.PI / 180

// ─── materials ─────────────────────────────────────────────────────────────────

const materials = new Map<string, THREE.Material>()

/**
 * Studio light of the viewmodel, in view space (x right, y up, z toward the eye): a key from the upper left behind
 * the eye, a weak fill from the lower right and a sky/ground term. The world's lights stay in at a fifth of their
 * weight. Without it every face of a weapon that points back at the eye gets the same light from the map's two
 * overhead directional lights, and boxes read as flat cut-outs; with it the top, the left and the right faces of
 * every part differ in brightness wherever the player looks, which is what makes the low-poly shapes read as
 * objects. The uniforms are shared by every viewmodel solid.
 */
const STUDIO_UNIFORMS = {
  vmKeyDir: { value: new THREE.Vector3(-0.42, 0.74, 0.52).normalize() },
  vmFillDir: { value: new THREE.Vector3(0.72, -0.2, 0.36).normalize() },
  // base, sky-up, key, fill: top faces about 1.6, faces toward the eye 1.3, left 1.05, right 0.7, bottom 0.35
  vmStudio: { value: new THREE.Vector4(0.3, 0.22, 1.45, 0.32) },
  vmWorld: { value: 0.18 },
}

function studioLight(shader: THREE.WebGLProgramParametersWithUniforms): void {
  Object.assign(shader.uniforms, STUDIO_UNIFORMS)
  shader.fragmentShader = shader.fragmentShader
    .replace('void main() {', 'uniform vec3 vmKeyDir;\nuniform vec3 vmFillDir;\nuniform vec4 vmStudio;\nuniform float vmWorld;\nvoid main() {')
    .replace(
      '#include <lights_fragment_end>',
      [
        '#include <lights_fragment_end>',
        '{',
        '  float vmKey = max(dot(normal, vmKeyDir), 0.0);',
        '  float vmFill = max(dot(normal, vmFillDir), 0.0);',
        '  float vmUp = 0.5 + 0.5 * normal.y;',
        '  float vmLight = vmStudio.x + vmStudio.y * vmUp + vmStudio.z * vmKey + vmStudio.w * vmFill;',
        '  reflectedLight.directDiffuse = diffuseColor.rgb * vmLight + vmWorld * reflectedLight.directDiffuse;',
        '  reflectedLight.indirectDiffuse *= vmWorld;',
        '}',
      ].join('\n')
    )
}

function withStudioLight<T extends THREE.MeshLambertMaterial>(m: T): T {
  m.onBeforeCompile = studioLight
  m.customProgramCacheKey = () => 'hl-viewmodel-studio-1'
  return m
}

/**
 * Flat-shaded Lambert for solid parts, lit by the studio light above. `transparent` is what puts the viewmodel in the
 * late transparent pass after the depth clear (contract render-order trick); opacity stays 1. `emissive` below 0.5
 * only lifts the darkest faces a little (the studio light does the shaping); 0.5 and above marks self-lit parts
 * (team accents, lenses) that should stay bright in any light.
 */
export function solid(color: string, emissive = 0.2): THREE.MeshLambertMaterial {
  const key = `s:${color}:${emissive}`
  let m = materials.get(key) as THREE.MeshLambertMaterial | undefined
  if (!m) {
    const intensity = emissive >= 0.5 ? emissive * 0.75 : emissive * 0.3
    m = withStudioLight(new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: intensity, flatShading: true }))
    m.transparent = true
    m.depthTest = true
    m.depthWrite = true
    m.fog = false
    materials.set(key, m)
  }
  return m
}

/** Team accents (stripes, lenses, vials): strongly self-lit so the team colour reads in any light. */
export function accent(team: TeamKey): THREE.MeshLambertMaterial {
  return solid(TEAM_FX[team], 0.65)
}

/** Additive glow; never writes depth. */
export function glow(color: string, opacity = 1): THREE.MeshBasicMaterial {
  const key = `g:${color}:${opacity}`
  let m = materials.get(key) as THREE.MeshBasicMaterial | undefined
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: false,
    })
    materials.set(key, m)
  }
  return m
}

/** A glow whose opacity changes per instance (flame flicker, nozzle): its own material, not cached. */
export function ownGlow(color: string, opacity = 1): THREE.MeshBasicMaterial {
  return glow(color, opacity).clone()
}

/** A solid part whose emissive changes per instance (the medigun canister): its own material, not cached. */
export function ownSolid(color: string, emissive = 0.2): THREE.MeshLambertMaterial {
  return withStudioLight(solid(color, emissive).clone()) // clone() does not carry onBeforeCompile
}

// ─── geometries ────────────────────────────────────────────────────────────────

const geometries = new Map<string, THREE.BufferGeometry>()

function cachedGeometry(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = geometries.get(key)
  if (!g) {
    g = make()
    geometries.set(key, g)
  }
  return g
}

const q = (v: number) => Math.round(v * 100) / 100

/**
 * Box with sizes along X (forward), Y (left), Z (up). Parts at least 0.9 thick get chamfered edges: under the flat
 * shading and the studio light each chamfer catches a highlight, which is most of what separates a designed low-poly
 * part from a raw box. Thin plates stay plain boxes.
 */
export function boxGeometry(lx: number, ly: number, lz: number): THREE.BufferGeometry {
  return cachedGeometry(`b:${q(lx)}:${q(ly)}:${q(lz)}`, () => {
    const min = Math.min(lx, ly, lz)
    if (min < 0.9) return new THREE.BoxGeometry(lx, ly, lz)
    return new RoundedBoxGeometry(lx, ly, lz, 1, Math.min(0.45, 0.17 * min))
  })
}

/**
 * Lathe around +Y with chamfered rims: radius r at -len/2, r2 at +len/2. A facet faces each principal direction
 * (phiStart), so 6- and 8-sided barrels show a flat top instead of an edge.
 */
function chamferedLathe(r: number, r2: number, len: number, segs: number): THREE.BufferGeometry {
  const h = len / 2
  const c = Math.min(0.32, 0.18 * Math.min(r, r2), 0.2 * len)
  const points =
    c < 0.06 || Math.min(r, r2) < 0.7
      ? [new THREE.Vector2(0, -h), new THREE.Vector2(r, -h), new THREE.Vector2(r2, h), new THREE.Vector2(0, h)]
      : [
          new THREE.Vector2(0, -h),
          new THREE.Vector2(r - c, -h),
          new THREE.Vector2(r, -h + c),
          new THREE.Vector2(r2, h - c),
          new THREE.Vector2(r2 - c, h),
          new THREE.Vector2(0, h),
        ]
  return new THREE.LatheGeometry(points, segs, -Math.PI / segs)
}

/** Cylinder or cone along +X, centred on the origin; `r2` is the radius at the front (+X) end. */
export function cylXGeometry(r: number, len: number, segs = 8, r2 = r): THREE.BufferGeometry {
  return cachedGeometry(`cx:${q(r)}:${q(r2)}:${q(len)}:${segs}`, () => {
    const g = chamferedLathe(r, r2, len, segs)
    g.rotateZ(-Math.PI / 2) // +Y (radius r2) to +X
    return g
  })
}

/** Cylinder along +Z, centred on the origin. */
export function cylZGeometry(r: number, len: number, segs = 8, r2 = r): THREE.BufferGeometry {
  return cachedGeometry(`cz:${q(r)}:${q(r2)}:${q(len)}:${segs}`, () => {
    const g = chamferedLathe(r, r2, len, segs)
    g.rotateX(Math.PI / 2) // +Y to +Z
    return g
  })
}

/** Cylinder along +Y, centred on the origin. */
export function cylYGeometry(r: number, len: number, segs = 8): THREE.BufferGeometry {
  return cachedGeometry(`cy:${q(r)}:${q(len)}:${segs}`, () => chamferedLathe(r, r, len, segs))
}

/** Low-poly sphere. */
export function ballGeometry(r: number): THREE.BufferGeometry {
  return cachedGeometry(`s:${q(r)}`, () => new THREE.IcosahedronGeometry(r, 0))
}

/** Flat blade in the X-Z plane: a rectangle of `len` x `h` whose front end narrows to a point, `t` thick. */
export function bladeGeometry(len: number, h: number, t: number, tip: number): THREE.BufferGeometry {
  return cachedGeometry(`bl:${q(len)}:${q(h)}:${q(t)}:${q(tip)}`, () => {
    const shape = new THREE.Shape()
    shape.moveTo(0, -h / 2)
    shape.lineTo(len - tip, -h / 2)
    shape.lineTo(len, h / 2)
    shape.lineTo(0, h / 2)
    shape.closePath()
    const g = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false })
    g.translate(0, 0, -t / 2)
    g.rotateX(Math.PI / 2) // shape Y to +Z, extrusion along -Y
    return g
  })
}

/** Unit box for segments that are stretched and oriented every frame (bow and crossbow strings). */
export function unitBoxGeometry(): THREE.BufferGeometry {
  return cachedGeometry('unit', () => new THREE.BoxGeometry(1, 1, 1))
}

/** Unit cone along +X, apex at 0 and open base (radius 1) at 1: flames and puffs, scaled every frame. */
export function unitConeGeometry(segs = 10): THREE.BufferGeometry {
  return cachedGeometry(`ucone:${segs}`, () => {
    const g = new THREE.ConeGeometry(1, 1, segs, 1, true)
    g.rotateZ(Math.PI / 2) // apex (+Y) to -X, base to +X
    g.translate(0.5, 0, 0)
    return g
  })
}

// ─── rig builder ───────────────────────────────────────────────────────────────

const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _dir = new THREE.Vector3()
const X_AXIS = new THREE.Vector3(1, 0, 0)

/** Places a unit-length X-aligned mesh between two points (scale x = length, y and z = thickness). */
export function orientBetween(object: THREE.Object3D, a: V3, b: V3, thickY: number, thickZ = thickY): void {
  _a.set(a[0], a[1], a[2])
  _b.set(b[0], b[1], b[2])
  _dir.subVectors(_b, _a)
  const len = Math.max(1e-3, _dir.length())
  object.position.addVectors(_a, _b).multiplyScalar(0.5)
  object.quaternion.setFromUnitVectors(X_AXIS, _dir.multiplyScalar(1 / len))
  object.scale.set(len, thickY, thickZ)
}

export interface RigPartOptions {
  rot?: V3            // degrees about X (roll), Y (pitch, + = nose down), Z (yaw, + = left)
  parent?: THREE.Object3D
  name?: string
}

/** A weapon model under construction. Everything is in rig space: +X forward, +Y left, +Z up, origin at the grip. */
export class Rig {
  readonly root = new THREE.Group()
  readonly parts: Record<string, THREE.Object3D> = {}
  readonly ownMaterials: THREE.Material[] = []
  muzzle = new THREE.Object3D()

  constructor(readonly team: TeamKey) {
    this.root.name = 'vmRig'
    this.muzzle.name = 'vmMuzzle'
    this.root.add(this.muzzle)
  }

  private place<T extends THREE.Object3D>(object: T, pos: V3, opts?: RigPartOptions): T {
    object.position.set(pos[0], pos[1], pos[2])
    if (opts?.rot) object.rotation.set(opts.rot[0] * DEG, opts.rot[1] * DEG, opts.rot[2] * DEG)
    ;(opts?.parent ?? this.root).add(object)
    if (opts?.name) {
      object.name = opts.name
      this.parts[opts.name] = object
    }
    return object
  }

  group(pos: V3, opts?: RigPartOptions): THREE.Group {
    return this.place(new THREE.Group(), pos, opts)
  }

  mesh(geometry: THREE.BufferGeometry, material: THREE.Material, pos: V3, opts?: RigPartOptions): THREE.Mesh {
    return this.place(new THREE.Mesh(geometry, material), pos, opts)
  }

  box(size: V3, material: THREE.Material, pos: V3, opts?: RigPartOptions): THREE.Mesh {
    return this.mesh(boxGeometry(size[0], size[1], size[2]), material, pos, opts)
  }

  /** Cylinder along X; `r2` is the front radius. */
  cyl(r: number, len: number, material: THREE.Material, pos: V3, opts?: RigPartOptions & { segs?: number; r2?: number }): THREE.Mesh {
    return this.mesh(cylXGeometry(r, len, opts?.segs ?? 8, opts?.r2 ?? r), material, pos, opts)
  }

  cylZ(r: number, len: number, material: THREE.Material, pos: V3, opts?: RigPartOptions & { segs?: number; r2?: number }): THREE.Mesh {
    return this.mesh(cylZGeometry(r, len, opts?.segs ?? 8, opts?.r2 ?? r), material, pos, opts)
  }

  cylY(r: number, len: number, material: THREE.Material, pos: V3, opts?: RigPartOptions & { segs?: number }): THREE.Mesh {
    return this.mesh(cylYGeometry(r, len, opts?.segs ?? 8), material, pos, opts)
  }

  ball(r: number, material: THREE.Material, pos: V3, opts?: RigPartOptions): THREE.Mesh {
    return this.mesh(ballGeometry(r), material, pos, opts)
  }

  /**
   * Bar from a to b, `w` wide and `h` high. Built from a box of the bar's own length (not a stretched unit box), so
   * the chamfers keep their size. The rotation is the shortest one from +X, so a bar in the X-Z plane keeps its width
   * along rig Y.
   */
  bar(a: V3, b: V3, w: number, material: THREE.Material, opts?: { parent?: THREE.Object3D; h?: number; name?: string }): THREE.Mesh {
    _a.set(a[0], a[1], a[2])
    _b.set(b[0], b[1], b[2])
    _dir.subVectors(_b, _a)
    const len = Math.max(0.01, _dir.length())
    const mesh = new THREE.Mesh(boxGeometry(len, w, opts?.h ?? w), material)
    mesh.position.addVectors(_a, _b).multiplyScalar(0.5)
    mesh.quaternion.setFromUnitVectors(X_AXIS, _dir.multiplyScalar(1 / len))
    ;(opts?.parent ?? this.root).add(mesh)
    if (opts?.name) {
      mesh.name = opts.name
      this.parts[opts.name] = mesh
    }
    return mesh
  }

  /** Six-sided tube from a to b with radius r1 at a and r2 at b (forearm sleeves, hoses). */
  tube(a: V3, b: V3, r1: number, r2: number, material: THREE.Material, parent?: THREE.Object3D): THREE.Mesh {
    _a.set(a[0], a[1], a[2])
    _b.set(b[0], b[1], b[2])
    const len = _a.distanceTo(_b)
    const mesh = new THREE.Mesh(cylXGeometry(r1, Math.max(0.01, len), 6, r2), material)
    mesh.position.addVectors(_a, _b).multiplyScalar(0.5)
    mesh.quaternion.setFromUnitVectors(X_AXIS, _dir.subVectors(_b, _a).normalize())
    ;(parent ?? this.root).add(mesh)
    return mesh
  }

  /** Declares a gloved hand; the forearm is added by `finishArms` once the rig's place in eye space is known. */
  hand(at: V3, side: 'right' | 'left', parent?: THREE.Object3D, opts?: { elbowEye?: V3; thick?: number }): void {
    this.hands.push({ at, side, parent, elbowEye: opts?.elbowEye, thick: opts?.thick ?? 1 })
  }

  readonly hands: { at: V3; side: 'right' | 'left'; parent?: THREE.Object3D; elbowEye?: V3; thick: number }[] = []

  /**
   * Adds every declared hand with its forearm. Elbows are given in eye space (forward, right, up), below the bottom
   * edge of the screen, and converted into rig space through the rig's anchor, aim and scale, so the forearms always
   * leave the screen downward whatever the weapon.
   */
  finishArms(anchor: V3, aimDeg: V3, scale: number, style: ArmStyle): void {
    const aim = new THREE.Quaternion().setFromEuler(new THREE.Euler(aimDeg[0] * DEG, aimDeg[1] * DEG, aimDeg[2] * DEG))
    const inv = aim.clone().invert()
    this.root.updateMatrixWorld(true)
    for (const h of this.hands) {
      const eye = h.elbowEye ?? (h.side === 'right' ? RIGHT_ELBOW_EYE : LEFT_ELBOW_EYE)
      // eye (forward, right, up) -> anchor frame (X forward, Y left, Z up) -> rig space
      const local = new THREE.Vector3(eye[0] - anchor[0], -(eye[1] - anchor[1]), eye[2] - anchor[2]).applyQuaternion(inv).multiplyScalar(1 / scale)
      const parent = h.parent ?? this.root
      parent.worldToLocal(local) // rig.root has no parent and an identity transform here, so world = rig space
      addArm(this, h.at, [local.x, local.y, local.z], h.thick === 1 ? style : { ...style, thick: style.thick * h.thick }, parent, h.side)
    }
  }

  setMuzzle(pos: V3, parent?: THREE.Object3D): void {
    this.muzzle.position.set(pos[0], pos[1], pos[2])
    ;(parent ?? this.root).add(this.muzzle)
  }

  /** Registers a material owned by this instance (disposed with it). */
  own<T extends THREE.Material>(material: T): T {
    this.ownMaterials.push(material)
    return material
  }
}

// ─── arms ─────────────────────────────────────────────────────────────────────

export interface ArmStyle { sleeve: string; glove: string; cuff: string; thick: number }

/**
 * Team-coloured sleeves (HUD team colour) and gloves (dark team colour, so the weapon stays the brightest thing in
 * the hand), with class touches on the cuff and the forearm thickness (TF2 silhouettes).
 */
export function armStyle(classId: number, team: TeamKey): ArmStyle {
  const base: ArmStyle = { sleeve: TEAM_HUD[team], glove: TEAM_DARK[team], cuff: GLOVE_BLACK, thick: 1 }
  switch (classId) {
    case 1: return { ...base, cuff: CUFF_WHITE, thick: 0.86 }                    // scout: slim, taped wrists
    case 3: return { ...base, thick: 1.06 }                                      // soldier
    case 4: return { ...base, thick: 1.04 }                                      // demoman
    case 5: return { ...base, cuff: CUFF_WHITE, thick: 0.94 }                    // medic: lab coat cuff
    case 6: return { ...base, thick: 1.22 }                                      // heavy: big forearms
    case 7: return { ...base, thick: 1.1 }                                       // pyro
    case 8: return { ...base, cuff: CUFF_WHITE, thick: 0.9 }                     // spy: shirt cuff under the suit
    case 9: return { ...base, cuff: ENGI_GLOVE, thick: 1.0 }                     // engineer: work glove cuff
    default: return base
  }
}

const _gx = new THREE.Vector3()
const _gy = new THREE.Vector3()
const _gz = new THREE.Vector3()
const _basis = new THREE.Matrix4()

/**
 * A gloved hand at `hand` with the forearm running back to `elbow` (off screen). The glove's frame follows the
 * forearm (X), with the back of the hand turned up (Z as close to rig +Z as the forearm allows) and the thumb on the
 * inner side: rig +Y (left) for the right hand, -Y for the left. The contract's 7 x 5 x 5 hand boxes covered the
 * pistols and grips at viewmodel FOV 70, so the glove is a smaller chamfered back of the hand, a curled block of
 * fingers and a thumb, scaled by the class thickness.
 */
export function addArm(rig: Rig, hand: V3, elbow: V3, style: ArmStyle, parent?: THREE.Object3D, side: 'right' | 'left' = 'right'): THREE.Group {
  const arm = new THREE.Group()
  arm.name = 'vmArm'
  ;(parent ?? rig.root).add(arm)
  const t = style.thick
  _a.set(hand[0], hand[1], hand[2])
  _b.set(elbow[0], elbow[1], elbow[2])
  _dir.subVectors(_a, _b).normalize() // elbow -> hand
  const wrist: V3 = [hand[0] - _dir.x * 1.9 * t, hand[1] - _dir.y * 1.9 * t, hand[2] - _dir.z * 1.9 * t]
  const cuffEnd: V3 = [wrist[0] - _dir.x * 1.2, wrist[1] - _dir.y * 1.2, wrist[2] - _dir.z * 1.2]

  // Glove frame: X along the forearm, Z (back of the hand) toward rig up
  _gx.copy(_dir)
  _gz.set(0, 0, 1).addScaledVector(_gx, -_gx.z)
  if (_gz.lengthSq() < 1e-4) _gz.set(-1, 0, 0).addScaledVector(_gx, _gx.x)
  _gz.normalize()
  _gy.crossVectors(_gz, _gx)
  _basis.makeBasis(_gx, _gy, _gz)

  const gloveMat = solid(style.glove, 0.3)
  const glove = new THREE.Group()
  glove.name = 'vmGlove'
  glove.position.copy(_a)
  glove.quaternion.setFromRotationMatrix(_basis)
  arm.add(glove)
  const inner = side === 'right' ? 1 : -1
  const backOfHand = new THREE.Mesh(boxGeometry(3.3 * t, 2.8 * t, 2.2 * t), gloveMat)
  backOfHand.position.set(-0.2 * t, 0, 0.35 * t)
  glove.add(backOfHand)
  const fingers = new THREE.Mesh(boxGeometry(1.7 * t, 2.7 * t, 2.5 * t), gloveMat)
  fingers.position.set(1.75 * t, 0, -0.35 * t)
  fingers.rotation.y = 0.35 // curled down around the grip
  glove.add(fingers)
  const thumb = new THREE.Mesh(boxGeometry(2.2 * t, 1.0 * t, 1.0 * t), gloveMat)
  thumb.position.set(0.9 * t, 1.45 * t * inner, 0.55 * t)
  thumb.rotation.z = 0.45 * inner
  glove.add(thumb)

  rig.tube(wrist, cuffEnd, 1.8 * t, 1.8 * t, solid(style.cuff, 0.25), arm)
  rig.tube(cuffEnd, elbow, 1.6 * t, 2.15 * t, solid(style.sleeve, 0.18), arm)
  return arm
}

// ─── shared accents ────────────────────────────────────────────────────────────

export const mats = {
  metal: () => solid(METAL),
  dark: () => solid(DARK_METAL, 0.18),
  light: () => solid(NEUTRAL, 0.2),
  wood: () => solid(WOOD, 0.2),
  darkWood: () => solid(DARK_WOOD, 0.2),
  brass: () => solid(BRASS, 0.25),
}
