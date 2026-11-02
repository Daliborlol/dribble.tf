// Model loading helpers for pack items (asset contract 3.6, 3.10 and 4.3). GLTFLoader, the meshopt decoder and
// SkeletonUtils load through dynamic import(), so a page without a pack runs none of this code. Everything
// returned owns GPU objects the caller disposes; nothing is owned by JSX.

import type { Camera, Material, Object3D, Scene, Texture, WebGLRenderer } from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'

import { ASSET_PACK_URL } from './config'
import { getAssetPackState, subscribeAssetPack } from './pack'

type Libs = {
  loader: import('three/examples/jsm/loaders/GLTFLoader.js').GLTFLoader
  clone: (source: Object3D) => Object3D
}

let libs: Promise<Libs> | null = null

function loadLibs(): Promise<Libs> {
  if (!libs) {
    libs = Promise.all([
      import('three/examples/jsm/loaders/GLTFLoader.js'),
      import('three/examples/jsm/libs/meshopt_decoder.module.js'),
      import('three/addons/utils/SkeletonUtils.js'),
    ]).then(([{ GLTFLoader }, { MeshoptDecoder }, SkeletonUtils]) => ({
      loader: new GLTFLoader().setMeshoptDecoder(MeshoptDecoder),
      clone: SkeletonUtils.clone,
    }))
    libs.catch(() => {
      libs = null
    })
  }
  return libs
}

/** Loads a pack GLB with the meshopt decoder. The caller owns the result: dispose it with disposeObject3D(gltf.scene). */
export async function loadPackGltf(url: string): Promise<GLTF> {
  const { loader } = await loadLibs()
  return loader.loadAsync(url)
}

const isTexture = (value: unknown): value is Texture =>
  !!value && (value as Texture).isTexture === true

function disposeMaterial(material: Material, seen: Set<unknown>) {
  if (seen.has(material)) return
  seen.add(material)
  const disposeTexture = (value: unknown) => {
    if (isTexture(value) && !seen.has(value)) {
      seen.add(value)
      value.dispose()
    }
  }
  for (const value of Object.values(material)) disposeTexture(value)
  // ShaderMaterial and onBeforeCompile materials keep textures in their uniforms.
  const uniforms = (material as any).uniforms as Record<string, { value?: unknown }> | undefined
  if (uniforms && typeof uniforms === 'object') {
    for (const uniform of Object.values(uniforms)) {
      const value = uniform?.value
      if (Array.isArray(value)) value.forEach(disposeTexture)
      else disposeTexture(value)
    }
  }
  material.dispose()
}

/** Disposes every geometry, material, texture and skeleton under `root`, each once. */
export function disposeObject3D(root: Object3D | null | undefined): void {
  if (!root) return
  const seen = new Set<unknown>()
  root.traverse(node => {
    const mesh = node as any
    if (mesh.geometry && !seen.has(mesh.geometry)) {
      seen.add(mesh.geometry)
      mesh.geometry.dispose()
    }
    const material = mesh.material as Material | Material[] | undefined
    if (Array.isArray(material)) material.forEach(m => m && disposeMaterial(m, seen))
    else if (material) disposeMaterial(material, seen)
    if (mesh.isSkinnedMesh && mesh.skeleton && !seen.has(mesh.skeleton)) {
      seen.add(mesh.skeleton)
      mesh.skeleton.dispose()
    }
  })
}

function disposeSkeletons(root: Object3D) {
  const seen = new Set<unknown>()
  root.traverse(node => {
    const mesh = node as any
    if (mesh.isSkinnedMesh && mesh.skeleton && !seen.has(mesh.skeleton)) {
      seen.add(mesh.skeleton)
      mesh.skeleton.dispose()
    }
  })
}

/**
 * A loaded pack model. `instantiate()` returns a copy that shares geometry and materials with the source
 * (SkeletonUtils.clone when skinned, so every copy has its own bones); `release(copy)` frees what a copy owns
 * (its skeletons); `dispose()` frees the shared GPU objects once no copy is drawn.
 */
export interface PackModel {
  gltf: GLTF
  skinned: boolean
  instantiate(): Object3D
  /** A copy of `template` (a clone of gltf.scene that may carry its own materials), own bones when skinned. */
  instantiateFrom(template: Object3D): Object3D
  release(copy: Object3D): void
  dispose(): void
}

export async function loadPackModel(url: string): Promise<PackModel> {
  const [{ clone }, gltf] = await Promise.all([loadLibs(), loadPackGltf(url)])
  let skinned = false
  gltf.scene.traverse(node => {
    if ((node as any).isSkinnedMesh) skinned = true
  })
  let disposed = false
  return {
    gltf,
    skinned,
    instantiate: () => (skinned ? clone(gltf.scene) : gltf.scene.clone(true)),
    instantiateFrom: template => (skinned ? clone(template) : template.clone(true)),
    release: copy => {
      if (skinned) disposeSkeletons(copy)
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      disposeObject3D(gltf.scene)
    },
  }
}

/**
 * Compiles the programs `object` needs before it joins the drawn scene (contract 4.3). `scene` must be the
 * scene the object will be drawn in (the r3f scene from useThree): its lights, fog and environment are part of
 * the program key, so compiling against any other scene can leave the first draw to compile again. Never
 * rejects: a compile failure leaves the first draw to compile.
 */
export async function warmUpObject(
  renderer: WebGLRenderer,
  object: Object3D,
  camera: Camera,
  scene: Scene
): Promise<void> {
  try {
    if (!scene || !(scene as any).isScene) {
      console.warn('[assets] warmUpObject needs the drawn scene; skipping the warm-up')
      return
    }
    if (typeof (renderer as any).compileAsync === 'function') {
      await (renderer as any).compileAsync(object, camera, scene)
    } else {
      renderer.compile(object, camera, scene)
    }
  } catch (error) {
    console.warn('[assets] shader warm-up failed', error)
  }
}

// The model probes (modelProbes.ts) load only once a pack is ready, so a page without one requests nothing.
let modelProbesRequested = false
if (ASSET_PACK_URL) {
  const loadModelProbes = () => {
    if (modelProbesRequested || getAssetPackState().status !== 'ready') return
    modelProbesRequested = true
    import('./modelProbes').catch(error => console.warn('[assets] model probes failed to load', error))
  }
  subscribeAssetPack(loadModelProbes)
  loadModelProbes()
}
