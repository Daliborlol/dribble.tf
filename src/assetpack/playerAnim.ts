// Third-person player animation from the pack (as/tpanim). The models stage writes one `models/player/<class>.mdl`
// item per class (role `player:model`, scripts/assets/models/players.mjs) with its skeleton, team skins and the clips
// of the sequences TF2 plays per anim slot, plus `anim`: per slot the stand, crouch, run, crouch-walk and airwalk
// sequences (a 3x3 move_x/move_y grid where the sequence has one), heavy's and the sniper's deployed variants, the
// aim matrix each one auto-layers (the body_yaw = 0 column by body_pitch) and the attack gestures with their layers.
//
// `evaluatePlayerPose` turns a PlayerAnimInput (computed from the demo by players/animState.ts) into bone-local
// transforms, the way Source's bone setup does: the base sequences blend by weight (the grid bilinearly), delta
// layers (aim matrices, delta gestures) post-multiply (q = q * delta^w, p += delta * w), and absolute gesture layers
// blend in with their per-bone weights. Simplifications: no body_yaw (the feet always face the eyes), no IK rules or
// IK locks, the first aim layer of a sequence only (run, not runS), no sequence-transition fades beyond what the
// input weights express. Everything is a pure function of the input (D12).

import type { AnimationClip, Object3D } from 'three'

import type { PackModelHandle, PackModelItem } from './models'

export interface PlayerSeqInfo {
  name: string
  clips: string[]
  /** move_x/move_y blend: p = parameter names of grid dimensions 0 and 1, k = their keys */
  grid?: { p: [string, string]; k: [number[], number[]]; size: [number, number] }
  /** distance per loop and ground speed of the forward clip (moving sequences) */
  stride?: number
  speed?: number
  aim?: { name: string; rows: { pitch: number; clip: string }[] }
}

export interface PlayerGestureInfo {
  name: string
  duration: number
  parts: { clip: string; delta: boolean; weights?: Record<string, number> }[]
}

export interface PlayerSlotInfo {
  stand: PlayerSeqInfo
  crouch?: PlayerSeqInfo
  run?: PlayerSeqInfo
  crouchWalk?: PlayerSeqInfo
  air?: PlayerSeqInfo
  deployed?: { stand: PlayerSeqInfo; crouch?: PlayerSeqInfo; run?: PlayerSeqInfo; crouchWalk?: PlayerSeqInfo }
  attackStand?: PlayerGestureInfo
  attackCrouch?: PlayerGestureInfo
}

export interface PlayerModelItem extends PackModelItem {
  role: 'player:model'
  class: string
  bones: string[]
  anim: {
    version: number
    defSlots: Record<string, string>
    slots: Record<string, PlayerSlotInfo>
    clips: Record<string, { frames: number; fps: number; delta: boolean; motion?: [number, number] }>
  }
}

export interface PlayerAnimInput {
  /** anim slot, already resolved to one the item has (playerSlot) */
  slot: string
  deployed: boolean
  /** weights of crouching, moving and being in the air, 0..1 */
  crouch: number
  move: number
  air: number
  /** move_x, move_y pose parameters (-1..1) */
  moveX: number
  moveY: number
  /** horizontal distance travelled (run cycle) and time in seconds (idle cycles) */
  distance: number
  time: number
  /** body_pitch, degrees (up positive) */
  pitch: number
  /** the attack gesture playing, null for none */
  gesture: { crouch: boolean; t: number } | null
}

/** Manifest key of a class's animated model (`classKey` as in CLASS_MAP). */
export const playerModelKey = (classKey: string) => `models/player/${classKey === 'demoman' ? 'demo' : classKey}.mdl`

export function playerModelItem(items: Record<string, unknown> | undefined, classKey: string): PlayerModelItem | null {
  const item = items?.[playerModelKey(classKey)] as PlayerModelItem | undefined
  return item && item.kind === 'model' && item.role === 'player:model' && item.anim?.version === 1 ? item : null
}

/** The anim slot the item plays for item `def` (-1: none known), with TF2-like fallbacks to a slot it has. */
export function playerSlot(item: PlayerModelItem, def: number): string {
  const slots = item.anim.slots
  const want = def >= 0 ? item.anim.defSlots[String(def)] : undefined
  const tries = want ? [want, want.replace(/\d+$/, ''), want.replace(/_ALLCLASS$/, ''), want === 'BUILDING' ? 'SAPPER' : ''] : []
  tries.push('PRIMARY', 'SECONDARY', 'MELEE')
  for (const s of tries) if (s && slots[s]) return s
  return Object.keys(slots)[0] ?? 'PRIMARY'
}

// ---- compiled clips ----------------------------------------------------------------------------------------

interface CompiledClip {
  frames: number
  fps: number
  delta: boolean
  /** per bone: translation keys (frames x 3, or 3 for a constant) or null for the default */
  t: (Float32Array | null)[]
  r: (Float32Array | null)[]
}

export interface PlayerRigData {
  item: PlayerModelItem
  bones: string[]
  restT: Float32Array
  restR: Float32Array
  clips: Map<string, CompiledClip>
  /** per gesture part with weights: per-bone weight array */
  weights: WeakMap<object, Float32Array>
}

const rigs = new WeakMap<PackModelHandle, PlayerRigData>()

/** Bones of a copy in item order (lower-case name match); null entries for bones the copy lacks. */
export function copyBones(copy: Object3D, names: string[]): (Object3D | null)[] {
  const byName = new Map<string, Object3D>()
  copy.traverse(node => {
    const k = node.name.toLowerCase()
    if (!byName.has(k)) byName.set(k, node)
  })
  return names.map(n => byName.get(n.toLowerCase()) ?? null)
}

/** Clip data of a loaded player model, read once per handle. */
export function playerRig(handle: PackModelHandle, item: PlayerModelItem): PlayerRigData {
  let rig = rigs.get(handle)
  if (rig) return rig
  const bones = item.bones
  const index = new Map(bones.map((b, i) => [b.toLowerCase(), i]))
  const restT = new Float32Array(bones.length * 3)
  const restR = new Float32Array(bones.length * 4)
  const copy = handle.instantiate()
  copyBones(copy, bones).forEach((node, i) => {
    if (node) {
      node.position.toArray(restT, i * 3)
      node.quaternion.toArray(restR, i * 4)
    } else restR[i * 4 + 3] = 1
  })
  handle.release(copy)
  const clips = new Map<string, CompiledClip>()
  const byName = new Map<string, AnimationClip>(handle.clips.map(c => [c.name, c]))
  for (const [name, info] of Object.entries(item.anim.clips)) {
    const c: CompiledClip = { frames: info.frames, fps: info.fps || 30, delta: info.delta, t: new Array(bones.length).fill(null), r: new Array(bones.length).fill(null) }
    for (const track of byName.get(name)?.tracks ?? []) {
      const dot = track.name.lastIndexOf('.')
      const b = index.get(track.name.slice(0, dot).toLowerCase())
      if (b === undefined) continue
      const prop = track.name.slice(dot + 1)
      const values = track.values instanceof Float32Array ? track.values : Float32Array.from(track.values)
      if (prop === 'position') c.t[b] = values
      else if (prop === 'quaternion') c.r[b] = values
    }
    clips.set(name, c)
  }
  rig = { item, bones, restT, restR, clips, weights: new WeakMap() }
  rigs.set(handle, rig)
  return rig
}

// ---- evaluation --------------------------------------------------------------------------------------------

export interface PlayerPose {
  t: Float32Array
  r: Float32Array
}

export function createPlayerPose(rig: PlayerRigData): PlayerPose {
  return { t: new Float32Array(rig.bones.length * 3), r: new Float32Array(rig.bones.length * 4) }
}

interface Sample {
  clip: CompiledClip
  frame: number
  w: number
}

const _base: Sample[] = []
const _delta: Sample[] = []
const _over: { s: Sample; weights: Float32Array | null }[] = []
const _q = new Float32Array(4)
const _p = new Float32Array(3)

/** Frame of a looping clip at `cycle` (0..1). */
const loopFrame = (clip: CompiledClip, cycle: number) => (cycle - Math.floor(cycle)) * Math.max(0, clip.frames - 1)

function pushSeq(rig: PlayerRigData, seq: PlayerSeqInfo | undefined, w: number, input: PlayerAnimInput, moving: boolean) {
  if (!seq || w < 1e-4) return
  const first = rig.clips.get(seq.clips[0])
  if (!first) return
  // cycle: by distance for moving sequences (the feet stay planted), else by time
  let cycle: number
  if (moving && seq.stride && seq.stride > 1) cycle = input.distance / seq.stride
  else cycle = input.time / Math.max(1 / 30, (first.frames - 1) / first.fps)
  if (seq.grid && seq.clips.length === seq.grid.size[0] * seq.grid.size[1]) {
    const v = [0, 0]
    for (let d = 0; d < 2; d++) v[d] = seq.grid.p[d] === 'move_x' ? input.moveX : input.moveY
    const idx = [0, 0]
    const f = [0, 0]
    for (let d = 0; d < 2; d++) {
      const keys = seq.grid.k[d]
      const n = keys.length
      let i = 0
      while (i < n - 2 && v[d] > keys[i + 1]) i++
      const span = keys[i + 1] - keys[i] || 1
      idx[d] = i
      f[d] = Math.min(1, Math.max(0, (v[d] - keys[i]) / span))
    }
    const g0 = seq.grid.size[0]
    for (let a = 0; a < 2; a++) {
      for (let b = 0; b < 2; b++) {
        const wc = w * (a ? f[0] : 1 - f[0]) * (b ? f[1] : 1 - f[1])
        if (wc < 1e-4) continue
        const clip = rig.clips.get(seq.clips[idx[0] + a + (idx[1] + b) * g0])
        if (clip) _base.push({ clip, frame: loopFrame(clip, cycle), w: wc })
      }
    }
  } else {
    _base.push({ clip: first, frame: loopFrame(first, cycle), w })
  }
  // aim matrix: rows bracketing body_pitch
  const rows = seq.aim?.rows
  if (rows && rows.length) {
    const pitch = Math.min(rows[rows.length - 1].pitch, Math.max(rows[0].pitch, input.pitch))
    let i = 0
    while (i < rows.length - 2 && pitch > rows[i + 1].pitch) i++
    const j = Math.min(rows.length - 1, i + 1)
    const span = rows[j].pitch - rows[i].pitch || 1
    const fj = j === i ? 0 : Math.min(1, Math.max(0, (pitch - rows[i].pitch) / span))
    const ci = rig.clips.get(rows[i].clip)
    const cj = rig.clips.get(rows[j].clip)
    if (ci && 1 - fj > 1e-4) _delta.push({ clip: ci, frame: 0, w: w * (1 - fj) })
    if (cj && fj > 1e-4) _delta.push({ clip: cj, frame: 0, w: w * fj })
  }
}

function sampleT(clip: CompiledClip, b: number, frame: number, rest: Float32Array, out: Float32Array) {
  const v = clip.t[b]
  if (!v) {
    if (clip.delta) { out[0] = 0; out[1] = 0; out[2] = 0 }
    else { out[0] = rest[b * 3]; out[1] = rest[b * 3 + 1]; out[2] = rest[b * 3 + 2] }
    return
  }
  const n = v.length / 3
  if (n <= 1) {
    out[0] = v[0]; out[1] = v[1]; out[2] = v[2]
    return
  }
  const f = Math.min(Math.max(frame, 0), n - 1)
  const i = Math.floor(f)
  const j = Math.min(i + 1, n - 1)
  const a = f - i
  for (let k = 0; k < 3; k++) out[k] = v[i * 3 + k] * (1 - a) + v[j * 3 + k] * a
}

function sampleR(clip: CompiledClip, b: number, frame: number, rest: Float32Array, out: Float32Array) {
  const v = clip.r[b]
  if (!v) {
    if (clip.delta) { out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1 }
    else { out[0] = rest[b * 4]; out[1] = rest[b * 4 + 1]; out[2] = rest[b * 4 + 2]; out[3] = rest[b * 4 + 3] }
    return
  }
  const n = v.length / 4
  if (n <= 1) {
    out[0] = v[0]; out[1] = v[1]; out[2] = v[2]; out[3] = v[3]
    return
  }
  const f = Math.min(Math.max(frame, 0), n - 1)
  const i = Math.floor(f)
  const j = Math.min(i + 1, n - 1)
  const a = f - i
  const s = v[i * 4] * v[j * 4] + v[i * 4 + 1] * v[j * 4 + 1] + v[i * 4 + 2] * v[j * 4 + 2] + v[i * 4 + 3] * v[j * 4 + 3] < 0 ? -1 : 1
  let len = 0
  for (let k = 0; k < 4; k++) {
    out[k] = v[i * 4 + k] * (1 - a) + v[j * 4 + k] * a * s
    len += out[k] * out[k]
  }
  len = 1 / Math.sqrt(len || 1)
  for (let k = 0; k < 4; k++) out[k] *= len
}

function gestureWeights(rig: PlayerRigData, part: PlayerGestureInfo['parts'][number]): Float32Array | null {
  if (!part.weights) return null
  let w = rig.weights.get(part)
  if (!w) {
    w = new Float32Array(rig.bones.length)
    rig.bones.forEach((name, b) => {
      w![b] = part.weights![name] ?? 0
    })
    rig.weights.set(part, w)
  }
  return w
}

/** Fills `pose` with the bone-local transforms of `input`. */
export function evaluatePlayerPose(rig: PlayerRigData, input: PlayerAnimInput, pose: PlayerPose): void {
  const slot = rig.item.anim.slots[input.slot] ?? Object.values(rig.item.anim.slots)[0]
  _base.length = 0
  _delta.length = 0
  _over.length = 0
  if (slot) {
    const dep = input.deployed ? slot.deployed : undefined
    const stand = dep?.stand ?? slot.stand
    const crouch = (dep ? dep.crouch : undefined) ?? slot.crouch ?? stand
    const run = (dep ? dep.run : undefined) ?? slot.run ?? stand
    const crouchWalk = (dep ? dep.crouchWalk : undefined) ?? slot.crouchWalk ?? crouch
    const ground = 1 - input.air
    pushSeq(rig, stand, ground * (1 - input.move) * (1 - input.crouch), input, false)
    pushSeq(rig, crouch, ground * (1 - input.move) * input.crouch, input, false)
    pushSeq(rig, run, ground * input.move * (1 - input.crouch), input, true)
    pushSeq(rig, crouchWalk, ground * input.move * input.crouch, input, true)
    pushSeq(rig, slot.air ?? stand, input.air, input, false)
    const g = input.gesture ? (input.gesture.crouch ? slot.attackCrouch ?? slot.attackStand : slot.attackStand) : undefined
    if (g && input.gesture) {
      const t = input.gesture.t
      const w = Math.min(1, t / 0.05) * Math.min(1, Math.max(0, (g.duration - t) / 0.2))
      if (w > 1e-4) {
        for (const part of g.parts) {
          const clip = rig.clips.get(part.clip)
          if (!clip) continue
          const frame = Math.min(t * clip.fps, clip.frames - 1)
          const weights = gestureWeights(rig, part)
          if (part.delta && !weights) _delta.push({ clip, frame, w })
          else _over.push({ s: { clip, frame, w }, weights })
        }
      }
    }
  }

  const nb = rig.bones.length
  const { restT, restR } = rig
  const T = pose.t
  const R = pose.r
  // base: weighted blend (positions linear, rotations nlerp aligned to the rest rotation)
  let total = 0
  for (const s of _base) total += s.w
  for (let b = 0; b < nb; b++) {
    let px = 0, py = 0, pz = 0, qx = 0, qy = 0, qz = 0, qw = 0
    const rx = restR[b * 4], ry = restR[b * 4 + 1], rz = restR[b * 4 + 2], rw = restR[b * 4 + 3]
    if (total < 1e-4) {
      px = restT[b * 3]; py = restT[b * 3 + 1]; pz = restT[b * 3 + 2]
      qx = rx; qy = ry; qz = rz; qw = rw
    } else {
      for (const s of _base) {
        const w = s.w / total
        sampleT(s.clip, b, s.frame, restT, _p)
        px += _p[0] * w; py += _p[1] * w; pz += _p[2] * w
        sampleR(s.clip, b, s.frame, restR, _q)
        const sign = _q[0] * rx + _q[1] * ry + _q[2] * rz + _q[3] * rw < 0 ? -w : w
        qx += _q[0] * sign; qy += _q[1] * sign; qz += _q[2] * sign; qw += _q[3] * sign
      }
    }
    // delta layers: q = q * slerp(identity, d, w), p += d * w
    for (const s of _delta) {
      if (!s.clip.r[b] && !s.clip.t[b]) continue
      if (s.clip.t[b]) {
        sampleT(s.clip, b, s.frame, restT, _p)
        px += _p[0] * s.w; py += _p[1] * s.w; pz += _p[2] * s.w
      }
      if (s.clip.r[b]) {
        sampleR(s.clip, b, s.frame, restR, _q)
        let dx = _q[0] * s.w, dy = _q[1] * s.w, dz = _q[2] * s.w, dw = (_q[3] < 0 ? -_q[3] : _q[3]) * s.w + (1 - s.w)
        if (_q[3] < 0) { dx = -dx; dy = -dy; dz = -dz }
        const dl = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz + dw * dw)
        dx *= dl; dy *= dl; dz *= dl; dw *= dl
        const x = qx * dw + qw * dx + qy * dz - qz * dy
        const y = qy * dw + qw * dy + qz * dx - qx * dz
        const z = qz * dw + qw * dz + qx * dy - qy * dx
        const w = qw * dw - qx * dx - qy * dy - qz * dz
        qx = x; qy = y; qz = z; qw = w
      }
    }
    // absolute (or weighted delta) gesture layers
    for (const o of _over) {
      const bw = o.weights ? o.weights[b] : 1
      const w = o.s.w * bw
      if (w < 1e-4) continue
      const clip = o.s.clip
      if (clip.delta) {
        if (clip.t[b]) {
          sampleT(clip, b, o.s.frame, restT, _p)
          px += _p[0] * w; py += _p[1] * w; pz += _p[2] * w
        }
        if (clip.r[b]) {
          sampleR(clip, b, o.s.frame, restR, _q)
          const neg = _q[3] < 0 ? -1 : 1
          let dx = _q[0] * w * neg, dy = _q[1] * w * neg, dz = _q[2] * w * neg, dw = _q[3] * neg * w + (1 - w)
          const dl = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz + dw * dw)
          dx *= dl; dy *= dl; dz *= dl; dw *= dl
          const x = qx * dw + qw * dx + qy * dz - qz * dy
          const y = qy * dw + qw * dy + qz * dx - qx * dz
          const z = qz * dw + qw * dz + qx * dy - qy * dx
          const ww = qw * dw - qx * dx - qy * dy - qz * dz
          qx = x; qy = y; qz = z; qw = ww
        }
        continue
      }
      sampleT(clip, b, o.s.frame, restT, _p)
      px += (_p[0] - px) * w; py += (_p[1] - py) * w; pz += (_p[2] - pz) * w
      sampleR(clip, b, o.s.frame, restR, _q)
      const ql = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw) || 1
      qx /= ql; qy /= ql; qz /= ql; qw /= ql
      const sign = _q[0] * qx + _q[1] * qy + _q[2] * qz + _q[3] * qw < 0 ? -1 : 1
      qx += (_q[0] * sign - qx) * w; qy += (_q[1] * sign - qy) * w; qz += (_q[2] * sign - qz) * w; qw += (_q[3] * sign - qw) * w
    }
    const l = 1 / (Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw) || 1)
    T[b * 3] = px; T[b * 3 + 1] = py; T[b * 3 + 2] = pz
    R[b * 4] = qx * l; R[b * 4 + 1] = qy * l; R[b * 4 + 2] = qz * l; R[b * 4 + 3] = qw * l
  }
}

/** Writes a pose into a copy's bones (from copyBones). */
export function applyPlayerPose(bones: (Object3D | null)[], pose: PlayerPose): void {
  for (let b = 0; b < bones.length; b++) {
    const node = bones[b]
    if (!node) continue
    node.position.fromArray(pose.t, b * 3)
    node.quaternion.fromArray(pose.r, b * 4)
  }
}
