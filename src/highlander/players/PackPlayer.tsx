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
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

import { useInstance } from '@zus/store'
import { packTeamSkin, usePackModel } from '@pack/models'
import type { PackModelHandle } from '@pack/models'
import { followsWeapon, registerThirdPersonCopy, thirdPersonModels } from '@pack/thirdPerson'
import { applyPlayerPose, copyBones, createPlayerPose, evaluatePlayerPose, playerRig, playerSlot as playerSlotOf } from '@pack/playerAnim'
import type { PlayerAnimInput, PlayerModelItem, PlayerPose, PlayerRigData } from '@pack/playerAnim'
import { measureThirdPersonAnchor, setThirdPersonAnchor } from '@highlander/combat/weaponAnchors'
import { frameTime, readyExtras } from '@highlander/combat/time'
import { registerHlProbe } from '@highlander/debug'
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
        const pelvis = m.body.bones[0]
        return {
          entityId: m.entityId,
          classKey: m.classKey,
          drawn: m.drawn(),
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
    const row: MountedPlayer = { entityId, classKey, input: body.input, body, drawn: () => visibleRef.current }
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

  useFrame(() => {
    if (!visibleRef.current) return
    const demo = useInstance.getState().parsedDemo
    if (!demo) return
    const p = demo.playerIndexOfEntity(entityId)
    if (p < 0) return
    const { tickF } = frameTime(_frame)
    playerAnimInput({ demo, extras: readyExtras(), p, tickF, item, weaponDef: defRef.current }, body.input)
    evaluatePlayerPose(body.rig, body.input, body.pose)
    applyPlayerPose(body.bones, body.pose)
    for (const m of body.mergers) m.merge()
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
    <group name="packPlayer" scale={[1, 1, 1 / (scaleZ || 1)]}>
      <primitive object={body.copy} />
      {held.weapon && <MergedPiece key={`w:${held.weapon}`} modelKey={held.weapon} kind="weapon" bodyOnly={false} anchorDef={weaponDef} {...look} />}
      {held.wearable && <MergedPiece key={`e:${held.wearable}`} modelKey={held.wearable} kind="wearable" bodyOnly={false} {...look} />}
      {wearables.map(key => (
        <MergedPiece key={`l:${key}`} modelKey={key} kind="loadout" bodyOnly {...look} />
      ))}
    </group>
  )
})

