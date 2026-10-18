// Drives the GLB brush-entity nodes (doors, setup gates, trains, rotating brushes, func_brush toggles) from
// the extras `movers` group. Draws nothing itself: it writes node matrices and visibility, and restores
// the GLB state on unmount, map reload, settings change or missing extras (contract section 5 F6).

import React, { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'

import { useExtras, useHlSetting } from '@highlander/extras/hooks'
import { useInstance } from '@zus/store'

import { frameTickF } from './frame'
import { MoverNodeDriver, getActiveMoverDriver, setActiveMoverDriver } from './movers'

export const BrushMovers = React.memo((_props: { renderTick: number }) => {
  const x = useExtras()
  const enabled = useHlSetting<boolean>('map.movers') !== false
  // World replaces the node map on every GLB reload, map change and scene-mode change (section 11.2).
  const mapNodes = useInstance(s => s.mapNodes)
  const driver = useMemo(() => new MoverNodeDriver(), [])

  const active = !!x && enabled && x.meta.available.movers && !!mapNodes && mapNodes.size > 0

  useEffect(() => {
    if (!active || !x || !mapNodes) return
    driver.bind(x, mapNodes)
    driver.update(frameTickF(), true)
    setActiveMoverDriver(driver)
    return () => {
      driver.unbind()
      if (getActiveMoverDriver() === driver) setActiveMoverDriver(null)
    }
  }, [active, x, mapNodes, driver])

  useFrame(() => {
    if (driver.bound) driver.update(frameTickF())
  })

  return null
})
