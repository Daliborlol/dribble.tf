// POV weapon HUD (contract section 5 F4, PovWeaponHud; setting pov.weaponHud; POV only), bottom right, 220 px wide:
// the subject's weapon with clip and reserve, and per class the engineer's metal and buildings, the medic's
// ÜberCharge, the spy's cloak and disguise, soldier and pyro rage, the demoman's stickies and bow or sticky charge.
// "Spectating <name>" and "Killed by <name>" head the panel while the POV follows a teammate or holds the death camera.
//
// The values are a pure function of the subject at hudTick (section 1.6 rule 10): renderTick while paused, rounded
// down to HUD_TICK_STEP while playing. Local-only values (clip, reserve, metal, rage, stickies, charge) need
// hasLocalTables and hide without them.

import React, { useRef } from 'react'

import type { AsyncParser } from '@components/Analyse/Data/AsyncParser'
import { CLASS_MAP } from '@constants/mappings'
import { useInstance, useStore } from '@zus/store'
import { cn } from '@utils/styling'
import { renderTickOf, useStoreValue } from '@utils/tickData'
import { HUD_TICK_STEP, TEAM_FX, TEAM_HUD } from '@highlander/constants'
import { buildingsOf, type BuildingView } from '@highlander/buildings/model'
import { TELE_STATE } from '@highlander/extras/enums'
import { registerHlProbe } from '@highlander/debug'
import {
  activeWeaponAt,
  ammoAt,
  cloakMeterAt,
  disguiseAt,
  hasLocalTables,
  loadoutAt,
  medigunAt,
  miscAt,
  weaponStateAt,
} from '@highlander/extras/getters'
import { useExtras, useHlSetting } from '@highlander/extras/hooks'
import { trackIndexAt } from '@highlander/extras/track'
import type { HighlanderExtras } from '@highlander/extras/types'
import { itemKind, itemName, itemSlot } from '@highlander/items'
import { getPovSubject, usePovSubject, type PovSubject } from '@highlander/pov/subject'

type Team = 'red' | 'blue'

export interface BuildingRow {
  type: number; mode: number; level: number; health: number; maxHealth: number; mini: boolean
  sapped: boolean; carried: boolean; building: boolean; builtPct: number
  detail: string
}

export interface WeaponHudModel {
  team: Team
  header: { text: string; team: Team | null } | null
  weapon: { name: string; clip: number | null; reserve: number | null } | null
  metal: number | null
  buildings: BuildingRow[] | null
  uber: { pct: number; ready: boolean; type: string; resist: string | null } | null
  cloak: number | null
  disguise: string | null
  rage: { label: string; pct: number } | null
  stickies: number | null
  charge: { label: string; pct: number } | null
}

const GUN_KINDS = new Set(['rocket_launcher', 'shotgun', 'scattergun', 'pistol', 'revolver', 'smg', 'sniper_rifle', 'bow', 'minigun', 'flamethrower', 'grenade_launcher', 'sticky_launcher', 'syringe_gun', 'crossbow', 'other'])
const RESIST = ['Bullet', 'Blast', 'Fire']
const TEAM_NAME: Record<number, string> = { 2: 'RED', 3: 'BLU' }
const BANNER_DEFS = new Set([129, 226, 354, 1001])
const PHLOG_DEF = 594

const titleCase = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)
const className = (cls: number) => titleCase(CLASS_MAP[cls] ?? '')
const BUILDING_NAME: Record<number, string> = { 0: 'Dispenser', 1: 'Teleporter', 2: 'Sentry' }

/**
 * The engineer's builder (item 28) is named "PDA" in the item schema; while it is out he carries or places a
 * building, so name that instead from his builder state (m_iObjectType of the owned builder, 255 unknown).
 */
function builderLabel(x: HighlanderExtras, p: number, tick: number, carrying: boolean): string {
  const t = x.players.builder
  const i = trackIndexAt(t, p, tick)
  const name = i >= 0 ? BUILDING_NAME[t.type[i]] : undefined
  return `${carrying ? 'Carrying' : 'Placing'} ${name ?? 'a building'}`
}

function playerName(demo: AsyncParser, p: number): string {
  return demo.entityPlayerMap.get(p)?.user.name ?? `#${p}`
}

function teamOf(demo: AsyncParser, p: number, tick: number): Team | null {
  const id = demo.playerCache.metaCache.getMeta(p, tick).teamId
  return id === 2 ? 'red' : id === 3 ? 'blue' : null
}

/**
 * A built teleporter's state, as the model's ready glow shows it (buildings/render.ts): 'ready' only while it can
 * send or receive (READY..RECEIVING_RELEASE), the seconds while recharging, and for IDLE what the other end is
 * doing: missing ('no exit', 'no entrance'), still building, carried, or not linked yet ('waiting').
 */
function teleporterDetail(b: BuildingView, own: BuildingView[]): string {
  if (b.objState === TELE_STATE.RECHARGING) return b.rechargeLeft > 0.05 ? `${b.rechargeLeft.toFixed(1)}s` : 'ready'
  if (b.objState >= TELE_STATE.READY && b.objState <= TELE_STATE.RECEIVING_RELEASE) return 'ready'
  if (b.objState === TELE_STATE.IDLE) {
    const partner = own.find(o => o.type === 1 && o.mode !== b.mode)
    const end = b.mode === 1 ? 'entry' : 'exit'
    if (!partner) return b.mode === 1 ? 'no entrance' : 'no exit'
    if (partner.carried) return `${end} carried`
    if (partner.building) return `${end} building`
    return 'waiting'
  }
  if (b.objState === TELE_STATE.UPGRADING) return 'upgrading'
  return ''
}

/** One building row; own is every building of the same builder at the tick (the teleporter's partner). */
function buildingRow(b: BuildingView, own: BuildingView[]): BuildingRow {
  const builtPct = b.built > 1 ? b.built / 255 : b.built
  let detail = ''
  if (b.carried) detail = 'carried'
  else if (b.building) detail = `building ${Math.round(builtPct * 100)}%`
  else if (b.type === 2) detail = `${b.shells}${b.level >= 3 ? ` · ${b.rockets}` : ''}`
  else if (b.type === 0) detail = `${b.metal} metal`
  else if (b.type === 1) detail = teleporterDetail(b, own)
  return {
    type: b.type, mode: b.mode, level: b.level, health: b.health, maxHealth: b.maxHealth, mini: b.mini,
    sapped: b.sapped, carried: b.carried, building: b.building, builtPct, detail,
  }
}

/** The HUD values for the POV subject at a cache tick, or null when there is nothing to show. */
export function weaponHudAt(x: HighlanderExtras, demo: AsyncParser, subject: PovSubject, tick: number): WeaponHudModel | null {
  const focusedTeam = subject.focusedP >= 0 ? teamOf(demo, subject.focusedP, tick) : null
  let header: WeaponHudModel['header'] = null
  if (
    subject.camera === 'spectated' ||
    (subject.camera === 'chase' && subject.entityId !== subject.focusedEntityId) ||
    // teammate-death camera (contract 12.2 item 1): the death of the teammate he spectated
    (subject.camera === 'deathcam' && subject.deathOfEntityId !== undefined)
  ) {
    header = { text: `Spectating ${playerName(demo, subject.p)}`, team: teamOf(demo, subject.p, tick) }
  } else if (subject.camera === 'deathcam' && subject.killerEntityId !== undefined) {
    const killerP = demo.playerIndexOfEntity(subject.killerEntityId)
    if (killerP >= 0) header = { text: `Killed by ${playerName(demo, killerP)}`, team: teamOf(demo, killerP, tick) }
  }

  const p = subject.p
  const alive = p >= 0 && (demo.playerCache.healthCache.get(p, tick) || 0) > 0
  const team = (p >= 0 ? teamOf(demo, p, tick) : null) ?? focusedTeam ?? 'red'
  const empty: WeaponHudModel = { team, header, weapon: null, metal: null, buildings: null, uber: null, cloak: null, disguise: null, rage: null, stickies: null, charge: null }
  if (!alive || subject.camera === 'deathcam' || subject.camera === 'stay') return header ? empty : null

  const classId = demo.playerCache.metaCache.getMeta(p, tick).classId
  const local = hasLocalTables(x, p)
  const model: WeaponHudModel = { ...empty }

  const weapon = x.meta.available.weapon ? activeWeaponAt(x, p, tick, classId) : null
  const ws = local && x.meta.available.wstate ? weaponStateAt(x, p, tick) : null
  const ammo = local && x.meta.available.ammo ? ammoAt(x, p, tick) : null
  const misc = miscAt(x, p, tick)
  if (weapon) {
    const slot = itemSlot(weapon.def, classId)
    const gun = GUN_KINDS.has(weapon.kind)
    const reserve = gun && ammo ? (slot === 'primary' ? ammo.primary : slot === 'secondary' ? ammo.secondary : null) : null
    const name = classId === 9 && weapon.cls === 'CTFWeaponBuilder' ? builderLabel(x, p, tick, !!misc?.carrying) : weapon.name
    model.weapon = { name, clip: ws && ws.clip >= 0 ? ws.clip : null, reserve }
    if (ws?.chargeTick != null && (weapon.kind === 'bow' || weapon.kind === 'sticky_launcher')) {
      const seconds = (tick - ws.chargeTick) * x.meta.intervalPerTick
      const pct = Math.min(1, Math.max(0, seconds / (weapon.kind === 'bow' ? 1 : 4)))
      model.charge = { label: weapon.kind === 'bow' ? 'Draw' : 'Charge', pct }
    }
  }

  switch (classId) {
    case 9: { // engineer
      if (ammo) model.metal = ammo.metal
      const own = buildingsOf(x, p, tick)
      model.buildings = own.filter(b => b.type !== 3).map(b => buildingRow(b, own))
      break
    }
    case 5: { // medic
      const m = x.meta.available.medigun ? medigunAt(x, p, tick) : null
      if (m) model.uber = { pct: m.charge, ready: m.charge >= 0.995, type: itemName(m.def), resist: m.type === 'vaccinator' ? RESIST[m.resist] ?? null : null }
      break
    }
    case 8: { // spy
      if (x.meta.available.cloak) model.cloak = cloakMeterAt(x, p, tick)
      const d = x.meta.available.disguise ? disguiseAt(x, p, tick) : null
      if (d && !d.disguising && d.cls > 0) {
        const weaponName = d.weaponDef !== 65535 ? ` (${itemName(d.weaponDef)})` : ''
        model.disguise = `Disguised as ${className(d.cls)}, ${TEAM_NAME[d.team] ?? '?'}${weaponName}`
      } else if (d) {
        const cls = d.desiredCls || d.cls
        const t = d.desiredTeam || d.team
        model.disguise = cls ? `Disguising as ${className(cls)}${t ? `, ${TEAM_NAME[t] ?? '?'}` : ''}` : 'Disguising'
      }
      break
    }
    case 3: // soldier
    case 7: { // pyro
      if (!local || !misc) break
      const loadout = x.meta.available.loadout ? loadoutAt(x, p, tick) : []
      const hasRageItem = classId === 3 ? loadout.some(d => BANNER_DEFS.has(d) || itemKind(d) === 'banner') : loadout.includes(PHLOG_DEF)
      if (hasRageItem || misc.rage > 0) model.rage = { label: classId === 3 ? 'BANNER' : 'MMMPH', pct: Math.min(1, misc.rage / 100) }
      break
    }
    case 4: { // demoman
      if (!local || !misc) break
      const loadout = x.meta.available.loadout ? loadoutAt(x, p, tick) : []
      if (misc.stickies > 0 || loadout.some(d => itemKind(d) === 'sticky_launcher')) model.stickies = misc.stickies
      break
    }
  }
  return model
}

// ─── view ─────────────────────────────────────────────────────────────────────

const Bar = ({ pct, color, className }: { pct: number; color: string; className?: string }) => (
  <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-white/15', className)}>
    <div className="h-full rounded-full" style={{ width: `${Math.round(Math.min(1, Math.max(0, pct)) * 100)}%`, background: color }} />
  </div>
)

const BUILDING_GLYPH: Record<number, string> = { 0: 'D', 1: 'T', 2: 'S' }

const BuildingLine = ({ b, team }: { b: BuildingRow; team: Team }) => {
  const hp = b.maxHealth > 0 ? b.health / b.maxHealth : 0
  const glyph = BUILDING_GLYPH[b.type] ?? '?'
  const arrow = b.type === 1 ? (b.mode === 1 ? '▼' : '▲') : ''
  return (
    <div
      data-hl="pov-building-row"
      className={cn('flex h-5 items-center gap-1.5 rounded px-1 text-[11px] leading-none', b.sapped && 'ring-1 ring-[#ff4b3e]', b.carried && 'opacity-60')}
    >
      <div className="flex h-4 w-6 shrink-0 items-center justify-center rounded-sm text-[10px] font-black text-white" style={{ background: TEAM_HUD[team] }}>
        {glyph}
        {arrow && <span className="ml-px text-[7px]">{arrow}</span>}
      </div>
      <div className="w-5 shrink-0 font-bold text-white/80">{b.mini ? 'M' : `L${b.level}`}</div>
      <Bar pct={b.building ? b.builtPct : hp} color={b.sapped ? '#ff4b3e' : b.building ? '#d9d9d9' : '#7cd67c'} className="flex-1" />
      <div className="w-[80px] shrink-0 truncate text-right font-semibold text-white/85">{b.sapped ? 'SAPPED' : b.detail}</div>
    </div>
  )
}

const hudTickOfRender = (renderTick: number, playing: boolean) => (playing ? renderTick - (renderTick % HUD_TICK_STEP) : renderTick)
const jsonEqual = <T,>(a: T, b: T) => a === b || JSON.stringify(a) === JSON.stringify(b)

export const PovWeaponHud = React.memo(() => {
  const enabled = useHlSetting<boolean>('pov.weaponHud')
  const extras = useExtras()
  const demo = useInstance(s => s.parsedDemo)
  const subject = usePovSubject(hudTickOfRender)
  // One model per hudTick; it renders when the model's display values change
  const last = useRef<{ tick: number; subject: PovSubject | null; model: WeaponHudModel | null } | null>(null)
  const model = useStoreValue(s => {
    if (!enabled || !extras || !demo || !subject) return null
    const hudTick = hudTickOfRender(renderTickOf(s.playback.tick), s.playback.playing)
    if (last.current && last.current.tick === hudTick && last.current.subject === subject) return last.current.model
    const next = weaponHudAt(extras, demo, subject, hudTick)
    last.current = { tick: hudTick, subject, model: next }
    return next
  }, jsonEqual)
  if (!model) return null
  const accent = TEAM_HUD[model.team]
  const glow = TEAM_FX[model.team]
  const hasBody = model.weapon || model.metal !== null || model.buildings || model.uber || model.cloak !== null || model.disguise || model.rage || model.stickies !== null || model.charge

  return (
    <div data-hl="pov-weapon-hud" data-hl-layout="pov-weapon-hud" className="flex w-[220px] flex-col items-stretch gap-1 text-white [text-shadow:0_0_3px_#000000]">
      {model.header && (
        <div
          className="self-end truncate rounded-lg bg-pp-panel/70 px-3 py-1 text-xs font-bold"
          style={{ borderLeft: `3px solid ${model.header.team ? TEAM_HUD[model.header.team] : '#888'}` }}
        >
          {model.header.text}
        </div>
      )}
      {hasBody && (
        <div className="overflow-hidden rounded-xl bg-pp-panel/70">
          {model.weapon && (
            <div className="flex items-end justify-between gap-2 px-3 pb-1 pt-2">
              <div className="min-w-0 truncate text-xs font-semibold text-white/85">{model.weapon.name}</div>
              {(model.weapon.clip !== null || model.weapon.reserve !== null) && (
                <div className="shrink-0 font-black leading-none">
                  {model.weapon.clip !== null && <span className="text-2xl">{model.weapon.clip}</span>}
                  {model.weapon.clip !== null && model.weapon.reserve !== null && <span className="text-sm text-white/60"> / </span>}
                  {model.weapon.reserve !== null && <span className={model.weapon.clip !== null ? 'text-sm text-white/80' : 'text-2xl'}>{model.weapon.reserve}</span>}
                </div>
              )}
            </div>
          )}
          <div className="flex flex-col gap-1 px-3 pb-2 pt-1 empty:hidden">
            {model.charge && (
              <div className="flex items-center gap-2 text-[11px] font-bold">
                <span className="w-12 text-white/70">{model.charge.label}</span>
                <Bar pct={model.charge.pct} color={glow} />
              </div>
            )}
            {model.uber && (
              <div className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between text-[11px] font-bold">
                  <span className={cn(model.uber.ready && 'animate-pulse text-[#ffe14d]')}>{model.uber.ready ? 'ÜBER READY' : 'ÜberCharge'}</span>
                  <span className="text-white/75">
                    {Math.floor(model.uber.pct * 100)}% {model.uber.type}
                    {model.uber.resist ? ` · ${model.uber.resist}` : ''}
                  </span>
                </div>
                <Bar pct={model.uber.pct} color={model.uber.ready ? '#ffe14d' : glow} />
              </div>
            )}
            {model.cloak !== null && (
              <div className="flex items-center gap-2 text-[11px] font-bold">
                <span className="w-12 text-white/70">Cloak</span>
                <Bar pct={model.cloak / 100} color="#c9d4e0" />
                <span className="w-7 text-right text-white/75">{Math.round(model.cloak)}</span>
              </div>
            )}
            {model.disguise && <div className="truncate text-[11px] font-semibold text-white/85">{model.disguise}</div>}
            {model.rage && (
              <div className="flex items-center gap-2 text-[11px] font-bold">
                <span className="w-12 text-white/70">{model.rage.label}</span>
                <Bar pct={model.rage.pct} color={model.rage.pct >= 1 ? '#ffe14d' : glow} />
              </div>
            )}
            {model.stickies !== null && (
              <div className="text-[11px] font-bold text-white/85">
                Stickies <span className="text-sm font-black text-white">{model.stickies}</span>
              </div>
            )}
            {model.metal !== null && (
              <div className="text-[11px] font-bold text-white/85">
                Metal <span className="text-sm font-black text-white">{model.metal}</span>
              </div>
            )}
            {model.buildings && model.buildings.length > 0 && (
              <div className="flex flex-col gap-0.5">
                {model.buildings.map((b, i) => (
                  <BuildingLine key={i} b={b} team={model.team} />
                ))}
              </div>
            )}
          </div>
          <div className="h-1 w-full" style={{ background: accent }} />
        </div>
      )}
    </div>
  )
})

// Probe: the weapon HUD values at a cache tick (default: the current renderTick), and whether the panel is in the DOM.
registerHlProbe('pov.hud', (tick?: number) => {
  const { extras, extrasStatus, parsedDemo } = useInstance.getState()
  const at = Math.floor(tick ?? Math.max(1, useStore.getState().playback.tick - 2))
  const subject = getPovSubject(at)
  const model = extrasStatus === 'ready' && extras && parsedDemo && subject ? weaponHudAt(extras, parsedDemo, subject, at) : null
  return { model, inDom: !!document.querySelector('[data-hl="pov-weapon-hud"]') }
})
