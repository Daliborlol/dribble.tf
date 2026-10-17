export const TEAM_HUD = { red: '#b8383b', blue: '#5885a2' }      // HUD panels, bars, text
export const TEAM_FX = { red: '#ff4b3e', blue: '#4ba3ff' }       // glows, auras, dots, beams, tracers (crit)
export const TEAM_DARK = { red: '#6e2224', blue: '#2f4a5c' }     // placeholder bodies
export const TEAM_TRAIL = { red: '#cf4a2e', blue: '#5885a2' }    // same as Projectiles.tsx TEAM_COLORS
export const NEUTRAL = '#8a8a8a'
export const METAL = '#4a4a4a'
export const DARK_METAL = '#2b2b2b'
export const CLOAK_TINT = { red: [1.0, 0.5, 0.4], blue: [0.4, 0.5, 1.0] } as const
export const EYE_HEIGHT: Record<number, number> = { 1: 65, 2: 75, 3: 68, 4: 68, 5: 75, 6: 75, 7: 68, 8: 75, 9: 68 }
export const DUCK_EYE_HEIGHT = 45
export const LEGACY_EYE_HEIGHT = 83                               // ActorDimensions.z
export const HULL = { width: 48, height: 82, duckHeight: 62 }
export const HUD_TICK_STEP = 3                                    // section 1.6 rule 10
export const HEAL_BEAM_OFFSET = 41.5                              // HealBeam adds this to both ends (BEAM_HEIGHT_OFFSET)
export const teamKey = (team: number) => (team === 2 ? 'red' : team === 3 ? 'blue' : null)
