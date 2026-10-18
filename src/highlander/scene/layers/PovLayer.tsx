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
import { povFovAt } from '@highlander/pov/fov'
import { entityIdOfPlayer, getPovSubject, usePovSubject, type PovSubject } from '@highlander/pov/subject'
import { allActors, getActor, useActorRegistryVersion } from '@highlander/scene/actorRegistry'
import { getEyeHeight } from '@highlander/scene/eyeHeight'
import { vmShared } from '@highlander/scene/viewmodel/shared'
import { installOwnMuzzleSource } from '@highlander/integration/ownMuzzle'

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

/**
 * Source horizontal FOV (4:3) the subject's camera shows at tickF: the networked zoom for his own and spectated
 * eyes (povFovAt: fovAt with the transition on the server timeline), 90 for the chase and death cameras.
 */
export function povSourceFov(x: HighlanderExtras | undefined, subject: PovSubject, tickF: number): number {
  if ((subject.camera === 'own' || subject.camera === 'spectated') && x && x.meta.available.fov && subject.p >= 0) {
    return povFovAt(x, subject.p, tickF, 90)
  }
  return 90
}

// ─── map raycasts (wall probes only: one ray costs 3.6 to 10.6 ms on the HL maps) ──

const _ray = new THREE.Raycaster()

/**
 * The map's `world` group, looked up per call (only the slow wall probes use it). Not cached in a module variable:
 * World replaces the group on map and mode changes, and a cached group would keep the previous map's GLB alive
 * (X1 memory audit, contract 12.3).
 */
function mapWorld(): THREE.Object3D | null {
  return useInstance.getState().threeScene?.getObjectByName('world') ?? null
}

/** Raycaster ignores `visible`; hidden map nodes (render-mode-10 brushes, the 3D skybox) must not block. */
function drawnUnder(object: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let n: THREE.Object3D | null = object; n; n = n.parent) {
    if (!n.visible) return false
    if (n === root) return true
  }
  return true
}

/** Distance from `origin` along the unit `dir` to the first drawn map surface within `far`, or null. */
function mapHitDistance(origin: THREE.Vector3, dir: THREE.Vector3, far: number): number | null {
  const world = mapWorld()
  if (!world) return null
  _ray.set(origin, dir)
  _ray.near = 0
  _ray.far = far
  for (const hit of _ray.intersectObject(world, true)) if (drawnUnder(hit.object, world)) return hit.distance
  return null
}

/**
 * Places the chase camera behind and above the subject's eye, looking along his view. There is no wall collision
 * (contract): the map hides the chased player in about a fifth of the ticks (18 % on koth_product, 24 % on pl_vigil,
 * measured with the 'pov.wallScan' probe in 'chase' mode), but a three.js raycast against those maps costs 3.6 to
 * 10.6 ms, too much for every frame without an acceleration structure.
 */
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

/**
 * Holds the death camera at the dead player's eye one tick before his death, looking at the killer: the focused
 * player for his own death camera, the spectated teammate for the teammate-death camera (contract 12.2 item 1,
 * `deathOfEntityId`; the subject's entityId and p are that teammate then).
 */
function placeDeathcam(camera: THREE.PerspectiveCamera, subject: PovSubject, tick: number): boolean {
  const demo = useInstance.getState().parsedDemo
  if (!demo || subject.p < 0) return false
  const at = Math.max(0, Math.min(demo.ticks - 1, (subject.deathTick ?? tick + 1) - 1))
  const pos = demo.playerCache.positionCache.getPosition(subject.p, at)
  const classId = demo.playerCache.metaCache.getMeta(subject.p, at).classId
  camera.position.set(pos.x, pos.y, pos.z + getEyeHeight(subject.entityId, classId, at))
  const killer = subject.killerEntityId !== undefined ? getActor(subject.killerEntityId) : undefined
  if (killer) {
    _target.copy(killer.group.position)
    _target.z += DEATHCAM_LOOK_UP
    camera.lookAt(_target)
  } else {
    const angles = demo.playerCache.viewAnglesCache.getAngles(subject.p, at)
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

  useEffect(
    () => () => {
      useInstance.getState().setPovCameraOverride(undefined)
      lastActiveCamera = null // X1 memory audit: do not hold the last camera (and its actor subtree) after unmount
    },
    []
  )

  // X1: the POV subject's own hitscan tracers (F3) start at his drawn viewmodel muzzle (F4) while this layer lives
  useEffect(() => installOwnMuzzleSource(), [])

  // The camera whose fov and near this layer changed. Restoring reads the settings at that moment, so the unmount
  // cleanup (created on mount) does not bring back the values of the first render.
  const applied = useRef<THREE.PerspectiveCamera | null>(null)
  const restore = (camera: THREE.PerspectiveCamera | null) => {
    if (!camera) return
    const { fov, near } = useStore.getState().settings.camera
    camera.fov = fov
    camera.near = near
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
    deathOfEntityId: subject.deathOfEntityId ?? null,
    fovH: r(fovH),
    fovV: r(tf2 ? verticalFov(fovH) : useStore.getState().settings.camera.fov),
    // the contract getter (zoom spline from m_flFOVTime, in the player's tickbase time), for comparison
    fovHNetworked: x && subject.p >= 0 && (subject.camera === 'own' || subject.camera === 'spectated') ? r(fovAt(x, subject.p, at, 90)) : null,
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
function wallDistances(camera: THREE.Object3D): { ahead: number | null; low: number | null } {
  camera.updateWorldMatrix(true, false)
  const origin = camera.getWorldPosition(new THREE.Vector3())
  const q = camera.getWorldQuaternion(new THREE.Quaternion())
  const out = { ahead: null as number | null, low: null as number | null }
  for (const [name, down] of [['ahead', 0], ['low', 20]] as const) {
    const dir = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(1, 0, 0), (-down * Math.PI) / 180).applyQuaternion(q)
    const hit = mapHitDistance(origin, dir, 400)
    out[name] = hit === null ? null : Math.round(hit)
  }
  return out
}
registerHlProbe('pov.wallDistance', (entityId?: number | 'all') => {
  if (!mapWorld()) return null
  if (entityId === 'all') {
    return Array.from(allActors()).map(a => {
      const camera = a.aim.getObjectByName('povCamera')
      return { entityId: a.entityId, ...(camera ? wallDistances(camera) : { ahead: null, low: null }) }
    })
  }
  const camera = entityId !== undefined ? getActor(entityId)?.aim.getObjectByName('povCamera') : lastActiveCamera
  return camera ? wallDistances(camera) : null
})

// Probe: ticks in [from, to) where player p's eye is within `maxDist` of the map straight ahead, from the base
// position, view angles and eye height alone (no seeking), with whether he heals. Finds natural "viewmodel against a
// wall" moments for the depth-clear check. Mode 'chase' instead casts from the eye to the chase camera spot (150 back,
// 20 up) and reports the ticks where the map is in between. Mode 'vm' casts toward where the viewmodel sits (forward 20,
// right 9, down 9), only on ticks where p heals, and keeps the hits whose view straight ahead is open for 300 units:
// the viewmodel would clip into a wall at the side while the heal beam and the world ahead stay on screen.
registerHlProbe('pov.wallScan', (p: number, from: number, to: number, step = 10, maxDist = 40, mode: 'ahead' | 'chase' | 'vm' = 'ahead') => {
  const { parsedDemo: demo, extras, extrasStatus } = useInstance.getState()
  if (!demo || !mapWorld()) return null
  const x = extrasStatus === 'ready' ? extras : undefined
  const entityId = entityIdOfPlayer(demo, p)
  const origin = new THREE.Vector3()
  const dir = new THREE.Vector3()
  const right = new THREE.Vector3()
  const up = new THREE.Vector3()
  const out: { t: number; dist: number; healing: boolean | null }[] = []
  let samples = 0
  const started = performance.now() // probe timing only, not effect logic
  for (let t = Math.max(1, from); t < Math.min(to, demo.ticks); t += step) {
    if (!((demo.playerCache.healthCache.get(p, t) || 0) > 0)) continue
    const healing = x ? !!medigunAt(x, p, t)?.healing : null
    if (mode === 'vm' && !healing) continue
    const pos = demo.playerCache.positionCache.getPosition(p, t)
    const ang = demo.playerCache.viewAnglesCache.getAngles(p, t)
    const classId = demo.playerCache.metaCache.getMeta(p, t).classId
    origin.set(pos.x, pos.y, pos.z + getEyeHeight(entityId, classId, t))
    const pitch = (ang.x * Math.PI) / 180, yaw = (ang.y * Math.PI) / 180
    // Appendix B.4: forward, right and up of Source view angles
    dir.set(Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), -Math.sin(pitch))
    let far = maxDist
    if (mode === 'chase') {
      dir.multiplyScalar(-CHASE_BACK).setZ(dir.z + CHASE_UP)
      far = dir.length()
      dir.multiplyScalar(1 / far)
    } else if (mode === 'vm') {
      samples++
      if (mapHitDistance(origin, dir, 300) !== null) continue // the view ahead must be open
      right.set(Math.sin(yaw), -Math.cos(yaw), 0)
      up.set(Math.sin(pitch) * Math.cos(yaw), Math.sin(pitch) * Math.sin(yaw), Math.cos(pitch))
      dir.multiplyScalar(20).addScaledVector(right, 9).addScaledVector(up, -9).normalize()
    }
    samples++
    const hit = mapHitDistance(origin, dir, far)
    if (hit !== null) out.push({ t, dist: Math.round(hit), healing })
  }
  return { ms: Math.round(performance.now() - started), samples, hits: out }
})
