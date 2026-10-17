// Engineer building view model (contract section 6.5; owner F2, read by F4 and F5).
//
// buildingsAt(x, tick) lists every building instance alive at the tick (created <= tick < deleted): sentries,
// dispensers, teleporters and sappers (type 3), including map-placed ones (`mapPlaced: true`, for example vigil's
// CObjectCartDispenser, which the scene layer never draws) and carried ones (`carried: true`: the instance is
// dormant while the engineer holds it, and `pos` is where it stood). buildingsOf(x, p, tick) keeps the rows whose
// builder is p, so a spy gets his sappers.
//
// `built` is the construction fraction 0..1, `rechargeLeft` the seconds until a recharging teleporter is ready.
// Every value is a pure function of the extras and the tick. Fractional ticks are allowed: the state is read at
// floor(tick) and the position is interpolated like the scene layer does. The returned arrays and objects are
// shared between callers for the same (extras, tick) and must not be mutated.

import * as THREE from 'three'

import { BLD, BUILDING_TYPE, TELE_STATE } from '@highlander/extras/enums'
import { trackIndexAt, xformAt } from '@highlander/extras/track'
import type { HighlanderExtras } from '@highlander/extras/types'

import { yawOfQuat } from './sentryAim'

export interface BuildingView {
  instance: number; entityId: number; type: number; mode: number; builder: number; team: number; mini: boolean; mapPlaced: boolean
  level: number; health: number; maxHealth: number; built: number; building: boolean; sapped: boolean
  disabled: boolean; wrangled: boolean; carried: boolean; upgrading: boolean
  shells: number; rockets: number; metal: number; objState: number; rechargeLeft: number
  pos: THREE.Vector3; yaw: number
}

const NONE_U32 = 0xffffffff
const _quat = new THREE.Quaternion()

/** True when building instance j exists at tick: created <= tick < deleted. */
export function buildingAliveAt(x: HighlanderExtras, j: number, tick: number): boolean {
  const b = x.buildings
  const deleted = b.deleted[j]
  return b.created[j] <= tick && (deleted === NONE_U32 || tick < deleted)
}

/** Instance indices alive at tick, in table order (created, entityId). */
export function buildingInstancesAt(x: HighlanderExtras, tick: number): number[] {
  const b = x.buildings
  const out: number[] = []
  for (let j = 0; j < b.count; j++) {
    if (b.created[j] > tick) break // the table is sorted by created
    if (buildingAliveAt(x, j, tick)) out.push(j)
  }
  return out
}

/** Seconds until a recharging teleporter is ready again (state entry si), 0 otherwise. */
export function rechargeLeftAt(x: HighlanderExtras, si: number, tickF: number): number {
  const s = x.buildings.state
  if (si < 0 || s.objState[si] !== TELE_STATE.RECHARGING) return 0
  const t = s.rechargeTick[si]
  if (Number.isNaN(t)) return 0
  return Math.max(0, (t - tickF) * x.meta.intervalPerTick)
}

/** The view of instance j at tick (j need not be alive there; callers check). */
export function buildingView(x: HighlanderExtras, j: number, tick: number): BuildingView {
  const b = x.buildings
  const s = b.state
  const si = trackIndexAt(s, j, Math.floor(tick))
  const flags = si < 0 ? 0 : s.flags[si]
  const pos = new THREE.Vector3(NaN, NaN, NaN)
  let yaw = 0
  if (xformAt(b.xform, j, tick, pos, _quat, x.meta.snapshotInterval || 1)) yaw = yawOfQuat(_quat.x, _quat.y, _quat.z, _quat.w)
  return {
    instance: j,
    entityId: b.entityId[j],
    type: b.type[j],
    mode: b.mode[j],
    builder: b.builder[j],
    team: b.team[j],
    mini: b.mini[j] !== 0,
    mapPlaced: b.mapPlaced[j] !== 0,
    level: si < 0 ? 1 : Math.max(1, s.level[si]),
    health: si < 0 ? 0 : s.health[si],
    maxHealth: si < 0 ? 0 : s.maxHealth[si],
    built: si < 0 ? 0 : s.built[si] / 255,
    building: (flags & BLD.BUILDING) !== 0,
    sapped: (flags & BLD.SAPPED) !== 0,
    disabled: (flags & (BLD.DISABLED | BLD.PLASMA)) !== 0,
    wrangled: (flags & BLD.WRANGLED) !== 0,
    carried: (flags & BLD.DORMANT) !== 0,
    upgrading: (flags & BLD.UPGRADING) !== 0,
    shells: si < 0 ? 0 : s.shells[si],
    rockets: si < 0 ? 0 : s.rockets[si],
    metal: si < 0 ? 0 : s.metal[si],
    objState: si < 0 ? 0 : s.objState[si],
    rechargeLeft: b.type[j] === BUILDING_TYPE.TELEPORTER ? rechargeLeftAt(x, si, tick) : 0,
    pos,
    yaw,
  }
}

// One-entry cache: the HUD snapshot, the POV panel and the probes often ask for the same tick in one frame.
let cache: { x: HighlanderExtras; tick: number; rows: BuildingView[] } | null = null

/** Every building instance alive at tick, including sappers, map-placed and carried buildings. */
export function buildingsAt(x: HighlanderExtras, tick: number): BuildingView[] {
  if (cache && cache.x === x && cache.tick === tick) return cache.rows
  const rows = buildingInstancesAt(x, Math.floor(tick)).map(j => buildingView(x, j, tick))
  cache = { x, tick, rows }
  return rows
}

/** The buildings (or, for a spy, the sappers) whose builder is player p. */
export function buildingsOf(x: HighlanderExtras, p: number, tick: number): BuildingView[] {
  return buildingsAt(x, tick).filter(v => v.builder === p)
}
