// Combat effects (contract 5 F3): crit glows and deflect rings of the projectiles ProjectilesExtraLayer draws,
// TETFExplosion bursts with scorch marks, building explosions, hitscan and sentry tracers, flamethrower flames,
// airblast puffs, deflect flashes, muzzle flashes and syringes. Every shape is one InstancedMesh (tracers one ribbon
// batch) filled each frame from `combatEffectsAt`, the same pure function the `combat.fx` probe reports.

import React, { useEffect, useMemo } from 'react'

import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'

import type { AsyncParser } from '@components/Analyse/Data/AsyncParser'
import { useInstance } from '@zus/store'
import { useExtras } from '@highlander/extras/hooks'
import type { HighlanderExtras } from '@highlander/extras/types'
import {
  combatEffectsAt,
  CRIT_GLOW_RADIUS,
  CRIT_GLOW_SOFTNESS,
  critGlowOpacity,
  DEFLECT_RING_RADIUS,
  readCombatSettings,
  SYRINGE_TRAIL_POINTS,
  TRACER_WIDTH,
  type ViewResolver,
} from '@highlander/combat/combatData'
import { FxInstances, gradientConeX, makeFxMaterial, pixelScaleOf, RibbonBatch, rgba, setFxOpacity } from '@highlander/combat/fx'
import { combatRecord, recordingEnabled, resetRecord } from '@highlander/combat/frameRecord'
import { quatForwardX } from '@highlander/combat/projectileData'
import { getProjectileSource } from '@highlander/combat/projectileSource'
import { frameTime } from '@highlander/combat/time'
import { TRAIL_HEAD_ALPHA, TRAIL_MIN_PIXELS } from '@highlander/combat/trails'
import { playerViewDrawn, povCameraOwner } from '@highlander/combat/view'
import '@highlander/combat/probes'
import { usePackProjectileSets } from '@highlander/combat/packProjectiles'
import { PROJ } from '@highlander/extras/enums'
import { PackParticlesLayer, packParticlesDrawing } from '@highlander/combat/packParticles'

const SYRINGE_KINDS = [PROJ.SYRINGE]

/** Tracers never get thinner than this on screen. */
const TRACER_MIN_PIXELS = 1.2
/**
 * Flames and airblasts of the player whose own eyes the camera uses fill the middle of the screen; they draw at
 * this fraction of their opacity so the view stays readable (the cue that he fires stays).
 */
const OWN_EYES_OPACITY = 0.4
const SCORCH_LIFT = 0.6
const Z_AXIS = new THREE.Vector3(0, 0, 1)

export const CombatFxLayer = React.memo((_props: { renderTick: number }) => {
  const extras = useExtras()
  const demo = useInstance(s => s.parsedDemo)
  if (!extras || !demo) return null
  return <CombatFx x={extras} demo={demo} />
})

function createCombatMeshes() {
  const sphere = new THREE.SphereGeometry(1, 20, 14)
  const glowSphere = new THREE.SphereGeometry(1, 16, 12)
  const disc = new THREE.CircleGeometry(1, 28)
  const ring = new THREE.TorusGeometry(DEFLECT_RING_RADIUS, 1, 8, 28)
  const thinRing = new THREE.TorusGeometry(1, 0.07, 6, 32)
  const frontRing = new THREE.TorusGeometry(1, 0.025, 4, 48)
  const flameCone = gradientConeX(rgba('#ffe066', 0.6), rgba('#ff5a1a', 0))
  // brightest at the open end: the expanding front reads as a pressure wave
  const airCone = gradientConeX(rgba('#dff3ff', 0.2), rgba('#dff3ff', 0.8))
  // 6-unit needles; the streak behind each one (syringeTrails) carries the stream in the RTS overview
  const needle = new THREE.BoxGeometry(6, 1.6, 1.6)

  const scorchMaterial = makeFxMaterial({ blending: 'normal', color: '#141414', instanceOpacity: true, side: THREE.DoubleSide })
  scorchMaterial.polygonOffset = true
  scorchMaterial.polygonOffsetFactor = -2
  scorchMaterial.polygonOffsetUnits = -2

  const glowMaterial = makeFxMaterial({ softness: CRIT_GLOW_SOFTNESS, opacity: 0.4 })

  const meshes = {
    explosions: new FxInstances(sphere, makeFxMaterial({ softness: 0.9, instanceOpacity: true }), 96, { color: true, opacity: true, name: 'hl-explosions' }),
    scorches: new FxInstances(disc, scorchMaterial, 256, { opacity: true, name: 'hl-scorches' }),
    glows: new FxInstances(glowSphere, glowMaterial, 64, { color: true, name: 'hl-crit-glows' }),
    rings: new FxInstances(ring, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }), 32, { color: true, name: 'hl-deflect-rings' }),
    deflects: new FxInstances(glowSphere, makeFxMaterial({ color: '#ffffff', softness: 1.2, instanceOpacity: true }), 32, { opacity: true, name: 'hl-deflect-flashes' }),
    muzzle: new FxInstances(glowSphere, makeFxMaterial({ color: '#ffd27a', softness: 1.0, instanceOpacity: true }), 64, { opacity: true, name: 'hl-muzzle-flashes' }),
    flameCones: new FxInstances(flameCone, makeFxMaterial({ vertexColors: true, instanceOpacity: true, softness: 0.8 }), 32, { opacity: true, name: 'hl-flames' }),
    flameBlobs: new FxInstances(glowSphere, makeFxMaterial({ color: '#ff8a3a', softness: 1.0, instanceOpacity: true }), 16, { opacity: true, name: 'hl-flame-blobs' }),
    airCones: new FxInstances(airCone, makeFxMaterial({ vertexColors: true, instanceOpacity: true, softness: 0.6 }), 16, { opacity: true, name: 'hl-airblast' }),
    airRings: new FxInstances(thinRing, makeFxMaterial({ color: '#dff3ff', instanceOpacity: true, side: THREE.DoubleSide }), 16, { opacity: true, name: 'hl-airblast-rings' }),
    airFronts: new FxInstances(frontRing, makeFxMaterial({ color: '#dff3ff', instanceOpacity: true, side: THREE.DoubleSide }), 16, { opacity: true, name: 'hl-airblast-fronts' }),
    syringes: new FxInstances(needle, new THREE.MeshBasicMaterial({ color: '#ffffff' }), 256, { color: true, name: 'hl-syringes' }),
  }
  const tracerMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide })
  const tracers = new RibbonBatch(tracerMaterial, 4096, 'hl-tracers')
  // syringe streaks blend like the projectile trails
  const syringeTrailMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide })
  const syringeTrails = new RibbonBatch(syringeTrailMaterial, 1024, 'hl-syringe-trails')
  const geometries = [sphere, glowSphere, disc, ring, thinRing, frontRing, flameCone, airCone, needle]
  return { meshes, tracers, tracerMaterial, syringeTrails, syringeTrailMaterial, geometries, glowMaterial }
}

type CombatMeshes = ReturnType<typeof createCombatMeshes>

function disposeCombatMeshes(fx: CombatMeshes) {
  for (const instances of Object.values(fx.meshes)) {
    ;(instances.mesh.material as THREE.Material).dispose()
    instances.dispose()
  }
  fx.tracers.dispose()
  fx.tracerMaterial.dispose()
  fx.syringeTrails.dispose()
  fx.syringeTrailMaterial.dispose()
  for (const geometry of fx.geometries) geometry.dispose()
}

const CombatFx = React.memo(({ x, demo }: { x: HighlanderExtras; demo: AsyncParser }) => {
  const fx = useMemo(() => createCombatMeshes(), [])
  useEffect(() => () => disposeCombatMeshes(fx), [fx])
  const size = useThree(state => state.size)
  // the pack syringe model, when loaded, replaces the placeholder needle (the streak stays)
  const syringePack = usePackProjectileSets(SYRINGE_KINDS, 256)[PROJ.SYRINGE] ?? null

  const s = useMemo(
    () => ({
      time: { tick: 0, tickF: 0 },
      pos: new THREE.Vector3(),
      end: new THREE.Vector3(),
      dir: new THREE.Vector3(),
      quat: new THREE.Quaternion(),
      scale: new THREE.Vector3(),
      matrix: new THREE.Matrix4(),
      camera: new THREE.Vector3(),
      color: new THREE.Color(),
      points: new Float32Array(SYRINGE_TRAIL_POINTS * 3),
    }),
    []
  )

  const resolve: ViewResolver = useMemo(() => (p, tickF, out) => playerViewDrawn(demo, p, tickF, out), [demo])

  useFrame(({ camera }) => {
    const { tickF } = frameTime(s.time)
    const settings = readCombatSettings()
    const source = getProjectileSource(x, demo)
    const ownEyes = povCameraOwner()
    const effects = combatEffectsAt(x, demo, source, tickF, resolve, ownEyes, settings)
    const m = fx.meshes
    for (const instances of Object.values(m)) instances.begin()
    syringePack?.begin()
    camera.getWorldPosition(s.camera)
    const pixelScale = pixelScaleOf(camera, size.height)
    fx.tracers.begin(s.camera, pixelScale)
    fx.syringeTrails.begin(s.camera, pixelScale)

    const at = (v: [number, number, number]) => s.pos.set(v[0], v[1], v[2])
    // with the pack's particle systems drawing, explosions and the cone flames of drawn pyros are theirs
    const pack = packParticlesDrawing()

    // explosions: soft additive spheres
    for (const e of pack ? [] : effects.explosions) {
      if (!(e.radius > 0)) continue
      s.matrix.compose(at(e.pos), s.quat.identity(), s.scale.setScalar(e.radius))
      m.explosions.push(s.matrix, s.color.set(e.color), e.opacity)
    }
    // scorch marks: dark discs on the surface
    for (const e of effects.scorches) {
      s.dir.set(e.normal[0], e.normal[1], e.normal[2]).normalize()
      at(e.pos).addScaledVector(s.dir, SCORCH_LIFT)
      s.quat.setFromUnitVectors(Z_AXIS, s.dir)
      s.matrix.compose(s.pos, s.quat, s.scale.setScalar(e.radius))
      m.scorches.push(s.matrix, undefined, e.opacity)
    }
    // crit glows of extras-drawn projectiles (base-drawn ones glow inside Projectiles.tsx)
    setFxOpacity(fx.glowMaterial, critGlowOpacity(tickF))
    for (const g of effects.glows) {
      s.matrix.compose(at(g.pos), s.quat.identity(), s.scale.setScalar(CRIT_GLOW_RADIUS))
      m.glows.push(s.matrix, s.color.set(g.color))
    }
    // deflect rings around extras-drawn projectiles, in the new team's colour
    for (const r of effects.rings) {
      s.dir.set(r.dir[0], r.dir[1], r.dir[2])
      s.quat.setFromUnitVectors(Z_AXIS, s.dir)
      s.matrix.compose(at(r.pos), s.quat, s.scale.setScalar(1))
      m.rings.push(s.matrix, s.color.set(r.color))
    }
    // hitscan tracers (one line per pellet) and sentry tracers
    for (const t of effects.tracers) {
      s.color.set(t.color)
      at(t.start)
      for (const end of t.ends) {
        s.end.set(end[0], end[1], end[2])
        fx.tracers.segment(s.pos, s.end, s.color, TRACER_WIDTH, t.opacity, t.opacity, TRACER_MIN_PIXELS)
      }
    }
    for (const t of effects.sentryTracers) {
      s.color.set(t.color)
      s.end.set(t.end[0], t.end[1], t.end[2])
      fx.tracers.segment(at(t.start), s.end, s.color, TRACER_WIDTH, t.opacity, t.opacity, TRACER_MIN_PIXELS)
    }
    // muzzle flashes
    for (const f of effects.muzzle) {
      s.matrix.compose(at(f.pos), s.quat.identity(), s.scale.setScalar(f.size / 2))
      m.muzzle.push(s.matrix, undefined, f.opacity)
    }
    // flames: outer and inner cone from the pyro's muzzle, or an ellipsoid filling the box
    for (const f of effects.flames) {
      if (f.cone) {
        if (pack) continue
        const c = f.cone
        s.dir.set(c.axis[0], c.axis[1], c.axis[2])
        quatForwardX(s.dir, s.quat)
        const r = c.radius * c.flicker
        const opacity = f.fade * (f.entityId === ownEyes ? OWN_EYES_OPACITY : 1)
        s.matrix.compose(at(c.muzzle), s.quat, s.scale.set(c.length, r, r))
        m.flameCones.push(s.matrix, undefined, opacity)
        s.matrix.compose(at(c.muzzle), s.quat, s.scale.set(c.length * 0.6, r * 0.6, r * 0.6))
        m.flameCones.push(s.matrix, undefined, opacity)
      } else {
        s.matrix.compose(at(f.box.center), s.quat.identity(), s.scale.set(Math.max(f.box.half[0], 4), Math.max(f.box.half[1], 4), Math.max(f.box.half[2], 4)))
        m.flameBlobs.push(s.matrix, undefined, 0.35 * f.fade)
      }
    }
    // airblast: a widening cone along the view plus a ring at the muzzle
    for (const a of effects.airblasts) {
      if (!(a.length > 0.5)) continue
      const opacity = a.opacity * (a.entityId === ownEyes ? OWN_EYES_OPACITY : 1)
      s.dir.set(a.axis[0], a.axis[1], a.axis[2])
      quatForwardX(s.dir, s.quat)
      s.matrix.compose(at(a.muzzle), s.quat, s.scale.set(a.length, a.radius, a.radius))
      m.airCones.push(s.matrix, undefined, opacity)
      s.quat.setFromUnitVectors(Z_AXIS, s.dir)
      s.matrix.compose(at(a.muzzle), s.quat, s.scale.setScalar(a.ring))
      m.airRings.push(s.matrix, undefined, opacity)
      // the cone's open end: a thin ring that travels out with it
      at(a.muzzle).addScaledVector(s.dir, a.length)
      s.matrix.compose(s.pos, s.quat, s.scale.setScalar(a.radius))
      m.airFronts.push(s.matrix, undefined, opacity)
    }
    // deflect flashes
    for (const d of effects.deflects) {
      s.matrix.compose(at(d.pos), s.quat.identity(), s.scale.setScalar(d.radius))
      m.deflects.push(s.matrix, undefined, d.opacity)
    }
    // syringes: needles along their velocity in the shooter's trail colour, each with a streak through its path
    for (const n of effects.syringes) {
      s.dir.set(n.dir[0], n.dir[1], n.dir[2])
      quatForwardX(s.dir, s.quat)
      s.matrix.compose(at(n.pos), s.quat, s.scale.setScalar(1))
      if (!syringePack?.push(s.matrix, n.team)) m.syringes.push(s.matrix, s.color.set(n.color))
      const count = Math.min(n.trail.length, SYRINGE_TRAIL_POINTS)
      if (count < 2) continue
      for (let k = 0; k < count; k++) {
        s.points[k * 3] = n.trail[k][0]
        s.points[k * 3 + 1] = n.trail[k][1]
        s.points[k * 3 + 2] = n.trail[k][2]
      }
      fx.syringeTrails.strip(s.points, count, s.color.set(n.trailColor), n.trailWidth, n.trailWidth * 0.5, TRAIL_HEAD_ALPHA, 0, TRAIL_MIN_PIXELS)
    }

    for (const instances of Object.values(m)) instances.end()
    syringePack?.end()
    fx.tracers.end()
    fx.syringeTrails.end()

    if (recordingEnabled()) {
      resetRecord(combatRecord, tickF)
      for (const g of effects.glows) combatRecord.glows.set(g.instance, g.pos)
      for (const [name, instances] of Object.entries(m)) if (instances.count) combatRecord.counts[name] = instances.count
      if (syringePack?.count) combatRecord.counts['pack:syringe'] = syringePack.count
      combatRecord.counts.tracerVertices = fx.tracers.vertexCount
      if (fx.syringeTrails.vertexCount) combatRecord.counts.syringeTrailVertices = fx.syringeTrails.vertexCount
    }
  })

  return (
    <group name="hl-combat-fx">
      {Object.entries(fx.meshes).map(([name, instances]) => (
        <primitive key={name} object={instances.mesh} />
      ))}
      <primitive object={fx.tracers.mesh} />
      <primitive object={fx.syringeTrails.mesh} />
      <PackParticlesLayer x={x} demo={demo} />
      {syringePack?.meshes.map(mesh => (
        <primitive key={mesh.name} object={mesh} />
      ))}
    </group>
  )
})
