// Building effects that are not part of one building's model (contract section 5 F2): the thin dispenser beams,
// the carried-building box on an engineer, blueprints and the destruction blasts. Each is one component with a
// fixed pool of objects that useFrame assigns from render.ts, so nothing remounts per tick.

import React, { useEffect, useMemo, useRef, type MutableRefObject } from 'react'

import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'

import { BUILDING_TYPE } from '@highlander/extras/enums'
import { useExtras } from '@highlander/extras/hooks'
import { getActor } from '@highlander/scene/actorRegistry'
import { useInstance } from '@zus/store'

import { glyphBadgeTexture, glyphOf, pxPerUnitAt, screenScale } from './label'
import { basic, BOX, BOX_EDGES, DARK_METAL, getFlashTexture, INVALID, METAL, PLANE, solid, TEAM_DARK, TEAM_FX, type TeamKey } from './parts'
import {
  blueprintsAt,
  buildingDraw,
  CARRY_BOX,
  carriesAt,
  BLUEPRINT_DISTANCE,
  DESTRUCTION_TICKS,
  destructionsAt,
  drawnInstancesAt,
  hash,
  HEAL_BEAM_HEIGHT,
  HULLS,
  teamName,
} from './render'
import { baseHealth, basePosition, baseTeam, povRenderedEntityId } from './scene'

type TickRef = MutableRefObject<number>

const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _mid = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _side = new THREE.Vector3()
const _cam = new THREE.Vector3()
const _off = new THREE.Vector3()

/** An actor that is drawn alive at tick (registered, base health above 0), else undefined. */
function liveActor(p: number, entityId: number, tick: number) {
  const actor = getActor(entityId)
  if (!actor || baseHealth(p, tick) <= 0) return undefined
  return actor
}

// ─── dispenser beams ──────────────────────────────────────────────────────────

const MAX_BEAMS = 32
const BEAM_WIDTH = 1.5
/**
 * A beam keeps at least this width on screen: 1.5 units is under a pixel from the default RTS camera, where the
 * contract's beam (healed players stand within about 64 units) read only when zoomed in.
 */
const BEAM_MIN_PX = 2
/** Contract 0.25, raised: at 0.25 the thin quad barely tinted the ground. Still unlike HealBeam (no glow, no motion). */
const BEAM_OPACITY = 0.4

function useBeamGeometry() {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_BEAMS * 6 * 3), 3).setUsage(THREE.DynamicDrawUsage))
    g.setDrawRange(0, 0)
    return g
  }, [])
  useEffect(() => () => geometry.dispose(), [geometry])
  return geometry
}

/**
 * Not HealBeam, which would make a dispenser with four players around it read like four medics: one camera-facing
 * quad per healed player, from the dispenser top to his chest (+41), 1.5 units wide but at least BEAM_MIN_PX on
 * screen, TEAM_FX at BEAM_OPACITY, no animation.
 */
export const DispenserBeams = React.memo(({ tickRef }: { tickRef: TickRef }) => {
  const x = useExtras()
  const red = useBeamGeometry()
  const blue = useBeamGeometry()
  const redMesh = useRef<THREE.Mesh>(null)
  const blueMesh = useRef<THREE.Mesh>(null)

  useFrame(({ camera, size }) => {
    if (!x) return
    const tick = tickRef.current
    const tickF = tick + useInstance.getState().frameProgress
    const pov = povRenderedEntityId()
    _cam.setFromMatrixPosition(camera.matrixWorld)
    const counts = { red: 0, blue: 0 }
    for (const j of drawnInstancesAt(x, tick)) {
      if (x.buildings.type[j] !== BUILDING_TYPE.DISPENSER) continue
      const d = buildingDraw(x, j, tickF)
      if (!d.drawn || !d.team || d.beams.length === 0) continue
      const geometry = d.team === 'red' ? red : blue
      const pos = geometry.attributes.position as THREE.BufferAttribute
      _a.set(d.pos.x, d.pos.y, d.pos.z + (d.height + 4) * d.scaleZ)
      for (const p of d.beams) {
        const entityId = x.players.entityId[p]
        if (entityId === pov || counts[d.team] >= MAX_BEAMS) continue
        const actor = liveActor(p, entityId, tick)
        if (!actor) continue
        _b.copy(actor.group.position)
        _b.z += HEAL_BEAM_HEIGHT
        _dir.subVectors(_b, _a)
        _mid.addVectors(_a, _b).multiplyScalar(0.5)
        _side.subVectors(_mid, _cam).cross(_dir)
        if (_side.lengthSq() < 1e-6) continue
        const pxPerUnit = pxPerUnitAt(_mid, camera, size.height)
        const width = pxPerUnit > 0 ? Math.max(BEAM_WIDTH, BEAM_MIN_PX / pxPerUnit) : BEAM_WIDTH
        _side.normalize().multiplyScalar(width / 2)
        const o = counts[d.team] * 18
        const arr = pos.array as Float32Array
        // two triangles: a-s, a+s, b+s / a-s, b+s, b-s
        arr[o] = _a.x - _side.x; arr[o + 1] = _a.y - _side.y; arr[o + 2] = _a.z - _side.z
        arr[o + 3] = _a.x + _side.x; arr[o + 4] = _a.y + _side.y; arr[o + 5] = _a.z + _side.z
        arr[o + 6] = _b.x + _side.x; arr[o + 7] = _b.y + _side.y; arr[o + 8] = _b.z + _side.z
        arr[o + 9] = _a.x - _side.x; arr[o + 10] = _a.y - _side.y; arr[o + 11] = _a.z - _side.z
        arr[o + 12] = _b.x + _side.x; arr[o + 13] = _b.y + _side.y; arr[o + 14] = _b.z + _side.z
        arr[o + 15] = _b.x - _side.x; arr[o + 16] = _b.y - _side.y; arr[o + 17] = _b.z - _side.z
        counts[d.team]++
      }
    }
    for (const [geometry, mesh, n] of [[red, redMesh.current, counts.red], [blue, blueMesh.current, counts.blue]] as const) {
      geometry.setDrawRange(0, n * 6)
      if (n > 0) {
        geometry.attributes.position.needsUpdate = true
        geometry.computeBoundingSphere()
      }
      if (mesh) mesh.visible = n > 0
    }
  })

  return (
    <group name="dispenserBeams">
      <mesh ref={redMesh} geometry={red} material={basic(TEAM_FX.red, BEAM_OPACITY)} frustumCulled={false} visible={false} />
      <mesh ref={blueMesh} geometry={blue} material={basic(TEAM_FX.blue, BEAM_OPACITY)} frustumCulled={false} visible={false} />
    </group>
  )
})

// ─── carry boxes ──────────────────────────────────────────────────────────────

const CARRY_POOL = 6
/** The carried building's glyph badge beside the box: 14 units, kept between 24 and 40 px wide on screen. */
const CARRY_BADGE = { size: 14, minPx: 24, maxPx: 40, maxScale: 10, side: 14, order: 21 }
const _right = new THREE.Vector3()
const _cameraQuat = new THREE.Quaternion()

/**
 * A 16-unit TEAM_DARK box with a TEAM_FX top, behind the engineer at chest height while he carries a building, and
 * beside it the carried building's glyph on a round team token (label.ts), which keeps the carry readable from the
 * default RTS camera where the box is a few pixels wide.
 */
export const CarryBoxes = React.memo(({ tickRef }: { tickRef: TickRef }) => {
  const x = useExtras()
  const slots = useRef<(THREE.Group | null)[]>([])
  const badges = useRef<(THREE.Mesh | null)[]>([])
  // one material per badge slot: its texture follows the carried building's team and type
  const badgeMaterials = useMemo(
    () => Array.from({ length: CARRY_POOL }, () => new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false })),
    []
  )
  useEffect(() => () => badgeMaterials.forEach(m => m.dispose()), [badgeMaterials])

  useFrame(({ camera, size }) => {
    if (!x) return
    const tick = tickRef.current
    const pov = povRenderedEntityId()
    // world orientation: the POV camera sits inside an actor
    camera.getWorldQuaternion(_cameraQuat)
    _right.set(1, 0, 0).applyQuaternion(_cameraQuat)
    let used = 0
    for (const c of carriesAt(x, tick)) {
      if (used >= CARRY_POOL || c.entityId === pov) continue
      const actor = liveActor(c.p, c.entityId, tick)
      const team = baseTeam(c.p, tick)
      const slot = slots.current[used]
      const badge = badges.current[used]
      if (!actor || !team || !slot || !badge) continue
      _off.set(CARRY_BOX.offset[0], CARRY_BOX.offset[1], CARRY_BOX.offset[2] * actor.body.scale.z).applyQuaternion(actor.body.quaternion)
      slot.position.copy(actor.group.position).add(_off)
      slot.quaternion.copy(actor.body.quaternion)
      const [box, top] = slot.children as THREE.Mesh[]
      box.material = solid(TEAM_DARK[team])
      top.material = solid(TEAM_FX[team], 0.35)
      slot.userData.carry = { p: c.p, type: c.type }
      slot.visible = true

      // the badge: only when the carried building is known (its type picks the glyph)
      badge.visible = c.type >= 0 && c.type !== BUILDING_TYPE.SAPPER
      if (badge.visible) {
        const material = badgeMaterials[used]
        const texture = glyphBadgeTexture(team, glyphOf(c.type, c.mode))
        if (material.map !== texture) {
          material.map = texture
          material.needsUpdate = true
        }
        badge.position.copy(slot.position)
        const scale = screenScale(badge, camera, size.height, CARRY_BADGE.size, CARRY_BADGE.minPx, CARRY_BADGE.maxPx, CARRY_BADGE.maxScale)
        const half = (CARRY_BADGE.size * scale) / 2
        // beside the engineer from the camera's view, so it covers neither him nor his nameplate
        badge.position.addScaledVector(_right, CARRY_BADGE.side + half)
        badge.quaternion.copy(_cameraQuat)
        badge.scale.set(CARRY_BADGE.size * scale, CARRY_BADGE.size * scale, 1)
        badge.userData.badge = { p: c.p, type: c.type, mode: c.mode, team }
      }
      used++
    }
    for (let i = used; i < CARRY_POOL; i++) {
      if (slots.current[i]) slots.current[i]!.visible = false
      if (badges.current[i]) badges.current[i]!.visible = false
    }
  })

  const s = CARRY_BOX.size
  return (
    <group name="carryBoxes">
      {Array.from({ length: CARRY_POOL }, (_, i) => (
        <group key={i} ref={g => (slots.current[i] = g)} visible={false}>
          <mesh geometry={BOX} material={solid(TEAM_DARK.red)} scale={[s, s, s]} />
          <mesh geometry={BOX} material={solid(TEAM_FX.red)} position={[0, 0, s / 2 + 0.5]} scale={[s, s, 1]} />
        </group>
      ))}
      {Array.from({ length: CARRY_POOL }, (_, i) => (
        <mesh
          key={`badge-${i}`}
          name="carryBadge"
          ref={m => (badges.current[i] = m)}
          geometry={PLANE}
          material={badgeMaterials[i]}
          renderOrder={CARRY_BADGE.order}
          frustumCulled={false}
          visible={false}
        />
      ))}
    </group>
  )
})

// ─── blueprints ───────────────────────────────────────────────────────────────

const BLUEPRINT_POOL = 6
const lineMaterials = new Map<string, THREE.LineBasicMaterial>()
const lineMaterial = (color: string) => {
  let m = lineMaterials.get(color)
  if (!m) {
    m = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.75, depthWrite: false })
    lineMaterials.set(color, m)
  }
  return m
}

/**
 * builder.state 2 (placing) draws the hull of builder.type 64 units in front of the engineer at his feet,
 * TEAM_FX at 0.3; state 3 (invalid spot) in red. Hulls: sentry 40 x 40 x 66, dispenser 40 x 40 x 55,
 * teleporter 48 x 48 x 12.
 */
export const Blueprints = React.memo(({ tickRef }: { tickRef: TickRef }) => {
  const x = useExtras()
  const slots = useRef<(THREE.Group | null)[]>([])

  useFrame(() => {
    if (!x) return
    const tick = tickRef.current
    let used = 0
    for (const bp of blueprintsAt(x, tick)) {
      if (used >= BLUEPRINT_POOL) break
      const actor = liveActor(bp.p, bp.entityId, tick)
      const team = baseTeam(bp.p, tick)
      const slot = slots.current[used]
      const hull = HULLS[bp.type]
      if (!actor || !team || !slot || !hull) continue
      const color = bp.valid ? TEAM_FX[team] : INVALID
      _off.set(BLUEPRINT_DISTANCE, 0, 0).applyQuaternion(actor.body.quaternion)
      slot.position.copy(actor.group.position).add(_off)
      slot.quaternion.copy(actor.body.quaternion)
      const [box, edges] = slot.children as [THREE.Mesh, THREE.LineSegments]
      box.scale.set(hull[0], hull[1], hull[2])
      box.position.set(0, 0, hull[2] / 2)
      box.material = basic(color, 0.3)
      edges.scale.copy(box.scale)
      edges.position.copy(box.position)
      edges.material = lineMaterial(color)
      slot.userData.blueprint = { p: bp.p, type: bp.type, valid: bp.valid }
      slot.visible = true
      used++
    }
    for (let i = used; i < BLUEPRINT_POOL; i++) if (slots.current[i]) slots.current[i]!.visible = false
  })

  return (
    <group name="blueprints">
      {Array.from({ length: BLUEPRINT_POOL }, (_, i) => (
        <group key={i} ref={g => (slots.current[i] = g)} visible={false}>
          <mesh geometry={BOX} material={basic(TEAM_FX.red, 0.3)} />
          <lineSegments geometry={BOX_EDGES} material={lineMaterial(TEAM_FX.red)} />
        </group>
      ))}
    </group>
  )
})

// ─── destruction ──────────────────────────────────────────────────────────────

const BLAST_POOL = 6
const DEBRIS = 8
const GRAVITY = 800
const FLASH_RADIUS = 40
/** The fireball texture fades toward its rim, so the sprite spans this many radii for a visible radius of about 40. */
const FLASH_SPAN = 2.5
/** Smallest flash on screen (diameter, px), so a destroyed building registers from the default RTS camera. */
const FLASH_MIN_PX = 48
const SMALL_SCALE = 0.35

/**
 * `destroyed` and `detonated` events, age < 20 ticks: a fading flash of radius 40 plus 8 boxes (4 units) flying out
 * under gravity 800 with directions from hash(instance, i). Sappers get a small pop; a building destroyed while
 * carried blows up at its engineer. The flash is an additive fireball sprite (contract 1.5: glows are additive, no
 * depth write): a hot core in the flash colour with an orange rim, so it reads as a burst rather than as a flat disc.
 */
export const Destructions = React.memo(({ tickRef }: { tickRef: TickRef }) => {
  const x = useExtras()
  const slots = useRef<(THREE.Group | null)[]>([])
  // the flash fades per blast, so each slot owns its material
  const flashMaterials = useMemo(
    () =>
      Array.from(
        { length: BLAST_POOL },
        () => new THREE.SpriteMaterial({ map: getFlashTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
      ),
    []
  )
  useEffect(() => () => flashMaterials.forEach(m => m.dispose()), [flashMaterials])

  useFrame(({ camera, size }) => {
    if (!x) return
    const tickF = tickRef.current + useInstance.getState().frameProgress
    const dt = x.meta.intervalPerTick
    let used = 0
    for (const e of destructionsAt(x, tickF, basePosition)) {
      const slot = slots.current[used]
      if (used >= BLAST_POOL || !slot) break
      const a = e.age / DESTRUCTION_TICKS
      const scale = e.small ? SMALL_SCALE : 1
      slot.position.copy(e.pos)
      const [flash, ...debris] = slot.children as THREE.Mesh[]
      // it grows over the first third of the blast and fades over all of it
      const pxPerUnit = pxPerUnitAt(e.pos, camera, size.height)
      const minDiameter = pxPerUnit > 0 ? (FLASH_MIN_PX * Math.max(0.5, scale)) / pxPerUnit : 0
      const diameter = Math.max(minDiameter, FLASH_SPAN * FLASH_RADIUS * scale) * (0.55 + 0.45 * Math.min(1, a * 3))
      flash.scale.set(diameter, diameter, 1)
      flashMaterials[used].opacity = 1 - a
      const team: TeamKey = teamName(e.team) ?? 'red'
      const t = e.age * dt
      debris.forEach((box, i) => {
        const k = e.building * 16 + i
        const azimuth = 2 * Math.PI * hash(k + 0.13)
        const elevation = 0.25 + 0.6 * hash(k + 0.57)
        const speed = (200 + 180 * hash(k + 0.91)) * scale
        const vh = speed * Math.cos(elevation)
        box.position.set(Math.cos(azimuth) * vh * t, Math.sin(azimuth) * vh * t, speed * Math.sin(elevation) * t - 0.5 * GRAVITY * t * t * scale)
        box.rotation.set(t * 9 * hash(k + 1.3), t * 11 * hash(k + 2.1), t * 7 * hash(k + 3.7))
        box.scale.setScalar(4 * Math.max(0.5, scale))
        box.material = solid(i % 2 ? METAL : e.small ? DARK_METAL : TEAM_DARK[team])
        box.visible = true
      })
      slot.userData.blast = { building: e.building, tick: e.tick, age: e.age }
      slot.visible = true
      used++
    }
    for (let i = used; i < BLAST_POOL; i++) if (slots.current[i]) slots.current[i]!.visible = false
  })

  return (
    <group name="destructions">
      {Array.from({ length: BLAST_POOL }, (_, i) => (
        <group key={i} ref={g => (slots.current[i] = g)} visible={false}>
          <sprite name="flash" material={flashMaterials[i]} />
          {Array.from({ length: DEBRIS }, (_, k) => (
            <mesh key={k} geometry={BOX} material={solid(METAL)} />
          ))}
        </group>
      ))}
    </group>
  )
})
