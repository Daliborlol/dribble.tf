// F1 debug-bridge probes (contract sections 3.10 and 5 F1), registered when PlayerFxLayer loads:
//   fx.actor(entityId, tick?)  the ActorFx plus inv, invE, the disguise view in effect and what the scene draws
//   fx.overlays(tick?)         [{ entityId, name, effects, drawn }] for every mounted actor
//   fx.plates()                the Highlander nameplate items in the DOM (name shown, badge, tags, bars)
// `tick` is a cache tick (default: the current renderTick). The computed parts are pure functions of the tick;
// `rendered` and `drawn` read the live scene, so evaluate them after seeking and a few frames.

import * as THREE from 'three'

import { getState, useInstance } from '@zus/store'
import { registerHlProbe } from '@highlander/debug'
import { HL } from '@highlander/extras/enums'
import { getActor, allActors } from '@highlander/scene/actorRegistry'

import { actorAt, type ActorInputs } from './actorState'
import { readFxSettings } from './fxSettings'
import { overlayNames } from './fxState'
import { currentPovSubject, povCameraOwnerEntityId, povInfoOf } from './pov'
import type { OverlayRig } from './overlayRig'

const HL_NAMES = Object.keys(HL) as (keyof typeof HL)[]
const flagNames = (flags: number) => HL_NAMES.filter(name => (flags & HL[name]) !== 0)

/** NaN and infinities become null so results cross page.evaluate() as JSON. */
function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v)))
}

const round = (v: number, digits = 4) => Math.round(v * 10 ** digits) / 10 ** digits
const renderTickNow = () => Math.max(1, (getState().playback.tick ?? 1) - 2)

/** Rigs mounted by PlayerFxLayer, by entity id (only for the probes). */
export const mountedRigs = new Map<number, OverlayRig>()

function inputsAt(tick: number): ActorInputs | { error: string } {
  const { extras, extrasStatus, parsedDemo } = useInstance.getState()
  if (extrasStatus !== 'ready' || !extras || !parsedDemo) return { error: `extras not ready (${extrasStatus})` }
  return {
    x: extras,
    demo: parsedDemo,
    settings: readFxSettings(),
    pov: povInfoOf(parsedDemo, currentPovSubject(extras, parsedDemo, tick), tick),
    povOwner: povCameraOwnerEntityId(),
  }
}

type EmissiveMaterial = THREE.Material & { emissive?: THREE.Color; emissiveIntensity?: number; opacity: number }

/** What the scene draws for the actor's model right now: visibility, material state, body scale. */
function renderedModel(entityId: number) {
  const handles = getActor(entityId)
  if (!handles) return null
  let mesh: THREE.Mesh | undefined
  handles.body.traverse(node => {
    if (!mesh && (node as THREE.Mesh).isMesh) mesh = node as THREE.Mesh
  })
  if (!mesh) return { mounted: false, bodyScaleZ: round(handles.body.scale.z) }
  let visible = true
  for (let n: THREE.Object3D | null = mesh; n; n = n.parent) {
    if (!n.visible) visible = false
    if (n === handles.group) break
  }
  // the body material ('.../spy/spy_blue'): heads and eyeballs share names across team models
  const materials: EmissiveMaterial[] = []
  handles.body.traverse(node => {
    const m = (node as THREE.Mesh).material
    if (!m) return
    for (const material of Array.isArray(m) ? m : [m]) materials.push(material as EmissiveMaterial)
  })
  const teamMaterial = (m: EmissiveMaterial) => /_(red|blue)(\.\d+)?$/.test(m.name)
  const material =
    materials.find(m => teamMaterial(m) && !m.name.includes('head')) ?? materials.find(teamMaterial) ?? materials[0]
  return {
    mounted: true,
    visible,
    material: material?.name ?? null,
    opacity: material ? round(material.opacity) : null,
    transparent: material?.transparent ?? null,
    depthWrite: material?.depthWrite ?? null,
    emissive: material?.emissive ? `#${material.emissive.getHexString()}` : null,
    emissiveIntensity: material?.emissiveIntensity !== undefined ? round(material.emissiveIntensity) : null,
    bodyScaleZ: round(handles.body.scale.z),
  }
}

registerHlProbe('fx.actor', (entityId: number, tickArg?: number) => {
  const tick = Math.max(0, Math.floor(tickArg ?? renderTickNow()))
  const inputs = inputsAt(tick)
  if ('error' in inputs) return inputs
  const id = Number(entityId)
  const at = actorAt(inputs, id, tick, true)
  if (!at) return { error: `no extras player for entity ${entityId}` }
  const { state } = at
  const name = inputs.demo.entityPlayerMap.get(at.p)?.user.name ?? null
  return jsonSafe({
    entityId: id,
    p: at.p,
    name,
    tick,
    classId: at.classId,
    team: at.team,
    health: at.health,
    drawn: at.drawn,
    fx: state.fx,
    inv: round(state.inv),
    invE: round(state.invE),
    view: state.view,
    viewSetting: inputs.settings.disguiseView,
    enemy: state.enemy,
    drawnAsDisguise: state.drawnAsDisguise,
    cloaked: state.cloaked,
    flags: flagNames(state.flags),
    disguise: state.disguise,
    pov: inputs.pov,
    povOwner: inputs.povOwner ?? null,
    overlays: overlayNames(at.overlays, tick),
    rendered: tick === renderTickNow() ? renderedModel(id) : null,
  })
})

registerHlProbe('fx.overlays', (tickArg?: number) => {
  const tick = Math.max(0, Math.floor(tickArg ?? renderTickNow()))
  const inputs = inputsAt(tick)
  if ('error' in inputs) return inputs
  const live = tick === renderTickNow()
  const rows = []
  for (const handles of allActors()) {
    const at = actorAt(inputs, handles.entityId, tick, false)
    rows.push({
      entityId: handles.entityId,
      name: at ? inputs.demo.entityPlayerMap.get(at.p)?.user.name ?? null : null,
      effects: at ? overlayNames(at.overlays, tick) : [],
      drawn: live ? mountedRigs.get(handles.entityId)?.visibleParts() ?? null : null,
    })
  }
  rows.sort((a, b) => a.entityId - b.entityId)
  return jsonSafe(rows)
})

registerHlProbe('fx.plates', () => {
  if (typeof document === 'undefined') return []
  return Array.from(document.querySelectorAll<HTMLElement>('[data-hl-plate]')).map(el => {
    // Actors.tsx sets the distance fade and the extra opacity on the drei Html wrapper around the plate
    let opacity = 1
    for (let n: HTMLElement | null = el; n && n !== document.body; n = n.parentElement) {
      const o = n.style.opacity
      if (o !== '') opacity *= Number(o)
    }
    return {
      name: el.dataset.hlName ?? null,
      shown: el.dataset.hlShown ?? null,
      team: el.dataset.hlTeam ?? null,
      classId: Number(el.dataset.hlClass ?? 0),
      badge: el.querySelector<HTMLElement>('[data-hl-badge]')?.innerText ?? null,
      badgeTeam: el.querySelector<HTMLElement>('[data-hl-badge]')?.dataset.hlBadgeTeam ?? null,
      tags: Array.from(el.querySelectorAll<HTMLElement>('[data-hl-tag]')).map(t => t.innerText),
      weaponIcon: el.querySelector<HTMLElement>('[data-hl-weapon]')?.dataset.hlWeapon ?? null,
      cloakPct: el.querySelector<HTMLElement>('[data-hl-cloak]')?.dataset.hlCloak ?? null,
      chargePct: el.querySelector<HTMLElement>('[data-hl-charge]')?.dataset.hlCharge ?? null,
      opacity: round(opacity, 3),
    }
  })
})
