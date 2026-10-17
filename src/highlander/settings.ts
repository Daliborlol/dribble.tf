// src/highlander/settings.ts
export interface HighlanderSettings {
  enabled: boolean
  players: {
    conditions: boolean; fxUber: boolean; fxCrit: boolean; fxDebuffs: boolean; fxOverheal: boolean
    cloak: boolean; cloakFloor: number; disguiseView: 'auto' | 'true' | 'enemy' | 'pov'
    nameplateExtras: boolean; nameplateWeapon: boolean; nameplateFadeDistance: number
  }
  buildings: { enabled: boolean; labels: boolean; sentryRange: boolean; blueprints: boolean }
  projectiles: { extraTypes: boolean; critGlow: boolean; explosions: boolean; tracers: boolean; flames: boolean; airblast: boolean }
  sniper: { dots: boolean; beams: boolean }
  pov: { viewmodel: boolean; viewmodelFov: number; minimalViewmodel: boolean; tf2Fov: boolean; eyeHeight: boolean; scopeOverlay: boolean; weaponHud: boolean; deadPov: 'stay' | 'spectated'; chase: boolean }
  hud: {
    objective: boolean; compactStatuses: boolean; statusBadges: boolean; medicPanel: boolean; scoreboard: boolean; roundBanner: boolean
    killfeedMaxLines: number; killfeedFeignDeaths: boolean; killfeedObjectives: boolean
    timelineMarkers: boolean; timelineMedic: boolean; timelineObjective: boolean; timelineSpy: boolean; timelineEngineer: boolean
    damageNumbers: boolean
  }
  map: { movers: boolean; pickups: boolean; respawnVisualizers: boolean; brightness: number; fog: boolean; deathMarkers: boolean; drops: boolean; staticProps: boolean }
}

export const DEFAULT_HIGHLANDER_SETTINGS: HighlanderSettings = {
  enabled: true,
  players: {
    conditions: true, fxUber: true, fxCrit: true, fxDebuffs: true, fxOverheal: false,
    cloak: true, cloakFloor: 0.15, disguiseView: 'auto',
    nameplateExtras: true, nameplateWeapon: true, nameplateFadeDistance: 0,
  },
  buildings: { enabled: true, labels: true, sentryRange: false, blueprints: true },
  projectiles: { extraTypes: true, critGlow: true, explosions: true, tracers: true, flames: true, airblast: true },
  sniper: { dots: true, beams: true },
  pov: { viewmodel: true, viewmodelFov: 70, minimalViewmodel: false, tf2Fov: true, eyeHeight: true, scopeOverlay: true, weaponHud: true, deadPov: 'spectated', chase: false },
  hud: {
    objective: true, compactStatuses: true, statusBadges: true, medicPanel: true, scoreboard: true, roundBanner: true,
    killfeedMaxLines: 6, killfeedFeignDeaths: false, killfeedObjectives: true,
    timelineMarkers: true, timelineMedic: true, timelineObjective: true, timelineSpy: false, timelineEngineer: false,
    damageNumbers: false,
  },
  map: { movers: true, pickups: true, respawnVisualizers: false, brightness: 1, fog: false, deathMarkers: true, drops: true, staticProps: true },
}

/** Effects presets: the select writes these keys; it shows "Custom" when the current values match none. */
export const EFFECT_PRESETS = {
  minimal:    { 'players.fxUber': true, 'players.fxCrit': false, 'players.fxDebuffs': false, 'players.fxOverheal': false, 'projectiles.tracers': false },
  standard:   { 'players.fxUber': true, 'players.fxCrit': true,  'players.fxDebuffs': true,  'players.fxOverheal': false, 'projectiles.tracers': true },
  everything: { 'players.fxUber': true, 'players.fxCrit': true,  'players.fxDebuffs': true,  'players.fxOverheal': true,  'projectiles.tracers': true },
} as const
