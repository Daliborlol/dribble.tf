// The placeholder viewmodel provider (contract section 5 F4): priority 0, supports every input. It builds a
// procedural weapon model per (class, weapon, team) with weapons.ts and drives it with the pure pose of animate.ts.
//
// Object tree (eye space, three.js camera axes at the top):
//   object                     the instance root the layer parents under the POV camera
//     eye                      fixed rotation from rig axes (+X forward, +Y left, +Z up) to camera axes
//       anchor                 the weapon's resting place and aim (weapons.ts)
//         pose                 draw, kick, reload, swing and sway, turning about the elbow pivot
//           pivotOffset        -pivot
//             rig.root         the weapon, hands and forearms
//       watchAnchor            the spy's left hand with the watch (viewmodel 1), rises and lowers on its own

import * as THREE from 'three'

import { flashTexture } from './textures'
import { computePose, hash01, MELEE_KINDS, type VmPose } from './animate'
import { buildWatch, buildWeaponModel, resolveKind, VM_SCALE, type WeaponModel } from './weapons'
import { armStyle, orientBetween, Rig, VM_GLOW_ORDER, type V3 } from './kit'
import { registerViewmodelProvider, type ViewmodelInput, type ViewmodelInstance, type ViewmodelProvider } from './provider'

const DEG = Math.PI / 180
/** Rig axes (+X forward, +Y left, +Z up) to camera axes (+x right, +y up, -z forward). */
const EYE_FROM_RIG = new THREE.Quaternion().setFromRotationMatrix(
  new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0))
)
const WATCH_ANCHOR: V3 = [18, -10, -10]
/** Resting watch-hand rotation: roll toward the centre, pitch the face back toward the eye. */
const WATCH_AIM: V3 = [22, -30, -8]

const setFromRig = (o: THREE.Object3D, v: V3) => o.position.set(v[0], -v[1], v[2])

export interface PlaceholderInstance extends ViewmodelInstance {
  shape: string
  lastPose: VmPose | null
}

export function createPlaceholder(input: ViewmodelInput): PlaceholderInstance {
  const kind = resolveKind(input.kind, input.weaponClass)
  const model: WeaponModel = buildWeaponModel(input.kind, input.weaponDef, input.team, input.classId, input.weaponClass)
  const { rig } = model

  const object = new THREE.Group()
  object.name = 'vmPlaceholder'
  const eye = new THREE.Group()
  eye.quaternion.copy(EYE_FROM_RIG)
  object.add(eye)

  const anchor = new THREE.Group()
  anchor.position.set(model.anchor[0], -model.anchor[1], model.anchor[2])
  anchor.rotation.set(model.aim[0] * DEG, model.aim[1] * DEG, model.aim[2] * DEG)
  eye.add(anchor)
  const pose = new THREE.Group()
  anchor.add(pose)
  const sc = model.scale
  const pivotOffset = new THREE.Group()
  pivotOffset.position.set(-model.pivot[0] * sc, -model.pivot[1] * sc, -model.pivot[2] * sc)
  pose.add(pivotOffset)
  pivotOffset.add(rig.root)

  // Muzzle flash: a camera-facing star just in front of the muzzle
  // Drawn over the weapon (no depth test): seen from behind, the barrel itself covers the muzzle point
  const flashMaterial = new THREE.SpriteMaterial({
    map: flashTexture(),
    color: '#ffd27a',
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    transparent: true,
    fog: false,
    toneMapped: false,
  })
  const flash = new THREE.Sprite(flashMaterial)
  flash.name = 'vmMuzzleFlash'
  flash.scale.set(6, 6, 6)
  flash.position.set(1.5, 0, 0)
  flash.visible = false
  flash.renderOrder = VM_GLOW_ORDER
  rig.muzzle.add(flash)

  // Spy watch hand (viewmodel 1), built lazily the first time a watch model shows up
  let watchAnchor: THREE.Group | null = null
  let watchRig: Rig | null = null
  const ensureWatch = (def: number) => {
    if (watchAnchor) return watchAnchor
    watchRig = new Rig(input.team)
    const style = armStyle(input.classId, input.team)
    buildWatch(watchRig, input.team, def)
    watchRig.finishArms(WATCH_ANCHOR, WATCH_AIM, VM_SCALE, style)
    watchRig.root.scale.setScalar(VM_SCALE)
    watchAnchor = new THREE.Group()
    watchAnchor.name = 'vmWatch'
    watchAnchor.add(watchRig.root)
    eye.add(watchAnchor)
    return watchAnchor
  }

  const parts = rig.parts
  const _a: V3 = [0, 0, 0]

  const instance: PlaceholderInstance = {
    object,
    muzzle: rig.muzzle,
    shape: model.shape,
    lastPose: null,
    update(next: ViewmodelInput) {
      const p = computePose(next, kind, { kick: model.kick, melee: model.melee || MELEE_KINDS.has(kind), reloads: model.reloads })
      instance.lastPose = p

      // Whole weapon about the pivot: eye-space offsets map to rig axes (right = -Y)
      pose.position.set(model.pivot[0] * sc + p.fwd, model.pivot[1] * sc - p.right, model.pivot[2] * sc + p.up)
      pose.rotation.set(p.roll * DEG, p.pitch * DEG, p.yaw * DEG)

      flash.visible = p.muzzleFlash && model.flash
      if (flash.visible) {
        // Rotate the star a little per shot so consecutive flashes differ (a function of the tick, not of time)
        flashMaterial.rotation = (Math.floor(next.tickF) * 0.7) % (Math.PI * 2)
      }

      if (parts.barrels) {
        if (kind === 'minigun') parts.barrels.rotation.x = p.spin * DEG
        else if (kind === 'scattergun') parts.barrels.rotation.y = 28 * p.reload * DEG // break open
      }
      if (parts.bolt) parts.bolt.position.x = 1.5 - 3 * p.cycle
      if (parts.pump) parts.pump.position.x = -3 * p.cycle
      if (parts.drum) parts.drum.rotation.x = p.drum * DEG
      if (parts.hammer) parts.hammer.rotation.y = (-30 + 40 * p.kick) * DEG
      if (parts.tube) parts.tube.position.x = -5 * p.pull
      if (parts.meter) parts.meter.scale.x = 0.15 + 0.85 * p.pull
      if (parts.blade) parts.blade.rotation.y = -30 * p.bladeUp * DEG
      if (parts.blink) parts.blink.visible = Math.floor(next.tickF / 10) % 2 === 0

      if (parts.nock) {
        // Bow: the nock (arrow and right hand) moves back with the draw; the string follows it
        const rest = parts.nock.userData.rest as V3
        parts.nock.position.set(rest[0] - 10 * p.pull, rest[1], rest[2])
        if (parts.arrow) parts.arrow.visible = p.loaded
        _a[0] = parts.nock.position.x - 0.4
        _a[1] = rest[1]
        _a[2] = rest[2]
        orientBetween(parts.stringTop, parts.stringTop.userData.tip, _a, 0.22)
        orientBetween(parts.stringBottom, parts.stringBottom.userData.tip, _a, 0.22)
      } else if (parts.stringTop && parts.stringBottom) {
        // Crossbow: the string is drawn back while a bolt is loaded
        const latch = (p.loaded ? parts.stringTop.userData.cocked : parts.stringTop.userData.fired) as V3
        orientBetween(parts.stringTop, parts.stringTop.userData.tip, latch, 0.22)
        orientBetween(parts.stringBottom, parts.stringBottom.userData.tip, latch, 0.22)
        if (parts.loadedBolt) parts.loadedBolt.visible = p.loaded
      }

      if (parts.flame) {
        const on = p.flame > 0
        parts.flame.visible = on
        if (on) {
          // Contract cone (r 3, length 14) as the hot core, plus a longer soft plume and two tongues of fire
          // that read in first person, where a cone pointing away is seen nearly end-on
          const len = 14 * (0.8 + 0.4 * p.flame)
          const outer = parts.flame.getObjectByName('flameOuter')!
          const inner = parts.flame.getObjectByName('flameInner')!
          outer.scale.set(len * 2.2, 5.5 * p.flame, 5.5 * p.flame)
          inner.scale.set(len, 3 * p.flame, 3 * p.flame)
          ;((outer as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.25 + 0.2 * p.flame
          for (const [name, base] of [['tongue0', 0.45], ['tongue1', 0.8]] as const) {
            const tongue = parts.flame.getObjectByName(name)
            if (!tongue) continue
            const wobble = 0.85 + 0.3 * hash01(Math.floor(next.tickF * 3) + (name === 'tongue0' ? 11 : 23))
            tongue.position.set(len * 2.2 * base, 0, 0)
            tongue.scale.setScalar((6 + 10 * base) * wobble * p.flame)
          }
        }
      }
      if (parts.puff) {
        const on = p.puff >= 0
        parts.puff.visible = on
        if (on) {
          const s = 0.3 + p.puff
          parts.puff.scale.set(22 * s, 7 * s, 7 * s)
          ;((parts.puff as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.45 * (1 - p.puff)
        }
      }
      if (parts.nozzleGlow) {
        parts.nozzleGlow.visible = p.heal > 0
        parts.nozzleGlow.scale.setScalar(0.9 + 0.25 * Math.sin(next.tickF * 0.6))
      }
      if (parts.canister) {
        const m = (parts.canister as THREE.Mesh).material as THREE.MeshLambertMaterial
        m.emissiveIntensity = 0.25 + 1.1 * p.charge
      }
      if (parts.rightFist && parts.leftFist) {
        const jab = p.jab >= 0 ? Math.sin(Math.PI * p.jab) : 0
        parts.rightFist.position.set(p.jabLeft ? 0 : 10 * jab, 0, p.jabLeft ? 0 : 2 * jab)
        parts.leftFist.position.set(p.jabLeft ? 10 * jab : 0, 16, p.jabLeft ? 2 * jab : 0)
      }
      if (p.eat > 0) {
        pose.position.z += 7 * p.eat
        pose.position.y += 4 * p.eat
        pose.rotation.y -= 30 * p.eat * DEG
      }

      // Spy watch: the left hand rises from below the screen while viewmodel 1 draws
      const vm1 = next.vm1
      if (p.watch >= 0 && vm1) {
        const w = ensureWatch(vm1.weaponDef)
        w.visible = true
        setFromRig(w, [WATCH_ANCHOR[0], WATCH_ANCHOR[1], WATCH_ANCHOR[2] - 16 * (1 - p.watch)])
        w.rotation.set(WATCH_AIM[0] * DEG, (WATCH_AIM[1] + 40 * (1 - p.watch)) * DEG, WATCH_AIM[2] * DEG)
      } else if (watchAnchor) {
        ;(watchAnchor as THREE.Group).visible = false
      }
    },
    dispose() {
      flashMaterial.dispose()
      for (const m of rig.ownMaterials) m.dispose()
      if (watchRig) for (const m of (watchRig as Rig).ownMaterials) m.dispose()
      object.removeFromParent()
    },
  }
  return instance
}

export const placeholderViewmodelProvider: ViewmodelProvider = {
  id: 'placeholder',
  priority: 0,
  supports: () => true,
  create: createPlaceholder,
}

registerViewmodelProvider(placeholderViewmodelProvider)
