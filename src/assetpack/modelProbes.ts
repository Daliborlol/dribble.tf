// Model probes (asset contract 12.4), loaded by loaders.ts through import() only once a pack is ready, so a
// page without a pack registers none of them and hl.probes() stays as on a06e4c7.
//
//   assets.models(filter?)                  the model cache rows
//   assets.modelShow(keys | null, opts?)    draws copies in front of the camera (null removes them); for shots
//   assets.gpu()                            renderer.info.memory and the last frame's render counts

import { _roots } from '@react-three/fiber'
import { Matrix4, Object3D, Vector3 } from 'three'
import type { Camera, Scene, WebGLRenderer } from 'three'

import { registerHlProbe } from '@highlander/debug'

import { acquirePackModel, attachmentMatrix, listPackModels, releasePackModel } from './models'
import type { PackModelHandle } from './models'

function rootState(): { gl: WebGLRenderer; scene: Scene; camera: Camera } | null {
  for (const canvas of Array.from(document.querySelectorAll('canvas'))) {
    const root = (_roots as Map<Element, any>).get(canvas)
    if (root) return root.store.getState()
  }
  return null
}

const shown: { key: string; handle: PackModelHandle | null; copy: Object3D | null }[] = []

function clearShown() {
  for (const s of shown.splice(0)) {
    if (s.copy) {
      s.copy.removeFromParent()
      s.handle?.release(s.copy)
    }
    releasePackModel(s.key)
  }
}

interface ShowOptions {
  skin?: number
  distance?: number
  spacing?: number
  scale?: number
  yaw?: number
  at?: [number, number, number]
}

async function modelShow(keys: string | string[] | null, opts: ShowOptions = {}) {
  clearShown()
  if (!keys) return { shown: 0 }
  const state = rootState()
  if (!state) return { error: 'no r3f root' }
  const { gl, scene, camera } = state
  const list = Array.isArray(keys) ? keys : [keys]
  const forward = new Vector3()
  camera.getWorldDirection(forward)
  const right = new Vector3().crossVectors(forward, camera.up).normalize()
  const center = opts.at
    ? new Vector3(...opts.at)
    : camera.position.clone().addScaledVector(forward, opts.distance ?? 200)
  const spacing = opts.spacing ?? 70
  const rows = []
  for (let i = 0; i < list.length; i++) {
    const key = list[i]
    const handle = await acquirePackModel(key, gl, scene, camera)
    const entry = { key, handle, copy: null as Object3D | null }
    shown.push(entry)
    if (!handle) {
      rows.push({ key, ok: false })
      continue
    }
    const copy = handle.instantiate(opts.skin ?? 0)
    copy.position.copy(center).addScaledVector(right, (i - (list.length - 1) / 2) * spacing)
    copy.rotation.set(0, 0, opts.yaw ?? 0)
    copy.scale.setScalar(opts.scale ?? 1)
    scene.add(copy)
    entry.copy = copy
    const m = new Matrix4()
    const muzzle = attachmentMatrix(copy, 'muzzle', m)
    rows.push({ key, ok: true, skins: handle.info.skins, clips: handle.clips.length, muzzle, pos: copy.position.toArray().map(Math.round) })
  }
  return { shown: rows.filter(r => r.ok).length, rows }
}

registerHlProbe('assets.models', (filter?: string) => listPackModels(filter))
registerHlProbe('assets.modelShow', (keys: string | string[] | null, opts?: ShowOptions) => modelShow(keys, opts))
registerHlProbe('assets.gpu', () => {
  const state = rootState()
  if (!state) return { error: 'no r3f root' }
  const info = state.gl.info
  return { memory: { ...info.memory }, programs: info.programs?.length ?? null, render: { calls: info.render.calls, triangles: info.render.triangles } }
})
