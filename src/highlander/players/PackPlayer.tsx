// Animated pack players (as/tpanim): with a pack, PlayerModel draws the class's `models/player/<class>.mdl` item
// (scripts/assets/models/players.mjs) in place of the public GLB, posed every frame by src/assetpack/playerAnim.ts
// from players/animState.ts, with the held weapon and the loadout's extra wearables bone-merged onto the animated
// skeleton: every copy node named like a player bone takes that bone's matrix each frame, as TF2's bone merge does.
//
// Mounted by PlayerModel inside the playerBody group, so it shares the body's visibility (death, own POV, a fully
// cloaked spy), the outline and the drawn class and team (the disguise while drawn as one); it takes the body's
// opacity, tint and emissive. The crouch scale is undone, because the crouch sequences lower the body themselves.
// The particle anchors (combat/weaponAnchors.ts) are measured once per weapon copy in the slot's stand pose at
// cycle 0 and pitch 0, so they stay constants of the model and the effects stay pure functions of the tick (D12).
//
// PlayerModel uses this only while the pack is ready, Highlander and assets.models are on and the class item has
// loaded; otherwise, and without a pack, it draws the public GLB and PackWeapons exactly as before (D21).

import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'

import { useInstance } from '@zus/store'
import { copyCharacterShading } from '@pack/characterShading'
import { packTeamSkin, usePackModel } from '@pack/models'
import type { PackModelHandle } from '@pack/models'
import { followsWeapon, registerThirdPersonCopy, thirdPersonModels } from '@pack/thirdPerson'
import { applyPlayerPose, copyBones, createPlayerPose, evaluatePlayerPose, playerRig, playerSlot as playerSlotOf } from '@pack/playerAnim'
import type { PlayerAnimInput, PlayerModelItem, PlayerPose, PlayerRigData } from '@pack/playerAnim'
import { measureThirdPersonAnchor, setThirdPersonAnchor } from '@highlander/combat/weaponAnchors'
import { frameTime, readyExtras } from '@highlander/combat/time'
import { registerHlProbe } from '@highlander/debug'
import { getActor } from '@highlander/scene/actorRegistry'
import { createAnimInput, playerAnimInput } from './animState'

export interface PackPlayerProps {
  handle: PackModelHandle
  item: PlayerModelItem
  entityId: number
  /** CLASS_MAP name of the drawn model */
  classKey: string
  /** drawn team, 'red' | 'blue' */
  team: string
  visible: boolean
  opacity: number
  tint: string | null
  emissive: number
  weaponDef: number
  loadoutDefs: string
  /** the playerBody crouch scale, undone here */
  scaleZ: number
}

type EmissiveMaterial = THREE.Material & { emissive?: THREE.Color; emissiveIntensity?: number }

/** Per-copy material clones, so one player's cloak or tint never reaches another's copy. */
function ownMaterials(root: THREE.Object3D): THREE.Material[] {
  const clones = new Map<THREE.Material, THREE.Material>()
  root.traverse(node => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    // the pose changes every frame: the bind-pose bounds would cull a crouching or jumping player wrongly
    mesh.frustumCulled = false
    const swap = (m: THREE.Material) => {
      let c = clones.get(m)
      if (!c) {
        c = m.clone()
        copyCharacterShading(m, c)
        c.userData.packOpaque = !m.transparent
        clones.set(m, c)
      }
      return c
    }
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material)
  })
  return Array.from(clones.values())
}

function applyLook(materials: THREE.Material[], opacity: number, tint: string | null, emissive: number) {
  for (const material of materials) {
    const transparent = opacity < 1 || !material.userData.packOpaque
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
}

/**
 * Hides every bone subtree that holds nothing drawable (as/perf). A player copy carries 80 to 140 bones and
 * attachment nodes; three's render list walks every visible node each frame, while invisible nodes keep their
 * matrices up to date (updateMatrixWorld ignores visibility), so the skeletons skin exactly as before. Nothing
 * is attached to these copies' bones at run time.
 */
function hideBoneSubtrees(root: THREE.Object3D) {
  const drawable = (node: THREE.Object3D) => {
    let found = false
    node.traverse(n => {
      const o = n as THREE.Mesh & { isPoints?: boolean; isLine?: boolean; isSprite?: boolean; isCamera?: boolean; isLight?: boolean }
      if (o.isMesh || o.isPoints || o.isLine || o.isSprite || o.isCamera || o.isLight) found = true
    })
    return found
  }
  const walk = (node: THREE.Object3D) => {
    for (const child of node.children) {
      if ((child as THREE.Bone).isBone && !drawable(child)) child.visible = false
      else walk(child)
    }
  }
  walk(root)
}

/** Bounds of a skinned copy in its current pose (measureThirdPersonAnchor reads them). */
function boundSkinnedMeshes(copy: THREE.Object3D) {
  copy.updateMatrixWorld(true)
  copy.traverse(node => {
    const mesh = node as THREE.SkinnedMesh
    if (!mesh.isSkinnedMesh) return
    mesh.skeleton.update()
    mesh.computeBoundingBox()
  })
}

interface Merger {
  merge(): void
}

interface BodyContext {
  rig: PlayerRigData
  copy: THREE.Object3D
  bones: (THREE.Object3D | null)[]
  /** lower-case bone name -> player bone */
  byName: Map<string, THREE.Object3D>
  mergers: Set<Merger>
  pose: PlayerPose
  /** poses the body in `def`'s slot stand pose at cycle 0, pitch 0 (anchor measurement) */
  neutral(def: number): void
  /** the held weapon's measured muzzle (probe) */
  anchor: { copy: THREE.Object3D; def: number; neutral: number[] | null } | null
}

// ---- merged pieces ------------------------------------------------------------------------------------------

interface PieceProps {
  body: BodyContext
  modelKey: string
  classKey: string
  team: string
  kind: 'weapon' | 'wearable' | 'loadout'
  bodyOnly: boolean
  anchorDef?: number
  opacity: number
  tint: string | null
  emissive: number
}

const _inv = new THREE.Matrix4()

const MergedPiece = React.memo((props: PieceProps) => {
  const { body, modelKey, team, bodyOnly, opacity, tint, emissive, classKey, kind, anchorDef } = props
  const handle = usePackModel(modelKey)

  const piece = useMemo(() => {
    if (!handle) return null
    const copy = handle.instantiate(packTeamSkin(handle.info, team === 'blue' ? 3 : 2))
    if (bodyOnly && followsWeapon(copy)) {
      handle.release(copy)
      return null
    }
    // merged nodes (named like a player bone), parents first. A node whose parent follows the player bone's parent
    // copies that bone's local transform; the others (the top of each merged chain) solve for the bone's world
    // matrix. The player copy and the piece share one parent group, so both chains start in the same frame.
    const list: { node: THREE.Object3D; target: THREE.Object3D; local: boolean }[] = []
    const targetOf = new Map<THREE.Object3D, THREE.Object3D>()
    copy.traverse(node => {
      if (node === copy) return
      const target = body.byName.get(node.name.toLowerCase())
      if (!target) return
      targetOf.set(node, target)
      const local = !!node.parent && targetOf.get(node.parent) === target.parent
      list.push({ node, target, local })
    })
    const merged = list.length
    if (merged === 0) {
      handle.release(copy)
      return null
    }
    const materials = ownMaterials(copy)
    hideBoneSubtrees(copy)
    let meshes = 0
    copy.traverse(node => {
      if ((node as THREE.Mesh).isMesh && node.visible) meshes++
    })
    const merger: Merger = {
      merge() {
        for (const { node, target, local } of list) {
          if (local) {
            node.position.copy(target.position)
            node.quaternion.copy(target.quaternion)
            node.scale.copy(target.scale)
            continue
          }
          node.parent!.updateWorldMatrix(true, false)
          target.updateWorldMatrix(true, false)
          node.matrix.multiplyMatrices(_inv.copy(node.parent!.matrixWorld).invert(), target.matrixWorld)
          node.matrix.decompose(node.position, node.quaternion, node.scale)
        }
      },
    }
    return { handle, copy, materials, merged, meshes, merger }
  }, [handle, team, bodyOnly, body])

  useLayoutEffect(() => {
    if (!piece) return
    body.mergers.add(piece.merger)
    const unregister = registerThirdPersonCopy({ modelKey, classKey, team, kind, merged: piece.merged, meshes: piece.meshes, copy: piece.copy })
    // the held weapon's muzzle and bounds for the pack particle effects, in the neutral pose
    let measured: ReturnType<typeof measureThirdPersonAnchor> = null
    if (anchorDef !== undefined) {
      body.neutral(anchorDef)
      piece.merger.merge()
      boundSkinnedMeshes(piece.copy)
      measured = measureThirdPersonAnchor(piece.copy, anchorDef)
      if (measured) setThirdPersonAnchor(measured.entityId, measured.anchor)
      body.anchor = { copy: piece.copy, def: anchorDef, neutral: measured?.anchor.muzzle?.toArray().map(v => +v.toFixed(1)) ?? null }
    }
    return () => {
      if (measured) setThirdPersonAnchor(measured.entityId, null, measured.anchor)
      if (body.anchor?.copy === piece.copy) body.anchor = null
      body.mergers.delete(piece.merger)
      unregister()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [piece])

  useEffect(() => {
    if (!piece) return
    return () => {
      piece.copy.removeFromParent()
      for (const m of piece.materials) m.dispose()
      piece.handle.release(piece.copy)
    }
  }, [piece])

  useLayoutEffect(() => {
    if (piece) applyLook(piece.materials, opacity, tint, emissive)
  }, [piece, opacity, tint, emissive])

  return piece ? <primitive object={piece.copy} /> : null
})

// ---- the player ---------------------------------------------------------------------------------------------

interface MountedPlayer {
  entityId: number
  classKey: string
  input: PlayerAnimInput
  body: BodyContext
  drawn: () => boolean
  /** out of view (as/perf culling): the bones keep the pose of the last frame in view */
  culled: () => boolean
  /** evaluates the input and pose of the current frame without posing the bones (the probe, for culled players) */
  refresh: () => void
}

const mountedPlayers = new Set<MountedPlayer>()

function poseDigest(pose: PlayerPose): number {
  let h = 0
  for (let i = 0; i < pose.t.length; i++) h = (h + Math.round(pose.t[i] * 1000) * (i + 1)) % 1000000007
  for (let i = 0; i < pose.r.length; i++) h = (h + Math.round(pose.r[i] * 100000) * (i + 7)) % 1000000007
  return h
}
let probeRegistered = false

function registerProbe() {
  if (probeRegistered) return
  probeRegistered = true
  // Probe: every mounted pack player with its animation input of the last drawn frame
  registerHlProbe('players.anim', () =>
    Array.from(mountedPlayers)
      .sort((a, b) => a.entityId - b.entityId)
      .map(m => {
        // a culled player's input and pose are those of the current frame too, as when he is drawn
        const culled = m.culled()
        if (culled) m.refresh()
        const pelvis = m.body.bones[0]
        return {
          entityId: m.entityId,
          classKey: m.classKey,
          drawn: m.drawn(),
          culled,
          slot: m.input.slot,
          deployed: m.input.deployed,
          crouch: +m.input.crouch.toFixed(3),
          move: +m.input.move.toFixed(3),
          air: +m.input.air.toFixed(3),
          moveX: +m.input.moveX.toFixed(3),
          moveY: +m.input.moveY.toFixed(3),
          distance: +m.input.distance.toFixed(1),
          pitch: +m.input.pitch.toFixed(1),
          gesture: m.input.gesture ? { crouch: m.input.gesture.crouch, t: +m.input.gesture.t.toFixed(3) } : null,
          merged: m.body.mergers.size,
          muzzle: m.body.anchor
            ? { def: m.body.anchor.def, neutral: m.body.anchor.neutral, now: measureThirdPersonAnchor(m.body.anchor.copy, m.body.anchor.def)?.anchor.muzzle?.toArray().map(v => +v.toFixed(1)) ?? null }
            : null,
          // a hash of the bone-local pose of the last drawn frame (determinism checks)
          digest: poseDigest(m.body.pose),
          pelvis: pelvis ? [pelvis.position.x, pelvis.position.y, pelvis.position.z].map(v => +v.toFixed(2)) : null,
        }
      })
  )
}

const _frame = { tick: 0, tickF: 0 }

// ---- view culling (as/perf) ---------------------------------------------------------------------------------
// The pack meshes are not frustum culled by three (frustumCulled false: the bind-pose bounds do not hold the pose),
// so every player was posed, skinned and drawn every frame, on screen or not. A player whose bounding sphere (128
// units around his centre, which holds every pose with the weapon) is outside the view frustum now skips the pose
// and draws nothing. The frame callback decides with the camera it sees; the final check runs right before the
// render with the camera of that render (scene.onBeforeRender, after three's matrix update): a player that turns
// out to be in view is posed there, at the same tickF, so what is drawn never depends on the order of the frame
// callbacks. The pose is a pure function of tickF, so culling changes nothing that is drawn (D12).

const CULL_RADIUS = 128
const CULL_LIFT = 41
const _frustum = new THREE.Frustum()
const _viewProj = new THREE.Matrix4()
const _sphere = new THREE.Sphere()

function inView(camera: THREE.Camera, center: THREE.Vector3): boolean {
  _viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  _frustum.setFromProjectionMatrix(_viewProj)
  _sphere.center.copy(center)
  _sphere.radius = CULL_RADIUS
  return _frustum.intersectsSphere(_sphere)
}

interface CullEntry {
  /** before the render: hide when out of view, pose now when posing was skipped but the player is in view */
  check(camera: THREE.Camera): void
}
const cullEntries = new Set<CullEntry>()
const hookedScenes = new WeakSet<THREE.Scene>()

function hookScene(scene: THREE.Scene) {
  if (hookedScenes.has(scene)) return
  hookedScenes.add(scene)
  const previous = scene.onBeforeRender
  // three calls a scene's onBeforeRender as (renderer, scene, camera, renderTarget)
  scene.onBeforeRender = function (this: THREE.Scene, ...args: unknown[]) {
    ;(previous as (...a: unknown[]) => void).apply(this, args)
    const camera = args[2] as THREE.Camera
    for (const entry of cullEntries) entry.check(camera)
  } as THREE.Scene['onBeforeRender']
}
const _center = new THREE.Vector3()

export const PackPlayer = React.memo((props: PackPlayerProps) => {
  const { handle, item, entityId, classKey, team, visible, opacity, tint, emissive, weaponDef, loadoutDefs, scaleZ } = props
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const defRef = useRef(weaponDef)
  defRef.current = weaponDef

  const body = useMemo<BodyContext & { materials: THREE.Material[]; input: PlayerAnimInput }>(() => {
    const rig = playerRig(handle, item)
    const copy = handle.instantiate(packTeamSkin(item, team === 'blue' ? 3 : 2))
    const materials = ownMaterials(copy)
    hideBoneSubtrees(copy)
    const bones = copyBones(copy, rig.bones)
    // bones are posed through position and quaternion only: drop the quaternion -> Euler sync three runs on every
    // write (nothing reads a bone's `rotation`)
    for (const b of bones) if (b) (b.quaternion as unknown as { _onChange(cb: () => void): void })._onChange(() => {})
    const byName = new Map<string, THREE.Object3D>()
    bones.forEach(b => b && byName.set(b.name.toLowerCase(), b))
    const pose = createPlayerPose(rig)
    const input = createAnimInput()
    const ctx = {
      rig, copy, bones, byName, mergers: new Set<Merger>(), pose, materials, input, anchor: null as BodyContext['anchor'],
      neutral(def: number) {
        const n = createAnimInput()
        n.slot = playerSlotOf(item, def)
        evaluatePlayerPose(rig, n, pose)
        applyPlayerPose(bones, pose)
        copy.updateMatrixWorld(true)
      },
    }
    return ctx
  }, [handle, item, team])

  useEffect(() => {
    registerProbe()
    const row: MountedPlayer = {
      entityId,
      classKey,
      input: body.input,
      body,
      drawn: () => visibleRef.current,
      culled: () => visibleRef.current && groupRef.current?.visible === false,
      refresh: () => {
        evaluate(frameTime(_frame).tickF)
      },
    }
    mountedPlayers.add(row)
    return () => {
      mountedPlayers.delete(row)
      body.copy.removeFromParent()
      for (const m of body.materials) m.dispose()
      handle.release(body.copy)
    }
  }, [body, handle, entityId, classKey])

  useLayoutEffect(() => {
    applyLook(body.materials, opacity, tint, emissive)
  }, [body, opacity, tint, emissive])

  const groupRef = useRef<THREE.Group>(null)
  const scene = useThree(state => state.scene)
  // the tickF of this frame while the frame callback skipped the pose (out of view), else null
  // drawnOnce: a copy is drawn at least once before it may be culled, so its materials get their programs while
  // it mounts (as without culling), not in the frame it first comes into view
  const posed = useRef<{ deferred: number | null; drawnOnce: boolean }>({ deferred: null, drawnOnce: false })

  const evaluate = (tickF: number): boolean => {
    const demo = useInstance.getState().parsedDemo
    if (!demo) return false
    const p = demo.playerIndexOfEntity(entityId)
    if (p < 0) return false
    playerAnimInput({ demo, extras: readyExtras(), p, tickF, item, weaponDef: defRef.current }, body.input)
    evaluatePlayerPose(body.rig, body.input, body.pose)
    return true
  }

  const pose = (tickF: number): boolean => {
    if (!evaluate(tickF)) return false
    applyPlayerPose(body.bones, body.pose)
    for (const m of body.mergers) m.merge()
    return true
  }

  const setDrawn = (group: THREE.Group, drawn: boolean) => {
    group.visible = drawn
    // hidden: three's scene update skips the copy's bones too
    group.matrixWorldAutoUpdate = drawn
  }

  useEffect(() => {
    hookScene(scene)
    posed.current.drawnOnce = false
    const entry: CullEntry = {
      check(camera) {
        const group = groupRef.current
        if (!group || !visibleRef.current) return
        const actor = getActor(entityId)?.group
        if (!actor) return
        _center.setFromMatrixPosition(actor.matrixWorld)
        _center.z += CULL_LIFT
        const seen = inView(camera, _center) || !posed.current.drawnOnce
        if (seen && group.visible) posed.current.drawnOnce = true
        if (!seen) {
          if (group.visible) setDrawn(group, false)
          return
        }
        if (posed.current.deferred !== null) {
          // skipped by the frame callback, but in view of this render: pose it now, at the same tickF
          const tickF = posed.current.deferred
          posed.current.deferred = null
          pose(tickF)
          setDrawn(group, true)
          group.updateMatrixWorld(true)
        } else if (!group.visible) {
          setDrawn(group, true)
          group.updateMatrixWorld(true)
        }
      },
    }
    cullEntries.add(entry)
    return () => {
      cullEntries.delete(entry)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, body, entityId])

  useFrame(({ camera }) => {
    posed.current.deferred = null
    if (!visibleRef.current) return
    const { tickF } = frameTime(_frame)
    const group = groupRef.current
    const actor = getActor(entityId)?.group
    if (group && actor) {
      _center.copy(actor.position)
      _center.z += CULL_LIFT
      if (posed.current.drawnOnce && !inView(camera, _center)) {
        posed.current.deferred = tickF
        if (group.visible) setDrawn(group, false)
        return
      }
    }
    pose(tickF)
  })

  const held = thirdPersonModels(classKey, weaponDef)
  const wearables = useMemo(() => {
    const out = new Set<string>()
    for (const d of loadoutDefs ? loadoutDefs.split(',') : []) {
      const def = Number(d)
      if (def === weaponDef) continue
      const w = thirdPersonModels(classKey, def).wearable
      if (w) out.add(w)
    }
    if (held.wearable) out.delete(held.wearable)
    return Array.from(out).sort()
  }, [classKey, loadoutDefs, weaponDef, held.wearable])

  const look = { classKey, team, opacity, tint, emissive, body }
  return (
    <group ref={groupRef} name="packPlayer" scale={[1, 1, 1 / (scaleZ || 1)]}>
      <primitive object={body.copy} />
      {held.weapon && <MergedPiece key={`w:${held.weapon}`} modelKey={held.weapon} kind="weapon" bodyOnly={false} anchorDef={weaponDef} {...look} />}
      {held.wearable && <MergedPiece key={`e:${held.wearable}`} modelKey={held.wearable} kind="wearable" bodyOnly={false} {...look} />}
      {wearables.map(key => (
        <MergedPiece key={`l:${key}`} modelKey={key} kind="loadout" bodyOnly {...look} />
      ))}
    </group>
  )
})

