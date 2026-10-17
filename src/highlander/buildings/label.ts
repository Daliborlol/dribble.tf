// Building status label drawn into one canvas texture (contract section 5 F2 "status billboard"): type glyph on a
// team square, three level pips, a 40 x 4 health bar (green above 50 %, yellow above 25 %, else red) and a second
// bar (sentry shells, max 150 at L1 and 200 above; dispenser metal of 400; teleporter recharge), plus the L3
// sentry rockets bar. One quad per building instead of a dozen overlay planes; the canvas is redrawn only when a
// shown value changes, so it costs nothing while a building is idle.

import * as THREE from 'three'

import { TEAM_HUD } from '@highlander/constants'
import { BUILDING_TYPE } from '@highlander/extras/enums'

import { drawGlyph, GAUGE, HEALTH_COLORS, LABEL_BG, PIP_OFF, PIP_ON, ROCKETS, SHELLS, type GlyphKind, type TeamKey } from './parts'
import type { BuildingDraw } from './render'

/** Label size in world units (before the distance scale): glyph 12 + gap 4 + bars 40, pips over the bars. */
export const LABEL_SIZE = { width: 58, height: 26 }
const PX = 4 // canvas pixels per unit
const BAR_X = 17
const BAR_W = 40
const STEPS = 40 // bar quantisation: one step per unit of bar width

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
    const key = `${health}|${d.healthFrac > 0.5 ? 2 : d.healthFrac > 0.25 ? 1 : 0}|${d.level}|${d.mini ? 1 : 0}|${secondQ}|${rockets}`
    if (key === this.key) return
    this.key = key
    this.draw(health / STEPS, d.healthFrac, d.level, d.mini, secondQ < 0 ? -1 : secondQ / STEPS, rockets < 0 ? -1 : rockets / STEPS)
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

  private draw(health: number, healthFrac: number, level: number, mini: boolean, second: number, rockets: number) {
    const ctx = this.ctx
    if (!ctx) return
    const u = PX
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)

    // glyph on a team square, vertically centred on the health bar
    const gy = 9
    ctx.fillStyle = TEAM_HUD[this.team]
    roundRect(ctx, 0, gy * u, 13 * u, 13 * u, 2 * u)
    ctx.fill()
    ctx.save()
    ctx.translate(1 * u, (gy + 1) * u)
    drawGlyph(ctx, this.glyph, 11 * u)
    ctx.restore()

    // level pips
    const pips = mini ? 1 : 3
    for (let i = 0; i < pips; i++) {
      ctx.fillStyle = i < level ? PIP_ON : PIP_OFF
      ctx.globalAlpha = i < level ? 1 : 0.8
      ctx.fillRect((BAR_X + 13 + i * 6) * u, 2 * u, 4 * u, 4 * u)
    }
    ctx.globalAlpha = 1

    // health bar: background, then the fill
    bar(ctx, 10, 6, 4, health, healthFrac > 0.5 ? HEALTH_COLORS.good : healthFrac > 0.25 ? HEALTH_COLORS.mid : HEALTH_COLORS.low)
    if (second >= 0) bar(ctx, 17, 3, 2, second, this.secondColor())
    if (rockets >= 0) bar(ctx, 21, 3, 2, rockets, ROCKETS)
  }
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
