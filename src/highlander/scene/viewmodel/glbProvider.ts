// GLB viewmodel provider (asset contract 10 and 13, V-provider): priority 10, over the pack's `viewmodels` stage.
// It draws the class's c_arms model with the active weapon's c_model bone-merged onto it, both in the team skin,
// and plays the arms' sequences from tick arithmetic (contract 4.4).
//
// - Models come from `@pack/models` and are held here with a reference count of our own: ViewmodelLayer requests
//   the pair for the subject's (class, weapon) and re-renders when both are loaded; every instance holds its own
//   reference and releases it in dispose(), so instances kept in the layer's LRU stay valid after the request moves on.
// - supports() is true only when the pack is ready, assets.enabled, assets.models and assets.viewmodels are on, the
//   arms list a model for the weapon def, both models are loaded, and the subject has local tables (old demos such as
//   the 6v6 sample keep the placeholder). Everything else falls back to the placeholder provider per weapon.
// - Sequences: the networked `vm0.seq` (an index into the arms' virtual model, contract 13.2) played at
//   `(tickF - vm0.since) x interval x vm0.rate` seconds; when vm0 is missing or shows another model, draw, idle, fire
//   and reload are derived from the weapon switch, fire events and the reload phases of the input, by activity.
// - Standalone viewmodels (`viewmodel:standalone`): the Gunslinger's c_engineer_gunslinger arms and the disguise kit's
//   v_pda_spy draw alone, without a c_model, while a def the item lists is out; they take the arms' place in every rule
//   here (vm0 sequences, derived sequences, team skin, cloak fade). An item that also lists `weapons` overrides the
//   class's arms while vm0 names it: an engineer with the Gunslinger equipped holds his shotgun, pistol and PDAs in
//   those arms.
// - Bone merge (13.3): every frame the weapon's `mergeBones` copy the transform of the arms bone of the same name.
// - The muzzle is the weapon's `muzzle` attachment, else its root bone; ViewmodelLayer turns it into
//   vmShared.live.muzzleWorld, where F3's own-muzzle tracers start.
// - Extras (P-viewmodel): a minigun's `barrel` bone turns by the placeholder's tick-driven spin angle; the arms' rocket
//   mesh (the soldier's reload rocket, one bodygroup with the arms, so no bodygroup switch hides it) draws only while a
//   primary weapon is out; the spy's watch hand is viewmodel 1, the pack's `viewmodel:watch` model named by
//   `vm1.model`, playing `vm1.seq` with vm1's own since and rate while vm1 is drawn.
//
// No number from a Valve model is in this file: positions, bones and sequences all come from the pack at runtime.

import * as THREE from 'three'
import type { Camera, Scene, WebGLRenderer } from 'three'

import { CLASS_MAP } from '@constants/mappings'
import { itemInfo } from '@highlander/items'
import { getAssetSetting } from '@pack/hooks'
import { acquirePackModel, packTeamSkin, releasePackModel, type PackModelHandle, type PackModelItem } from '@pack/models'
import { getAssetPackState } from '@pack/pack'

import { computePose, MELEE_KINDS } from './animate'
import { prepareViewmodelObject, VM_GLOW_ORDER } from './kit'
import { registerViewmodelProvider, type ViewmodelInput, type ViewmodelInstance, type ViewmodelProvider } from './provider'
import { flashTexture } from './textures'
import { resolveKind } from './weapons'

export const GLB_PROVIDER_ID = 'glb'

interface VmSequence { name: string; frames: number; fps: number; clip: string | null; loop?: boolean; activity?: string | null }
export interface ArmsItem extends PackModelItem {
  role: 'viewmodel:arms' | 'viewmodel:standalone'
  class: string
  /** standalone items: the weapon defs it replaces the arms and weapon pair for */
  defs?: number[]
  sequences: VmSequence[]
  sequenceIndex?: Record<string, number>
  /** arms items and standalone arms overrides: def -> weapon c_model key */
  weapons?: Record<string, string>
}
export interface WatchItem extends PackModelItem {
  role: 'viewmodel:watch'
  sequences: VmSequence[]
}
interface WeaponItem extends PackModelItem {
  role: 'viewmodel:weapon'
  viewmodel?: { defs: number[]; classes: string[]; mergeBones?: Record<string, string[]> }
}

/** Source rig axes (+X forward, +Y left, +Z up) to camera axes (+x right, +y up, -z forward), as the placeholder. */
const EYE_FROM_SOURCE = new THREE.Quaternion().setFromRotationMatrix(
  new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0))
)

// ─── manifest lookups ──────────────────────────────────────────────────────────

/** class name -> arms key, per manifest object (the manifest is replaced, never mutated). */
const armsByManifest = new WeakMap<object, Map<string, string>>()

function armsKeyOf(className: string): string | null {
  const manifest = getAssetPackState().manifest as { items?: Record<string, any> } | null
  if (!manifest?.items) return null
  let map = armsByManifest.get(manifest)
  if (!map) {
    map = new Map()
    for (const [key, item] of Object.entries(manifest.items)) {
      if (item?.kind === 'model' && item.role === 'viewmodel:arms' && typeof item.class === 'string') map.set(item.class, key)
    }
    armsByManifest.set(manifest, map)
  }
  return map.get(className) ?? null
}

/** `<class>:<def>` -> standalone viewmodel key, per manifest object. */
const standaloneByManifest = new WeakMap<object, Map<string, string>>()

function standaloneKeyOf(className: string, def: number): string | null {
  const manifest = getAssetPackState().manifest as { items?: Record<string, any> } | null
  if (!manifest?.items) return null
  let map = standaloneByManifest.get(manifest)
  if (!map) {
    map = new Map()
    for (const [key, item] of Object.entries(manifest.items)) {
      if (item?.kind !== 'model' || item.role !== 'viewmodel:standalone' || typeof item.class !== 'string' || !Array.isArray(item.defs)) continue
      for (const d of item.defs) map.set(`${item.class}:${d}`, key)
    }
    standaloneByManifest.set(manifest, map)
  }
  return map.get(`${className}:${def}`) ?? null
}

const itemOf = <T>(key: string): T | null => (getAssetPackState().manifest?.items?.[key] as T | undefined) ?? null

/** The c_arms class name: CLASS_MAP calls the demoman 'demoman', as the arms items do. */
const className = (classId: number): string | null => {
  const name = CLASS_MAP[classId]
  return name && name !== 'empty' ? name : null
}

/** Pack switches of viewmodels: pack ready, assets.enabled, assets.models (the model loader) and assets.viewmodels. */
export function packViewmodelsOn(): boolean {
  return (
    getAssetPackState().status === 'ready' &&
    getAssetSetting('enabled') &&
    getAssetSetting('models') &&
    getAssetSetting('viewmodels')
  )
}

/** `weapon` is null for a standalone viewmodel, which draws without a c_model. */
export interface VmKeys { arms: string; weapon: string | null }

/**
 * Weapon kinds that keep the placeholder although the pack lists them (none now). The minigun family draws from
 * the pack: TF2's own m_* clips hold the heavy's left hand on the carry handle at the bottom centre with the gun
 * below it, which is how the game shows it (the legacy v_minigun_heavy has the same root and hand).
 */
const PACK_POSE_EXCLUDED = new Set<string>()

/** The reason a weapon keeps the placeholder although the pack lists it, or null. */
export function packPoseExcluded(kind: string, weaponClass?: string): string | null {
  const k = resolveKind(kind, weaponClass)
  return PACK_POSE_EXCLUDED.has(k) ? `pose:${k}` : null
}

/** The standalone item vm0 names when it overrides `cls`'s arms (it lists weapons), else null. */
function armsOverrideOf(cls: string, vm0Model: string | null | undefined): string | null {
  if (!vm0Model) return null
  const key = vm0Model.toLowerCase().replace(/\\/g, '/')
  const item = itemOf<ArmsItem>(key)
  return item?.kind === 'model' && item.role === 'viewmodel:standalone' && item.class === cls && item.weapons ? key : null
}

/**
 * Arms and weapon model keys of (class, weapon def), or null when the pack is off or lists none. `vm0Model` is the
 * networked viewmodel 0 model: an arms override it names (the Gunslinger arms) replaces the class's c_arms.
 */
export function glbViewmodelKeys(classId: number, weaponDef: number, vm0Model?: string | null): VmKeys | null {
  if (!packViewmodelsOn()) return null
  const cls = className(classId)
  const standalone = cls ? standaloneKeyOf(cls, weaponDef) : null
  if (standalone) return { arms: standalone, weapon: null }
  const arms = cls ? armsOverrideOf(cls, vm0Model) ?? armsKeyOf(cls) : null
  if (!arms) return null
  const weapon = itemOf<ArmsItem>(arms)?.weapons?.[String(weaponDef)]
  if (!weapon || !itemOf<WeaponItem>(weapon)) return null
  return { arms, weapon }
}

/** The pack key of a watch viewmodel (vm1.model), or null when the pack is off or lists no watch under it. */
export function watchKeyOf(model: string | null | undefined): string | null {
  if (!model || !packViewmodelsOn()) return null
  const key = model.toLowerCase().replace(/\\/g, '/')
  const item = itemOf<{ kind?: string; role?: string }>(key)
  return item?.kind === 'model' && item.role === 'viewmodel:watch' ? key : null
}

// ─── model references ──────────────────────────────────────────────────────────

interface Held { refs: number; handle: PackModelHandle | null; done: boolean; promise: Promise<PackModelHandle | null> }
/** Pack models the viewmodel code holds (pack handles, never demo data: contract 12.3 memory rule). */
const held = new Map<string, Held>()

function hold(key: string, gl: WebGLRenderer, scene: Scene, camera: Camera): Promise<PackModelHandle | null> {
  let entry = held.get(key)
  if (!entry) {
    const created: Held = { refs: 0, handle: null, done: false, promise: Promise.resolve(null) }
    created.promise = acquirePackModel(key, gl, scene, camera).then(handle => {
      created.handle = handle
      created.done = true
      return handle
    })
    held.set(key, created)
    entry = created
  }
  entry.refs++
  return entry.promise
}

/** Another reference to a model that is already loaded (instances); false when it is not. */
function holdLoaded(key: string): PackModelHandle | null {
  const entry = held.get(key)
  if (!entry?.handle) return null
  entry.refs++
  return entry.handle
}

function unhold(key: string) {
  const entry = held.get(key)
  if (!entry) return
  entry.refs--
  if (entry.refs > 0) return
  held.delete(key)
  releasePackModel(key)
}

const loadedHandle = (key: string): PackModelHandle | null => held.get(key)?.handle ?? null

/** Both models loaded, bound and compiled. */
export function glbModelsReady(keys: VmKeys | null): boolean {
  return !!keys && !!loadedHandle(keys.arms) && (keys.weapon === null || !!loadedHandle(keys.weapon))
}

/**
 * Loads the pair for the layer; `onSettled` runs once both settled (loaded or failed). Returns the release, which
 * the layer calls when the subject's (class, weapon) changes or it unmounts.
 */
export function requestViewmodelModels(keys: VmKeys, gl: WebGLRenderer, scene: Scene, camera: Camera, onSettled: () => void): () => void {
  let alive = true
  const list = keys.weapon ? [keys.arms, keys.weapon] : [keys.arms]
  Promise.all(list.map(k => hold(k, gl, scene, camera))).then(() => {
    if (alive) onSettled()
  })
  return () => {
    alive = false
    for (const k of list) unhold(k)
  }
}

/** Loads watch models (the subject's vm1 models) ahead of the cloak; same contract as requestViewmodelModels. */
export function requestWatchModels(keys: string[], gl: WebGLRenderer, scene: Scene, camera: Camera, onSettled: () => void): () => void {
  let alive = true
  Promise.all(keys.map(k => hold(k, gl, scene, camera))).then(() => {
    if (alive) onSettled()
  })
  return () => {
    alive = false
    for (const k of keys) unhold(k)
  }
}

/** Probe rows: the models the viewmodel code holds. */
export function heldViewmodelModels() {
  return Array.from(held.entries()).map(([key, e]) => ({ key, refs: e.refs, loaded: !!e.handle, failed: e.done && !e.handle }))
}

// ─── sequences ─────────────────────────────────────────────────────────────────

const SLOT_ACT: Record<string, string> = {
  primary: 'PRIMARY',
  secondary: 'SECONDARY',
  melee: 'MELEE',
  pda: 'ENGINEER_PDA1',
  pda2: 'ENGINEER_PDA2',
  building: 'ENGINEER_BLD',
}

export interface SeqChoice { seq: number; name: string; clip: string | null; time: number; source: 'vm0' | 'derived'; since: number }

const DERIVED_DRAW = 'VM_DRAW'
const DERIVED_IDLE = 'VM_IDLE'
const DERIVED_FIRE = 'VM_PRIMARYATTACK'
const DERIVED_RELOAD = 'VM_RELOAD'

/** First sequence with a clip whose activity is ACT_<slot>_<what>, else ACT_<what>. */
function byActivity(seqs: VmSequence[], slot: string | undefined, what: string): number {
  const want = slot ? [`ACT_${slot}_${what}`, `ACT_${what}`] : [`ACT_${what}`]
  for (const name of want) {
    const i = seqs.findIndex(s => s.clip && s.activity === name)
    if (i >= 0) return i
  }
  return -1
}

/** The idle a clip-less sequence (inspects, the reference pose) holds: `<prefix>_idle`, else `idle`, else any idle. */
function idleFor(arms: ArmsItem, name: string): number {
  const index = arms.sequenceIndex ?? {}
  const prefix = name.includes('_') ? name.slice(0, name.indexOf('_')) : ''
  const pick = (n: string) => (index[n] !== undefined && arms.sequences[index[n]]?.clip ? index[n] : -1)
  let i = prefix ? pick(`${prefix}_idle`) : -1
  if (i < 0) i = pick('idle')
  if (i < 0) i = arms.sequences.findIndex(s => s.clip && /idle/i.test(s.name))
  return i
}

function derivedSequence(input: ViewmodelInput, arms: ArmsItem, interval: number): { seq: number; since: number } {
  const seqs = arms.sequences
  const slot = SLOT_ACT[itemInfo(input.weaponDef)?.slot ?? '']
  const tick = input.tickF
  const lastFire = input.fireTicks.length ? input.fireTicks[input.fireTicks.length - 1] : -Infinity
  const draw = byActivity(seqs, slot, DERIVED_DRAW)
  const seconds = (i: number) => (i >= 0 ? seqs[i].frames / (seqs[i].fps || 30) : 0)
  // Latest of draw, fire and reload whose clip is still running, else idle from the draw
  let best = { seq: -1, since: -Infinity }
  if (draw >= 0 && (tick - input.drawTick) * interval < seconds(draw)) best = { seq: draw, since: input.drawTick }
  const fire = byActivity(seqs, slot, DERIVED_FIRE)
  if (fire >= 0 && lastFire >= input.drawTick && lastFire > best.since && (tick - lastFire) * interval < seconds(fire)) {
    best = { seq: fire, since: lastFire }
  }
  if (input.reloadSince !== undefined && input.reloadSince > best.since) {
    const reload = byActivity(seqs, slot, DERIVED_RELOAD)
    if (reload >= 0) best = { seq: reload, since: input.reloadSince }
  }
  if (best.seq >= 0) return best
  return { seq: byActivity(seqs, slot, DERIVED_IDLE), since: input.drawTick }
}

/** The arms sequence and its time in seconds at input.tickF. Pure (D12). */
export function chooseSequence(input: ViewmodelInput, armsKey: string, arms: ArmsItem): SeqChoice {
  const interval = input.interval || 0.015
  const vm0 = input.vm0
  let seq = -1
  let since = input.drawTick
  let rate = 1
  let source: SeqChoice['source'] = 'derived'
  if (vm0 && vm0.model.toLowerCase().replace(/\\/g, '/') === armsKey && vm0.seq < arms.sequences.length) {
    source = 'vm0'
    seq = vm0.seq
    since = vm0.since
    rate = Number.isFinite(vm0.rate) && vm0.rate > 0 ? vm0.rate : 1
    if (!arms.sequences[seq]?.clip) seq = idleFor(arms, arms.sequences[seq]?.name ?? '') // inspects hold idle (13.4)
  } else {
    const d = derivedSequence(input, arms, interval)
    seq = d.seq
    since = d.since
  }
  const info = seq >= 0 ? arms.sequences[seq] : undefined
  if (!info?.clip) return { seq, name: info?.name ?? '', clip: null, time: 0, source, since }
  return { seq, name: info.name, clip: info.clip, time: sequenceTime(info, input.tickF, since, interval, rate), source, since }
}

/** Seconds into a sequence at tickF: looping sequences wrap, the others hold their last frame. */
function sequenceTime(info: VmSequence, tickF: number, since: number, interval: number, rate: number): number {
  const duration = Math.max(1, info.frames - 1) / (info.fps || 30)
  const time = Math.max(0, (tickF - since) * interval * rate)
  return info.loop ? time % duration : Math.min(time, duration)
}

// ─── instance ──────────────────────────────────────────────────────────────────

export interface GlbInstance extends ViewmodelInstance {
  keys: VmKeys
  lastChoice: SeqChoice | null
  mergedBones: number
  /** The drawn watch hand (vm1): its key and sequence name, or null. */
  watch: { key: string; seq: number; name: string; time: number } | null
  /** Minigun barrel angle in degrees, null without a barrel bone. */
  barrelSpin: number | null
  /** The arms' rocket mesh is drawn (null when the arms have none). */
  rocketVisible: boolean | null
}

function lowerNameMap(root: THREE.Object3D): Map<string, THREE.Object3D> {
  const map = new Map<string, THREE.Object3D>()
  root.traverse(node => {
    const key = node.name.toLowerCase()
    if (node.name && !map.has(key)) map.set(key, node)
  })
  return map
}

function depthOf(node: THREE.Object3D): number {
  let d = 0
  for (let n = node.parent; n; n = n.parent) d++
  return d
}

/**
 * An opaque pack material's texture alpha holds VMT masks (phong, envmap), not coverage. The layer draws viewmodels in
 * the transparent pass, so once the cloak fade switches on blending that mask would show the world through the
 * weapon. The alpha becomes the material opacity alone.
 */
function ignoreTextureAlpha(material: THREE.Material): void {
  const previous = material.onBeforeCompile
  const previousKey = material.customProgramCacheKey.bind(material)
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer)
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      '#include <map_fragment>\n\tdiffuseColor.a = opacity;'
    )
  }
  material.customProgramCacheKey = () => previousKey() + '|vmOpaqueAlpha'
}

/** Per-copy materials, so the layer's viewmodel flags and the cloak fade never touch the shared pack materials. */
function ownMaterials(root: THREE.Object3D): THREE.Material[] {
  const clones = new Map<THREE.Material, THREE.Material>()
  root.traverse(node => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    const swap = (m: THREE.Material) => {
      let c = clones.get(m)
      if (!c) {
        c = m.clone()
        // The layer draws every viewmodel mesh in the transparent pass; an opaque pack material must not start
        // blending its texture's alpha, which holds the VMT's masks (phong, envmap), so it draws without blending
        // until the cloak fade needs it
        if (!m.transparent) {
          c.userData.vmOpaque = true
          ignoreTextureAlpha(c)
        }
        clones.set(m, c)
      }
      return c
    }
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material)
  })
  return Array.from(clones.values())
}

const _parentInv = new THREE.Matrix4()
const _local = new THREE.Matrix4()
const _spin = new THREE.Quaternion()
const BARREL_AXIS = new THREE.Vector3(0, 0, 1) // the barrel bone's local axis along the barrels
const DEG = Math.PI / 180
/** The soldier arms' reload rocket (its material), drawn only with a primary weapon out. */
const ROCKET_MATERIAL = /(^|\/)w_rocket01$/i

function setLoopedClip(mixer: THREE.AnimationMixer, clip: THREE.AnimationClip, current: THREE.AnimationAction | null) {
  current?.stop()
  const action = mixer.clipAction(clip)
  action.setLoop(THREE.LoopRepeat, Infinity)
  action.play()
  return action
}

interface WatchSub {
  key: string
  handle: PackModelHandle
  root: THREE.Object3D
  info: WatchItem
  materials: THREE.Material[]
  mixer: THREE.AnimationMixer
  clips: Map<string, THREE.AnimationClip>
  action: THREE.AnimationAction | null
  actionClip: string | null
}

/** A watch hand for `key` when its model is loaded, holding its own reference; null otherwise. */
function createWatch(key: string, team: number, parent: THREE.Object3D): WatchSub | null {
  const handle = holdLoaded(key)
  if (!handle) return null
  const info = handle.info as WatchItem
  const root = handle.instantiate(packTeamSkin(info, team))
  root.name = 'vmWatch'
  const materials = ownMaterials(root)
  prepareViewmodelObject(root)
  parent.add(root)
  const mixer = new THREE.AnimationMixer(root)
  return { key, handle, root, info, materials, mixer, clips: new Map(handle.clips.map(c => [c.name, c])), action: null, actionClip: null }
}

function disposeWatch(w: WatchSub) {
  w.action?.stop()
  w.mixer.stopAllAction()
  w.mixer.uncacheRoot(w.root)
  for (const m of w.materials) m.dispose()
  w.root.removeFromParent()
  w.handle.release(w.root)
  unhold(w.key)
}

function createGlb(input: ViewmodelInput): ViewmodelInstance {
  const keys = glbViewmodelKeys(input.classId, input.weaponDef, input.vm0?.model)
  const armsHandle = keys ? holdLoaded(keys.arms) : null
  const weaponHandle = keys?.weapon ? holdLoaded(keys.weapon) : null
  if (!keys || !armsHandle || (keys.weapon && !weaponHandle)) {
    // supports() said yes a moment ago; should the pair have gone since, draw nothing rather than throw
    if (armsHandle && keys) unhold(keys.arms)
    if (weaponHandle && keys?.weapon) unhold(keys.weapon)
    const object = new THREE.Group()
    const muzzle = new THREE.Object3D()
    object.add(muzzle)
    return { object, muzzle, update: () => {}, dispose: () => object.removeFromParent() }
  }
  const armsInfo = armsHandle.info as ArmsItem
  const weaponInfo = (weaponHandle?.info as WeaponItem | undefined) ?? null
  const team = input.team === 'red' ? 2 : 3
  const arms = armsHandle.instantiate(packTeamSkin(armsInfo, team))
  // a standalone viewmodel has no weapon model: an empty group keeps the bone merge and muzzle code uniform
  const weapon = weaponHandle && weaponInfo ? weaponHandle.instantiate(packTeamSkin(weaponInfo, team)) : new THREE.Group()
  arms.name = 'vmArms'
  weapon.name = 'vmWeapon'
  const materials = [...ownMaterials(arms), ...ownMaterials(weapon)]

  const object = new THREE.Group()
  object.name = 'vmPack'
  const eye = new THREE.Group()
  eye.quaternion.copy(EYE_FROM_SOURCE)
  eye.add(arms, weapon)
  object.add(eye)

  // Bone merge pairs, parents first
  const armsNodes = lowerNameMap(arms)
  const weaponNodes = lowerNameMap(weapon)
  const mergeNames = weaponInfo?.viewmodel?.mergeBones?.[armsInfo.class] ?? []
  const pairs: { from: THREE.Object3D; to: THREE.Object3D; depth: number }[] = []
  for (const name of mergeNames) {
    const from = armsNodes.get(name.toLowerCase())
    const to = weaponNodes.get(name.toLowerCase())
    if (from && to) pairs.push({ from, to, depth: depthOf(to) })
  }
  pairs.sort((a, b) => a.depth - b.depth)

  // Muzzle: the weapon's attachment, else its root merge bone, else the arms' weapon_bone
  const muzzle =
    weaponNodes.get('attachment_muzzle') ?? pairs[0]?.to ?? armsNodes.get('weapon_bone') ?? eye
  const flashMaterial = new THREE.SpriteMaterial({
    map: flashTexture(),
    color: '#ffd27a',
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    transparent: true,
    fog: false,
    toneMapped: false,
  })
  const flash = new THREE.Sprite(flashMaterial)
  flash.name = 'vmMuzzleFlash'
  flash.scale.set(6, 6, 6)
  flash.visible = false
  flash.renderOrder = VM_GLOW_ORDER
  muzzle.add(flash)

  const mixer = new THREE.AnimationMixer(arms)
  const clipsByName = new Map(armsHandle.clips.map(c => [c.name, c]))
  let action: THREE.AnimationAction | null = null
  let actionClip: string | null = null
  const kind = resolveKind(input.kind, input.weaponClass)
  const melee = MELEE_KINDS.has(kind)

  // Minigun barrels: the weapon's own `barrel` bone (not a merge bone), turned about its axis from its rest
  const barrel = kind === 'minigun' ? weaponNodes.get('barrel') ?? null : null
  const barrelRest = barrel ? barrel.quaternion.clone() : null
  // The arms' rocket mesh: only with a primary weapon out (melee and secondary clips leave its bone at the default)
  const rockets: THREE.Object3D[] = []
  arms.traverse(node => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    const ms = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    if (ms.some(m => ROCKET_MATERIAL.test(m.name))) rockets.push(mesh)
  })
  // An item missing from items.json keeps the rocket: hide it only for a known non-primary slot
  const slot = itemInfo(input.weaponDef)?.slot
  const rocketVisible = rockets.length ? slot === undefined || slot === 'primary' : null
  for (const r of rockets) r.visible = !!rocketVisible

  let watch: WatchSub | null = null

  const instance: GlbInstance = {
    object,
    muzzle,
    keys,
    lastChoice: null,
    mergedBones: pairs.length,
    watch: null,
    barrelSpin: barrel ? 0 : null,
    rocketVisible,
    update(next: ViewmodelInput) {
      const choice = chooseSequence(next, keys.arms, armsInfo)
      instance.lastChoice = choice
      const clip = choice.clip ? clipsByName.get(choice.clip) ?? null : null
      if (clip && actionClip !== clip.name) {
        action = setLoopedClip(mixer, clip, action)
        actionClip = clip.name
      }
      if (action) mixer.setTime(Math.min(choice.time, Math.max(0, (clip?.duration ?? 0) - 1e-4)))
      object.visible = !next.vm0?.nodraw

      // Bone merge: the weapon's merge bones take the arms bone's world transform
      if (pairs.length) {
        arms.updateWorldMatrix(true, true)
        for (const { from, to } of pairs) {
          const parent = to.parent!
          parent.updateWorldMatrix(true, false)
          _parentInv.copy(parent.matrixWorld).invert()
          _local.multiplyMatrices(_parentInv, from.matrixWorld)
          _local.decompose(to.position, to.quaternion, to.scale)
          to.updateMatrixWorld(true)
        }
      }

      // Muzzle flash at the attachment, timed like the placeholder's (a function of the tick)
      const pose = computePose(next, kind, { kick: [1, 1], melee, reloads: true })
      flash.visible = pose.muzzleFlash && !melee
      if (flash.visible) flashMaterial.rotation = (Math.floor(next.tickF) * 0.7) % (Math.PI * 2)
      if (barrel && barrelRest) {
        barrel.quaternion.copy(barrelRest).multiply(_spin.setFromAxisAngle(BARREL_AXIS, pose.spin * DEG))
        instance.barrelSpin = Math.round(pose.spin * 100) / 100
      }

      // Watch hand (viewmodel 1): the pack model vm1 names, while vm1 is drawn
      const vm1 = next.vm1
      const watchKey = vm1 && !vm1.nodraw ? watchKeyOf(vm1.model) : null
      if (watch && watchKey && watch.key !== watchKey) {
        disposeWatch(watch)
        watch = null
      }
      if (!watch && watchKey) watch = createWatch(watchKey, team, eye)
      const wInfo = watch && watchKey && vm1 ? watch.info.sequences[vm1.seq] : undefined
      const wClip = wInfo?.clip ? watch!.clips.get(wInfo.clip) ?? null : null
      if (watch) watch.root.visible = !!wClip
      if (watch && wClip && wInfo && vm1) {
        if (watch.actionClip !== wClip.name) {
          watch.action = setLoopedClip(watch.mixer, wClip, watch.action)
          watch.actionClip = wClip.name
        }
        const rate = Number.isFinite(vm1.rate) && vm1.rate > 0 ? vm1.rate : 1
        const time = sequenceTime(wInfo, next.tickF, vm1.since, next.interval || 0.015, rate)
        watch.mixer.setTime(Math.min(time, Math.max(0, wClip.duration - 1e-4)))
        instance.watch = { key: watch.key, seq: vm1.seq, name: wInfo.name, time: Math.round(time * 1000) / 1000 }
      } else instance.watch = null

      // Cloak fade: the spy's own viewmodel fades with his invisibility
      // (only from a visible cloak: tiny invisibility values must not start blending the viewmodel)
      const invis = next.invis ?? 0
      const opacity = invis > 0.02 ? 1 - 0.85 * invis : 1
      for (const m of watch ? [...materials, ...watch.materials] : materials) {
        m.opacity = opacity
        if (m.userData.vmOpaque) m.blending = opacity < 1 ? THREE.NormalBlending : THREE.NoBlending
      }
    },
    dispose() {
      if (watch) disposeWatch(watch)
      watch = null
      action?.stop()
      mixer.stopAllAction()
      mixer.uncacheRoot(arms)
      flash.removeFromParent()
      flashMaterial.dispose()
      for (const m of materials) m.dispose()
      armsHandle.release(arms)
      if (weaponHandle) weaponHandle.release(weapon)
      object.removeFromParent()
      unhold(keys.arms)
      if (keys.weapon) unhold(keys.weapon)
    },
  }
  return instance
}

export const glbViewmodelProvider: ViewmodelProvider = {
  id: GLB_PROVIDER_ID,
  priority: 10,
  supports: input =>
    input.localTables === true &&
    !packPoseExcluded(input.kind, input.weaponClass) &&
    glbModelsReady(glbViewmodelKeys(input.classId, input.weaponDef, input.vm0?.model)),
  create: createGlb,
}

registerViewmodelProvider(glbViewmodelProvider)
