// Procedural canvas textures shared by the F4 layers (viewmodel muzzle flash, sniper and wrangler dots). Each is
// drawn once, on first use, and never disposed (they are tiny and live for the page).

import * as THREE from 'three'

let radial: THREE.CanvasTexture | null = null
let flash: THREE.CanvasTexture | null = null

/** White radial glow: opaque core fading to transparent at the rim (dots, nozzle glows). */
export function radialTexture(): THREE.CanvasTexture {
  if (radial) return radial
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.35, 'rgba(255,255,255,0.85)')
  g.addColorStop(0.7, 'rgba(255,255,255,0.25)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  radial = new THREE.CanvasTexture(canvas)
  radial.colorSpace = THREE.SRGBColorSpace
  return radial
}

/** Four-pointed muzzle flash star with a hot core. */
export function flashTexture(): THREE.CanvasTexture {
  if (flash) return flash
  const size = 64
  const c = size / 2
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const core = ctx.createRadialGradient(c, c, 0, c, c, c * 0.55)
  core.addColorStop(0, 'rgba(255,255,255,1)')
  core.addColorStop(0.5, 'rgba(255,240,200,0.9)')
  core.addColorStop(1, 'rgba(255,200,120,0)')
  ctx.fillStyle = core
  ctx.fillRect(0, 0, size, size)
  ctx.globalCompositeOperation = 'lighter'
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + Math.PI / 4
    ctx.save()
    ctx.translate(c, c)
    ctx.rotate(a)
    const ray = ctx.createLinearGradient(0, 0, c, 0)
    ray.addColorStop(0, 'rgba(255,230,170,0.95)')
    ray.addColorStop(1, 'rgba(255,190,90,0)')
    ctx.fillStyle = ray
    ctx.beginPath()
    ctx.moveTo(0, -c * 0.12)
    ctx.lineTo(c, 0)
    ctx.lineTo(0, c * 0.12)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }
  flash = new THREE.CanvasTexture(canvas)
  flash.colorSpace = THREE.SRGBColorSpace
  return flash
}
