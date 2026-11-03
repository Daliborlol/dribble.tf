// Team-coloured player glow through walls (as/shading, `highlander.players.xrayGlow`, key X), after TF2's spectator
// glow outlines. Every mesh of a drawn player model gets a glow child that shares its geometry (and its skeleton when
// skinned) and draws only where the map hides the player: depth test GREATER, no depth write, a team colour that
// is faint inside the silhouette and strong at its edge (a view-angle fresnel, so it reads as an outline).
//
// Order: the glow meshes draw at render order 1 in the opaque list, after the map (0) and before the players' own
// meshes, which the hook moves to render order 2 while the glow is on. The depth buffer then holds the world but no
// player yet, so a player's own parts never glow over each other, and the player's visible pixels cover the glow
// drawn behind them. Without the setting nothing is created and the render orders stay as they were.
//
// The glow follows the body: it is a child of each mesh, so death, the own POV, full cloak and the disguise model
// (whose team colour it takes) apply to it as to the body, and its opacity is the body's opacity (the cloak fade).
// One material per player, shared program; disposed when the glow turns off or the model unmounts (GPU disposal).

import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

import { registerHlProbe } from '../debug'
import { TEAM_FX } from '../constants'

const GLOW_TYPE = 'XrayGlowMesh'
const RESCAN_FRAMES = 30

const VERTEX = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
varying vec3 vGlowNormal;
varying vec3 vGlowView;
void main() {
  #include <skinbase_vertex>
  #include <beginnormal_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  #include <logdepthbuf_vertex>
  vGlowNormal = normalize( transformedNormal );
  vGlowView = -mvPosition.xyz;
}`

const FRAGMENT = /* glsl */ `
uniform vec3 glowColor;
uniform float glowOpacity;
#include <logdepthbuf_pars_fragment>
varying vec3 vGlowNormal;
varying vec3 vGlowView;
void main() {
  #include <logdepthbuf_fragment>
  float f = 1.0 - abs( dot( normalize( vGlowNormal ), normalize( vGlowView ) ) );
  gl_FragColor = vec4( glowColor, glowOpacity * ( 0.4 + 0.6 * f * f ) );
  #include <colorspace_fragment>
}`

function glowMaterial(): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    uniforms: { glowColor: { value: new THREE.Color() }, glowOpacity: { value: 1 } },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    depthTest: true,
    depthWrite: false,
    depthFunc: THREE.GreaterDepth,
    // transparent stays false: the glow belongs in the opaque list, between the map and the players
    blending: THREE.CustomBlending,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  })
  material.name = 'xray-glow'
  return material
}

const noRaycast = () => {}

interface GlowState {
  material: THREE.ShaderMaterial
  glows: Map<THREE.Mesh, THREE.Mesh>
  frame: number
}

function attach(root: THREE.Object3D, state: GlowState) {
  root.traverse(node => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh || mesh.type === GLOW_TYPE || state.glows.has(mesh) || !mesh.geometry?.attributes?.normal) return
    const source = mesh as THREE.SkinnedMesh
    let glow: THREE.Mesh
    if (source.isSkinnedMesh) {
      const skinned = new THREE.SkinnedMesh(source.geometry, state.material)
      skinned.bindMode = source.bindMode
      skinned.bind(source.skeleton, source.bindMatrix)
      glow = skinned
    } else {
      glow = new THREE.Mesh(mesh.geometry, state.material)
    }
    ;(glow as { type: string }).type = GLOW_TYPE
    glow.name = 'xray-glow'
    glow.renderOrder = 1
    glow.frustumCulled = mesh.frustumCulled
    glow.raycast = noRaycast
    glow.userData.xrayGlow = true
    mesh.userData.xrayRenderOrder = mesh.renderOrder
    mesh.renderOrder = 2
    mesh.add(glow)
    state.glows.set(mesh, glow)
  })
  // meshes that left the model (a weapon swap) drop their glow
  for (const [mesh, glow] of state.glows) {
    let under = false
    for (let n: THREE.Object3D | null = mesh; n; n = n.parent) if (n === root) { under = true; break }
    if (under) continue
    mesh.remove(glow)
    mesh.renderOrder = mesh.userData.xrayRenderOrder ?? 0
    state.glows.delete(mesh)
  }
}

function detach(state: GlowState) {
  for (const [mesh, glow] of state.glows) {
    mesh.remove(glow)
    mesh.renderOrder = mesh.userData.xrayRenderOrder ?? 0
    delete mesh.userData.xrayRenderOrder
  }
  state.glows.clear()
  state.material.dispose()
}

/**
 * Glow children on every mesh under `root` while `active`. `team` is the drawn model's team ('red' or 'blue'),
 * `opacity` the body's opacity; a new `rootKey` (the pack model replacing the public one) rebuilds the glow.
 */
export function useXrayGlow(root: RefObject<THREE.Object3D>, active: boolean, team: string, opacity: number, rootKey = ''): void {
  const state = useRef<GlowState | null>(null)
  useEffect(() => {
    if (!active) return
    const created: GlowState = { material: glowMaterial(), glows: new Map(), frame: 0 }
    state.current = created
    if (root.current) attach(root.current, created)
    return () => {
      detach(created)
      if (state.current === created) state.current = null
    }
  }, [active, root, rootKey])

  useEffect(() => {
    const s = state.current
    if (!s) return
    s.material.uniforms.glowColor.value.set(team === 'blue' || team === 'blu' ? TEAM_FX.blue : TEAM_FX.red)
    s.material.uniforms.glowOpacity.value = Math.max(0, Math.min(1, opacity))
  }, [active, team, opacity])

  // models and weapons that load later (pack copies, third-person weapons) get theirs within RESCAN_FRAMES
  useFrame(({ gl, scene }) => {
    const s = state.current
    if (!s || !root.current) return
    lastGl = gl
    lastScene = scene
    if (++s.frame % RESCAN_FRAMES === 0) attach(root.current, s)
  })
}

// The probe reads the scene of the last frame a glow hook ran in (a renderer and scene, never demo data).
let lastScene: THREE.Scene | null = null
let lastGl: THREE.WebGLRenderer | null = null

/** players.xray: glow meshes in the scene, how many drew last frame's way (visible chain), and their programs. */
registerHlProbe('players.xray', () => {
  const scene = lastScene
  if (!scene) return { glows: 0, visible: 0, programs: 0 }
  let glows = 0
  let visible = 0
  const materials = new Set<THREE.Material>()
  scene.traverse(o => {
    if (o.type !== GLOW_TYPE) return
    glows++
    materials.add((o as THREE.Mesh).material as THREE.Material)
    let shown = true
    for (let n: THREE.Object3D | null = o; n; n = n.parent) if (!n.visible) { shown = false; break }
    if (shown) visible++
  })
  const names: Record<string, number> = {}
  for (const p of lastGl?.info.programs ?? []) names[p.name] = (names[p.name] ?? 0) + 1
  return { glows, visible, materials: materials.size, programs: names }
})
