// The shared HUD snapshot (contract section 1.6 rule 10 and section 5 F5).
//
// One plain object per hudTick: the per-player rows (class, health, alive, respawn seconds, badge data), the
// per-team medic state, the objective values, the team header and the round banner. PlayerStatuses,
// MedicPanel, ObjectiveHud, TeamHeader, Scoreboard and RoundBanner read only this object; none of them calls a
// getter. hudTick = renderTick while paused and renderTick - renderTick % HUD_TICK_STEP while playing, so the
// numbers are a pure function of the tick and seeking stays deterministic.
//
// Memoized at module level by (demo, extras, map-meta, hudTick) in a WeakMap: every widget of a render pass
// shares one compute, and the memo never keeps an unloaded demo alive. Rows whose values did not change keep
// their previous object, so memoized rows skip re-rendering.

import { useMemo } from 'react'

import type { AsyncParser } from '@components/Analyse/Data/AsyncParser'
import { HEALTH_MAP } from '@constants/mappings'
import { useInstance, useStore } from '@zus/store'
import { buildingsOf } from '@highlander/buildings/model'
import { HUD_TICK_STEP } from '@highlander/constants'
import { HL } from '@highlander/extras/enums'
import {
  cloakMeterAt,
  disguiseAt,
  flagsAt,
  flagSince,
  hasLocalTables,
  itemChargeAt,
  loadoutAt,
  medigunAt,
  miscAt,
  respawnSecondsAt,
  scoringAt,
  sniperChargeAt,
  type MedigunType,
} from '@highlander/extras/getters'
import { useExtras } from '@highlander/extras/hooks'
import { trackIndexAt } from '@highlander/extras/track'
import type { HighlanderExtras } from '@highlander/extras/types'
import { itemInfo, itemName } from '@highlander/items'
import { useMapMeta, type MapMeta } from '@highlander/map/mapMeta'
import { bannerAt, type BannerView } from '@highlander/objectives/banner'
import { countAtOrBefore } from '@highlander/objectives/deaths'
import { formatK } from '@highlander/objectives/format'
import { stopwatchIndex } from '@highlander/objectives/stopwatch'
import { objectiveModeOf, objectiveViewAt, type ObjectiveView } from '@highlander/objectives/objectiveModel'
import { kadAt, scoreboardAt, scoreIndex, type ScoreboardView } from '@highlander/objectives/scoreboardModel'

// ─── types ─────────────────────────────────────────────────────────────────────

export type CondGlyph = 'uber' | 'kritz' | 'fire' | 'bleed' | 'jarate' | 'milk' | 'marked'

export interface BuildingGlyph {
  type: number
  mode: number
  level: number
  /** 0..1 */
  health: number
  sapped: boolean
  building: boolean
  mini: boolean
  /** the engineer is carrying it */
  carried: boolean
}

export interface HudBadges {
  medic: { pct: number; letter: string; ready: boolean } | null
  /** spy cloak meter 0..100, null when full and uncloaked */
  cloak: number | null
  cloaked: boolean
  disguise: { cls: number; team: number } | null
  /** sniper charge 0..1 while above 0 */
  sniper: number | null
  buildings: BuildingGlyph[]
  stickies: number
  conds: CondGlyph[]
  /** banner / Phlogistinator / Heatmaker rage 0..100 */
  rage: number | null
  /** demoman shield charge 0..100 */
  shield: number | null
  /** jar or ball recharge 0..100 while recharging */
  throwable: number | null
}

export interface HudRow {
  entityId: number
  p: number
  name: string
  team: 'red' | 'blue'
  teamId: number
  classId: number
  health: number
  maxHealth: number
  alive: boolean
  /** whole seconds until respawn, null when alive or unknown */
  respawn: number | null
  badges: HudBadges | null
  /** hover text: full name, loadout, K/A/D and damage */
  title: string
}

export type MedicState = 'BUILDING' | 'READY' | 'ACTIVE' | 'DEAD'

export interface MedicRow {
  entityId: number
  name: string
  team: 'red' | 'blue'
  alive: boolean
  respawn: number | null
  /** extras medigun data present (type and state are exact) */
  known: boolean
  type: MedigunType
  typeName: string
  typeLetter: string
  /** 0..1 */
  charge: number
  state: MedicState
  /** seconds of uber left while ACTIVE */
  secondsLeft: number | null
  /** Vaccinator: ready charges (25 % each) and the selected resist (0 bullet, 1 blast, 2 fire) */
  vacc: { charges: number; resist: number } | null
  /** percentage points ahead of the other team's medic, only on the leading team and when both are alive */
  advantage: number | null
  /** seconds since this medic's last uber in the current round, null when none yet */
  lastUberAgo: number | null
}

export interface HudSnapshot {
  hudTick: number
  ready: boolean
  rows: { blue: HudRow[]; red: HudRow[] }
  medics: { blue: MedicRow[]; red: MedicRow[] }
  objective: ObjectiveView | null
  banner: BannerView | null
  /** Tab scoreboard, computed on first read */
  scoreboard: () => ScoreboardView
}

// ─── badges ────────────────────────────────────────────────────────────────────

const TYPE_LETTER: Record<MedigunType, string> = { medigun: 'U', kritzkrieg: 'K', quickfix: 'Q', vaccinator: 'V' }
const TYPE_NAME: Record<MedigunType, string> = { medigun: 'Medi Gun', kritzkrieg: 'Kritzkrieg', quickfix: 'Quick-Fix', vaccinator: 'Vaccinator' }
/** set_buff_type of banners (1..3), the Phlogistinator (5) and the Hitman's Heatmaker (6); 4 is the B.A.S.E. Jumper */
const RAGE_BUFF_TYPES = new Set([1, 2, 3, 5, 6])
const BALL_BATS = new Set(['tf_weapon_bat_wood', 'tf_weapon_bat_giftwrap'])
const UBER_RELEASE_SECONDS = 8 // weapon_medigun_chargerelease_rate
const VACC_RESIST_SECONDS = 3 // weapon_vaccinator_resist_duration

function condGlyphs(f: number): CondGlyph[] {
  const out: CondGlyph[] = []
  if (f & (HL.UBER | HL.QUICKFIX_UBER | HL.VACC_UBER)) out.push('uber')
  if (f & HL.CRIT) out.push('kritz')
  if (f & HL.MARKED) out.push('marked')
  if (f & HL.BURNING) out.push('fire')
  if (f & HL.BLEEDING) out.push('bleed')
  if (f & HL.JARATED) out.push('jarate')
  if (f & HL.MILKED) out.push('milk')
  return out
}

function badgesOf(x: HighlanderExtras, p: number, classId: number, alive: boolean, tick: number, baseCharge: number | null): HudBadges {
  const a = x.meta.available
  const f = a.cond ? flagsAt(x, p, tick) : 0
  const local = hasLocalTables(x, p)
  const badges: HudBadges = {
    medic: null,
    cloak: null,
    cloaked: false,
    disguise: null,
    sniper: null,
    buildings: [],
    stickies: 0,
    conds: alive ? condGlyphs(f) : [],
    rage: null,
    shield: null,
    throwable: null,
  }
  if (!alive) return badges

  if (classId === 5) {
    const m = a.medigun ? medigunAt(x, p, tick) : null
    const charge = m ? m.charge : baseCharge !== null ? baseCharge / 100 : null
    if (charge !== null) {
      const pct = Math.floor(charge * 100 + 1e-6)
      badges.medic = { pct, letter: m ? TYPE_LETTER[m.type] : 'U', ready: pct >= 100 }
    }
  } else if (classId === 8) {
    const meter = a.cloak ? cloakMeterAt(x, p, tick) : 100
    badges.cloaked = (f & HL.CLOAKED) !== 0
    if (meter < 100 || badges.cloaked) badges.cloak = meter
    const d = a.disguise ? disguiseAt(x, p, tick) : null
    if (d && !d.disguising && d.cls > 0) badges.disguise = { cls: d.cls, team: d.team }
  } else if (classId === 2) {
    const c = a.sniper ? sniperChargeAt(x, p, tick) : 0
    if (c > 0) badges.sniper = Math.min(1, c / 150)
  } else if (classId === 9) {
    for (const b of buildingsOf(x, p, tick)) {
      if (b.mapPlaced || b.type === 3) continue
      badges.buildings.push({
        type: b.type,
        mode: b.mode,
        level: b.level,
        health: b.maxHealth > 0 ? Math.max(0, Math.min(1, b.health / b.maxHealth)) : 1,
        sapped: b.sapped,
        building: b.building,
        mini: b.mini,
        carried: b.carried,
      })
    }
    badges.buildings.sort((u, v) => u.type - v.type || u.mode - v.mode)
  }

  const misc = a.misc ? miscAt(x, p, tick) : null
  if (classId === 4 && misc && local && misc.stickies > 0) badges.stickies = misc.stickies

  if (a.loadout && (classId === 2 || classId === 3 || classId === 4 || classId === 7 || classId === 1 || classId === 8)) {
    const loadout = loadoutAt(x, p, tick)
    let rage = false, shield = false, jar = false, ball = false
    for (const def of loadout) {
      const info = itemInfo(def)
      if (!info) continue
      if (info.buffType !== undefined && RAGE_BUFF_TYPES.has(info.buffType)) rage = true
      if (info.kind === 'shield') shield = true
      if (info.kind === 'jar') jar = true
      if (info.kind === 'melee_blunt' && info.weaponMode === 1 && BALL_BATS.has(info.itemClass)) ball = true
    }
    if (rage && misc && local && misc.rage > 0) badges.rage = misc.rage
    if (shield && misc) badges.shield = misc.charge
    if ((jar || ball) && a.itemCharge && local) {
      const charge = itemChargeAt(x, p, tick)
      const value = charge ? (jar ? charge.secondary : charge.melee) : 100
      if (value < 100) badges.throwable = value
    }
  }
  return badges
}

// ─── rows ──────────────────────────────────────────────────────────────────────

function maxHealthOf(x: HighlanderExtras | undefined, p: number, classId: number, tick: number): number {
  if (x && x.meta.available.resource) {
    const t = x.players.resource
    const i = trackIndexAt(t, p, tick)
    if (i >= 0 && t.maxHealth[i] > 0) return t.maxHealth[i]
  }
  return HEALTH_MAP[classId] ?? 100
}

function titleOf(demo: AsyncParser, x: HighlanderExtras | undefined, p: number, name: string, tick: number): string {
  const lines = [name]
  if (x && x.meta.available.loadout) {
    const names = loadoutAt(x, p, tick).map(itemName).filter(n => n !== 'Unknown')
    if (names.length) lines.push(names.join(', '))
  }
  const kad = kadAt(demo, x, p, tick)
  let damage: number | null = null
  if (x) {
    const scoring = x.meta.available.scoring && hasLocalTables(x, p) ? scoringAt(x, p, tick) : null
    if (scoring) damage = scoring.damage
    else if (x.meta.available.resource) {
      const t = x.players.resource
      const i = trackIndexAt(t, p, tick)
      if (i >= 0) damage = t.damage[i]
    }
  }
  lines.push(`K ${kad.kills} A ${kad.assists} D ${kad.deaths}${damage !== null ? `, ${formatK(damage)} damage` : ''}`)
  return lines.join('\n')
}

const rowSig = (r: HudRow) => JSON.stringify(r)

// ─── medic panel ───────────────────────────────────────────────────────────────

function medicRowOf(x: HighlanderExtras | undefined, row: HudRow, baseCharge: number | null, tick: number): MedicRow {
  const out: MedicRow = {
    entityId: row.entityId,
    name: row.name,
    team: row.team,
    alive: row.alive,
    respawn: row.respawn,
    known: false,
    type: 'medigun',
    typeName: 'Medigun',
    typeLetter: 'U',
    charge: 0,
    state: row.alive ? 'BUILDING' : 'DEAD',
    secondsLeft: null,
    vacc: null,
    advantage: null,
    lastUberAgo: null,
  }
  const m = x && x.meta.available.medigun ? medigunAt(x, row.p, tick) : null
  if (m) {
    out.known = true
    out.type = m.type
    out.typeName = TYPE_NAME[m.type]
    out.typeLetter = TYPE_LETTER[m.type]
    out.charge = m.charge
  } else if (baseCharge !== null) {
    out.charge = baseCharge / 100
  }
  if (!row.alive) {
    out.charge = 0
    return out
  }
  if (m && m.type === 'vaccinator') {
    out.vacc = { charges: Math.floor(m.charge * 4 + 1e-6), resist: m.resist }
    const f = x!.meta.available.cond ? flagsAt(x!, row.p, tick) : 0
    if (f & HL.VACC_UBER) {
      const onset = flagSince(x!, row.p, tick, HL.VACC_UBER) ?? tick
      out.state = 'ACTIVE'
      out.secondsLeft = Math.max(0, VACC_RESIST_SECONDS - (tick - onset) * x!.meta.intervalPerTick)
    } else out.state = out.vacc.charges > 0 ? 'READY' : 'BUILDING'
  } else if (m && m.releasing) {
    out.state = 'ACTIVE'
    out.secondsLeft = m.charge * UBER_RELEASE_SECONDS
  } else {
    out.state = out.charge >= 1 - 1e-6 ? 'READY' : 'BUILDING'
  }
  return out
}

// ─── snapshot ──────────────────────────────────────────────────────────────────

export function hudTickOf(renderTick: number, playing: boolean): number {
  return playing ? renderTick - (renderTick % HUD_TICK_STEP) : renderTick
}

/**
 * The snapshot at `tick`, a pure function of its inputs. `prev` only lends its unchanged row objects (same
 * values, same object) so memoized rows skip re-rendering.
 */
export function computeHudSnapshot(
  demo: AsyncParser,
  x: HighlanderExtras | undefined,
  meta: MapMeta | null,
  tick: number,
  prev?: HudSnapshot | null
): HudSnapshot {
  const ipt = demo.intervalPerTick || 0.015
  const prevRows = new Map<number, { row: HudRow; sig: string }>()
  if (prev) for (const r of [...prev.rows.blue, ...prev.rows.red]) prevRows.set(r.entityId, { row: r, sig: rowSig(r) })

  const blue: HudRow[] = []
  const red: HudRow[] = []
  const baseCharges = new Map<number, number | null>()
  for (const player of demo.getPlayersAtTick(tick)) {
    if (!player.connected || (player.teamId !== 2 && player.teamId !== 3)) continue
    const entityId = player.user.entityId
    const p = demo.playerIndexOfEntity(entityId)
    const alive = player.health > 0
    let respawn: number | null = null
    if (!alive) {
      const seconds = x && x.meta.available.resource ? respawnSecondsAt(x, p, tick) : null
      if (seconds !== null) respawn = Math.ceil(seconds - 1e-6)
      else if (player.respawnTick != null) respawn = Math.max(0, Math.ceil((player.respawnTick - tick) * ipt))
    }
    baseCharges.set(entityId, player.chargeLevel)
    let row: HudRow = {
      entityId,
      p,
      name: player.user.name,
      team: player.teamId === 2 ? 'red' : 'blue',
      teamId: player.teamId,
      classId: player.classId,
      health: player.health,
      maxHealth: maxHealthOf(x, p, player.classId, tick),
      alive,
      respawn,
      badges: x && p >= 0 ? badgesOf(x, p, player.classId, alive, tick, player.chargeLevel) : null,
      title: p >= 0 ? titleOf(demo, x, p, player.user.name, tick) : player.user.name,
    }
    const old = prevRows.get(entityId)
    if (old && old.sig === rowSig(row)) row = old.row
    ;(row.team === 'red' ? red : blue).push(row)
  }

  // medics: medic rows of each team, alive first, at most two
  const medicsOf = (rows: HudRow[]) =>
    rows
      .filter(r => r.classId === 5)
      .sort((a, b) => Number(b.alive) - Number(a.alive))
      .slice(0, 2)
      .map(r => medicRowOf(x, r, baseCharges.get(r.entityId) ?? null, tick))
  const medics = { blue: medicsOf(blue), red: medicsOf(red) }
  const best = (rows: MedicRow[]) => rows.filter(r => r.alive).reduce<MedicRow | null>((b, r) => (!b || r.charge > b.charge ? r : b), null)
  const bluBest = best(medics.blue), redBest = best(medics.red)
  if (bluBest && redBest) {
    const diff = Math.round((bluBest.charge - redBest.charge) * 100)
    if (diff > 0) bluBest.advantage = diff
    else if (diff < 0) redBest.advantage = -diff
  }
  if (x) {
    // Each medic's own latest uber at or before the tick, counted only from the current round's start: the
    // stopwatch side swap and round restarts never carry another medic's or the previous round's uber over.
    const index = scoreIndex(demo, x)
    const starts = stopwatchIndex(x).roundStarts
    const nStarts = countAtOrBefore(starts, tick)
    const roundStart = nStarts > 0 ? starts[nStarts - 1] : -Infinity
    const pOf = new Map<number, number>()
    for (const r of [...blue, ...red]) pOf.set(r.entityId, r.p)
    for (const r of [...medics.blue, ...medics.red]) {
      const list = index.ubers[pOf.get(r.entityId) ?? -1] ?? []
      const n = countAtOrBefore(list, tick)
      const last = n > 0 ? list[n - 1] : -Infinity
      r.lastUberAgo = last >= roundStart && Number.isFinite(last) ? (tick - last) * ipt : null
    }
  }

  const mode = x ? objectiveModeOf(x, meta) : 'none'
  let scoreboard: ScoreboardView | null = null
  return {
    hudTick: tick,
    ready: !!x,
    rows: { blue, red },
    medics,
    objective: x ? objectiveViewAt(x, meta, tick) : null,
    banner: x ? bannerAt(x, mode, tick) : null,
    scoreboard: () => (scoreboard ??= scoreboardAt(demo, x, tick)),
  }
}

// ─── memo + hook ───────────────────────────────────────────────────────────────

interface SnapshotMemo { demo: AsyncParser; x: HighlanderExtras | undefined; meta: MapMeta | null; tick: number; snap: HudSnapshot }

// The last snapshot per data set, keyed by the extras object when there is one, else by the demo. Either key
// belongs to one loaded demo, so a replaced demo or a replaced extras object (and the caches behind them) is
// never kept alive by this memo, even when no snapshot is computed afterwards (Highlander turned off).
const memo = new WeakMap<AsyncParser | HighlanderExtras, SnapshotMemo>()
const stats = { computes: 0, lastHudTick: -1 }

export function getHudSnapshot(demo: AsyncParser, x: HighlanderExtras | undefined, meta: MapMeta | null, hudTick: number): HudSnapshot {
  const key = x ?? demo
  const last = memo.get(key)
  const same = !!last && last.demo === demo && last.x === x
  if (same && last.meta === meta && last.tick === hudTick) return last.snap
  const snap = computeHudSnapshot(demo, x, meta, hudTick, same ? last.snap : null)
  memo.set(key, { demo, x, meta, tick: hudTick, snap })
  stats.computes++
  stats.lastHudTick = hudTick
  return snap
}

/** { computes, lastHudTick } for the `hud.snapshotStats` probe. */
export function hudSnapshotStats(): { computes: number; lastHudTick: number } {
  return { ...stats }
}

/** The map-meta of the loaded demo's map (null while loading or absent). */
export function useDemoMapMeta(): MapMeta | null {
  const map = useInstance(s => s.parsedDemo?.header?.map ?? '')
  return useMapMeta(map)
}

/** The shared snapshot at this renderTick's hudTick, null without a demo. */
export function useHudSnapshot(renderTick: number): HudSnapshot | null {
  const demo = useInstance(s => s.parsedDemo)
  const x = useExtras()
  const playing = useStore(s => s.playback.playing)
  const meta = useDemoMapMeta()
  const hudTick = hudTickOf(renderTick, playing)
  return useMemo(() => (demo ? getHudSnapshot(demo, x, meta, hudTick) : null), [demo, x, meta, hudTick])
}
