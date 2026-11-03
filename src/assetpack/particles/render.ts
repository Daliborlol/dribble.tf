// GPU side of the pack particles (as/particles): one instanced quad mesh per (material, renderer kind) batch,
// filled from scratch every frame. Sprites face the camera and turn by their roll; trails stretch from the head
// back along the velocity. Blended batches are sorted back to front. Colours blend in gamma space as Source does:
// the textures are sampled raw (the stage writes them with `srgb: false`), multiplied by the vertex colour and the
// material's overbright factor, and written premultiplied. SpriteCard's $maxsize, $minsize and the
// $startfadesize/$endfadesize screen-size fade apply in the vertex shader.

import * as THREE from 'three'

import { acquirePackTexture, releasePackTexture } from '@pack/textures'

import type { BatchInfo, CompiledParticles, ParticleOut, ParticleSink } from './sim'
import type { PcfMaterial } from './types'

/** Particles per batch; more are dropped (counted in `dropped`). */
export const BATCH_CAPACITY = 2048
const FLOATS = 24

const VERTEX = /* glsl */ `
  attribute vec2 corner;
  attribute vec4 a0;
  attribute vec4 a1;
  attribute vec4 a2;
  attribute vec4 a3;
  attribute vec4 a4;
  attribute vec4 a5;
  uniform float uTrail;
  uniform float uOverbright;
  uniform float uMaxSize;
  uniform float uMinSize;
  uniform float uStartFade;
  uniform float uEndFade;
  varying vec2 vUv0;
  varying vec2 vUv1;
  varying float vBlend;
  varying vec4 vColor;
  void main() {
    vec4 mv = modelViewMatrix * vec4(a0.xyz, 1.0);
    float radius = a0.w;
    float depth = max(-mv.z, 0.5);
    // diameter as a fraction of the viewport height
    float frac = radius * projectionMatrix[1][1] / depth;
    if (frac > uMaxSize) { radius *= uMaxSize / frac; frac = uMaxSize; }
    if (frac < uMinSize && frac > 0.0) { radius *= uMinSize / frac; frac = uMinSize; }
    float fade = uEndFade > uStartFade ? 1.0 - smoothstep(uStartFade, uEndFade, frac) : 1.0;
    vec2 c = corner;
    vec2 uvc = c * 0.5 + 0.5;
    if (uTrail < 0.5) {
      float s = sin(a5.x);
      float k = cos(a5.x);
      mv.xy += vec2(c.x * k - c.y * s, c.x * s + c.y * k) * radius;
      gl_Position = projectionMatrix * mv;
    } else {
      vec3 dir = (modelViewMatrix * vec4(a4.xyz, 0.0)).xyz;
      vec3 head = mv.xyz;
      vec3 tail = head - dir * a4.w;
      vec3 axis = head - tail;
      vec3 side = cross(axis, head);
      float sl = length(side);
      side = sl > 1e-5 ? side / sl : vec3(1.0, 0.0, 0.0);
      vec3 p = mix(tail, head, uvc.y) + side * c.x * radius;
      gl_Position = projectionMatrix * vec4(p, 1.0);
    }
    vUv0 = vec2(mix(a2.x, a2.z, uvc.x), mix(a2.w, a2.y, uvc.y));
    vUv1 = vec2(mix(a3.x, a3.z, uvc.x), mix(a3.w, a3.y, uvc.y));
    vBlend = a5.y;
    vColor = vec4(a1.rgb * uOverbright, a1.a * fade);
  }
`

const FRAGMENT = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uAddself;
  varying vec2 vUv0;
  varying vec2 vUv1;
  varying float vBlend;
  varying vec4 vColor;
  void main() {
    vec4 t = mix(texture2D(uMap, vUv0), texture2D(uMap, vUv1), vBlend);
    vec3 rgb = t.rgb * vColor.rgb;
    float a = t.a * vColor.a;
    #ifdef ADDITIVE
      gl_FragColor = vec4(rgb * a, 0.0);
    #else
      gl_FragColor = vec4(rgb * a * (1.0 + uAddself), a);
    #endif
  }
`

interface Batch {
  info: BatchInfo
  material: PcfMaterial
  mesh: THREE.Mesh
  geometry: THREE.InstancedBufferGeometry
  shader: THREE.ShaderMaterial
  attrs: THREE.InstancedBufferAttribute[]
  staging: Float32Array
  depth: Float32Array
  order: Uint32Array
  count: number
  texture: string | null
  ready: boolean
  sorted: boolean
}

function makeBatch(info: BatchInfo, material: PcfMaterial): Batch {
  const geometry = new THREE.InstancedBufferGeometry()
  geometry.setAttribute('corner', new THREE.Float32BufferAttribute([-1, -1, 1, -1, 1, 1, -1, 1], 2))
  geometry.setIndex([0, 1, 2, 0, 2, 3])
  const attrs: THREE.InstancedBufferAttribute[] = []
  for (let i = 0; i < 6; i++) {
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(BATCH_CAPACITY * 4), 4)
    attr.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute(`a${i}`, attr)
    attrs.push(attr)
  }
  geometry.instanceCount = 0
  const additive = material.blend === 'additive'
  const shader = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: {
      uMap: { value: null },
      uTrail: { value: info.kind === 'trail' ? 1 : 0 },
      uOverbright: { value: material.overbright },
      uAddself: { value: material.addself },
      uMaxSize: { value: material.maxSize },
      uMinSize: { value: material.minSize },
      uStartFade: { value: material.startFadeSize },
      uEndFade: { value: material.endFadeSize },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  })
  if (additive) shader.defines = { ADDITIVE: '' }
  const mesh = new THREE.Mesh(geometry, shader)
  mesh.name = `pack-particles:${info.key}`
  mesh.frustumCulled = false
  mesh.visible = false
  // blended smoke first, additive fire and glows over it, in the order the systems define them
  mesh.renderOrder = (additive ? 20 : 10) + info.order * 0.001
  return {
    info, material, mesh, geometry, shader, attrs, staging: new Float32Array(BATCH_CAPACITY * FLOATS), depth: new Float32Array(BATCH_CAPACITY),
    order: new Uint32Array(BATCH_CAPACITY), count: 0, texture: material.texture, ready: !material.texture, sorted: !additive,
  }
}

/** The meshes of one compiled particle set; owns its geometries, materials and texture references. */
export class ParticleRenderer implements ParticleSink {
  readonly group = new THREE.Group()
  readonly batches: Batch[] = []
  dropped = 0
  private camPos = new THREE.Vector3()
  private camDir = new THREE.Vector3()
  private disposed = false

  constructor(compiled: CompiledParticles, materials: Record<string, PcfMaterial>, renderer: THREE.WebGLRenderer) {
    this.group.name = 'pack-particles'
    for (const info of compiled.batches) {
      const material = materials[info.material]
      if (!material) continue
      const batch = makeBatch(info, material)
      this.batches[info.order] = batch
      this.group.add(batch.mesh)
      if (batch.texture) {
        const key = batch.texture
        acquirePackTexture(key, renderer).then(texture => {
          if (this.disposed) return
          if (texture) {
            texture.wrapS = THREE.ClampToEdgeWrapping
            texture.wrapT = THREE.ClampToEdgeWrapping
            texture.needsUpdate = true
            batch.shader.uniforms.uMap.value = texture
            batch.ready = true
          }
        })
      }
    }
  }

  /** True once every batch's texture has loaded (a failed one never draws). */
  get ready(): boolean {
    return this.batches.every(b => !b || b.ready)
  }

  begin(camera: THREE.Camera): void {
    camera.getWorldPosition(this.camPos)
    camera.getWorldDirection(this.camDir)
    this.dropped = 0
    for (const b of this.batches) if (b) b.count = 0
  }

  push(index: number, p: ParticleOut): void {
    const b = this.batches[index]
    if (!b || !b.ready) return
    if (b.count >= BATCH_CAPACITY) {
      this.dropped++
      return
    }
    const s = b.staging
    const o = b.count * FLOATS
    s[o] = p.x
    s[o + 1] = p.y
    s[o + 2] = p.z
    s[o + 3] = p.radius
    s[o + 4] = p.r
    s[o + 5] = p.g
    s[o + 6] = p.b
    s[o + 7] = p.a
    s[o + 8] = p.uv0[0]
    s[o + 9] = p.uv0[1]
    s[o + 10] = p.uv0[2]
    s[o + 11] = p.uv0[3]
    s[o + 12] = p.uv1[0]
    s[o + 13] = p.uv1[1]
    s[o + 14] = p.uv1[2]
    s[o + 15] = p.uv1[3]
    s[o + 16] = p.dx
    s[o + 17] = p.dy
    s[o + 18] = p.dz
    s[o + 19] = p.length
    s[o + 20] = p.rotation
    s[o + 21] = p.blend
    s[o + 22] = 0
    s[o + 23] = 0
    if (b.sorted) {
      const c = this.camPos, d = this.camDir
      b.depth[b.count] = (p.x - c.x) * d.x + (p.y - c.y) * d.y + (p.z - c.z) * d.z
    }
    b.count++
  }

  end(): void {
    for (const b of this.batches) {
      if (!b) continue
      const n = b.count
      b.mesh.visible = n > 0
      b.geometry.instanceCount = n
      if (!n) continue
      let order: ArrayLike<number> | null = null
      if (b.sorted && n > 1) {
        const idx = b.order
        for (let i = 0; i < n; i++) idx[i] = i
        const depth = b.depth
        const view = idx.subarray(0, n)
        view.sort((i, j) => depth[j] - depth[i] || i - j)
        order = view
      }
      for (let k = 0; k < 6; k++) {
        const arr = b.attrs[k].array as Float32Array
        for (let i = 0; i < n; i++) {
          const src = (order ? order[i] : i) * FLOATS + k * 4
          const dst = i * 4
          arr[dst] = b.staging[src]
          arr[dst + 1] = b.staging[src + 1]
          arr[dst + 2] = b.staging[src + 2]
          arr[dst + 3] = b.staging[src + 3]
        }
        b.attrs[k].clearUpdateRanges()
        b.attrs[k].addUpdateRange(0, n * 4)
        b.attrs[k].needsUpdate = true
      }
    }
  }

  /** Particles drawn last frame per batch key. */
  counts(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const b of this.batches) if (b && b.count) out[b.info.key] = b.count
    return out
  }

  dispose(): void {
    this.disposed = true
    for (const b of this.batches) {
      if (!b) continue
      b.geometry.dispose()
      b.shader.dispose()
      if (b.texture) releasePackTexture(b.texture)
    }
    this.group.clear()
  }
}
