// Stand-in for `three` in the Node checker bundle (scripts/hl/lib/bundle.mjs). The extras helpers only need
// Quaternion (track.ts keeps one at module scope for xformAt) and the Vector3 shape. Bundling the real
// three.module.js adds 300 KB of code and several MB of RSS to a process whose peak the checker measures.

export class Vector3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x
    this.y = y
    this.z = z
  }
  set(x, y, z) {
    this.x = x
    this.y = y
    this.z = z
    return this
  }
}

export class Quaternion {
  constructor(x = 0, y = 0, z = 0, w = 1) {
    this.x = x
    this.y = y
    this.z = z
    this.w = w
  }
  set(x, y, z, w) {
    this.x = x
    this.y = y
    this.z = z
    this.w = w
    return this
  }
  slerp(q, t) {
    const { x, y, z, w } = this
    let cos = w * q.w + x * q.x + y * q.y + z * q.z
    let sign = 1
    if (cos < 0) {
      cos = -cos
      sign = -1
    }
    let a = 1 - t
    let b = t * sign
    if (cos < 0.9995) {
      const theta = Math.acos(cos)
      const sin = Math.sin(theta)
      a = Math.sin((1 - t) * theta) / sin
      b = (Math.sin(t * theta) / sin) * sign
    }
    return this.set(a * x + b * q.x, a * y + b * q.y, a * z + b * q.z, a * w + b * q.w)
  }
}
