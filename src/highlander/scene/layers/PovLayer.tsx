// POV subject cameras (contract section 5 F4, PovLayer): applies the POV subject of D16 every frame.
//
// - Camera. 'own' and 'stay' render from the focused actor's povCamera (no override). 'spectated' sets the override to
//   the spectated actor's povCamera. 'chase' and 'deathcam' use two cameras owned by this layer (named
//   hlChaseCamera and hlDeathCamera, never under an actor group, contract A4), so no actor hides and the chased
//   subject stays visible. The override is set only when the camera object changes, and cleared when the kind goes
//   back to 'own' or 'stay', when the controls leave POV, and on unmount.
// - FOV (pov.tf2Fov): TF2's horizontal FOV at 4:3 with the networked zoom (fovAt), as three.js vertical FOV. Near
//   plane 1 on the active POV camera. Both restored on a camera when it stops being the active POV camera.
// - POV medic beam from the viewmodel muzzle (or from just below the eye without a viewmodel) to the heal target.
//
// Everything placed here is a function of the tick and of the interpolated actors, so a seek matches playback (D12).

import React, { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'

import { HealBeam } from '@components/Scene/HealBeam'
import { cameraQuaternionFromSourceAnglesDeg } from '@utils/geometry'
import { useInstance, useStore } from '@zus/store'
import { HEAL_BEAM_OFFSET } from '@highlander/constants'
import { registerHlProbe } from '@highlander/debug'
import { HL } from '@highlander/extras/enums'
import { flagsAt, fovAt, medigunAt, verticalFov } from '@highlander/extras/getters'
import { getHlSetting, useExtras, useHlSetting } from '@highlander/extras/hooks'
import type { HighlanderExtras } from '@highlander/extras/types'
import { entityIdOfPlayer, getPovSubject, usePovSubject, type PovSubject } from '@highlander/pov/subject'
import { allActors, getActor, useActorRegistryVersion } from '@highlander/scene/actorRegistry'
import { getEyeHeight } from '@highlander/scene/eyeHeight'
import { vmShared } from '@highlander/scene/viewmodel/shared'

const CHASE_BACK = 150
const CHASE_UP = 20
const DEATHCAM_LOOK_UP = 41
const POV_NEAR = 1
const BEAM_FALLBACK_DOWN = 12
const BEAM_FALLBACK_FORWARD = 20

/** The r3f default camera of the last frame (probes cannot reach the r3f store). */
let lastActiveCamera: THREE.Camera | null = null

const _eye = new THREE.Vector3()
const _forward = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _target = new THREE.Vector3()

/** Source horizontal FOV (4:3) the subject's camera shows at tickF, or null when POV FOV is not TF2's. */
export function povSourceFov(x: HighlanderExtras | undefined, subject: PovSubject, tickF: number): number {
  if ((subject.camera === 'own' || subject.camera === 'spectated') && x && x.meta.available.fov && subject.p >= 0) {
    return fovAt(x, subject.p, tickF, 90)
  }
  return 90
}

/** Places the chase camera behind and above the subject's eye, looking along his view. */
function placeChase(camera: THREE.PerspectiveCamera, subject: PovSubject): boolean {
  const aim = getActor(subject.entityId)?.aim
  if (!aim) return false
  aim.updateWorldMatrix(true, false)
  aim.getWorldPosition(_eye)
  aim.getWorldQuaternion(_quat)
  _forward.set(0, 0, -1).applyQuaternion(_quat)
  camera.position.copy(_eye).addScaledVector(_forward, -CHASE_BACK)
  camera.position.z += CHASE_UP
  camera.quaternion.copy(_quat)
  camera.updateMatrixWorld()
  return true
}

/** Holds the death camera at the focused player's eye one tick before his death, looking at the killer. */
function placeDeathcam(camera: THREE.PerspectiveCamera, subject: PovSubject, tick: number): boolean {
  const demo = useInstance.getState().parsedDemo
  if (!demo || subject.focusedP < 0) return false
  const at = Math.max(0, Math.min(demo.ticks - 1, (subject.deathTick ?? tick + 1) - 1))
  const pos = demo.playerCache.positionCache.getPosition(subject.focusedP, at)
  const classId = demo.playerCache.metaCache.getMeta(subject.focusedP, at).classId
  camera.position.set(pos.x, pos.y, pos.z + getEyeHeight(subject.focusedEntityId, classId, at))
  const killer = subject.killerEntityId !== undefined ? getActor(subject.killerEntityId) : undefined
  if (killer) {
    _target.copy(killer.group.position)
    _target.z += DEATHCAM_LOOK_UP
    camera.lookAt(_target)
  } else {
    const angles = demo.playerCache.viewAnglesCache.getAngles(subject.focusedP, at)
    camera.quaternion.copy(cameraQuaternionFromSourceAnglesDeg({ pitch: angles.x, yaw: angles.y, roll: angles.z }))
  }
  camera.updateMatrixWorld()
  return true
}

const makeCamera = (name: string) => {
  const camera = new THREE.PerspectiveCamera(verticalFov(90), 16 / 9, POV_NEAR, 15000)
  camera.name = name
  camera.up.set(0, 0, 1)
  return camera
}

export const PovLayer = React.memo(({ renderTick }: { renderTick: number }) => {
  const extras = useExtras()
  const subject = usePovSubject(renderTick)
  const controlsMode = useStore(s => s.scene.controls.mode)
  const focusedObject = useInstance(s => s.focusedObject)
  const tf2Fov = useHlSetting<boolean>('pov.tf2Fov')
  const viewmodelOn = useHlSetting<boolean>('pov.viewmodel')
  const settingsFov = useStore(s => s.settings.camera.fov)
  const settingsNear = useStore(s => s.settings.camera.near)
  const settingsFar = useStore(s => s.settings.camera.far)
  const registryVersion = useActorRegistryVersion()
  const { size } = useThree()

  const chaseCamera = useMemo(() => makeCamera('hlChaseCamera'), [])
  const deathCamera = useMemo(() => makeCamera('hlDeathCamera'), [])

  const povActive = controlsMode === 'pov' && !!focusedObject && !!subject
  const kind = povActive ? subject!.camera : null

  // Camera override: set only when the camera object changes (setPovCameraOverride ignores unchanged values)
  useEffect(() => {
    const setOverride = useInstance.getState().setPovCameraOverride
    if (!povActive || !subject) return setOverride(undefined)
    if (kind === 'spectated') {
      const camera = getActor(subject.entityId)?.aim.getObjectByName('povCamera')
      setOverride(camera as THREE.Camera | undefined)
    } else if (kind === 'chase') {
      if (placeChase(chaseCamera, subject)) setOverride(chaseCamera)
      else setOverride(undefined)
    } else if (kind === 'deathcam') {
      placeDeathcam(deathCamera, subject, renderTick)
      setOverride(deathCamera)
    } else {
      setOverride(undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [povActive, kind, subject?.entityId, registryVersion])

  useEffect(() => () => useInstance.getState().setPovCameraOverride(undefined), [])

  // The camera whose fov and near this layer changed, with the values to restore
  const applied = useRef<THREE.PerspectiveCamera | null>(null)
  const restore = (camera: THREE.PerspectiveCamera | null) => {
    if (!camera) return
    camera.fov = settingsFov
    camera.near = settingsNear
    camera.updateProjectionMatrix()
  }
  useEffect(
    () => () => {
      restore(applied.current)
      applied.current = null
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  // POV medic beam (only while the base beam is hidden: pov.viewmodel on and extras ready, S0's Actors rule)
  const beamTargetEntity = useMemo(() => {
    if (!povActive || !subject || !extras || !viewmodelOn || !extras.meta.available.medigun) return -1
    if (subject.camera !== 'own' && subject.camera !== 'spectated') return -1
    const medigun = medigunAt(extras, subject.p, renderTick)
    if (!medigun || !medigun.healing || medigun.target === 255) return -1
    const demo = useInstance.getState().parsedDemo
    return demo ? entityIdOfPlayer(demo, medigun.target) : -1
  }, [povActive, subject, extras, viewmodelOn, renderTick])
  const beamTarget = useMemo(() => new THREE.Vector3(), [])
  const beamTeam = useMemo(() => {
    const demo = useInstance.getState().parsedDemo
    if (!demo || !subject || subject.p < 0) return 'red'
    return demo.playerCache.metaCache.getMeta(subject.p, renderTick).teamId === 3 ? 'blue' : 'red'
  }, [subject, renderTick])
  const showBeam = beamTargetEntity > 0 && !!getActor(beamTargetEntity)

  useFrame(state => {
    const active = state.camera as THREE.PerspectiveCamera
    lastActiveCamera = active
    if (!povActive || !subject || !(active as any).isPerspectiveCamera) {
      if (applied.current) {
        restore(applied.current)
        applied.current = null
      }
      return
    }
    const tickF = renderTick + useInstance.getState().frameProgress

    if (subject.camera === 'chase') placeChase(chaseCamera, subject)
    else if (subject.camera === 'deathcam') placeDeathcam(deathCamera, subject, renderTick)

    // Our own cameras follow the canvas size; actor povCameras handle resize themselves
    for (const own of [chaseCamera, deathCamera]) {
      const aspect = size.width / Math.max(1, size.height)
      if (Math.abs(own.aspect - aspect) > 1e-4 || own.far !== settingsFar) {
        own.aspect = aspect
        own.far = settingsFar
        own.updateProjectionMatrix()
      }
    }

    if (applied.current && applied.current !== active) restore(applied.current)
    applied.current = active
    const fov = tf2Fov ? verticalFov(povSourceFov(extras, subject, tickF)) : settingsFov
    if (Math.abs(active.fov - fov) > 0.01 || active.near !== POV_NEAR) {
      active.fov = fov
      active.near = POV_NEAR
      active.updateProjectionMatrix()
    }

    if (showBeam) {
      const target = getActor(beamTargetEntity)
      if (target) beamTarget.copy(target.group.position)
      // Fallback origin below and in front of the eye; ViewmodelLayer overwrites it from the muzzle after its update
      const origin = vmShared.beamOrigin
      active.updateWorldMatrix(true, false)
      active.getWorldPosition(origin)
      active.getWorldQuaternion(_quat)
      _forward.set(0, 0, -1).applyQuaternion(_quat)
      origin.addScaledVector(_forward, BEAM_FALLBACK_FORWARD)
      origin.z -= BEAM_FALLBACK_DOWN + HEAL_BEAM_OFFSET
    }
  })

  if (!showBeam) return null
  return (
    <group name="hlPovBeam">
      <HealBeam origin={vmShared.beamOrigin} target={beamTarget} color={beamTeam === 'blue' ? '#0374ff' : '#ff0202'} />
    </group>
  )
})

// Probe: the POV subject and camera values at a cache tick (default: the current renderTick).
registerHlProbe('pov.state', (tick?: number) => {
  const at = Math.floor(tick ?? Math.max(1, useStore.getState().playback.tick - 2))
  const subject = getPovSubject(at)
  const { extras, extrasStatus, povCameraOverride, parsedDemo } = useInstance.getState()
  const x = extrasStatus === 'ready' ? extras : undefined
  const camera = lastActiveCamera as THREE.PerspectiveCamera | null
  const cameraWorld = camera ? camera.getWorldPosition(new THREE.Vector3()) : null
  if (!subject || !parsedDemo) {
    return { subject: null, override: povCameraOverride?.name ?? null }
  }
  const fovH = povSourceFov(x, subject, at)
  const tf2 = !!getHlSetting<boolean>('pov.tf2Fov')
  const classId = subject.p >= 0 ? parsedDemo.playerCache.metaCache.getMeta(subject.p, at).classId : 0
  const r = (v: number) => Math.round(v * 1000) / 1000
  let overrideOwner: number | null = null
  for (let n: THREE.Object3D | null = povCameraOverride ?? null; n; n = n.parent) {
    if (n.name === 'actor') {
      overrideOwner = n.userData?.entityId ?? null
      break
    }
  }
  return {
    focusedEntityId: subject.focusedEntityId,
    entityId: subject.entityId,
    camera: subject.camera,
    killerEntityId: subject.killerEntityId ?? null,
    deathTick: subject.deathTick ?? null,
    fovH: r(fovH),
    fovV: r(tf2 ? verticalFov(fovH) : useStore.getState().settings.camera.fov),
    eyeZ: getEyeHeight(subject.entityId, classId, at),
    near: camera ? camera.near : null,
    cameraFov: camera ? r(camera.fov) : null,
    cameraName: camera?.name ?? null,
    zoomed: x && subject.p >= 0 ? (flagsAt(x, subject.p, at) & HL.ZOOMED) !== 0 : false,
    override: povCameraOverride?.name ?? null,
    overrideOwner,
    cameraPosition: cameraWorld ? [r(cameraWorld.x), r(cameraWorld.y), r(cameraWorld.z)] : null,
  }
})

// Probe: distance from a player's eye (his povCamera; default: the active camera) to the map along his view and
// 20 degrees below it, where the viewmodel sits. Used to find moments where a POV player hugs a wall (the viewmodel
// depth-clear check). With entityId 'all', every registered actor.
const _ray = new THREE.Raycaster()
function wallDistances(camera: THREE.Object3D, world: THREE.Object3D): { ahead: number | null; low: number | null } {
  camera.updateWorldMatrix(true, false)
  const origin = camera.getWorldPosition(new THREE.Vector3())
  const q = camera.getWorldQuaternion(new THREE.Quaternion())
  const out = { ahead: null as number | null, low: null as number | null }
  for (const [name, down] of [['ahead', 0], ['low', 20]] as const) {
    const dir = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(1, 0, 0), (-down * Math.PI) / 180).applyQuaternion(q)
    _ray.set(origin, dir)
    _ray.far = 400
    const hit = _ray.intersectObject(world, true)[0]
    out[name] = hit ? Math.round(hit.distance) : null
  }
  return out
}
registerHlProbe('pov.wallDistance', (entityId?: number | 'all') => {
  const world = useInstance.getState().threeScene?.getObjectByName('world')
  if (!world) return null
  if (entityId === 'all') {
    return Array.from(allActors()).map(a => {
      const camera = a.aim.getObjectByName('povCamera')
      return { entityId: a.entityId, ...(camera ? wallDistances(camera, world) : { ahead: null, low: null }) }
    })
  }
  const camera = entityId !== undefined ? getActor(entityId)?.aim.getObjectByName('povCamera') : lastActiveCamera
  return camera ? wallDistances(camera, world) : null
})
