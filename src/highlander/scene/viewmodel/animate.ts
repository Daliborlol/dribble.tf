// Viewmodel animation (contract section 5 F4 table): every value is a pure function of the ViewmodelInput, so a
// paused frame, a seek and playback through the same tick all draw the same pose (D12). Times are in ticks.

import { HL, MINIGUN_STATE, FLAME_STATE } from '@highlander/extras/enums'

import type { ViewmodelInput } from './provider'

export interface VmPose {
  // Whole-weapon offset in eye space (Hammer units) and rotation (degrees: pitch + nose down, yaw + left,
  // roll + clockwise as seen by the player)
  fwd: number; right: number; up: number; pitch: number; yaw: number; roll: number
  /** Draw progress, 0 at the weapon switch, 1 when settled. */
  draw: number
  /** Fire kick weight 0..1. */
  kick: number
  /** Reload dip weight 0..1. */
  reload: number
  /** Melee swing progress 0..1, -1 when not swinging. */
  swing: number
  muzzleFlash: boolean
  /** Minigun barrel roll in degrees. */
  spin: number
  /** Sniper bolt or shotgun pump travel 0..1. */
  cycle: number
  /** Bow draw or sticky launcher charge 0..1. */
  pull: number
  /** Knife raised for a backstab 0..1. */
  bladeUp: number
  /** Flamethrower flame intensity 0..1 (flicker included). */
  flame: number
  /** Airblast puff progress 0..1, -1 when none. */
  puff: number
  /** Medigun nozzle glow 0..1. */
  heal: number
  /** Uber charge 0..1 (canister). */
  charge: number
  /** Grenade launcher drum turn in degrees. */
  drum: number
  /** Fists jab progress 0..1 (-1 none) and which hand jabs. */
  jab: number; jabLeft: boolean
  /** The bow arrow or crossbow bolt is nocked. */
  loaded: boolean
  /** Spy watch raise 0..1, -1 when the watch hand is not drawn. */
  watch: number
  /** Lunchbox raised to the mouth (taunt) 0..1. */
  eat: number
}

export const MELEE_KINDS = new Set(['melee_blunt', 'melee_blade', 'knife', 'wrench', 'fists'])
const NO_FLASH_KINDS = new Set(['melee_blunt', 'melee_blade', 'knife', 'wrench', 'fists', 'medigun', 'flamethrower', 'bow', 'crossbow', 'pda', 'watch', 'sapper', 'lunchbox', 'jar', 'banner'])
const RELOAD_KINDS = new Set(['rocket_launcher', 'shotgun', 'scattergun', 'pistol', 'revolver', 'smg', 'grenade_launcher', 'sticky_launcher', 'syringe_gun', 'crossbow', 'other'])

const ANIM_ATTACK_PRIMARY = 0
/** Backstabs arrive as CUSTOM_GESTURE (activity 1088 on the local demos), not ATTACK_PRIMARY. */
const ANIM_CUSTOM_GESTURE = 20
const ANIM_RELOAD = 3
const ANIM_RELOAD_LOOP = 4
const ANIM_RELOAD_END = 5

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3
const easeInOut = (t: number) => t * t * (3 - 2 * t)
/** Deterministic noise in [0, 1) (Appendix B.6). */
export const hash01 = (n: number) => {
  const s = Math.sin(n * 12.9898) * 43758.5453
  return s - Math.floor(s)
}

/** Latest value in a sorted list at or before t, or null. */
function latestAtOrBefore(list: number[], t: number): number | null {
  for (let i = list.length - 1; i >= 0; i--) if (list[i] <= t) return list[i]
  return null
}

function latestAnim(input: ViewmodelInput, events: number[], t: number): number | null {
  const a = input.anim
  for (let i = a.length - 1; i >= 0; i--) if (a[i].tick <= t && events.includes(a[i].event)) return a[i].tick
  return null
}

/** Reload weight: eases in over 6 ticks from the reload start and out over 6 ticks after its end. */
function reloadWeight(input: ViewmodelInput, t: number): number {
  const ws = input.wstate
  const inReload = !!ws && (ws.reload === 1 || ws.reload === 2)
  if (inReload) {
    const since = input.reloadSince ?? latestAnim(input, [ANIM_RELOAD, ANIM_RELOAD_LOOP], t) ?? t
    return easeInOut(clamp01((t - since) / 6))
  }
  if (input.reloadEnd !== undefined) return 1 - easeInOut(clamp01((t - input.reloadEnd) / 6))
  if (!ws) {
    // No weapon state (old demos): reload anim events alone, until RELOAD_END or 40 ticks
    const start = latestAnim(input, [ANIM_RELOAD, ANIM_RELOAD_LOOP], t)
    const end = latestAnim(input, [ANIM_RELOAD_END], t)
    if (start !== null && (end === null || end < start) && t - start < 40) return easeInOut(clamp01((t - start) / 6))
    if (end !== null && start !== null && end >= start) return 1 - easeInOut(clamp01((t - end) / 6))
  }
  return 0
}

/** Reload bumps: each RELOAD_LOOP event or clip increment adds a 6-tick dip of -2. */
function reloadBump(input: ViewmodelInput, t: number): number {
  let bump = 0
  const add = (tick: number) => {
    const age = t - tick
    if (age >= 0 && age < 6) bump = Math.min(bump, -2 * Math.sin((Math.PI * age) / 6))
  }
  for (const e of input.anim) if (e.event === ANIM_RELOAD_LOOP) add(e.tick)
  for (const tick of input.clipUpTicks ?? []) add(tick)
  return bump
}

export function computePose(input: ViewmodelInput, kind: string, opts: { kick: [number, number]; melee: boolean; reloads: boolean }): VmPose {
  const t = input.tickF
  const interval = input.interval ?? 0.015
  const pose: VmPose = {
    fwd: 0, right: 0, up: 0, pitch: 0, yaw: 0, roll: 0,
    draw: 1, kick: 0, reload: 0, swing: -1, muzzleFlash: false,
    spin: 0, cycle: 0, pull: 0, bladeUp: 0, flame: 0, puff: -1, heal: 0, charge: 0, drum: 0,
    jab: -1, jabLeft: false, loaded: true, watch: -1, eat: 0,
  }

  // Draw: the weapon rises into place over 33 ticks after a switch
  const d = clamp01((t - input.drawTick) / 33)
  const e = easeOutCubic(d)
  pose.draw = d
  pose.up += -14 * (1 - e)
  pose.pitch += 25 * (1 - e)

  // Fire kick: latest fire event within 12 ticks
  const lastFire = latestAtOrBefore(input.fireTicks, t)
  const fireAge = lastFire === null ? Infinity : t - lastFire
  if (!opts.melee && fireAge <= 12) {
    const a = Math.max(0, 1 - fireAge / 8)
    pose.kick = a
    pose.fwd -= 2.5 * a * opts.kick[0]
    pose.pitch -= 4 * a * opts.kick[1]
    pose.muzzleFlash = fireAge < 2 && !NO_FLASH_KINDS.has(kind)
  }

  // Melee swing: latest ATTACK_PRIMARY (or a knife's backstab gesture) within 14 ticks; the weapon sweeps from the
  // right to the left
  if (opts.melee) {
    const swingTick = latestAnim(input, kind === 'knife' ? [ANIM_ATTACK_PRIMARY, ANIM_CUSTOM_GESTURE] : [ANIM_ATTACK_PRIMARY], t)
    const age = swingTick === null ? Infinity : t - swingTick
    if (age < 14) {
      const s = age / 14
      pose.swing = s
      if (kind === 'fists') {
        pose.jab = s
        pose.jabLeft = !!input.vm0 && input.vm0.seq % 2 === 1
      } else {
        const arc = Math.sin(Math.PI * s)
        pose.yaw += -35 + 80 * easeInOut(s)
        pose.fwd += 6 * arc
        pose.roll += 20 * arc
        pose.pitch += 18 * arc
      }
    }
  }

  // Reload dip with per-shell bumps
  if (opts.reloads && RELOAD_KINDS.has(kind)) {
    const k = reloadWeight(input, t)
    pose.reload = k
    pose.up += -5 * k + reloadBump(input, t)
    pose.roll += -18 * k
    pose.pitch -= 4 * k // lift the muzzle a little so the dipped weapon stays in view
  }

  const ws = input.wstate
  switch (kind) {
    case 'minigun': {
      const state = ws?.state ?? 0
      const rate = state === MINIGUN_STATE.FIRING || state === MINIGUN_STATE.SPINNING ? 18 : state === MINIGUN_STATE.STARTFIRING ? 6 : 0
      pose.spin = (t * rate) % 360
      if (state === MINIGUN_STATE.FIRING) {
        // Continuous fire: a small deterministic shake and a flickering flash instead of per-event kicks
        const n = Math.floor(t * 2)
        pose.fwd -= 0.5 + 0.4 * hash01(n)
        pose.up += 0.25 * (hash01(n + 7) - 0.5)
        pose.right += 0.25 * (hash01(n + 13) - 0.5)
        pose.muzzleFlash = hash01(n + 3) > 0.35
        pose.kick = Math.max(pose.kick, 0.3)
      }
      break
    }
    case 'flamethrower': {
      const state = ws?.state ?? 0
      if (state === FLAME_STATE.STARTFIRING || state === FLAME_STATE.FIRING) {
        pose.flame = 0.72 + 0.28 * hash01(Math.floor(t * 3))
        pose.fwd -= 0.3 * hash01(Math.floor(t * 3) + 5)
      }
      if (state === FLAME_STATE.SECONDARY) {
        const since = input.stateSince ?? t
        const p = (t - since) / 8
        if (p >= 0 && p < 1) {
          pose.puff = p
          pose.fwd -= 3 * Math.sin(Math.PI * p)
          pose.pitch -= 3 * Math.sin(Math.PI * p)
        }
      }
      break
    }
    case 'medigun': {
      pose.heal = input.medigun?.healing ? 1 : 0
      pose.charge = input.medigun?.charge ?? 0
      break
    }
    case 'sniper_rifle': {
      // Bolt slides back 3 and returns over 20 ticks after a shot
      if (fireAge < 20) pose.cycle = fireAge < 6 ? fireAge / 6 : 1 - (fireAge - 6) / 14
      break
    }
    case 'shotgun': {
      // Pump: back and forth between 4 and 16 ticks after the shot
      const p = (fireAge - 4) / 12
      if (p >= 0 && p < 1) pose.cycle = Math.sin(Math.PI * p)
      break
    }
    case 'bow': {
      const chargeTick = ws?.chargeTick ?? null
      if (chargeTick !== null) pose.pull = clamp01(((t - chargeTick) * interval) / 1.0)
      pose.loaded = !(fireAge < 12)
      break
    }
    case 'sticky_launcher': {
      const chargeTick = ws?.chargeTick ?? null
      if (chargeTick !== null) pose.pull = clamp01(((t - chargeTick) * interval) / 4.0)
      break
    }
    case 'grenade_launcher': {
      if (fireAge < 10) pose.drum = 60 * easeInOut(clamp01(fireAge / 6))
      break
    }
    case 'crossbow': {
      pose.loaded = ws && ws.clip >= 0 ? ws.clip > 0 : !(fireAge < 60)
      break
    }
    case 'knife': {
      pose.bladeUp = ws?.readyToBackstab ? 1 : 0
      break
    }
    case 'lunchbox': {
      pose.eat = (input.flags & HL.TAUNTING) !== 0 ? 1 : 0
      break
    }
  }

  // Spy watch hand (viewmodel 1): drawn while not nodraw; raised over 10 ticks, lowered over 20 (sequence 2)
  const vm1 = input.vm1
  if (vm1 && !vm1.nodraw && vm1.model) {
    const age = t - vm1.since
    pose.watch = vm1.seq === 2 ? 1 - clamp01(age / 20) : vm1.seq === 0 ? easeOutCubic(clamp01(age / 10)) : 1
  }

  // Idle sway
  pose.right += 0.4 * Math.sin(t * 0.05)
  pose.up += 0.3 * Math.sin(t * 0.1)
  return pose
}
