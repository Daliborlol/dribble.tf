// Debug-bridge probes for the map pipeline (contract section 3.10), registered when World.tsx loads:
//   window.__dribble.hl.probe('map.status')        load state, brush-entity node counts, fog, key light
//   window.__dribble.hl.probe('map.nodes', filter?) brush-entity nodes (filter: substring of the node name)
//   window.__dribble.hl.probe('map.meta', map?)     Promise of a map-meta summary (default: the scene map)

import * as THREE from 'three'

import { registerHlProbe } from '@highlander/debug'
import { fetchMapMeta } from '@highlander/map/mapMeta'
import { getMapNodeInfo } from '@highlander/map/mapNodes'
import { getMapFolder } from '@utils/mapAssets'
import { getState, useInstance } from '@zus/store'

const round = (value: number) => Math.round(value * 100) / 100

registerHlProbe('map.status', () => {
  const instance = useInstance.getState()
  const nodes = instance.mapNodes
  const world = instance.threeScene?.getObjectByName('world')
  let meshes = 0
  let visibleMeshes = 0
  const materials = new Set<string>()
  world?.traverse(node => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    meshes += 1
    let visible = true
    for (
      let parent: THREE.Object3D | null = mesh;
      parent && parent !== world;
      parent = parent.parent
    ) {
      if (!parent.visible) visible = false
    }
    if (visible) visibleMeshes += 1
    const material = mesh.material as THREE.Material
    if (material?.name) materials.add(material.name)
  })
  const fog = instance.threeScene?.fog as THREE.Fog | null | undefined
  const lights = instance.threeScene?.getObjectByName('lights')
  const keyLight = lights?.children.find(
    child => (child as THREE.DirectionalLight).isDirectionalLight
  )
  return {
    map: getState().scene.map,
    folder: getMapFolder(getState().scene.map) ?? null,
    status: instance.mapStatus,
    meshes,
    visibleMeshes,
    materials: [...materials].sort(),
    mapNodes: nodes?.size ?? null,
    hiddenMapNodes: nodes ? [...nodes.values()].filter(node => !node.visible).length : null,
    fog: fog ? { near: fog.near, far: fog.far, color: `#${fog.color.getHexString()}` } : null,
    keyLight: keyLight ? keyLight.position.toArray().map(round) : null,
    worldPosition: world ? world.position.toArray().map(round) : null,
  }
})

registerHlProbe('map.nodes', (filter?: string) => {
  const nodes = useInstance.getState().mapNodes
  if (!nodes) return []
  return [...nodes.entries()]
    .filter(([, node]) => !filter || node.name.toLowerCase().includes(String(filter).toLowerCase()))
    .map(([bspModelIndex, node]) => {
      const info = getMapNodeInfo(node)
      return {
        bspModelIndex,
        name: node.name,
        classname: info?.classname ?? null,
        targetname: info?.targetname ?? null,
        visible: node.visible,
        hasGeometry: info?.hasGeometry ?? null,
        initiallyVisible: info?.initiallyVisible !== false,
        renderMode: info?.renderMode ?? 0,
      }
    })
})

registerHlProbe('map.meta', (map?: string) =>
  fetchMapMeta(map ?? getState().scene.map).then(meta =>
    meta
      ? {
          map: meta.map,
          gameMode: meta.gameMode,
          camera: meta.camera,
          worldBounds: meta.worldBounds,
          cartBspModel: meta.payload[0]?.cart?.brush?.bspModelIndex ?? null,
          counts: {
            spawns: meta.spawns.length,
            controlPoints: meta.controlPoints.length,
            captureAreas: meta.captureAreas.length,
            payload: meta.payload.length,
            doors: meta.doors.length,
            respawnRooms: meta.respawnRooms.length,
            resupply: meta.resupply.length,
            items: meta.items.length,
          },
          sunDirection: meta.light?.environment?.direction ?? null,
        }
      : null
  )
)
