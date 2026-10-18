// First-person viewmodel of the POV subject (contract section 5 F4, ViewmodelLayer).
//
// Mounted under the subject actor's povCamera (createPortal) while the camera kind is 'own' or 'spectated',
// `pov.viewmodel` is on, the subject is alive and not zoomed, and his active weapon is known. Every input comes from
// the subject, so a spectated teammate shows his own weapon. The provider instance is recreated when (class, weapon,
// team) changes; the last few instances are kept, so a spy quick-switching between three weapons does not rebuild
// them every few ticks.
//
// Render-order trick (contract, exact): a tiny depth-clearing mesh sorts after the whole world in the transparent
// pass and clears the depth buffer, then every viewmodel mesh draws with depth test and write, so the weapon never
// clips into walls, with plain rendering and with the outline EffectComposer alike.

import React, { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { createPortal, useFrame } from '@react-three/fiber'

import { useInstance, useStore } from '@zus/store'
import { HEAL_BEAM_OFFSET } from '@highlander/constants'
import { registerHlProbe } from '@highlander/debug'
import { useExtras, useHlSetting } from '@highlander/extras/hooks'
import { verticalFov } from '@highlander/extras/getters'
import { itemInfo, itemKind, itemName } from '@highlander/items'
import type { ActiveWeapon } from '@highlander/extras/getters'
import { getPovSubject, usePovSubject } from '@highlander/pov/subject'
import { getActor, useActorRegistryVersion } from '@highlander/scene/actorRegistry'

import { DEPTH_CLEAR_ORDER, prepareViewmodelObject } from './kit'
import { buildViewmodelInput, viewmodelBlock } from './input'
import { pickViewmodelProvider, type ViewmodelInstance, type ViewmodelProvider } from './provider'
import { computePose, MELEE_KINDS } from './animate'
import { resolveKind } from './weapons'
import { vmShared, type VmLive } from './shared'
import './placeholderProvider'

/** Instances kept per layer (spy quick-switch: three weapons plus the disguise kit). */
const INSTANCE_CACHE_SIZE = 6

const depthClearGeometry = new THREE.PlaneGeometry(0.01, 0.01)
const depthClearMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, transparent: true })

interface CachedInstance { provider: ViewmodelProvider; instance: ViewmodelInstance }

const _muzzleWorld = new THREE.Vector3()

export const ViewmodelLayer = React.memo(({ renderTick }: { renderTick: number }) => {
  const extras = useExtras()
  const demo = useInstance(s => s.parsedDemo)
  const subject = usePovSubject(renderTick)
  const enabled = useHlSetting<boolean>('pov.viewmodel')
  const vmFov = useHlSetting<number>('pov.viewmodelFov')
  const minimal = useHlSetting<boolean>('pov.minimalViewmodel')
  const registryVersion = useActorRegistryVersion()

  const state = demo ? viewmodelBlock(extras, demo, subject, renderTick, enabled) : null
  const camera = useMemo(() => {
    if (!subject || state?.block !== 'ok') return null
    return getActor(subject.entityId)?.aim.getObjectByName('povCamera') ?? null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subject?.entityId, state?.block, registryVersion])

  const realWeapon = state?.weapon ?? null
  const debugDef = vmShared.debug.def
  const weapon: ActiveWeapon | null =
    realWeapon && debugDef !== null
      ? { ...realWeapon, def: debugDef, kind: itemKind(debugDef), name: itemName(debugDef), cls: '' }
      : realWeapon
  const key = weapon && state?.team ? `${state.classId}:${weapon.def}:${state.team}:${weapon.cls}` : ''

  // LRU of provider instances, disposed on unmount
  const cache = useRef(new Map<string, CachedInstance>())
  useEffect(() => {
    const instances = cache.current
    return () => {
      for (const { instance } of instances.values()) instance.dispose()
      instances.clear()
      vmShared.live = null
    }
  }, [])

  const entry = useMemo(() => {
    if (!key || !extras || !demo || !subject || !weapon || !state?.team) return null
    const instances = cache.current
    const hit = instances.get(key)
    if (hit) {
      instances.delete(key)
      instances.set(key, hit)
      return hit
    }
    const input = buildViewmodelInput(extras, demo, subject.p, state.classId, state.team, weapon, renderTick)
    const provider = pickViewmodelProvider(input)
    const instance = provider.create(input)
    prepareViewmodelObject(instance.object)
    instances.set(key, { provider, instance })
    while (instances.size > INSTANCE_CACHE_SIZE) {
      const [oldKey, old] = instances.entries().next().value as [string, CachedInstance]
      instances.delete(oldKey)
      old.instance.dispose()
    }
    return instances.get(key)!
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, extras, demo])

  const rootRef = useRef<THREE.Group>(null)
  const offsetRef = useRef<THREE.Group>(null)
  const depthClearRef = useRef<THREE.Mesh>(null)

  useEffect(() => {
    const mesh = depthClearRef.current
    if (!mesh) return
    mesh.onBeforeRender = renderer => {
      if (vmShared.debug.noDepthClear) return // debug comparison only (probe viewmodel.debug)
      renderer.state.buffers.depth.setMask(true) // glClear(DEPTH_BUFFER_BIT) obeys the depth mask
      renderer.clearDepth()
    }
  })

  const mounted = !!(entry && camera)
  useEffect(() => {
    if (!mounted) vmShared.live = null
  }, [mounted])

  useFrame(() => {
    const root = rootRef.current
    if (!mounted || !entry || !root || !camera || !extras || !demo || !subject || !weapon || !state?.team) return
    const tickF = renderTick + useInstance.getState().frameProgress
    const input = buildViewmodelInput(extras, demo, subject.p, state.classId, state.team, weapon, tickF)
    if (vmShared.debug.flip !== null) input.flip = vmShared.debug.flip
    entry.instance.update(input)

    // Viewmodel FOV: scale x and y so the weapon looks rendered with pov.viewmodelFov (Source horizontal at 4:3)
    const cam = camera as THREE.PerspectiveCamera
    const k = Math.tan(((cam.fov || 73.74) * Math.PI) / 360) / Math.tan((verticalFov(vmFov || 70) * Math.PI) / 360)
    root.scale.set(input.flip ? -k : k, k, 1)

    // tf_use_min_viewmodels: the item's offset (forward, right, up), in camera axes
    const offset = offsetRef.current
    const o = minimal ? itemInfo(weapon.def)?.minViewmodelOffset : undefined
    if (offset) offset.position.set(o ? o[1] : 0, o ? o[2] : 0, (o ? -o[0] : 0) - vmShared.debug.push)

    const muzzle = entry.instance.muzzle
    muzzle.updateWorldMatrix(true, false)
    _muzzleWorld.setFromMatrixPosition(muzzle.matrixWorld)
    // POV medic beam origin: the muzzle (HealBeam adds HEAL_BEAM_OFFSET to both ends)
    vmShared.beamOrigin.set(_muzzleWorld.x, _muzzleWorld.y, _muzzleWorld.z - HEAL_BEAM_OFFSET)
    const live: VmLive = {
      subjectEntityId: subject.entityId,
      provider: entry.provider.id,
      kind: weapon.kind,
      weaponDef: weapon.def,
      muzzle,
      muzzleWorld: _muzzleWorld,
      scale: k,
      flip: input.flip,
      tick: renderTick,
    }
    vmShared.live = live
  })

  if (!mounted || !entry || !camera) return null
  return createPortal(
    <group name="viewmodelRoot" ref={rootRef}>
      <mesh
        ref={depthClearRef}
        name="viewmodelDepthClear"
        geometry={depthClearGeometry}
        material={depthClearMaterial}
        renderOrder={DEPTH_CLEAR_ORDER}
        frustumCulled={false}
        position={[0, 0, -2]}
      />
      <group ref={offsetRef} name="viewmodelOffset">
        <primitive object={entry.instance.object} />
      </group>
    </group>,
    camera
  )
})

// Probe: what the viewmodel shows for the POV subject at a cache tick (default: the current renderTick).
// Recomputed from the data, so seeking to the same tick twice gives the same answer (D12).
registerHlProbe('viewmodel.state', (tick?: number) => {
  const { parsedDemo: demo, extras, extrasStatus } = useInstance.getState()
  const at = tick ?? Math.max(1, useStore.getState().playback.tick - 2)
  const subject = getPovSubject(Math.floor(at))
  const x = extrasStatus === 'ready' ? extras : undefined
  const enabled = !!useStore.getState().settings.highlander?.pov?.viewmodel
  if (!demo) return { error: 'no demo' }
  const s = viewmodelBlock(x, demo, subject, Math.floor(at), enabled)
  const live = vmShared.live
  const base = {
    subject: subject?.entityId ?? null,
    camera: subject?.camera ?? null,
    block: s.block,
    mounted: !!live,
    liveSubject: live?.subjectEntityId ?? null,
  }
  if (s.block !== 'ok' || !x || !subject || !s.weapon || !s.team) return { ...base, provider: null, kind: null, weaponDef: null, draw: null, kick: null, reload: null, swing: null }
  const input = buildViewmodelInput(x, demo, subject.p, s.classId, s.team, s.weapon, at)
  const kind = resolveKind(s.weapon.kind, s.weapon.cls)
  const pose = computePose(input, kind, { kick: [1, 1], melee: MELEE_KINDS.has(kind), reloads: true })
  const r = (v: number) => Math.round(v * 1000) / 1000
  return {
    ...base,
    provider: pickViewmodelProvider(input).id,
    kind: s.weapon.kind,
    shape: kind,
    weaponDef: s.weapon.def,
    weaponName: s.weapon.name,
    drawTick: input.drawTick,
    draw: r(pose.draw),
    kick: r(pose.kick),
    reload: r(pose.reload),
    swing: r(pose.swing),
    flash: pose.muzzleFlash,
    pull: r(pose.pull),
    spin: r(pose.spin),
    watch: r(pose.watch),
    bladeUp: pose.bladeUp,
    flame: r(pose.flame),
    puff: r(pose.puff),
    heal: pose.heal,
    cycle: r(pose.cycle),
    loaded: pose.loaded,
    flip: input.flip, // misc.flip of the subject (m_bFlipViewModels)
    flipDrawn: live ? live.flip : null, // what the layer drew, including the viewmodel.debug override
    fireTicks: input.fireTicks.slice(-4),
    scale: live ? r(live.scale) : null,
    muzzleWorld: live ? [r(live.muzzleWorld.x), r(live.muzzleWorld.y), r(live.muzzleWorld.z)] : null,
  }
})

// Debug: force the left-handed mirror ({ flip: true | false | null }) on demos without left-handed players, show
// another weapon def ({ def: 18 | null }) to review every placeholder model at one spot, push the viewmodel forward
// into a wall ({ push: 120 }) and skip the depth clear ({ noDepthClear: true }) to compare the clipping it prevents.
registerHlProbe('viewmodel.debug', (opts?: { flip?: boolean | null; def?: number | null; noDepthClear?: boolean; push?: number }) => {
  if (opts && 'push' in opts) vmShared.debug.push = Number(opts.push) || 0
  if (opts && 'flip' in opts) vmShared.debug.flip = opts.flip ?? null
  if (opts && 'def' in opts) vmShared.debug.def = opts.def ?? null
  if (opts && 'noDepthClear' in opts) vmShared.debug.noDepthClear = !!opts.noDepthClear
  useInstance.getState().bumpActorRegistryVersion() // re-render the layer now, also while paused
  return { ...vmShared.debug }
})
