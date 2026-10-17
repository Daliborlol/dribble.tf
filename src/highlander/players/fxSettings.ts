// The settings F1 reads (contract sections 5 F1 and 6.3), as one flat object of primitives.
// React code builds it from useHlSetting selectors (rule 4: selectors return primitives); useFrame callbacks and
// probes read it from the store with readFxSettings().

import { useMemo } from 'react'

import { getState } from '@zus/store'
import { useHlSetting } from '@highlander/extras/hooks'
import { DEFAULT_HIGHLANDER_SETTINGS, type HighlanderSettings } from '@highlander/settings'

export type DisguiseViewSetting = HighlanderSettings['players']['disguiseView']

export interface FxSettings {
  /** settings.highlander.enabled */
  enabled: boolean
  /** players.conditions: master toggle of the four effect groups (not of cloak and disguise) */
  conditions: boolean
  fxUber: boolean
  fxCrit: boolean
  fxDebuffs: boolean
  fxOverheal: boolean
  cloak: boolean
  cloakFloor: number
  disguiseView: DisguiseViewSetting
  nameplateExtras: boolean
  nameplateWeapon: boolean
}

const D = DEFAULT_HIGHLANDER_SETTINGS.players

const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback)
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const view = (v: unknown): DisguiseViewSetting =>
  v === 'auto' || v === 'true' || v === 'enemy' || v === 'pov' ? v : D.disguiseView

function build(
  enabled: unknown, conditions: unknown, fxUber: unknown, fxCrit: unknown, fxDebuffs: unknown, fxOverheal: unknown,
  cloak: unknown, cloakFloor: unknown, disguiseView: unknown, nameplateExtras: unknown, nameplateWeapon: unknown
): FxSettings {
  return {
    enabled: bool(enabled, DEFAULT_HIGHLANDER_SETTINGS.enabled),
    conditions: bool(conditions, D.conditions),
    fxUber: bool(fxUber, D.fxUber),
    fxCrit: bool(fxCrit, D.fxCrit),
    fxDebuffs: bool(fxDebuffs, D.fxDebuffs),
    fxOverheal: bool(fxOverheal, D.fxOverheal),
    cloak: bool(cloak, D.cloak),
    cloakFloor: Math.min(1, Math.max(0, num(cloakFloor, D.cloakFloor))),
    disguiseView: view(disguiseView),
    nameplateExtras: bool(nameplateExtras, D.nameplateExtras),
    nameplateWeapon: bool(nameplateWeapon, D.nameplateWeapon),
  }
}

/** The current settings, for non-React code (useFrame callbacks, probes). */
export function readFxSettings(): FxSettings {
  const hl = getState().settings.highlander
  const pl = hl?.players
  return build(
    hl?.enabled, pl?.conditions, pl?.fxUber, pl?.fxCrit, pl?.fxDebuffs, pl?.fxOverheal,
    pl?.cloak, pl?.cloakFloor, pl?.disguiseView, pl?.nameplateExtras, pl?.nameplateWeapon
  )
}

/** The same values through primitive selectors; the returned object changes only when a value changes. */
export function useFxSettings(): FxSettings {
  const enabled = useHlSetting<boolean>('enabled')
  const conditions = useHlSetting<boolean>('players.conditions')
  const fxUber = useHlSetting<boolean>('players.fxUber')
  const fxCrit = useHlSetting<boolean>('players.fxCrit')
  const fxDebuffs = useHlSetting<boolean>('players.fxDebuffs')
  const fxOverheal = useHlSetting<boolean>('players.fxOverheal')
  const cloak = useHlSetting<boolean>('players.cloak')
  const cloakFloor = useHlSetting<number>('players.cloakFloor')
  const disguiseView = useHlSetting<DisguiseViewSetting>('players.disguiseView')
  const nameplateExtras = useHlSetting<boolean>('players.nameplateExtras')
  const nameplateWeapon = useHlSetting<boolean>('players.nameplateWeapon')

  return useMemo(
    () =>
      build(enabled, conditions, fxUber, fxCrit, fxDebuffs, fxOverheal, cloak, cloakFloor, disguiseView, nameplateExtras, nameplateWeapon),
    [enabled, conditions, fxUber, fxCrit, fxDebuffs, fxOverheal, cloak, cloakFloor, disguiseView, nameplateExtras, nameplateWeapon]
  )
}
