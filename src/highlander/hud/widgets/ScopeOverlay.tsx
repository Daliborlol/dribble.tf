// Sniper scope overlay (contract section 5 F4, ScopeOverlay; setting pov.scopeOverlay; POV only).
//
// Shown while the POV subject is zoomed (HL.ZOOMED) with a sniper rifle and the camera is his own or spectated eyes:
// black outside a centred circle of radius 46vh, thin reticle lines, and a vertical charge gauge (TF2's
// CHudScopeCharge) beside the centre. The overlay fades in with the zoom FOV transition: opacity
// clamp((90 - fov) / 70, 0, 1).
//
// The mask is portalled to document.body just below the HUD layers (z-index 1999999999 < .ui-layer 2e9 > drei Html
// nameplates), so the killfeed, player lists, playback bar and weapon HUD stay on top of the black, as in TF2.
// scopeActive (which hides the base Crosshair) is true for the whole zoom, from the tick the cond is set, so the
// game crosshair never shows through a scope that is still fading in.

import React, { useEffect } from 'react'
import { createPortal } from 'react-dom'

import { useInstance, useStore } from '@zus/store'
import { TEAM_HUD } from '@highlander/constants'
import { registerHlProbe } from '@highlander/debug'
import { HL } from '@highlander/extras/enums'
import { activeWeaponAt, flagsAt, hasLocalTables, sniperChargeAt } from '@highlander/extras/getters'
import { useExtras, useHlSetting } from '@highlander/extras/hooks'
import type { HighlanderExtras } from '@highlander/extras/types'
import { itemInfo } from '@highlander/items'
import { povFovAt } from '@highlander/pov/fov'
import { getPovSubject, usePovSubject, type PovSubject } from '@highlander/pov/subject'
import { dotsAt } from '@highlander/scene/layers/SniperLayer'

const SLEEPER_YELLOW = '#e8d34a'

export interface ScopeState { visible: boolean; opacity: number; fov: number; charge: number | null; sleeper: boolean; team: 'red' | 'blue' }

/** What the overlay shows for the subject at a cache tick; null when no scope is up. */
export function scopeStateAt(x: HighlanderExtras | undefined, subject: PovSubject | null, tick: number): ScopeState | null {
  if (!x || !subject || subject.p < 0) return null
  if (subject.camera !== 'own' && subject.camera !== 'spectated') return null
  if ((flagsAt(x, subject.p, tick) & HL.ZOOMED) === 0) return null
  const demo = useInstance.getState().parsedDemo
  const meta = demo ? demo.playerCache.metaCache.getMeta(subject.p, tick) : { classId: 2, teamId: 2 }
  const weapon = activeWeaponAt(x, subject.p, tick, meta.classId)
  if (!weapon || weapon.kind !== 'sniper_rifle') return null
  // The camera's zoom (povFovAt), so the overlay fades exactly with the FOV the scene shows
  const fov = x.meta.available.fov ? povFovAt(x, subject.p, tick, 90) : 20
  const opacity = Math.min(1, Math.max(0, (90 - fov) / 70))
  let charge: number | null = null
  if (x.meta.available.sniper && hasLocalTables(x, subject.p)) {
    charge = sniperChargeAt(x, subject.p, tick)
  } else {
    // Without local tables: the subject's own dot carries the charge start time
    const dot = dotsAt(x, tick).find(d => d.owner === subject.p && !d.laser)
    if (dot && !Number.isNaN(dot.chargeTick)) charge = Math.min(150, Math.max(0, (tick - dot.chargeTick) * x.meta.intervalPerTick * 50))
  }
  return {
    visible: true,
    opacity,
    fov,
    charge,
    sleeper: itemInfo(weapon.def)?.weaponMode === 1,
    team: meta.teamId === 3 ? 'blue' : 'red',
  }
}

export const ScopeOverlay = React.memo(({ renderTick }: { renderTick: number }) => {
  const enabled = useHlSetting<boolean>('pov.scopeOverlay')
  const extras = useExtras()
  const subject = usePovSubject(renderTick)
  const scope = enabled ? scopeStateAt(extras, subject, renderTick) : null
  const active = !!scope

  useEffect(() => {
    useInstance.getState().setScopeActive(active)
  }, [active])
  useEffect(() => () => useInstance.getState().setScopeActive(false), [])

  if (!scope || scope.opacity <= 0) return null
  const fill = scope.charge === null ? null : Math.min(1, scope.charge / 150)
  const gaugeColor = scope.sleeper ? SLEEPER_YELLOW : TEAM_HUD[scope.team]
  const line = 'rgba(0, 0, 0, 0.85)'

  return createPortal(
    <div
      data-hl="scope-overlay"
      className="pointer-events-none fixed inset-0"
      style={{ zIndex: 1999999999, opacity: scope.opacity }}
    >
      {/* Lens: clear centre, darkening rim, black outside the 46vh circle */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(circle at 50% 50%, rgba(0,0,0,0) 0, rgba(0,0,0,0) 36vh, rgba(0,0,0,0.28) 44.5vh, rgba(0,0,0,0.9) 45.8vh, #000 46vh)',
        }}
      />
      {/* Reticle: 1 px lines across the circle, thicker posts toward the rim */}
      <div className="absolute left-1/2 top-1/2" style={{ width: '92vh', height: 1, marginLeft: '-46vh', background: line }} />
      <div className="absolute left-1/2 top-1/2" style={{ height: '92vh', width: 1, marginTop: '-46vh', background: line }} />
      <div className="absolute top-1/2" style={{ left: 'calc(50% - 46vh)', width: '30vh', height: 4, marginTop: -2, background: line }} />
      <div className="absolute top-1/2" style={{ left: 'calc(50% + 16vh)', width: '30vh', height: 4, marginTop: -2, background: line }} />
      <div className="absolute left-1/2" style={{ top: 'calc(50% + 16vh)', height: '30vh', width: 4, marginLeft: -2, background: line }} />
      {/* Charge gauge right of the centre */}
      {fill !== null && (
        <div className="absolute" style={{ left: 'calc(50% + 6vh)', top: 'calc(50% - 9vh)', height: '18vh', width: '0.8vh' }}>
          <div className="absolute inset-0 rounded-sm" style={{ background: 'rgba(0,0,0,0.55)', boxShadow: '0 0 0 1px rgba(0,0,0,0.8)' }} />
          <div
            className="absolute bottom-0 left-0 right-0 rounded-sm"
            style={{ height: `${(fill * 100).toFixed(1)}%`, background: gaugeColor, boxShadow: `0 0 6px ${gaugeColor}` }}
          />
          <div
            className="absolute whitespace-nowrap font-bold text-white"
            style={{ left: '1.6vh', bottom: `calc(${(fill * 100).toFixed(1)}% - 0.8em)`, fontSize: '1.7vh', textShadow: '0 0 3px #000, 0 0 2px #000' }}
          >
            {Math.round(fill * 100)}%
          </div>
        </div>
      )}
    </div>,
    document.body
  )
})

// Probe: the scope overlay state at a cache tick (default: the current renderTick), plus whether the base crosshair
// is in the DOM right now.
registerHlProbe('scope.state', (tick?: number) => {
  const { extras, extrasStatus, scopeActive } = useInstance.getState()
  const at = Math.floor(tick ?? Math.max(1, useStore.getState().playback.tick - 2))
  const s = scopeStateAt(extrasStatus === 'ready' ? extras : undefined, getPovSubject(at), at)
  const r = (v: number) => Math.round(v * 1000) / 1000
  return {
    visible: !!s,
    opacity: s ? r(s.opacity) : 0,
    fov: s ? r(s.fov) : null,
    charge: s?.charge ?? null,
    sleeper: s?.sleeper ?? false,
    scopeActive,
    overlayInDom: !!document.querySelector('[data-hl="scope-overlay"]'),
  }
})
