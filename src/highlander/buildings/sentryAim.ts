// Sentry turret aim from the networked pose parameters (contract section 5 F2).
//
// The server sets `aim_pitch` = -pitch and `aim_yaw` = -(turret yaw - build yaw) (CObjectSentrygun::MoveTurret,
// tf_obj_sentrygun.cpp:1851, 1935). m_flPoseParameter travels normalised to 0..1 over the model's pose range, and
// P1 stores round(value x 255): `buildings.pose.yaw` is element 001 and `.pitch` element 000. So
//
//   relYaw = YAW_SIGN * (pose.yaw / 255 * YAW_RANGE - YAW_RANGE / 2) + YAW_OFFSET      degrees, relative to the build yaw
//   pitch  = PITCH_SIGN * (pose.pitch / 255 * PITCH_RANGE - PITCH_RANGE / 2) + PITCH_OFFSET   Source pitch, positive down
//
// scripts/hl/calibrate-sentry.mjs fits the constants on 1438891 and 1440442 and rewrites the block below with
// --write. AIM_AT_ENEMY is set when either fit has R^2 < 0.9: then the turret aims at its enemy while attacking and
// sweeps +/-50 degrees about the build yaw otherwise.
//
// The fit uses the firing samples (the sentry fires only with its turret within 10 degrees of its goal,
// CObjectSentrygun::Attack). Every attacking sample would mix in the real slew after a target is acquired
// (FoundTarget sets the enemy; MoveTurret turns the turret on later thinks), which drops R^2 to about 0.78 / 0.74
// with nearly the same constants. The accuracy figures score poseAimAt, the aim the layer draws; the attacking set
// skips wrangled entries, where the turret follows the engineer's laser dot instead of its enemy.
//
// This module has no React or store imports, so the Node calibration script bundles it as it is.

import { BLD, ENEMY, SENTRY_STATE } from '../extras/enums'
import { trackIndexAt } from '../extras/track'
import type { HighlanderExtras } from '../extras/types'

// <calibration> (written by scripts/hl/calibrate-sentry.mjs --write)
// demos: 1438891 (koth_product_final, 29 sentries, 476 samples), 1440442 (cp_steel_f12, 20 sentries, 138 samples)
// fit on firing samples: 410 of 614 attacking state samples; R^2 yaw 0.9981, pitch 0.9736; rms yaw 2.43 deg, pitch 2.43 deg
// drawn barrel within 15 deg of the enemy centre: 80.1 % of the 614 attacking samples (median 1.66 deg, p90 42.27 deg), 78.8 % of all 637 with the wrangled ones, 99.8 % of the 410 firing samples
// misses are turret slew: 128 samples sit on the tick a target is acquired (28.9 % within), 50 in the 32 ticks after it (46.0 %); without the acquisition tick 93.6 % of 486
export const YAW_RANGE = 361.8
export const YAW_SIGN = -1
export const YAW_OFFSET = 0.1
export const PITCH_RANGE = 101.2
export const PITCH_SIGN = -1
export const PITCH_OFFSET = -0.49
export const AIM_AT_ENEMY = false
// </calibration>

/** The six pose-mapping constants, as one object (the calibration script scores other sets through poseAimAt). */
export interface AimConstants {
  YAW_RANGE: number; YAW_SIGN: number; YAW_OFFSET: number
  PITCH_RANGE: number; PITCH_SIGN: number; PITCH_OFFSET: number
}
export const CALIBRATION: AimConstants = { YAW_RANGE, YAW_SIGN, YAW_OFFSET, PITCH_RANGE, PITCH_SIGN, PITCH_OFFSET }

/** Resolves a sentry's enemy (ENEMY kind and index) to a scene point at tickF, or null. */
export type EnemyCentre = (kind: number, index: number, tickF: number) => { x: number; y: number; z: number } | null

/** Height of WorldSpaceCenter above a standing player's origin: the point CObjectSentrygun aims at. */
export const ENEMY_AIM_HEIGHT = 41
/** SENTRYGUN_EYE_OFFSET_LEVEL_1..3 (tf_shareddefs.h:1351-1353); mini sentries use the L1 parts scaled 0.75. */
export const SENTRY_PIVOT = [32, 32, 40, 46] as const
export const MINI_SCALE = 0.75
/** The turret's pitch limits (CObjectSentrygun::Attack clamps the goal pitch to +/-50). */
export const SENTRY_PITCH_LIMIT = 50
/** Idle sweep about the build yaw (m_iLeftBound / m_iRightBound = build yaw +/- 50). */
export const SENTRY_SWEEP = 50
/** Pose entries further apart than this many ticks hold their value instead of interpolating. */
export const POSE_MAX_GAP = 8

export function sentryPivotHeight(level: number, mini: boolean): number {
  if (mini) return SENTRY_PIVOT[1] * MINI_SCALE
  return SENTRY_PIVOT[Math.max(1, Math.min(3, level))]
}

/** Yaw in degrees of a Source quaternion (AngleQuaternion order: yaw about z applied first). */
export function yawOfQuat(qx: number, qy: number, qz: number, qw: number): number {
  return (Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qy * qy + qz * qz)) * 180) / Math.PI
}

export function wrap180(a: number): number {
  const v = ((((a + 180) % 360) + 360) % 360) - 180
  return v === -180 ? 180 : v
}

/** Turret yaw relative to the build yaw, degrees, from a pose value 0..1. */
export function poseRelYaw(v: number, c: AimConstants = CALIBRATION): number {
  return wrap180(c.YAW_SIGN * (v * c.YAW_RANGE - c.YAW_RANGE / 2) + c.YAW_OFFSET)
}

/** Source pitch (positive down), degrees, from a pose value 0..1. */
export function posePitch(v: number, c: AimConstants = CALIBRATION): number {
  const p = c.PITCH_SIGN * (v * c.PITCH_RANGE - c.PITCH_RANGE / 2) + c.PITCH_OFFSET
  return Math.max(-SENTRY_PITCH_LIMIT, Math.min(SENTRY_PITCH_LIMIT, p))
}

/**
 * The turret aim the layer draws from the pose track at tickF, or null without a pose entry: the entry in effect,
 * interpolated toward the next one when they are at most POSE_MAX_GAP ticks apart (yaw along the shorter arc), so
 * the turret turns smoothly between the server's 3-tick think updates, as the TF2 client interpolates
 * m_flPoseParameter. The calibration script scores this same function, so its printed figure matches the screen.
 */
export function poseAimAt(x: HighlanderExtras, j: number, tickF: number, c: AimConstants = CALIBRATION): { relYaw: number; pitch: number } | null {
  const t = x.buildings.pose
  const i = trackIndexAt(t, j, Math.floor(tickF))
  if (i < 0) return null
  let relYaw = poseRelYaw(t.yaw[i] / 255, c)
  let pitch = posePitch(t.pitch[i] / 255, c)
  const next = i + 1
  if (next < t.offsets[j + 1]) {
    const gap = t.ticks[next] - t.ticks[i]
    const a = (tickF - t.ticks[i]) / gap
    if (gap > 0 && gap <= POSE_MAX_GAP && a > 0) {
      const s = Math.min(1, a)
      relYaw = wrap180(relYaw + wrap180(poseRelYaw(t.yaw[next] / 255, c) - relYaw) * s)
      pitch = pitch + (posePitch(t.pitch[next] / 255, c) - pitch) * s
    }
  }
  return { relYaw, pitch }
}

export interface SentryAim {
  /** degrees relative to the build yaw */
  relYaw: number
  /** Source pitch, degrees, positive down */
  pitch: number
  source: 'pose' | 'enemy' | 'sweep' | 'none'
}

/**
 * The turret aim of sentry instance j at tickF: poseAimAt, a pure function of the extras and tickF. In AIM_AT_ENEMY
 * mode, `enemyCentre(kind, index, tickF)` returns the scene position the turret should look at at tickF (or null),
 * and `pivot` is the turret pivot in scene space.
 */
export function sentryAimAt(
  x: HighlanderExtras,
  j: number,
  tickF: number,
  buildYaw = 0,
  pivot?: { x: number; y: number; z: number },
  enemyCentre?: EnemyCentre
): SentryAim {
  const b = x.buildings
  const tick = Math.floor(tickF)
  if (AIM_AT_ENEMY) {
    const si = trackIndexAt(b.state, j, tick)
    const attacking = si >= 0 && b.state.objState[si] === SENTRY_STATE.ATTACKING && (b.state.flags[si] & BLD.WRANGLED) === 0
    const ei = trackIndexAt(b.enemy, j, tick)
    if (attacking && ei >= 0 && pivot && enemyCentre) {
      const kind = b.enemy.kind[ei]
      const target = kind === ENEMY.PLAYER || kind === ENEMY.BUILDING ? enemyCentre(kind, b.enemy.index[ei], tickF) : null
      if (target) {
        const dx = target.x - pivot.x, dy = target.y - pivot.y, dz = target.z - pivot.z
        const len = Math.hypot(dx, dy, dz)
        if (len > 1) {
          const yaw = (Math.atan2(dy, dx) * 180) / Math.PI
          const pitch = Math.max(-SENTRY_PITCH_LIMIT, Math.min(SENTRY_PITCH_LIMIT, (-Math.asin(dz / len) * 180) / Math.PI))
          return { relYaw: wrap180(yaw - buildYaw), pitch, source: 'enemy' }
        }
      }
    }
    return { relYaw: SENTRY_SWEEP * Math.sin(tickF * 0.02), pitch: 0, source: 'sweep' }
  }

  const pose = poseAimAt(x, j, tickF)
  return pose ? { relYaw: pose.relYaw, pitch: pose.pitch, source: 'pose' } : { relYaw: 0, pitch: 0, source: 'none' }
}
