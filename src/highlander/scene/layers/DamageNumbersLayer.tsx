// Damage numbers of the POV subject, after TF2's hud_combattext (setting pov.damageNumbers).
//
// Each hit the subject dealt to another player shows "-N" in red above the victim's position at the hit tick, rises
// and fades. Hits on one victim in one tick are one number (a shotgun's pellets). Like the game's, the numbers keep
// their screen size and draw over walls and the viewmodel. Everything is a pure function of the extras, the base caches
// and tickF (D12), so a seek shows the numbers of the hits before it.
//
// One instanced quad per glyph from a canvas atlas: one draw call, nothing while no number shows.

import React, { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'

import type { AsyncParser } from '@components/Analyse/Data/AsyncParser'
import { useInstance } from '@zus/store'
import { frameTime, readyExtras, type FrameTime } from '@highlander/combat/time'
import { registerHlProbe } from '@highlander/debug'
import { useExtras, useHlSetting } from '@highlander/extras/hooks'
import { byPlayerRange } from '@highlander/extras/track'
import type { HighlanderExtras } from '@highlander/extras/types'
import { getPovSubject } from '@highlander/pov/subject'
import { VM_GLOW_ORDER } from '@highlander/scene/viewmodel/kit'

const LIFE_SECONDS = 1.5
/** The number starts about at the head of a standing player. */
const ABOVE_FEET = 85
const FADE_FROM = 0.6
const MAX_NUMBERS = 16
const MAX_GLYPHS = MAX_NUMBERS * 4
/** On-screen sizes at a 1080 px tall canvas; they scale with its height. */
const GLYPH_HEIGHT_PX = 30
const RISE_PX = 70
const REFERENCE_HEIGHT = 1080

const GLYPHS = '-0123456789'
const CELL_W = 64
const CELL_H = 96
const ADVANCE = 0.56
const MINUS_NUDGE = 0.25

export interface DamageNumber {
  tick: number
  victim: number
  damage: number
  x: number; y: number; z: number
  /** 0 at the hit, 1 at the end of its life */
  age: number
}

/** The numbers showing at tickF, oldest first; at most MAX_NUMBERS, the newest. */
export function damageNumbersAt(x: HighlanderExtras, demo: AsyncParser, attacker: number, tickF: number): DamageNumber[] {
  const hurts = x.hurts
  const life = LIFE_SECONDS / x.meta.intervalPerTick
  const out: DamageNumber[] = []
  for (const h of byPlayerRange(x.derived.hurtsByAttacker, hurts, attacker, Math.ceil(tickF - life), Math.floor(tickF) + 1)) {
    const victim = hurts.victim[h]
    const damage = hurts.damage[h]
    if (victim === attacker || damage <= 0) continue
    const tick = hurts.tick[h]
    const merged = out.find(n => n.tick === tick && n.victim === victim)
    if (merged) {
      merged.damage += damage
      continue
    }
    if (!demo.entityPlayerMap.has(victim)) continue
    const at = demo.playerCache.positionCache.getPosition(victim, Math.min(tick, demo.ticks - 1))
    out.push({ tick, victim, damage, x: at.x, y: at.y, z: at.z + ABOVE_FEET, age: (tickF - tick) / life })
  }
  return out.length > MAX_NUMBERS ? out.slice(out.length - MAX_NUMBERS) : out
}

function makeAtlas(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = CELL_W * GLYPHS.length
  canvas.height = CELL_H
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
  ctx.font = `900 ${Math.round(CELL_H * 0.82)}px "Arial Black", Arial, Helvetica, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  ctx.lineWidth = 10
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)'
  ctx.fillStyle = '#ff2a2a'
  for (let i = 0; i < GLYPHS.length; i++) {
    const cx = (i + 0.5) * CELL_W
    ctx.strokeText(GLYPHS[i], cx, CELL_H / 2)
    ctx.fillText(GLYPHS[i], cx, CELL_H / 2)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.generateMipmaps = true
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  return texture
}

const VERTEX = /* glsl */ `
  attribute vec3 iWorld;
  attribute vec2 iOffset;
  attribute vec2 iGlyph;
  uniform vec2 uViewport;
  uniform vec2 uCellPx;
  uniform float uGlyphs;
  varying vec2 vUv;
  varying float vAlpha;
  void main() {
    vec4 clip = projectionMatrix * viewMatrix * vec4(iWorld, 1.0);
    if (clip.w <= 0.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    } else {
      vec2 px = position.xy * uCellPx + iOffset;
      clip.xy += px * 2.0 / uViewport * clip.w;
      gl_Position = clip;
    }
    vUv = vec2((iGlyph.x + uv.x) / uGlyphs, uv.y);
    vAlpha = iGlyph.y;
  }
`

const FRAGMENT = /* glsl */ `
  uniform sampler2D uMap;
  varying vec2 vUv;
  varying float vAlpha;
  void main() {
    vec4 c = texture2D(uMap, vUv);
    gl_FragColor = vec4(c.rgb, c.a * vAlpha);
  }
`

function makeMesh(): THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial> {
  const quad = new THREE.PlaneGeometry(1, 1)
  const geometry = new THREE.InstancedBufferGeometry()
  geometry.index = quad.index
  geometry.setAttribute('position', quad.getAttribute('position'))
  geometry.setAttribute('uv', quad.getAttribute('uv'))
  const dynamic = (name: string, size: number) => {
    const attribute = new THREE.InstancedBufferAttribute(new Float32Array(MAX_GLYPHS * size), size)
    attribute.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute(name, attribute)
  }
  dynamic('iWorld', 3)
  dynamic('iOffset', 2)
  dynamic('iGlyph', 2)
  geometry.instanceCount = 0
  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: {
      uMap: { value: makeAtlas() },
      uViewport: { value: new THREE.Vector2(1, 1) },
      uCellPx: { value: new THREE.Vector2(1, 1) },
      uGlyphs: { value: GLYPHS.length },
    },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.frustumCulled = false
  mesh.visible = false
  mesh.renderOrder = VM_GLOW_ORDER + 1
  mesh.raycast = () => {}
  return mesh
}

const _time: FrameTime = { tick: 0, tickF: 0 }

export const DamageNumbersLayer = React.memo(() => {
  const enabled = useHlSetting<boolean>('pov.damageNumbers')
  const extras = useExtras()
  const available = !!extras?.meta.available.hurts
  const mesh = useMemo(() => (enabled && available ? makeMesh() : null), [enabled, available])

  useEffect(() => {
    if (!mesh) return
    return () => {
      mesh.geometry.dispose()
      ;(mesh.material.uniforms.uMap.value as THREE.Texture).dispose()
      mesh.material.dispose()
    }
  }, [mesh])

  useFrame(state => {
    if (!mesh) return
    const { parsedDemo } = useInstance.getState()
    const x = readyExtras()
    frameTime(_time)
    const subject = getPovSubject(_time.tick)
    const numbers = x && parsedDemo && subject && subject.p >= 0 ? damageNumbersAt(x, parsedDemo, subject.p, _time.tickF) : null
    if (!numbers?.length) {
      mesh.visible = false
      return
    }
    const scale = state.size.height / REFERENCE_HEIGHT
    const glyphH = GLYPH_HEIGHT_PX * scale
    const glyphW = (glyphH * CELL_W) / CELL_H
    const step = glyphH * ADVANCE
    const { uViewport, uCellPx } = mesh.material.uniforms
    ;(uViewport.value as THREE.Vector2).set(state.size.width, state.size.height)
    ;(uCellPx.value as THREE.Vector2).set(glyphW, glyphH)

    const world = mesh.geometry.getAttribute('iWorld') as THREE.InstancedBufferAttribute
    const offset = mesh.geometry.getAttribute('iOffset') as THREE.InstancedBufferAttribute
    const glyph = mesh.geometry.getAttribute('iGlyph') as THREE.InstancedBufferAttribute
    let count = 0
    for (const n of numbers) {
      const text = `-${Math.min(n.damage, 999)}`
      const alpha = n.age < FADE_FROM ? 1 : 1 - (n.age - FADE_FROM) / (1 - FADE_FROM)
      const rise = RISE_PX * scale * n.age
      for (let i = 0; i < text.length && count < MAX_GLYPHS; i++, count++) {
        world.setXYZ(count, n.x, n.y, n.z)
        // the minus is narrower than its cell
        offset.setXY(count, (i - (text.length - 1) / 2 + (i === 0 ? MINUS_NUDGE : 0)) * step, rise)
        glyph.setXY(count, GLYPHS.indexOf(text[i]), alpha)
      }
    }
    world.needsUpdate = offset.needsUpdate = glyph.needsUpdate = true
    mesh.geometry.instanceCount = count
    mesh.visible = true
  })

  return mesh ? <primitive object={mesh} /> : null
})

registerHlProbe('pov.damageNumbers', (tick?: number) => {
  const { parsedDemo } = useInstance.getState()
  const x = readyExtras()
  const at = tick ?? frameTime().tick
  const subject = getPovSubject(at)
  if (!x || !parsedDemo || !subject || subject.p < 0) return { subject: null, numbers: [] }
  return { subject: subject.entityId, numbers: damageNumbersAt(x, parsedDemo, subject.p, at) }
})
