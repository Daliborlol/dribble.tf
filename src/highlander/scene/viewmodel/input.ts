// Builds the ViewmodelInput of the POV subject from the extras and the base caches. Pure: the same (extras, demo,
// subject, tickF) always gives the same input, so the probe can recompute exactly what the layer draws.

import type { AsyncParser } from '@components/Analyse/Data/AsyncParser'
import { HL } from '@highlander/extras/enums'
import {
  activeWeaponAt,
  animEvents,
  fireTicks,
  flagsAt,
  medigunAt,
  miscAt,
  sniperChargeAt,
  viewmodelAt,
  weaponStateAt,
  type ActiveWeapon,
} from '@highlander/extras/getters'
import { trackIndexAt } from '@highlander/extras/track'
import type { HighlanderExtras } from '@highlander/extras/types'
import { baseHealthAt, type PovSubject } from '@highlander/pov/subject'

import type { ViewmodelInput } from './provider'

export type VmBlock = 'ok' | 'notPov' | 'camera' | 'dead' | 'zoomed' | 'noWeapon' | 'noExtras' | 'setting'

/** Why the viewmodel is or is not drawn for the subject at the tick (contract mount conditions). */
export function viewmodelBlock(x: HighlanderExtras | undefined, demo: AsyncParser, subject: PovSubject | null, tick: number, enabled: boolean): { block: VmBlock; weapon: ActiveWeapon | null; classId: number; team: 'red' | 'blue' | null } {
  const none = { weapon: null, classId: 0, team: null }
  if (!subject) return { block: 'notPov', ...none }
  if (!enabled) return { block: 'setting', ...none }
  if (subject.camera !== 'own' && subject.camera !== 'spectated') return { block: 'camera', ...none }
  if (!x || !x.meta.available.weapon) return { block: 'noExtras', ...none }
  const p = subject.p
  if (p < 0 || baseHealthAt(demo, p, tick) <= 0) return { block: 'dead', ...none }
  const meta = demo.playerCache.metaCache.getMeta(p, tick)
  const team = meta.teamId === 2 ? 'red' : meta.teamId === 3 ? 'blue' : null
  if (!team) return { block: 'dead', ...none }
  if ((flagsAt(x, p, tick) & HL.ZOOMED) !== 0) return { block: 'zoomed', weapon: null, classId: meta.classId, team }
  const weapon = activeWeaponAt(x, p, tick, meta.classId)
  if (!weapon) return { block: 'noWeapon', weapon: null, classId: meta.classId, team }
  return { block: 'ok', weapon, classId: meta.classId, team }
}

/** Tick the current `wstate` field value began (walks back at most `maxSteps` entries), or null. */
function wstateSince(x: HighlanderExtras, p: number, tick: number, test: (i: number) => boolean, maxSteps = 64): number | null {
  const t = x.players.wstate
  const i = trackIndexAt(t, p, tick)
  if (i < 0 || !test(i)) return null
  const lo = t.offsets[p]
  let j = i
  for (let steps = 0; steps < maxSteps && j - 1 >= lo && test(j - 1); steps++) j--
  return t.ticks[j]
}

/** Reload phases and clip increments from the wstate history (shell-by-shell reloads, reload ease-out). */
function reloadHistory(x: HighlanderExtras, p: number, tick: number): { reloadSince?: number; reloadEnd?: number; clipUpTicks: number[] } {
  const t = x.players.wstate
  const i = trackIndexAt(t, p, tick)
  const out: { reloadSince?: number; reloadEnd?: number; clipUpTicks: number[] } = { clipUpTicks: [] }
  if (i < 0) return out
  const lo = t.offsets[p]
  const inReload = (k: number) => t.reload[k] === 1 || t.reload[k] === 2
  if (inReload(i)) {
    out.reloadSince = wstateSince(x, p, tick, inReload, 128) ?? t.ticks[i]
  } else {
    // The latest entry that left a reload phase, within 60 ticks
    for (let k = i; k > lo && tick - t.ticks[k] <= 60; k--) {
      if (inReload(k - 1) && !inReload(k)) {
        out.reloadEnd = t.ticks[k]
        break
      }
    }
  }
  for (let k = i; k > lo && tick - t.ticks[k] <= 12; k--) {
    if (t.clip[k] >= 0 && t.clip[k - 1] >= 0 && t.clip[k] === t.clip[k - 1] + 1) out.clipUpTicks.unshift(t.ticks[k])
  }
  return out
}

// Per-tick event windows: the arrays only change when the integer tick does, so frames within a tick reuse them.
let windowKey = ''
let windowFire: number[] = []
let windowAnim: { tick: number; event: number; data: number }[] = []

export function buildViewmodelInput(x: HighlanderExtras, demo: AsyncParser, p: number, classId: number, team: 'red' | 'blue', weapon: ActiveWeapon, tickF: number): ViewmodelInput {
  const tick = Math.floor(tickF)
  const key = `${p}:${tick}:${x.meta.ticks}`
  if (key !== windowKey) {
    windowKey = key
    windowFire = fireTicks(x, p, tick - 40, tick + 1)
    windowAnim = animEvents(x, p, tick - 60, tick + 1)
  }
  const wstate = weaponStateAt(x, p, tick)
  const history = reloadHistory(x, p, tick)
  const misc = miscAt(x, p, tick)
  return {
    p,
    classId,
    team,
    weaponDef: weapon.def,
    kind: weapon.kind,
    tickF,
    drawTick: weapon.since,
    fireTicks: windowFire,
    anim: windowAnim,
    wstate,
    medigun: medigunAt(x, p, tick),
    sniperCharge: sniperChargeAt(x, p, tick),
    flags: flagsAt(x, p, tick),
    flip: !!misc?.flip,
    vm0: viewmodelAt(x, p, tick, 0),
    vm1: viewmodelAt(x, p, tick, 1),
    interval: x.meta.intervalPerTick || demo.intervalPerTick || 0.015,
    reloadSince: history.reloadSince,
    reloadEnd: history.reloadEnd,
    stateSince: wstate ? wstateSince(x, p, tick, i => x.players.wstate.state[i] === wstate.state) ?? undefined : undefined,
    clipUpTicks: history.clipUpTicks,
    weaponClass: weapon.cls,
  }
}
