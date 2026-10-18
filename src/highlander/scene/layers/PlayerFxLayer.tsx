// Condition overlays around players (contract section 5 F1): uber shells, crit auras and orbiters, soldier buff,
// flames, drips, marked-for-death skull, stun stars, overheal signs, teleport glow, disguise smoke and the decloak
// ring. One child per mounted actor, portalled into the actor's group from the registry so it follows the actor
// for free. The rules are in src/highlander/players/fxState.ts; the meshes in players/overlayRig.ts.

import React, { useEffect, useMemo, useRef } from 'react'
import { createPortal, useFrame } from '@react-three/fiber'

import { useExtras, useHlSetting } from '@highlander/extras/hooks'
import { actorAt } from '@highlander/players/actorState'
import { FxFrameCache } from '@highlander/players/frameContext'
import type { OverlayState } from '@highlander/players/fxState'
import { OverlayRig } from '@highlander/players/overlayRig'
import { mountedRigs } from '@highlander/players/probes'
import { allActors, useActorRegistryVersion, type ActorHandles } from '@highlander/scene/actorRegistry'

interface ActorOverlayProps {
  handles: ActorHandles
  frameCache: FxFrameCache
}

const ActorOverlay = React.memo(({ handles, frameCache }: ActorOverlayProps) => {
  const { entityId } = handles
  const rig = useMemo(() => new OverlayRig(entityId), [entityId])
  // The per-tick state only changes with the frame context version (tick, settings, POV); frames in between
  // only animate it with tickF
  const cached = useRef<{ version: number; overlays: OverlayState | null }>({ version: -1, overlays: null })

  useEffect(() => {
    mountedRigs.set(entityId, rig)
    return () => {
      if (mountedRigs.get(entityId) === rig) mountedRigs.delete(entityId)
      rig.dispose()
    }
  }, [entityId, rig])

  useFrame(() => {
    const ctx = frameCache.get()
    if (!ctx) {
      rig.update(null, 0)
      return
    }
    if (cached.current.version !== ctx.version) {
      const at = actorAt(ctx, entityId, ctx.tick, false)
      cached.current = { version: ctx.version, overlays: at && at.drawn ? at.overlays : null }
    }
    rig.update(cached.current.overlays, ctx.tickF)
  })

  return createPortal(<primitive object={rig.group} dispose={null} />, handles.group)
})

// The overlays read the tick and frameProgress of the frame from the store (FxFrameCache, frameTime), not from the
// renderTick prop, which reaches React a frame after DemoViewer advances playback.tick.
export const PlayerFxLayer = React.memo((_props: { renderTick: number }) => {
  const x = useExtras()
  const conditions = useHlSetting<boolean>('players.conditions')
  const cloak = useHlSetting<boolean>('players.cloak')
  const registryVersion = useActorRegistryVersion()

  // One frame context per frame for all overlays. It references the extras and the demo, so it is cleared as
  // soon as the extras change (a new demo sets them to undefined before its extras parse), while the overlays
  // are off, and when the layer unmounts (Highlander off)
  const frameCache = useMemo(() => new FxFrameCache(), [])
  const active = !!x && !!x.meta.available.cond && (conditions || cloak)
  useEffect(() => () => frameCache.clear(), [x, active, frameCache])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const actors = useMemo(() => Array.from(allActors()), [registryVersion])

  if (!active) return null

  return (
    <>
      {actors.map(handles => (
        <ActorOverlay
          key={`${handles.entityId}:${handles.group.uuid}`}
          handles={handles}
          frameCache={frameCache}
        />
      ))}
    </>
  )
})
