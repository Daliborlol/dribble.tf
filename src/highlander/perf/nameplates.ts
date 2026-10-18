// Nameplate declutter (contract section 5 X1): at most the NAMEPLATE_CAP nameplates nearest the camera are drawn,
// plus the focused player's, the POV subject's, the hovered player's and every pinned plate (F1 sets
// NameplateExtra.pinned for disguised or disguising spies, cloaked spies, spies below 100 cloak, ubered players and a
// MEDIC! call). Only plates on screen compete for the NAMEPLATE_CAP slots: a player behind the camera or outside the
// view never takes a slot from a visible one. The pass runs once per frame before the actors' own frame callbacks
// and only toggles `display` on the plates' DOM nodes, so it adds no React work.
//
// The hovered player is the one whose body or plate is under the mouse pointer: his screen-space hull (feet to the
// top of the plate, as wide as the 48-unit player hull) contains the pointer; the nearest such player wins. This is
// the scene's version of TF2's target ID (name and health on hover).
//
// Module state holds only the mounted actors' scene and DOM handles and the pointer position, never a demo, an
// extras object or a store snapshot (contract 12.3); entries leave with their actor.

import * as THREE from 'three'

import { registerHlProbe } from '@highlander/debug'
import type { NameplateExtra } from '@highlander/scene/actorFx'

/** Nameplates drawn besides the exempt ones. */
export const NAMEPLATE_CAP = 12
/** Hull used for the hover test, Hammer units (48 x 48 x 82 player hull; the plate sits above the head). */
const HOVER_HALF_WIDTH = 24
const HOVER_TOP = 83 * 0.85 + 40
/** The plate anchor above the feet (Actors.tsx: ActorDimensions.z * 0.85) and the on-screen margin in NDC. */
const PLATE_Z = 83 * 0.85
const SCREEN_MARGIN = 1.05

/** What an actor tells the pass about his plate; updated on every render of the actor. */
export interface PlateState {
  /** the plate's Html is mounted with content (nameplates on, alive, not rendered from his own eyes) */
  drawn: boolean
  /** F1: exempt from the cap and the distance fade */
  pinned: boolean
}

/** Per-pass inputs besides the camera. */
export interface DeclutterOptions {
  /** settings.highlander.enabled: with Highlander off every plate shows, as before S0 */
  enabled: boolean
  /** the focused player and the POV subject (entity ids, -1 for none): always shown */
  focusedEntityId: number
  subjectEntityId: number
}

interface PlateEntry {
  entityId: number
  group: THREE.Object3D
  element: { current: HTMLElement | null }
  state: { current: PlateState }
  /** what the pass last applied: true shown, false hidden, null untouched */
  applied: boolean | null
  /** last pass results, for the probe */
  distance: number
  rank: number
  shown: boolean
  reason: 'near' | 'pinned' | 'followed' | 'hovered' | 'capped' | 'offscreen' | 'notDrawn'
}

const entries = new Map<number, PlateEntry>()
const pointer = { x: 0, y: 0, inside: false }
let hoveredEntityId = -1
let passes = 0
let capEnabled = true
const lastOptions: DeclutterOptions = { enabled: true, focusedEntityId: -1, subjectEntityId: -1 }

/** Registers the plate of a mounted actor; returns the cleanup. */
export function registerPlate(
  entityId: number,
  group: THREE.Object3D,
  element: { current: HTMLElement | null },
  state: { current: PlateState }
): () => void {
  const entry: PlateEntry = { entityId, group, element, state, applied: null, distance: 0, rank: -1, shown: true, reason: 'notDrawn' }
  entries.set(entityId, entry)
  return () => {
    if (entries.get(entityId) === entry) entries.delete(entityId)
    const el = entry.element.current
    if (el && entry.applied === false) el.style.removeProperty('display')
  }
}

/** Tracks the pointer over the canvas for the hover exemption; returns the cleanup. */
export function trackPointer(dom: HTMLElement): () => void {
  const move = (event: PointerEvent) => {
    const rect = dom.getBoundingClientRect()
    pointer.x = event.clientX - rect.left
    pointer.y = event.clientY - rect.top
    pointer.inside = true
  }
  const leave = () => {
    pointer.inside = false
  }
  dom.addEventListener('pointermove', move, { passive: true })
  dom.addEventListener('pointerleave', leave, { passive: true })
  return () => {
    dom.removeEventListener('pointermove', move)
    dom.removeEventListener('pointerleave', leave)
    pointer.inside = false
  }
}

const _camera = new THREE.Vector3()
const _pos = new THREE.Vector3()
const _ndc = new THREE.Vector3()
const _feet = new THREE.Vector3()
const _top = new THREE.Vector3()
const _right = new THREE.Vector3()
const order: PlateEntry[] = []

/** The player under the pointer (body or plate), nearest first; -1 for none. */
function hoveredAt(camera: THREE.Camera, width: number, height: number): number {
  if (!pointer.inside || width <= 0 || height <= 0) return -1
  let best = -1
  let bestDistance = Infinity
  _right.setFromMatrixColumn(camera.matrixWorld, 0).normalize()
  for (const entry of entries.values()) {
    if (!entry.state.current.drawn) continue
    entry.group.getWorldPosition(_pos)
    // project the hull's bottom-left and top-right corners (camera-right axis), then test the screen rectangle
    _feet.copy(_pos).addScaledVector(_right, -HOVER_HALF_WIDTH).project(camera)
    _top.copy(_pos).addScaledVector(_right, HOVER_HALF_WIDTH)
    _top.z += HOVER_TOP
    _top.project(camera)
    if (_feet.z > 1 || _top.z > 1 || _feet.z < -1 || _top.z < -1) continue // behind the camera or clipped
    const x0 = ((Math.min(_feet.x, _top.x) + 1) / 2) * width
    const x1 = ((Math.max(_feet.x, _top.x) + 1) / 2) * width
    const y0 = ((1 - Math.max(_feet.y, _top.y)) / 2) * height
    const y1 = ((1 - Math.min(_feet.y, _top.y)) / 2) * height
    if (pointer.x < x0 || pointer.x > x1 || pointer.y < y0 || pointer.y > y1) continue
    if (entry.distance < bestDistance) {
      bestDistance = entry.distance
      best = entry.entityId
    }
  }
  return best
}

/**
 * One declutter pass: rank the drawn plates on screen by camera distance, show the NAMEPLATE_CAP nearest plus the
 * exempt ones, hide the rest. Writes the DOM only when a plate's state flips.
 */
export function declutterPlates(camera: THREE.Camera, width: number, height: number, opts: DeclutterOptions): void {
  passes++
  camera.updateMatrixWorld()
  _camera.setFromMatrixPosition(camera.matrixWorld)
  order.length = 0
  for (const entry of entries.values()) {
    entry.rank = -1
    if (!entry.state.current.drawn) {
      entry.reason = 'notDrawn'
      entry.shown = true
      continue
    }
    entry.distance = _camera.distanceTo(entry.group.getWorldPosition(_pos))
    // off screen (behind the camera, beyond near/far, or outside the view): no slot, nothing to hide
    _ndc.copy(_pos)
    _ndc.z += PLATE_Z
    _ndc.project(camera)
    if (!(_ndc.z >= -1 && _ndc.z <= 1 && Math.abs(_ndc.x) <= SCREEN_MARGIN && Math.abs(_ndc.y) <= SCREEN_MARGIN)) {
      entry.reason = 'offscreen'
      entry.shown = true
      continue
    }
    order.push(entry)
  }
  order.sort((a, b) => a.distance - b.distance || a.entityId - b.entityId)
  hoveredEntityId = hoveredAt(camera, width, height)

  const capped = capEnabled && opts.enabled
  for (let i = 0; i < order.length; i++) {
    const entry = order[i]
    entry.rank = i
    if (!capped || i < NAMEPLATE_CAP) entry.reason = 'near'
    else if (entry.state.current.pinned) entry.reason = 'pinned'
    else if (entry.entityId === opts.focusedEntityId || entry.entityId === opts.subjectEntityId) entry.reason = 'followed'
    else if (entry.entityId === hoveredEntityId) entry.reason = 'hovered'
    else entry.reason = 'capped'
    entry.shown = entry.reason !== 'capped'
  }
  lastOptions.enabled = opts.enabled
  lastOptions.focusedEntityId = opts.focusedEntityId
  lastOptions.subjectEntityId = opts.subjectEntityId
  order.length = 0

  for (const entry of entries.values()) {
    const el = entry.element.current
    if (!el) {
      entry.applied = null
      continue
    }
    const shown = entry.shown
    if (entry.applied === shown && el.style.display === (shown ? '' : 'none')) continue
    entry.applied = shown
    if (shown) el.style.removeProperty('display')
    else el.style.display = 'none'
  }
}

/**
 * True when two nameplate extras draw the same plate (F1's NameplateExtra, compared by value). useActorFx builds a
 * new object on every tick; comparing by value lets the memoized plate skip drei Html's per-render root update.
 */
export function nameplateExtraEqual(a: NameplateExtra | undefined, b: NameplateExtra | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (
    a.cloakPct !== b.cloakPct ||
    a.chargePct !== b.chargePct ||
    a.weaponIcon !== b.weaponIcon ||
    a.opacity !== b.opacity ||
    a.pinned !== b.pinned ||
    a.nameOverride !== b.nameOverride ||
    a.healthOverride !== b.healthOverride ||
    a.classOverride !== b.classOverride ||
    a.teamOverride !== b.teamOverride
  ) {
    return false
  }
  const ta = a.tags, tb = b.tags
  if (ta !== tb) {
    if (!ta || !tb || ta.length !== tb.length) return false
    for (let i = 0; i < ta.length; i++) if (ta[i] !== tb[i]) return false
  }
  const da = a.disguise, db = b.disguise
  if (da !== db) {
    if (!da || !db) return false
    if (da.cls !== db.cls || da.team !== db.team || da.disguising !== db.disguising || da.targetName !== db.targetName || da.health !== db.health) return false
  }
  return true
}

/** Probe and harness switch: the cap on (default) or off (every drawn plate shows, the pre-X1 behaviour). */
export function setNameplateCap(enabled: boolean): void {
  capEnabled = enabled
}

// Probe: the last pass, per registered plate: distance to the camera, rank among the drawn plates, shown and why.
registerHlProbe('nameplates.declutter', () => {
  const rows = Array.from(entries.values())
    .map(e => ({
      entityId: e.entityId,
      drawn: e.state.current.drawn,
      pinned: e.state.current.pinned,
      distance: Math.round(e.distance),
      rank: e.rank,
      shown: e.shown,
      reason: e.reason,
      domDisplay: e.element.current ? e.element.current.style.display || 'default' : null,
    }))
    .sort((a, b) => (a.rank < 0 ? 1e9 : a.rank) - (b.rank < 0 ? 1e9 : b.rank) || a.entityId - b.entityId)
  return {
    cap: capEnabled && lastOptions.enabled ? NAMEPLATE_CAP : null,
    options: { ...lastOptions },
    passes,
    hovered: hoveredEntityId,
    pointer: { ...pointer },
    drawn: rows.filter(r => r.drawn).length,
    shown: rows.filter(r => r.drawn && r.shown).length,
    offscreen: rows.filter(r => r.reason === 'offscreen').length,
    capped: rows.filter(r => r.reason === 'capped').length,
    rows,
  }
})

// Harness switch: nameplates.cap(false) restores every plate (for before/after comparisons), cap(true) the default.
registerHlProbe('nameplates.cap', (enabled?: boolean) => {
  if (typeof enabled === 'boolean') setNameplateCap(enabled)
  return { cap: capEnabled }
})
