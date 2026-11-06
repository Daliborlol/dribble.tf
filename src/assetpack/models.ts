// World models from the pack (asset contract 12.4). One cache entry per model key, reference-counted, with
// one template per skin: the source GLB scene (geometry shared by every copy), its materials cloned per skin
// with that skin's textures bound and its shaders compiled. instantiate(skin) clones the template (own bones
// when skinned). At zero references the entry disposes its geometry, its materials and its texture bindings.
//
// Copies are in Source units and axes: +X forward, +Z up, as scene space (a wrapper group turns the GLB's
// glTF axes back; the copy's own position, rotation and scale are free for the caller). Non-default
// bodygroups are hidden. Feature tasks draw `handle ? pack : placeholder`.

import { useEffect, useState, useSyncExternalStore } from 'react'
import { useThree } from '@react-three/fiber'
import { Group } from 'three'
import type { AnimationClip, Camera, Material, Matrix4, Mesh, Object3D, Scene, WebGLRenderer } from 'three'

import { getAssetSetting, useAssetSetting } from './hooks'
import { getAssetItem, loadPackItem, releaseAssetItem, subscribeAssetItems } from './items'
import { loadPackModel, mergeSkinnedByMaterial, shareEyeMaterial, warmUpObject } from './loaders'
import { freezeGeometryAfterFirstDraw, skipEmptyLeaves } from '@highlander/perf/sceneUpdate'
import type { PackModel } from './loaders'
import { bindPackTextures } from './modelTextures'
import { bindCharacterShading } from './characterShading'
import type { CharacterShadingBinding } from './characterShading'
import type { PackTextureBinding } from './modelTextures'
import { getAssetPackState, subscribeAssetPack } from './pack'

export interface PackModelAttachment {
  bone: string | null
  pos: [number, number, number]
  quat: [number, number, number, number]
}

export interface PackModelItem {
  kind: 'model'
  file: string
  bytes: number
  sha256: string
  stage: 'models'
  source: string
  role?: string
  textures: string[]
  skins: number
  teamSkins?: [number, number]
  variants?: Record<string, { skins?: number[] }>
  attachments: Record<string, PackModelAttachment>
  sequences: { name: string; frames: number; fps: number; clip: string | null }[]
  poseParams: Record<string, { min: number; max: number }>
  bodygroups?: { name: string; models: number }[]
  bounds: [[number, number, number], [number, number, number]]
}

export interface PackModelHandle {
  key: string
  info: PackModelItem
  clips: AnimationClip[]
  /** Shared geometry; materials shared per (model, skin); own bones when skinned. */
  instantiate(skin?: number): Object3D
  release(copy: Object3D): void
}

const modelItem = (key: string): PackModelItem | null => {
  const item = getAssetPackState().manifest?.items?.[key] as PackModelItem | undefined
  return item && item.kind === 'model' && typeof item.file === 'string' ? item : null
}

/** Pack ready, assets.enabled and assets.models on, the item listed and not failed. */
export function packModelListed(key: string): boolean {
  if (getAssetPackState().status !== 'ready') return false
  if (!getAssetSetting('enabled') || !getAssetSetting('models')) return false
  if (!modelItem(key)) return false
  return getAssetItem(key)?.state !== 'failed'
}

/** The skin of a team (2 RED, 3 BLU): `teamSkins` when the item has it, else 0 and 1 for models with skins. */
export function packTeamSkin(info: PackModelItem, team: number): number {
  const pair = info.teamSkins ?? (info.skins >= 2 ? [0, 1] : [0, 0])
  return team === 3 ? pair[1] : pair[0]
}

interface Entry {
  refs: number
  promise: Promise<PackModelHandle | null>
  model: PackModel | null
  templates: Object3D[]
  bindings: PackTextureBinding[]
  shadings: CharacterShadingBinding[]
  disposed: boolean
}

const cache = new Map<string, Entry>()

function collectMaterials(root: Object3D): Material[] {
  const out = new Set<Material>()
  root.traverse(node => {
    const m = (node as any).material as Material | Material[] | undefined
    if (Array.isArray(m)) m.forEach(x => x && out.add(x))
    else if (m) out.add(m)
  })
  return Array.from(out)
}

/** A copy of the source scene with its own materials (one clone per source material). */
function skinTemplate(model: PackModel): Object3D {
  // instantiate() rebinds bones to the copy (SkeletonUtils), which a plain clone(true) would not. The GLB is
  // glTF Y-up (its source_to_gltf node turns Source into glTF axes); the wrapper turns it back to Source's
  // Z-up, as the world group does for the map, so skinning stays exactly as the GLB defines it.
  const axes = new Group()
  axes.name = 'source_axes'
  axes.rotation.x = Math.PI / 2
  axes.add(model.instantiate())
  const template = new Group()
  template.name = 'pack-model'
  template.add(axes)
  template.updateMatrixWorld(true)
  const clones = new Map<Material, Material>()
  template.traverse(node => {
    const mesh = node as any
    if (!mesh.material) return
    const swap = (m: Material) => {
      let c = clones.get(m)
      if (!c) {
        c = m.clone()
        clones.set(m, c)
      }
      return c
    }
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material)
  })
  return template
}

function prepareSource(model: PackModel) {
  model.gltf.scene.traverse(node => {
    if (node.userData?.defaultBodygroup === false) node.visible = false
  })
}

function disposeEntry(key: string, entry: Entry) {
  if (entry.disposed) return
  entry.disposed = true
  for (const binding of entry.bindings) binding.release()
  for (const binding of entry.shadings) binding.release()
  for (const template of entry.templates) {
    for (const m of collectMaterials(template)) m.dispose()
    entry.model?.release(template)
  }
  entry.model?.dispose()
  entry.templates = []
  entry.bindings = []
  entry.shadings = []
  entry.model = null
  releaseAssetItem(key)
}

async function build(key: string, entry: Entry, renderer: WebGLRenderer, scene: Scene, camera: Camera) {
  const info = modelItem(key)
  if (!info) return null
  const model = await loadPackItem(key, url => loadPackModel(url))
  if (!model) return null
  if (entry.disposed || entry.refs <= 0) {
    model.dispose()
    return null
  }
  entry.model = model
  // as/perf: one draw per material for the player models (their meshes share one skeleton since shareSkins)
  if (info.role === 'player:model') {
    shareEyeMaterial(model.gltf.scene)
    mergeSkinnedByMaterial(model.gltf.scene)
  }
  prepareSource(model)
  const skins = Math.max(1, info.skins | 0)
  for (let skin = 0; skin < skins; skin++) {
    const template = skinTemplate(model)
    const binding = await bindPackTextures(template, renderer, { skin })
    const shading = await bindCharacterShading(template, renderer, { skin })
    if (entry.disposed) {
      // Released while binding: disposeEntry already ran, so this template is freed here.
      binding.release()
      shading.release()
      for (const m of collectMaterials(template)) m.dispose()
      model.release(template)
      return null
    }
    entry.templates.push(template)
    entry.bindings.push(binding)
    entry.shadings.push(shading)
    await warmUpObject(renderer, template, camera, scene)
    if (entry.disposed) return null
  }
  const templates = entry.templates
  const handle: PackModelHandle = {
    key,
    info,
    clips: model.gltf.animations ?? [],
    instantiate: (skin = 0) => {
      const template = templates[Math.min(Math.max(0, skin | 0), templates.length - 1)]
      const copy = model.skinned ? model.instantiateFrom(template) : template.clone(true)
      copy.traverse(node => {
        if ((node as Mesh).isMesh) freezeGeometryAfterFirstDraw(node as Mesh)
      })
      skipEmptyLeaves(copy)
      return copy
    },
    release: copy => model.release(copy),
  }
  return handle
}

/** Reference-counted; never rejects. null when absent, unlisted or failed. */
export function acquirePackModel(
  key: string,
  renderer: WebGLRenderer,
  scene: Scene,
  camera: Camera
): Promise<PackModelHandle | null> {
  let entry = cache.get(key)
  if (!entry) {
    const created: Entry = { refs: 0, promise: Promise.resolve(null), model: null, templates: [], bindings: [], shadings: [], disposed: false }
    created.promise = (packModelListed(key) ? build(key, created, renderer, scene, camera) : Promise.resolve(null)).catch(error => {
      console.warn(`[assets] ${key}: ${error instanceof Error ? error.message : String(error)}; using the fallback`)
      return null
    })
    cache.set(key, created)
    entry = created
    created.promise.then(handle => {
      // A failed or absent model does not stay cached, so a later mount after a pack change can try again.
      if (!handle && cache.get(key) === created && created.refs <= 0) cache.delete(key)
    })
  }
  entry.refs++
  return entry.promise
}

export function releasePackModel(key: string): void {
  const entry = cache.get(key)
  if (!entry) return
  entry.refs--
  if (entry.refs > 0) return
  cache.delete(key)
  disposeEntry(key, entry)
}

const getPackState = getAssetPackState
const noop = () => () => {}

/** Acquire on mount, release on unmount; null until loaded, bound and compiled, and whenever unlisted. */
export function usePackModel(key: string | null): PackModelHandle | null {
  const gl = useThree(s => s.gl)
  const scene = useThree(s => s.scene)
  const camera = useThree(s => s.camera)
  const pack = useSyncExternalStore(key ? subscribeAssetPack : noop, getPackState, getPackState)
  const enabled = useAssetSetting('enabled')
  const models = useAssetSetting('models')
  const failed = useSyncExternalStore(
    key ? subscribeAssetItems : noop,
    () => (key ? getAssetItem(key)?.state === 'failed' : false),
    () => false
  )
  const listed =
    !!key && pack.status === 'ready' && enabled && models && !failed && !!modelItem(key)
  const [loaded, setLoaded] = useState<PackModelHandle | null>(null)
  useEffect(() => {
    if (!listed || !key) return
    let alive = true
    acquirePackModel(key, gl, scene, camera).then(handle => {
      if (alive) setLoaded(handle)
    })
    return () => {
      alive = false
      setLoaded(null)
      releasePackModel(key)
    }
    // The camera only matters for the first compile; a camera change does not reload the model.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listed, key, gl, scene])
  return listed && loaded && loaded.key === key ? loaded : null
}

const attachmentNodes = new WeakMap<Object3D, Map<string, Object3D | null>>()

/** World matrix of attachment `name` on a copy; false when the model has none. */
export function attachmentMatrix(copy: Object3D, name: string, out: Matrix4): boolean {
  let nodes = attachmentNodes.get(copy)
  if (!nodes) {
    nodes = new Map()
    attachmentNodes.set(copy, nodes)
  }
  let node = nodes.get(name)
  if (node === undefined) {
    node = copy.getObjectByName(`attachment_${name}`) ?? null
    nodes.set(name, node)
  }
  if (!node) return false
  node.updateWorldMatrix(true, false)
  out.copy(node.matrixWorld)
  return true
}

/** Probe rows of the model cache (assets.models). */
export function listPackModels(filter?: string) {
  return Array.from(cache.entries())
    .filter(([key]) => !filter || key.includes(filter))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => ({
      key,
      refs: entry.refs,
      loaded: !!entry.model,
      skinned: entry.model?.skinned ?? null,
      templates: entry.templates.length,
      bound: entry.bindings.reduce((n, b) => n + b.bound, 0),
      failed: entry.bindings.reduce((n, b) => n + b.failed, 0),
      shaded: entry.shadings.reduce((n, b) => n + b.shaded, 0),
      clips: entry.model?.gltf.animations?.length ?? 0,
    }))
}
