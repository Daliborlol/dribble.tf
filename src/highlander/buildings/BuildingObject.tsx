// One placed building: sentry, dispenser or teleporter, with its sapper, wrangler shield, upgrade ring, range ring
// and status label (contract section 5 F2). Mounted by BuildingsLayer for every drawn instance; everything that
// changes per tick is applied in useFrame from buildingDraw() (render.ts), so the component renders once.

import React, { useMemo, useRef, type MutableRefObject } from 'react'

import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { Billboard } from '@react-three/drei'

import { BUILDING_TYPE } from '@highlander/extras/enums'
import { useExtras, useHlSetting } from '@highlander/extras/hooks'
import { useInstance } from '@zus/store'

import { BuildingLabel, glyphOf, LABEL_SIZE, minScreenScale } from './label'
import {
  ARC,
  ARC_SEGMENTS,
  ARROW,
  basic,
  BOX,
  bodyColor,
  CYL_X,
  CYL_Z,
  DARK_METAL,
  GAUGE,
  ghostOf,
  glowSprite,
  METAL,
  MUZZLE,
  OPEN_CYL,
  PIP_ON,
  PLANE,
  POD_DISCS,
  RANGE_RING,
  SAPPER_GLOW,
  SCREEN,
  solid,
  SPHERE,
  TEAM_FX,
  TELE_BLADES,
  TELE_RING,
  THIN_RING,
  TWIN_BARRELS,
  type TeamKey,
} from './parts'
import { buildingDraw, DISPENSER, LABEL_GAP, SAPPER, sapperOffset, SENTRY, TELEPORTER, type BuildingDraw } from './render'
import { MINI_SCALE, SENTRY_PIVOT } from './sentryAim'
import { enemyCentreResolver } from './scene'

const DEG = Math.PI / 180
/** Sentry range ring opacity (contract 0.12, raised: see the ring mesh). */
const RANGE_OPACITY = 0.25
/** Size of the sapper's electric spark sprite: large enough to read from the RTS camera. */
const SAPPER_SPARK = 30

export interface BuildingObjectProps {
  instance: number
  tickRef: MutableRefObject<number>
}

/** Swap the materials of every part mesh (userData.part) between the solid and the construction variant. */
function applyGhost(root: THREE.Object3D, ghost: boolean) {
  root.traverse(node => {
    const mesh = node as THREE.Mesh
    const base = mesh.userData?.part as THREE.Material | undefined
    if (!mesh.isMesh || !base) return
    mesh.material = ghost ? ghostOf(base) : base
  })
}

/** A part mesh: a shared geometry and a shared solid material that the construction state can swap. */
type PartProps = Omit<JSX.IntrinsicElements['mesh'], 'ref' | 'material' | 'userData'> & { mat: THREE.Material }
const Part = React.forwardRef<THREE.Mesh, PartProps>(({ mat, ...props }, ref) => (
  <mesh ref={ref} material={mat} userData={{ part: mat }} {...props} />
))

// ─── label ────────────────────────────────────────────────────────────────────

const LABEL_ORDER = 20
/**
 * Labels keep at least this many pixels of width: far from the camera (the default RTS view sits 2000 to 3500
 * units away) they grow like the HTML nameplates do, so every building stays findable and its glyph (about 23 px)
 * readable. Up close they keep their world size (scale 1).
 */
const LABEL_MIN_PX = 80
const LABEL_MAX_SCALE = 8
/** Width of the state frame around the label, units. */
const FRAME = 4
/** The label sits this far above its anchor in billboard space: its frame's bottom edge on the anchor. */
const LABEL_LIFT = LABEL_SIZE.height / 2 + FRAME
/** A hollow rectangle around the label (it tucks half a unit under the label's edge). */
const FRAME_GEOMETRY = (() => {
  const w = LABEL_SIZE.width / 2 + FRAME, h = LABEL_SIZE.height / 2 + FRAME
  const iw = LABEL_SIZE.width / 2 - 0.5, ih = LABEL_SIZE.height / 2 - 0.5
  const shape = new THREE.Shape([new THREE.Vector2(-w, -h), new THREE.Vector2(w, -h), new THREE.Vector2(w, h), new THREE.Vector2(-w, h)])
  shape.holes.push(new THREE.Path([new THREE.Vector2(-iw, -ih), new THREE.Vector2(-iw, ih), new THREE.Vector2(iw, ih), new THREE.Vector2(iw, -ih)]))
  return new THREE.ShapeGeometry(shape)
})()

interface LabelRefs {
  group: THREE.Group | null
  frame: THREE.Mesh | null
}

/**
 * The status billboard: one canvas quad (label.ts) and a frame behind it that shows two states from afar: a
 * flickering electric-blue frame while sapped, a steady team-coloured one while wrangled.
 */
function StatusLabel({ refs, label }: { refs: MutableRefObject<LabelRefs>; label: BuildingLabel }) {
  return (
    <Billboard ref={(g: THREE.Group | null) => (refs.current.group = g)}>
      {/* lifted in billboard space, so the label grows upward on screen from its anchor at any camera angle */}
      <group position={[0, LABEL_LIFT, 0]}>
        <mesh name="labelFrame" ref={m => (refs.current.frame = m)} geometry={FRAME_GEOMETRY} renderOrder={LABEL_ORDER - 1} visible={false} />
        <mesh name="label" geometry={PLANE} material={label.material} scale={[LABEL_SIZE.width, LABEL_SIZE.height, 1]} renderOrder={LABEL_ORDER} />
      </group>
    </Billboard>
  )
}

function updateLabel(
  refs: LabelRefs,
  label: BuildingLabel,
  d: BuildingDraw,
  frames: { sapped: THREE.MeshBasicMaterial; wrangled: THREE.Material },
  camera: THREE.Camera,
  viewportHeight: number
) {
  if (!refs.group) return
  refs.group.position.set(0, 0, d.labelZ)
  refs.group.scale.setScalar(minScreenScale(refs.group, camera, viewportHeight, LABEL_SIZE.width, LABEL_MIN_PX, LABEL_MAX_SCALE))
  if (refs.frame) {
    refs.frame.visible = !!d.sapper || d.wrangled
    refs.frame.userData.state = d.sapper ? 'sapped' : d.wrangled ? 'wrangled' : null
    if (d.sapper) {
      frames.sapped.opacity = 0.35 + 0.65 * d.sapper.opacity
      refs.frame.material = frames.sapped
    } else if (d.wrangled) refs.frame.material = frames.wrangled
  }
  label.update(d)
}

// ─── sentry ───────────────────────────────────────────────────────────────────

interface SentryRefs {
  post: THREE.Mesh | null
  yaw: THREE.Group | null
  pitch: THREE.Group | null
  l1: THREE.Group | null
  l23: THREE.Group | null
  pod: THREE.Group | null
  muzzle: THREE.Sprite | null
}

function SentryModel({ team, mini, refs }: { team: TeamKey; mini: boolean; refs: MutableRefObject<SentryRefs> }) {
  const body = solid(bodyColor(team, mini))
  const stripe = solid(TEAM_FX[team], 0.35)
  const t1 = SENTRY.turret[1], t2 = SENTRY.turret[2]
  const b1 = SENTRY.barrel[1]
  const pod = SENTRY.pod
  return (
    <group scale={mini ? MINI_SCALE : 1}>
      <Part geometry={BOX} mat={solid(DARK_METAL)} position={[0, 0, SENTRY.baseHeight / 2]} scale={[SENTRY.baseSize, SENTRY.baseSize, SENTRY.baseHeight]} />
      <Part ref={m => (refs.current.post = m)} geometry={CYL_Z} mat={solid(METAL)} />
      <group ref={g => (refs.current.yaw = g)}>
        <Part geometry={BOX} mat={body} position={[0, 0, -SENTRY.yoke.below + SENTRY.yoke.z / 2]} scale={[SENTRY.yoke.x, SENTRY.yoke.y, SENTRY.yoke.z]} />
        <group ref={g => (refs.current.pitch = g)}>
          {/* level 1 */}
          <group ref={g => (refs.current.l1 = g)}>
            <Part geometry={BOX} mat={body} scale={t1} />
            <Part geometry={BOX} mat={stripe} position={[0, 0, t1[2] / 2 + 0.25]} scale={[t1[0], t1[1] * 0.6, 0.5]} />
            <Part geometry={CYL_X} mat={solid(DARK_METAL)} position={[t1[0] / 2, 0, 0]} scale={[b1.length, b1.radius, b1.radius]} />
          </group>
          {/* levels 2 and 3 */}
          <group ref={g => (refs.current.l23 = g)} visible={false}>
            <Part geometry={BOX} mat={body} scale={t2} />
            <Part geometry={BOX} mat={stripe} position={[0, 0, t2[2] / 2 + 0.25]} scale={[t2[0], t2[1] * 0.6, 0.5]} />
            <Part geometry={TWIN_BARRELS} mat={solid(DARK_METAL)} position={[t2[0] / 2, 0, 0]} />
          </group>
          {/* level 3 rocket pod */}
          <group ref={g => (refs.current.pod = g)} position={[0, 0, pod.above]} visible={false}>
            <Part geometry={BOX} mat={body} scale={[pod.x, pod.y, pod.z]} />
            <Part geometry={BOX} mat={stripe} position={[0, 0, pod.z / 2 + 0.25]} scale={[pod.x, pod.y * 0.6, 0.5]} />
            <Part geometry={POD_DISCS} mat={solid(DARK_METAL)} position={[pod.x / 2 + 0.05, 0, 0]} />
          </group>
          <sprite ref={s => (refs.current.muzzle = s)} material={glowSprite(MUZZLE)} scale={[10, 10, 1]} visible={false} />
        </group>
      </group>
    </group>
  )
}

function updateSentry(refs: SentryRefs, d: BuildingDraw) {
  // inside the mini-scaled group the L1 pivot stays 32
  const level = d.mini ? 1 : d.level
  const pivot = SENTRY_PIVOT[level]
  const postTop = pivot - SENTRY.yoke.below
  if (refs.post) {
    const h = Math.max(0.1, postTop - SENTRY.baseHeight)
    refs.post.position.set(0, 0, SENTRY.baseHeight + h / 2)
    refs.post.scale.set(SENTRY.postRadius, SENTRY.postRadius, h)
  }
  if (refs.yaw) {
    refs.yaw.position.set(0, 0, pivot)
    refs.yaw.rotation.set(0, 0, (d.aim?.relYaw ?? 0) * DEG)
  }
  if (refs.pitch) refs.pitch.rotation.set(0, (d.aim?.pitch ?? 0) * DEG, 0)
  if (refs.l1) refs.l1.visible = level === 1
  if (refs.l23) refs.l23.visible = level >= 2
  if (refs.pod) refs.pod.visible = level >= 3
  if (refs.muzzle) {
    refs.muzzle.visible = d.muzzle >= 0
    if (d.muzzle >= 0) {
      if (level === 1) refs.muzzle.position.set(SENTRY.turret[1][0] / 2 + SENTRY.barrel[1].length, 0, 0)
      else refs.muzzle.position.set(SENTRY.turret[2][0] / 2 + SENTRY.barrel[2].length, SENTRY.barrel[2].offsets[d.muzzle] ?? 0, 0)
    }
  }
}

// ─── dispenser ────────────────────────────────────────────────────────────────

interface DispenserRefs {
  body: THREE.Mesh | null
  cap: THREE.Mesh | null
  stripe: THREE.Mesh | null
  screen: THREE.Mesh | null
  gauge: THREE.Mesh | null
}

function DispenserModel({ team, refs }: { team: TeamKey; refs: MutableRefObject<DispenserRefs> }) {
  const w = DISPENSER.width
  const c = DISPENSER.cap.size
  return (
    <group>
      <Part ref={m => (refs.current.body = m)} geometry={BOX} mat={solid(bodyColor(team))} />
      <Part ref={m => (refs.current.cap = m)} geometry={BOX} mat={solid(METAL)} scale={[c, c, DISPENSER.cap.height]} />
      {/* team stripe on the cap, like the sentry's: the metal cap is all the RTS camera sees from above */}
      <Part ref={m => (refs.current.stripe = m)} geometry={BOX} mat={solid(TEAM_FX[team], 0.35)} scale={[c, c * 0.4, 0.5]} />
      <Part ref={m => (refs.current.screen = m)} geometry={BOX} mat={solid(SCREEN)} position={[w / 2 + 0.5, 0, 0]} scale={[1, DISPENSER.screen.y, DISPENSER.screen.z]} />
      <Part ref={m => (refs.current.gauge = m)} geometry={BOX} mat={solid(GAUGE, 0.3)} position={[0, -w / 2 - 0.5, 0]} />
    </group>
  )
}

function updateDispenser(refs: DispenserRefs, d: BuildingDraw) {
  const h = d.height
  if (refs.body) {
    refs.body.position.set(0, 0, h / 2)
    refs.body.scale.set(DISPENSER.width, DISPENSER.width, h)
  }
  if (refs.cap) refs.cap.position.set(0, 0, h + DISPENSER.cap.height / 2)
  if (refs.stripe) refs.stripe.position.set(0, 0, h + DISPENSER.cap.height + 0.25)
  if (refs.screen) {
    refs.screen.position.z = h - DISPENSER.screen.below
    const mat = solid(SCREEN, d.screenOn ? 0.5 : 0)
    if (refs.screen.userData.part !== mat) {
      refs.screen.userData.part = mat
      refs.screen.material = d.ghost ? ghostOf(mat) : mat
    }
  }
  if (refs.gauge) {
    const gh = (h - DISPENSER.gauge.inset) * d.metalFrac
    refs.gauge.visible = gh > 0.05
    refs.gauge.position.z = DISPENSER.gauge.inset / 2 + gh / 2
    refs.gauge.scale.set(DISPENSER.gauge.width, 1, Math.max(0.05, gh))
  }
}

// ─── teleporter ───────────────────────────────────────────────────────────────

interface TeleporterRefs {
  blades: THREE.Group | null
  glow: THREE.Mesh | null
  arc: THREE.Mesh | null
}

function TeleporterModel({ team, mode, refs }: { team: TeamKey; mode: number; refs: MutableRefObject<TeleporterRefs> }) {
  const t = TELEPORTER
  // own copy of the arc: its draw range shows the recharge fraction
  const arc = useMemo(() => ARC.clone(), [])
  React.useEffect(() => () => arc.dispose(), [arc])
  const top = t.height
  return (
    <group>
      <Part geometry={CYL_Z} mat={solid(bodyColor(team))} position={[0, 0, top / 2]} scale={[t.radius, t.radius, top]} />
      <Part geometry={TELE_RING} mat={solid(TEAM_FX[team], 0.35)} position={[0, 0, t.ring.z]} />
      <group ref={g => (refs.current.blades = g)} position={[0, 0, top + t.blade[2] / 2]}>
        <Part geometry={TELE_BLADES} mat={solid(METAL)} />
      </group>
      {mode === 1 ? (
        <mesh geometry={CYL_Z} material={basic(TEAM_FX[team], 0.5)} position={[0, 0, top + t.beacon.height / 2]} scale={[t.beacon.radius, t.beacon.radius, t.beacon.height]} />
      ) : (
        <Part geometry={ARROW} mat={solid(TEAM_FX[team], 0.35)} position={[4, 0, top + 1]} scale={[1, 1, 0.2]} />
      )}
      <mesh ref={m => (refs.current.glow = m)} geometry={OPEN_CYL} material={basic(TEAM_FX[team], 0.15, true)} position={[0, 0, top]} scale={[t.glow.radius, t.glow.radius, t.glow.height]} visible={false} />
      {/* recharge arc in white, so it stands apart from the team ring under it */}
      <mesh ref={m => (refs.current.arc = m)} geometry={arc} material={basic(PIP_ON, 0.9)} position={[0, 0, top + 0.3]} visible={false} />
    </group>
  )
}

function updateTeleporter(refs: TeleporterRefs, d: BuildingDraw) {
  if (refs.blades) refs.blades.rotation.set(0, 0, d.spin * DEG)
  if (refs.glow) refs.glow.visible = d.readyGlow && !d.ghost
  if (refs.arc) {
    refs.arc.visible = d.recharge >= 0
    if (d.recharge >= 0) refs.arc.geometry.setDrawRange(0, 6 * Math.max(1, Math.round(d.recharge * ARC_SEGMENTS)))
  }
}

// ─── the building ─────────────────────────────────────────────────────────────

export const BuildingObject = React.memo(({ instance, tickRef }: BuildingObjectProps) => {
  const x = useExtras()
  const labels = useHlSetting<boolean>('buildings.labels')
  const sentryRange = useHlSetting<boolean>('buildings.sentryRange')

  const root = useRef<THREE.Group>(null)
  const body = useRef<THREE.Group>(null)
  const sapper = useRef<THREE.Group>(null)
  const sapperSprite = useRef<THREE.Sprite>(null)
  const shield = useRef<THREE.Mesh>(null)
  const upgrade = useRef<THREE.Mesh>(null)
  const range = useRef<THREE.Mesh>(null)
  const label = useRef<LabelRefs>({ group: null, frame: null })
  const sentryRefs = useRef<SentryRefs>({ post: null, yaw: null, pitch: null, l1: null, l23: null, pod: null, muzzle: null })
  const dispenserRefs = useRef<DispenserRefs>({ body: null, cap: null, stripe: null, screen: null, gauge: null })
  const teleRefs = useRef<TeleporterRefs>({ blades: null, glow: null, arc: null })
  const ghostApplied = useRef(false)

  const type = x ? x.buildings.type[instance] : -1
  const team: TeamKey = x && x.buildings.team[instance] === 2 ? 'red' : 'blue'
  const mini = !!x && x.buildings.mini[instance] !== 0
  const mode = x ? x.buildings.mode[instance] : 0

  // one flicker material per sapper sprite and per sapped-label frame (their opacity changes per tick)
  const sparkMaterial = useMemo(() => glowSprite(SAPPER_GLOW).clone(), [])
  const frames = useMemo(() => ({ sapped: basic(SAPPER_GLOW, 0.9, false, true).clone(), wrangled: basic(TEAM_FX[team], 0.95, false, true) }), [team])
  React.useEffect(
    () => () => {
      sparkMaterial.dispose()
      frames.sapped.dispose()
    },
    [sparkMaterial, frames]
  )

  // the status label's canvas, owned by this building (team, glyph and type never change for an instance)
  const labelCanvas = useMemo(() => (type < 0 ? null : new BuildingLabel(team, glyphOf(type, mode), type)), [team, type, mode])
  React.useEffect(() => () => labelCanvas?.dispose(), [labelCanvas])

  const enemyCentre = useMemo(() => enemyCentreResolver(), [])

  useFrame(({ camera, size }) => {
    const g = root.current
    if (!x || !g || !body.current) return
    const tickF = tickRef.current + useInstance.getState().frameProgress
    const d = buildingDraw(x, instance, tickF, { rangeRing: sentryRange, enemyCentre })
    g.visible = d.drawn
    // the transform follows the data even while hidden (carried), so the scene never keeps a stale pose
    if (Number.isFinite(d.pos.x)) g.position.copy(d.pos)
    g.rotation.set(0, 0, d.yaw * DEG)
    if (!d.drawn) return
    body.current.scale.set(1, 1, d.scaleZ)
    if (ghostApplied.current !== d.ghost) {
      ghostApplied.current = d.ghost
      applyGhost(body.current, d.ghost)
    }

    if (d.type === BUILDING_TYPE.SENTRY) updateSentry(sentryRefs.current, d)
    else if (d.type === BUILDING_TYPE.DISPENSER) updateDispenser(dispenserRefs.current, d)
    else if (d.type === BUILDING_TYPE.TELEPORTER) updateTeleporter(teleRefs.current, d)

    if (sapper.current) {
      sapper.current.visible = !!d.sapper
      if (d.sapper) {
        const [ox, oy, oz] = sapperOffset(d.type, d.level, d.mini)
        sapper.current.position.set(ox, oy, oz)
        sparkMaterial.opacity = d.sapper.opacity
      }
    }
    if (shield.current) {
      shield.current.visible = d.shield
      shield.current.position.set(0, 0, d.pivot)
    }
    if (upgrade.current) {
      upgrade.current.visible = d.upgradeRing >= 0
      if (d.upgradeRing >= 0) upgrade.current.position.set(0, 0, (d.labelZ - LABEL_GAP) * d.upgradeRing)
    }
    if (range.current) range.current.visible = d.rangeRing
    if (labelCanvas) updateLabel(label.current, labelCanvas, d, frames, camera, size.height)
  })

  if (!x || type < 0) return null
  const upgradeRadius = type === BUILDING_TYPE.TELEPORTER ? 28 : type === BUILDING_TYPE.SENTRY ? 22 : 19
  return (
    <group ref={root} name="building" userData={{ instance }} visible={false}>
      <group ref={body}>
        {type === BUILDING_TYPE.SENTRY && <SentryModel team={team} mini={mini} refs={sentryRefs} />}
        {type === BUILDING_TYPE.DISPENSER && <DispenserModel team={team} refs={dispenserRefs} />}
        {type === BUILDING_TYPE.TELEPORTER && <TeleporterModel team={team} mode={mode} refs={teleRefs} />}
        <group ref={sapper} visible={false}>
          <Part geometry={BOX} mat={solid(DARK_METAL)} scale={SAPPER.size} />
          <sprite ref={sapperSprite} material={sparkMaterial} position={[0, SAPPER.size[1] / 2 + 2, 0]} scale={[SAPPER_SPARK, SAPPER_SPARK, 1]} />
        </group>
      </group>
      {type === BUILDING_TYPE.SENTRY && (
        <>
          <mesh ref={shield} geometry={SPHERE} material={basic(TEAM_FX[team], 0.18, true)} scale={45} visible={false} />
          {/* an overlay, not depth-tested: at the sentry's base height the flat ring runs through hills and walls, and
              at the contract's 0.12 opacity it vanished on the map ground (it is an opt-in setting) */}
          <mesh ref={range} geometry={RANGE_RING} material={basic(TEAM_FX[team], RANGE_OPACITY, false, true)} position={[0, 0, 2]} visible={false} />
        </>
      )}
      <mesh ref={upgrade} geometry={THIN_RING} material={basic(TEAM_FX[team], 0.8, true)} scale={upgradeRadius} visible={false} />
      {labels && labelCanvas && <StatusLabel refs={label} label={labelCanvas} />}
    </group>
  )
})
