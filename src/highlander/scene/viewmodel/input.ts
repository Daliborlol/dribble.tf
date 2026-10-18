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

type AnimEvent = { tick: number; event: number; data: number }

const ANIM_RELOAD = 3
const ANIM_RELOAD_LOOP = 4
const ANIM_RELOAD_END = 5
/** A finished reload reports its end tick this long (the 6-tick ease-out, and no restart from its own events). */
const RELOAD_END_WINDOW = 60
/** Contract: a RELOAD or RELOAD_LOOP anim event holds the reload pose 40 ticks when nothing in the data ends it. */
const ANIM_RELOAD_HOLD = 40
/**
 * While the clip is known, a whole-clip reload holds until the clip refills, at most this long. The slowest stock
 * clip reloads take about 1.5 s (Force-A-Nature 1.43 s, syringe gun 1.3 s, pistol 1.25 s), 100 ticks at 66.7 Hz.
 */
const CLIP_RELOAD_MAX = 110
/** Anim and fire events read for whole-clip reloads: the longest reload plus the end window. */
const RELOAD_LOOKBACK = CLIP_RELOAD_MAX + RELOAD_END_WINDOW

interface ReloadHistory { reloadSince?: number; reloadEnd?: number; clipUpTicks: number[] }

/**
 * Whole-clip reloads. CTFWeaponBase::DefaultReload (pistols, revolvers, SMGs, syringe guns, the Force-A-Nature)
 * emits PLAYERANIMEVENT_RELOAD but leaves m_iReloadMode at TF_RELOAD_START (tf_weaponbase.cpp:1812-1816 and 2202),
 * so wstate never shows these reloads. One starts at a RELOAD event after the weapon was drawn (old demos without
 * weapon state reload singly through a run of RELOAD and RELOAD_LOOP events, each within the hold of the previous
 * one), and the first of these ends it: RELOAD_END, the clip growing, a shot (firing with rounds left aborts the
 * reload, tf_weaponbase.cpp:2384-2404), or the hold: CLIP_RELOAD_MAX from the start while the clip is known (the
 * refill comes first), else the contract's 40 ticks after the latest event.
 */
function clipReloadPhase(x: HighlanderExtras, p: number, tick: number, drawTick: number, anim: AnimEvent[], fire: number[]): { since?: number; end?: number } {
  const isReload = (e: AnimEvent) => e.event === ANIM_RELOAD || e.event === ANIM_RELOAD_LOOP
  const firedIn = (from: number, to: number) => fire.some(f => f > from && f <= to)
  let last = anim.length - 1
  while (last >= 0 && !(anim[last].tick <= tick && isReload(anim[last]))) last--
  if (last < 0 || anim[last].tick < drawTick) return {}
  let first = last
  for (let k = last - 1; k >= 0; k--) {
    const e = anim[k]
    if (e.event === ANIM_RELOAD_END || e.tick < drawTick) break
    if (!isReload(e)) continue
    if (anim[first].tick - e.tick > ANIM_RELOAD_HOLD || firedIn(e.tick, anim[first].tick)) break
    first = k
  }
  const start = anim[first].tick
  const lastTick = anim[last].tick

  let end = Infinity
  for (let k = last + 1; k < anim.length; k++) {
    if (anim[k].tick > tick) break
    if (anim[k].event === ANIM_RELOAD_END) { end = anim[k].tick; break }
  }
  for (const f of fire) if (f > lastTick && f <= tick) { end = Math.min(end, f); break }
  const w = x.players.wstate
  const i = trackIndexAt(w, p, tick)
  const clipKnown = i >= 0 && w.clip[i] >= 0
  if (clipKnown) {
    const lo = w.offsets[p]
    for (let k = i; k > lo && w.ticks[k] > lastTick; k--) {
      if (w.clip[k - 1] >= 0 && w.clip[k] > w.clip[k - 1]) end = Math.min(end, w.ticks[k])
    }
  }
  const hold = clipKnown ? start + CLIP_RELOAD_MAX : lastTick + ANIM_RELOAD_HOLD
  if (end <= tick) return { end: Math.min(end, hold) }
  return hold > tick ? { since: start } : { end: hold }
}

/**
 * Reload phases: wstate reload 1 or 2 (weapons that reload singly), else the whole-clip reload of the anim events;
 * plus the clip increments of the last 12 ticks (shell-by-shell reloads).
 */
function reloadHistory(x: HighlanderExtras, p: number, tick: number, drawTick: number, anim: AnimEvent[], fire: number[]): ReloadHistory {
  const t = x.players.wstate
  const i = trackIndexAt(t, p, tick)
  const out: ReloadHistory = { clipUpTicks: [] }
  const inReload = (k: number) => t.reload[k] === 1 || t.reload[k] === 2
  let wstateEnd: number | undefined
  if (i >= 0) {
    const lo = t.offsets[p]
    for (let k = i; k > lo && tick - t.ticks[k] <= 12; k--) {
      if (t.clip[k] >= 0 && t.clip[k - 1] >= 0 && t.clip[k] === t.clip[k - 1] + 1) out.clipUpTicks.unshift(t.ticks[k])
    }
    if (inReload(i)) {
      out.reloadSince = wstateSince(x, p, tick, inReload, 128) ?? t.ticks[i]
      return out
    }
    // The latest entry that left a reload phase, within the end window
    for (let k = i; k > lo && tick - t.ticks[k] <= RELOAD_END_WINDOW; k--) {
      if (inReload(k - 1) && !inReload(k)) {
        wstateEnd = t.ticks[k]
        break
      }
    }
  }
  const clip = clipReloadPhase(x, p, tick, drawTick, anim, fire)
  // A RELOAD event from before the end of a wstate reload belongs to that reload
  if (clip.since !== undefined && (wstateEnd === undefined || clip.since > wstateEnd)) {
    out.reloadSince = clip.since
    return out
  }
  const end = Math.max(wstateEnd ?? -Infinity, clip.end ?? -Infinity)
  if (tick - end <= RELOAD_END_WINDOW) out.reloadEnd = end
  return out
}

// Per-tick event windows and reload phases: they only change when the integer tick does, so frames within a tick
// reuse them.
let windowX: HighlanderExtras | null = null
let windowKey = ''
let windowFire: number[] = []
let windowAnim: AnimEvent[] = []
let windowReload: ReloadHistory = { clipUpTicks: [] }

export function buildViewmodelInput(x: HighlanderExtras, demo: AsyncParser, p: number, classId: number, team: 'red' | 'blue', weapon: ActiveWeapon, tickF: number): ViewmodelInput {
  const tick = Math.floor(tickF)
  const key = `${p}:${tick}:${weapon.since}`
  if (key !== windowKey || x !== windowX) {
    windowX = x
    windowKey = key
    const anim = animEvents(x, p, tick - RELOAD_LOOKBACK, tick + 1)
    const fire = fireTicks(x, p, tick - RELOAD_LOOKBACK, tick + 1)
    windowFire = fire.filter(f => f >= tick - 40)
    windowAnim = anim.filter(e => e.tick >= tick - 60)
    windowReload = reloadHistory(x, p, tick, weapon.since, anim, fire)
  }
  const wstate = weaponStateAt(x, p, tick)
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
    reloadSince: windowReload.reloadSince,
    reloadEnd: windowReload.reloadEnd,
    stateSince: wstate ? wstateSince(x, p, tick, i => x.players.wstate.state[i] === wstate.state) ?? undefined : undefined,
    clipUpTicks: windowReload.clipUpTicks,
    weaponClass: weapon.cls,
  }
}
