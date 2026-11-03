// The 3D skybox of a pack world (as/mapfx). Asset pack only: World mounts this component only for a world loaded
// from the pack, so the public worlds keep their 3D skybox hidden (asset contract D21).
//
// Source draws the 3D skybox first, from a second eye at sky_camera.origin + eye / scale, then clears the depth
// buffer and draws the map over it. Here the skybox geometry stays at skybox size and moves every frame so that
// the main camera sees it as that second eye would: a skybox point p is drawn at p + T with
// T = eye x (1 - 1 / scale) - sky_camera.origin (in the world group's glTF frame). The directions from the eye
// equal Source's, the distances stay small enough for the camera's far plane, and a depth clear after the
// skybox (an empty mesh at SKY_ORDER + 1) lets the map draw over it. Skybox meshes draw at SKY_ORDER, before
// every other opaque object; their translucent materials draw as cutouts, because the transparent pass comes
// after the map. Nothing in the skybox catches raycasts.

import { useEffect, useMemo, useRef } from 'react'

import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'

import { StaticProps } from '@highlander/map/StaticProps'
import type { MapRenderMode } from '@highlander/map/bspMaterials'

/** Render order of the skybox meshes; the depth clear follows at SKY_ORDER + 1. */
export const SKY_ORDER = -1_000_000

const NO_RAYCAST = () => {}

/** `userData.dribble` of the world.glb skybox_3d node (scripts/convert-bsp.mjs). */
interface SkyNodeInfo {
  kind: 'skybox3d'
  skyCameraOrigin: number[]
  scale: number
}

export function findSkyboxNode(root: THREE.Object3D | null): THREE.Object3D | null {
  let found: THREE.Object3D | null = null
  root?.traverse(node => {
    if (!found && node.userData?.dribble?.kind === 'skybox3d') found = node
  })
  return found
}

/**
 * Sky meshes draw before the map at SKY_ORDER. A translucent material becomes a cutout copy (owned here), because
 * the transparent pass runs after the map and would test against the map's depth. Returns the copies to dispose.
 */
export function prepareSkyMeshes(root: THREE.Object3D, owned?: Map<THREE.Material, THREE.Material>): THREE.Material[] {
  const copies: THREE.Material[] = []
  root.traverse(node => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    mesh.renderOrder = SKY_ORDER
    mesh.raycast = NO_RAYCAST
    const swap = (material: THREE.Material): THREE.Material => {
      if (!material.transparent) return material
      if (!owned) {
        // Materials this caller owns (sky props): changed in place.
        material.transparent = false
        material.depthWrite = true
        material.alphaTest = Math.max(material.alphaTest, 0.5)
        material.needsUpdate = true
        return material
      }
      let copy = owned.get(material)
      if (!copy) {
        copy = material.clone()
        copy.onBeforeCompile = material.onBeforeCompile
        copy.customProgramCacheKey = material.customProgramCacheKey
        copy.transparent = false
        copy.depthWrite = true
        copy.polygonOffset = material.polygonOffset
        copy.alphaTest = Math.max(material.alphaTest, 0.5)
        owned.set(material, copy)
        copies.push(copy)
      }
      return copy
    }
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material)
  })
  return copies
}

const clearGeometry = new THREE.BufferGeometry()
clearGeometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3))
const clearMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false })

export interface Skybox3DProps {
  /** The loaded pack world (gltf.scene, identity transform inside World's group). */
  root: THREE.Object3D
  /** The pack's props-sky.glb, or null. */
  props: { url: string; key: string } | null
  mode: MapRenderMode
}

export const Skybox3D = ({ root, props, mode }: Skybox3DProps) => {
  const camera = useThree(state => state.camera)
  const skyNode = useMemo(() => findSkyboxNode(root), [root])
  const info = skyNode?.userData?.dribble as SkyNodeInfo | undefined
  const propsGroupRef = useRef<THREE.Group>(null)
  const clearRef = useRef<THREE.Mesh>(null)

  // Shown while mounted; World's initial visibility hides it again with the next world.
  useEffect(() => {
    if (!skyNode) return
    const owned = new Map<THREE.Material, THREE.Material>()
    const originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>()
    skyNode.traverse(node => {
      const mesh = node as THREE.Mesh
      if (mesh.isMesh) originals.set(mesh, mesh.material)
    })
    const copies = prepareSkyMeshes(skyNode, owned)
    const savedMatrix = skyNode.matrix.clone()
    skyNode.visible = true
    return () => {
      skyNode.visible = false
      originals.forEach((material, mesh) => {
        mesh.material = material
      })
      copies.forEach(material => material.dispose())
      skyNode.matrix.copy(savedMatrix)
      skyNode.matrixWorldNeedsUpdate = true
    }
  }, [skyNode])

  useEffect(() => {
    const mesh = clearRef.current
    if (!mesh) return
    mesh.onBeforeRender = renderer => {
      renderer.state.buffers.depth.setMask(true) // glClear(DEPTH_BUFFER_BIT) obeys the depth mask
      renderer.clearDepth()
    }
  })

  const eye = useRef(new THREE.Vector3())
  const offset = useRef(new THREE.Vector3())
  useFrame(() => {
    if (!skyNode || !info || !skyNode.parent) return
    const scale = Number(info.scale) > 0 ? Number(info.scale) : 16
    const [cx, cy, cz] = info.skyCameraOrigin ?? [0, 0, 0]
    // The camera in the frame of the sky node's parent (the GLB root inside the world group).
    camera.getWorldPosition(eye.current)
    skyNode.parent.worldToLocal(eye.current)
    offset.current.copy(eye.current).multiplyScalar(1 - 1 / scale)
    offset.current.x -= cx
    offset.current.y -= cz // glTF = (x, z, -y) of Source
    offset.current.z += cy
    skyNode.matrix.makeTranslation(offset.current.x, offset.current.y, offset.current.z)
    skyNode.matrixWorldNeedsUpdate = true
    // The props group sits beside the GLB root, whose transform is the identity: the same frame.
    propsGroupRef.current?.position.copy(offset.current)
  })

  if (!skyNode || !info) return null
  return (
    <>
      <mesh
        ref={clearRef}
        geometry={clearGeometry}
        material={clearMaterial}
        renderOrder={SKY_ORDER + 1}
        frustumCulled={false}
        raycast={NO_RAYCAST}
      />
      {props ? (
        <group ref={propsGroupRef} name="skybox_3d_props">
          <StaticProps
            key={props.key}
            source="sky"
            url={props.url}
            itemKey={props.key}
            mode={mode}
            onPrepared={prepareSkyProps}
          />
        </group>
      ) : null}
    </>
  )
}

const prepareSkyProps = (root: THREE.Object3D) => {
  prepareSkyMeshes(root)
}
