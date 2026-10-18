// F6 map dynamics (contract section 5 F6): moving doors, gates, trains and rotating brushes, brush
// visibility toggles, prop-door slabs, resupply cabinets, health and ammo pickups with respawn rings,
// death markers and dropped items. Every part reads the extras through useExtras(), checks its own
// setting and `extras.meta.available` key, and draws nothing without data (section 3.9).

import React from 'react'

import { useExtras } from '@highlander/extras/hooks'
import { BrushMovers } from '@highlander/mapdyn/BrushMovers'
import { DeathMarkers } from '@highlander/mapdyn/DeathMarkers'
import { DoorSlabs } from '@highlander/mapdyn/DoorSlabs'
import { Drops } from '@highlander/mapdyn/Drops'
import { Pickups } from '@highlander/mapdyn/Pickups'
import { ResupplyLockers } from '@highlander/mapdyn/ResupplyLockers'
import '@highlander/mapdyn/probes'

export const MapDynamicsLayer = React.memo(({ renderTick }: { renderTick: number }) => {
  const x = useExtras()
  if (!x) return null
  return (
    <group name="mapDynamics">
      <BrushMovers renderTick={renderTick} />
      <DoorSlabs renderTick={renderTick} />
      <ResupplyLockers />
      <Pickups renderTick={renderTick} />
      <DeathMarkers renderTick={renderTick} />
      <Drops renderTick={renderTick} />
    </group>
  )
})
