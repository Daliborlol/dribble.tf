// Shared rendering helpers for the F3 layers: an instanced effect material with per-instance colour and opacity,
// a small wrapper that fills an InstancedMesh each frame, and a camera-facing ribbon batch (trails and tracers).
//
// All of them are written once per frame from pure data (contract 1.6 rules 3, 6 and 7): no React state per tick,
// one draw call per shape.

import * as THREE from 'three'

// ─── Material ─────────────────────────────────────────────────────────────────

const FX_VERTEX = /* glsl */ `
  #ifdef FX_INSTANCE_OPACITY
    attribute float instanceOpacity;
  #endif
  varying vec4 vFxColor;
  varying float vFacing;

  void main() {
    vec4 c = vec4(1.0);
    #ifdef USE_INSTANCING_COLOR
      c.rgb *= instanceColor;
    #endif
    #if defined( USE_COLOR_ALPHA )
      c *= color;
    #elif defined( USE_COLOR )
      c.rgb *= color;
    #endif
    #ifdef FX_INSTANCE_OPACITY
      c.a *= instanceOpacity;
    #endif
    vFxColor = c;

    vec4 local = vec4(position, 1.0);
    vec3 n = normal;
    #ifdef USE_INSTANCING
      local = instanceMatrix * local;
      n = mat3(instanceMatrix) * n;
    #endif
    vec4 mv = modelViewMatrix * local;
    vec3 viewNormal = normalize(normalMatrix * n);
    vFacing = abs(dot(viewNormal, normalize(-mv.xyz)));
    gl_Position = projectionMatrix * mv;
  }
`

const FX_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uSoftness;
  varying vec4 vFxColor;
  varying float vFacing;

  void main() {
    float edge = uSoftness > 0.0 ? pow(clamp(vFacing, 0.0, 1.0), uSoftness) : 1.0;
    gl_FragColor = vec4(uColor * vFxColor.rgb, uOpacity * vFxColor.a * edge);
    #include <colorspace_fragment>
  }
`

export interface FxMaterialOptions {
  /** 'additive' (glows, flashes, fire) or 'normal' (smoke, scorch marks). Default additive. */
  blending?: 'additive' | 'normal'
  color?: THREE.ColorRepresentation
  opacity?: number
  /** > 0: alpha falls off toward the silhouette as pow(n.v, softness), so a sphere reads as a soft glow. */
  softness?: number
  /** Multiply by the geometry's `color` attribute (RGB or RGBA). */
  vertexColors?: boolean
  /** Multiply alpha by the per-instance `instanceOpacity` attribute (FxInstances provides it). */
  instanceOpacity?: boolean
  side?: THREE.Side
}

/** Unlit effect material for meshes and InstancedMeshes. Colours are sRGB like every other material. */
export function makeFxMaterial(options: FxMaterialOptions = {}): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    vertexShader: FX_VERTEX,
    fragmentShader: FX_FRAGMENT,
    uniforms: {
      uColor: { value: new THREE.Color(options.color ?? '#ffffff') },
      uOpacity: { value: options.opacity ?? 1 },
      uSoftness: { value: options.softness ?? 0 },
    },
    transparent: true,
    depthWrite: false,
    blending: options.blending === 'normal' ? THREE.NormalBlending : THREE.AdditiveBlending,
    side: options.side ?? THREE.FrontSide,
    vertexColors: !!options.vertexColors,
  })
  if (options.instanceOpacity) material.defines = { FX_INSTANCE_OPACITY: '' }
  return material
}

/** Sets the material-wide opacity of a makeFxMaterial material. */
export function setFxOpacity(material: THREE.ShaderMaterial, opacity: number): void {
  material.uniforms.uOpacity.value = opacity
}

// ─── Instances ────────────────────────────────────────────────────────────────

const _color = new THREE.Color()

/**
 * An InstancedMesh filled from scratch every frame: begin(), push() per instance, end(). Instances beyond the
 * capacity are dropped (counted in `dropped`). The mesh hides itself while empty, so unused shapes cost no draw call.
 */
export class FxInstances {
  readonly mesh: THREE.InstancedMesh
  readonly capacity: number
  count = 0
  dropped = 0
  private readonly opacity?: Float32Array
  private readonly opacityAttr?: THREE.InstancedBufferAttribute

  constructor(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number, options: { color?: boolean; opacity?: boolean; name?: string } = {}) {
    // a per-instance attribute lives on the geometry, so every instanced mesh with one owns its geometry copy
    const geo = options.opacity ? geometry.clone() : geometry
    this.capacity = capacity
    this.mesh = new THREE.InstancedMesh(geo, material, capacity)
    this.mesh.name = options.name ?? 'fx'
    this.mesh.frustumCulled = false
    this.mesh.count = 0
    this.mesh.visible = false
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    if (options.color) {
      this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3)
      this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
    }
    if (options.opacity) {
      this.opacity = new Float32Array(capacity).fill(1)
      this.opacityAttr = new THREE.InstancedBufferAttribute(this.opacity, 1)
      this.opacityAttr.setUsage(THREE.DynamicDrawUsage)
      geo.setAttribute('instanceOpacity', this.opacityAttr)
    }
  }

  begin(): void {
    this.count = 0
  }

  /** Adds one instance; `color` needs the `color` option, `opacity` the `opacity` option. Returns its index or -1. */
  push(matrix: THREE.Matrix4, color?: THREE.ColorRepresentation | THREE.Color, opacity = 1): number {
    if (this.count >= this.capacity) {
      this.dropped++
      return -1
    }
    const i = this.count++
    this.mesh.setMatrixAt(i, matrix)
    if (color !== undefined && this.mesh.instanceColor) {
      this.mesh.setColorAt(i, color instanceof THREE.Color ? color : _color.set(color))
    }
    if (this.opacity) this.opacity[i] = opacity
    return i
  }

  end(): void {
    const mesh = this.mesh
    mesh.count = this.count
    mesh.visible = this.count > 0
    if (this.count === 0) return
    mesh.instanceMatrix.clearUpdateRanges()
    mesh.instanceMatrix.addUpdateRange(0, this.count * 16)
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) {
      mesh.instanceColor.clearUpdateRanges()
      mesh.instanceColor.addUpdateRange(0, this.count * 3)
      mesh.instanceColor.needsUpdate = true
    }
    if (this.opacityAttr) {
      this.opacityAttr.clearUpdateRanges()
      this.opacityAttr.addUpdateRange(0, this.count)
      this.opacityAttr.needsUpdate = true
    }
  }

  dispose(): void {
    if (this.opacityAttr) this.mesh.geometry.dispose()
    this.mesh.dispose()
  }
}

// ─── Ribbons ──────────────────────────────────────────────────────────────────

const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _t = new THREE.Vector3()
const _v = new THREE.Vector3()
const _side = new THREE.Vector3()

/** World units per pixel per unit of camera distance (0 for non-perspective cameras). */
export function pixelScaleOf(camera: THREE.Camera, viewportHeight: number): number {
  const perspective = camera as THREE.PerspectiveCamera
  if (!perspective.isPerspectiveCamera || !(viewportHeight > 0)) return 0
  return (2 * Math.tan((perspective.fov * Math.PI) / 360)) / (viewportHeight * (perspective.zoom || 1))
}

/**
 * Camera-facing ribbons built on the CPU into one non-indexed triangle list (one draw call for every trail or
 * tracer of a layer). Each point gets a side vector perpendicular to the local tangent and the view direction.
 */
export class RibbonBatch {
  readonly mesh: THREE.Mesh
  private positions: Float32Array
  private colors: Float32Array
  private vertices = 0
  private capacity: number
  private readonly camera = new THREE.Vector3()
  private pixelScale = 0
  /** Per-point side vectors of the current strip (scratch). */
  private sides: Float32Array = new Float32Array(64 * 3)

  constructor(material: THREE.Material, capacity = 4096, name = 'ribbons') {
    this.capacity = capacity
    this.positions = new Float32Array(capacity * 3)
    this.colors = new Float32Array(capacity * 4)
    this.mesh = new THREE.Mesh(this.makeGeometry(), material)
    this.mesh.name = name
    this.mesh.frustumCulled = false
    this.mesh.visible = false
  }

  private makeGeometry(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry()
    const position = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage)
    const color = new THREE.BufferAttribute(this.colors, 4).setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute('position', position)
    geometry.setAttribute('color', color)
    geometry.setDrawRange(0, 0)
    return geometry
  }

  private grow(needed: number): void {
    let capacity = this.capacity
    while (capacity < needed) capacity *= 2
    const positions = new Float32Array(capacity * 3)
    const colors = new Float32Array(capacity * 4)
    positions.set(this.positions.subarray(0, this.vertices * 3))
    colors.set(this.colors.subarray(0, this.vertices * 4))
    this.positions = positions
    this.colors = colors
    this.capacity = capacity
    const old = this.mesh.geometry
    this.mesh.geometry = this.makeGeometry()
    old.dispose()
  }

  /**
   * `pixelScale` = world units per pixel per unit of distance (2 tan(fov / 2) / viewport height for a perspective
   * camera, 0 to disable): strips drawn with `minWidthPx` never get thinner than that many pixels on screen.
   */
  begin(cameraWorldPosition: THREE.Vector3, pixelScale = 0): void {
    this.vertices = 0
    this.camera.copy(cameraWorldPosition)
    this.pixelScale = pixelScale
  }

  private vertex(x: number, y: number, z: number, r: number, g: number, b: number, a: number): void {
    const i = this.vertices++
    const p = this.positions, c = this.colors
    p[i * 3] = x
    p[i * 3 + 1] = y
    p[i * 3 + 2] = z
    c[i * 4] = r
    c[i * 4 + 1] = g
    c[i * 4 + 2] = b
    c[i * 4 + 3] = a
  }

  /**
   * A strip through `count` points (flat xyz in `points`), head first. Width and alpha go linearly from the head
   * values to the tail values. `color` is linear RGB (a THREE.Color).
   */
  strip(points: ArrayLike<number>, count: number, color: THREE.Color, widthHead: number, widthTail: number, alphaHead: number, alphaTail: number, minWidthPx = 0): void {
    if (count < 2) return
    if (this.sides.length < count * 3) this.sides = new Float32Array(count * 6)
    const sides = this.sides
    for (let k = 0; k < count; k++) {
      const prev = k > 0 ? k - 1 : k
      const next = k < count - 1 ? k + 1 : k
      _a.set(points[prev * 3], points[prev * 3 + 1], points[prev * 3 + 2])
      _b.set(points[next * 3], points[next * 3 + 1], points[next * 3 + 2])
      _t.subVectors(_b, _a)
      _v.set(points[k * 3], points[k * 3 + 1], points[k * 3 + 2]).sub(this.camera).negate()
      _side.crossVectors(_t, _v)
      const len = _side.length()
      const u = count > 1 ? k / (count - 1) : 0
      let half = 0.5 * (widthHead + (widthTail - widthHead) * u)
      if (minWidthPx > 0 && this.pixelScale > 0) half = Math.max(half, 0.5 * minWidthPx * this.pixelScale * _v.length())
      if (len > 1e-6) _side.multiplyScalar(half / len)
      else _side.set(0, 0, 0)
      sides[k * 3] = _side.x
      sides[k * 3 + 1] = _side.y
      sides[k * 3 + 2] = _side.z
    }
    const needed = this.vertices + (count - 1) * 6
    if (needed > this.capacity) this.grow(needed)
    const { r, g, b } = color
    for (let k = 0; k < count - 1; k++) {
      const u0 = k / (count - 1), u1 = (k + 1) / (count - 1)
      const a0 = alphaHead + (alphaTail - alphaHead) * u0
      const a1 = alphaHead + (alphaTail - alphaHead) * u1
      const x0 = points[k * 3], y0 = points[k * 3 + 1], z0 = points[k * 3 + 2]
      const x1 = points[k * 3 + 3], y1 = points[k * 3 + 4], z1 = points[k * 3 + 5]
      const sx0 = sides[k * 3], sy0 = sides[k * 3 + 1], sz0 = sides[k * 3 + 2]
      const sx1 = sides[k * 3 + 3], sy1 = sides[k * 3 + 4], sz1 = sides[k * 3 + 5]
      // two triangles: (p0 - s0, p0 + s0, p1 + s1) and (p0 - s0, p1 + s1, p1 - s1)
      this.vertex(x0 - sx0, y0 - sy0, z0 - sz0, r, g, b, a0)
      this.vertex(x0 + sx0, y0 + sy0, z0 + sz0, r, g, b, a0)
      this.vertex(x1 + sx1, y1 + sy1, z1 + sz1, r, g, b, a1)
      this.vertex(x0 - sx0, y0 - sy0, z0 - sz0, r, g, b, a0)
      this.vertex(x1 + sx1, y1 + sy1, z1 + sz1, r, g, b, a1)
      this.vertex(x1 - sx1, y1 - sy1, z1 - sz1, r, g, b, a1)
    }
  }

  /** A single segment from a to b with constant width (tracers). */
  segment(a: THREE.Vector3, b: THREE.Vector3, color: THREE.Color, width: number, alphaA: number, alphaB: number, minWidthPx = 0): void {
    const pts = _segmentPoints
    pts[0] = a.x; pts[1] = a.y; pts[2] = a.z
    pts[3] = b.x; pts[4] = b.y; pts[5] = b.z
    this.strip(pts, 2, color, width, width, alphaA, alphaB, minWidthPx)
  }

  end(): void {
    const geometry = this.mesh.geometry
    geometry.setDrawRange(0, this.vertices)
    this.mesh.visible = this.vertices > 0
    if (this.vertices === 0) return
    const position = geometry.getAttribute('position') as THREE.BufferAttribute
    const color = geometry.getAttribute('color') as THREE.BufferAttribute
    position.clearUpdateRanges()
    position.addUpdateRange(0, this.vertices * 3)
    position.needsUpdate = true
    color.clearUpdateRanges()
    color.addUpdateRange(0, this.vertices * 4)
    color.needsUpdate = true
  }

  /** Vertex count of the last frame (probes). */
  get vertexCount(): number {
    return this.vertices
  }

  dispose(): void {
    this.mesh.geometry.dispose()
  }
}

const _segmentPoints = new Float32Array(6)

// ─── Geometry helpers ─────────────────────────────────────────────────────────

/** Cylinder of radius r and length `length` along +X, from x0 to x0 + length. */
export function cylinderX(r: number, length: number, x0: number, segments = 10): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, length, segments, 1)
  g.rotateZ(-Math.PI / 2) // Y axis -> X axis
  g.translate(x0 + length / 2, 0, 0)
  return g
}

/** Cone along +X: base radius r at x0, apex at x0 + length. */
export function coneX(r: number, length: number, x0: number, segments = 10): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(r, length, segments, 1)
  g.rotateZ(-Math.PI / 2) // apex +Y -> +X
  g.translate(x0 + length / 2, 0, 0)
  return g
}

/**
 * Open cone with its apex at the origin, opening along +X to radius 1 at x = 1, with an RGBA vertex colour that
 * goes from `head` (apex) to `tail` (open end). Colours are linear RGBA tuples (see `rgba`). Scale X by the
 * length and Y/Z by the end radius.
 */
export function gradientConeX(head: [number, number, number, number], tail: [number, number, number, number], radial = 16, rings = 6): THREE.BufferGeometry {
  const positions: number[] = []
  const normals: number[] = []
  const colors: number[] = []
  const indices: number[] = []
  const n = new THREE.Vector3()
  for (let ring = 0; ring <= rings; ring++) {
    const u = ring / rings
    const radius = Math.max(u, 0.02)
    for (let k = 0; k <= radial; k++) {
      const a = (k / radial) * Math.PI * 2
      const cy = Math.cos(a), cz = Math.sin(a)
      positions.push(u, cy * radius, cz * radius)
      // side normal of a cone whose radius grows 1:1 with x
      n.set(-1, cy, cz).normalize()
      normals.push(n.x, n.y, n.z)
      colors.push(
        head[0] + (tail[0] - head[0]) * u,
        head[1] + (tail[1] - head[1]) * u,
        head[2] + (tail[2] - head[2]) * u,
        head[3] + (tail[3] - head[3]) * u
      )
    }
  }
  const row = radial + 1
  for (let ring = 0; ring < rings; ring++) {
    for (let k = 0; k < radial; k++) {
      const a = ring * row + k, b = a + 1, c = a + row, d = c + 1
      // counter-clockwise seen from outside, so FrontSide shows the outer surface
      indices.push(a, b, c, b, d, c)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4))
  g.setIndex(indices)
  return g
}

/** An sRGB hex colour as a linear RGBA tuple (vertex colours are linear, like THREE.Color values). */
export function rgba(hex: string, alpha: number): [number, number, number, number] {
  const c = new THREE.Color(hex)
  return [c.r, c.g, c.b, alpha]
}
