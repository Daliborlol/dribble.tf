// Medic panel (contract section 5 F5): one 30 px row per medic under each team column (at most two). Medigun
// type, the charge as a bar, the state BUILDING / READY / ACTIVE with seconds left, the uber advantage on the
// leading team when both medics live, and the time since this team's last uber. Values come from the HUD
// snapshot (MedicRow); this component calls no getter.
//
// Two lines: the type (or, when a team has two medics, the medic's name and a type letter), the advantage and
// the state on top; "popped m:ss ago" below it in smaller text, so the state word fits next to the advantage in
// the 232 px row.
//
// Seconds left while releasing: charge x 8 for stock, Kritzkrieg and Quick-Fix. The Vaccinator shows its ready
// charges (25 % each), the selected resist, and 3 s from the onset of its resist uber while it runs.

import React from 'react'

import { TEAM_HUD } from '@highlander/constants'
import type { MedicRow } from '@highlander/hud/hudSnapshot'
import { formatAgo } from '@highlander/objectives/format'
import { ResistIcon } from '@highlander/objectives/glyphs'
import { HUD_LAYOUT } from '@highlander/objectives/layout'

const STATE_COLOR: Record<MedicRow['state'], string> = {
  BUILDING: '#e5e7eb',
  READY: '#ffe36e',
  ACTIVE: '#9df5ff',
  DEAD: '#9ca3af',
}

const SHADOW = '[text-shadow:0_1px_1px_rgb(0_0_0_/_0.8)]'

/** The state word and its value: BUILDING 47%, READY (x3 on the Vaccinator), ACTIVE 7.5s, DEAD 12. */
function stateParts(m: MedicRow, pct: number): [string, string | null] {
  switch (m.state) {
    case 'ACTIVE':
      return ['ACTIVE', m.secondsLeft !== null ? `${m.secondsLeft.toFixed(1)}s` : null]
    case 'READY':
      return ['READY', m.vacc ? `x${m.vacc.charges}` : null]
    case 'DEAD':
      return ['DEAD', m.respawn !== null ? `${m.respawn}` : null]
    default:
      return ['BUILDING', `${pct}%`]
  }
}

export const MedicPanel = React.memo(({ medic: m, showName }: { medic: MedicRow; showName: boolean }) => {
  const color = m.team === 'red' ? TEAM_HUD.red : TEAM_HUD.blue
  const mirrored = m.team === 'red'
  const pct = Math.floor(m.charge * 100 + 1e-6)
  const [word, value] = stateParts(m, pct)
  const popped = m.lastUberAgo !== null && m.state !== 'ACTIVE' && m.state !== 'DEAD' ? formatAgo(m.lastUberAgo) : null
  const title = [
    `${m.name}: ${m.typeName}${m.known ? '' : ' (type unknown)'}`,
    `${word}${value !== null ? ` ${value}` : ''}${m.state !== 'BUILDING' ? ` (${pct} %)` : ''}`,
    m.advantage ? `advantage +${m.advantage} %` : null,
    m.lastUberAgo !== null ? `last uber ${formatAgo(m.lastUberAgo)} ago` : 'no uber yet',
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <div
      title={title}
      className="relative flex shrink-0 select-none flex-col justify-center gap-[2px] overflow-hidden rounded-[3px] px-[6px] font-semibold leading-none text-white"
      style={{
        height: HUD_LAYOUT.medicRowHeight,
        width: HUD_LAYOUT.rowWidth,
        background: m.state === 'DEAD' ? '#2a2a2a' : 'rgb(18 18 18 / 0.9)',
        boxShadow: m.state === 'READY' ? 'inset 0 0 0 1px #ffd23f' : m.state === 'ACTIVE' ? 'inset 0 0 0 1px #9df5ff' : undefined,
      }}
    >
      {/* charge fill */}
      <div
        className="absolute inset-y-0"
        style={{ [mirrored ? 'right' : 'left']: 0, width: `${Math.min(100, pct)}%`, background: color, opacity: m.state === 'ACTIVE' ? 0.95 : 0.6 }}
      />

      <div className={`relative flex items-center gap-[6px] text-[12px] ${mirrored ? 'flex-row-reverse' : ''}`}>
        <div className={`flex min-w-0 flex-1 items-center gap-[4px] ${mirrored ? 'flex-row-reverse' : ''}`}>
          <span className={`truncate font-bold ${SHADOW}`}>{showName ? m.name : m.typeName}</span>
          {showName && m.known && (
            <span className="shrink-0 rounded-[2px] bg-black/45 px-[3px] py-[1px] text-[10px] font-bold" title={m.typeName}>
              {m.typeLetter}
            </span>
          )}
          {m.vacc && <ResistIcon resist={m.vacc.resist} size={13} />}
        </div>
        {m.advantage ? <span className={`shrink-0 text-[11px] font-bold text-[#9dff80] ${SHADOW}`}>+{m.advantage}%</span> : null}
        <span className={`flex shrink-0 items-baseline gap-[3px] font-bold tabular-nums ${SHADOW}`} style={{ color: STATE_COLOR[m.state] }}>
          {value !== null ? (
            <>
              <span className="text-[10px] tracking-[0.02em] opacity-90">{word}</span>
              <span>{value}</span>
            </>
          ) : (
            word
          )}
        </span>
      </div>

      {popped && (
        <div className={`relative flex text-[10px] font-semibold text-white/80 ${SHADOW} ${mirrored ? 'justify-end' : ''}`}>
          popped {popped} ago
        </div>
      )}
    </div>
  )
})
