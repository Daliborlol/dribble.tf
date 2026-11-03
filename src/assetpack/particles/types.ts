// The pack's particles/systems.json (scripts/assets/particles/stage.mjs). Every value comes from the user's own
// .pcf files; nothing here is a Valve number.

export interface PcfOperator {
  fn: string
  [attr: string]: number | boolean | string | number[] | boolean[] | string[]
}

export interface PcfSystem {
  maxParticles: number
  initialParticles: number
  material: string
  radius: number
  color: number[]
  rotation: number
  rotationSpeed: number
  sequence: number
  emitters: PcfOperator[]
  initializers: PcfOperator[]
  operators: PcfOperator[]
  forces: PcfOperator[]
  constraints: PcfOperator[]
  renderers: PcfOperator[]
  children: { system: string; delay: number }[]
}

export interface PcfSheetSequence {
  clamp: boolean
  total: number
  frames: { duration: number; rect: number[] }[]
}

export interface PcfMaterial {
  shader: string
  blend: 'additive' | 'blend'
  overbright: number
  addself: number
  blendFrames: boolean
  maxSize: number
  minSize: number
  startFadeSize: number
  endFadeSize: number
  texture: string | null
  width: number
  height: number
  sheet: (PcfSheetSequence | null)[] | null
}

export interface PcfFile {
  version: number
  systems: Record<string, PcfSystem>
  materials: Record<string, PcfMaterial>
}
