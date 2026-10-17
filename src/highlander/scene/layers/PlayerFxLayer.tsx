// Condition overlays around players (contract section 5 F1): uber shells, crit auras and orbiters, soldier buff,
// flames, drips, marked-for-death skull, stun stars, overheal signs, teleport glow, disguise smoke and the decloak
// ring. One child per mounted actor, portalled into the actor's group from the registry so it follows the actor
// for free. The rules are in src/highlander/players/fxState.ts; the meshes in players/overlayRig.ts.

import React, { useEffect, useMemo, useRef } from 'react'
import { createPortal, useFrame } from '@react-three/fiber'

import { useExtras, useHlSetting } from '@highlander/extras/hooks'
import { actorAt } from '@highlander/players/actorState'
import { fxFrameContext } from '@highlander/players/frameContext'
import type { OverlayState } from '@highlander/players/fxState'
import { OverlayRig } from '@highlander/players/overlayRig'
import { mountedRigs } from '@highlander/players/probes'
import { allActors, useActorRegistryVersion, type ActorHandles } from '@highlander/scene/actorRegistry'

interface ActorOverlayProps {
  handles: ActorHandles
  tickRef: React.MutableRefObject<number>
}

const ActorOverlay = React.memo(({ handles, tickRef }: ActorOverlayProps) => {
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
    const ctx = fxFrameContext(tickRef.current)
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

export const PlayerFxLayer = React.memo(({ renderTick }: { renderTick: number }) => {
  const x = useExtras()
  const conditions = useHlSetting<boolean>('players.conditions')
  const cloak = useHlSetting<boolean>('players.cloak')
  const registryVersion = useActorRegistryVersion()

  // Children read the tick in useFrame, so a new tick re-renders only this list, not the overlays
  const tickRef = useRef(renderTick)
  tickRef.current = renderTick

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const actors = useMemo(() => Array.from(allActors()), [registryVersion])

  if (!x || !x.meta.available.cond || (!conditions && !cloak)) return null

  return (
    <>
      {actors.map(handles => (
        <ActorOverlay key={`${handles.entityId}:${handles.group.uuid}`} handles={handles} tickRef={tickRef} />
      ))}
    </>
  )
})
