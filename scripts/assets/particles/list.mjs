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
  'particles/medicgun_beam.pcf',
  'particles/firstperson_weapon_fx.pcf',
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
  // weapon scripts' MuzzleFlashParticleEffect (as/particles2): one per hitscan or launcher weapon kind
  'muzzle_scattergun',
  'muzzle_shotgun',
  'muzzle_pistol',
  'muzzle_smg',
  'muzzle_revolver',
  'muzzle_sniperrifle',
  'muzzle_minigun_constant',
  'muzzle_syringe',
  'muzzle_grenadelauncher',
  'muzzle_pipelauncher',
  // weapon scripts' TracerEffect, per team and crit (FX_FireBullets appends _red/_blue and _crit)
  'bullet_tracer01_red',
  'bullet_tracer01_blue',
  'bullet_tracer01_red_crit',
  'bullet_tracer01_blue_crit',
  'bullet_scattergun_tracer01_red',
  'bullet_scattergun_tracer01_blue',
  'bullet_scattergun_tracer01_red_crit',
  'bullet_scattergun_tracer01_blue_crit',
  'bullet_shotgun_tracer01_red',
  'bullet_shotgun_tracer01_blue',
  'bullet_shotgun_tracer01_red_crit',
  'bullet_shotgun_tracer01_blue_crit',
  'bullet_pistol_tracer01_red',
  'bullet_pistol_tracer01_blue',
  'bullet_pistol_tracer01_red_crit',
  'bullet_pistol_tracer01_blue_crit',
  // C_TFFlameThrower airblast
  'pyro_blast',
  // C_WeaponMedigun full charge, and C_TFPlayer's crit-boost effect on the active weapon
  'medicgun_invulnstatus_fullcharge_red',
  'medicgun_invulnstatus_fullcharge_blue',
  'critgun_weaponmodel_red',
  'critgun_weaponmodel_blu',
]
