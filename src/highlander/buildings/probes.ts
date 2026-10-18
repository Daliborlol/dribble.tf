// Debug-bridge probes of the buildings layer (contract section 3.10): window.__dribble.hl.probe('buildings.at', tick)
// and friends. Registered when BuildingsLayer loads. Ticks are cache ticks (default: the current renderTick).

import * as THREE from 'three'

import { registerHlProbe } from '@highlander/debug'
import { getHlSetting } from '@highlander/extras/hooks'
import { trackIndexAt } from '@highlander/extras/track'
import { useInstance } from '@zus/store'

import { buildingInstancesAt, buildingsAt, buildingsOf, type BuildingView } from './model'
import { blueprintsAt, buildingDraw, carriesAt, destructionsAt, drawnInstancesAt, sentryMuzzleAt, tracerBarrel, type BuildingDraw } from './render'
import { basePosition, enemyCentreResolver, povLabelContext, povRenderedEntityId, readyExtras, renderTickNow } from './scene'
import * as aim from './sentryAim'

const TYPE_NAMES = ['dispenser', 'teleporter', 'sentry', 'sapper']
const r1 = (v: number) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null)
const r3 = (v: number) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null)
const vec = (v: { x: number; y: number; z: number }) => [r1(v.x), r1(v.y), r1(v.z)]

function viewJson(v: BuildingView) {
  return { ...v, typeName: TYPE_NAMES[v.type] ?? String(v.type), built: r3(v.built), rechargeLeft: r3(v.rechargeLeft), pos: vec(v.pos), yaw: r1(v.yaw) }
}

const _muzzle = new THREE.Vector3()

/** The muzzle flash's barrel tip from sentryMuzzleAt (the scene probe reports where the sprite really is). */
function muzzleWorld(d: BuildingDraw, tickF: number, enemyCentre: aim.EnemyCentre) {
  const x = readyExtras()
  if (!x || d.muzzle < 0 || !sentryMuzzleAt(x, d.instance, tickF, d.muzzle, _muzzle, enemyCentre)) return null
  return vec(_muzzle)
}

function drawJson(d: BuildingDraw, tickF: number, enemyCentre: aim.EnemyCentre) {
  return {
    instance: d.instance,
    typeName: TYPE_NAMES[d.type] ?? String(d.type),
    team: d.team,
    mode: d.mode,
    mini: d.mini,
    drawn: d.drawn,
    reason: d.reason,
    pos: vec(d.pos),
    yaw: r1(d.yaw),
    level: d.level,
    builtFrac: r3(d.builtFrac),
    scaleZ: r3(d.scaleZ),
    opacity: d.ghost ? 0.55 : 1,
    health: d.health,
    maxHealth: d.maxHealth,
    labelZ: r1(d.labelZ),
    aim: d.aim && { relYaw: r1(d.aim.relYaw), pitch: r1(d.aim.pitch), source: d.aim.source },
    shellsFrac: r3(d.shellsFrac),
    rocketsFrac: r3(d.rocketsFrac),
    shield: d.shield,
    wrangled: d.wrangled,
    muzzle: d.muzzle,
    muzzleWorld: muzzleWorld(d, tickF, enemyCentre),
    rangeRing: d.rangeRing,
    height: d.height,
    metalFrac: r3(d.metalFrac),
    screenOn: d.screenOn,
    beams: d.beams,
    teleState: d.teleState,
    spin: r1(d.spin),
    readyGlow: d.readyGlow,
    recharge: r3(d.recharge),
    upgradeRing: r3(d.upgradeRing),
    sapper: d.sapper && { instance: d.sapper.instance, opacity: r3(d.sapper.opacity) },
    sapped: d.sapped,
    disabled: d.disabled,
  }
}

const notReady = () => ({ error: 'extras not ready', status: useInstance.getState().extrasStatus })

/** BuildingView[] at a cache tick (section 6.5), JSON-safe: every alive instance, map-placed and sappers included. */
registerHlProbe('buildings.at', (tick?: number) => {
  const x = readyExtras()
  if (!x) return notReady()
  return buildingsAt(x, Math.max(0, Math.floor(tick ?? renderTickNow()))).map(viewJson)
})

/** buildingsOf(p, tick). */
registerHlProbe('buildings.of', (p: number, tick?: number) => {
  const x = readyExtras()
  if (!x) return notReady()
  return buildingsOf(x, p, Math.max(0, Math.floor(tick ?? renderTickNow()))).map(viewJson)
})

/**
 * What the layer draws at a (fractional) cache tick: whether the layer is on, every alive building with its draw
 * state (hidden ones with their reason), carried-building boxes, blueprints and destruction blasts.
 */
registerHlProbe('buildings.draw', (tickArg?: number) => {
  const x = readyExtras()
  if (!x) return notReady()
  const tickF = Math.max(0, tickArg ?? renderTickNow())
  const tick = Math.floor(tickF)
  const pov = povRenderedEntityId()
  // the same inputs as BuildingObject, so the AIM_AT_ENEMY fallback reports what the scene draws at this tick
  const enemyCentre = enemyCentreResolver()
  const rangeRing = getHlSetting<boolean>('buildings.sentryRange')
  return {
    tick: tickF,
    layer: {
      enabled: getHlSetting<boolean>('enabled') !== false,
      buildings: getHlSetting<boolean>('buildings.enabled') !== false,
      available: !!x.meta.available.buildings,
      labels: getHlSetting<boolean>('buildings.labels'),
      sentryRange: rangeRing,
      blueprints: getHlSetting<boolean>('buildings.blueprints'),
    },
    // the POV subject whose own building labels hide (null outside POV)
    pov: povLabelContext(x, tick),
    mounted: drawnInstancesAt(x, tick),
    buildings: buildingInstancesAt(x, tick).map(j => drawJson(buildingDraw(x, j, tickF, { rangeRing, enemyCentre }), tickF, enemyCentre)),
    carries: carriesAt(x, tick).map(c => ({ ...c, povHidden: c.entityId === pov })),
    blueprints: blueprintsAt(x, tick),
    destructions: destructionsAt(x, tickF, basePosition).map(e => ({ building: e.building, type: e.type, tick: e.tick, age: r1(e.age), carried: e.carried, small: e.small, pos: vec(e.pos) })),
    aimCalibration: { YAW_RANGE: aim.YAW_RANGE, YAW_SIGN: aim.YAW_SIGN, YAW_OFFSET: aim.YAW_OFFSET, PITCH_RANGE: aim.PITCH_RANGE, PITCH_SIGN: aim.PITCH_SIGN, PITCH_OFFSET: aim.PITCH_OFFSET, AIM_AT_ENEMY: aim.AIM_AT_ENEMY },
  }
})

/**
 * A sentry tracer row's start as other layers would take it from F2: the barrel the row flashes (tracerBarrel) and
 * that barrel's tip at the tracer's tick (sentryMuzzleAt).
 */
registerHlProbe('buildings.tracerMuzzle', (row: number) => {
  const x = readyExtras()
  if (!x) return notReady()
  const tr = x.tempents.tracers
  if (!(row >= 0 && row < tr.tick.length)) return { error: 'no such row', rows: tr.tick.length }
  const j = tr.sentry[row]
  const barrel = tracerBarrel(x, row)
  const ok = barrel >= 0 && sentryMuzzleAt(x, j, tr.tick[row], barrel, _muzzle, enemyCentreResolver())
  return { row, tick: tr.tick[row], sentry: j === 65535 ? -1 : j, barrel, muzzle: ok ? vec(_muzzle) : null }
})

/**
 * Distinct instances that buildingsAt lists over the demo, by type, scanning every `stride`-th tick (default 1),
 * plus the map-placed ones and the most buildings alive at once.
 */
registerHlProbe('buildings.summary', (stride = 1) => {
  const x = readyExtras()
  if (!x) return notReady()
  const seen = new Set<number>()
  let maxAlive = 0
  const step = Math.max(1, Math.floor(stride))
  for (let t = 0; t < x.meta.ticks; t += step) {
    const alive = buildingInstancesAt(x, t)
    if (alive.length > maxAlive) maxAlive = alive.length
    for (const j of alive) seen.add(j)
  }
  const byType: Record<string, number> = {}
  let mapPlaced = 0
  for (const j of seen) {
    if (x.buildings.mapPlaced[j]) mapPlaced++
    const name = `${x.buildings.mapPlaced[j] ? 'mapPlaced ' : ''}${TYPE_NAMES[x.buildings.type[j]] ?? x.buildings.type[j]}`
    byType[name] = (byType[name] ?? 0) + 1
  }
  return { instances: x.buildings.count, seen: seen.size, byType, mapPlaced, maxAlive, stride: step }
})

/** Samples of one instance over [from, to): the values the acceptance checks follow (construction, level, carry). */
registerHlProbe('buildings.track', (instance: number, from: number, to: number, step = 1) => {
  const x = readyExtras()
  if (!x) return notReady()
  const rows = []
  for (let t = Math.max(0, from); t < Math.min(to, x.meta.ticks); t += Math.max(1, step)) {
    const d = buildingDraw(x, instance, t)
    const si = trackIndexAt(x.buildings.state, instance, t)
    rows.push({
      tick: t,
      drawn: d.drawn,
      reason: d.reason,
      level: d.level,
      health: d.health,
      maxHealth: d.maxHealth,
      built: si < 0 ? null : r3(x.buildings.state.built[si] / 255),
      scaleZ: r3(d.scaleZ),
      opacity: d.ghost ? 0.55 : 1,
      sapper: !!d.sapper,
      shield: d.shield,
    })
  }
  return rows
})

/** What is actually in the scene: the mounted building groups and the visible effect slots, with world positions. */
registerHlProbe('buildings.scene', () => {
  const scene = useInstance.getState().threeScene
  const root = scene?.getObjectByName('buildings')
  if (!root) return { mounted: false }
  const visibleChain = (node: THREE.Object3D) => {
    for (let n: THREE.Object3D | null = node; n; n = n.parent) if (!n.visible) return false
    return true
  }
  const world = (node: THREE.Object3D) => vec(node.getWorldPosition(new THREE.Vector3()))
  const buildings: unknown[] = []
  root.traverse(node => {
    if (node.name !== 'building') return
    const meshes: number[] = [0, 0]
    node.traverse(m => {
      if ((m as THREE.Mesh).isMesh || (m as THREE.Sprite).isSprite) meshes[visibleChain(m) ? 0 : 1]++
    })
    const label = node.getObjectByName('label')
    const frame = node.getObjectByName('labelFrame')
    const muzzle = node.getObjectByName('muzzle')
    const sapper = node.getObjectByName('sapper')
    const nodeVisible = visibleChain(node)
    const labelVisible = !!label && visibleChain(label)
    // label -> lift group -> drei Billboard's inner group -> the outer group BuildingObject scales and fades
    const billboard = label?.parent?.parent?.parent
    buildings.push({
      instance: node.userData.instance,
      visible: nodeVisible,
      pos: world(node),
      visibleMeshes: meshes[0],
      hiddenMeshes: meshes[1],
      // a hidden label (carried building, POV) keeps whatever scale it last had, so only a drawn one reports it;
      // `hidden` says why a drawn building shows no label ('povOwn' or 'povNear')
      label: label
        ? {
            visible: labelVisible,
            scale: labelVisible ? r3(billboard?.scale.x ?? 1) : null,
            opacity: labelVisible ? r3(billboard?.userData.opacity ?? 1) : null,
            hidden: nodeVisible && !labelVisible ? billboard?.userData.hidden ?? null : null,
            frame: frame && visibleChain(frame) ? frame.userData.state ?? null : null,
          }
        : null,
      muzzle: muzzle && visibleChain(muzzle) ? world(muzzle) : null,
      sapper: sapper && visibleChain(sapper) ? world(sapper) : null,
    })
  })
  const slots = (name: string, key: string) => {
    const group = root.getObjectByName(name)
    if (!group) return []
    return group.children.filter(c => c.visible && c.userData[key]).map(c => ({ ...c.userData[key], pos: world(c) }))
  }
  const beams = root.getObjectByName('dispenserBeams')
  return {
    mounted: true,
    visible: visibleChain(root),
    buildings,
    carries: slots('carryBoxes', 'carry'),
    carryBadges: (root.getObjectByName('carryBoxes')?.children ?? [])
      .filter(c => c.visible && c.userData.badge)
      .map(c => ({ ...c.userData.badge, pos: world(c), size: r1(c.scale.x) })),
    blueprints: slots('blueprints', 'blueprint'),
    blasts: slots('destructions', 'blast'),
    beams: beams ? beams.children.map(m => ((m as THREE.Mesh).visible ? ((m as THREE.Mesh).geometry.drawRange.count / 6) : 0)) : [],
  }
})
