// POV subject (contract D16 and section 5 F4): the one player whose view, FOV, viewmodel, scope and weapon HUD the
// POV mode shows. It is the focused player while he lives. While he is dead, `pov.deadPov` decides: 'stay' keeps
// his own (dead) camera; 'spectated' follows his networked observer state: a death camera during DEATHCAM and
// FREEZECAM, then the teammate he spectates in IN_EYE (or CHASE) mode.
//
// The death camera's killer is the killer of the base death record (the killfeed's), never misc.obsTarget: in
// tournament mode the server falls back to DEATHCAM and keeps the dead teammate as the target when the teammate the
// player spectates dies (tf_player.cpp:13777-13786), and in the health-bucket ticks before a death the target still
// holds the previous life's value. Only the DEATHCAM and FREEZECAM run of his own death names a killer.
//
// Teammate-death camera (contract 12.2 item 1, X1): when the teammate a dead player spectates dies (IN_EYE or CHASE
// with a dead target, and the tournament DEATHCAM fallback that keeps the dead teammate as the target), the subject
// becomes that teammate with camera 'deathcam' and `deathOfEntityId` set: the death camera holds his death spot
// (base position at his death tick - 1 plus his eye height) and looks at his base killer (latestDeath), and the
// weapon HUD heads it "Spectating <teammate>". It ends at the next misc entry whose target is alive (IN_EYE or
// CHASE: the 'spectated' row) or when the focused player respawns.
//
// povSubjectAt is a pure function of the demo data and the tick (D12): it reads the base caches (health, team,
// connection, deaths) and the extras `misc` track, never the scene.

import { useMemo } from 'react'

import type { AsyncParser } from '@components/Analyse/Data/AsyncParser'
import { useInstance, useStore } from '@zus/store'
import { OBS_MODE } from '@highlander/extras/enums'
import { miscAt } from '@highlander/extras/getters'
import { useExtras, useHlSetting } from '@highlander/extras/hooks'
import { trackIndexAt } from '@highlander/extras/track'
import type { HighlanderExtras } from '@highlander/extras/types'

export type PovCameraKind = 'own' | 'spectated' | 'chase' | 'deathcam' | 'stay'
export interface PovSubject {
  focusedEntityId: number; focusedP: number      // the player the user picked
  entityId: number; p: number                    // the player whose view, FOV, viewmodel and HUD are shown
  camera: PovCameraKind
  killerEntityId?: number                        // deathcam: the actor the camera looks at
  deathTick?: number                             // deathcam: the latest death at or before the tick of the player `entityId`
  /**
   * Teammate-death camera (contract 12.2 item 1): the spectated teammate whose death the death camera shows. Then
   * `entityId`/`p` are that teammate, `deathTick` his death and `killerEntityId` his base killer. Unset for the
   * focused player's own death camera (`entityId` is the focused player there).
   */
  deathOfEntityId?: number
}

/** Base death events can trail the health drop by up to one 4-tick health bucket; look this far ahead for them. */
const DEATH_LOOKAHEAD = 4
/**
 * The server switches the observer mode to DEATHCAM one to three ticks after the death. While the mode still reads
 * NONE this soon after the base death, the death camera already looks at the killer instead of snapping to him a few
 * ticks later.
 */
const DEATHCAM_GRACE_TICKS = 8
/** Upper bound on the misc entries walked back to the death (a dead player has a few dozen at most). */
const MAX_RUN_STEPS = 1024
const NONE_U8 = 255

/** A base death: its cache tick and the killer's entity id (-1 for none: the world, a suicide, an unknown player). */
export interface DeathRecord {
  tick: number
  killer: number
}

// Deaths per victim entity id, ascending by tick, built once per parsed demo from the base `deaths`.
const deathIndex = new WeakMap<AsyncParser, Map<number, DeathRecord[]>>()

function deathsOf(demo: AsyncParser, entityId: number): DeathRecord[] {
  let index = deathIndex.get(demo)
  if (!index) {
    index = new Map()
    for (const key in demo.deaths) {
      for (const death of demo.deaths[key]) {
        const victim = death.victim?.user?.entityId
        if (victim === undefined) continue
        const killer = death.killer?.user?.entityId
        let list = index.get(victim)
        if (!list) index.set(victim, (list = []))
        list.push({ tick: death.tick, killer: killer !== undefined && killer !== victim ? killer : -1 })
      }
    }
    for (const list of index.values()) list.sort((a, b) => a.tick - b.tick)
    deathIndex.set(demo, index)
  }
  return index.get(entityId) ?? []
}

/** The latest base death of `entityId` at or before `tick` (plus the health-bucket lookahead), or null. */
export function latestDeath(demo: AsyncParser, entityId: number, tick: number): DeathRecord | null {
  const list = deathsOf(demo, entityId)
  let lo = 0, hi = list.length
  const limit = tick + DEATH_LOOKAHEAD
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (list[mid].tick <= limit) lo = mid + 1
    else hi = mid
  }
  return lo > 0 ? list[lo - 1] : null
}

/** The tick of `latestDeath`, or null. */
export function latestDeathTick(demo: AsyncParser, entityId: number, tick: number): number | null {
  return latestDeath(demo, entityId, tick)?.tick ?? null
}

/**
 * True while player p's observer state still belongs to his own death at `deathTick`: no misc entry after the death
 * up to `tick` has him in IN_EYE or CHASE. Once he has spectated someone, a DEATHCAM or FREEZECAM run means the
 * teammate he spectated died (tournament mode falls back to OBS_MODE_DEATHCAM with the dead teammate as the target),
 * so it is not his death camera.
 */
function inOwnDeathRun(x: HighlanderExtras, p: number, deathTick: number, tick: number): boolean {
  const t = x.players.misc
  const lo = t.offsets[p] ?? 0
  let steps = 0
  for (let k = trackIndexAt(t, p, tick); k >= lo && t.ticks[k] > deathTick; k--) {
    if (++steps > MAX_RUN_STEPS) return false
    const mode = t.obsMode[k]
    if (mode === OBS_MODE.IN_EYE || mode === OBS_MODE.CHASE) return false
  }
  return true
}

/** Base health of player index p at a cache tick (4-tick buckets, as the actors use it); 0 outside the demo. */
export function baseHealthAt(demo: AsyncParser, p: number, tick: number): number {
  if (p < 0 || tick < 0 || tick >= demo.ticks) return 0
  return demo.playerCache.healthCache.get(p, tick) || 0
}

/** True when DemoViewer renders an actor for p at the tick (connected, on RED or BLU) and he is alive. */
export function aliveWithActorAt(demo: AsyncParser, p: number, tick: number): boolean {
  if (p < 0 || p >= demo.nextMappedPlayer) return false
  if (baseHealthAt(demo, p, tick) <= 0) return false
  if (!demo.playerCache.connectedCache.get(p, tick)) return false
  const team = demo.playerCache.metaCache.getMeta(p, tick).teamId
  return team === 2 || team === 3
}

/** Entity id of player index p, or -1. */
export function entityIdOfPlayer(demo: AsyncParser, p: number): number {
  return demo.entityPlayerMap.get(p)?.user.entityId ?? -1
}

export function povSubjectAt(x: HighlanderExtras | undefined, demo: AsyncParser, focusedEntityId: number, tick: number, opts: { deadPov: 'stay' | 'spectated'; chase: boolean }): PovSubject {
  const focusedP = demo.playerIndexOfEntity(focusedEntityId)
  const own: PovSubject = { focusedEntityId, focusedP, entityId: focusedEntityId, p: focusedP, camera: opts.chase ? 'chase' : 'own' }
  if (focusedP < 0 || baseHealthAt(demo, focusedP, tick) > 0) return own

  // Dead from here on
  if (opts.deadPov === 'stay') return { ...own, camera: 'stay' }

  const death = latestDeath(demo, focusedEntityId, tick)
  const deathcam: PovSubject = { focusedEntityId, focusedP, entityId: focusedEntityId, p: focusedP, camera: 'deathcam', deathTick: death?.tick }

  const misc = x && x.meta.available.misc ? miscAt(x, focusedP, tick) : null
  if (!x || !misc) return deathcam
  const { obsMode, obsTarget } = misc
  const targetEntityId = obsTarget === NONE_U8 ? -1 : entityIdOfPlayer(demo, obsTarget)
  const spectating = obsMode === OBS_MODE.IN_EYE || obsMode === OBS_MODE.CHASE

  if (spectating && targetEntityId > 0 && obsTarget !== focusedP && aliveWithActorAt(demo, obsTarget, tick)) {
    const camera: PovCameraKind = obsMode === OBS_MODE.CHASE || opts.chase ? 'chase' : 'spectated'
    return { focusedEntityId, focusedP, entityId: targetEntityId, p: obsTarget, camera }
  }

  // His own death camera names the killer: from the base death on (the health buckets read dead up to three ticks
  // early), during DEATHCAM or FREEZECAM (or NONE in the few ticks before the server switches the mode), and only
  // until he first spectates someone.
  if (death && tick >= death.tick) {
    const deathMode = obsMode === OBS_MODE.DEATHCAM || obsMode === OBS_MODE.FREEZECAM || (obsMode === OBS_MODE.NONE && tick - death.tick <= DEATHCAM_GRACE_TICKS)
    if (deathMode && inOwnDeathRun(x, focusedP, death.tick, tick)) {
      // The killfeed's killer. Without one (a suicide, the world, an unknown player), the networked target counts
      // only when it is an enemy player, never himself or a teammate.
      let killer = death.killer
      if (killer <= 0 && targetEntityId > 0 && obsTarget !== focusedP) {
        const team = demo.playerCache.metaCache.getMeta(focusedP, tick).teamId
        const targetTeam = demo.playerCache.metaCache.getMeta(obsTarget, tick).teamId
        if ((targetTeam === 2 || targetTeam === 3) && targetTeam !== team) killer = targetEntityId
      }
      return killer > 0 ? { ...deathcam, killerEntityId: killer } : deathcam
    }
  }

  // The teammate he spectated died: IN_EYE or CHASE with a dead target, or the DEATHCAM fallback of tournament mode
  // that keeps the dead teammate as the target (FREEZECAM included: both hold a target). The pre-death health-bucket
  // ticks never get here, because the observer mode still reads NONE while he lives.
  const fallback = obsMode === OBS_MODE.DEATHCAM || obsMode === OBS_MODE.FREEZECAM
  if ((spectating || fallback) && targetEntityId > 0 && obsTarget !== focusedP) {
    const mate = teammateDeathAt(demo, focusedP, obsTarget, targetEntityId, tick)
    if (mate) return { focusedEntityId, focusedP, ...mate }
  }

  // Everything else: the death camera at his own death spot without a killer
  return deathcam
}

/**
 * The teammate-death camera on player `p` (entity `entityId`), the target of the dead focused player `focusedP` at
 * `tick`: only while `p` is on the focused player's team, connected and dead, and has a base death at or before the
 * tick. Returns the subject fields, or null.
 */
function teammateDeathAt(
  demo: AsyncParser,
  focusedP: number,
  p: number,
  entityId: number,
  tick: number
): Pick<PovSubject, 'entityId' | 'p' | 'camera' | 'deathTick' | 'killerEntityId' | 'deathOfEntityId'> | null {
  if (p < 0 || p >= demo.nextMappedPlayer || tick < 0 || tick >= demo.ticks) return null
  const team = demo.playerCache.metaCache.getMeta(focusedP, tick).teamId
  if (team !== 2 && team !== 3) return null
  if (demo.playerCache.metaCache.getMeta(p, tick).teamId !== team) return null
  if (!demo.playerCache.connectedCache.get(p, tick) || baseHealthAt(demo, p, tick) > 0) return null
  const death = latestDeath(demo, entityId, tick)
  if (!death) return null
  return {
    entityId,
    p,
    camera: 'deathcam',
    deathTick: death.tick,
    killerEntityId: death.killer > 0 ? death.killer : undefined,
    deathOfEntityId: entityId,
  }
}

/** Null unless the controls mode is 'pov' and focusedObject is set. */
export function usePovSubject(renderTick: number): PovSubject | null {
  const controlsMode = useStore(s => s.scene.controls.mode)
  const focusedEntityId = useInstance(s => s.focusedObject?.userData?.entityId as number | undefined)
  const demo = useInstance(s => s.parsedDemo)
  const extras = useExtras()
  const deadPov = useHlSetting<'stay' | 'spectated'>('pov.deadPov')
  const chase = useHlSetting<boolean>('pov.chase')

  return useMemo(() => {
    if (controlsMode !== 'pov' || focusedEntityId === undefined || !demo) return null
    return povSubjectAt(extras, demo, focusedEntityId, renderTick, { deadPov, chase })
  }, [controlsMode, focusedEntityId, demo, extras, renderTick, deadPov, chase])
}

/** usePovSubject for non-React code (probes, useFrame callbacks): the subject at `tick` from the stores. */
export function getPovSubject(tick: number): PovSubject | null {
  const { focusedObject, parsedDemo, extras, extrasStatus } = useInstance.getState()
  const settings = useStore.getState().settings
  const focusedEntityId = focusedObject?.userData?.entityId as number | undefined
  if (useStore.getState().scene.controls.mode !== 'pov' || focusedEntityId === undefined || !parsedDemo) return null
  const pov = settings.highlander?.pov
  return povSubjectAt(extrasStatus === 'ready' ? extras : undefined, parsedDemo, focusedEntityId, tick, {
    deadPov: pov?.deadPov ?? 'spectated',
    chase: !!pov?.chase,
  })
}
