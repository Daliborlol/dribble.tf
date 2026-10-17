// Engineer building view model (contract section 6.5; owner F2, read by F5). S0 writes the types and stubs.

import * as THREE from 'three'

import type { HighlanderExtras } from '@highlander/extras/types'

export interface BuildingView {
  instance: number; entityId: number; type: number; mode: number; builder: number; team: number; mini: boolean; mapPlaced: boolean
  level: number; health: number; maxHealth: number; built: number; building: boolean; sapped: boolean
  disabled: boolean; wrangled: boolean; carried: boolean; upgrading: boolean
  shells: number; rockets: number; metal: number; objState: number; rechargeLeft: number
  pos: THREE.Vector3; yaw: number
}
export function buildingsAt(_x: HighlanderExtras, _tick: number): BuildingView[] {
  return []
}
export function buildingsOf(_x: HighlanderExtras, _p: number, _tick: number): BuildingView[] {
  return []
}
