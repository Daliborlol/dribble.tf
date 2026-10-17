// F3 probes for the debug bridge (contract 3.10 and 5 F3). Imported for its side effects by both F3 layers and by
// Projectiles.tsx. Every probe returns JSON-safe data; tick arguments are cache ticks (default: the frame's tick).

import * as THREE from 'three'

import { getState, useInstance } from '@zus/store'
import { registerHlProbe } from '@highlander/debug'
import { getHlSetting } from '@highlander/extras/hooks'

import { combatEffectsAt, readCombatSettings } from './combatData'
import { baseRecord, combatRecord, extrasRecord, pointList, roundVec, type DrawnTrail, type Vec3 } from './frameRecord'
import { deflectIndexAt, positionAt, projectilesDrawnAt, projectilesDrawnIn, projectileTeamAt } from './projectileData'
import { getProjectileSource, projectileSourceStats } from './projectileSource'
import { frameTime, readyExtras } from './time'
import { ROCKET_TRAIL_SAMPLES, SMOKE_TICKS, TRAIL_SAMPLES, forEachSmokePuff, trailPoints, trailStyle } from './trails'
import { playerViewAt, povCameraOwner } from './view'

const _p = new THREE.Vector3()

function context() {
  const x = readyExtras()
  const demo = useInstance.getState().parsedDemo
  return x && demo ? { x, demo } : null
}

function tickArg(tick: unknown): { tick: number; tickF: number } {
  if (typeof tick === 'number' && Number.isFinite(tick)) return { tick: Math.floor(tick), tickF: tick }
  return frameTime()
}

/** True when Projectiles.tsx draws its projectiles from the extras (contract 5 F3 edits 1 to 3). */
export function baseExtrasMode(): boolean {
  const x = readyExtras()
  return !!x && getHlSetting<boolean>('enabled') !== false && x.meta.available.projectiles
}

/** Every instance drawn at the tick (created <= tick < hidden). */
registerHlProbe('projectiles.at', (tick?: number) => {
  const c = context()
  if (!c) return { error: 'extras not ready' }
  const { x, demo } = c
  const t = tickArg(tick)
  const source = getProjectileSource(x, demo)
  const pj = x.projectiles
  return projectilesDrawnAt(x, t.tick).map(j => {
    const ok = positionAt(x, j, t.tickF, _p)
    const d = deflectIndexAt(x, j, t.tick)
    return {
      instance: j,
      entityId: pj.entityId[j],
      kind: pj.kind[j],
      pos: ok ? roundVec(_p.x, _p.y, _p.z) : null,
      crit: pj.crit[j] !== 0,
      deflected: d >= 0,
      team: projectileTeamAt(x, j, t.tick),
      source: source.servedByBase[j] ? 'base' : 'extras',
      baseType: source.baseType[j],
      created: pj.created[j],
      hidden: pj.hidden[j],
    }
  })
})

/** The source split: how many instances the base cache serves, and the kind-table mismatches. */
registerHlProbe('projectiles.source', () => {
  const c = context()
  if (!c) return { error: 'extras not ready' }
  const source = getProjectileSource(c.x, c.demo)
  let served = 0
  for (let j = 0; j < source.servedByBase.length; j++) served += source.servedByBase[j]
  return { count: c.x.projectiles.count, served, mismatches: source.mismatches, stats: projectileSourceStats(source) ?? null }
})

function dataTrails(tick: number, tickF: number): DrawnTrail[] {
  const c = context()
  if (!c) return []
  const { x, demo } = c
  const source = getProjectileSource(x, demo)
  const out: DrawnTrail[] = []
  const points = new Float32Array((ROCKET_TRAIL_SAMPLES + 2) * 3)
  const extrasOn = getHlSetting<boolean>('projectiles.extraTypes') !== false && getHlSetting<boolean>('enabled') !== false
  const baseOn = baseExtrasMode()
  for (const j of projectilesDrawnAt(x, tick)) {
    const base = source.servedByBase[j] === 1
    if (base ? !baseOn : !extrasOn) continue
    const samples = base && source.baseType[j] === 1 ? ROCKET_TRAIL_SAMPLES : TRAIL_SAMPLES
    const count = trailPoints(x, j, tickF, samples, points)
    if (count < 2) continue
    const style = trailStyle(x, j, tick)
    out.push({ key: `${base ? 'base' : 'extras'}:${j}`, instance: j, source: base ? 'base' : 'extras', width: style.width, color: style.color, points: pointList(points, count) })
  }
  return out
}

/**
 * Trail point lists at a tick, computed from the samples (`data`) and as drawn in the last frame (`drawn`, from
 * the layers' frame records; only when that frame rendered the same tickF). `match` compares the two.
 */
registerHlProbe('projectiles.trails', (tick?: number) => {
  const c = context()
  if (!c) return { error: 'extras not ready' }
  const t = tickArg(tick)
  const data = dataTrails(t.tick, t.tickF)
  const sameFrame = (r: { tickF: number }) => r.tickF === t.tickF
  const drawn = [...(sameFrame(baseRecord) ? baseRecord.trails : []), ...(sameFrame(extrasRecord) ? extrasRecord.trails : [])]
  const key = (list: DrawnTrail[]) => JSON.stringify(list.map(d => [d.key, d.width, d.color, d.points]).sort())
  // smoke puffs of base rockets (count and a positional checksum)
  let smoke = 0
  let smokeSum = 0
  if (baseExtrasMode()) {
    const source = getProjectileSource(c.x, c.demo)
    for (const j of projectilesDrawnIn(c.x, t.tick - SMOKE_TICKS + 1, t.tick)) {
      if (!source.servedByBase[j] || source.baseType[j] !== 1) continue
      forEachSmokePuff(c.x, j, t.tickF, (px, py, pz, size, opacity) => {
        smoke++
        smokeSum += px + py + pz + size + opacity
      })
    }
  }
  return {
    tick: t.tick,
    tickF: t.tickF,
    baseMode: baseExtrasMode() ? 'extras' : 'legacy',
    data,
    drawn: sameFrame(baseRecord) || sameFrame(extrasRecord) ? drawn : null,
    match: sameFrame(baseRecord) || sameFrame(extrasRecord) ? key(data) === key(drawn) : null,
    smoke: { data: smoke, drawn: sameFrame(baseRecord) ? baseRecord.smoke : null, checksum: Math.round(smokeSum * 100) / 100 },
  }
})

/** Scene meshes per projectile entity id in the last frame: base groups (Projectiles.tsx) and extras instances. */
registerHlProbe('projectiles.meshes', (entityId?: number) => {
  const c = context()
  const scene = useInstance.getState().threeScene
  const counts = new Map<number, { entityId: number; base: number; legacy: number; extras: number; names: string[] }>()
  const row = (e: number) => {
    let r = counts.get(e)
    if (!r) counts.set(e, (r = { entityId: e, base: 0, legacy: 0, extras: 0, names: [] }))
    return r
  }
  scene?.traverse(node => {
    const data = node.userData as { hlProjectile?: 'base' | 'legacy'; entityId?: number }
    if (!data?.hlProjectile || typeof data.entityId !== 'number') return
    let visible = true
    for (let n: THREE.Object3D | null = node; n; n = n.parent) if (!n.visible) visible = false
    if (!visible) return
    const r = row(data.entityId)
    r[data.hlProjectile]++
    r.names.push(node.name)
  })
  if (c) for (const j of extrasRecord.meshes.keys()) row(c.x.projectiles.entityId[j]).extras++
  const rows = Array.from(counts.values()).sort((a, b) => a.entityId - b.entityId)
  return entityId === undefined ? rows : rows.filter(r => r.entityId === entityId)
})

/** Active combat effects at a tick with their ages (pure, base-data player anchors). */
registerHlProbe('combat.fx', (tick?: number) => {
  const c = context()
  if (!c) return { error: 'extras not ready' }
  const t = tickArg(tick)
  const fx = combatEffectsAt(c.x, c.demo, getProjectileSource(c.x, c.demo), t.tickF, (p, tickF, out) => playerViewAt(c.demo, p, tickF, out), povCameraOwner(), readCombatSettings())
  return {
    ...fx,
    counts: Object.fromEntries(Object.entries(fx).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as unknown[]).length])),
    drawn: combatRecord.tickF === t.tickF ? { ...combatRecord.counts } : null,
    playing: getState().playback.playing,
  }
})

/**
 * Crit glows of the last frame with their mesh positions: base-drawn glows are children of the projectile group
 * (world positions of both), extras-drawn glows come from the two layers' frame records.
 */
registerHlProbe('combat.critGlow', () => {
  const rows: { source: 'base' | 'extras'; entityId: number; instance: number; glow: Vec3; mesh: Vec3; dist: number }[] = []
  const scene = useInstance.getState().threeScene
  const gw = new THREE.Vector3()
  const mw = new THREE.Vector3()
  scene?.traverse(node => {
    if (node.name !== 'hl-crit-glow' || !node.parent) return
    let visible = true
    for (let n: THREE.Object3D | null = node; n; n = n.parent) if (!n.visible) visible = false
    if (!visible) return
    node.getWorldPosition(gw)
    node.parent.getWorldPosition(mw)
    const data = node.parent.userData as { entityId?: number; hlInstance?: number }
    rows.push({ source: 'base', entityId: data.entityId ?? -1, instance: data.hlInstance ?? -1, glow: roundVec(gw.x, gw.y, gw.z), mesh: roundVec(mw.x, mw.y, mw.z), dist: Math.round(gw.distanceTo(mw) * 1000) / 1000 })
  })
  const c = context()
  if (c && combatRecord.tickF === extrasRecord.tickF) {
    for (const [j, glow] of combatRecord.glows) {
      const mesh = extrasRecord.meshes.get(j)
      if (!mesh) continue
      const dist = Math.hypot(glow[0] - mesh[0], glow[1] - mesh[1], glow[2] - mesh[2])
      rows.push({ source: 'extras', entityId: c.x.projectiles.entityId[j], instance: j, glow, mesh, dist: Math.round(dist * 1000) / 1000 })
    }
  }
  return { tickF: frameTime().tickF, rows, maxDist: rows.reduce((m, r) => Math.max(m, r.dist), 0) }
})
