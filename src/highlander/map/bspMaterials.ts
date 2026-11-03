// Material rules of the bsp-to-glb pipeline (contract section 4.5 item 2; owner M1). World.tsx applies
// them to world.glb; M2's StaticProps applies the same rules to props.glb (section 4.8 item 5).
//
// scripts/convert-bsp.mjs writes `userData.dribble = { kind, lightmap, hiddenByDefault? }` on every GLB
// material. applyBspMaterials() swaps each mesh's material for one shared material per kind and mode:
//   textured    MeshBasicMaterial: vertex colours (the compile-time albedo) times the lightmap atlas
//   untextured  MeshLambertMaterial with vertex colours, lit by Lights.tsx
//   wireframe   MAP_WIREFRAME_MATERIAL, the viewer's wireframe material for every map pipeline
// It remembers the converter info on `mesh.userData.dribbleMaterial`, so a later call with another mode
// (or a caller such as the respawn-visualizer toggle) still finds it after the swap.
//
// Textured pack worlds (asset contract 12.5): a material whose info carries `texture` (convert-bsp.mjs
// --texture-uvs) and whose texture is in `options.textures` gets its own MeshBasicMaterial per (kind, lightmap,
// texture): the pack texture times the lightmap, the alpha rule of contract 2.6, and for WorldVertexTransition
// a second texture blended by the vertex attribute. Without its texture it draws the flat albedo as before.

import * as THREE from 'three'

import {
  applyPackTextureAlpha,
  getPackTextureItem,
  packTextureForChannel,
  type PackTextureRecord,
} from '@pack/textures'

export type MapRenderMode = 'textured' | 'untextured' | 'wireframe'

/** `material.userData.dribble` of a bsp-to-glb material (scripts/convert-bsp.mjs). */
export interface BspMaterialInfo {
  kind: 'opaque' | 'translucent' | 'water' | 'unlit' | 'visualizer' | string
  lightmap: boolean
  hiddenByDefault?: boolean // respawn-room visualizers: shown only with settings map.respawnVisualizers
  texture?: PackTextureRecord // textured pack worlds only
  /** kind 'overlay' (pack worlds, convert-bsp.mjs --overlays): 'modulate' for DecalModulate materials. */
  overlay?: { blend?: 'alpha' | 'modulate'; order?: number }
}

/** Overlays without their pack texture draw nothing (their flat albedo would be a coloured rectangle). */
const BSP_OVERLAY_HIDDEN_MATERIAL = new THREE.MeshBasicMaterial({ visible: false })

export const MAP_WIREFRAME_MATERIAL = new THREE.MeshStandardMaterial({
  color: '#333333',
  opacity: 0.1,
  transparent: true,
  wireframe: true,
})

const BSP_UNTEXTURED_MATERIAL = new THREE.MeshLambertMaterial({ vertexColors: true })
const BSP_UNTEXTURED_TRANSLUCENT_MATERIAL = new THREE.MeshLambertMaterial({
  vertexColors: true,
  transparent: true,
  depthWrite: false,
  side: THREE.DoubleSide,
})

const MODULE_MATERIALS = new Set<THREE.Material>([
  MAP_WIREFRAME_MATERIAL,
  BSP_OVERLAY_HIDDEN_MATERIAL,
  BSP_UNTEXTURED_MATERIAL,
  BSP_UNTEXTURED_TRANSLUCENT_MATERIAL,
])

/** True for the module-level materials above: they outlive every map, so never dispose them. */
export const isSharedMapMaterial = (material: THREE.Material): boolean =>
  MODULE_MATERIALS.has(material)

/**
 * lightMapIntensity of a lit material: three divides lightmaps by PI, and the atlas stores linear light
 * divided by `range` (conversion.json lightmap.range). brightness = settings.highlander.map.brightness.
 */
export const bspLightMapIntensity = (range: number, brightness: number): number =>
  range * Math.PI * brightness

/** The converter's material info of a mesh, also after applyBspMaterials() replaced its material. */
export function getBspMaterialInfo(mesh: THREE.Mesh): BspMaterialInfo {
  const remembered = mesh.userData.dribbleMaterial as BspMaterialInfo | undefined
  if (remembered) return remembered
  const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as
    | THREE.Material
    | undefined
  return (material?.userData?.dribble as BspMaterialInfo | undefined) ?? {
    kind: 'opaque',
    lightmap: false,
  }
}

export interface BspMaterialOptions {
  mode: MapRenderMode
  /** The map's lightmap atlas, or null (no atlas, or a GLB that has none such as props.glb). */
  lightmap: THREE.Texture | null
  /** conversion.json lightmap.range; 1 without a lightmap. */
  lightmapRange: number
  /** settings.highlander.map.brightness at the time of the call. */
  brightness: number
  /** Pack textures by key (textured pack worlds); materials without theirs keep the flat albedo. */
  textures?: Map<string, THREE.Texture | null>
}

export interface BspMaterials {
  /** settings map.brightness changed: rescales lightMapIntensity of the lit materials, no reload. */
  setBrightness(brightness: number): void
  /** Frees the textured-mode materials this call created (the module-level ones stay). */
  dispose(): void
}

/**
 * Gives every mesh under `root` the shared material for its converter kind in `options.mode`, and
 * disposes the GLB's own materials the first time. Call it again after a mode change, after disposing
 * the previous result.
 */
/** WorldVertexTransition: mixes `map2` over the base map by the vertex attribute (0 base, 1 map2). */
function addVertexBlend(material: THREE.MeshBasicMaterial, map2: THREE.Texture, attribute: string) {
  const name = attribute.replace(/[^A-Za-z0-9_]/g, '')
  material.onBeforeCompile = shader => {
    shader.uniforms.dribbleMap2 = { value: map2 }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute float ${name};\nvarying float vDribbleBlend;`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>\nvDribbleBlend = ${name};`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D dribbleMap2;\nvarying float vDribbleBlend;')
      .replace(
        '#include <map_fragment>',
        '#include <map_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, diffuse * texture2D(dribbleMap2, vMapUv).rgb, clamp(vDribbleBlend, 0.0, 1.0));'
      )
  }
  material.customProgramCacheKey = () => `dribble-wvt-${name}`
}

/**
 * $detail (as/mapfx): the detail texture over the base texture, as Source's TextureCombine: mode 0 and 7 mod2x
 * (base x mix(1, 2 x detail, factor)), 1 additive, 8 multiply. Source reads mod2x details without the sRGB
 * decode, so the shader re-encodes the hardware-decoded sample. UVs are the base UVs x scale, or with
 * $seamless_detail a triplanar projection of the world position x the seamless scale. Chains any earlier
 * onBeforeCompile (the WorldVertexTransition blend).
 */
function addDetail(material: THREE.MeshBasicMaterial, detail: THREE.Texture, record: NonNullable<PackTextureRecord['detail']>) {
  const previous = material.onBeforeCompile
  const previousKey = material.customProgramCacheKey()
  const seamless = (record.seamless ?? 0) > 0
  const mode = record.mode === 1 ? 1 : record.mode === 8 ? 8 : 0
  detail.wrapS = detail.wrapT = THREE.RepeatWrapping
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer)
    shader.uniforms.dribbleDetail = { value: detail }
    shader.uniforms.dribbleDetailParams = {
      value: new THREE.Vector3(seamless ? record.seamless! : record.scale || 1, record.factor ?? 1, 0),
    }
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\n${seamless ? 'varying vec3 vDribbleDetailPos;\nvarying vec3 vDribbleDetailNormal;' : ''}`
      )
      .replace(
        '#include <project_vertex>',
        seamless
          ? `#include <project_vertex>
vec4 dribbleDetailPos = vec4(transformed, 1.0);
vec3 dribbleDetailNormal = normal;
#ifdef USE_INSTANCING
dribbleDetailPos = instanceMatrix * dribbleDetailPos;
dribbleDetailNormal = mat3(instanceMatrix) * dribbleDetailNormal;
#endif
vDribbleDetailPos = (modelMatrix * dribbleDetailPos).xyz;
vDribbleDetailNormal = normalize(mat3(modelMatrix) * dribbleDetailNormal);`
          : '#include <project_vertex>'
      )
    const sample = seamless
      ? `vec3 dw = abs(vDribbleDetailNormal); dw = dw / max(dw.x + dw.y + dw.z, 1e-4);
vec3 dp = vDribbleDetailPos * dribbleDetailParams.x;
vec4 detailSample = texture2D(dribbleDetail, dp.yz) * dw.x + texture2D(dribbleDetail, dp.zx) * dw.y + texture2D(dribbleDetail, dp.xy) * dw.z;`
      : 'vec4 detailSample = texture2D(dribbleDetail, vMapUv * dribbleDetailParams.x);'
    const combine =
      mode === 1
        ? 'diffuseColor.rgb += detailRaw * dribbleDetailParams.y;'
        : mode === 8
          ? 'diffuseColor.rgb *= mix(vec3(1.0), detailSample.rgb, dribbleDetailParams.y);'
          : 'diffuseColor.rgb *= mix(vec3(1.0), 2.0 * detailRaw, dribbleDetailParams.y);'
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nuniform sampler2D dribbleDetail;\nuniform vec3 dribbleDetailParams;\n${seamless ? 'varying vec3 vDribbleDetailPos;\nvarying vec3 vDribbleDetailNormal;' : ''}`
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
${sample}
vec3 detailRaw = ${detail.colorSpace === THREE.SRGBColorSpace ? 'sRGBTransferOETF(vec4(detailSample.rgb, 1.0)).rgb' : 'detailSample.rgb'};
${combine}`
      )
  }
  material.customProgramCacheKey = () => `${previousKey}|dribble-detail-${mode}-${seamless ? 's' : 'u'}`
}

export function applyBspMaterials(root: THREE.Object3D, options: BspMaterialOptions): BspMaterials {
  const { mode, lightmap, lightmapRange } = options
  const created = new Map<string, THREE.MeshBasicMaterial>()
  const textures = options.textures
  const original = new Set<THREE.Material>()

  const materialFor = (info: BspMaterialInfo): THREE.Material => {
    if (info.kind === 'overlay' && (mode !== 'textured' || !info.texture || !textures?.get(info.texture.key))) {
      return BSP_OVERLAY_HIDDEN_MATERIAL
    }
    if (mode === 'wireframe') return MAP_WIREFRAME_MATERIAL
    const transparent = info.kind !== 'opaque' && info.kind !== 'unlit'
    if (mode === 'untextured') {
      return transparent ? BSP_UNTEXTURED_TRANSLUCENT_MATERIAL : BSP_UNTEXTURED_MATERIAL
    }
    const lit = info.lightmap && !!lightmap
    const record = info.texture
    const map = record && textures?.get(record.key)
    if (record && map) {
      const map2 = record.blend ? textures?.get(record.blend.key) ?? null : null
      const key = `${info.kind}:${lit}:${record.key}:${map2 ? record.blend!.key : ''}:${record.flatAlpha ?? 1}:${record.colorScale?.join(',') ?? ''}:${record.vertexAlpha ?? ''}`
      let material = created.get(key)
      if (!material) {
        material = new THREE.MeshBasicMaterial({
          map: packTextureForChannel(map, record.uv ?? 0),
          lightMap: lit ? lightmap : null,
          lightMapIntensity: bspLightMapIntensity(lightmapRange, options.brightness),
          side: info.kind === 'water' || info.kind === 'visualizer' ? THREE.DoubleSide : THREE.FrontSide,
        })
        applyPackTextureAlpha(material, record, getPackTextureItem(record.key), transparent)
        if (record.colorScale) {
          // Pack props (M3-props2): the vertex colours hold flat albedo x baked light, so the texture draws with
          // them times 1 / albedo, and the vertex alpha (the flat coverage) is divided out of the texture's alpha.
          material.vertexColors = true
          material.userData.dribbleColorScale = record.colorScale
          material.color.fromArray(record.colorScale).multiplyScalar(options.brightness)
          if (record.alpha === 'test' || record.alpha === 'blend') material.opacity = 1 / Math.max(0.05, record.vertexAlpha ?? 1)
          else if (transparent) material.opacity = 1
        }
        if (map2) addVertexBlend(material, packTextureForChannel(map2, record.uv ?? 0), record.blend!.attribute)
        const detailMap = record.detail ? textures?.get(record.detail.key.toLowerCase()) ?? null : null
        if (detailMap && record.detail) addDetail(material, packTextureForChannel(detailMap, record.uv ?? 0), record.detail)
        if (info.kind === 'overlay') {
          // info_overlay (as/mapfx): drawn over the face below without writing depth, pulled towards the camera
          // by a polygon offset (the geometry is also lifted 0.5 units). $alpha scales the texture's alpha;
          // DecalModulate multiplies the surface by 2 x the texture (Source's mod2x).
          material.polygonOffset = true
          material.polygonOffsetFactor = -1
          material.polygonOffsetUnits = -4
          material.depthWrite = false
          if (record.alpha !== 'test') {
            material.transparent = true
            material.opacity = record.flatAlpha ?? 1
          }
          if (info.overlay?.blend === 'modulate') {
            material.blending = THREE.CustomBlending
            material.blendSrc = THREE.DstColorFactor
            material.blendDst = THREE.SrcColorFactor
            material.lightMap = null
          }
        }
        material.name = `dribble_${info.kind}${lit ? '_lit' : ''}:${record.key}`
        material.userData.dribbleLit = lit
        material.userData.dribble = { kind: info.kind, lightmap: lit, texture: record, ...(info.overlay ? { overlay: info.overlay } : {}) }
        created.set(key, material)
      }
      return material
    }
    const key = `${info.kind}:${lit}`
    let material = created.get(key)
    if (!material) {
      material = new THREE.MeshBasicMaterial({
        vertexColors: true,
        lightMap: lit ? lightmap : null,
        lightMapIntensity: bspLightMapIntensity(lightmapRange, options.brightness),
        transparent,
        depthWrite: !transparent,
        side: info.kind === 'water' || info.kind === 'visualizer' ? THREE.DoubleSide : THREE.FrontSide,
      })
      material.name = `dribble_${info.kind}${lit ? '_lit' : ''}`
      material.userData.dribbleLit = lit
      created.set(key, material)
    }
    return material
  }

  root.traverse(node => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    if (!mesh.userData.dribbleMaterial) {
      const info = getBspMaterialInfo(mesh)
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      materials.forEach(material => {
        if (material && !isSharedMapMaterial(material)) original.add(material)
      })
      mesh.userData.dribbleMaterial = info
    }
    mesh.material = materialFor(mesh.userData.dribbleMaterial as BspMaterialInfo)
  })
  original.forEach(material => material.dispose())

  return {
    setBrightness(brightness: number) {
      const intensity = bspLightMapIntensity(lightmapRange, brightness)
      created.forEach(material => {
        material.lightMapIntensity = intensity
      })
    },
    dispose() {
      created.forEach(material => material.dispose())
      created.clear()
    },
  }
}
