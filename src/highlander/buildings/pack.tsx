// Pack models for the buildings layer (asset contract 12.4, 12.5 W-buildings). A building draws its TF2 model when
// the pack serves the model of its current state, else its placeholder (per item, contract 5 cases 4 and 5).
// Everything is posed from tick arithmetic (4.4): build and upgrade sequences through AnimationMixer.setTime, the
// sentry aim through the model's own aim layers (additive deltas of `layer_aim_yaw` and `layer_aim_pitch`), so the
// same tickF always gives the same pose (D12). No number of a Valve model is written here; attachments, clips and
// skins come from the pack.

import { useEffect, useMemo } from 'react'
import * as THREE from 'three'

import { BLD, BUILDING_TYPE } from '@highlander/extras/enums'
import { sinceTick } from '@highlander/extras/track'
import type { HighlanderExtras } from '@highlander/extras/types'
import { attachmentMatrix, packTeamSkin, usePackModel, type PackModelHandle } from '@pack/models'
import { skipSceneUpdateWhileHidden } from '@highlander/perf/hiddenSubtree'

import { lastShotTicks, type BuildingDraw } from './render'
import { MINI_SCALE } from './sentryAim'

const M = (name: string) => `models/buildables/${name}.mdl`
/** sentry1_heavy's include model: it holds the sentry's build sequence, which plays on sentry1_heavy's bones. */
const SENTRY_ANIMS = M('sentry1_animations')
/** A disabled sentry without aim pose data lowers its gun to this pitch (Source: positive is down). */
const DROOP_PITCH = 50
/** Seconds the droop takes. */
const DROOP_SECONDS = 0.5
/** A sentry keeps cycling its fire sequence while shots follow within this many seconds. */
const FIRE_HOLD_SECONDS = 0.3

/** Model keys a building of `type` may draw, in a fixed order per type (one usePackModel call each). */
export function packBuildingKeys(type: number, mini: boolean): string[] {
  if (type === BUILDING_TYPE.SENTRY) {
    return mini
      ? [M('sentry1'), M('sentry1_heavy'), SENTRY_ANIMS, M('sapper_sentry1')]
      : [M('sentry1'), M('sentry2'), M('sentry3'), M('sentry1_heavy'), M('sentry2_heavy'), M('sentry3_heavy'), SENTRY_ANIMS, M('sapper_sentry1'), M('sapper_sentry2'), M('sapper_sentry3')]
  }
  if (type === BUILDING_TYPE.DISPENSER) return [M('dispenser'), M('dispenser_lvl2'), M('dispenser_lvl3'), M('sapper_dispenser')]
  if (type === BUILDING_TYPE.TELEPORTER) return [M('teleporter'), M('sapper_teleporter')]
  return []
}

/** Skin of a team, the mini variant's pair for mini sentries when the item lists one. */
export function skinOf(handle: PackModelHandle, team: 'red' | 'blue', mini: boolean): number {
  const pair = mini ? handle.info.variants?.mini?.skins : undefined
  if (pair && pair.length >= 2) return team === 'blue' ? pair[1] : pair[0]
  return packTeamSkin(handle.info, team === 'blue' ? 3 : 2)
}

export const packTeamSkinOf = (handle: PackModelHandle, team: 'red' | 'blue') => skinOf(handle, team, false)

// ─── one posed copy ───────────────────────────────────────────────────────────

interface Rest { node: THREE.Object3D; p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 }
interface Delta { node: THREE.Object3D; q: THREE.Quaternion | null; p: THREE.Vector3 | null }

const _qa = new THREE.Quaternion()
const _qb = new THREE.Quaternion()
const _va = new THREE.Vector3()
const _zero = new THREE.Vector3()

/** Frame 0 of an additive layer clip, resolved to the copy's nodes. */
function layerDeltas(copy: THREE.Object3D, clip: THREE.AnimationClip | undefined): Map<THREE.Object3D, Delta> | null {
  if (!clip) return null
  const out = new Map<THREE.Object3D, Delta>()
  for (const track of clip.tracks) {
    const dot = track.name.lastIndexOf('.')
    const node = copy.getObjectByName(track.name.slice(0, dot))
    const path = track.name.slice(dot + 1)
    if (!node) continue
    const d = out.get(node) ?? { node, q: null, p: null }
    if (path === 'quaternion') d.q = new THREE.Quaternion().fromArray(track.values, 0)
    else if (path === 'position') d.p = new THREE.Vector3().fromArray(track.values, 0)
    out.set(node, d)
  }
  return out
}

export class PackCopy {
  readonly object: THREE.Object3D
  readonly handle: PackModelHandle
  private mixer: THREE.AnimationMixer
  private rest: Rest[] = []
  private active: THREE.AnimationClip | null = null
  private yaw: { deg: number; deltas: Map<THREE.Object3D, Delta> | null }[] = []
  private pitch: { deg: number; deltas: Map<THREE.Object3D, Delta> | null }[] = []
  private layerNodes: Rest[] = []

  constructor(handle: PackModelHandle, skin: number) {
    this.handle = handle
    this.object = handle.instantiate(skin)
    this.object.visible = false
    skipSceneUpdateWhileHidden(this.object)
    this.mixer = new THREE.AnimationMixer(this.object)
    this.object.traverse(node => this.rest.push({ node, p: node.position.clone(), q: node.quaternion.clone(), s: node.scale.clone() }))
    const clip = (name: string) => handle.clips.find(c => c.name === name)
    // the aim layers by pose name, positive yaw to the left and positive pitch down as Source angles
    const yawPoses: [number, string][] = [[-180, 'a_yaw_back'], [-90, 'a_yaw_right'], [0, 'a_yaw_forward'], [90, 'a_yaw_left'], [180, 'a_yaw_back']]
    const pitchPoses: [number, string][] = [[-50, 'a_pitch_up'], [0, 'a_pitch_center'], [50, 'a_pitch_down']]
    if (yawPoses.every(([, n]) => clip(n))) this.yaw = yawPoses.map(([deg, n]) => ({ deg, deltas: layerDeltas(this.object, clip(n)) }))
    if (pitchPoses.every(([, n]) => clip(n))) this.pitch = pitchPoses.map(([deg, n]) => ({ deg, deltas: layerDeltas(this.object, clip(n)) }))
    const touched = new Set<THREE.Object3D>()
    for (const pose of [...this.yaw, ...this.pitch]) pose.deltas?.forEach((_, node) => touched.add(node))
    this.layerNodes = this.rest.filter(r => touched.has(r.node))
  }

  private toolbox: THREE.Object3D | null | undefined

  /**
   * Shows or hides the engineer's toolbox bones (the build sequence unfolds the building from it and leaves its lid
   * beside the built model); a hidden toolbox scales its root bone to zero.
   */
  showToolbox(visible: boolean) {
    if (this.toolbox === undefined) this.toolbox = this.object.getObjectByName('toolboxRoot') ?? null
    if (this.toolbox) this.toolbox.scale.setScalar(visible ? 1 : 0)
  }

  get hasAim() {
    return this.yaw.length > 0 && this.pitch.length > 0
  }

  clipNamed(name: string) {
    return this.handle.clips.find(c => c.name === name) ?? null
  }

  /** Plays `clip` at `seconds` (clamped to its end unless `loop`), or the rest pose for null. */
  play(clip: THREE.AnimationClip | null, seconds: number, loop = false) {
    if (clip !== this.active) {
      this.mixer.stopAllAction()
      for (const r of this.rest) {
        r.node.position.copy(r.p)
        r.node.quaternion.copy(r.q)
        r.node.scale.copy(r.s)
      }
      this.active = clip
      if (clip) {
        const action = this.mixer.clipAction(clip)
        action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity)
        action.clampWhenFinished = true
        action.play()
      }
    }
    if (!clip) return
    const d = clip.duration
    const t = loop ? ((seconds % d) + d) % d : Math.max(0, Math.min(d - 1e-4, seconds))
    this.mixer.setTime(t)
  }

  private applyLayer(poses: { deg: number; deltas: Map<THREE.Object3D, Delta> | null }[], deg: number) {
    let i = 0
    while (i < poses.length - 2 && deg > poses[i + 1].deg) i++
    const a = poses[i], b = poses[i + 1]
    const w = Math.max(0, Math.min(1, (deg - a.deg) / (b.deg - a.deg)))
    const nodes = new Set<THREE.Object3D>()
    a.deltas?.forEach((_, n) => nodes.add(n))
    b.deltas?.forEach((_, n) => nodes.add(n))
    nodes.forEach(node => {
      const da = a.deltas?.get(node), db = b.deltas?.get(node)
      _qa.copy(da?.q ?? _qb.identity())
      if (db?.q) _qa.slerp(db.q, w)
      else _qa.slerp(_qb.identity(), w)
      node.quaternion.multiply(_qa)
      _va.copy(da?.p ?? _zero).lerp(db?.p ?? _zero, w)
      node.position.add(_va)
    })
  }

  /**
   * The aim layers at relYaw and pitch (degrees, Source signs) over the rest pose, or over `clip` at `seconds`
   * (the fire and disabled sequences), as Source adds its aim layers to the playing sequence.
   */
  aim(relYaw: number, pitch: number, clip: THREE.AnimationClip | null = null, seconds = 0, loop = false) {
    for (const r of this.layerNodes) {
      r.node.position.copy(r.p)
      r.node.quaternion.copy(r.q)
    }
    this.play(clip, seconds, loop)
    const yaw = ((((relYaw + 180) % 360) + 360) % 360) - 180
    this.applyLayer(this.yaw, yaw)
    this.applyLayer(this.pitch, Math.max(-50, Math.min(50, pitch)))
  }

  dispose() {
    this.mixer.stopAllAction()
    this.mixer.uncacheRoot(this.object)
    this.object.removeFromParent()
    this.handle.release(this.object)
  }
}

// ─── the building's pack set ──────────────────────────────────────────────────

const _m = new THREE.Matrix4()
const _att = new THREE.Matrix4()
const _inv = new THREE.Matrix4()

/** The attachment's matrix relative to the copy's root (independent of where the copy is drawn). */
export function attachmentLocal(copy: PackCopy, name: string, out: THREE.Matrix4): boolean {
  if (!attachmentMatrix(copy.object, name, _att)) return false
  copy.object.updateWorldMatrix(true, false)
  out.copy(_inv.copy(copy.object.matrixWorld).invert()).multiply(_att)
  return true
}

export interface PackFrame {
  /** the building copy drawn this frame, or null for the placeholder */
  body: PackCopy | null
  /** the sapper copy drawn this frame */
  sapper: PackCopy | null
}

/** Picks and poses the copy for a draw state; returns null when the placeholder draws. */
export class PackBuilding {
  readonly group = new THREE.Group()
  private copies = new Map<string, PackCopy>()
  /** the clip-only sentry1_animations model (no copy: its clips play on sentry1_heavy) */
  private anims: PackModelHandle | null = null
  readonly frame: PackFrame = { body: null, sapper: null }

  constructor(private type: number, private mini: boolean) {
    this.group.name = 'packBuilding'
    if (mini) this.group.scale.setScalar(MINI_SCALE)
  }

  sync(handles: (PackModelHandle | null)[], team: 'red' | 'blue') {
    const want = new Set<string>()
    this.anims = null
    for (const h of handles) {
      if (!h) continue
      if (h.key === SENTRY_ANIMS) {
        this.anims = h
        continue
      }
      want.add(h.key)
      if (this.copies.has(h.key)) continue
      const copy = new PackCopy(h, skinOf(h, team, this.mini))
      this.copies.set(h.key, copy)
      this.group.add(copy.object)
    }
    for (const [key, copy] of this.copies) {
      if (want.has(key)) continue
      copy.dispose()
      this.copies.delete(key)
    }
  }

  dispose() {
    for (const copy of this.copies.values()) copy.dispose()
    this.copies.clear()
    this.frame.body = this.frame.sapper = null
  }

  private copy(name: string) {
    return this.copies.get(M(name)) ?? null
  }

  /**
   * A built sentry: a firing one cycles its `fire` sequence from the first shot of the burst while the shots last,
   * otherwise it rests; the aim layers go on top. A disabled or sapped one without pose data lowers its gun over
   * DROOP_SECONDS. Every time comes from tick arithmetic (D12).
   */
  private poseSentry(x: HighlanderExtras, body: PackCopy, d: BuildingDraw, tickF: number, tick: number) {
    if (!body.hasAim || !d.aim) {
      body.play(null, 0)
      return
    }
    const ipt = x.meta.intervalPerTick || 0.015
    const s = x.buildings.state
    const OFF = BLD.SAPPED | BLD.DISABLED | BLD.PLASMA
    // the networked aim pose already lowers a disabled sentry's gun (about 30 degrees within 1.5 s); only a sentry
    // without pose data lowers it here
    if (d.aim.source === 'none' && !d.ghost && (d.sapped || d.disabled)) {
      const since = sinceTick(s, d.instance, tick, i => (s.flags[i] & OFF) !== 0) ?? tick
      const seconds = Math.max(0, (tickF - since) * ipt)
      body.aim(d.aim.relYaw, d.aim.pitch + (DROOP_PITCH - d.aim.pitch) * Math.min(1, seconds / DROOP_SECONDS))
      return
    }
    const fire = body.clipNamed('@fire')
    const shots = fire ? lastShotTicks(x, d.instance, tickF, FIRE_HOLD_SECONDS / ipt) : null
    if (fire && shots && (tickF - shots.last) * ipt < FIRE_HOLD_SECONDS) {
      body.aim(d.aim.relYaw, d.aim.pitch, fire, (tickF - shots.first) * ipt, true)
      return
    }
    body.aim(d.aim.relYaw, d.aim.pitch)
  }

  /**
   * Poses the copy for `d` at `tickF`. Returns the pack frame (body null: draw the placeholder). The group's z
   * scale undoes the construction squash for models with a build sequence.
   */
  update(x: HighlanderExtras, d: BuildingDraw, tickF: number): PackFrame {
    const f = this.frame
    for (const c of this.copies.values()) c.object.visible = false
    f.body = f.sapper = null
    if (!d.drawn || !d.team) return f
    const ipt = x.meta.intervalPerTick || 0.015
    const s = x.buildings.state
    const tick = Math.floor(tickF)
    const flags = d.ghost ? BLD.BUILDING : 0
    const upgrading = d.upgradeRing >= 0
    const since = upgrading ? sinceTick(s, d.instance, tick, i => (s.flags[i] & BLD.UPGRADING) !== 0) ?? tick : tick
    const upSeconds = (tickF - since) * ipt
    let body: PackCopy | null = null
    let squash = true
    let toolbox = this.type !== BUILDING_TYPE.SENTRY
    const level = this.mini ? 1 : d.level
    if (this.type === BUILDING_TYPE.SENTRY) {
      const heavy = upgrading && level >= 2 ? this.copy(`sentry${level}_heavy`) : null
      const upgrade = heavy?.clipNamed('@upgrade')
      // construction: sentry1_heavy unfolds from the toolbox with the build sequence of its include model, as in
      // game, a mini sentry too (in its mini skin when the pack lists sentry1_heavy's mini variant); without that
      // model or clip (older packs) the level 1 model keeps the z scale-up
      const builder = flags ? this.copy('sentry1_heavy') : null
      const build = builder ? this.anims?.clips.find(c => c.name === '@build') ?? null : null
      if (heavy && upgrade && !flags) {
        body = heavy
        body.play(upgrade, upSeconds)
      } else if (builder && build) {
        body = builder
        body.play(build, d.builtFrac * build.duration)
        squash = false
        toolbox = true
      } else {
        body = this.copy(`sentry${level}`)
        if (body) this.poseSentry(x, body, d, tickF, tick)
      }
    } else if (this.type === BUILDING_TYPE.DISPENSER) {
      if (flags) {
        body = this.copy('dispenser')
        const build = body?.clipNamed('a_build_1') ?? body?.handle.clips.find(c => /build/.test(c.name)) ?? null
        if (body && build) {
          body.play(build, d.builtFrac * build.duration)
          squash = false
        } else body?.play(null, 0)
      } else {
        body = this.copy(level === 1 ? 'dispenser' : `dispenser_lvl${level}`)
        // the level 2 and 3 models only carry their upgrade sequence and level 1 its build: their last frame is the
        // built model (level 1's rest pose is the bind pose, with its ammo belt stretched out)
        const clip = body ? (level >= 2 ? body.clipNamed('@upgrade') : body.clipNamed('a_build_1')) : null
        if (body) body.play(clip, upgrading && level >= 2 ? upSeconds : Infinity)
      }
    } else if (this.type === BUILDING_TYPE.TELEPORTER) {
      body = this.copy('teleporter')
      const build = body?.clipNamed('@build') ?? null
      if (body && flags && build) {
        body.play(build, d.builtFrac * build.duration)
        squash = false
      } else body?.play(null, 0)
    }
    if (!body) return f
    if (toolbox) body.showToolbox(!!flags)
    body.object.visible = true
    f.body = body
    const miniScale = this.mini ? MINI_SCALE : 1
    this.group.scale.set(miniScale, miniScale, miniScale * (squash ? 1 : 1 / Math.max(0.01, d.scaleZ)))

    if (d.sapper) {
      const name =
        this.type === BUILDING_TYPE.SENTRY ? `sapper_sentry${level}` : this.type === BUILDING_TYPE.DISPENSER ? 'sapper_dispenser' : 'sapper_teleporter'
      const sapper = this.copy(name)
      if (sapper && attachmentLocal(body, 'build_point_0', _m)) {
        _m.decompose(sapper.object.position, sapper.object.quaternion, sapper.object.scale)
        sapper.object.scale.setScalar(1)
        const idle = sapper.clipNamed('@idle')
        sapper.play(idle, tickF * ipt, true)
        sapper.object.visible = true
        f.sapper = sapper
      }
    }
    return f
  }
}

/** The pack set of one mounted building: handles from usePackModel, copies owned by the component. */
export function usePackBuilding(type: number, mini: boolean, team: 'red' | 'blue'): PackBuilding {
  const keys = useMemo(() => packBuildingKeys(type, mini), [type, mini])
  // the key list is fixed for an instance (type and mini never change), so the hook count is stable
  const handles = keys.map(key => usePackModel(key)) // eslint-disable-line react-hooks/rules-of-hooks
  const pack = useMemo(() => new PackBuilding(type, mini), [type, mini])
  useEffect(() => () => pack.dispose(), [pack])
  // copies follow the handles at once, so turning assets.models off returns to the placeholder in the same frame
  pack.sync(handles, team)
  return pack
}

/** Every model the layer may draw (buildings, sappers, blueprints). */
export const PACK_LAYER_KEYS = [
  ...packBuildingKeys(BUILDING_TYPE.SENTRY, false),
  ...packBuildingKeys(BUILDING_TYPE.DISPENSER, false),
  ...packBuildingKeys(BUILDING_TYPE.TELEPORTER, false),
  M('sentry1_blueprint'),
  M('dispenser_blueprint'),
  M('teleporter_blueprint_enter'),
  M('teleporter_blueprint_exit'),
]

/**
 * Holds one reference to every building model while the layer is mounted, so a seek that unmounts the last sentry
 * neither disposes its model nor reloads it on the next one (and no model is released while it still compiles).
 */
export function useRetainPackModels() {
  // a constant list: the hook count never changes
  for (const key of PACK_LAYER_KEYS) usePackModel(key) // eslint-disable-line react-hooks/rules-of-hooks
}

// ─── sentry muzzle registry (sentryMuzzleAt reads the drawn pack sentry's attachments) ─────────────────

export interface PackMuzzle {
  /** The barrel's tip in the building's frame (origin at its position, +X along its build yaw), or false. */
  (tickF: number, barrel: number, out: THREE.Vector3): boolean
}

const muzzles = new WeakMap<HighlanderExtras, Map<number, PackMuzzle>>()

export function setPackMuzzle(x: HighlanderExtras, j: number, fn: PackMuzzle | null) {
  let map = muzzles.get(x)
  if (!map) muzzles.set(x, (map = new Map()))
  if (fn) map.set(j, fn)
  else map.delete(j)
}

export function packMuzzleOf(x: HighlanderExtras, j: number): PackMuzzle | null {
  return muzzles.get(x)?.get(j) ?? null
}

/** Attachment name of a muzzle: `muzzle` on level 1, `muzzle_l` and `muzzle_r` for the twin barrels. */
export function muzzleAttachment(copy: PackCopy, barrel: number): string {
  const a = copy.handle.info.attachments
  if (a.muzzle_l && a.muzzle_r) return SENTRY_SIDE[barrel] ?? 'muzzle_l'
  return 'muzzle'
}
// SENTRY.barrel offsets: barrel 0 at -y (right), barrel 1 at +y (left)
const SENTRY_SIDE = ['muzzle_r', 'muzzle_l']

const _rel = new THREE.Matrix4()
/** The muzzle in the building's frame: the copy's attachment through the pack group's scale. */
export function muzzleInBuilding(pack: PackBuilding, copy: PackCopy, barrel: number, out: THREE.Vector3, scaleZ: number): boolean {
  if (!attachmentLocal(copy, muzzleAttachment(copy, barrel), _rel)) return false
  out.setFromMatrixPosition(_rel)
  out.multiply(pack.group.scale)
  out.z *= scaleZ
  return true
}
