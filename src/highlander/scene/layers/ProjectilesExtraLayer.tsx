// Projectiles the base parser drops (contract D13 and 5 F3): every extras projectile instance without a typed base
// slot (servedByBase 0) that is drawn at the tick, whatever its kind: flares, arrows, repair bolts, cannonballs,
// jars, cleavers, balls, ornaments, Bison and Pomson rings, Cow Mangler balls, Dragon's Fury fireballs, orbs, and
// any rocket, pipe or bolt the base missed, plus the landed phase of such a bolt (combat/landing.ts). One
// InstancedMesh per placeholder part, plus one ribbon batch for their trails. Positions and trails come from the
// extras samples at tickF, so a seek reproduces them exactly (D12).

import React, { useEffect, useMemo } from 'react'

import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'

import type { AsyncParser } from '@components/Analyse/Data/AsyncParser'
import { useInstance } from '@zus/store'
import { useExtras, useHlSetting } from '@highlander/extras/hooks'
import type { HighlanderExtras } from '@highlander/extras/types'
import { PROJ } from '@highlander/extras/enums'
import type { ViewResolver } from '@highlander/combat/combatData'
import { pixelScaleOf, RibbonBatch } from '@highlander/combat/fx'
import { extrasRecord, pointList, recordingEnabled, resetRecord, roundVec } from '@highlander/combat/frameRecord'
import { landedPoseAt } from '@highlander/combat/landing'
import { directionAt, positionAt, projectilesDrawnAt, projectilesLandedAt, projectileTeamAt, quatForwardX } from '@highlander/combat/projectileData'
import { createProjectileParts, disposeProjectileParts, partColor, partsForKind } from '@highlander/combat/projectileMeshes'
import type { ProjectilePart } from '@highlander/combat/projectileMeshes'
import { packSetMeshes, usePackProjectileSets } from '@highlander/combat/packProjectiles'
import type { PackProjectileSet } from '@highlander/combat/packProjectiles'
import { getProjectileSource } from '@highlander/combat/projectileSource'
import { frameTime } from '@highlander/combat/time'
import { TRAIL_HEAD_ALPHA, TRAIL_MIN_PIXELS, TRAIL_SAMPLES, trailPoints, trailStyle } from '@highlander/combat/trails'
import { playerViewDrawn, povCameraOwner } from '@highlander/combat/view'
import '@highlander/combat/probes'

const ONE = new THREE.Vector3(1, 1, 1)

/** Kinds this layer draws from pack models when the pack has them (syringes are CombatFxLayer's). */
const PACK_KINDS = [PROJ.CANNONBALL, PROJ.FLARE, PROJ.ARROW, PROJ.REPAIR_BOLT, PROJ.HEALING_BOLT, PROJ.JARATE, PROJ.MILK, PROJ.CLEAVER, PROJ.STUN_BALL, PROJ.ORNAMENT]

/**
 * Pack models that tumble in flight, in degrees per second about their side axis (+Y): the cleaver turns end over
 * end and the ornament rolls. The data has no projectile angles, so the angle runs from the creation tick (D12);
 * placeholders stay unspun (contract 4.1).
 */
const PACK_SPIN_DEG_PER_S: Readonly<Record<number, number>> = { [PROJ.CLEAVER]: 1080, [PROJ.ORNAMENT]: 540 }
const _spin = new THREE.Matrix4()
const _spun = new THREE.Matrix4()

/** `matrix` turned by kind's spin at `seconds` of flight (a reused matrix), or `matrix` itself for other kinds. */
function packSpin(matrix: THREE.Matrix4, kind: number, seconds: number, phase: number): THREE.Matrix4 {
  const rate = PACK_SPIN_DEG_PER_S[kind]
  if (!rate) return matrix
  return _spun.multiplyMatrices(matrix, _spin.makeRotationY(((seconds * rate + phase) * Math.PI) / 180))
}

/** The pack model when it is loaded (plus the parts kept with it, such as the flare glow), else the placeholder parts. */
function pushProjectile(
  set: PackProjectileSet | null | undefined,
  kindParts: ProjectilePart[],
  matrix: THREE.Matrix4,
  kind: number,
  team: number,
  packMatrix: THREE.Matrix4 = matrix
) {
  const pack = !!set && set.push(packMatrix, team)
  for (const part of kindParts) if (!pack || part.def.keepWithPack) part.instances.push(matrix, partColor(part, kind, team))
}

export const ProjectilesExtraLayer = React.memo(() => {
  const extras = useExtras()
  const demo = useInstance(s => s.parsedDemo)
  const enabled = useHlSetting<boolean>('projectiles.extraTypes')
  if (!extras || !demo || !enabled || !extras.meta.available.projectiles) return null
  return <ExtrasProjectiles x={extras} demo={demo} />
})

const ExtrasProjectiles = React.memo(({ x, demo }: { x: HighlanderExtras; demo: AsyncParser }) => {
  const { parts, byKind } = useMemo(() => createProjectileParts(), [])
  const ribbonMaterial = useMemo(
    () => new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
    []
  )
  const ribbons = useMemo(() => new RibbonBatch(ribbonMaterial, 2048, 'hl-projectile-trails'), [ribbonMaterial])
  const size = useThree(state => state.size)
  const packSets = usePackProjectileSets(PACK_KINDS, 96)
  const packMeshes = useMemo(() => packSetMeshes(packSets), [packSets])

  useEffect(
    () => () => {
      disposeProjectileParts(parts)
      ribbons.dispose()
      ribbonMaterial.dispose()
    },
    [parts, ribbons, ribbonMaterial]
  )

  const resolve: ViewResolver = useMemo(() => (p, tickF, out) => playerViewDrawn(demo, p, tickF, out), [demo])

  const scratch = useMemo(
    () => ({
      time: { tick: 0, tickF: 0 },
      alive: [] as number[],
      landed: [] as number[],
      pos: new THREE.Vector3(),
      dir: new THREE.Vector3(),
      quat: new THREE.Quaternion(),
      matrix: new THREE.Matrix4(),
      camera: new THREE.Vector3(),
      color: new THREE.Color(),
      points: new Float32Array((TRAIL_SAMPLES + 2) * 3),
      style: { width: 0, color: '', crit: false, team: 0 },
    }),
    []
  )

  useFrame(({ camera }) => {
    const s = scratch
    const { tick, tickF } = frameTime(s.time)
    const source = getProjectileSource(x, demo)
    const pj = x.projectiles
    const record = recordingEnabled()
    if (record) resetRecord(extrasRecord, tickF)

    camera.getWorldPosition(s.camera)
    ribbons.begin(s.camera, pixelScaleOf(camera, size.height))
    for (const part of parts) part.instances.begin()
    for (const set of packSets) set?.begin()

    for (const j of projectilesDrawnAt(x, tick, s.alive)) {
      if (source.servedByBase[j]) continue // Projectiles.tsx draws it
      if (!positionAt(x, j, tickF, s.pos)) continue
      directionAt(x, j, tickF, s.dir)
      quatForwardX(s.dir, s.quat)
      s.matrix.compose(s.pos, s.quat, ONE)
      const kind = pj.kind[j]
      const team = projectileTeamAt(x, j, tick)
      const flight = Math.max(0, tickF - pj.created[j]) * (x.meta.intervalPerTick || 0.015)
      pushProjectile(packSets[kind], partsForKind(byKind, kind), s.matrix, kind, team, packSpin(s.matrix, kind, flight, (j * 137) % 360))

      const count = trailPoints(x, j, tickF, TRAIL_SAMPLES, s.points)
      const style = trailStyle(x, j, tick, s.style)
      if (count >= 2) ribbons.strip(s.points, count, s.color.set(style.color), style.width, style.width, TRAIL_HEAD_ALPHA, 0, TRAIL_MIN_PIXELS)

      if (record) {
        extrasRecord.meshes.set(j, roundVec(s.pos.x, s.pos.y, s.pos.z))
        if (count >= 2) {
          extrasRecord.trails.push({ key: `extras:${j}`, instance: j, source: 'extras', width: style.width, color: style.color, points: pointList(s.points, count) })
        }
      }
    }

    // landed bolts: where they hit, or on the player they hit, until the server deletes them (no trail)
    const ownEyes = povCameraOwner()
    for (const j of projectilesLandedAt(x, tick, s.landed)) {
      if (source.servedByBase[j]) continue // Projectiles.tsx draws it
      if (!landedPoseAt(x, demo, j, tickF, resolve, s.pos, s.dir, ownEyes)) continue
      quatForwardX(s.dir, s.quat)
      s.matrix.compose(s.pos, s.quat, ONE)
      const kind = pj.kind[j]
      const team = projectileTeamAt(x, j, tick)
      pushProjectile(packSets[kind], partsForKind(byKind, kind), s.matrix, kind, team)
      if (record) extrasRecord.landed.set(j, roundVec(s.pos.x, s.pos.y, s.pos.z))
    }

    for (const part of parts) part.instances.end()
    for (const set of packSets) set?.end()
    ribbons.end()
    if (record) {
      for (const part of parts) if (part.instances.count) extrasRecord.counts[part.def.name] = part.instances.count
      for (const set of packSets) if (set?.count) extrasRecord.counts[`pack:${set.role}`] = set.count
    }
  })

  return (
    <group name="hl-projectiles">
      {parts.map(part => (
        <primitive key={part.def.name} object={part.instances.mesh} />
      ))}
      {packMeshes.map(mesh => (
        <primitive key={mesh.name} object={mesh} />
      ))}
      <primitive object={ribbons.mesh} />
    </group>
  )
})
