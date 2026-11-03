// TF2 particle effects from the asset pack (as/particles): the always-loaded part. PackParticlesLayer imports the
// evaluator, the renderer and the effect selection (packParticlesDraw.tsx) only once a ready pack lists
// `particles/systems` and assets.particles is on, so pages without a pack load and request nothing new (D21).
// While the particles draw, the placeholders they replace stand down (packParticlesDrawing).

import React, { Suspense, lazy } from 'react'

import type { AsyncParser } from '@components/Analyse/Data/AsyncParser'
import type { HighlanderExtras } from '@highlander/extras/types'
import { usePackParticlesWanted } from '@pack/particles/load'

let drawing: { ready: boolean } | null = null

/** True while the pack particle layer is mounted with its definitions and textures ready. */
export function packParticlesDrawing(): boolean {
  return !!drawing && drawing.ready
}

/** Set by the mounted renderer; `owner` clears only when it is still the current one. */
export function setPackParticleRenderer(renderer: { ready: boolean } | null, owner?: { ready: boolean }): void {
  if (renderer || !owner || drawing === owner) drawing = renderer
}

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
