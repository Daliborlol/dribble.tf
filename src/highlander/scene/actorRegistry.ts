// Scene handles of the mounted player actors, keyed by entity id (contract section 6.4).
// Actors.tsx registers each actor after mount; layers look actors up instead of traversing the scene.

import * as THREE from 'three'

import { useInstance } from '@zus/store'
import { registerHlProbe } from '@highlander/debug'

export interface ActorHandles {
  entityId: number
  group: THREE.Group
  body: THREE.Group
  aim: THREE.Group
}

const actors = new Map<number, ActorHandles>()

/** Bumps actorRegistryVersion. */
export function registerActor(handles: ActorHandles): void {
  actors.set(handles.entityId, handles)
  useInstance.getState().bumpActorRegistryVersion()
}

/** Removes only if the stored entry is this object; bumps actorRegistryVersion. */
export function unregisterActor(handles: ActorHandles): void {
  if (actors.get(handles.entityId) === handles) actors.delete(handles.entityId)
  useInstance.getState().bumpActorRegistryVersion()
}

export function getActor(entityId: number): ActorHandles | undefined {
  return actors.get(entityId)
}

export function allActors(): IterableIterator<ActorHandles> {
  return actors.values()
}

export const useActorRegistryVersion = () => useInstance(s => s.actorRegistryVersion)

/**
 * Whether the player model is drawn: true when some mesh under `body` has every node from itself up to the actor
 * `group` visible. The model's own visibility sits on PlayerModel's inner group, not on `body`. Null while no
 * model mesh is mounted (GLB still loading, the class-change remount, no class or team).
 */
function modelVisibility(body: THREE.Object3D, group: THREE.Object3D): boolean | null {
  let meshes = 0
  let visible = false
  body.traverse(node => {
    if (visible || !(node as THREE.Mesh).isMesh) return
    meshes++
    for (let n: THREE.Object3D | null = node; n; n = n.parent) {
      if (!n.visible) return
      if (n === group) break
    }
    visible = true
  })
  return meshes > 0 ? visible : null
}

// Probe: which actors are registered, with their scene node ids, model visibility and world positions.
registerHlProbe('actors.registry', () =>
  Array.from(actors.values())
    .map(({ entityId, group, body, aim }) => {
      const position = group.getWorldPosition(new THREE.Vector3())
      return {
        entityId,
        groupId: group.id,
        userDataEntityId: group.userData?.entityId ?? null,
        modelVisible: modelVisibility(body, group),
        aimZ: Math.round(aim.position.z * 100) / 100,
        position: [position.x, position.y, position.z].map(v => Math.round(v * 10) / 10),
      }
    })
    .sort((a, b) => a.entityId - b.entityId)
)
