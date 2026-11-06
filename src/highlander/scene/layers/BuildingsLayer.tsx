// Engineer buildings layer (contract section 5 F2): sentries, dispensers, teleporters and sappers at their real
// positions with level, health, construction, upgrade, sapper, wrangler, ammo, aim and carry state, plus the
// dispenser beams, carried-building boxes, blueprints and destruction blasts.
//
// The only React state that changes per tick is the list of mounted instances (alive, not map-placed, not
// sappers, which draw on their building). Everything else is applied in useFrame from the pure functions of
// src/highlander/buildings/render.ts at the tick and frameProgress the store holds in that frame (frameTime() in
// src/highlander/combat/time.ts; the renderTick prop lags a frame), so seeking stays deterministic (D12). The
// prop only picks the mounted instances.

import React, { useMemo } from 'react'

import { useStore } from '@zus/store'
import { renderTickOf } from '@utils/tickData'
import { useExtras, useHlSetting } from '@highlander/extras/hooks'
import { BuildingObject } from '@highlander/buildings/BuildingObject'
import { Blueprints, CarryBoxes, Destructions, DispenserBeams } from '@highlander/buildings/EngineerFx'
import { drawnInstancesAt } from '@highlander/buildings/render'
import { useRetainPackModels } from '@highlander/buildings/pack'
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

export const BuildingsLayer = React.memo(() => {
  const extras = useExtras()
  const enabled = useHlSetting<boolean>('buildings.enabled')
  const blueprints = useHlSetting<boolean>('buildings.blueprints')

  const active = !!extras && enabled !== false && !!extras.meta.available.buildings
  const key = useStore(state => (active ? drawnInstancesAt(extras, renderTickOf(state.playback.tick)).join(',') : ''))
  const instances = useMemo(() => (key ? key.split(',').map(Number) : []), [key])

  if (!active) return null
  const xid = extrasId(extras)
  return (
    <group name="buildings">
      <RetainPackModels />
      {instances.map(j => (
        <BuildingObject key={`${xid}:${j}`} instance={j} />
      ))}
      <DispenserBeams />
      <CarryBoxes />
      {blueprints !== false && <Blueprints />}
      <Destructions />
    </group>
  )
})

/** Pack building models stay loaded while the layer draws (asset contract 12.4); renders nothing. */
function RetainPackModels() {
  useRetainPackModels()
  return null
}

