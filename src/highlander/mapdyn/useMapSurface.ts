// Runs a SurfaceJob (surface.ts) over the loaded map for a list of spots, a slice per frame.
//
// The analysis re-runs whenever the static map geometry can have changed: the map becomes ready, a child
// joins or leaves the rotated `world` group (World swaps its GLB on a reload or a scene-mode change, and
// M2's StaticProps adds props.glb there when it finishes loading), the brush-entity node map changes, or the
// map.staticProps setting shows or hides the props. Until the first analysis of the current spots
// completes, callers use their fallback; a re-run keeps the previous result until the new one is ready.
// The job advances a fixed number of triangles per frame (no wall clock), so the result is a pure function
// of the map geometry, the settings, the spots and the options.

import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'

import { useHlSetting } from '@highlander/extras/hooks'
import { useInstance } from '@zus/store'

import { SURFACE_TRIANGLES_PER_FRAME } from './constants'
import { SurfaceJob, type Spot, type SpotSurface, type SurfaceOptions } from './surface'

/** The rotated group World mounts the map GLB (and M2's props.glb) in. */
export const getWorldGroup = (): THREE.Object3D | undefined =>
  useInstance.getState().threeScene?.getObjectByName('world')

/** Brush-entity nodes move or toggle with the demo, so the analysis skips them (surface.ts). */
export const movingMapNodes = (): ReadonlySet<THREE.Object3D> =>
  new Set(useInstance.getState().mapNodes?.values() ?? [])

interface Done {
  spots: readonly Spot[]
  options: SurfaceOptions
  surface: SpotSurface
}

/** Analyses started, finished and still running (probe diagnostics). */
const jobStats = { started: 0, finished: 0, pending: new Set<SurfaceJob>() }
export const getSurfaceJobStats = () => ({
  started: jobStats.started,
  finished: jobStats.finished,
  pending: jobStats.pending.size,
})

export function useMapSurface(spots: readonly Spot[] | null, options: SurfaceOptions | null): SpotSurface | null {
  const ready = useInstance(s => s.mapStatus.state === 'ready')
  const mapNodes = useInstance(s => s.mapNodes)
  const staticProps = useHlSetting<boolean>('map.staticProps') !== false
  const [worldVersion, setWorldVersion] = useState(0)
  const [done, setDone] = useState<Done | null>(null)
  const pending = useRef<{ job: SurfaceJob; spots: readonly Spot[]; options: SurfaceOptions } | null>(null)

  useEffect(() => {
    const world = ready ? getWorldGroup() : undefined
    if (!world) return
    const bump = () => setWorldVersion(v => v + 1)
    world.addEventListener('childadded', bump)
    world.addEventListener('childremoved', bump)
    return () => {
      world.removeEventListener('childadded', bump)
      world.removeEventListener('childremoved', bump)
    }
  }, [ready])

  useEffect(() => {
    pending.current = null
    const world = ready && spots && spots.length > 0 && options ? getWorldGroup() : undefined
    if (!world || !spots || !options) return
    const job = new SurfaceJob(world, spots, options, movingMapNodes())
    pending.current = { job, spots, options }
    jobStats.started++
    jobStats.pending.add(job)
    return () => {
      jobStats.pending.delete(job)
    }
  }, [ready, spots, options, mapNodes, staticProps, worldVersion])

  useFrame(() => {
    const run = pending.current
    if (!run || !run.job.step(SURFACE_TRIANGLES_PER_FRAME)) return
    pending.current = null
    jobStats.finished++
    jobStats.pending.delete(run.job)
    setDone({ spots: run.spots, options: run.options, surface: run.job.result() })
  })

  return done && done.spots === spots && done.options === options ? done.surface : null
}
