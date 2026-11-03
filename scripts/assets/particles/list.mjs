// The particle systems the `particles` stage exports (as/particles). Names only: every value of a system comes
// from the user's own .pcf files and stays in the pack (D19). The runtime picks among these by name.

/** .pcf files read, in the order TF2's particles_manifest.txt loads them (a later file never overrides here). */
export const PCF_FILES = [
  'particles/explosion.pcf',
  'particles/flamethrower.pcf',
  'particles/rockettrail.pcf',
  'particles/stickybomb.pcf',
  'particles/muzzle_flash.pcf',
  'particles/bullet_tracers.pcf',
]

/** Root systems; their children are added recursively. */
export const ROOT_SYSTEMS = [
  // TFExplosionCallback: weapon script effects (wall, player/mid-air), flare guns, building and sapper deaths
  'ExplosionCore_Wall',
  'ExplosionCore_MidAir',
  'ExplosionCore_MidAir_Flare',
  'ExplosionCore_buildings',
  // C_TFFlameThrower: the stream, per team, and the crit streams
  'flamethrower',
  'flamethrower_blue',
  'flamethrower_crit_red',
  'flamethrower_crit_blue',
  // C_TFProjectile_Rocket and C_TFGrenadePipebombProjectile trails, plus the crit layers they add
  'rockettrail',
  'critical_rocket_red',
  'critical_rocket_blue',
  'pipebombtrail_red',
  'pipebombtrail_blue',
  'critical_pipe_red',
  'critical_pipe_blue',
  'stickybombtrail_red',
  'stickybombtrail_blue',
  'critical_grenade_red',
  'critical_grenade_blue',
]
