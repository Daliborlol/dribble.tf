// A stripped copy of drei's Html for the nameplates: only non-transform mode without occlusion. It skips every per-frame
// read and write while the plate is hidden, and it does not write z-index: declutterPlates writes a rank when the order
// changes. drei's writes transform and z-index for every plate every frame, and any composited transform write makes
// Blink rerun its layerization: in the TF2 look 17 of 18 plates are hidden and paid for all of it.
import * as React from 'react'
import * as ReactDOM from 'react-dom/client'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'

import { plateSkipsWrites } from '@highlander/perf/nameplates'

const v1 = new THREE.Vector3()
const v2 = new THREE.Vector3()
const v3 = new THREE.Vector3()
const EPS = 0.001

interface PlateHtmlProps {
  entityId: number
  className?: string
  style?: React.CSSProperties
  position?: [number, number, number]
  name?: string
  children?: React.ReactNode
}

export const PlateHtml = React.forwardRef<HTMLDivElement, PlateHtmlProps>(({ entityId, children, className, style, ...props }, ref) => {
  const { gl, camera, scene, size, events } = useThree()
  const [el] = React.useState(() => document.createElement('div'))
  const root = React.useRef<ReactDOM.Root>()
  const group = React.useRef<THREE.Group>(null)
  const old = React.useRef([0, 0])
  const shownState = React.useRef({ behind: false, skipped: false })
  const target = (events.connected || gl.domElement.parentNode) as HTMLElement | null

  React.useLayoutEffect(() => {
    if (!group.current) return
    const currentRoot = (root.current = ReactDOM.createRoot(el))
    scene.updateMatrixWorld()
    v1.setFromMatrixPosition(group.current.matrixWorld).project(camera)
    const x = v1.x * (size.width / 2) + size.width / 2
    const y = -(v1.y * (size.height / 2)) + size.height / 2
    el.style.cssText = `position:absolute;top:0;left:0;transform:translate3d(${x}px,${y}px,0);transform-origin:0 0;`
    if (target) target.appendChild(el)
    return () => {
      if (target) target.removeChild(el)
      currentRoot.unmount()
    }
  }, [target])

  const styles = React.useMemo<React.CSSProperties>(() => ({ position: 'absolute', transform: 'none', ...style }), [style])
  React.useLayoutEffect(() => {
    root.current?.render(<div ref={ref} style={styles} className={className}>{children}</div>)
  })

  useFrame(() => {
    const g = group.current
    if (!g) return
    const state = shownState.current
    if (plateSkipsWrites(entityId)) {
      if (!state.skipped) {
        state.skipped = true
        el.style.display = 'none'
      }
      return
    }
    camera.updateMatrixWorld()
    g.updateWorldMatrix(true, false)
    v1.setFromMatrixPosition(g.matrixWorld)
    const delta = v2.setFromMatrixPosition(camera.matrixWorld).negate().add(v1)
    const behind = delta.angleTo(camera.getWorldDirection(v3)) > Math.PI / 2
    v1.project(camera)
    const x = v1.x * (size.width / 2) + size.width / 2
    const y = -(v1.y * (size.height / 2)) + size.height / 2
    const moved = Math.abs(old.current[0] - x) > EPS || Math.abs(old.current[1] - y) > EPS
    if (state.skipped || behind !== state.behind) {
      el.style.display = behind ? 'none' : 'block'
      state.behind = behind
      state.skipped = false
    }
    if (moved) {
      el.style.transform = `translate3d(${x}px,${y}px,0) scale(1)`
      old.current[0] = x
      old.current[1] = y
    }
  })

  return <group {...props} ref={group} />
})
