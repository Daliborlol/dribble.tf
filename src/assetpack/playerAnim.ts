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

// Reused sample records: a pose evaluation allocates nothing.
const _basePool: Sample[] = []
const _deltaPool: Sample[] = []
const _overPool: { s: Sample; weights: Float32Array | null }[] = []
let _baseCount = 0
let _deltaCount = 0
let _overCount = 0

function pushBase(clip: CompiledClip, frame: number, w: number) {
  const s = _basePool[_baseCount] ?? (_basePool[_baseCount] = { clip, frame, w })
  s.clip = clip
  s.frame = frame
  s.w = w
  _baseCount++
}
function pushDelta(clip: CompiledClip, frame: number, w: number) {
  const s = _deltaPool[_deltaCount] ?? (_deltaPool[_deltaCount] = { clip, frame, w })
  s.clip = clip
  s.frame = frame
  s.w = w
  _deltaCount++
}
function pushOver(clip: CompiledClip, frame: number, w: number, weights: Float32Array | null) {
  const o = _overPool[_overCount] ?? (_overPool[_overCount] = { s: { clip, frame, w }, weights })
  o.s.clip = clip
  o.s.frame = frame
  o.s.w = w
  o.weights = weights
  _overCount++
}

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
    const grid = seq.grid
    const v0 = grid.p[0] === 'move_x' ? input.moveX : input.moveY
    const v1 = grid.p[1] === 'move_x' ? input.moveX : input.moveY
    const k0 = grid.k[0], k1 = grid.k[1]
    let i0 = 0
    while (i0 < k0.length - 2 && v0 > k0[i0 + 1]) i0++
    let i1 = 0
    while (i1 < k1.length - 2 && v1 > k1[i1 + 1]) i1++
    const f0 = Math.min(1, Math.max(0, (v0 - k0[i0]) / (k0[i0 + 1] - k0[i0] || 1)))
    const f1 = Math.min(1, Math.max(0, (v1 - k1[i1]) / (k1[i1 + 1] - k1[i1] || 1)))
    const g0 = grid.size[0]
    for (let a = 0; a < 2; a++) {
      for (let b = 0; b < 2; b++) {
        const wc = w * (a ? f0 : 1 - f0) * (b ? f1 : 1 - f1)
        if (wc < 1e-4) continue
        const clip = rig.clips.get(seq.clips[i0 + a + (i1 + b) * g0])
        if (clip) pushBase(clip, loopFrame(clip, cycle), wc)
      }
    }
  } else {
    pushBase(first, loopFrame(first, cycle), w)
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
    if (ci && 1 - fj > 1e-4) pushDelta(ci, 0, w * (1 - fj))
    if (cj && fj > 1e-4) pushDelta(cj, 0, w * fj)
  }
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

/** Bones a clip has a track for, ascending (delta layers touch only those). */
const trackedBones = new WeakMap<CompiledClip, Int32Array>()
function tracked(clip: CompiledClip): Int32Array {
  let list = trackedBones.get(clip)
  if (!list) {
    const out: number[] = []
    for (let b = 0; b < clip.t.length; b++) if (clip.t[b] || clip.r[b]) out.push(b)
    list = Int32Array.from(out)
    trackedBones.set(clip, list)
  }
  return list
}

// Accumulators, 7 per bone: position and the unnormalized rotation.
let _acc = new Float64Array(0)

/** Adds one sample's blend contribution to every bone: its tracks read in one pass, frame position computed once. */
function addBase(acc: Float64Array, clip: CompiledClip, frame: number, w: number, nb: number, restT: Float32Array, restR: Float32Array) {
  const delta = clip.delta
  const tt = clip.t, rr = clip.r
  let lastN = -1, i = 0, j = 0, f = 0
  for (let b = 0; b < nb; b++) {
    const o = b * 7
    // translation
    const vt = tt[b]
    if (!vt) {
      if (!delta) {
        acc[o] += restT[b * 3] * w
        acc[o + 1] += restT[b * 3 + 1] * w
        acc[o + 2] += restT[b * 3 + 2] * w
      }
    } else {
      const n = vt.length / 3
      if (n <= 1) {
        acc[o] += vt[0] * w
        acc[o + 1] += vt[1] * w
        acc[o + 2] += vt[2] * w
      } else {
        if (n !== lastN) {
          lastN = n
          const c = Math.min(Math.max(frame, 0), n - 1)
          i = Math.floor(c)
          j = Math.min(i + 1, n - 1)
          f = c - i
        }
        const it = i * 3, jt = j * 3, g = 1 - f
        acc[o] += (vt[it] * g + vt[jt] * f) * w
        acc[o + 1] += (vt[it + 1] * g + vt[jt + 1] * f) * w
        acc[o + 2] += (vt[it + 2] * g + vt[jt + 2] * f) * w
      }
    }
    // rotation, aligned to the rest rotation
    const rx = restR[b * 4], ry = restR[b * 4 + 1], rz = restR[b * 4 + 2], rw = restR[b * 4 + 3]
    const vr = rr[b]
    let qx: number, qy: number, qz: number, qw: number
    if (!vr) {
      if (delta) { qx = 0; qy = 0; qz = 0; qw = 1 }
      else { qx = rx; qy = ry; qz = rz; qw = rw }
    } else {
      const n = vr.length / 4
      if (n <= 1) {
        qx = vr[0]; qy = vr[1]; qz = vr[2]; qw = vr[3]
      } else {
        if (n !== lastN) {
          lastN = n
          const c = Math.min(Math.max(frame, 0), n - 1)
          i = Math.floor(c)
          j = Math.min(i + 1, n - 1)
          f = c - i
        }
        const a = i * 4, c = j * 4
        const ax = vr[a], ay = vr[a + 1], az = vr[a + 2], aw = vr[a + 3]
        if (f === 0) {
          qx = ax; qy = ay; qz = az; qw = aw
        } else {
          const cx = vr[c], cy = vr[c + 1], cz = vr[c + 2], cw = vr[c + 3]
          const s = ax * cx + ay * cy + az * cz + aw * cw < 0 ? -f : f
          const g = 1 - f
          qx = ax * g + cx * s
          qy = ay * g + cy * s
          qz = az * g + cz * s
          qw = aw * g + cw * s
          const l = 1 / Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw || 1)
          qx *= l; qy *= l; qz *= l; qw *= l
        }
      }
    }
    const sign = qx * rx + qy * ry + qz * rz + qw * rw < 0 ? -w : w
    acc[o + 3] += qx * sign
    acc[o + 4] += qy * sign
    acc[o + 5] += qz * sign
    acc[o + 6] += qw * sign
  }
}

const _q = new Float64Array(4)
const _p = new Float64Array(3)

function readT(v: Float32Array, frame: number) {
  const n = v.length / 3
  if (n <= 1) { _p[0] = v[0]; _p[1] = v[1]; _p[2] = v[2]; return }
  const c = Math.min(Math.max(frame, 0), n - 1)
  const i = Math.floor(c), j = Math.min(i + 1, n - 1), a = c - i
  _p[0] = v[i * 3] * (1 - a) + v[j * 3] * a
  _p[1] = v[i * 3 + 1] * (1 - a) + v[j * 3 + 1] * a
  _p[2] = v[i * 3 + 2] * (1 - a) + v[j * 3 + 2] * a
}

function readR(v: Float32Array, frame: number) {
  const n = v.length / 4
  if (n <= 1) { _q[0] = v[0]; _q[1] = v[1]; _q[2] = v[2]; _q[3] = v[3]; return }
  const c = Math.min(Math.max(frame, 0), n - 1)
  const i = Math.floor(c), j = Math.min(i + 1, n - 1), a = c - i
  const s = v[i * 4] * v[j * 4] + v[i * 4 + 1] * v[j * 4 + 1] + v[i * 4 + 2] * v[j * 4 + 2] + v[i * 4 + 3] * v[j * 4 + 3] < 0 ? -1 : 1
  let len = 0
  for (let k = 0; k < 4; k++) {
    _q[k] = v[i * 4 + k] * (1 - a) + v[j * 4 + k] * a * s
    len += _q[k] * _q[k]
  }
  len = 1 / Math.sqrt(len || 1)
  for (let k = 0; k < 4; k++) _q[k] *= len
}

/** Fills `pose` with the bone-local transforms of `input`. */
export function evaluatePlayerPose(rig: PlayerRigData, input: PlayerAnimInput, pose: PlayerPose): void {
  const slot = rig.item.anim.slots[input.slot] ?? Object.values(rig.item.anim.slots)[0]
  _baseCount = 0
  _deltaCount = 0
  _overCount = 0
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
          if (part.delta && !weights) pushDelta(clip, frame, w)
          else pushOver(clip, frame, w, weights)
        }
      }
    }
  }

  const nb = rig.bones.length
  const { restT, restR } = rig
  const T = pose.t
  const R = pose.r
  if (_acc.length < nb * 7) _acc = new Float64Array(nb * 7)
  const acc = _acc
  // base: weighted blend (positions linear, rotations nlerp aligned to the rest rotation)
  let total = 0
  for (let k = 0; k < _baseCount; k++) total += _basePool[k].w
  if (total < 1e-4) {
    for (let b = 0; b < nb; b++) {
      const o = b * 7
      acc[o] = restT[b * 3]; acc[o + 1] = restT[b * 3 + 1]; acc[o + 2] = restT[b * 3 + 2]
      acc[o + 3] = restR[b * 4]; acc[o + 4] = restR[b * 4 + 1]; acc[o + 5] = restR[b * 4 + 2]; acc[o + 6] = restR[b * 4 + 3]
    }
  } else {
    acc.fill(0, 0, nb * 7)
    for (let k = 0; k < _baseCount; k++) {
      const s = _basePool[k]
      addBase(acc, s.clip, s.frame, s.w / total, nb, restT, restR)
    }
  }
  // delta layers: q = q * slerp(identity, d, w), p += d * w
  for (let k = 0; k < _deltaCount; k++) {
    const s = _deltaPool[k]
    const clip = s.clip
    const list = tracked(clip)
    const sw = s.w
    for (let n = 0; n < list.length; n++) {
      const b = list[n]
      const o = b * 7
      const vt = clip.t[b]
      if (vt) {
        readT(vt, s.frame)
        acc[o] += _p[0] * sw; acc[o + 1] += _p[1] * sw; acc[o + 2] += _p[2] * sw
      }
      const vr = clip.r[b]
      if (vr) {
        readR(vr, s.frame)
        let dx = _q[0] * sw, dy = _q[1] * sw, dz = _q[2] * sw, dw = (_q[3] < 0 ? -_q[3] : _q[3]) * sw + (1 - sw)
        if (_q[3] < 0) { dx = -dx; dy = -dy; dz = -dz }
        const dl = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz + dw * dw)
        dx *= dl; dy *= dl; dz *= dl; dw *= dl
        const qx = acc[o + 3], qy = acc[o + 4], qz = acc[o + 5], qw = acc[o + 6]
        acc[o + 3] = qx * dw + qw * dx + qy * dz - qz * dy
        acc[o + 4] = qy * dw + qw * dy + qz * dx - qx * dz
        acc[o + 5] = qz * dw + qw * dz + qx * dy - qy * dx
        acc[o + 6] = qw * dw - qx * dx - qy * dy - qz * dz
      }
    }
  }
  // absolute (or weighted delta) gesture layers
  for (let k = 0; k < _overCount; k++) {
    const over = _overPool[k]
    const clip = over.s.clip
    const frame = over.s.frame
    for (let b = 0; b < nb; b++) {
      const bw = over.weights ? over.weights[b] : 1
      const w = over.s.w * bw
      if (w < 1e-4) continue
      const o = b * 7
      let px = acc[o], py = acc[o + 1], pz = acc[o + 2], qx = acc[o + 3], qy = acc[o + 4], qz = acc[o + 5], qw = acc[o + 6]
      const vt = clip.t[b], vr = clip.r[b]
      if (clip.delta) {
        if (vt) {
          readT(vt, frame)
          acc[o] = px + _p[0] * w; acc[o + 1] = py + _p[1] * w; acc[o + 2] = pz + _p[2] * w
        }
        if (vr) {
          readR(vr, frame)
          const neg = _q[3] < 0 ? -1 : 1
          let dx = _q[0] * w * neg, dy = _q[1] * w * neg, dz = _q[2] * w * neg, dw = _q[3] * neg * w + (1 - w)
          const dl = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz + dw * dw)
          dx *= dl; dy *= dl; dz *= dl; dw *= dl
          acc[o + 3] = qx * dw + qw * dx + qy * dz - qz * dy
          acc[o + 4] = qy * dw + qw * dy + qz * dx - qx * dz
          acc[o + 5] = qz * dw + qw * dz + qx * dy - qy * dx
          acc[o + 6] = qw * dw - qx * dx - qy * dy - qz * dz
        }
        continue
      }
      if (vt) readT(vt, frame)
      else { _p[0] = restT[b * 3]; _p[1] = restT[b * 3 + 1]; _p[2] = restT[b * 3 + 2] }
      acc[o] = px + (_p[0] - px) * w; acc[o + 1] = py + (_p[1] - py) * w; acc[o + 2] = pz + (_p[2] - pz) * w
      if (vr) readR(vr, frame)
      else { _q[0] = restR[b * 4]; _q[1] = restR[b * 4 + 1]; _q[2] = restR[b * 4 + 2]; _q[3] = restR[b * 4 + 3] }
      const ql = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw) || 1
      qx /= ql; qy /= ql; qz /= ql; qw /= ql
      const sign = _q[0] * qx + _q[1] * qy + _q[2] * qz + _q[3] * qw < 0 ? -1 : 1
      acc[o + 3] = qx + (_q[0] * sign - qx) * w
      acc[o + 4] = qy + (_q[1] * sign - qy) * w
      acc[o + 5] = qz + (_q[2] * sign - qz) * w
      acc[o + 6] = qw + (_q[3] * sign - qw) * w
    }
  }
  for (let b = 0; b < nb; b++) {
    const o = b * 7
    const qx = acc[o + 3], qy = acc[o + 4], qz = acc[o + 5], qw = acc[o + 6]
    const l = 1 / (Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw) || 1)
    T[b * 3] = acc[o]; T[b * 3 + 1] = acc[o + 1]; T[b * 3 + 2] = acc[o + 2]
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
