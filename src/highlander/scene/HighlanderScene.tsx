// Root of every Highlander scene layer (contract section 6.4). Mounted inside the Canvas right after
// <Projectiles />. Renders nothing while settings.highlander.enabled is false.

import React from 'react'

import { useHlSetting } from '@highlander/extras/hooks'
import { BuildingsLayer } from '@highlander/scene/layers/BuildingsLayer'
import { CombatFxLayer } from '@highlander/scene/layers/CombatFxLayer'
import { DamageNumbersLayer } from '@highlander/scene/layers/DamageNumbersLayer'
import { MapDynamicsLayer } from '@highlander/scene/layers/MapDynamicsLayer'
import { ObjectivesLayer } from '@highlander/scene/layers/ObjectivesLayer'
import { PlayerFxLayer } from '@highlander/scene/layers/PlayerFxLayer'
import { PovLayer } from '@highlander/scene/layers/PovLayer'
import { ProjectilesExtraLayer } from '@highlander/scene/layers/ProjectilesExtraLayer'
import { SniperLayer } from '@highlander/scene/layers/SniperLayer'
import { ViewmodelLayer } from '@highlander/scene/viewmodel/ViewmodelLayer'

export const HighlanderScene = React.memo(() => {
  const enabled = useHlSetting<boolean>('enabled')
  if (!enabled) return null
  return (
    <group name="highlander">
      <PlayerFxLayer />
      <BuildingsLayer />
      <ProjectilesExtraLayer />
      <CombatFxLayer />
      <SniperLayer />
      <ObjectivesLayer />
      <MapDynamicsLayer />
      <PovLayer />
      <ViewmodelLayer />
      <DamageNumbersLayer />
    </group>
  )
})
