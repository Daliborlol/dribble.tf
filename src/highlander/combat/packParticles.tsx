// TF2 particle effects from the asset pack (as/particles): the always-loaded part. PackParticlesLayer imports the
// evaluator, the renderer and the effect selection (packParticlesDraw.tsx) only once a ready pack lists
// `particles/systems` and assets.particles is on, so pages without a pack load and request nothing new (D21).
// While the particles draw, the placeholders they replace stand down (packParticlesDrawing, packDraws).

import React, { Suspense, lazy } from 'react'

import type { AsyncParser } from '@components/Analyse/Data/AsyncParser'
import type { HighlanderExtras } from '@highlander/extras/types'
import { usePackParticlesWanted } from '@pack/particles/load'

interface Drawing {
  ready: boolean
  /** systems the loaded definitions hold */
  systems: { has(name: string): boolean }
}
let drawing: Drawing | null = null

/** True while the pack particle layer is mounted with its definitions and textures ready. */
export function packParticlesDrawing(): boolean {
  return !!drawing && drawing.ready
}

/** True while the pack particles draw and their definitions hold system `name` (older packs lack the newer ones). */
export function packDraws(name: string | null | undefined): boolean {
  return !!name && !!drawing && drawing.ready && drawing.systems.has(name)
}

/** Set by the mounted renderer; `owner` clears only when it is still the current one. */
export function setPackParticleRenderer(renderer: Drawing | null, owner?: Drawing): void {
  if (renderer || !owner || drawing === owner) drawing = renderer
}

/**
 * MuzzleFlashParticleEffect of the weapon scripts, by items.ts weapon kind (rocket launchers have none here); the
 * minigun's is C_TFMinigun's looping muzzle_minigun_constant, played over each firing run.
 */
export const MUZZLE_SYSTEMS: Record<string, string> = {
  scattergun: 'muzzle_scattergun',
  shotgun: 'muzzle_shotgun',
  pistol: 'muzzle_pistol',
  smg: 'muzzle_smg',
  revolver: 'muzzle_revolver',
  sniper_rifle: 'muzzle_sniperrifle',
  minigun: 'muzzle_minigun_constant',
  syringe_gun: 'muzzle_syringe',
  grenade_launcher: 'muzzle_grenadelauncher',
  sticky_launcher: 'muzzle_pipelauncher',
}

/** One system per family whose presence means the pack draws it: hitscan tracers and crit-boost sparks. */
export const PACK_TRACER_PROBE = 'bullet_tracer01_red'
export const PACK_CRIT_PROBE = 'critgun_weaponmodel_red'

const PackParticlesLoaded = lazy(() => import('./packParticlesDraw'))

/** Mounted by CombatFxLayer; renders nothing without a pack that lists particles or with assets.particles off. */
export const PackParticlesLayer = React.memo(({ x, demo }: { x: HighlanderExtras; demo: AsyncParser }) => {
  const wanted = usePackParticlesWanted()
  if (!wanted) return null
  return (
    <Suspense fallback={null}>
      <PackParticlesLoaded x={x} demo={demo} />
    </Suspense>
  )
})
