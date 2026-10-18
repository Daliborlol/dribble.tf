// Resupply cabinets (contract section 5 F6), static, bsp-to-glb maps only.
//
// map-meta `resupply[]` lists each func_regenerate with its team and the name of its `resupply_locker.mdl`
// prop. The trigger volume (`mins`/`maxs`) is the 96 x 96 x 128 zone players stand in, not the cabinet, so
// the placeholder sits at the locker prop instead: a TEAM_DARK cabinet with a lighter TEAM_HUD front, facing
// the prop's yaw. Entries without a matching prop fall back to the trigger bounds. A trigger without a team
// (team 0 on ashville, proot, divulgence and some others) takes the team of the func_respawnroom that
// contains the cabinet when that room has one. Otherwise it takes the team of the nearest spawn point that
// is enabled at round start, and only when none is in range the nearest disabled one. Forward rooms on
// payload maps hold disabled spawns of the team that takes them over later (Blu_spawnpoint_C in RED's
// opening room on pl_eruption_b15), so a disabled spawn must not outvote the room or an enabled spawn.
// The colour is static: it is the room's round-start owner from the BSP, so a forward room that later
// changes team through SetTeam keeps its round-start colour.

import * as THREE from 'three'

import { NEUTRAL, TEAM_DARK, TEAM_HUD, teamKey } from '@highlander/constants'
import type { MapMeta } from '@highlander/map/mapMeta'

import { LOCKER_SIZE } from './constants'
import { angleQuaternion } from './movers'

export interface LockerBox {
  team: number
  name: string
  /** 'prop': at the locker prop; 'bounds': the trigger volume (no prop found). */
  source: 'prop' | 'bounds'
  matrix: THREE.Matrix4
  color: THREE.Color
}

const PANEL_INSET = 6
/** func_regenerate without a team (KOTH maps, several payload maps): spawn points further away are ignored. */
const SPAWN_TEAM_RANGE = 1500

const centerOf = (min: number[], max: number[]): [number, number, number] => [
  (min[0] + max[0]) / 2,
  (min[1] + max[1]) / 2,
  (min[2] + max[2]) / 2,
]

const contains = (box: { mins?: number[]; maxs?: number[] }, at: readonly number[]): boolean =>
  Array.isArray(box.mins) && Array.isArray(box.maxs) && [0, 1, 2].every(i => at[i] >= box.mins![i] && at[i] <= box.maxs![i])

/** The team of the smallest team-2/3 func_respawnroom whose bounds contain `at`, or 0. */
function respawnRoomTeam(meta: MapMeta, at: readonly number[]): number {
  let best = 0
  let bestVolume = Infinity
  for (const room of meta.respawnRooms ?? []) {
    if ((room.team !== 2 && room.team !== 3) || !contains(room, at)) continue
    const volume = [0, 1, 2].reduce((v, i) => v * (room.maxs![i] - room.mins![i]), 1)
    if (volume < bestVolume) {
      bestVolume = volume
      best = room.team
    }
  }
  return best
}

/** The team of the nearest spawn point within SPAWN_TEAM_RANGE; `enabledOnly` skips StartDisabled ones. */
function nearestSpawnTeam(meta: MapMeta, at: readonly number[], enabledOnly: boolean): number {
  let best = 0
  let bestDistance = SPAWN_TEAM_RANGE
  for (const spawn of meta.spawns) {
    if (spawn.team !== 2 && spawn.team !== 3) continue
    if (enabledOnly && spawn.disabled) continue
    const distance = Math.hypot(spawn.origin[0] - at[0], spawn.origin[1] - at[1], spawn.origin[2] - at[2])
    if (distance < bestDistance) {
      bestDistance = distance
      best = spawn.team
    }
  }
  return best
}

/** Team for a func_regenerate without one (see the header). */
function untaggedLockerTeam(meta: MapMeta, at: readonly number[]): number {
  return respawnRoomTeam(meta, at) || nearestSpawnTeam(meta, at, true) || nearestSpawnTeam(meta, at, false)
}

/** Body and front-panel boxes for every resupply entry (scene space). */
export function buildLockers(meta: MapMeta | null, origin: { x: number; y: number; z: number }): LockerBox[] {
  if (!meta) return []
  const props = new Map<string, MapMeta['gameplayProps'][number]>()
  for (const prop of meta.gameplayProps) {
    if (prop.name && /resupply_locker/i.test(prop.model)) props.set(prop.name, prop)
  }
  const out: LockerBox[] = []
  const seen = new Set<string>()
  for (const r of meta.resupply) {
    const prop = r.locker ? props.get(r.locker) : undefined
    const at = prop?.origin ?? (Array.isArray(r.mins) && Array.isArray(r.maxs) ? centerOf(r.mins, r.maxs) : null)
    const team = r.team === 2 || r.team === 3 ? r.team : at ? untaggedLockerTeam(meta, at) : 0
    const key = teamKey(team)
    const body = new THREE.Color(key ? TEAM_DARK[key] : NEUTRAL)
    const panel = new THREE.Color(key ? TEAM_HUD[key] : NEUTRAL)
    if (prop) {
      if (seen.has(prop.name ?? '')) continue
      seen.add(prop.name ?? '')
      const quat = angleQuaternion(prop.angles, new THREE.Quaternion())
      const base = new THREE.Vector3(prop.origin[0] - origin.x, prop.origin[1] - origin.y, prop.origin[2] - origin.z)
      const { width, depth, height } = LOCKER_SIZE
      const center = base.clone().add(new THREE.Vector3(0, 0, height / 2))
      out.push({
        team,
        name: prop.name ?? r.locker,
        source: 'prop',
        matrix: new THREE.Matrix4().compose(center, quat, new THREE.Vector3(depth, width, height)),
        color: body,
      })
      const front = new THREE.Vector3(depth / 2 + 0.6, 0, 0).applyQuaternion(quat).add(center)
      out.push({
        team,
        name: `${prop.name ?? r.locker}:front`,
        source: 'prop',
        matrix: new THREE.Matrix4().compose(
          front,
          quat,
          new THREE.Vector3(1.2, width - PANEL_INSET * 2, height - PANEL_INSET * 2)
        ),
        color: panel,
      })
      continue
    }
    const min = r.mins, max = r.maxs
    if (!Array.isArray(min) || !Array.isArray(max)) continue
    const center = new THREE.Vector3(
      (min[0] + max[0]) / 2 - origin.x,
      (min[1] + max[1]) / 2 - origin.y,
      (min[2] + max[2]) / 2 - origin.z
    )
    const size = new THREE.Vector3(
      Math.max(1, max[0] - min[0]),
      Math.max(1, max[1] - min[1]),
      Math.max(1, max[2] - min[2])
    )
    out.push({
      team,
      name: r.locker ?? `resupply ${out.length}`,
      source: 'bounds',
      matrix: new THREE.Matrix4().compose(center, new THREE.Quaternion(), size),
      color: body,
    })
  }
  return out
}
