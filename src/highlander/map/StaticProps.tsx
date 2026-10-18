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

import React, { useEffect, useRef, useState } from 'react'

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/Addons.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'

import { useInstance } from '@zus/store'
import { registerHlProbe } from '@highlander/debug'
import { useHlSetting } from '@highlander/extras/hooks'
import {
  BspMaterials,
  MapRenderMode,
  applyBspMaterials,
  isSharedMapMaterial,
} from '@highlander/map/bspMaterials'

export interface StaticPropsProps {
  /** props.glb of the map folder (conversion.json files.props), undefined when the map has none. */
  url: string | undefined
  mode: MapRenderMode
}

type PropsState = 'off' | 'loading' | 'ready' | 'error'

/** What the component shows right now, for the probe (one World, so one entry). */
const current: {
  url: string | undefined
  state: PropsState
  error: string | null
  root: THREE.Object3D | null
  mode: MapRenderMode | null
  /** The material rules actually applied: untextured shows the props with their textured material. */
  materialMode: MapRenderMode | null
  brightness: number | null
} = { url: undefined, state: 'off', error: null, root: null, mode: null, materialMode: null, brightness: null }

export const StaticProps = React.memo(({ url, mode }: StaticPropsProps) => {
  const enabled = useHlSetting<boolean>('map.staticProps') ?? true
  const brightness = useHlSetting<number>('map.brightness') ?? 1
  const [loaded, setLoaded] = useState<{ url: string; root: THREE.Group } | null>(null)
  const requestRef = useRef(0)
  const materialsRef = useRef<BspMaterials | null>(null)
  const brightnessRef = useRef(brightness)
  brightnessRef.current = brightness

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
    new GLTFLoader()
      .setMeshoptDecoder(MeshoptDecoder)
      .loadAsync(url)
      .then(gltf => {
        if (request !== requestRef.current) {
          disposeProps(gltf.scene)
          return
        }
        freeze(gltf.scene)
        setLoaded({ url, root: gltf.scene })
      })
      .catch(error => {
        if (request !== requestRef.current) return
        current.state = 'error'
        current.error = error instanceof Error ? error.message : String(error)
        console.warn(`Static props unavailable: ${url}`, error)
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
    return () => {
      disposeProps(loaded.root)
      if (current.root === loaded.root) {
        current.root = null
        current.state = 'off'
      }
    }
  }, [loaded])

  // The world.glb material rules. Baked light needs no scene lights: untextured keeps the unlit
  // textured material, wireframe uses the shared wireframe material without the instance light.
  const materialMode: MapRenderMode = mode === 'wireframe' ? 'wireframe' : 'textured'
  useEffect(() => {
    if (!loaded) return
    const materials = applyBspMaterials(loaded.root, {
      mode: materialMode,
      lightmap: null,
      lightmapRange: 1,
      brightness: brightnessRef.current,
    })
    materialsRef.current = materials
    setInstanceLight(loaded.root, materialMode !== 'wireframe')
    current.materialMode = materialMode
    return () => {
      if (materialsRef.current === materials) materialsRef.current = null
      materials.dispose()
    }
  }, [loaded, materialMode])
  useEffect(() => {
    current.mode = mode
  }, [mode])

  // map.brightness: the vertex colours already hold the baked light, so the colour scales them.
  useEffect(() => {
    if (!loaded) return
    materialsRef.current?.setBrightness(brightness)
    forEachOwnMaterial(loaded.root, material => {
      if (material instanceof THREE.MeshBasicMaterial) material.color.setScalar(brightness)
    })
    current.brightness = brightness
  }, [loaded, materialMode, brightness])

  // Hidden props must also stop catching the world raycasts (RTS centre, stickers), which check each
  // hit object's own `visible` flag, so the meshes are toggled with the root.
  useEffect(() => {
    if (!loaded) return
    loaded.root.traverse(node => {
      if ((node as THREE.Mesh).isMesh) node.visible = enabled
    })
    loaded.root.visible = enabled
  }, [loaded, enabled])

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
    []
  )

  return loaded && loaded.url === url ? <primitive object={loaded.root} /> : null
})

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
registerHlProbe('map.propInstances', (filter?: string) => {
  const origin = useInstance.getState().parsedDemo?.world?.boundaryMin ?? { x: 0, y: 0, z: 0 }
  const needle = filter ? String(filter).toLowerCase() : null
  const rows = new Map<
    string,
    {
      node: string
      model: string
      staticProp: number
      entity: number
      source: number[]
      scene: number[]
      lighting: string
    }
  >()
  current.root?.traverse(node => {
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
  return [...rows.values()].sort(
    (a, b) => a.staticProp - b.staticProp || a.entity - b.entity || a.node.localeCompare(b.node)
  )
})

registerHlProbe('map.props', () => {
  const root = current.root
  let nodes = 0
  let instancedMeshes = 0
  let gpuInstances = 0
  let meshes = 0
  let triangles = 0
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
    if (visible) visibleMeshes += 1
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
  }
})
