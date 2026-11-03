// TF2's VertexLitGeneric character look for pack models (as/shading). The pack's `shading` stage writes, per base
// texture key, the VMT's phong, rim light, light warp and bump parameters (`shading/materials`, see
// scripts/assets/shading/stage.mjs). bindCharacterShading() runs after bindPackTextures() on every model template
// of src/assetpack/models.ts: it binds the bump map as `normalMap` and patches the material's lighting through
// onBeforeCompile with one shared program source (customProgramCacheKey), so players, weapons, buildings and
// viewmodels share their programs.
//
// The lighting (view space, the scene's directional lights and its ambient light):
//   diffuse  = sum 2 x warp(halfLambert) x light (half-Lambert squared without a warp; plain Lambert without $phong
//              and $halflambert), plus the ambient light scaled by a sky/ground hemisphere (the ambient cube)
//   specular = sum pow(R.L, exponent) x N.L x light x boost x fresnel(ranges) x mask x tint (Source's
//              Fresnel(): (1 - N.V)^2 into the three ranges)
//   rim      = max(specular, sum pow(R.L, rimexponent) x N.L x light x rimFresnel x rimMask), plus the ambient
//              seen along the view ray x rimFresnel x rimboost x max(N.up, 0); rimFresnel = (1 - N.V)^4
// Every term goes through three's 1/pi Lambert scale, so the result keeps the brightness of the scene's other
// materials. assets.characterShading turns it off and on at once (one shared uniform): off restores the geometry
// normal and three's own lighting of the material, so the bound extra textures cost memory only.

import * as THREE from 'three'
import type { Material, Object3D, Texture, WebGLRenderer } from 'three'

import { getState, useStore } from '@zus/store'

import { loadPackItem } from './items'
import { getAssetPackState } from './pack'
import { acquirePackTexture, releasePackTexture } from './textures'
import type { PackTextureRecord } from './textures'
import { DEFAULT_ASSET_SETTINGS } from './settings'

/** One `shading/materials` entry (see the stage's header for the fields). */
export interface ShadingEntry {
  p?: [number, number, number, number, number]
  ex?: 1
  m?: 0 | 1 | 2
  inv?: 1
  at?: 1
  t?: [number, number, number]
  b?: string
  e?: string
  ef?: number
  w?: string
  hl?: 1
  r?: [number, number, number]
}

type ShadingTable = Record<string, ShadingEntry>

const tables = new WeakMap<object, Promise<ShadingTable | null>>()

/** The pack's shading table, fetched once per manifest; null without one. */
export function loadShadingTable(): Promise<ShadingTable | null> {
  const pack = getAssetPackState()
  const manifest = pack.manifest
  if (pack.status !== 'ready' || !manifest || manifest.items?.['shading/materials']?.kind !== 'shading')
    return Promise.resolve(null)
  let table = tables.get(manifest)
  if (!table) {
    table = loadPackItem('shading/materials', async url => {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const json = await response.json()
      if (!json || typeof json.materials !== 'object') throw new Error('no materials')
      return json.materials as ShadingTable
    }).catch(() => null)
    tables.set(manifest, table)
  }
  return table
}

// ─── the shared switch ─────────────────────────────────────────────────────────

const characterShadingOn = () => getState().settings.assets?.characterShading ?? DEFAULT_ASSET_SETTINGS.characterShading
const SH_ON = { value: 1 }
let subscribed = false
function subscribeSwitch() {
  if (subscribed) return
  subscribed = true
  SH_ON.value = characterShadingOn() ? 1 : 0
  useStore.subscribe(() => {
    SH_ON.value = characterShadingOn() ? 1 : 0
  })
}

// A white texel for the samplers a material does not use (one module-level texture, as shared geometries are).
let white: THREE.DataTexture | null = null
const whiteTexture = () => {
  if (!white) {
    white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1)
    white.needsUpdate = true
  }
  return white
}

// ─── the material patch ────────────────────────────────────────────────────────

interface ShadingState {
  entry: ShadingEntry
  exp: Texture | null
  warp: Texture | null
}

const states = new WeakMap<Material, ShadingState>()

const FRAGMENT_PARS = /* glsl */ `
uniform float shOn;
uniform sampler2D shExp;
uniform sampler2D shWarp;
uniform vec4 shPhong;   // exponent, boost, exponent from texture, mask mode (0 none, 1 bump alpha, 2 base alpha)
uniform vec3 shFresnel;
uniform vec4 shMisc;    // phong, half-Lambert, warp, albedo tint
uniform vec4 shRim;     // rim, exponent, boost, mask from exponent alpha
uniform vec4 shTint;    // phong tint, invert mask
uniform float shExpFactor;
void main() {`

const AFTER_NORMAL_BEGIN = /* glsl */ `
#include <normal_fragment_begin>
vec3 shGeomNormal = normal;`

const AFTER_NORMAL_MAPS = /* glsl */ `
#include <normal_fragment_maps>
#ifdef USE_NORMALMAP
  vec4 shBump = texture2D( normalMap, vNormalMapUv );
#else
  vec4 shBump = vec4( 0.5, 0.5, 1.0, 1.0 );
#endif
if ( shOn < 0.5 ) normal = shGeomNormal;`

const AFTER_LIGHTS = /* glsl */ `
#include <lights_fragment_end>
if ( shOn > 0.5 ) {
  #ifdef USE_MAP
    vec2 shUv = vMapUv;
    float shBaseA = texture2D( map, vMapUv ).a;
  #else
    vec2 shUv = vec2( 0.0 );
    float shBaseA = 1.0;
  #endif
  vec3 shN = normal;
  vec3 shV = normalize( vViewPosition );
  float shNdotV = clamp( dot( shN, shV ), 0.0, 1.0 );
  vec4 shE = texture2D( shExp, shUv );
  float shExponent = shPhong.z > 0.5 ? 1.0 + shExpFactor * shE.r : shPhong.x;
  float shMask = shPhong.w < 0.5 ? 1.0 : ( shPhong.w < 1.5 ? shBump.a : shBaseA );
  if ( shTint.w > 0.5 ) shMask = 1.0 - shMask;
  float shF = 1.0 - shNdotV;
  float shF2 = shF * shF;
  float shFresnelTerm = shF2 > 0.5 ? mix( shFresnel.y, shFresnel.z, 2.0 * shF2 - 1.0 ) : mix( shFresnel.x, shFresnel.y, 2.0 * shF2 );
  float shRimF = shF2 * shF2;
  float shRimMask = shRim.w > 0.5 ? shE.a : 1.0;
  vec3 shR = reflect( -shV, shN );
  vec3 shDiff = vec3( 0.0 );
  vec3 shSpec = vec3( 0.0 );
  vec3 shRimL = vec3( 0.0 );
  #if NUM_DIR_LIGHTS > 0
  for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
    vec3 shL = directionalLights[ i ].direction;
    vec3 shC = directionalLights[ i ].color;
    float shNdotL = dot( shN, shL );
    float shNl = clamp( shNdotL, 0.0, 1.0 );
    float shD = shMisc.y > 0.5 ? clamp( shNdotL * 0.5 + 0.5, 0.0, 1.0 ) : shNl;
    vec3 shW = shMisc.z > 0.5 ? 2.0 * texture2D( shWarp, vec2( shD, 0.5 ) ).rgb : vec3( shMisc.y > 0.5 ? shD * shD : shD );
    shDiff += shW * shC;
    float shRdotL = clamp( dot( shR, shL ), 0.0, 1.0 );
    shSpec += pow( shRdotL, shExponent ) * shNl * shC;
    shRimL += pow( shRdotL, shRim.y ) * shNl * shC;
  }
  #endif
  vec3 shUp = normalize( ( viewMatrix * vec4( 0.0, 0.0, 1.0, 0.0 ) ).xyz );
  vec3 shAmb = ambientLightColor * mix( 0.55, 1.3, dot( shN, shUp ) * 0.5 + 0.5 );
  vec3 shAmbView = ambientLightColor * mix( 0.55, 1.3, dot( shV, shUp ) * 0.5 + 0.5 );
  reflectedLight.directDiffuse = BRDF_Lambert( diffuseColor.rgb ) * shDiff;
  reflectedLight.indirectDiffuse = BRDF_Lambert( diffuseColor.rgb ) * shAmb;
  vec3 shTintC = mix( vec3( 1.0 ), diffuseColor.rgb, shMisc.w * shE.g ) * shTint.rgb;
  vec3 shOut = shMisc.x * shSpec * shPhong.y * shFresnelTerm * shMask * shTintC;
  if ( shRim.x > 0.5 ) {
    shOut = max( shOut, shRimL * shRimF * shRimMask );
    shOut += shRimF * shRimMask * shRim.z * shAmbView * clamp( dot( shN, shUp ), 0.0, 1.0 );
  }
  reflectedLight.directSpecular = shOut * RECIPROCAL_PI;
  reflectedLight.indirectSpecular = vec3( 0.0 );
}`

function patchShader(shader: THREE.WebGLProgramParametersWithUniforms, state: ShadingState) {
  const e = state.entry
  const phong = e.p
  shader.uniforms.shOn = SH_ON
  shader.uniforms.shExp = { value: state.exp ?? whiteTexture() }
  shader.uniforms.shWarp = { value: state.warp ?? whiteTexture() }
  const fromTexture = !!state.exp && !e.ex
  shader.uniforms.shPhong = { value: new THREE.Vector4(phong?.[0] ?? 5, phong?.[1] ?? 0, fromTexture ? 1 : 0, e.m ?? 0) }
  shader.uniforms.shFresnel = { value: new THREE.Vector3(phong?.[2] ?? 0, phong?.[3] ?? 0.5, phong?.[4] ?? 1) }
  shader.uniforms.shMisc = { value: new THREE.Vector4(phong ? 1 : 0, e.hl ? 1 : 0, state.warp ? 1 : 0, e.at && state.exp ? 1 : 0) }
  shader.uniforms.shRim = { value: new THREE.Vector4(e.r ? 1 : 0, e.r?.[0] ?? 4, e.r?.[1] ?? 1, e.r?.[2] && state.exp ? 1 : 0) }
  const t = e.t ?? [1, 1, 1]
  shader.uniforms.shTint = { value: new THREE.Vector4(t[0], t[1], t[2], e.inv ? 1 : 0) }
  shader.uniforms.shExpFactor = { value: e.ef ?? 149 }
  shader.fragmentShader = shader.fragmentShader
    .replace('void main() {', FRAGMENT_PARS)
    .replace('#include <normal_fragment_begin>', AFTER_NORMAL_BEGIN)
    .replace('#include <normal_fragment_maps>', AFTER_NORMAL_MAPS)
    .replace('#include <lights_fragment_end>', AFTER_LIGHTS)
}

const PROGRAM_KEY = 'dribble-character-shading-1'

function install(material: Material, state: ShadingState) {
  states.set(material, state)
  material.onBeforeCompile = shader => patchShader(shader, state)
  material.customProgramCacheKey = () => PROGRAM_KEY
  material.needsUpdate = true
}

/**
 * Carries the shading of `source` to its clone (Material.clone() keeps the normal map but not onBeforeCompile).
 * Call it right after clone(), before any other onBeforeCompile wrapper is added to the copy.
 */
export function copyCharacterShading(source: Material, copy: Material): void {
  const state = states.get(source)
  if (state) install(copy, state)
}

/** True when the material draws with the character shading patch. */
export const hasCharacterShading = (material: Material): boolean => states.has(material)

export interface CharacterShadingBinding {
  shaded: number
  release(): void
}

const NONE: CharacterShadingBinding = { shaded: 0, release() {} }

/**
 * Patches every material under `root` whose skin texture has a shading entry and binds its extra textures
 * (reference counted; `release()` frees them). Resolves at once without a shading table. Call before warmUpObject.
 */
export async function bindCharacterShading(
  root: Object3D,
  renderer: WebGLRenderer,
  opts: { skin?: number } = {}
): Promise<CharacterShadingBinding> {
  const table = await loadShadingTable()
  if (!table) return NONE
  subscribeSwitch()
  const jobs: { material: THREE.MeshStandardMaterial; entry: ShadingEntry }[] = []
  const seen = new Set<Material>()
  root.traverse(node => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (!material || seen.has(material)) continue
      seen.add(material)
      if (!(material as THREE.MeshStandardMaterial).isMeshStandardMaterial) continue
      const record = material.userData?.dribble?.texture as PackTextureRecord | undefined
      if (!record?.key) continue
      const key = (record.skins?.[opts.skin ?? 0] ?? record.key).toLowerCase()
      const entry = table[key]
      if (entry) jobs.push({ material: material as THREE.MeshStandardMaterial, entry })
    }
  })
  if (!jobs.length) return NONE
  const keys: string[] = []
  const acquire = (key: string | undefined) => {
    if (!key) return Promise.resolve(null)
    keys.push(key)
    return acquirePackTexture(key, renderer)
  }
  const textures = await Promise.all(jobs.map(job => Promise.all([acquire(job.entry.b), acquire(job.entry.e), acquire(job.entry.w)])))
  jobs.forEach((job, i) => {
    const [bump, exp, warp] = textures[i]
    if (bump) {
      job.material.normalMap = bump
      // Source normal maps are DirectX style (green down the image); with flipY false and derivative tangents
      // that is three's +1 (the GLTFLoader flips OpenGL-style glTF maps to -1)
      job.material.normalScale.set(1, 1)
    }
    if (warp && warp.wrapS !== THREE.ClampToEdgeWrapping) {
      warp.wrapS = THREE.ClampToEdgeWrapping
      warp.wrapT = THREE.ClampToEdgeWrapping
      warp.needsUpdate = true
    }
    install(job.material, { entry: job.entry, exp, warp })
  })
  let released = false
  return {
    shaded: jobs.length,
    release() {
      if (released) return
      released = true
      keys.forEach(releasePackTexture)
    },
  }
}
