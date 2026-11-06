// PAK static props of bsp-to-glb maps (contract section 4.8, task M2).
//
// scripts/convert-bsp.mjs writes public/models/maps/<map>/props.glb (scripts/lib/static-props.mjs): the
// static props whose models ship inside the map's PAK lump, as EXT_mesh_gpu_instancing nodes in glTF
// axes plus one merged batch, with vertex colours = flat albedo x the PAK's baked vertex lighting.
// Stock props are TF2 game assets and stay invisible (D1/D7).
//
// World.tsx mounts this component inside its rotated `world` group, next to world.glb, so the file needs
// no transform of its own. The same shared bsp-to-glb material rules apply (bspMaterials.ts); the props
// have no lightmap, so map.brightness scales their material colour instead of lightMapIntensity.
// Their vertex and instance colours already hold VRAD's baked light, so the untextured mode keeps the
// unlit textured material (the world's Lambert material would light them a second time), and the
// wireframe mode drops the instance light so the shared wireframe material is not tinted.
// Setting map.staticProps shows or hides them; the file loads the first time they are shown.
// Probe: window.__dribble.hl.probe('map.props')
//
// Stock props (asset contract 9 "M3-props"): a local asset pack may list maps/<folder>/props-stock.glb,
// the stock prop_static models of the map converted from the user's own VPKs by the same code path
// (scripts/assets/maps/stage.mjs). World mounts a second StaticProps with source 'stock' for it while
// useStockProps() returns it: the pack is ready, assets.enabled and assets.stockProps are on, and the
// pack's map entry matches the public conversion.json (contract 3.5). Both copies follow the same material
// rules, map.brightness, the render mode and map.staticProps. The stock file loads through the pack item
// registry (loadPackItem, one warning and the fallback, which is nothing, on failure) and the dynamic
// GLTFLoader of src/assetpack, so a page without a pack runs none of that code.
//
// Textured pack props (asset task M3-props2): the pack's props-stock.glb and props-pak.glb (the PAK props again,
// with VPK materials; World draws it in place of public props.glb while assets.mapTextures is on) carry UVs and
// one material per texture (`userData.dribble.texture`, contract 12.3). With assets.mapTextures on and the
// textured render mode, the file's textures are acquired through @pack/textures, the materials are built and
// their programs compiled (warmUpObject) before the props are shown; a texture that fails keeps the flat look.
// Far VTX LODs and sprp fades (POV and spectator only) run in propLod.ts.

import React, { useEffect, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { freezeGeometryAfterFirstDraw } from '@highlander/perf/sceneUpdate'

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/Addons.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'

import { useInstance, useStore } from '@zus/store'
import type { MapConversion } from '@utils/mapAssets'
import { publicMapIdentity } from '@utils/mapAssets'
import { useAssetSetting } from '@pack/hooks'
import { assetPackFile, useAssetPack } from '@pack/pack'
import { loadPackItem, releaseAssetItem, skipAssetItem, getAssetItem } from '@pack/items'
import { loadPackGltf, warmUpObject } from '@pack/loaders'
import { acquirePackTexture, releasePackTexture } from '@pack/textures'
import { PropLodController } from '@highlander/map/propLod'
import { applyArrayMaterials, bakeRuntimeProps, type ArrayMaterials, type PropBatchResult } from '@highlander/map/propBatch'
import { registerHlProbe } from '@highlander/debug'
import { useHlSetting } from '@highlander/extras/hooks'
import {
  BspMaterials,
  MapRenderMode,
  applyBspMaterials,
  isSharedMapMaterial,
} from '@highlander/map/bspMaterials'

export type StaticPropsSource = 'pak' | 'stock' | 'sky'

export interface StaticPropsProps {
  /** props.glb of the map folder (conversion.json files.props), or the pack's props-stock.glb; undefined when none. */
  url: string | undefined
  mode: MapRenderMode
  /** 'pak' (default): public props.glb. 'stock': the asset pack's props-stock.glb, loaded as pack item `itemKey`. */
  source?: StaticPropsSource
  /** Pack item key of a pack file (its pack path, maps/<folder>/props-stock.glb or props-pak.glb). */
  itemKey?: string
  /**
   * 'sky' (as/mapfx, props-sky.glb): called once the materials are applied, so the 3D skybox can give the props
   * its render order and opaque materials; also turns their raycasts off.
   */
  onPrepared?: (root: THREE.Object3D) => void
}

/** A loaded file: its root, the pack textures it holds (released with it) and the materials made for its warm-up. */
interface LoadedProps {
  url: string
  root: THREE.Group
  textures: Map<string, THREE.Texture | null> | null
  prepared: { mode: MapRenderMode; textured: boolean; materials: BspMaterials; arrays: ArrayMaterials } | null
  /** The runtime bake of a pack file (propBatch.ts), or null. */
  batch: PropBatchResult | null
}

type PropsState = 'off' | 'loading' | 'ready' | 'error'

interface PropsCurrent {
  url: string | undefined
  state: PropsState
  error: string | null
  root: THREE.Object3D | null
  mode: MapRenderMode | null
  /** The material rules actually applied: untextured shows the props with their textured material. */
  materialMode: MapRenderMode | null
  brightness: number | null
  /** Pack textures: keys held and bound (M3-props2). */
  textures: { keys: number; loaded: number } | null
  lod: PropLodController | null
  batch: Omit<PropBatchResult, 'dispose'> | null
}

const emptyCurrent = (): PropsCurrent => ({
  url: undefined,
  state: 'off',
  error: null,
  root: null,
  mode: null,
  materialMode: null,
  brightness: null,
  textures: null,
  lod: null,
  batch: null,
})

/** What each copy shows right now, for the probes (one World, so one entry per source). */
const currents: Record<StaticPropsSource, PropsCurrent> = { pak: emptyCurrent(), stock: emptyCurrent(), sky: emptyCurrent() }

/** Loads one props file: public props.glb directly, a stock file through the pack item registry. */
function loadPropsFile(source: StaticPropsSource, url: string, itemKey: string | undefined): Promise<THREE.Group> {
  if (source !== 'pak' || itemKey) {
    if (!itemKey) return Promise.reject(new Error('stock props need a pack item key'))
    return loadPackItem(itemKey, loadPackGltf).then(gltf => {
      // null: failed before or now (the registry warned once), or skipped. Nothing draws.
      if (!gltf) throw new PackItemUnavailable(getAssetItem(itemKey)?.error ?? 'unavailable')
      return gltf.scene
    })
  }
  return new GLTFLoader()
    .setMeshoptDecoder(MeshoptDecoder)
    .loadAsync(url)
    .then(gltf => gltf.scene)
}

class PackItemUnavailable extends Error {}

export const StaticProps = React.memo(({ url, mode, source = 'pak', itemKey, onPrepared }: StaticPropsProps) => {
  const current = currents[source]
  const enabled = useHlSetting<boolean>('map.staticProps') ?? true
  const brightness = useHlSetting<number>('map.brightness') ?? 1
  // Pack files only: their textures load with the file while assets.mapTextures is on (the next load after a change).
  const packTextures = useAssetSetting('mapTextures') && !!itemKey
  const gl = useThree(state => state.gl)
  const camera = useThree(state => state.camera)
  const scene = useThree(state => state.scene)
  const [loaded, setLoaded] = useState<LoadedProps | null>(null)
  const requestRef = useRef(0)
  const materialsRef = useRef<BspMaterials | null>(null)
  const brightnessRef = useRef(brightness)
  brightnessRef.current = brightness
  // The world.glb material rules. Baked light needs no scene lights: untextured keeps the unlit
  // textured material, wireframe uses the shared wireframe material without the instance light.
  // Pack textures draw in the textured render mode only.
  const materialMode: MapRenderMode = mode === 'wireframe' ? 'wireframe' : 'textured'
  const useTextures = mode === 'textured'
  const modeRef = useRef({ materialMode, useTextures })
  modeRef.current = { materialMode, useTextures }

  // Load once the props are wanted; switching them off afterwards only hides them.
  const wanted = enabled || loaded?.url === url
  useEffect(() => {
    current.url = url
    if (!url) {
      current.state = 'off'
      current.error = null
      setLoaded(null)
      return
    }
    if (loaded?.url === url) return
    if (!wanted) {
      current.state = 'off'
      return
    }
    const request = ++requestRef.current
    current.state = 'loading'
    current.error = null
    let held: string[] = []
    const releaseHeld = () => {
      held.forEach(releasePackTexture)
      held = []
    }
    // Pack files written for the runtime bake are merged once, before the bounds and materials (propBatch.ts).
    let batch: PropBatchResult | null = null
    const bake = async (root: THREE.Group, textures: Map<string, THREE.Texture | null> | null) => {
      const t0 = performance.now()
      const result = itemKey ? await bakeRuntimeProps(root, textures, gl.capabilities.isWebGL2) : null
      if (result) result.bakeMs = Math.round(performance.now() - t0)
      freeze(root)
      return result
    }
    loadPropsFile(source, url, itemKey)
      .then(async root => {
        if (request !== requestRef.current) throw new Superseded(root)
        let textures: Map<string, THREE.Texture | null> | null = null
        let prepared: LoadedProps['prepared'] = null
        const keys = packTextures ? packTextureKeys(root) : []
        if (keys.length) {
          held = keys
          const list = await Promise.all(keys.map(key => acquirePackTexture(key, gl)))
          if (request !== requestRef.current) throw new Superseded(root)
          textures = new Map(keys.map((key, i) => [key, list[i]]))
          batch = await bake(root, textures)
          if (request !== requestRef.current) throw new Superseded(root, batch)
          // Materials and programs before the props are shown (asset contract 4.3); the effect below adopts them.
          const { materialMode: m, useTextures: t } = modeRef.current
          const materials = applyBspMaterials(root, {
            mode: m,
            lightmap: null,
            lightmapRange: 1,
            brightness: brightnessRef.current,
            ...(t ? { textures } : {}),
          })
          const arrays = applyArrayMaterials(root, t, brightnessRef.current)
          prepared = { mode: m, textured: t, materials, arrays }
          await warmUpObject(gl, root, camera, scene)
          if (request !== requestRef.current) {
            materials.dispose()
            arrays.dispose()
            throw new Superseded(root, batch)
          }
        } else {
          batch = await bake(root, null)
          if (request !== requestRef.current) throw new Superseded(root, batch)
        }
        held = []
        setLoaded({ url, root, textures, prepared, batch })
      })
      .catch(error => {
        if (error instanceof Superseded) {
          disposeProps(error.root)
          error.batch?.dispose()
          releaseHeld()
          if (itemKey) releaseAssetItem(itemKey)
          return
        }
        releaseHeld()
        if (request !== requestRef.current) return
        current.state = 'error'
        current.error = error instanceof Error ? error.message : String(error)
        // A pack item already logged its one warning (asset contract 3.6).
        if (!(error instanceof PackItemUnavailable) && !itemKey) console.warn(`Static props unavailable: ${url}`, error)
      })
    return () => {
      if (requestRef.current === request) requestRef.current += 1
    }
  }, [url, wanted]) // eslint-disable-line react-hooks/exhaustive-deps

  // A replaced or unmounted file frees its geometry (the material effect below frees the materials).
  useEffect(() => {
    if (!loaded) return
    current.root = loaded.root
    current.state = 'ready'
    const keys = loaded.textures ? [...loaded.textures.keys()] : []
    current.textures = loaded.textures
      ? { keys: keys.length, loaded: [...loaded.textures.values()].filter(Boolean).length }
      : null
    if (loaded.batch) {
      loaded.root.traverse(node => {
        if ((node as THREE.Mesh).isMesh) freezeGeometryAfterFirstDraw(node as THREE.Mesh)
      })
    }
    const t0 = performance.now()
    const lod = new PropLodController(loaded.root, gl)
    if (loaded.batch) loaded.batch.lodSetupMs = Math.round(performance.now() - t0)
    current.lod = lod.active ? lod : null
    if (loaded.batch) {
      const { dispose: _dispose, ...batchStats } = loaded.batch
      current.batch = batchStats
    } else current.batch = null
    return () => {
      lod.dispose()
      disposeProps(loaded.root)
      loaded.batch?.dispose()
      keys.forEach(releasePackTexture)
      // A pack file whose copy is gone goes back to idle; the next mount loads it again.
      if (itemKey) releaseAssetItem(itemKey)
      if (current.root === loaded.root) {
        current.root = null
        current.state = 'off'
        current.textures = null
        current.lod = null
        current.batch = null
      }
    }
  }, [loaded]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!loaded) return
    const prepared = loaded.prepared
    let materials: BspMaterials
    let arrays: ArrayMaterials
    if (prepared && prepared.mode === materialMode && prepared.textured === useTextures) {
      materials = prepared.materials
      arrays = prepared.arrays
    } else {
      materials = applyBspMaterials(loaded.root, {
        mode: materialMode,
        lightmap: null,
        lightmapRange: 1,
        brightness: brightnessRef.current,
        ...(useTextures && loaded.textures ? { textures: loaded.textures } : {}),
      })
      arrays = applyArrayMaterials(loaded.root, materialMode === 'textured' && useTextures && !!loaded.textures, brightnessRef.current)
    }
    // Adopted or not, the prepared set is this effect's to free from now on.
    loaded.prepared = null
    if (prepared && prepared.materials !== materials) {
      prepared.materials.dispose()
      prepared.arrays.dispose()
    }
    materialsRef.current = materials
    setInstanceLight(loaded.root, materialMode !== 'wireframe')
    onPrepared?.(loaded.root)
    current.materialMode = materialMode
    return () => {
      if (materialsRef.current === materials) materialsRef.current = null
      materials.dispose()
      arrays.dispose()
    }
  }, [loaded, materialMode, useTextures]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    current.mode = mode
  }, [mode]) // eslint-disable-line react-hooks/exhaustive-deps

  // map.brightness: the vertex colours already hold the baked light, so the colour scales them (textured pack
  // props: their 1 / albedo scale times the brightness).
  useEffect(() => {
    if (!loaded) return
    materialsRef.current?.setBrightness(brightness)
    forEachOwnMaterial(loaded.root, material => {
      if (!(material instanceof THREE.MeshBasicMaterial)) return
      const scale = material.userData.dribbleColorScale as number[] | undefined
      if (scale) material.color.fromArray(scale).multiplyScalar(brightness)
      else material.color.setScalar(brightness)
    })
    current.brightness = brightness
  }, [loaded, materialMode, useTextures, brightness]) // eslint-disable-line react-hooks/exhaustive-deps

  // Hidden props must also stop catching the world raycasts (RTS centre, stickers), which check each
  // hit object's own `visible` flag, so the meshes are toggled with the root.
  useEffect(() => {
    if (!loaded) return
    loaded.root.traverse(node => {
      if ((node as THREE.Mesh).isMesh) node.visible = enabled
    })
    current.lod?.setEnabled(enabled)
    loaded.root.visible = enabled
  }, [loaded, enabled]) // eslint-disable-line react-hooks/exhaustive-deps

  // Far LODs and sprp fades follow the camera (POV and spectator views fade, RTS never does).
  const cameraWorld = useRef(new THREE.Vector3())
  useFrame(() => {
    const lod = current.lod
    if (!lod || !loaded || current.root !== loaded.root) return
    camera.getWorldPosition(cameraWorld.current)
    lod.update(cameraWorld.current, useStore.getState().scene.controls.mode !== 'rts')
  })

  // Unmounted (a map without props.glb): the probe reports nothing loaded, not the last map's file.
  useEffect(
    () => () => {
      current.url = undefined
      current.state = 'off'
      current.error = null
      current.mode = null
      current.materialMode = null
      current.brightness = null
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  )

  return loaded && loaded.url === url ? <primitive object={loaded.root} /> : null
})

/** A load whose result is no longer wanted (another file or an unmount came first). */
class Superseded extends Error {
  constructor(
    readonly root: THREE.Object3D,
    readonly batch: PropBatchResult | null = null
  ) {
    super('superseded')
  }
}

/** Pack texture keys the materials of a loaded pack file name (contract 12.3 `extras.dribble.texture`). */
function packTextureKeys(root: THREE.Object3D): string[] {
  const keys = new Set<string>()
  root.traverse(node => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const material of materials) {
      const key = material?.userData?.dribble?.texture?.key
      if (typeof key === 'string') keys.add(key.toLowerCase())
      const detail = material?.userData?.dribble?.texture?.detail?.key
      if (typeof detail === 'string') keys.add(detail.toLowerCase())
    }
  })
  return [...keys].sort()
}

/**
 * Instance colours carry each instance's baked light. Wireframe mode moves them aside (three tints any
 * material by instanceColor) and the other modes put them back.
 */
function setInstanceLight(root: THREE.Object3D, on: boolean) {
  root.traverse(node => {
    const mesh = node as THREE.InstancedMesh
    if (!mesh.isInstancedMesh) return
    const stashed = mesh.userData.dribbleInstanceColor as THREE.InstancedBufferAttribute | undefined
    if (!on && mesh.instanceColor) {
      mesh.userData.dribbleInstanceColor = mesh.instanceColor
      mesh.instanceColor = null
    } else if (on && stashed) {
      mesh.instanceColor = stashed
      delete mesh.userData.dribbleInstanceColor
    }
  })
}

/** Static geometry: no per-frame matrix updates, bounds computed once (instances included). */
function freeze(root: THREE.Object3D) {
  root.traverse(node => {
    node.matrixAutoUpdate = false
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
      ;(mesh as THREE.InstancedMesh).computeBoundingSphere()
      ;(mesh as THREE.InstancedMesh).computeBoundingBox()
    } else {
      mesh.geometry.computeBoundingSphere()
    }
    mesh.frustumCulled = true
  })
  root.updateMatrixWorld(true)
  // computed before the root joins the world group: the next scene update redoes it with the group's matrix
  root.matrixWorldNeedsUpdate = true
}

/** The materials applyBspMaterials created for this file (the module-level shared ones excluded). */
function forEachOwnMaterial(root: THREE.Object3D, callback: (material: THREE.Material) => void) {
  const seen = new Set<THREE.Material>()
  root.traverse(node => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    materials.forEach(material => {
      if (!material || seen.has(material) || isSharedMapMaterial(material)) return
      seen.add(material)
      callback(material)
    })
  })
}

function disposeProps(root: THREE.Object3D) {
  // Instance colours moved aside in wireframe mode go back first: three frees the GPU buffer of
  // `instanceColor` only while it is set.
  setInstanceLight(root, true)
  root.traverse(node => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    mesh.geometry?.dispose()
    if ((mesh as THREE.InstancedMesh).isInstancedMesh) (mesh as THREE.InstancedMesh).dispose()
  })
}

/** Instance id of row i of a staticProps node: the static prop index, or the prop_dynamic entity. */
const instanceIdOf = (info: { staticProps?: number[]; entities?: number[] }, i: number): string => {
  const index = info.staticProps?.[i] ?? -1
  return index >= 0 ? `sp:${index}` : `ent:${info.entities?.[i] ?? -1}`
}

/**
 * A model with an unlit part (UnlitGeneric) lists its instances twice, on the lit node and on the
 * `_unlit` node. Probes keep one row per instance, preferring the lit node's.
 */
function keepRow<T extends { lighting: string }>(rows: Map<string, T>, id: string, row: T) {
  const seen = rows.get(id)
  if (!seen || (seen.lighting === 'unlit' && row.lighting !== 'unlit')) rows.set(id, row)
}

/**
 * Instances of the loaded props.glb whose node name or model path contains `filter` (all without one):
 * static prop index, Source origin and scene position (Source - parsedDemo.world.boundaryMin).
 */
type PropInstanceRow = {
  node: string
  model: string
  staticProp: number
  entity: number
  source: number[]
  scene: number[]
  lighting: string
}

function propInstanceRows(root: THREE.Object3D | null, filter?: string): PropInstanceRow[] {
  const origin = useInstance.getState().parsedDemo?.world?.boundaryMin ?? { x: 0, y: 0, z: 0 }
  const needle = filter ? String(filter).toLowerCase() : null
  const rows = new Map<string, PropInstanceRow>()
  root?.traverse(node => {
    const info = node.userData?.dribble
    if (info?.kind !== 'staticProps') return
    ;(info.origins ?? []).forEach((source: number[], i: number) => {
      const model: string = info.models?.[i] ?? info.model ?? ''
      if (needle && !`${node.name} ${model}`.toLowerCase().includes(needle)) return
      keepRow(rows, instanceIdOf(info, i), {
        node: node.name,
        model,
        staticProp: info.staticProps?.[i] ?? -1,
        entity: info.entities?.[i] ?? -1,
        source,
        scene: [source[0] - origin.x, source[1] - origin.y, source[2] - origin.z].map(v => Math.round(v)),
        lighting: info.lighting?.[i] ?? 'unknown',
      })
    })
  })
  return [...rows.values()]
}

type InstanceOrder = { staticProp: number; entity: number; node: string }
const byInstance = (a: InstanceOrder, b: InstanceOrder) =>
  a.staticProp - b.staticProp || a.entity - b.entity || a.node.localeCompare(b.node)

/**
 * Instances of the loaded props.glb whose node name or model path contains `filter` (all without one):
 * static prop index, Source origin and scene position (Source - parsedDemo.world.boundaryMin). While stock
 * props are drawn their rows join, marked source: 'stock' with the Source origin as `origin`; PAK rows keep
 * today's shape.
 */
registerHlProbe('map.propInstances', (filter?: string) => {
  const pak = propInstanceRows(currents.pak.root, filter)
  if (!currents.stock.root) return pak.sort(byInstance)
  // `source` of a PAK row is its Source origin; a stock row is marked source: 'stock' (asset contract 9)
  // and carries its Source origin as `origin`.
  const stock = propInstanceRows(currents.stock.root, filter).map(({ source, ...row }) => ({
    ...row,
    origin: source,
    source: 'stock' as const,
  }))
  return [...pak, ...stock].sort(byInstance)
})

function summarizeProps(current: PropsCurrent) {
  const root = current.root
  let nodes = 0
  let instancedMeshes = 0
  let gpuInstances = 0
  let meshes = 0
  let triangles = 0
  let drawnTriangles = 0
  let visibleMeshes = 0
  const instanceLighting = new Map<string, { lighting: string }>()
  const materials = new Set<string>()
  const colorScale = new Set<number>()
  const models: { name: string; instances: number; lighting: string[] }[] = []
  root?.traverse(node => {
    const info = node.userData?.dribble
    if (info?.kind === 'staticProps') {
      nodes += 1
      models.push({
        name: node.name,
        instances: info.instances,
        lighting: [...new Set<string>(info.lighting ?? [])],
      })
      ;(info.staticProps ?? []).forEach((_: number, i: number) => {
        keepRow(instanceLighting, instanceIdOf(info, i), { lighting: info.lighting?.[i] ?? 'unknown' })
      })
    }
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    meshes += 1
    const count = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh).count : 1
    if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
      instancedMeshes += 1
      gpuInstances += count
    }
    const index = mesh.geometry.index
    triangles += ((index ? index.count : mesh.geometry.attributes.position.count) / 3) * count
    let visible = true
    for (let parent: THREE.Object3D | null = mesh; parent; parent = parent.parent) {
      if (!parent.visible) visible = false
    }
    if (visible) {
      visibleMeshes += 1
      const total = index ? index.count : mesh.geometry.attributes.position.count
      drawnTriangles += (Math.min(total, mesh.geometry.drawRange.count) / 3) * count
    }
    const material = mesh.material as THREE.Material
    if (material) {
      materials.add(material.name || material.type)
      if (material instanceof THREE.MeshBasicMaterial) colorScale.add(material.color.r)
    }
  })
  const rootInfo = root?.children[0]?.userData?.dribble
  const lighting: Record<string, number> = {}
  instanceLighting.forEach(({ lighting: kind }) => {
    lighting[kind] = (lighting[kind] ?? 0) + 1
  })
  return {
    rootInfo,
    url: current.url ?? null,
    state: current.state,
    error: current.error,
    mode: current.mode,
    materialMode: current.materialMode,
    brightness: current.brightness,
    attached: Boolean(root?.parent),
    visible: root ? root.visible : null,
    pak: rootInfo?.pak ?? null,
    instances: instanceLighting.size,
    lighting,
    nodes,
    meshes,
    visibleMeshes,
    instancedMeshes,
    gpuInstances,
    triangles: Math.round(triangles),
    materials: [...materials].sort(),
    colorScale: [...colorScale],
    models,
    // Pack files only (M3-props2): textures held, far-LOD rows and the triangles drawn now.
    ...(current.textures ? { textures: current.textures } : {}),
    ...(current.lod ? { lod: current.lod.stats(), drawnTriangles: Math.round(drawnTriangles) } : {}),
    ...(current.batch ? { batch: current.batch } : {}),
  }
}

/**
 * The loaded props.glb (today's fields, unchanged without a pack). While stock props are drawn, `stock`
 * holds the same summary of props-stock.glb, its model rows marked source: 'stock'.
 */
registerHlProbe('map.props', () => {
  const { rootInfo: _pakRoot, ...pak } = summarizeProps(currents.pak)
  if (!currents.stock.root) return pak
  const { rootInfo, pak: _none, models, ...stock } = summarizeProps(currents.stock)
  return {
    ...pak,
    stock: {
      ...stock,
      source: 'stock' as const,
      stock: rootInfo?.stock ?? null,
      models: models.map(model => ({ ...model, source: 'stock' as const })),
    },
  }
})

// ─── stock props from the asset pack (asset contract 3.5 and 9 "M3-props") ─────────────────────────

/** Folders whose pack entry did not match the public files this page (one warning each). */
const staleFolders = new Set<string>()

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * The pack's props-stock.glb for a loaded bsp-to-glb map folder, or null: no pack, pack not ready,
 * assets.enabled (or ?assets=off) or assets.stockProps off, no entry or file for the folder, or an entry
 * built from another BSP (mapName or publicProps differ from the public conversion.json). A stale entry
 * logs one warning per page and its files are marked skipped, so they are never requested.
 */
export function useStockProps(
  folder: string | undefined,
  conversion: MapConversion | null
): { url: string; key: string } | null {
  return usePackPropsFile(folder, conversion, 'propsStock')
}

/**
 * The pack's props-pak.glb (M3-props2: the PAK props with VPK materials) that World draws in place of public
 * props.glb, or null: as useStockProps, but gated by assets.mapTextures instead of assets.stockProps.
 */
export function usePackPakProps(
  folder: string | undefined,
  conversion: MapConversion | null
): { url: string; key: string } | null {
  return usePackPropsFile(folder, conversion, 'propsPak')
}

/**
 * The pack's props-sky.glb (as/mapfx: the static props inside the 3D skybox) of a pack world, or null: as
 * usePackPakProps, and also null while assets.skybox3d is off.
 */
export function usePackSkyProps(
  folder: string | undefined,
  conversion: MapConversion | null
): { url: string; key: string } | null {
  return usePackPropsFile(folder, conversion, 'propsSky')
}

function usePackPropsFile(
  folder: string | undefined,
  conversion: MapConversion | null,
  which: 'propsStock' | 'propsPak' | 'propsSky'
): { url: string; key: string } | null {
  const pack = useAssetPack()
  const enabled = useAssetSetting('enabled')
  const stockProps = useAssetSetting(which === 'propsStock' ? 'stockProps' : 'mapTextures')
  const sky = useAssetSetting('skybox3d')
  const entry = folder && pack.status === 'ready' ? pack.manifest?.maps?.[folder] : undefined
  const identity = entry ? publicMapIdentity(conversion) : null
  const stale =
    !!entry &&
    (!identity ||
      entry.mapName !== identity.mapName ||
      canonical(entry.publicProps ?? null) !== canonical(identity.props))

  useEffect(() => {
    if (!stale || !folder || !entry || staleFolders.has(folder)) return
    staleFolders.add(folder)
    console.warn(`[assets] maps/${folder} was built from another BSP; using public files`)
    for (const file of Object.values(entry.files ?? {})) skipAssetItem(file, 'stale map entry')
  }, [stale, folder, entry])

  if (!folder || !entry || stale || !enabled || !stockProps || (which === 'propsSky' && !sky)) return null
  const file = entry.files?.[which]
  const url = file ? assetPackFile(file) : null
  return file && url ? { url, key: file } : null
}
