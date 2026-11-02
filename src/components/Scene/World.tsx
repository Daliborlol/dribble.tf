import { useRef, useState, useEffect, useSyncExternalStore } from 'react'

import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { GLTF, GLTFLoader } from 'three/examples/jsm/Addons.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'

import { ActorDimensions } from '@components/Scene/Actors'

import mapChunkingConfig from '@constants/mapChunking.json'
import { MapVisibilityMetadata } from '@constants/types'
import { addDownloadAction, updateDownloadAction } from '@zus/actions'
import { getState, useInstance, useStore } from '@zus/store'
import { getMapVisibilityUrl } from '@utils/game'
import {
  MapConversion,
  fetchMapConversion,
  getMapFileUrl,
  getMapFolder,
  getMapModelUrl,
  publicMapIdentity,
} from '@utils/mapAssets'
import { useHlSetting } from '@highlander/extras/hooks'
import {
  BspMaterialInfo,
  BspMaterials,
  MAP_WIREFRAME_MATERIAL,
  applyBspMaterials,
  isSharedMapMaterial,
} from '@highlander/map/bspMaterials'
import { collectMapNodes } from '@highlander/map/mapNodes'
import '@highlander/map/probes'
import { StaticProps, usePackPakProps, useStockProps } from '@highlander/map/StaticProps'
import { getAssetSetting } from '@pack/hooks'
import { getAssetItem, loadPackItem, subscribeAssetItems } from '@pack/items'
import { loadPackGltf, warmUpObject } from '@pack/loaders'
import { assetPackFile, getAssetPackState, isAssetPackSettled, resolveAssetPack } from '@pack/pack'
import { acquirePackTexture, releasePackTexture, setPackWorldInfo } from '@pack/textures'

const INVISIBLE_TOOL_MATERIALS = new Set([
  'toolsnodraw',
  'toolsclip',
  'toolsplayerclip',
  'toolsinvisible',
  'toolsinvisibleladder',
  'toolstrigger',
  'toolsareaportal',
  'toolsblockbullets',
  'toolshint',
  'toolsskip',
  'toolsfog',
  'toolsskybox',
])

// Entity prefixes that are game-logic helpers and should never be rendered.
// These may appear in older GLB files that were exported before the VMF filter
// was updated to strip them.
const INVISIBLE_NODE_PREFIXES = ['team_control_point']

function isInvisibleToolMaterial(materialName: string): boolean {
  const name = materialName.toLowerCase()
  const baseName = name.includes('/') ? name.split('/').pop()! : name
  return INVISIBLE_TOOL_MATERIALS.has(baseName)
}

function isInvisibleEntityNode(nodeName: string): boolean {
  const name = nodeName.toLowerCase()
  return INVISIBLE_NODE_PREFIXES.some(prefix => name.startsWith(prefix))
}

const MAP_UNTEXTURED_MATERIAL = new THREE.MeshStandardMaterial({
  color: 'white',
})

const MAP_CHUNKING_ENABLED = mapChunkingConfig.enabled

type MapPipeline = 'bsp-to-glb' | 'textured'

interface LoadedMap {
  root: THREE.Group
  pipeline: MapPipeline
  folder: string
  conversion: MapConversion | null
  lightmap: THREE.Texture | null
  /** A textured world from the asset pack (asset contract 12.5): its materials, made before it was shown. */
  pack?: { materials: BspMaterials; textureKeys: string[]; released: boolean }
}

export interface WorldProps {
  map: string
  mode?: 'textured' | 'untextured' | 'wireframe'
}

export const World = (props: WorldProps) => {
  const ref = useRef<THREE.Group>(null)
  const cameraWorldPositionRef = useRef(new THREE.Vector3())
  const chunkRootsByNameRef = useRef<Map<string, THREE.Object3D>>(new Map())
  const visibilityCullingEnabledRef = useRef(false)
  const currentClusterRef = useRef<number | null>(null)
  const mapLoadRequestIdRef = useRef(0)
  const visibilityRequestIdRef = useRef(0)
  const bspMaterialsRef = useRef<BspMaterials | null>(null)
  const [loadedMap, setLoadedMap] = useState<LoadedMap | null>(null)
  const [mapOverlay, setMapOverlay] = useState<THREE.Group | null>()
  const [mapVisibility, setMapVisibility] = useState<MapVisibilityMetadata | null>(null)
  const { map, mode } = props
  const mapModel = loadedMap?.root ?? null
  const scene = useThree(state => state.scene)
  const gl = useThree(state => state.gl)
  const camera = useThree(state => state.camera)

  const bounds = useStore(state => state.scene.bounds)
  const brightness = useHlSetting<number>('map.brightness') ?? 1
  const showRespawnVisualizers = useHlSetting<boolean>('map.respawnVisualizers') ?? false
  const fogSetting = useHlSetting<boolean>('map.fog') ?? false
  const brightnessRef = useRef(brightness)
  brightnessRef.current = brightness

  // Briefly ensure the map is cleared when the map changes
  // to prevent lingering of the previous map
  useEffect(() => {
    setLoadedMap(null)
    setMapOverlay(null)
    chunkRootsByNameRef.current = new Map()
    visibilityCullingEnabledRef.current = false
    currentClusterRef.current = null
    useInstance.getState().setMapNodes(undefined)
    useInstance.getState().setRuntimePerf({
      visibleChunkCount: 0,
      currentCluster: null,
    })
    setMapVisibility(null)

    return () => {
      useInstance.getState().setMapNodes(undefined)
    }
  }, [map])

  useEffect(() => {
    if (!MAP_CHUNKING_ENABLED) {
      setMapVisibility(null)
      return
    }

    const visibilityUrl = getMapVisibilityUrl(map)
    if (!visibilityUrl) {
      setMapVisibility(null)
      return
    }

    const requestId = ++visibilityRequestIdRef.current

    fetch(visibilityUrl)
      .then(response => {
        if (!response.ok) {
          throw new Error(`Failed to load visibility metadata: ${response.status}`)
        }
        return response.json()
      })
      .then(data => {
        if (requestId !== visibilityRequestIdRef.current) return
        setMapVisibility(isMapVisibilityMetadata(data) ? data : null)
      })
      .catch(() => {
        if (requestId === visibilityRequestIdRef.current) {
          setMapVisibility(null)
        }
      })

    return () => {
      if (visibilityRequestIdRef.current === requestId) {
        visibilityRequestIdRef.current += 1
      }
    }
  }, [map])

  // Load the map model. bsp-to-glb maps (conversion.json pipeline) load files.model with the meshopt
  // decoder plus the lightmap atlas; older maps load textured_compressed.glb. Failures end in
  // mapStatus 'missing' or 'error', which MapNotice shows (no blocking alerts).
  useEffect(() => {
    const requestId = ++mapLoadRequestIdRef.current
    const isStale = () => requestId !== mapLoadRequestIdRef.current
    const { setMapStatus } = useInstance.getState()
    const folder = getMapFolder(map)

    if (!folder) {
      setMapStatus({ state: 'missing', message: `No converted geometry for ${map}` })
      return
    }
    setMapStatus({ state: 'loading', folder })

    let pipeline: MapPipeline | undefined
    const load = async () => {
      // Asset contract 3.5: the pack resolves before conversion.json; a settled pack adds no await.
      if (!isAssetPackSettled()) {
        await resolveAssetPack()
        if (isStale()) return
      }
      const conversion = await fetchMapConversion(map)
      if (isStale()) return
      pipeline = conversion?.pipeline === 'bsp-to-glb' ? 'bsp-to-glb' : 'textured'

      // Textured world from the asset pack (contract 12.5); any failure falls back to the public files.
      const packFiles = pipeline === 'bsp-to-glb' ? packWorldFiles(folder, conversion, mode) : null
      if (packFiles) {
        const packed = await loadPackWorld(packFiles, folder, conversion, {
          gl,
          camera,
          scene,
          brightness: brightnessRef.current,
        })
        if (isStale()) {
          if (packed) disposeLoadedMap(packed)
          return
        }
        if (packed) {
          setLoadedMap(packed)
          return
        }
      }
      setPackWorldInfo(folder, packFiles ? 'fallback' : null)
      const modelUrl = getMapModelUrl(map, conversion)
      if (!modelUrl) throw new Error(`No model file for ${map}`)

      const lightmapFile = pipeline === 'bsp-to-glb' ? conversion?.lightmap?.file : undefined
      const lightmapUrl = lightmapFile ? getMapFileUrl(map, lightmapFile) : undefined
      const [gltf, lightmap] = await Promise.all([
        loadGLTF(
          modelUrl,
          `${map} (${pipeline === 'bsp-to-glb' ? 'geometry' : 'textured'})`,
          pipeline === 'bsp-to-glb'
        ),
        lightmapUrl
          ? loadLightmap(lightmapUrl, conversion?.lightmap?.uvChannel ?? 0)
          : Promise.resolve(null),
      ])
      if (isStale() || !gltf?.scene) {
        lightmap?.dispose()
        return
      }
      setLoadedMap({ root: gltf.scene, pipeline, folder, conversion, lightmap })
    }

    load().catch(error => {
      if (isStale()) return
      const status = (error as { response?: Response })?.response?.status
      const message = error instanceof Error ? error.message : String(error)
      setMapStatus({ state: status === 404 ? 'missing' : 'error', folder, pipeline, message })
      console.error(`Unable to load map: ${map} (${mode})`, error)
    })

    return () => {
      if (mapLoadRequestIdRef.current === requestId) {
        mapLoadRequestIdRef.current += 1
      }
    }
  }, [map, mode])

  // Free the GPU resources of a replaced map (module-level shared materials stay).
  useEffect(() => {
    if (!loadedMap) return
    return () => disposeLoadedMap(loadedMap)
  }, [loadedMap])

  useEffect(() => {
    if (!mapModel || !MAP_CHUNKING_ENABLED) {
      chunkRootsByNameRef.current = new Map()
      visibilityCullingEnabledRef.current = false
      currentClusterRef.current = null
      useInstance.getState().setRuntimePerf({
        visibleChunkCount: 0,
        currentCluster: null,
      })
      return
    }

    const chunkRootsByName = collectChunkRoots(mapModel)
    chunkRootsByNameRef.current = chunkRootsByName
    currentClusterRef.current = null
    setChunkRootVisibility(chunkRootsByName, true)
    useInstance.getState().setRuntimePerf({
      visibleChunkCount: chunkRootsByName.size,
      currentCluster: null,
    })

    if (!mapVisibility) {
      visibilityCullingEnabledRef.current = false
      return
    }

    const missingChunkNames = mapVisibility.chunkNames.filter(
      chunkName => !chunkRootsByName.has(chunkName)
    )

    if (missingChunkNames.length > 0) {
      visibilityCullingEnabledRef.current = false
      setChunkRootVisibility(chunkRootsByName, true)
      console.warn(
        `Visibility culling disabled for ${map}: missing chunk roots ${missingChunkNames.join(', ')}`
      )
      return
    }

    visibilityCullingEnabledRef.current = true
  }, [map, mapModel, mapVisibility])

  useFrame(state => {
    const chunkRootsByName = chunkRootsByNameRef.current
    if (chunkRootsByName.size === 0) return

    if (!visibilityCullingEnabledRef.current || !mapVisibility || !ref.current) {
      if (currentClusterRef.current !== null) {
        setChunkRootVisibility(chunkRootsByName, true)
        currentClusterRef.current = null
        useInstance.getState().setRuntimePerf({
          visibleChunkCount: chunkRootsByName.size,
          currentCluster: null,
        })
      }
      return
    }

    const cameraWorldPosition = state.camera.getWorldPosition(cameraWorldPositionRef.current)
    const currentCluster = getClusterIndexForWorldPoint(
      cameraWorldPosition,
      ref.current,
      mapVisibility
    )

    if (currentCluster < 0) {
      if (currentClusterRef.current !== -1) {
        setChunkRootVisibility(chunkRootsByName, true)
        currentClusterRef.current = -1
        useInstance.getState().setRuntimePerf({
          visibleChunkCount: chunkRootsByName.size,
          currentCluster: -1,
        })
      }
      return
    }

    if (currentCluster === currentClusterRef.current) {
      return
    }

    const visibleChunkIndices = mapVisibility.visibleChunksByCluster[currentCluster]
    if (!Array.isArray(visibleChunkIndices) || visibleChunkIndices.length === 0) {
      setChunkRootVisibility(chunkRootsByName, true)
      currentClusterRef.current = -1
      useInstance.getState().setRuntimePerf({
        visibleChunkCount: chunkRootsByName.size,
        currentCluster: -1,
      })
      return
    }

    setChunkVisibilityForCluster(
      chunkRootsByName,
      mapVisibility.chunkNames,
      visibleChunkIndices
    )
    currentClusterRef.current = currentCluster
    useInstance.getState().setRuntimePerf({
      visibleChunkCount: visibleChunkIndices.length,
      currentCluster,
    })
  })

  // Update map overlay materials
  useEffect(() => {
    if (mapOverlay) {
      mapOverlay.traverse((child: THREE.Object3D) => {
        traverseMaterials(child, (material: any) => {
          // if (material.map) material.map.encoding = THREE.sRGBEncoding
          // if (material.emissiveMap) material.emissiveMap.encoding = THREE.sRGBEncoding
          material.depthWrite = true
          material.needsUpdate = true

          material.polygonOffset = true
          material.polygonOffsetUnits = 1
          material.polygonOffsetFactor = -10
          material.vertexColors = false
        })
      })
    }
  }, [mapOverlay, mode])

  // Freeze the static map, then publish the brush-entity nodes (F6 moves and toggles them) and the
  // ready status. bsp-to-glb nodes start with their converter visibility first: the 3D skybox is
  // hidden, brush entities that start hidden (initiallyVisible false) wait for runtime code.
  useEffect(() => {
    if (loadedMap) {
      if (loadedMap.pipeline === 'bsp-to-glb') applyBspInitialVisibility(loadedMap.root)
      freezeStaticMapSubtree(loadedMap.root)
    }

    if (mapOverlay) {
      freezeStaticMapSubtree(mapOverlay)
    }

    if (loadedMap) {
      const { setMapNodes, setMapStatus } = useInstance.getState()
      setMapNodes(loadedMap.pipeline === 'bsp-to-glb' ? collectMapNodes(loadedMap.root) : new Map())
      setMapStatus({ state: 'ready', folder: loadedMap.folder, pipeline: loadedMap.pipeline })
    }
  }, [loadedMap, mapOverlay])

  // Update map model materials
  useEffect(() => {
    if (!loadedMap) return
    const mapModel = loadedMap.root

    if (loadedMap.pack) {
      // Materials were made, and their programs compiled, before the pack world was shown (load above).
      bspMaterialsRef.current = loadedMap.pack.materials
      return () => {
        if (bspMaterialsRef.current === loadedMap.pack?.materials) bspMaterialsRef.current = null
      }
    }

    if (loadedMap.pipeline === 'bsp-to-glb') {
      // One shared material per kind (src/highlander/map/bspMaterials.ts). Vertex colours are the
      // albedo (texdata reflectivity) and the lightmap lights them, so none of the textured-GLB fixes
      // below apply.
      const materials = applyBspMaterials(mapModel, {
        mode: mode ?? 'textured',
        lightmap: loadedMap.lightmap,
        lightmapRange: loadedMap.conversion?.lightmap?.range ?? 1,
        brightness: brightnessRef.current,
      })
      bspMaterialsRef.current = materials

      return () => {
        if (bspMaterialsRef.current === materials) bspMaterialsRef.current = null
        materials.dispose()
      }
    }

    mapModel.traverse((child: THREE.Object3D) => {
      // Hide invisible game-logic entity nodes (e.g. team_control_point brushes)
      if (isInvisibleEntityNode(child.name)) {
        child.visible = false
        return
      }

      traverseMaterials(child, (material: any, node: any) => {
        // Hide invisible tool materials (nodraw, clip, trigger, etc.)
        if (isInvisibleToolMaterial(material.name)) {
          node.visible = false
          return
        }

        // if (material.map) material.map.encoding = THREE.sRGBEncoding
        // if (material.emissiveMap) material.emissiveMap.encoding = THREE.sRGBEncoding
        material.depthWrite = true
        material.vertexColors = false
        material.needsUpdate = true

        if (mode === 'untextured') {
          node.material = MAP_UNTEXTURED_MATERIAL
        }

        if (mode === 'wireframe') {
          node.material = MAP_WIREFRAME_MATERIAL
        }
      })
    })
  }, [loadedMap, mode])

  // Map brightness (settings.highlander.map.brightness) scales the lightmap without a reload.
  useEffect(() => {
    bspMaterialsRef.current?.setBrightness(brightness)
  }, [brightness, loadedMap, mode])

  // Respawn-room visualizer meshes (material hiddenByDefault) follow map.respawnVisualizers.
  useEffect(() => {
    if (loadedMap?.pipeline !== 'bsp-to-glb') return
    loadedMap.root.traverse(node => {
      const info = node.userData.dribbleMaterial as BspMaterialInfo | undefined
      if (info?.hiddenByDefault) node.visible = showRespawnVisualizers
    })
  }, [loadedMap, mode, showRespawnVisualizers])

  // Fog from the map's env_fog_controller (bsp-to-glb maps, setting map.fog).
  useEffect(() => {
    const fog = loadedMap?.pipeline === 'bsp-to-glb' ? loadedMap.conversion?.fog : null
    if (!fogSetting || !fog?.enabled || !Array.isArray(fog.color)) return
    const [r, g, b] = fog.color.map(value => Math.min(255, Math.max(0, Number(value) || 0)) / 255)
    const sceneFog = new THREE.Fog(
      new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace),
      fog.start,
      fog.end
    )
    scene.fog = sceneFog
    return () => {
      if (scene.fog === sceneFog) scene.fog = null
    }
  }, [scene, loadedMap, fogSetting])

  // Reposition the world to the center of the scene bounds
  useEffect(() => {
    // Not entirely sure if this logic is correct
    const x = bounds.center.x - bounds.max.x
    const y = -bounds.center.y - bounds.min.y
    const z = ActorDimensions.z * 0.5

    ref.current?.position.copy(bounds.center).add(new THREE.Vector3(x, y, z))
  }, [bounds])

  // PAK static props (task M2): props.glb shares the world group's transform and material rules. The
  // URL comes from the loaded map's own folder, so a render between a map change and the reset above
  // never pairs the new map name with the previous map's file list.
  const propsFile = loadedMap?.pipeline === 'bsp-to-glb' ? loadedMap.conversion?.files?.props : undefined
  const propsUrl = loadedMap && propsFile ? getMapFileUrl(loadedMap.folder, propsFile) : undefined
  // Stock props of a local asset pack (asset contract 9 "M3-props"), beside props.glb.
  const stockProps = useStockProps(
    loadedMap?.pipeline === 'bsp-to-glb' ? loadedMap.folder : undefined,
    loadedMap?.conversion ?? null
  )

  // Textured PAK props of the pack (M3-props2) replace props.glb while assets.mapTextures is on.
  const pakProps = usePackPakProps(
    loadedMap?.pipeline === 'bsp-to-glb' && propsUrl ? loadedMap.folder : undefined,
    loadedMap?.conversion ?? null
  )
  // A props-pak.glb that failed or was skipped falls back to public props.glb (per-item fallback, asset contract 3.6).
  const pakKey = pakProps?.key
  const pakUnavailable = useSyncExternalStore(subscribeAssetItems, () => {
    const state = pakKey ? getAssetItem(pakKey)?.state : undefined
    return state === 'failed' || state === 'skipped'
  })
  const pakPropsDrawn = pakProps && !pakUnavailable ? pakProps : null

  return (
    // Account for valve maps using different axis system
    <group ref={ref} name="world" rotation={[Math.PI / 2, 0, 0]}>
      {mapModel ? <primitive object={mapModel} /> : null}
      {mapOverlay ? <primitive object={mapOverlay} /> : null}
      {pakPropsDrawn ? (
        <StaticProps
          key={pakPropsDrawn.key}
          url={pakPropsDrawn.url}
          itemKey={pakPropsDrawn.key}
          mode={mode ?? 'textured'}
        />
      ) : propsUrl ? (
        <StaticProps url={propsUrl} mode={mode ?? 'textured'} />
      ) : null}
      {stockProps ? (
        <StaticProps
          key={stockProps.key}
          source="stock"
          url={stockProps.url}
          itemKey={stockProps.key}
          mode={mode ?? 'textured'}
        />
      ) : null}
    </group>
  )
}

function isMapVisibilityMetadata(data: unknown): data is MapVisibilityMetadata {
  if (!data || typeof data !== 'object') return false

  const candidate = data as Record<string, unknown>
  return (
    candidate.version === 2 &&
    candidate.transform === 'gltf-to-source:x,-z,y' &&
    Array.isArray(candidate.chunkNames) &&
    Array.isArray(candidate.chunkBounds) &&
    Array.isArray(candidate.planes) &&
    Array.isArray(candidate.nodes) &&
    Array.isArray(candidate.leafClusters) &&
    Array.isArray(candidate.visibleChunksByCluster)
  )
}

function collectChunkRoots(root: THREE.Object3D): Map<string, THREE.Object3D> {
  const chunkRootsByName = new Map<string, THREE.Object3D>()

  root.traverse(node => {
    if (/^chunk_\d+_\d+$/.test(node.name)) {
      chunkRootsByName.set(node.name, node)
    }
  })

  return chunkRootsByName
}

function setChunkRootVisibility(chunkRootsByName: Map<string, THREE.Object3D>, visible: boolean) {
  chunkRootsByName.forEach(chunkRoot => {
    chunkRoot.visible = visible
  })
}

function setChunkVisibilityForCluster(
  chunkRootsByName: Map<string, THREE.Object3D>,
  chunkNames: string[],
  visibleChunkIndices: number[]
) {
  const visibleChunkIndexSet = new Set(visibleChunkIndices)

  chunkNames.forEach((chunkName, chunkIndex) => {
    const chunkRoot = chunkRootsByName.get(chunkName)
    if (!chunkRoot) return
    chunkRoot.visible = visibleChunkIndexSet.has(chunkIndex)
  })
}

// bsp-to-glb node visibility at load: the 3D skybox (drawn x16 around sky_camera in game) stays hidden,
// and brush-entity parents start as the converter marked them (initiallyVisible false: func_brush
// StartDisabled, rendermode 6/10 collision brushes).
function applyBspInitialVisibility(root: THREE.Object3D) {
  root.traverse(node => {
    const info = node.userData?.dribble
    if (!info) return
    if (info.kind === 'skybox3d' || info.hiddenByDefault === true) {
      node.visible = false
    } else if (info.kind === 'brushEntity' || info.kind === 'respawnVisualizer') {
      node.visible = info.initiallyVisible !== false
    }
  })
}

function freezeStaticMapSubtree(root: THREE.Object3D) {
  root.traverse(node => {
    node.matrixAutoUpdate = false

    if (node.type !== 'Mesh') return

    const mesh = node as THREE.Mesh
    if (!mesh.geometry.boundingBox) {
      mesh.geometry.computeBoundingBox()
    }
    if (!mesh.geometry.boundingSphere) {
      mesh.geometry.computeBoundingSphere()
    }
    mesh.frustumCulled = true
  })

  root.updateMatrixWorld(true)
}

const SHARED_MATERIALS = new Set<THREE.Material>([MAP_UNTEXTURED_MATERIAL])

function disposeLoadedMap(loaded: LoadedMap) {
  if (loaded.pack && !loaded.pack.released) {
    loaded.pack.released = true
    loaded.pack.materials.dispose()
    loaded.pack.textureKeys.forEach(releasePackTexture)
  }
  const textures = new Set<THREE.Texture>()
  loaded.root.traverse(node => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    mesh.geometry?.dispose()
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    materials.forEach(material => {
      if (!material || SHARED_MATERIALS.has(material) || isSharedMapMaterial(material)) return
      Object.values(material).forEach(value => {
        // Pack textures are shared and released above, never disposed here.
        if (value instanceof THREE.Texture && !value.userData.dribblePack) textures.add(value)
      })
      material.dispose()
    })
  })
  if (loaded.lightmap) textures.add(loaded.lightmap)
  textures.forEach(texture => texture.dispose())
}

function getMapLocalPoint(worldPoint: THREE.Vector3, mapRoot: THREE.Object3D): THREE.Vector3 | null {
  mapRoot.updateWorldMatrix(true, false)

  const inverseWorldMatrix = new THREE.Matrix4().copy(mapRoot.matrixWorld)
  if (inverseWorldMatrix.determinant() === 0) {
    return null
  }

  return worldPoint.clone().applyMatrix4(inverseWorldMatrix.invert())
}

function convertGltfPointToSource(point: THREE.Vector3): [number, number, number] {
  return [point.x, -point.z, point.y]
}

function getLeafIndexForSourcePoint(
  sourcePoint: [number, number, number],
  metadata: MapVisibilityMetadata
): number {
  let nodeIndex = 0

  while (Number.isInteger(nodeIndex) && nodeIndex >= 0) {
    if (nodeIndex >= metadata.nodes.length) return -1

    const [planeIndex, frontChild, backChild] = metadata.nodes[nodeIndex]
    const plane = metadata.planes[planeIndex]
    if (!plane) return -1

    const distance =
      sourcePoint[0] * plane[0] + sourcePoint[1] * plane[1] + sourcePoint[2] * plane[2] - plane[3]
    nodeIndex = distance >= 0 ? frontChild : backChild
  }

  const leafIndex = -nodeIndex - 1
  return leafIndex >= 0 && leafIndex < metadata.leafClusters.length ? leafIndex : -1
}

function getClusterIndexForLeaf(leafIndex: number, metadata: MapVisibilityMetadata): number {
  if (leafIndex < 0 || leafIndex >= metadata.leafClusters.length) {
    return -1
  }

  const clusterIndex = metadata.leafClusters[leafIndex]
  return Number.isInteger(clusterIndex) && clusterIndex >= 0 ? clusterIndex : -1
}

function getClusterIndexForWorldPoint(
  worldPoint: THREE.Vector3,
  mapRoot: THREE.Object3D | null,
  metadata: MapVisibilityMetadata | null
): number {
  if (!mapRoot || !metadata) {
    return -1
  }

  const mapLocalPoint = getMapLocalPoint(worldPoint, mapRoot)
  if (!mapLocalPoint) {
    return -1
  }

  const leafIndex = getLeafIndexForSourcePoint(convertGltfPointToSource(mapLocalPoint), metadata)
  return getClusterIndexForLeaf(leafIndex, metadata)
}

//
// ─── HELPERS ────────────────────────────────────────────────────────────────────
//

// Useful resource: https://github.com/donmccurdy/three-gltf-viewer/blob/master/src/viewer.js

function loadGLTF(url: string, name?: string, meshopt = false) {
  return new Promise<GLTF>((resolve, reject) => {
    try {
      const gltfLoader = new GLTFLoader().setCrossOrigin('anonymous')
      // bsp-to-glb maps are EXT_meshopt_compression + KHR_mesh_quantization
      if (meshopt) gltfLoader.setMeshoptDecoder(MeshoptDecoder)

      const onLoad = (gltf: GLTF) => {
        resolve(gltf)
      }

      const onProgress = (xhr: ProgressEvent) => {
        // TODO: The lengthComputable seems to be false after being deployed to
        // Netlify. This may be due to some content headers needing to be set:
        // https://community.netlify.com/t/progressevent-total-is-0-for-asset-on-deployed-site-but-works-in-local-environment/3747

        const fileDownload = getState().downloads.get(url)
        if (!fileDownload) addDownloadAction({ type: 'map', name: name ?? url, url: url })

        if (xhr.lengthComputable) {
          const percentComplete = (xhr.loaded / xhr.total) * 100
          updateDownloadAction(url, { progress: percentComplete, size: xhr.total })
        }
      }

      const onError = (error: unknown) => {
        reject(error)
      }

      gltfLoader.load(url, onLoad, onProgress, onError)
    } catch (error) {
      console.error(error)
      reject(error)
    }
  })
}

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

interface PackWorldFiles {
  world: string
  lightmap: string
  conversion: string
}

/**
 * The pack world files of a folder (contract 12.5), or null: pack not ready, assets.enabled or
 * assets.mapTextures off, a render mode other than textured (untextured and wireframe keep the public look), no
 * world in the entry, or an entry built from another BSP (3.5; StaticProps logs that once). Synchronous, so a
 * page without a pack adds no await to the map load.
 */
function packWorldFiles(
  folder: string,
  conversion: MapConversion | null,
  mode: WorldProps['mode']
): PackWorldFiles | null {
  const pack = getAssetPackState()
  if (pack.status !== 'ready' || (mode ?? 'textured') !== 'textured') return null
  if (!getAssetSetting('enabled') || !getAssetSetting('mapTextures')) return null
  const entry = pack.manifest?.maps?.[folder]
  const files = entry?.files
  if (!entry || !files?.world || !files.lightmap || !files.conversion) return null
  const identity = publicMapIdentity(conversion)
  if (
    !identity ||
    entry.mapName !== identity.mapName ||
    canonicalJson(entry.publicProps ?? null) !== canonicalJson(identity.props)
  )
    return null
  if (!assetPackFile(files.world) || !assetPackFile(files.lightmap) || !assetPackFile(files.conversion))
    return null
  return { world: files.world, lightmap: files.lightmap, conversion: files.conversion }
}

/**
 * Loads the pack's conversion.json, world.glb and lightmap (one converter run), acquires every texture the
 * world's materials name, builds the materials and compiles their programs before the world is shown (4.3).
 * Null when any of the three files fails (each warns once through loadPackItem); a missing texture only leaves
 * its material on the flat albedo.
 */
async function loadPackWorld(
  files: PackWorldFiles,
  folder: string,
  conversion: MapConversion | null,
  ctx: { gl: THREE.WebGLRenderer; camera: THREE.Camera; scene: THREE.Scene; brightness: number }
): Promise<LoadedMap | null> {
  const packConversion = await loadPackItem(files.conversion, async url => {
    const response = await fetch(url, { cache: 'no-cache' })
    if (!response.ok) throw new Error(`conversion.json answered ${response.status}`)
    return (await response.json()) as MapConversion
  })
  if (!packConversion?.lightmap) return null
  const [gltf, lightmap] = await Promise.all([
    loadPackItem(files.world, loadPackGltf),
    loadPackItem(files.lightmap, async url => {
      const texture = await loadLightmap(url, packConversion.lightmap?.uvChannel ?? 0)
      if (!texture) throw new Error('lightmap failed to load')
      return texture
    }),
  ])
  if (!gltf?.scene || !lightmap) {
    lightmap?.dispose()
    if (gltf?.scene) disposeLoadedMap({ root: gltf.scene, pipeline: 'bsp-to-glb', folder, conversion, lightmap: null })
    return null
  }
  const keys = new Set<string>()
  gltf.scene.traverse(node => {
    const material = (node as THREE.Mesh).material as THREE.Material | undefined
    const record = (material && !Array.isArray(material) ? material.userData?.dribble?.texture : null) as
      | { key?: string; blend?: { key?: string } }
      | null
    if (record?.key) keys.add(record.key)
    if (record?.blend?.key) keys.add(record.blend.key)
  })
  const textureKeys = [...keys].sort()
  const loaded = await Promise.all(textureKeys.map(key => acquirePackTexture(key, ctx.gl)))
  const textures = new Map(textureKeys.map((key, i) => [key, loaded[i]]))
  const materials = applyBspMaterials(gltf.scene, {
    mode: 'textured',
    lightmap,
    lightmapRange: packConversion.lightmap.range ?? 1,
    brightness: ctx.brightness,
    textures,
  })
  await warmUpObject(ctx.gl, gltf.scene, ctx.camera, ctx.scene)
  const bound = loaded.filter(Boolean).length
  setPackWorldInfo(folder, 'pack', { textures: textureKeys.length, bound, failed: textureKeys.length - bound })
  return {
    root: gltf.scene,
    pipeline: 'bsp-to-glb',
    folder,
    conversion,
    lightmap,
    pack: { materials, textureKeys, released: false },
  }
}

// The atlas has no padding between faces, so no mipmaps (they would bleed) and linear filtering.
async function loadLightmap(url: string, uvChannel: number): Promise<THREE.Texture | null> {
  try {
    const texture = await new THREE.TextureLoader().setCrossOrigin('anonymous').loadAsync(url)
    texture.flipY = false
    texture.colorSpace = THREE.SRGBColorSpace
    texture.channel = uvChannel
    texture.generateMipmaps = false
    texture.minFilter = THREE.LinearFilter
    texture.magFilter = THREE.LinearFilter
    texture.needsUpdate = true
    return texture
  } catch (error) {
    // The geometry still renders with its flat albedo colours.
    console.warn(`Map lightmap unavailable: ${url}`, error)
    return null
  }
}

function traverseMaterials(
  object: THREE.Object3D,
  callback: (material: THREE.Material, node: THREE.Object3D) => void
) {
  object.traverse((node: THREE.Object3D) => {
    if (node.type === 'Mesh') {
      const m = node as THREE.Mesh
      const materials = Array.isArray(m.material) ? m.material : [m.material]

      materials.forEach((material: THREE.Material) => callback(material, node))
    }
  })
}
