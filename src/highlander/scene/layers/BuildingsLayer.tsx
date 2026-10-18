// Engineer buildings layer (contract section 5 F2): sentries, dispensers, teleporters and sappers at their real
// positions with level, health, construction, upgrade, sapper, wrangler, ammo, aim and carry state, plus the
// dispenser beams, carried-building boxes, blueprints and destruction blasts.
//
// The only React state that changes per tick is the list of mounted instances (alive, not map-placed, not
// sappers, which draw on their building). Everything else is applied in useFrame from the pure functions of
// src/highlander/buildings/render.ts at tickF = renderTick + frameProgress, so seeking stays deterministic (D12).

import React, { useLayoutEffect, useMemo, useRef } from 'react'

import { useExtras, useHlSetting } from '@highlander/extras/hooks'
import { BuildingObject } from '@highlander/buildings/BuildingObject'
import { Blueprints, CarryBoxes, Destructions, DispenserBeams } from '@highlander/buildings/EngineerFx'
import { drawnInstancesAt } from '@highlander/buildings/render'
import type { HighlanderExtras } from '@highlander/extras/types'
import '@highlander/buildings/probes'

// Instance indices repeat between demos: key the mounted buildings by extras object too, so a new demo never
// reuses a component built for another demo's instance (another type, team or construction state).
const extrasIds = new WeakMap<HighlanderExtras, number>()
let nextExtrasId = 1
const extrasId = (x: HighlanderExtras) => {
  let id = extrasIds.get(x)
  if (id === undefined) extrasIds.set(x, (id = nextExtrasId++))
  return id
}

export const BuildingsLayer = React.memo(({ renderTick }: { renderTick: number }) => {
  const extras = useExtras()
  const enabled = useHlSetting<boolean>('buildings.enabled')
  const blueprints = useHlSetting<boolean>('buildings.blueprints')

  // Children read the tick in useFrame through this ref, so they render once instead of every tick.
  const tickRef = useRef(renderTick)
  useLayoutEffect(() => {
    tickRef.current = renderTick
  }, [renderTick])

  const active = !!extras && enabled !== false && !!extras.meta.available.buildings
  const key = active ? drawnInstancesAt(extras, renderTick).join(',') : ''
  const instances = useMemo(() => (key ? key.split(',').map(Number) : []), [key])

  if (!active) return null
  const xid = extrasId(extras)
  return (
    <group name="buildings">
      {instances.map(j => (
        <BuildingObject key={`${xid}:${j}`} instance={j} tickRef={tickRef} />
      ))}
      <DispenserBeams tickRef={tickRef} />
      <CarryBoxes tickRef={tickRef} />
      {blueprints !== false && <Blueprints tickRef={tickRef} />}
      <Destructions tickRef={tickRef} />
    </group>
  )
})
