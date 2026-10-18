// The settings F1 reads (contract sections 5 F1 and 6.3), as one flat object of primitives.
// React code reads it with useFxSettings (rule 4: the selector returns a primitive); useFrame callbacks and probes
// read it from the store with readFxSettings().
//
// X1: one selector per actor instead of twelve. The selector encodes the twelve values into one string key, and a
// small cache keyed by that string hands every actor the same FxSettings object for the same values (built from
// the key alone, never from a store snapshot), so the object changes only when a value changes.

import { useMemo } from 'react'

import { getState, useStore } from '@zus/store'
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
  /** settings.ui.nameplate.enabled: the plates cover the space above the heads, so overhead effects move below them */
  nameplates: boolean
}

const D = DEFAULT_HIGHLANDER_SETTINGS.players

const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback)
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const view = (v: unknown): DisguiseViewSetting =>
  v === 'auto' || v === 'true' || v === 'enemy' || v === 'pov' ? v : D.disguiseView

function build(
  enabled: unknown, conditions: unknown, fxUber: unknown, fxCrit: unknown, fxDebuffs: unknown, fxOverheal: unknown,
  cloak: unknown, cloakFloor: unknown, disguiseView: unknown, nameplateExtras: unknown, nameplateWeapon: unknown,
  nameplates: unknown
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
    nameplates: bool(nameplates, true),
  }
}

type StoreSettings = ReturnType<typeof getState>['settings']

/** One character per boolean ('1', '0', '-' for anything else), the number and the view as text. */
const b = (v: unknown) => (v === true ? '1' : v === false ? '0' : '-')
const n = (v: unknown) => (typeof v === 'number' ? String(v) : '')
const s = (v: unknown) => (typeof v === 'string' ? v : '')

/** The twelve values as one primitive (the store selector's result). */
export function fxSettingsKey(settings: StoreSettings): string {
  const hl = settings.highlander
  const pl = hl?.players
  return (
    b(hl?.enabled) + b(pl?.conditions) + b(pl?.fxUber) + b(pl?.fxCrit) + b(pl?.fxDebuffs) + b(pl?.fxOverheal) +
    b(pl?.cloak) + b(pl?.nameplateExtras) + b(pl?.nameplateWeapon) + b(settings.ui?.nameplate?.enabled) +
    '|' + n(pl?.cloakFloor) + '|' + s(pl?.disguiseView)
  )
}

const unb = (c: string) => (c === '1' ? true : c === '0' ? false : undefined)
const cache = new Map<string, FxSettings>()

/** The FxSettings of a key, shared by every caller with the same key. */
function fromKey(key: string): FxSettings {
  const hit = cache.get(key)
  if (hit) return hit
  const [flags, floor, disguiseView] = key.split('|')
  const at = (i: number) => unb(flags.charAt(i))
  const value = build(at(0), at(1), at(2), at(3), at(4), at(5), at(6), floor === '' ? undefined : Number(floor), disguiseView, at(7), at(8), at(9))
  if (cache.size >= 32) cache.clear()
  cache.set(key, value)
  return value
}

/** The current settings, for non-React code (useFrame callbacks, probes). */
export function readFxSettings(): FxSettings {
  return fromKey(fxSettingsKey(getState().settings))
}

/** The same values through one primitive selector; the returned object changes only when a value changes. */
export function useFxSettings(): FxSettings {
  const key = useStore(state => fxSettingsKey(state.settings))
  return useMemo(() => fromKey(key), [key])
}
