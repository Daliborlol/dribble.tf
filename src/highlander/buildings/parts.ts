// Shared geometries, materials and textures of the building placeholders (contract sections 1.5 and 1.6 rule 6).
// Everything here is created once per page and never disposed: a few dozen small objects shared by every building.

import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

import { DARK_METAL, METAL, TEAM_DARK, TEAM_FX } from '@highlander/constants'

import { SENTRY, TELEPORTER } from './render'

// ─── geometries (unit shapes, scaled per mesh) ─────────────────────────────────

export const BOX = new THREE.BoxGeometry(1, 1, 1)
/** Unit cylinder (radius 1, height 1) along +Z, centred. */
export const CYL_Z = new THREE.CylinderGeometry(1, 1, 1, 18).rotateX(Math.PI / 2)
/** Unit cylinder along +X, from x 0 to 1 (barrels grow forward from their base). */
export const CYL_X = new THREE.CylinderGeometry(1, 1, 1, 10).rotateZ(-Math.PI / 2).translate(0.5, 0, 0)
export const SPHERE = new THREE.SphereGeometry(1, 20, 14)
/** Teleporter ring, flat on the ground (torus around +Z). */
export const TELE_RING = new THREE.TorusGeometry(TELEPORTER.ring.radius, TELEPORTER.ring.tube, 8, 40)
/** Unit torus around +Z with a thin tube, scaled uniformly by the ring radius. */
export const THIN_RING = new THREE.TorusGeometry(1, 0.07, 6, 48)
/** Flat arrow pointing +X (a cone lying on its side, flattened by the mesh scale). */
export const ARROW = new THREE.ConeGeometry(6, 14, 16).rotateZ(-Math.PI / 2)
/** Open cylinder (radius 1, height 1) along +Z from z 0 to 1: the teleporter's ready glow. */
export const OPEN_CYL = new THREE.CylinderGeometry(1, 1, 1, 32, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5)
/** Recharge arc: 48 segments of a flat ring; drawRange(0, 6 * k) shows the first k segments (index order is by segment). */
export const ARC_SEGMENTS = 48
export const ARC = new THREE.RingGeometry(TELEPORTER.radius - 2, TELEPORTER.radius + 1.5, ARC_SEGMENTS, 1, Math.PI / 2, -Math.PI * 2)
export const PLANE = new THREE.PlaneGeometry(1, 1)
/** Unit box edges, for the blueprint outline. */
export const BOX_EDGES = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1))
/** Sentry range ring (1100 units, SENTRY_MAX_RANGE), flat; a 40-unit band inside the range, so it reads from the RTS camera. */
export const RANGE_RING = new THREE.RingGeometry(1060, 1100, 160)

// Parts that always move together share one geometry, so each costs one draw call.
const merged = (parts: THREE.BufferGeometry[]) => {
  const g = mergeGeometries(parts)
  parts.forEach(p => p.dispose())
  return g ?? new THREE.BufferGeometry()
}
/** The two L2/L3 sentry barrels along +X from x 0, at y +/-3.5 (contract: r 1.6, length 22). */
export const TWIN_BARRELS = merged(
  SENTRY.barrel[2].offsets.map(y =>
    new THREE.CylinderGeometry(SENTRY.barrel[2].radius, SENTRY.barrel[2].radius, SENTRY.barrel[2].length, 10)
      .rotateZ(-Math.PI / 2)
      .translate(SENTRY.barrel[2].length / 2, y, 0)
  )
)
/** The four r 2 discs on the front (+X) of the L3 rocket pod, centred on the pod's front face. */
export const POD_DISCS = merged(
  [-1, 1].flatMap(sy => [-1, 1].map(sz => new THREE.CircleGeometry(SENTRY.pod.disc, 12).rotateY(Math.PI / 2).translate(0, sy * 4.5, sz * 2)))
)
/** The teleporter's three blades (18 x 3 x 1) at 0, 120 and 240 degrees around +Z. */
export const TELE_BLADES = merged(
  [0, 1, 2].map(i => {
    const [l, w, h] = TELEPORTER.blade
    return new THREE.BoxGeometry(l, w, h).translate(l / 2 + 1, 0, 0).rotateZ((i * 2 * Math.PI) / 3)
  })
)

// ─── colours ──────────────────────────────────────────────────────────────────

export type TeamKey = 'red' | 'blue'
export const SCREEN = '#9fd7ff'
export const GAUGE = '#f0c040'
export const SAPPER_GLOW = '#9fd7ff'
export const MUZZLE = '#ffd27a'
export const FLASH = '#ffd28a'
export const INVALID = '#ff2020'
export const HEALTH_COLORS = { good: '#4caf50', mid: '#e0c040', low: '#e04040' }
export const SHELLS = '#d8c08a'
export const ROCKETS = '#e07a3a'
export const PIP_ON = '#f2f2f2'
export const PIP_OFF = '#666666'
export const LABEL_BG = '#111111'

/** Mini sentry body: TEAM_DARK lerped 40 % toward TEAM_FX. */
export function miniBodyColor(team: TeamKey): string {
  return '#' + new THREE.Color(TEAM_DARK[team]).lerp(new THREE.Color(TEAM_FX[team]), 0.4).getHexString()
}

export const bodyColor = (team: TeamKey, mini = false) => (mini ? miniBodyColor(team) : TEAM_DARK[team])
export { DARK_METAL, METAL, TEAM_DARK, TEAM_FX }

// ─── materials ────────────────────────────────────────────────────────────────

/** Opacity of every part while a building is under construction (or redeploying). */
export const GHOST_OPACITY = 0.55

const lamberts = new Map<string, THREE.MeshLambertMaterial>()
const ghosts = new Map<THREE.Material, THREE.Material>()
const basics = new Map<string, THREE.MeshBasicMaterial>()

/** Shared opaque Lambert material of a colour (optionally emissive in the same colour). */
export function solid(color: string, emissive = 0): THREE.MeshLambertMaterial {
  const key = `${color}|${emissive}`
  let m = lamberts.get(key)
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color })
    if (emissive > 0) {
      m.emissive.set(color)
      m.emissiveIntensity = emissive
    }
    lamberts.set(key, m)
  }
  return m
}

/** The translucent construction variant of a shared material. */
export function ghostOf(material: THREE.Material): THREE.Material {
  let g = ghosts.get(material)
  if (!g) {
    g = material.clone()
    g.transparent = true
    g.opacity = Math.min(material.opacity, GHOST_OPACITY)
    g.depthWrite = false
    ghosts.set(material, g)
  }
  return g
}

/**
 * Shared unlit material: additive glows (`additive`), or flat overlays with normal blending. `onTop` disables the
 * depth test for labels, which then draw over the scene like the HTML nameplates do.
 */
export function basic(color: string, opacity = 1, additive = false, onTop = false): THREE.MeshBasicMaterial {
  const key = `${color}|${opacity}|${additive}|${onTop}`
  let m = basics.get(key)
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      color,
      transparent: opacity < 1 || additive || onTop,
      opacity,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      depthWrite: !(opacity < 1 || additive),
      depthTest: !onTop,
      side: THREE.DoubleSide,
    })
    basics.set(key, m)
  }
  return m
}

// ─── glow sprite texture (procedural, no network) ───────────────────────────────

let glowTexture: THREE.Texture | null = null

/** Soft radial glow, white at the centre, for additive sprites (muzzle flashes, sapper sparks). */
export function getGlowTexture(): THREE.Texture {
  if (glowTexture) return glowTexture
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
    g.addColorStop(0, 'rgba(255,255,255,1)')
    g.addColorStop(0.35, 'rgba(255,255,255,0.65)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, size, size)
  }
  glowTexture = new THREE.CanvasTexture(canvas)
  return glowTexture
}

// ─── building type glyphs for the labels (procedural, white on transparent) ────────

export type GlyphKind = 'sentry' | 'dispenser' | 'teleEntrance' | 'teleExit'

/** Draws a building type glyph (white by default) into the box (0, 0, s, s) of the current canvas transform. */
export function drawGlyph(ctx: CanvasRenderingContext2D, kind: GlyphKind, s: number, color = '#ffffff') {
  ctx.fillStyle = color
  ctx.strokeStyle = color
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const u = s / 64
  if (kind === 'sentry') {
    // tripod base, post, turret head and barrel pointing right
    ctx.beginPath()
    ctx.moveTo(12 * u, 56 * u)
    ctx.lineTo(52 * u, 56 * u)
    ctx.lineTo(44 * u, 46 * u)
    ctx.lineTo(20 * u, 46 * u)
    ctx.closePath()
    ctx.fill()
    ctx.fillRect(28 * u, 30 * u, 8 * u, 17 * u)
    ctx.fillRect(14 * u, 14 * u, 30 * u, 18 * u)
    ctx.fillRect(42 * u, 19 * u, 16 * u, 6 * u)
  } else if (kind === 'dispenser') {
    // cabinet with a cross on its screen
    ctx.lineWidth = 5 * u
    ctx.strokeRect(16 * u, 8 * u, 32 * u, 50 * u)
    ctx.fillRect(14 * u, 6 * u, 36 * u, 6 * u)
    ctx.fillRect(28 * u, 20 * u, 8 * u, 24 * u)
    ctx.fillRect(20 * u, 28 * u, 24 * u, 8 * u)
  } else {
    // pad seen at an angle, with an arrow: down into the entrance, up out of the exit
    ctx.lineWidth = 5 * u
    ctx.beginPath()
    ctx.ellipse(32 * u, 50 * u, 24 * u, 9 * u, 0, 0, Math.PI * 2)
    ctx.stroke()
    const up = kind === 'teleExit'
    ctx.fillRect(28 * u, (up ? 14 : 8) * u, 8 * u, 26 * u)
    ctx.beginPath()
    if (up) {
      ctx.moveTo(16 * u, 22 * u)
      ctx.lineTo(32 * u, 4 * u)
      ctx.lineTo(48 * u, 22 * u)
    } else {
      ctx.moveTo(16 * u, 28 * u)
      ctx.lineTo(32 * u, 46 * u)
      ctx.lineTo(48 * u, 28 * u)
    }
    ctx.closePath()
    ctx.fill()
  }
}

const spriteMaterials = new Map<string, THREE.SpriteMaterial>()

/** Shared additive glow sprite material. */
export function glowSprite(color: string, opacity = 1): THREE.SpriteMaterial {
  const key = `${color}|${opacity}`
  let m = spriteMaterials.get(key)
  if (!m) {
    m = new THREE.SpriteMaterial({ map: getGlowTexture(), color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false })
    spriteMaterials.set(key, m)
  }
  return m
}
