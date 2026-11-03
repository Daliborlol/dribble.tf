// src/highlander/settings.ts
export interface HighlanderSettings {
  enabled: boolean
  players: {
    conditions: boolean; fxUber: boolean; fxCrit: boolean; fxDebuffs: boolean; fxOverheal: boolean
    cloak: boolean; cloakFloor: number; disguiseView: 'auto' | 'true' | 'enemy' | 'pov'
    nameplateExtras: boolean; nameplateWeapon: boolean; nameplateFadeDistance: number
    /** as/shading: team-coloured glow of players behind walls (key X) */
    xrayGlow: boolean
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
  /** as/tflook: the view-style toggles; VIEW_PRESETS writes them together with a few older keys */
  view: {
    /** which players get nameplates: 'all' (the nearest 12 plus the exempt ones), 'focus' (followed, hovered, POV teammates) */
    plates: 'all' | 'focus'
    /** nameplate tags: 'always', 'brief' (2 s after the state starts), 'off' */
    plateTags: 'always' | 'brief' | 'off'
    /** building status labels: 'all', or 'focus' (the followed engineer's and the hovered building's) */
    buildingLabels: 'all' | 'focus'
    /** heal beam width and wave factor */
    healBeamScale: number
    /** control point discs: 'full' or 'subtle' (smaller, translucent) */
    objectiveMarkers: 'full' | 'subtle'
    /** taken kits' ghost box and respawn ring */
    respawnRings: boolean
    /** the 9v9 player columns (or the old player list) */
    playerColumns: boolean
    /** the playback bar and the side toolbar fade out while playing and the mouse is idle */
    autoHideControls: boolean
  }
}

export const DEFAULT_HIGHLANDER_SETTINGS: HighlanderSettings = {
  enabled: true,
  players: {
    conditions: true, fxUber: true, fxCrit: true, fxDebuffs: true, fxOverheal: false,
    cloak: true, cloakFloor: 0.15, disguiseView: 'auto',
    nameplateExtras: true, nameplateWeapon: true, nameplateFadeDistance: 0,
    xrayGlow: false,
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
  view: {
    plates: 'all', plateTags: 'always', buildingLabels: 'all', healBeamScale: 1, objectiveMarkers: 'full',
    respawnRings: true, playerColumns: true, autoHideControls: false,
  },
}

/** Effects presets: the select writes these keys; it shows "Custom" when the current values match none. */
export const EFFECT_PRESETS = {
  minimal:    { 'players.fxUber': true, 'players.fxCrit': false, 'players.fxDebuffs': false, 'players.fxOverheal': false, 'projectiles.tracers': false },
  standard:   { 'players.fxUber': true, 'players.fxCrit': true,  'players.fxDebuffs': true,  'players.fxOverheal': false, 'projectiles.tracers': true },
  everything: { 'players.fxUber': true, 'players.fxCrit': true,  'players.fxDebuffs': true,  'players.fxOverheal': true,  'projectiles.tracers': true },
} as const

/**
 * View styles (as/tflook): the select writes these settings (paths from the settings root); it shows "Custom" when
 * the current values match none. 'analysis' equals the defaults.
 */
export const VIEW_PRESETS = {
  analysis: {
    'highlander.view.plates': 'all', 'highlander.view.plateTags': 'always', 'ui.nameplate.showClass': true,
    'ui.nameplate.showHealth': true, 'highlander.players.nameplateWeapon': true, 'highlander.view.buildingLabels': 'all',
    'highlander.sniper.beams': true, 'highlander.view.healBeamScale': 1, 'highlander.view.objectiveMarkers': 'full',
    'highlander.view.respawnRings': true, 'highlander.map.deathMarkers': true, 'highlander.view.playerColumns': true,
    'highlander.hud.timelineMarkers': true, 'highlander.view.autoHideControls': false,
  },
  tf2: {
    'highlander.view.plates': 'focus', 'highlander.view.plateTags': 'brief', 'ui.nameplate.showClass': false,
    'ui.nameplate.showHealth': true, 'highlander.players.nameplateWeapon': false, 'highlander.view.buildingLabels': 'focus',
    'highlander.sniper.beams': false, 'highlander.view.healBeamScale': 0.45, 'highlander.view.objectiveMarkers': 'subtle',
    'highlander.view.respawnRings': false, 'highlander.map.deathMarkers': false, 'highlander.view.playerColumns': false,
    'highlander.hud.timelineMarkers': false, 'highlander.view.autoHideControls': true,
  },
} as const

export type ViewStyle = keyof typeof VIEW_PRESETS
