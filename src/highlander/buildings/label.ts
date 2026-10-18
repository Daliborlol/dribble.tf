// Building status label drawn into one canvas texture (contract section 5 F2 "status billboard"): a type glyph on
// a team square, three level pips, a 40 x 4 health bar (green above 50 %, yellow above 25 %, else red) and a second
// bar (sentry shells, max 150 at L1 and 200 above; dispenser metal of 400; teleporter recharge), plus the L3
// sentry rockets bar. One quad per building instead of a dozen overlay planes; the canvas is redrawn only when a
// shown value changes, so it costs nothing while a building is idle.
//
// The glyph square also carries the states that must read from the default RTS camera, where the building itself
// is only a few pixels tall: under construction the team colour fills the square from the bottom as the building
// goes up, and a sapped building's square turns electric blue (the flickering frame behind the label is
// BuildingObject's). The same glyph square, alone, marks a carried building on its engineer (glyphBadgeTexture).

import * as THREE from 'three'

import { TEAM_HUD } from '@highlander/constants'
import { BUILDING_TYPE } from '@highlander/extras/enums'

import { drawGlyph, GAUGE, HEALTH_COLORS, LABEL_BG, PIP_OFF, PIP_ON, ROCKETS, SAPPER_GLOW, SHELLS, type GlyphKind, type TeamKey } from './parts'
import type { BuildingDraw } from './render'

/** Label size in world units (before the distance scale): glyph square 18, gap 3, bars 40, pips above the bars. */
export const LABEL_SIZE = { width: 62, height: 26 }
const PX = 4 // canvas pixels per unit
const GLYPH = { y: 6, size: 18 }
const BAR_X = 21
const BAR_W = 40
const STEPS = 40 // bar quantisation: one step per unit of bar width
const BUILD_STEPS = 18 // construction fill quantisation: one step per unit of glyph height
/** Glyph colour on the electric-blue square of a sapped building. */
const SAPPED_GLYPH = '#0e2230'

export class BuildingLabel {
  readonly material: THREE.MeshBasicMaterial
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D | null
  private readonly texture: THREE.CanvasTexture
  private key = ''

  constructor(private readonly team: TeamKey, private readonly glyph: GlyphKind, private readonly type: number) {
    this.canvas = document.createElement('canvas')
    this.canvas.width = LABEL_SIZE.width * PX
    this.canvas.height = LABEL_SIZE.height * PX
    this.ctx = this.canvas.getContext('2d')
    this.texture = new THREE.CanvasTexture(this.canvas)
    this.texture.colorSpace = THREE.SRGBColorSpace
    this.texture.anisotropy = 2
    this.material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false })
  }

  /** Redraws the canvas when a shown value changed. */
  update(d: BuildingDraw) {
    const health = Math.round(d.healthFrac * STEPS)
    const second = this.secondFrac(d)
    const secondQ = second < 0 ? -1 : Math.round(second * STEPS)
    const rockets = d.type === BUILDING_TYPE.SENTRY && d.level >= 3 && !d.mini ? Math.round(d.rocketsFrac * STEPS) : -1
    const built = d.ghost ? Math.round(d.builtFrac * BUILD_STEPS) : -1
    const sapped = !!d.sapper
    const key = `${health}|${d.healthFrac > 0.5 ? 2 : d.healthFrac > 0.25 ? 1 : 0}|${d.level}|${d.mini ? 1 : 0}|${secondQ}|${rockets}|${built}|${sapped ? 1 : 0}`
    if (key === this.key) return
    this.key = key
    this.draw({
      health: health / STEPS,
      healthFrac: d.healthFrac,
      level: d.level,
      mini: d.mini,
      second: secondQ < 0 ? -1 : secondQ / STEPS,
      rockets: rockets < 0 ? -1 : rockets / STEPS,
      built: built < 0 ? -1 : built / BUILD_STEPS,
      sapped,
    })
    this.texture.needsUpdate = true
  }

  dispose() {
    this.texture.dispose()
    this.material.dispose()
  }

  private secondFrac(d: BuildingDraw): number {
    if (d.type === BUILDING_TYPE.SENTRY) return d.shellsFrac
    if (d.type === BUILDING_TYPE.DISPENSER) return d.metalFrac
    return d.recharge // -1 unless recharging
  }

  private secondColor(): string {
    return this.type === BUILDING_TYPE.SENTRY ? SHELLS : this.type === BUILDING_TYPE.DISPENSER ? GAUGE : PIP_ON
  }

  private draw(v: { health: number; healthFrac: number; level: number; mini: boolean; second: number; rockets: number; built: number; sapped: boolean }) {
    const ctx = this.ctx
    if (!ctx) return
    const u = PX
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)

    drawGlyphSquare(ctx, u, 0, GLYPH.y, GLYPH.size, this.team, this.glyph, v.built, v.sapped)

    // level pips on a dark backing like the bars, so both lit and unlit pips read on bright and dark ground (an L1
    // sentry shows 1 of 3, a mini sentry a single pip)
    const pips = v.mini ? 1 : 3
    ctx.fillStyle = LABEL_BG
    ctx.globalAlpha = 0.6
    ctx.fillRect((BAR_X - 1) * u, 0, (pips * 6) * u, 6 * u)
    ctx.globalAlpha = 1
    for (let i = 0; i < pips; i++) {
      ctx.fillStyle = i < v.level ? PIP_ON : PIP_OFF
      ctx.fillRect((BAR_X + i * 6) * u, 1 * u, 4 * u, 4 * u)
    }

    // health bar: background, then the fill
    bar(ctx, 8, 6, 4, v.health, v.healthFrac > 0.5 ? HEALTH_COLORS.good : v.healthFrac > 0.25 ? HEALTH_COLORS.mid : HEALTH_COLORS.low)
    if (v.second >= 0) bar(ctx, 15, 3, 2, v.second, this.secondColor())
    if (v.rockets >= 0) bar(ctx, 19, 3, 2, v.rockets, ROCKETS)
  }
}

/**
 * The glyph on its team square at (x, y) units, `size` units wide. `built` 0..1 while under construction: the team
 * colour fills the square from the bottom over a dark, hazard-striped background, inside a team outline; -1 when
 * built. A sapped building's square is electric blue inside a team border.
 */
function drawGlyphSquare(ctx: CanvasRenderingContext2D, u: number, x: number, y: number, size: number, team: TeamKey, glyph: GlyphKind, built: number, sapped: boolean) {
  const r = 2.5
  ctx.save()
  roundRect(ctx, x * u, y * u, size * u, size * u, r * u)
  ctx.clip()
  ctx.fillStyle = TEAM_HUD[team]
  if (sapped) {
    ctx.fillRect(x * u, y * u, size * u, size * u)
    ctx.fillStyle = SAPPER_GLOW
    ctx.fillRect((x + 2) * u, (y + 2) * u, (size - 4) * u, (size - 4) * u)
  } else if (built >= 0) {
    // the part still to build: dark with diagonal hazard stripes, so the progress reads on any ground and from afar
    ctx.fillStyle = LABEL_BG
    ctx.globalAlpha = 0.65
    ctx.fillRect(x * u, y * u, size * u, size * u)
    ctx.globalAlpha = 0.4
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 1.3 * u
    ctx.beginPath()
    for (let k = -size; k < size; k += 4.5) {
      ctx.moveTo((x + k) * u, (y + size) * u)
      ctx.lineTo((x + k + size) * u, y * u)
    }
    ctx.stroke()
    ctx.globalAlpha = 1
    ctx.fillStyle = TEAM_HUD[team]
    const h = size * built
    ctx.fillRect(x * u, (y + size - h) * u, size * u, h * u)
  } else {
    ctx.fillRect(x * u, y * u, size * u, size * u)
  }
  ctx.restore()
  if (built >= 0 && !sapped) {
    // a thin team outline keeps the square's shape while it is mostly empty
    ctx.strokeStyle = TEAM_HUD[team]
    ctx.lineWidth = 1 * u
    roundRect(ctx, (x + 0.5) * u, (y + 0.5) * u, (size - 1) * u, (size - 1) * u, r * u)
    ctx.stroke()
  }
  const inset = size * 0.1
  ctx.save()
  ctx.translate((x + inset) * u, (y + inset) * u)
  drawGlyph(ctx, glyph, (size - 2 * inset) * u, sapped ? SAPPED_GLYPH : '#ffffff')
  ctx.restore()
}

/** A bar row at y (units): a dark background `bg` units tall and a fill `fill` units tall. */
function bar(ctx: CanvasRenderingContext2D, y: number, bg: number, fill: number, frac: number, color: string) {
  const u = PX
  ctx.fillStyle = LABEL_BG
  ctx.globalAlpha = 0.6
  ctx.fillRect((BAR_X - 1) * u, y * u, (BAR_W + 2) * u, bg * u)
  ctx.globalAlpha = 1
  if (frac > 0) {
    ctx.fillStyle = color
    ctx.fillRect(BAR_X * u, (y + (bg - fill) / 2) * u, Math.max(1, BAR_W * frac * u), fill * u)
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

// ─── screen-size floor ────────────────────────────────────────────────────────

const _objectWorld = new THREE.Vector3()
const _cameraWorld = new THREE.Vector3()

/**
 * Scale for an object `worldWidth` units wide so it stays at least `minPx` pixels wide on screen under a perspective
 * camera (1 up close, at most `maxScale`). It depends on the camera only, never on time.
 */
export function minScreenScale(object: THREE.Object3D, camera: THREE.Camera, viewportHeight: number, worldWidth: number, minPx: number, maxScale: number): number {
  const cam = camera as THREE.PerspectiveCamera
  if (!cam.isPerspectiveCamera || viewportHeight <= 0) return 1
  object.getWorldPosition(_objectWorld)
  _cameraWorld.setFromMatrixPosition(camera.matrixWorld)
  const distance = _objectWorld.distanceTo(_cameraWorld)
  const pxPerUnit = viewportHeight / (2 * distance * Math.tan((cam.fov * Math.PI) / 360))
  if (!Number.isFinite(pxPerUnit) || pxPerUnit <= 0) return 1
  return Math.min(maxScale, Math.max(1, minPx / (worldWidth * pxPerUnit)))
}

// ─── carried-building badge ───────────────────────────────────────────────────

/** Size of the badge canvas in units. */
const BADGE_SIZE = 18
const badgeTextures = new Map<string, THREE.CanvasTexture>()

/**
 * The carried building's glyph on a round team token with a white ring, as a shared texture per team and glyph: the
 * badge beside a carried building's box on its engineer. Round, so it never reads as a placed building's label.
 * Created once per page and never disposed (at most 8: 4 glyphs x 2 teams).
 */
export function glyphBadgeTexture(team: TeamKey, glyph: GlyphKind): THREE.CanvasTexture {
  const key = `${team}|${glyph}`
  let texture = badgeTextures.get(key)
  if (texture) return texture
  const canvas = document.createElement('canvas')
  canvas.width = BADGE_SIZE * PX
  canvas.height = BADGE_SIZE * PX
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const c = (BADGE_SIZE / 2) * PX
    ctx.beginPath()
    ctx.arc(c, c, c - 1.2 * PX, 0, Math.PI * 2)
    ctx.fillStyle = TEAM_HUD[team]
    ctx.fill()
    ctx.lineWidth = 1.6 * PX
    ctx.strokeStyle = '#ffffff'
    ctx.stroke()
    const inset = BADGE_SIZE * 0.24
    ctx.save()
    ctx.translate(inset * PX, inset * PX)
    drawGlyph(ctx, glyph, (BADGE_SIZE - 2 * inset) * PX)
    ctx.restore()
  }
  texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  badgeTextures.set(key, texture)
  return texture
}

/** The label glyph of a building type (teleporters by mode: 0 entrance, 1 exit). */
export function glyphOf(type: number, mode: number): GlyphKind {
  if (type === BUILDING_TYPE.SENTRY) return 'sentry'
  if (type === BUILDING_TYPE.DISPENSER) return 'dispenser'
  return mode === 1 ? 'teleExit' : 'teleEntrance'
}
