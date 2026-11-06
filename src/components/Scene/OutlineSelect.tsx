// A Select for @react-three/postprocessing's Selection without its update loop (as/perf).
//
// The library's Select re-runs its effect whenever the selection context changes and treats any traversed object
// that is not selected as a change. Its own group is never selected (only meshes are), so every run selects again,
// which changes the context, which re-runs every Select's effect: an endless chain of r3f commits that traversed
// every player model (bones included) several times per frame, with outlines on or off.
//
// This one selects the same meshes (type 'Mesh' under the group, as the library does) when it mounts or its
// children change, and removes them on unmount. While player outlines are on it also checks once per frame for
// meshes that appeared later (third-person weapons that finished loading), which the library's loop picked up.

import { useContext, useEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { selectionContext } from '@react-three/postprocessing'
import type * as THREE from 'three'

import { useStore } from '@zus/store'

type SelectProps = JSX.IntrinsicElements['group'] & { enabled?: boolean }

function meshesUnder(group: THREE.Object3D): THREE.Object3D[] {
  const out: THREE.Object3D[] = []
  group.traverse(o => {
    if (o.type === 'Mesh') out.push(o)
  })
  return out
}

const sameList = (a: THREE.Object3D[], b: THREE.Object3D[]) => a.length === b.length && a.every((o, i) => o === b[i])

export const Select = ({ enabled = false, children, ...props }: SelectProps) => {
  const group = useRef<THREE.Group>(null)
  const api = useContext(selectionContext)
  const select = api?.select
  const current = useRef<THREE.Object3D[]>([])

  const apply = (next: THREE.Object3D[]) => {
    if (!select) return
    const prev = current.current
    if (sameList(prev, next)) return
    current.current = next
    select(state => [...state.filter(o => !prev.includes(o)), ...next])
  }

  // Nothing reads the selection while outlines are off: no traversal of the player's nodes on his renders (react-perf),
  // and no context update per mounting player. With outlines on, the frame callback selects within a frame.
  useEffect(() => {
    if (!select || !enabled) return
    return () => {
      const prev = current.current
      current.current = []
      if (prev.length) select(state => state.filter(o => !prev.includes(o)))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, select])

  useFrame(() => {
    if (!select || !enabled || !group.current) return
    if (!useStore.getState().settings.ui.playerOutlines) {
      if (current.current.length) apply([])
      return
    }
    apply(meshesUnder(group.current))
  })

  return (
    <group ref={group} {...props}>
      {children}
    </group>
  )
}
