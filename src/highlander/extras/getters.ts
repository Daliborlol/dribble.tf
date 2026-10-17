// Value-at-tick accessors for the Highlander extras (contract section 3.7.2).
//
// S0 writes the signatures with stub bodies that return null, 0, [] or the documented default.
// P1 writes the real bodies (and renames the underscore-prefixed parameters it starts to use).
// `p` is a player index, `tick` an integer cache tick, `tickF` a fractional cache tick.

import type { HighlanderExtras } from './types'

export function playerIndexOf(_x: HighlanderExtras, _entityId: number): number {
  return -1 // -1 unknown
}

/** HL mask, 0 without data. */
export function flagsAt(_x: HighlanderExtras, _p: number, _tick: number): number {
  return 0
}

/** Raw ETFCond test on w0..w4. */
export function condAt(_x: HighlanderExtras, _p: number, _tick: number, _cond: number): boolean {
  return false
}

/** Tick the flag became set, null if not set. */
export function flagSince(_x: HighlanderExtras, _p: number, _tick: number, _bit: number): number | null {
  return null
}

/** Tick the flag last went from set to clear, null while set or if never set (within 256 entries). */
export function flagClearedSince(_x: HighlanderExtras, _p: number, _tick: number, _bit: number): number | null {
  return null
}

/** 0..cap; cap 0.95 is the spectator view, 1 the enemy view. */
export function invisAt(_x: HighlanderExtras, _p: number, _tickF: number, _cap = 0.95): number {
  return 0
}

/** 0..100, 100 without data. */
export function cloakMeterAt(_x: HighlanderExtras, _p: number, _tick: number): number {
  return 100
}

export interface DisguiseState { team: number; cls: number; target: number; health: number; weaponDef: number; disguising: boolean; desiredTeam: number; desiredCls: number; since: number }

/** Null unless DISGUISED or DISGUISING. */
export function disguiseAt(_x: HighlanderExtras, _p: number, _tick: number): DisguiseState | null {
  return null
}

export interface ActiveWeapon { id: number; def: number; cls: string; kind: string; slot: string; name: string; since: number }

export function activeWeaponAt(_x: HighlanderExtras, _p: number, _tick: number, _classId: number): ActiveWeapon | null {
  return null
}

export interface WeaponState { state: number; reload: number; clip: number; readyToBackstab: boolean; critFire: boolean; lowered: boolean; chargeTick: number | null }

export function weaponStateAt(_x: HighlanderExtras, _p: number, _tick: number): WeaponState | null {
  return null
}

export type MedigunType = 'medigun' | 'kritzkrieg' | 'quickfix' | 'vaccinator'
export interface MedigunState { charge: number; healing: boolean; attacking: boolean; releasing: boolean; holstered: boolean; target: number; def: number; type: MedigunType; resist: number }

/** Null when def is 65535. */
export function medigunAt(_x: HighlanderExtras, _p: number, _tick: number): MedigunState | null {
  return null
}

/** 0..150 */
export function sniperChargeAt(_x: HighlanderExtras, _p: number, _tick: number): number {
  return 0
}

/** Source FOV (horizontal at 4:3). */
export function fovAt(_x: HighlanderExtras, _p: number, _tickF: number, defaultFov = 90): number {
  return defaultFov
}

/** Degrees, for three.js. Source FOV is horizontal at 4:3: 90 -> 73.74, 20 -> 15.07, 70 -> 55.4. */
export function verticalFov(fovH43: number): number {
  return (2 * Math.atan(Math.tan((fovH43 * Math.PI) / 360) * 0.75) * 180) / Math.PI
}

/** m_vecViewOffset z, null without data. */
export function eyeZAt(_x: HighlanderExtras, _p: number, _tick: number): number | null {
  return null
}

/** Null when alive or unknown. */
export function respawnSecondsAt(_x: HighlanderExtras, _p: number, _tickF: number): number | null {
  return null
}

export function ammoAt(_x: HighlanderExtras, _p: number, _tick: number): { primary: number; secondary: number; metal: number } | null {
  return null
}

/** Weapon defs (d0..d7), then wearable defs (w0..w3) known to items.json; 65535 dropped. */
export function loadoutAt(_x: HighlanderExtras, _p: number, _tick: number): number[] {
  return []
}

export interface ScoringState { kills: number; deaths: number; assists: number; damage: number; heals: number; caps: number; defenses: number; backstabs: number; headshots: number; invulns: number; teleports: number; built: number; destroyed: number; dominations: number; revenges: number; points: number }

/** Null without data (no tv_transmitall). */
export function scoringAt(_x: HighlanderExtras, _p: number, _tick: number): ScoringState | null {
  return null
}

/** 0..100 */
export function itemChargeAt(_x: HighlanderExtras, _p: number, _tick: number): { primary: number; secondary: number; melee: number } | null {
  return null
}

export interface VmState { model: string; seq: number; parity: number; muzzle: number; weaponDef: number; rate: number; nodraw: boolean; since: number }

export function viewmodelAt(_x: HighlanderExtras, _p: number, _tick: number, _which: 0 | 1): VmState | null {
  return null
}

export function fireTicks(_x: HighlanderExtras, _p: number, _from: number, _to: number): number[] {
  return []
}

export function animEvents(_x: HighlanderExtras, _p: number, _from: number, _to: number): { tick: number; event: number; data: number }[] {
  return []
}

export function miscAt(_x: HighlanderExtras, _p: number, _tick: number): { healers: number; carrying: boolean; flip: boolean; obsMode: number; obsTarget: number; revenge: number; heads: number; charge: number; rage: number; stickies: number; saveMeTick: number } | null {
  return null
}

export interface RulesState { roundState: number; winner: number; flags: number; swState: number; rounds: number; redKoth: number; bluKoth: number; hudTimer: number; swTimer: number; waveRed: number; waveBlu: number; restartTick: number }

export function rulesAt(_x: HighlanderExtras, _tick: number): RulesState | null {
  return null
}

/** Seconds shown by a round timer (teamplay_round_timer.cpp:377-403). */
export function timerSecondsAt(_x: HighlanderExtras, _timer: number, _tickF: number): number {
  return 0
}

/** 0..1, lerpField with maxGap = meta.snapshotInterval. */
export function capProgressAt(_x: HighlanderExtras, _point: number, _tickF: number): number {
  return 0
}

export function teamAt(_x: HighlanderExtras, _team: number, _tick: number): { score: number; roundsWon: number; role: number } | null {
  return null
}

/** Last SetConVar value at or before tick. */
export function convarAt(_x: HighlanderExtras, _key: string, _tick: number): string | undefined {
  return undefined
}
