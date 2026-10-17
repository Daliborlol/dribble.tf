// Medic panel (contract section 5 F5): one 30 px row per medic under each team column (at most two). Medigun
// type, the charge as a bar, the state BUILDING / READY / ACTIVE with seconds left, the uber advantage on the
// leading team when both medics live, and the time since this team's last uber. Values come from the HUD
// snapshot (MedicRow); this component calls no getter.
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

export const MedicPanel = React.memo(({ medic: m, showName }: { medic: MedicRow; showName: boolean }) => {
  const color = m.team === 'red' ? TEAM_HUD.red : TEAM_HUD.blue
  const mirrored = m.team === 'red'
  const pct = Math.floor(m.charge * 100 + 1e-6)
  const state =
    m.state === 'ACTIVE'
      ? `ACTIVE ${m.secondsLeft !== null ? `${m.secondsLeft.toFixed(1)}s` : ''}`
      : m.state === 'READY'
        ? m.vacc
          ? `READY x${m.vacc.charges}`
          : 'READY'
        : m.state === 'DEAD'
          ? m.respawn !== null
            ? `DEAD ${m.respawn}`
            : 'DEAD'
          : `${pct}%`
  const title = [
    `${m.name}: ${m.typeName}${m.known ? '' : ' (type unknown)'}`,
    `${pct} % ${m.state.toLowerCase()}`,
    m.advantage ? `advantage +${m.advantage} %` : null,
    m.lastUberAgo !== null ? `last uber ${formatAgo(m.lastUberAgo)} ago` : 'no uber yet',
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <div
      title={title}
      className="relative flex shrink-0 select-none items-center overflow-hidden rounded-[3px] px-[6px] text-[12px] font-semibold leading-none text-white"
      style={{
        height: HUD_LAYOUT.medicRowHeight,
        width: HUD_LAYOUT.rowWidth,
        background: m.state === 'DEAD' ? '#2a2a2a' : 'rgb(18 18 18 / 0.9)',
        flexDirection: mirrored ? 'row-reverse' : 'row',
        boxShadow: m.state === 'READY' ? 'inset 0 0 0 1px #ffd23f' : m.state === 'ACTIVE' ? 'inset 0 0 0 1px #9df5ff' : undefined,
      }}
    >
      {/* charge fill */}
      <div
        className="absolute inset-y-0"
        style={{ [mirrored ? 'right' : 'left']: 0, width: `${Math.min(100, pct)}%`, background: color, opacity: m.state === 'ACTIVE' ? 0.95 : 0.6 }}
      />

      <div className={`relative flex min-w-0 flex-1 items-center gap-[5px] ${mirrored ? 'flex-row-reverse' : ''}`}>
        <span className="truncate font-bold [text-shadow:0_1px_1px_rgb(0_0_0_/_0.7)]">{showName ? m.name : m.typeName}</span>
        {m.vacc && <ResistIcon resist={m.vacc.resist} size={13} />}
      </div>

      <div className={`relative flex shrink-0 items-center gap-[6px] ${mirrored ? 'flex-row-reverse' : ''}`}>
        {m.advantage ? <span className="text-[11px] font-bold text-[#9dff80] [text-shadow:0_1px_1px_rgb(0_0_0_/_0.8)]">+{m.advantage}%</span> : null}
        {m.lastUberAgo !== null && m.state !== 'ACTIVE' && m.state !== 'DEAD' && (
          <span className="text-[10px] font-semibold text-white/75 [text-shadow:0_1px_1px_rgb(0_0_0_/_0.8)]" title="time since this team's last uber">
            popped {formatAgo(m.lastUberAgo)} ago
          </span>
        )}
        <span className="text-[12px] font-bold tabular-nums [text-shadow:0_1px_1px_rgb(0_0_0_/_0.8)]" style={{ color: STATE_COLOR[m.state] }}>
          {state}
        </span>
      </div>
    </div>
  )
})
