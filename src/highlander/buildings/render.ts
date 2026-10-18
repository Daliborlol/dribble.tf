// What the buildings layer draws, as pure functions of (extras, tickF) (contract section 5 F2, D12).
// BuildingsLayer reads these every frame and the `buildings.draw` probe returns the same values, so harness plans
// can assert on what was drawn. Nothing here touches the scene or the store.

import { BLD, BUILDING_TYPE, TELE_STATE } from '@highlander/extras/enums'
import { lowerBound, sinceTick, trackIndexAt, trackRange, xformAt } from '@highlander/extras/track'
import type { HighlanderExtras } from '@highlander/extras/types'
import * as THREE from 'three'

import { buildingAliveAt, buildingInstancesAt, rechargeLeftAt } from './model'
import { MINI_SCALE, sentryAimAt, sentryPivotHeight, yawOfQuat, type SentryAim } from './sentryAim'

// ─── placeholder dimensions (contract section 5 F2 table, Hammer units) ────────

export const SENTRY = {
  baseSize: 34, baseHeight: 6, postRadius: 3.5,
  yoke: { x: 10, y: 20, z: 6, below: 8 },
  turret: { 1: [22, 16, 12], 2: [26, 20, 14], 3: [26, 20, 14] } as Record<number, [number, number, number]>,
  barrel: { 1: { radius: 1.6, length: 18, offsets: [0] }, 2: { radius: 1.6, length: 22, offsets: [-3.5, 3.5] }, 3: { radius: 1.6, length: 22, offsets: [-3.5, 3.5] } } as Record<number, { radius: number; length: number; offsets: number[] }>,
  pod: { x: 12, y: 18, z: 8, above: 10, disc: 2 },
}
export const DISPENSER = { width: 24, heights: [40, 40, 46, 52], cap: { size: 26, height: 4 }, screen: { y: 14, z: 10, below: 18 }, gauge: { width: 3, inset: 10 }, maxMetal: 400 }
export const TELEPORTER = { radius: 24, height: 6, ring: { radius: 20, tube: 1.5, z: 6.2 }, blade: [18, 3, 1], beacon: { radius: 2, height: 30 }, glow: { radius: 20, height: 50 } }
export const SAPPER = { size: [8, 6, 8] as [number, number, number] }
export const HULLS: Record<number, [number, number, number]> = {
  [BUILDING_TYPE.SENTRY]: [40, 40, 66],
  [BUILDING_TYPE.DISPENSER]: [40, 40, 55],
  [BUILDING_TYPE.TELEPORTER]: [48, 48, 12],
}
/**
 * The status label's anchor, units above the building's top: the bottom edge of the label's frame sits there and the
 * label grows upward on screen from it (BuildingObject lifts it in billboard space). In a side view at scale 1 its
 * centre is 18 units above the top (the contract says top + 14), and in steep RTS views it stays clear of the
 * building instead of covering it.
 */
export const LABEL_GAP = 1
export const BLUEPRINT_DISTANCE = 64
export const CARRY_BOX = { size: 16, offset: [-14, 0, 40] as [number, number, number] }
export const SENTRY_RANGE = 1100
export const DESTRUCTION_TICKS = 20
export const MUZZLE_TICKS = 2
export const UPGRADE_PERIOD = 40
/** Teleporter blade speed, degrees per tick: spinning while ready, sending or receiving; slow while recharging. */
export const TELE_SPIN = { active: 6, recharging: 1.5 }
export const HEAL_BEAM_HEIGHT = 41

export const teamName = (team: number): 'red' | 'blue' | null => (team === 2 ? 'red' : team === 3 ? 'blue' : null)

export const dispenserHeight = (level: number) => DISPENSER.heights[Math.max(1, Math.min(3, level))]

/** Height of the drawn top of a building, before the construction scale. */
export function buildingTop(type: number, level: number, mini: boolean, mode: number): number {
  if (type === BUILDING_TYPE.SENTRY) {
    if (mini) return (SENTRY_PIVOT_L1 + SENTRY.turret[1][2] / 2 + 0.5) * MINI_SCALE
    const pivot = sentryPivotHeight(level, false)
    if (level >= 3) return pivot + SENTRY.pod.above + SENTRY.pod.z / 2
    return pivot + SENTRY.turret[level >= 2 ? 2 : 1][2] / 2 + 0.5
  }
  if (type === BUILDING_TYPE.DISPENSER) return dispenserHeight(level) + DISPENSER.cap.height
  if (type === BUILDING_TYPE.TELEPORTER) return mode === 1 ? TELEPORTER.height + TELEPORTER.beacon.height : TELEPORTER.height
  return SAPPER.size[2]
}
const SENTRY_PIVOT_L1 = 32

/** Sapper box centre in the sapped building's frame: on its +Y face at half height. */
export function sapperOffset(type: number, level: number, mini: boolean): [number, number, number] {
  const half = SAPPER.size[1] / 2
  if (type === BUILDING_TYPE.SENTRY) {
    const s = mini ? MINI_SCALE : 1
    return [0, (SENTRY.postRadius + half) * s, (sentryPivotHeight(level, mini) / 2)]
  }
  if (type === BUILDING_TYPE.DISPENSER) return [0, DISPENSER.width / 2 + half, dispenserHeight(level) / 2]
  if (type === BUILDING_TYPE.TELEPORTER) return [0, TELEPORTER.radius + half, SAPPER.size[2] / 2]
  return [0, 0, SAPPER.size[2] / 2]
}

/** Deterministic noise (contract appendix B.6). */
export const hash = (n: number) => {
  const v = Math.sin(n * 12.9898) * 43758.5453
  return v - Math.floor(v)
}

// ─── per-extras indices (built once, module-level WeakMaps) ────────────────────

interface BuildingIndex {
  /** sapper instances per sapped building instance */
  sappers: Map<number, number[]>
  /** tracer rows per sentry instance, tick order */
  tracers: Map<number, number[]>
  /** cumulative teleporter blade angle (degrees) at each of the instance's state entries */
  spin: Map<number, Float64Array>
  /** destroyed and detonated events */
  destructions: DestructionEvent[]
}

export interface DestructionEvent {
  event: number
  tick: number
  building: number
  type: number
  team: number
  builder: number
  /** the building was carried (dormant) at the event: draw at the builder */
  carried: boolean
  /** sappers removed by an engineer get a small pop instead of the explosion */
  small: boolean
}

const indexCache = new WeakMap<HighlanderExtras, BuildingIndex>()

function spinRate(objState: number, flags: number): number {
  if (flags & (BLD.BUILDING | BLD.DORMANT)) return 0
  if (objState >= TELE_STATE.READY && objState <= TELE_STATE.RECEIVING_RELEASE) return TELE_SPIN.active
  if (objState === TELE_STATE.RECHARGING) return TELE_SPIN.recharging
  return 0
}

export function buildingIndex(x: HighlanderExtras): BuildingIndex {
  let index = indexCache.get(x)
  if (index) return index
  const b = x.buildings
  const sappers = new Map<number, number[]>()
  for (let j = 0; j < b.count; j++) {
    if (b.type[j] !== BUILDING_TYPE.SAPPER || b.builtOn[j] < 0) continue
    const list = sappers.get(b.builtOn[j]) ?? []
    list.push(j)
    sappers.set(b.builtOn[j], list)
  }
  const tracers = new Map<number, number[]>()
  const tr = x.tempents.tracers
  for (let i = 0; i < tr.tick.length; i++) {
    const j = tr.sentry[i]
    if (j === 65535) continue
    const list = tracers.get(j) ?? []
    list.push(i)
    tracers.set(j, list)
  }
  const spin = new Map<number, Float64Array>()
  const s = b.state
  for (let j = 0; j < b.count; j++) {
    if (b.type[j] !== BUILDING_TYPE.TELEPORTER) continue
    const [lo, hi] = trackRange(s, j)
    const cum = new Float64Array(Math.max(0, hi - lo))
    for (let i = lo + 1; i < hi; i++) {
      cum[i - lo] = cum[i - 1 - lo] + spinRate(s.objState[i - 1], s.flags[i - 1]) * (s.ticks[i] - s.ticks[i - 1])
    }
    spin.set(j, cum)
  }
  const destructions: DestructionEvent[] = []
  for (const t of ['destroyed', 'detonated'] as const) {
    for (const e of x.derived.eventsByType[t] ?? []) {
      const ev = x.events[e]
      if (ev.t !== 'destroyed' && ev.t !== 'detonated') continue
      const j = ev.building
      if (j < 0 || j >= b.count || b.mapPlaced[j]) continue
      const si = trackIndexAt(s, j, ev.tick)
      const carried = si >= 0 && (s.flags[si] & BLD.DORMANT) !== 0
      destructions.push({
        event: e,
        tick: ev.tick,
        building: j,
        type: b.type[j],
        team: b.team[j],
        builder: b.builder[j],
        carried,
        small: b.type[j] === BUILDING_TYPE.SAPPER,
      })
    }
  }
  destructions.sort((a, c) => a.tick - c.tick || a.event - c.event)
  index = { sappers, tracers, spin, destructions }
  indexCache.set(x, index)
  return index
}

// ─── per-building draw state ────────────────────────────────────────────────────

export interface BuildingDraw {
  instance: number
  type: number
  mode: number
  team: 'red' | 'blue' | null
  mini: boolean
  /** false for map-placed buildings, carried (dormant) ones and instances not alive at the tick */
  drawn: boolean
  reason: 'mapPlaced' | 'carried' | 'notAlive' | 'noPosition' | null
  pos: THREE.Vector3
  /** build yaw, degrees */
  yaw: number
  level: number
  /** construction fraction 0..1 (m_flPercentageConstructed, interpolated between updates), 1 once built */
  builtFrac: number
  /** construction: z scale 0.25 + 0.75 * built, else 1 */
  scaleZ: number
  /** construction (and redeploy): every part at opacity 0.55 */
  ghost: boolean
  health: number
  maxHealth: number
  healthFrac: number
  /** label anchor height above the origin (the building top, construction-scaled, plus LABEL_GAP) */
  labelZ: number
  // sentry
  aim: SentryAim | null
  pivot: number
  shells: number
  shellsFrac: number
  rocketsFrac: number
  shield: boolean
  wrangled: boolean
  /** -1 none, else the barrel (0 or 1) that flashes */
  muzzle: number
  rangeRing: boolean
  // dispenser
  height: number
  metalFrac: number
  screenOn: boolean
  /** player indices the dispenser heals */
  beams: number[]
  // teleporter
  teleState: number
  /** blade angle, degrees */
  spin: number
  readyGlow: boolean
  /** recharge arc fraction 0..1 while recharging, -1 otherwise */
  recharge: number
  // shared
  /** -1 none, else the rising ring's height fraction 0..1 */
  upgradeRing: number
  /** sapper drawn on this building, with its flicker opacity */
  sapper: { instance: number; opacity: number } | null
  sapped: boolean
  disabled: boolean
}

const _q = new THREE.Quaternion()

/** Player indices set in a heal mask entry (bit p of lo, bit p-32 of hi). */
export function healTargets(x: HighlanderExtras, j: number, tick: number): number[] {
  const h = x.buildings.heal
  const i = trackIndexAt(h, j, tick)
  if (i < 0) return []
  const out: number[] = []
  const lo = h.lo[i] >>> 0, hi = h.hi[i] >>> 0
  for (let p = 0; p < 32; p++) if ((lo >>> p) & 1) out.push(p)
  for (let p = 0; p < 32; p++) if ((hi >>> p) & 1) out.push(p + 32)
  return out
}

/** The tracer row of sentry j that fired within MUZZLE_TICKS before tickF, or -1. */
export function muzzleRow(x: HighlanderExtras, j: number, tickF: number): number {
  const rows = buildingIndex(x).tracers.get(j)
  if (!rows || rows.length === 0) return -1
  const ticks = x.tempents.tracers.tick
  // last row with tick <= tickF
  let lo = 0, hi = rows.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (ticks[rows[mid]] <= tickF) lo = mid + 1
    else hi = mid
  }
  const k = lo - 1
  if (k < 0) return -1
  const age = tickF - ticks[rows[k]]
  return age >= 0 && age < MUZZLE_TICKS ? k : -1
}

/** Teleporter blade angle in degrees: the integral of the blade speed over the state entries up to tickF. */
export function teleporterSpin(x: HighlanderExtras, j: number, tickF: number): number {
  const s = x.buildings.state
  const i = trackIndexAt(s, j, Math.floor(tickF))
  if (i < 0) return 0
  const cum = buildingIndex(x).spin.get(j)
  const lo = s.offsets[j]
  const base = cum ? cum[i - lo] ?? 0 : 0
  return (base + spinRate(s.objState[i], s.flags[i]) * Math.max(0, tickF - s.ticks[i])) % 360
}

/** The sapper instance alive on building j at tick, or -1. */
export function sapperOn(x: HighlanderExtras, j: number, tick: number): number {
  const list = buildingIndex(x).sappers.get(j)
  if (!list) return -1
  for (const k of list) if (buildingAliveAt(x, k, tick)) return k
  return -1
}

export function buildingDraw(
  x: HighlanderExtras,
  j: number,
  tickF: number,
  opts: { rangeRing?: boolean; enemyCentre?: (kind: number, index: number) => { x: number; y: number; z: number } | null } = {}
): BuildingDraw {
  const b = x.buildings
  const s = b.state
  const tick = Math.floor(tickF)
  const type = b.type[j]
  const mini = b.mini[j] !== 0
  const si = trackIndexAt(s, j, tick)
  const flags = si < 0 ? 0 : s.flags[si]
  const level = si < 0 ? 1 : Math.max(1, Math.min(3, s.level[si]))
  const pos = new THREE.Vector3(NaN, NaN, NaN)
  let yaw = 0
  const hasPos = xformAt(b.xform, j, tickF, pos, _q, x.meta.snapshotInterval || 1)
  if (hasPos) yaw = yawOfQuat(_q.x, _q.y, _q.z, _q.w)

  let reason: BuildingDraw['reason'] = null
  if (b.mapPlaced[j]) reason = 'mapPlaced'
  else if (!buildingAliveAt(x, j, tick)) reason = 'notAlive'
  else if (flags & BLD.DORMANT) reason = 'carried'
  else if (!hasPos) reason = 'noPosition'

  const building = (flags & BLD.BUILDING) !== 0
  // construction fraction, interpolated between the 7-tick server updates so the build-up is smooth
  let built = si < 0 ? 0 : s.built[si] / 255
  if (building && si >= 0 && si + 1 < s.offsets[j + 1]) {
    const gap = s.ticks[si + 1] - s.ticks[si]
    const a = (tickF - s.ticks[si]) / gap
    if (gap > 0 && gap <= 8 && a > 0) built += (s.built[si + 1] / 255 - built) * Math.min(1, a)
  }
  const builtFrac = building ? Math.max(0, Math.min(1, built)) : 1
  const scaleZ = building ? 0.25 + 0.75 * builtFrac : 1
  const health = si < 0 ? 0 : s.health[si]
  const maxHealth = si < 0 ? 0 : s.maxHealth[si]
  const top = buildingTop(type, level, mini, b.mode[j])
  const objState = si < 0 ? 0 : s.objState[si]

  let aim: SentryAim | null = null
  let pivot = 0
  let shellsFrac = 0, rocketsFrac = 0, muzzle = -1
  if (type === BUILDING_TYPE.SENTRY) {
    pivot = sentryPivotHeight(level, mini)
    const pivotPos = { x: pos.x, y: pos.y, z: pos.z + pivot }
    aim = building ? { relYaw: 0, pitch: 0, source: 'none' } : sentryAimAt(x, j, tickF, yaw, pivotPos, opts.enemyCentre)
    shellsFrac = si < 0 ? 0 : Math.min(1, s.shells[si] / (level === 1 ? 150 : 200))
    rocketsFrac = si < 0 || level < 3 ? 0 : Math.min(1, s.rockets[si] / 20)
    const row = building ? -1 : muzzleRow(x, j, tickF)
    muzzle = row < 0 ? -1 : level >= 2 && !mini ? row % 2 : 0
  }

  let height = 0, metalFrac = 0, screenOn = false
  let beams: number[] = []
  if (type === BUILDING_TYPE.DISPENSER) {
    height = dispenserHeight(level)
    const metal = si < 0 ? 0 : s.metal[si]
    metalFrac = Math.min(1, metal / DISPENSER.maxMetal)
    // a sapped (disabled) dispenser goes dark, as in game
    screenOn = metal > 0 && !building && (flags & (BLD.DISABLED | BLD.SAPPED)) === 0
    if (reason === null) beams = healTargets(x, j, tick)
  }

  let spin = 0, readyGlow = false, recharge = -1
  if (type === BUILDING_TYPE.TELEPORTER) {
    spin = teleporterSpin(x, j, tickF)
    readyGlow = !building && objState >= TELE_STATE.READY && objState <= TELE_STATE.RECEIVING_RELEASE
    if (!building && objState === TELE_STATE.RECHARGING) {
      const dur = s.rechargeDur[si]
      const left = rechargeLeftAt(x, si, tickF)
      recharge = dur > 0 ? Math.max(0, Math.min(1, 1 - left / dur)) : 0
    }
  }

  let upgradeRing = -1
  if (flags & BLD.UPGRADING) {
    const since = sinceTick(s, j, tick, i => (s.flags[i] & BLD.UPGRADING) !== 0) ?? tick
    upgradeRing = (((tickF - since) % UPGRADE_PERIOD) + UPGRADE_PERIOD) % UPGRADE_PERIOD / UPGRADE_PERIOD
  }

  let sapper: BuildingDraw['sapper'] = null
  const sapped = (flags & BLD.SAPPED) !== 0
  if (type !== BUILDING_TYPE.SAPPER) {
    const k = sapperOn(x, j, tick)
    if (k >= 0 || sapped) sapper = { instance: k, opacity: 0.4 + 0.4 * hash(tick + 7 * j) }
  }

  return {
    instance: j,
    type,
    mode: b.mode[j],
    team: teamName(b.team[j]),
    mini,
    drawn: reason === null && type !== BUILDING_TYPE.SAPPER,
    reason,
    pos,
    yaw,
    level,
    builtFrac,
    scaleZ,
    ghost: building,
    health,
    maxHealth,
    healthFrac: maxHealth > 0 ? Math.max(0, Math.min(1, health / maxHealth)) : 0,
    labelZ: top * scaleZ + LABEL_GAP,
    aim,
    pivot,
    shells: si < 0 ? 0 : s.shells[si],
    shellsFrac,
    rocketsFrac,
    shield: (flags & BLD.SHIELD) !== 0,
    wrangled: (flags & BLD.WRANGLED) !== 0,
    muzzle,
    rangeRing: !!opts.rangeRing && type === BUILDING_TYPE.SENTRY && !building && reason === null,
    height,
    metalFrac,
    screenOn,
    beams,
    teleState: objState,
    spin,
    readyGlow,
    recharge,
    upgradeRing,
    sapper,
    sapped,
    disabled: (flags & (BLD.DISABLED | BLD.PLASMA)) !== 0,
  }
}

/** Instances the layer mounts at tick: alive, not map-placed, not sappers (drawn on their building). */
export function drawnInstancesAt(x: HighlanderExtras, tick: number): number[] {
  const b = x.buildings
  return buildingInstancesAt(x, tick).filter(j => !b.mapPlaced[j] && b.type[j] !== BUILDING_TYPE.SAPPER)
}

// ─── engineers: carry boxes and blueprints ─────────────────────────────────────

export interface CarryDraw { p: number; entityId: number; type: number; mode: number }
export interface BlueprintDraw { p: number; entityId: number; type: number; mode: number; valid: boolean; carried: boolean }

/** The building instance p carries at tick (his dormant building), or -1. */
function carriedBuilding(x: HighlanderExtras, p: number, tick: number): number {
  const b = x.buildings
  let found = -1
  for (const j of buildingInstancesAt(x, tick)) {
    if (b.builder[j] !== p || b.type[j] === BUILDING_TYPE.SAPPER) continue
    const si = trackIndexAt(b.state, j, tick)
    if (si >= 0 && b.state.flags[si] & BLD.DORMANT) found = j
  }
  return found
}

function carryingAt(x: HighlanderExtras, p: number, tick: number): boolean {
  const m = x.players.misc
  const i = trackIndexAt(m, p, tick)
  return i >= 0 && m.carrying[i] !== 0
}

/** Engineers carrying a building at tick (misc.carrying), with the type of the dormant building they own (-1 unknown). */
export function carriesAt(x: HighlanderExtras, tick: number): CarryDraw[] {
  if (!x.meta.available.misc) return []
  const out: CarryDraw[] = []
  for (let p = 0; p < x.players.count; p++) {
    if (!carryingAt(x, p, tick)) continue
    const j = carriedBuilding(x, p, tick)
    out.push({ p, entityId: x.players.entityId[p], type: j < 0 ? -1 : x.buildings.type[j], mode: j < 0 ? 0 : x.buildings.mode[j] })
  }
  return out
}

/**
 * Engineers placing a blueprint at tick: builder.state 2 (valid) or 3 (invalid). While he carries a building the
 * hull is that building's: the builder weapon's m_iObjectType keeps the last type chosen from the PDA, because
 * picking up a building only sets m_hObjectBeingBuilt (tf_weapon_builder.cpp:1003-1005); on 1438891 11 of the
 * 25 carries have a stale type.
 */
export function blueprintsAt(x: HighlanderExtras, tick: number): BlueprintDraw[] {
  if (!x.meta.available.builder) return []
  const t = x.players.builder
  const out: BlueprintDraw[] = []
  for (let p = 0; p < x.players.count; p++) {
    const i = trackIndexAt(t, p, tick)
    if (i < 0) continue
    const state = t.state[i]
    if (state !== 2 && state !== 3) continue
    let type = t.type[i]
    let mode = t.mode[i]
    let carried = false
    if (x.meta.available.misc && carryingAt(x, p, tick)) {
      const j = carriedBuilding(x, p, tick)
      if (j >= 0) {
        type = x.buildings.type[j]
        mode = x.buildings.mode[j]
        carried = true
      }
    }
    if (!HULLS[type]) continue
    out.push({ p, entityId: x.players.entityId[p], type, mode, valid: state === 2, carried })
  }
  return out
}

// ─── destruction effects ──────────────────────────────────────────────────────

export interface DestructionDraw extends DestructionEvent {
  age: number
  /** world position of the blast centre (scene space) */
  pos: THREE.Vector3
}

/**
 * Destroyed or detonated buildings with 0 <= age < DESTRUCTION_TICKS at tickF. The blast sits at the building's
 * last position (the sapper box for sappers); a building destroyed while carried explodes at the builder, through
 * `playerPos(p, tick)` (base positions; null when unknown).
 */
export function destructionsAt(
  x: HighlanderExtras,
  tickF: number,
  playerPos?: (p: number, tick: number) => { x: number; y: number; z: number } | null
): DestructionDraw[] {
  const list = buildingIndex(x).destructions
  if (list.length === 0) return []
  const from = tickF - DESTRUCTION_TICKS
  // first event with tick > from
  let lo = 0, hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (list[mid].tick <= from) lo = mid + 1
    else hi = mid
  }
  const out: DestructionDraw[] = []
  const b = x.buildings
  for (let k = lo; k < list.length && list[k].tick <= tickF; k++) {
    const e = list[k]
    const pos = new THREE.Vector3(NaN, NaN, NaN)
    // the last transform before the delete (xform entries end at the instance's last update)
    const at = Math.max(b.created[e.building], e.tick - 1)
    if (e.carried && playerPos) {
      const p = playerPos(e.builder, e.tick)
      if (p) pos.set(p.x, p.y, p.z + 40)
    } else if (xformAt(b.xform, e.building, at, pos, _q, 0)) {
      if (e.small) {
        // the sapper box on its building's +Y face
        const target = b.builtOn[e.building]
        const si = target >= 0 ? trackIndexAt(b.state, target, at) : -1
        const off = target >= 0 ? sapperOffset(b.type[target], si >= 0 ? b.state.level[si] : 1, b.mini[target] !== 0) : [0, 0, 4]
        const yaw = (yawOfQuat(_q.x, _q.y, _q.z, _q.w) * Math.PI) / 180
        pos.x += off[0] * Math.cos(yaw) - off[1] * Math.sin(yaw)
        pos.y += off[0] * Math.sin(yaw) + off[1] * Math.cos(yaw)
        pos.z += off[2]
      } else {
        const si = trackIndexAt(b.state, e.building, at)
        const level = si >= 0 ? b.state.level[si] : 1
        pos.z += buildingTop(e.type, level, b.mini[e.building] !== 0, b.mode[e.building]) / 2
      }
    }
    if (Number.isNaN(pos.x)) continue
    out.push({ ...e, age: tickF - e.tick, pos })
  }
  return out
}

/** Used by the probes: the tracer tick list of a sentry (debug). */
export function tracerTicksOf(x: HighlanderExtras, j: number, from: number, to: number): number[] {
  const rows = buildingIndex(x).tracers.get(j) ?? []
  const ticks = x.tempents.tracers.tick
  const start = lowerBound(Uint32Array.from(rows.map(r => ticks[r])), from)
  const out: number[] = []
  for (let k = start; k < rows.length && ticks[rows[k]] < to; k++) out.push(ticks[rows[k]])
  return out
}
