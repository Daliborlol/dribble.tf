import React, { useRef, useEffect, useLayoutEffect, useMemo, Suspense, useState } from 'react'

import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { Select } from '@components/Scene/OutlineSelect'
import { useXrayGlow } from '@highlander/players/xrayGlow'
import { Html, useGLTF } from '@react-three/drei'
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js'
import { Vector } from '@components/Analyse/Data/Types'

import { HealBeam } from '@components/Scene/HealBeam'
import { Nameplate } from '@components/Scene/Nameplate'
import { CachedPlayer } from '@components/Analyse/Data/PlayerCache'

import { useInstance, useStore } from '@zus/store'
import { getPovPicks } from '@zus/actions'
import { CLASS_MAP } from '@constants/mappings'
import {
  objCoordsToVector3,
  cameraQuaternionFromSourceAnglesDeg,
  yawQuaternionFromDegrees,
  smoothingAlpha,
  createStaleFrameGuard,
  guardedLerpProgress,
} from '@utils/geometry'
import { getAsset } from '@utils/misc'
import { useEventListener } from '@utils/hooks'

import { registerActor, unregisterActor, getActor } from '@highlander/scene/actorRegistry'
import { useActorFx, type NameplateExtra } from '@highlander/scene/actorFx'
import { getEyeHeight } from '@highlander/scene/eyeHeight'
import { getHlSetting, useExtras, useHlSetting } from '@highlander/extras/hooks'
import { getPovSubject } from '@highlander/pov/subject'
import { PackWeapons } from '@highlander/players/PackWeapon'
import { PackPlayer } from '@highlander/players/PackPlayer'
import { useAssetPack, useAssetPackActive } from '@pack/pack'
import { usePackModel } from '@pack/models'
import { playerModelItem, playerModelKey } from '@pack/playerAnim'
import {
  declutterPlates,
  nameplateExtraEqual,
  registerPlate,
  trackPointer,
  type PlateState,
} from '@highlander/perf/nameplates'

// Every useGLTF(..., true) call shares drei's one DRACOLoader, which initialises from whichever path
// decodes first. Point it at the local copy in public/draco/ so player and projectile models load offline.
useGLTF.setDecoderPath(getAsset('/draco/'))

// Default TF2 player dimensions as specified in:
// https://developer.valvesoftware.com/wiki/TF2/Team_Fortress_2_Mapper%27s_Reference
export const ActorDimensions = new THREE.Vector3(49, 49, 83)


export const AimLineSize = 150
const _cameraWorldPosition = new THREE.Vector3()
const _actorWorldPosition = new THREE.Vector3()
const RENDER_POSITION_SMOOTH_SECONDS = 0.04
const RENDER_ROTATION_SMOOTH_SECONDS = 0.03
const TELEPORT_LERP_DISTANCE = 4096

/**
 * Resolve view angles that may erroneously be all-zero from the parser.
 * Updates lastGoodRef when non-zero angles are found, and falls back
 * to the last known good angles when all components are zero.
 */
function resolveViewAngles(angles: Vector, lastGoodRef: { current: Vector }): Vector {
  if (angles.x === 0 && angles.y === 0 && angles.z === 0) {
    return lastGoodRef.current
  }
  lastGoodRef.current = angles
  return angles
}

//
// ─── PLAYER MODEL ───────────────────────────────────────────────────────────────
//

export interface PlayerModelProps {
  team: string
  classId: number
  visible?: boolean
  opacity?: number
  tint?: string | null
  emissive?: number
  /** Held item def for the pack's third-person weapon (-1 none); without a pack nothing is drawn */
  weaponDef?: number
  /** Loadout defs, comma separated, for the pack's extra wearables */
  loadoutDefs?: string
  /** Entity id and playerBody crouch scale, for the pack's animated player (PackPlayer) */
  entityId?: number
  scaleZ?: number
}

type EmissiveMaterial = THREE.Material & { emissive?: THREE.Color; emissiveIntensity?: number }

/** Deep clone of the shared GLTF scene with its own materials, so per-actor opacity and tint never leak. */
const cloneModel = (source: THREE.Object3D) => {
  let skinned = false
  source.traverse(child => {
    if ((child as THREE.SkinnedMesh).isSkinnedMesh) skinned = true
  })
  const object = skinned ? SkeletonUtils.clone(source) : source.clone(true)

  const materials: THREE.Material[] = []
  object.traverse(child => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh || !mesh.material) return
    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map(material => {
        const copy = material.clone()
        materials.push(copy)
        return copy
      })
    } else {
      mesh.material = mesh.material.clone()
      materials.push(mesh.material)
    }
  })

  return { object, materials }
}

export const PlayerModel = React.memo((props: PlayerModelProps) => {
  const { team, classId, visible, opacity = 1, tint = null, emissive = 0, weaponDef = -1, loadoutDefs = '', entityId = -1, scaleZ = 1 } = props

  // Note: currently RED and BLU models are separate GLTF files.
  // It would be awesome if we could use a single GLTF and swap the material/textures.
  // I tried doing that but dual materials wouldn't export from Blender.
  // The models have been hugely optimized by removing bones/animations and baking the pose,
  // so it's no longer as huge a deal. They're are also cached by the GLTF loader.
  const modelUrl = getAsset(`/models/players/${CLASS_MAP[classId]}_${team}.glb`)
  const gltf = useGLTF(modelUrl, true, false)

  const model = useMemo(() => cloneModel(gltf.scene), [gltf.scene])

  useEffect(() => {
    return () => {
      for (const material of model.materials) material.dispose()
    }
  }, [model])

  useLayoutEffect(() => {
    for (const material of model.materials) {
      const transparent = opacity < 1
      if (material.transparent !== transparent) {
        material.transparent = transparent
        material.needsUpdate = true
      }
      material.opacity = opacity
      material.depthWrite = opacity > 0.5

      const lit = material as EmissiveMaterial
      if (lit.emissive) {
        lit.emissive.set(tint ?? '#000')
        lit.emissiveIntensity = tint ? emissive : 0
      }
    }
  }, [model, opacity, tint, emissive])

  // With a pack (and Highlander on), the animated class model replaces the public GLB once it has loaded
  const packActive = useAssetPackActive()
  const pack = useAssetPack()
  const hlEnabled = useHlSetting<boolean>('enabled')
  const classKey = CLASS_MAP[classId] ?? ''
  const packItem = packActive && hlEnabled && entityId >= 0 ? playerModelItem(pack.manifest?.items, classKey) : null
  const packHandle = usePackModel(packItem ? playerModelKey(classKey) : null)

  // as/shading: team-coloured glow through walls (highlander.players.xrayGlow, key X)
  const glowRoot = useRef<THREE.Group>(null)
  const xrayGlow = useHlSetting<boolean>('players.xrayGlow') === true && hlEnabled
  const glowKey = packHandle && packItem ? 'pack' : 'public'
  useXrayGlow(glowRoot, xrayGlow && entityId >= 0, team, opacity, glowKey)

  if (packHandle && packItem) {
    return (
      <group ref={glowRoot} visible={visible}>
        <Select enabled>
          <PackPlayer
            handle={packHandle}
            item={packItem}
            entityId={entityId}
            classKey={classKey}
            team={team}
            visible={!!visible}
            opacity={opacity}
            tint={tint}
            emissive={emissive}
            weaponDef={weaponDef}
            loadoutDefs={loadoutDefs}
            scaleZ={scaleZ}
          />
        </Select>
      </group>
    )
  }

  return (
    <group ref={glowRoot} visible={visible} rotation={[Math.PI * 0.5, Math.PI * 0.5, 0]}>
      <Select enabled={!!gltf.scene}>
        <primitive object={model.object} />
        <PackWeapons
          classKey={CLASS_MAP[classId] ?? ''}
          team={team}
          weaponDef={weaponDef}
          loadoutDefs={loadoutDefs}
          opacity={opacity}
          tint={tint}
          emissive={emissive}
        />
      </Select>
    </group>
  )
})

// ─── ACTORS ──────────────────────────────────────────────────────────────────

export interface ActorsProps {
  actors: ActorProps[]
  renderTick: number
}

interface FocusMemo {
  /** Entity id of the player the user focused while a stand-in is shown (or parked as the last POV), else null */
  wanted: number | null
  /** The group focused in his place, else null */
  standIn: THREE.Object3D | null
  /** The focused player's index in the latest actor list that held him */
  slot: number
  /** getPovPicks() at the last resolve: a change means the user picked a POV since */
  picks: number
}

const clearStandIn = (memo: FocusMemo) => {
  memo.wanted = null
  memo.standIn = null
}

const resolveFocus = (memo: FocusMemo, actors: ActorProps[]) => {
  const { focusedObject, lastFocusedPOV, setFocusedObject, setLastFocusedPOV } = useInstance.getState()
  const picks = getPovPicks()
  const picked = picks !== memo.picks
  memo.picks = picks
  // A user pick (even of the player shown as the stand-in) replaces the remembered player
  if (picked) clearStandIn(memo)

  if (!focusedObject || focusedObject.name !== 'actor') {
    // RTS or spectator after a stand-in: keep the remembered player, so returning to POV (a resume, not a pick)
    // goes back to him once he is drawn again. lastFocusedPOV itself is not moved: it positions the free cameras.
    if (!(memo.standIn && lastFocusedPOV === memo.standIn)) clearStandIn(memo)
    return
  }
  if (focusedObject !== memo.standIn) clearStandIn(memo)
  const wanted: number = memo.wanted ?? focusedObject.userData?.entityId
  const slot = actors.findIndex(actor => actor.user.entityId === wanted)
  if (slot >= 0) memo.slot = slot

  let next: THREE.Object3D | undefined
  const live = slot >= 0 ? getActor(wanted)?.group : undefined
  if (live?.parent) {
    // The focused player is drawn: focus his current group (a no-op unless he came back or a stand-in is shown)
    next = live
    clearStandIn(memo)
  } else if (!focusedObject.parent && actors.length > 0) {
    // The focused group is detached and the player is absent: the player in his slot stands in for him
    const standIn = actors[Math.min(Math.max(memo.slot, 0), actors.length - 1)]
    next = getActor(standIn.user.entityId)?.group
    if (next?.parent) {
      memo.wanted = wanted
      memo.standIn = next
    } else next = undefined
  }
  if (!next || next === focusedObject) return

  setFocusedObject(next)
  if (lastFocusedPOV === focusedObject) setLastFocusedPOV(next)
}

export const Actors = (props: ActorsProps) => {
  const { actors = [], renderTick } = props
  const gl = useThree(state => state.gl)

  // Nameplate declutter (contract 5 X1): once per frame, before the actors' own callbacks (negative priority),
  // show the 12 plates nearest the camera plus the focused, followed, hovered and pinned ones.
  useEffect(() => trackPointer(gl.domElement), [gl])
  useFrame(state => {
    const enabled = getHlSetting<boolean>('enabled') !== false
    const focusedEntityId = (useInstance.getState().focusedObject?.userData?.entityId as number | undefined) ?? -1
    const subjectEntityId = enabled && focusedEntityId >= 0 ? getPovSubject(renderTick)?.entityId ?? -1 : -1
    const playing = useStore.getState().playback.playing
    declutterPlates(state.camera, state.size.width, state.size.height, { enabled, focusedEntityId, subjectEntityId, playing })
  }, -1)

  // Focus re-resolution. Actors are keyed by entity id, so a player who leaves the drawn list (disconnect,
  // spectator, team switch) and comes back is a new group, and the focus would stay on the detached old one.
  // After each commit (the children's registration effects have run): while the focused player is absent, follow
  // the player who now holds his list slot, as the index-keyed actors at 598e328 did; once he is drawn again,
  // focus his new group. A POV the user picks, even the stand-in's, replaces the remembered player.
  // Subscribed to the focus so the slot is recorded as soon as a player is focused, even while paused.
  useInstance(state => state.focusedObject)
  const focusMemo = useRef<FocusMemo>({ wanted: null, standIn: null, slot: -1, picks: getPovPicks() })
  useEffect(() => {
    resolveFocus(focusMemo.current, actors)
  })

  // Keyed by entity id: when a player disconnects or changes team, the other actors keep their
  // component instance (and the focused POV stays on the same player).
  return (
    <group name="actors">
      {actors.map(actor => (
        <Actor key={`actor-${actor.user.entityId}`} {...actor} renderTick={renderTick} />
      ))}
    </group>
  )
}

//
// ─── ACTOR ──────────────────────────────────────────────────────────────────────
//

export type ActorProps = CachedPlayer & { positionNext: Vector; viewAnglesNext: Vector }

/** Entity id of the actor whose own `povCamera` this is, or undefined for any other camera. */
const povCameraOwnerOf = (camera?: THREE.Object3D): number | undefined => {
  if (camera?.name !== 'povCamera') return undefined
  for (let node: THREE.Object3D | null = camera; node; node = node.parent) {
    if (node.name === 'actor') return node.userData?.entityId
  }
  return undefined
}

export const Actor = (props: ActorProps & { renderTick: number }) => {
  const actorRef = useRef<THREE.Group>(null)
  const bodyRef = useRef<THREE.Group>(null)
  const playerAimRef = useRef<THREE.Group>(null)
  const nameplateRef = useRef<HTMLDivElement>(null)
  const nameplateApplied = useRef<{ element: HTMLDivElement | null; opacity: number }>({ element: null, opacity: 1 })
  const lastGoodViewAngles = useRef<Vector>({ x: 0, y: 0, z: 0 })
  const lerpedPosition = useRef(new THREE.Vector3())
  const hasPositionInit = useRef(false)
  const staleGuard = useRef(createStaleFrameGuard(props.position))
  const [changing, setChanging] = useState<boolean>(false)

  // Only the playing flag (as/perf): selecting the whole playback object re-rendered every actor in a commit of its
  // own on each tick, before DemoViewer's render re-rendered them all again with the new tick's props
  const playing = useStore(state => state.playback.playing)
  const settings = useStore(state => state.settings)
  const controlsMode = useStore(state => state.scene.controls.mode)
  const focusedObject = useInstance(state => state.focusedObject)
  const povCameraOverride = useInstance(state => state.povCameraOverride)
  const extras = useExtras()
  const hlEnabled = useHlSetting<boolean>('enabled')
  const povViewmodel = useHlSetting<boolean>('pov.viewmodel')
  const nameplateFadeDistance = useHlSetting<number>('players.nameplateFadeDistance')

  const { classId, health, team, user, healTarget, renderTick } = props
  const fx = useActorFx(user.entityId, renderTick, classId, team)
  // DEFAULT_ACTOR_FX leaves the model class and team at 0 and '', which mean the actor's base class and team
  const modelClassId = fx.modelClassId || classId
  const modelTeam = fx.modelTeam || team

  // True when Controls renders from this actor's own povCamera: in POV mode the focused actor, or, while
  // a POV camera override is set, the actor that owns the override (a chase or death camera owns none).
  const isFocusedPOV =
    controlsMode === 'pov' &&
    !!focusedObject &&
    (povCameraOverride
      ? povCameraOwnerOf(povCameraOverride) === user.entityId
      : focusedObject.userData?.entityId === user.entityId)
  let { position, viewAngles, positionNext, viewAnglesNext } = props

  // Resolve zero-valued view angles (parser bug) by falling back to last non-zero angles
  viewAngles = resolveViewAngles(viewAngles, lastGoodViewAngles)
  if (viewAnglesNext.x === 0 && viewAnglesNext.y === 0 && viewAnglesNext.z === 0) {
    viewAnglesNext = viewAngles
  }

  const alive = health > 0
  let color
  if (team === 'red') color = '#ff0202'
  if (team === 'blue') color = '#0374ff'

  // Source QAngle convention (degrees): x=pitch, y=yaw, z=roll
  const positionVec3: THREE.Vector3 = objCoordsToVector3(position)
  const positionNextVec3: THREE.Vector3 = objCoordsToVector3(positionNext)
  const pitchDeg = viewAngles.x
  const yawDeg = viewAngles.y
  const rollDeg = viewAngles.z
  const pitchNextDeg = viewAnglesNext.x
  const yawNextDeg = viewAnglesNext.y
  const rollNextDeg = viewAnglesNext.z

  const healTargetVec3: THREE.Vector3 | undefined = healTarget
    ? getActor(healTarget)?.group.position
    : undefined
  // F4 draws the POV medic beam once the extras are ready
  const showHealBeam = !!healTargetVec3 && !(hlEnabled && isFocusedPOV && povViewmodel && !!extras)

  // Register the scene handles by entity id (contract section 6.4)
  useEffect(() => {
    if (!actorRef.current || !bodyRef.current || !playerAimRef.current) return
    const handles = {
      entityId: user.entityId,
      group: actorRef.current,
      body: bodyRef.current,
      aim: playerAimRef.current,
    }
    registerActor(handles)
    return () => unregisterActor(handles)
  }, [user.entityId])

  // Nameplate declutter (X1): the Actors pass reads this every frame; it is the state of the latest render. A plate
  // at opacity 0 shows nothing (F1: an enemy spy cloaked in the POV player's view, pinned because he is cloaked), so
  // it counts as not drawn: it takes none of the cap's slots and cannot be hovered.
  const showPlate = settings.ui.nameplate.enabled && !isFocusedPOV
  const plateOpacity = fx.nameplate?.opacity ?? 1
  const plateState = useRef<PlateState>({ drawn: false, pinned: false })
  plateState.current = { drawn: showPlate && alive && plateOpacity > 0, pinned: !!fx.nameplate?.pinned }
  useEffect(() => {
    if (!actorRef.current) return
    return registerPlate(user.entityId, actorRef.current, nameplateRef, plateState)
  }, [user.entityId])

  // Nameplate distance fade: 1 up to the fade distance, linear to 0 at twice that (0 disables it)
  const fadeDistance = hlEnabled && !fx.nameplate?.pinned ? nameplateFadeDistance || 0 : 0
  useFrame(({ camera }) => {
    const element = nameplateRef.current
    if (!element || !actorRef.current) return

    let opacity = plateOpacity
    if (fadeDistance > 0) {
      _cameraWorldPosition.setFromMatrixPosition(camera.matrixWorld)
      const distance = _cameraWorldPosition.distanceTo(actorRef.current.getWorldPosition(_actorWorldPosition))
      opacity *= THREE.MathUtils.clamp(2 - distance / fadeDistance, 0, 1)
    }
    // Touch the DOM only when the value or the element changed; opacity 1 leaves the plate untouched
    const applied = nameplateApplied.current
    if (applied.element !== element || applied.opacity !== opacity) {
      applied.element = element
      applied.opacity = opacity
      if (opacity === 1) element.style.removeProperty('opacity')
      else element.style.opacity = String(opacity)
    }
  })

  useFrame((_, delta) => {
    if (!actorRef.current || !bodyRef.current || !playerAimRef.current) return

    // Actor group is position-only; rotations are applied to children.
    actorRef.current.quaternion.identity()

    const frameProgress = useInstance.getState().frameProgress

    // Skip interpolation when disabled or paused
    if (settings.scene.interpolateFrames === false || playing === false) {
      actorRef.current.position.set(position.x, position.y, position.z)
      hasPositionInit.current = true
      bodyRef.current.quaternion.copy(yawQuaternionFromDegrees(yawDeg))
      playerAimRef.current.position.set(0, 0, getEyeHeight(user.entityId, classId, renderTick))
      playerAimRef.current.quaternion.copy(
        cameraQuaternionFromSourceAnglesDeg({ pitch: pitchDeg, yaw: yawDeg, roll: rollDeg })
      )
      guardedLerpProgress(staleGuard.current, frameProgress, position, false)
      return
    }

    playerAimRef.current.position.set(0, 0, getEyeHeight(user.entityId, classId, renderTick))

    const lerpProgress = guardedLerpProgress(
      staleGuard.current, frameProgress, position, playing
    )
    const didTeleport = positionVec3.distanceTo(positionNextVec3) > TELEPORT_LERP_DISTANCE
    const wasInitialized = hasPositionInit.current
    const positionBlend = smoothingAlpha(delta, RENDER_POSITION_SMOOTH_SECONDS)
    const rotationBlend = smoothingAlpha(delta, RENDER_ROTATION_SMOOTH_SECONDS)

    // Position interpolation
    if (didTeleport) {
      lerpedPosition.current.copy(positionVec3)
    } else {
      lerpedPosition.current.copy(positionVec3).lerp(positionNextVec3, lerpProgress)
    }

    if (didTeleport || !wasInitialized) {
      actorRef.current.position.copy(lerpedPosition.current)
    } else {
      actorRef.current.position.lerp(lerpedPosition.current, positionBlend)
    }
    hasPositionInit.current = true

    // Body: yaw-only quaternion
    const bodyTarget = yawQuaternionFromDegrees(yawDeg)
      .clone()
      .slerp(yawQuaternionFromDegrees(yawNextDeg), lerpProgress)
    if (didTeleport || !wasInitialized) {
      bodyRef.current.quaternion.copy(bodyTarget)
    } else {
      bodyRef.current.quaternion.slerp(bodyTarget, rotationBlend)
    }

    // Aim/camera: full view angles
    const camTarget = cameraQuaternionFromSourceAnglesDeg({
      pitch: pitchDeg,
      yaw: yawDeg,
      roll: rollDeg,
    })
      .clone()
      .slerp(
        cameraQuaternionFromSourceAnglesDeg({
          pitch: pitchNextDeg,
          yaw: yawNextDeg,
          roll: rollNextDeg,
        }),
        lerpProgress
      )
    if (didTeleport || !wasInitialized) {
      playerAimRef.current.quaternion.copy(camTarget)
    } else {
      playerAimRef.current.quaternion.slerp(camTarget, rotationBlend)
    }
  })

  // Kinda hacky solution to fix player models not updating when they change class,
  // which is due to how PlayerModel handles caching of loaded GLTF models. So this
  // solution relies of quickly remounting the PlayerModel with the updated team/classId
  // values. It doesn't appear to trigger any network refetches, so this should be ok
  useEffect(() => {
    setChanging(true)
    const timer = setTimeout(() => setChanging(false), 10)
    return () => clearTimeout(timer)
  }, [modelTeam, modelClassId])

  return (
    <group name="actor" ref={actorRef} userData={user}>
      {/* Player model */}

      <group name="playerBody" ref={bodyRef} scale={[1, 1, fx.scaleZ]}>
        <Suspense fallback={null}>
          {modelTeam && modelClassId && !changing ? (
            <PlayerModel
              visible={alive && !isFocusedPOV && !fx.hidden}
              team={modelTeam}
              classId={modelClassId}
              opacity={fx.opacity}
              tint={fx.tint}
              emissive={fx.emissive}
              weaponDef={fx.weaponDef}
              loadoutDefs={fx.loadoutDefs}
              entityId={user.entityId}
              scaleZ={fx.scaleZ}
            />
          ) : null}
        </Suspense>
      </group>

      {/* Player aim */}

      <group
        ref={playerAimRef}
        name="playerAim"
        position={[0, 0, getEyeHeight(user.entityId, classId, renderTick)]}
      >
        {/* Aim line (debugging) */}
        {/* <mesh visible={alive} position={[AimLineSize * 0.5, 0, 0]}>
          <boxGeometry attach="geometry" args={[AimLineSize, 5, 5]} />
          <meshBasicMaterial attach="material" color={color} opacity={0.5} transparent />
        </mesh> */}

        <POVCamera />
      </group>

      {/* Medic heal beam */}

      {showHealBeam && healTargetVec3 && (
        <HealBeam origin={positionVec3} target={healTargetVec3} color={color} />
      )}

      {/* Nameplate */}

      {showPlate && (
        <ActorNameplate
          plateRef={nameplateRef}
          z={ActorDimensions.z * 0.85 * fx.scaleZ}
          alive={alive}
          name={user.name}
          team={team}
          health={health}
          classId={classId}
          plateEnabled={settings.ui.nameplate.enabled}
          showName={settings.ui.nameplate.showName}
          showHealth={settings.ui.nameplate.showHealth}
          showClass={settings.ui.nameplate.showClass}
          extra={fx.nameplate ?? undefined}
        />
      )}
    </group>
  )
}

// ─── NAMEPLATE ──────────────────────────────────────────────────────────────────

const PLATE_STYLE: React.CSSProperties = { bottom: 0, transform: 'translateX(-50%)', textAlign: 'center' }

interface ActorNameplateProps {
  plateRef: React.RefObject<HTMLDivElement>
  z: number
  alive: boolean
  name: string
  team: string
  health: number
  classId: number
  // settings.ui.nameplate as primitives: the settings reducer mutates that object in place
  plateEnabled: boolean
  showName: boolean
  showHealth: boolean
  showClass: boolean
  extra?: NameplateExtra
}

const actorNameplateEqual = (a: ActorNameplateProps, b: ActorNameplateProps) =>
  a.plateRef === b.plateRef &&
  a.z === b.z &&
  a.alive === b.alive &&
  a.name === b.name &&
  a.team === b.team &&
  a.health === b.health &&
  a.classId === b.classId &&
  a.plateEnabled === b.plateEnabled &&
  a.showName === b.showName &&
  a.showHealth === b.showHealth &&
  a.showClass === b.showClass &&
  nameplateExtraEqual(a.extra, b.extra)

/**
 * The actor's drei Html nameplate (X1). drei's Html re-renders its own React root on every render, and the actor
 * renders on every tick; memoized by value (the nameplate extra included), the plate re-renders only when what it
 * shows changes. Opacity (distance fade, cloak) and the declutter's display toggle are written to its DOM node by
 * the frame callbacks, outside React.
 */
const ActorNameplate = React.memo((props: ActorNameplateProps) => {
  const { plateRef, z, alive, name, team, health, classId, plateEnabled, showName, showHealth, showClass, extra } = props
  const settings = useMemo(
    () => ({ enabled: plateEnabled, showName, showHealth, showClass }),
    [plateEnabled, showName, showHealth, showClass]
  )
  const position = useMemo(() => [0, 0, z] as [number, number, number], [z])
  return (
    <Html ref={plateRef} name="html" className="pointer-events-none select-none" style={PLATE_STYLE} position={position}>
      {alive && <Nameplate name={name} team={team} health={health} classId={classId} settings={settings} extra={extra} />}
    </Html>
  )
}, actorNameplateEqual)

export interface POVCameraProps {}

// Memoized (as/perf): it has no props and reads the settings itself, so the actor's per-tick render no longer
// re-renders it (r3f applied no prop then anyway, as the values were unchanged)
export const POVCamera = React.memo(({}: POVCameraProps) => {
  const ref = useRef<THREE.PerspectiveCamera>(null)

  const settings = useStore(state => state.settings)

  const updateCamera = () => {
    if (!ref.current) return
    ref.current.aspect = window.innerWidth / window.innerHeight
    ref.current.updateProjectionMatrix()
  }

  useEffect(updateCamera, [settings])
  useEventListener('resize', updateCamera, window)

  return (
    <perspectiveCamera
      name="povCamera"
      ref={ref}
      {...settings?.camera}
      position={[0, 0, 0]}
      rotation={[0, 0, 0]}
    />
  )
})
