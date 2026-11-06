// Model loading helpers for pack items (asset contract 3.6, 3.10 and 4.3). GLTFLoader, the meshopt decoder and
// SkeletonUtils load through dynamic import(), so a page without a pack runs none of this code. Everything
// returned owns GPU objects the caller disposes; nothing is owned by JSX.

import { BufferAttribute, BufferGeometry, Matrix3, Matrix4, Vector3 } from 'three'
import type { Camera, Material, Object3D, Scene, Skeleton, SkinnedMesh, Texture, WebGLRenderer } from 'three'
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

// ---- one skeleton per bone set (as/perf) -------------------------------------------------------------------
// The exporter writes one glTF skin per mesh, because each mesh's positions are quantized with their own scale and
// offset, which gltfpack folds into that skin's inverse bind matrices. GLTFLoader then gives every mesh its own
// Skeleton, and three computes and uploads a bone texture per skeleton every frame (8 per player model). When the
// skins of the meshes over one bone list differ by one constant matrix C (boneInverse_m[j] = boneInverse_r[j] x C
// for every joint j), the mesh's positions and normals take that matrix once at load and the mesh binds the
// reference mesh's skeleton: the skinned result is the same up to float rounding, with one skeleton per bone set.

const _m = new Matrix4()
const _c = new Matrix4()
const _v = new Vector3()

function sameMatrix(a: Matrix4, b: Matrix4, tol: number): boolean {
  for (let i = 0; i < 16; i++) if (Math.abs(a.elements[i] - b.elements[i]) > tol) return false
  return true
}

function transformedAttribute(attr: BufferAttribute, apply: (v: Vector3) => void): BufferAttribute {
  const out = new Float32Array(attr.count * 3)
  for (let i = 0; i < attr.count; i++) {
    _v.fromBufferAttribute(attr, i)
    apply(_v)
    out[i * 3] = _v.x
    out[i * 3 + 1] = _v.y
    out[i * 3 + 2] = _v.z
  }
  return new BufferAttribute(out, 3)
}

/** Rebinds the skinned meshes of a loaded scene that share a bone list to one skeleton (see above). */
function shareSkins(root: Object3D): void {
  const groups = new Map<Object3D, SkinnedMesh[]>()
  root.updateMatrixWorld(true)
  root.traverse(node => {
    const mesh = node as SkinnedMesh
    if (!mesh.isSkinnedMesh || !mesh.skeleton?.bones.length || mesh.bindMode !== 'attached') return
    const key = mesh.skeleton.bones[0]
    const list = groups.get(key)
    if (list) list.push(mesh)
    else groups.set(key, [mesh])
  })
  for (const list of groups.values()) {
    const ref = list[0]
    const refBones = ref.skeleton.bones
    const refInv = ref.skeleton.boneInverses
    if (refInv.length !== refBones.length) continue
    for (let k = 1; k < list.length; k++) {
      const mesh = list[k]
      const { bones, boneInverses } = mesh.skeleton
      if (bones.length !== refBones.length || boneInverses.length !== bones.length) continue
      if (bones.some((b, j) => b !== refBones[j])) continue
      // C = inv(boneInverse_r[0]) x boneInverse_m[0], checked against every joint
      _c.copy(refInv[0]).invert().multiply(boneInverses[0])
      const scale = Math.max(1, ...(_c.elements.map(Math.abs) as number[]))
      let constant = true
      for (let j = 1; j < bones.length && constant; j++) {
        _m.copy(refInv[j]).invert().multiply(boneInverses[j])
        constant = sameMatrix(_m, _c, 1e-4 * scale)
      }
      if (!constant) continue
      // positions: inv(bind_r) x C x bind_m; normals and tangents: the same matrix's linear part, as the skin
      // matrix applied it before
      const full = new Matrix4().copy(ref.bindMatrix).invert().multiply(_c).multiply(mesh.bindMatrix)
      const linear = new Matrix3().setFromMatrix4(full)
      const source = mesh.geometry as BufferGeometry
      if (Object.keys(source.morphAttributes).length) continue
      const geometry = source.clone()
      const position = source.getAttribute('position') as BufferAttribute | undefined
      if (!position) continue
      geometry.setAttribute('position', transformedAttribute(position, v => v.applyMatrix4(full)))
      const normal = source.getAttribute('normal') as BufferAttribute | undefined
      if (normal) geometry.setAttribute('normal', transformedAttribute(normal, v => v.applyMatrix3(linear)))
      const tangent = source.getAttribute('tangent') as BufferAttribute | undefined
      if (tangent) {
        const out = new Float32Array(tangent.count * 4)
        for (let i = 0; i < tangent.count; i++) {
          _v.fromBufferAttribute(tangent, i).applyMatrix3(linear)
          out.set([_v.x, _v.y, _v.z, tangent.getW(i)], i * 4)
        }
        geometry.setAttribute('tangent', new BufferAttribute(out, 4))
      }
      geometry.boundingBox = null
      geometry.boundingSphere = null
      source.dispose()
      mesh.geometry = geometry
      const old = mesh.skeleton
      mesh.bind(ref.skeleton, ref.bindMatrix)
      old.dispose()
    }
  }
}

/**
 * Merges the default-visible opaque skinned meshes that share one skeleton, bind matrix and material into one mesh
 * (as/perf; player models only, called by models.ts): a pack player draws 4 to 8 meshes, often several with the
 * same material (the scout's body parts, the pyro's five), and every draw costs the renderer the same whatever its
 * size. Attributes become float arrays (skin indices 16-bit), which the shader reads as the same values; triangle
 * order within the merged mesh is the old draw order. Meshes of hidden bodygroups keep their own mesh.
 */
export function mergeSkinnedByMaterial(root: Object3D): number {
  const groups = new Map<string, SkinnedMesh[]>()
  root.traverse(node => {
    const mesh = node as SkinnedMesh
    if (!mesh.isSkinnedMesh || !mesh.skeleton || Array.isArray(mesh.material)) return
    if (node.userData?.defaultBodygroup === false || !mesh.visible || mesh.children.length) return
    const material = mesh.material as Material
    if (material.transparent) return
    const geometry = mesh.geometry as BufferGeometry
    if (geometry.groups.length > 1 || Object.keys(geometry.morphAttributes).length) return
    const names = Object.keys(geometry.attributes).sort()
    const key = [mesh.skeleton.uuid, material.uuid, mesh.parent?.uuid, mesh.bindMatrix.elements.join(','), mesh.matrix.elements.join(','), names.map(n => `${n}:${geometry.attributes[n].itemSize}`).join(',')].join('|')
    const list = groups.get(key)
    if (list) list.push(mesh)
    else groups.set(key, [mesh])
  })
  let merged = 0
  for (const list of groups.values()) {
    if (list.length < 2) continue
    const first = list[0].geometry as BufferGeometry
    const names = Object.keys(first.attributes)
    let vertices = 0
    let indices = 0
    for (const m of list) {
      const g = m.geometry as BufferGeometry
      vertices += g.attributes.position.count
      indices += g.index ? g.index.count : g.attributes.position.count
    }
    const out = new BufferGeometry()
    for (const name of names) {
      const size = first.attributes[name].itemSize
      const array = name === 'skinIndex' ? new Uint16Array(vertices * size) : new Float32Array(vertices * size)
      let base = 0
      for (const m of list) {
        const attr = (m.geometry as BufferGeometry).attributes[name] as BufferAttribute
        for (let i = 0; i < attr.count; i++) {
          for (let c = 0; c < size; c++) array[(base + i) * size + c] = attr.getComponent(i, c)
        }
        base += attr.count
      }
      out.setAttribute(name, new BufferAttribute(array, size))
    }
    const index = vertices > 65535 ? new Uint32Array(indices) : new Uint16Array(indices)
    let vBase = 0
    let iBase = 0
    for (const m of list) {
      const g = m.geometry as BufferGeometry
      const count = g.attributes.position.count
      if (g.index) for (let i = 0; i < g.index.count; i++) index[iBase++] = g.index.getX(i) + vBase
      else for (let i = 0; i < count; i++) index[iBase++] = vBase + i
      vBase += count
    }
    out.setIndex(new BufferAttribute(index, 1))
    const keep = list[0]
    for (let k = 1; k < list.length; k++) {
      list[k].geometry.dispose()
      list[k].removeFromParent()
    }
    keep.geometry.dispose()
    keep.geometry = out
    merged += list.length - 1
  }
  return merged
}

/**
 * SkeletonUtils.clone gives every mesh its own Skeleton again; the clones of meshes that shared one share their
 * boneInverses array and bones, so they share one skeleton again here.
 */
function regroupSkeletons(copy: Object3D): Object3D {
  const byInverses = new Map<Matrix4[], Skeleton>()
  copy.traverse(node => {
    const mesh = node as SkinnedMesh
    if (!mesh.isSkinnedMesh || !mesh.skeleton) return
    const shared = byInverses.get(mesh.skeleton.boneInverses)
    if (!shared) byInverses.set(mesh.skeleton.boneInverses, mesh.skeleton)
    else if (shared !== mesh.skeleton && shared.bones.every((b, j) => b === mesh.skeleton.bones[j])) mesh.skeleton = shared
  })
  return copy
}

/**
 * Nothing drives a pack model's flexes (their influences stay 0), so the morph data only costs: each head and eyeball
 * keeps its own Skeleton and bone texture (shareSkins skips morphed meshes), its own program per morph count, a
 * morph texture, and the morph path of the renderer and the vertex shader on every draw.
 */
function stripMorphTargets(root: Object3D): void {
  root.traverse(node => {
    const mesh = node as SkinnedMesh
    if (!mesh.isMesh) return
    const geometry = mesh.geometry as BufferGeometry
    if (geometry && Object.keys(geometry.morphAttributes).length) {
      geometry.morphAttributes = {}
      geometry.morphTargetsRelative = false
    }
    if (mesh.morphTargetInfluences) {
      delete (mesh as { morphTargetInfluences?: number[] }).morphTargetInfluences
      delete (mesh as { morphTargetDictionary?: unknown }).morphTargetDictionary
    }
  })
}

export async function loadPackModel(url: string): Promise<PackModel> {
  const [{ clone }, gltf] = await Promise.all([loadLibs(), loadPackGltf(url)])
  let skinned = false
  gltf.scene.traverse(node => {
    if ((node as any).isSkinnedMesh) skinned = true
  })
  stripMorphTargets(gltf.scene)
  if (skinned) shareSkins(gltf.scene)
  let disposed = false
  return {
    gltf,
    skinned,
    instantiate: () => (skinned ? regroupSkeletons(clone(gltf.scene)) : gltf.scene.clone(true)),
    instantiateFrom: template => (skinned ? regroupSkeletons(clone(template)) : template.clone(true)),
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
    // renderer.compile plus our own wait instead of compileAsync: compileAsync's poll reads the program of every
    // material it compiled and throws (an uncaught error in a timer; its promise never settles) once one of them
    // was disposed meanwhile, as when a model is released during its warm-up (demo reloads, weapon switches)
    const materials = renderer.compile(object, camera, scene) as unknown as Set<Material> | undefined
    const parallel = !!renderer.extensions?.has?.('KHR_parallel_shader_compile')
    if (!materials || !parallel) return
    const pending = (m: Material) => {
      const program = (renderer.properties.get(m) as any)?.currentProgram
      return !!program && typeof program.isReady === 'function' && !program.isReady()
    }
    const started = performance.now()
    while (Array.from(materials).some(pending) && performance.now() - started < 10000) {
      await new Promise(resolve => setTimeout(resolve, 10))
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
