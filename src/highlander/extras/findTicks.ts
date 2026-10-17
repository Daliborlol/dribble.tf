// Interesting-tick finder (contract section 3.8). S0 writes the signature; P1 implements the kinds.

import type { HighlanderExtras } from './types'

export type FindKind =
  | 'cloak'
  | 'decloak'
  | 'disguise'
  | 'disguising'
  | 'feign'
  | 'backstab'
  | 'headshot'
  | 'uber'
  | 'kritz'
  | 'quickfix'
  | 'vacc'
  | 'crit'
  | 'minicrit'
  | 'burning'
  | 'jarate'
  | 'milk'
  | 'marked'
  | 'bonk'
  | 'overheal'
  | 'teleportedGlow'
  | 'stun'
  | 'gas'
  | 'banner'
  | 'busiest'
  | 'zoom'
  | 'airblast'
  | 'flamesOn'
  | 'deflect'
  | 'buildStart'
  | 'buildDone'
  | 'upgrade'
  | 'carry'
  | 'redeploy'
  | 'sapped'
  | 'destroyed'
  | 'teleported'
  | 'wrangled'
  | `proj:${number}`
  | 'syringe'
  | 'explosion'
  | 'tracer'
  | 'bullet'
  | 'critBullet'
  | 'capStart'
  | 'captured'
  | 'capBlocked'
  | 'capBroken'
  | 'capping'
  | 'cartMoving'
  | 'cartReceding'
  | 'overtime'
  | 'roundWin'
  | 'roundStart'
  | 'setupFinished'
  | 'doorMove'
  | 'pickupTaken'
  | 'pickupBack'
  | 'medicDrop'
  | 'respawnWave'
  | 'medicCall'

/** Cache ticks sorted ascending, `limit` default 20. S0 stub: always empty. */
export function findTicks(
  _x: HighlanderExtras,
  _kind: FindKind,
  _opts?: { limit?: number; player?: number; team?: number }
): { tick: number; player?: number; instance?: number; note?: string }[] {
  return []
}
