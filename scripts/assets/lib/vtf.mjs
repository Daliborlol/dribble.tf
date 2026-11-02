// VTF header parse (7.0 to 7.5): version, size, format, flags, frames, faces, depth, reflectivity,
// bump scale, mip count, low-res thumbnail, resources, and the byte layout of the high-res mip chain.
//
//   parseVtfHeader(buf)      -> header object (throws on a buffer that is not a VTF)
//   vtfReflectivity(buf)     -> [r, g, b] linear 0..1 | null (the texture's average colour)
//   vtfMipLayout(header)     -> [{ level, width, height, depth, bytes, offset }], level 0 = largest,
//                               offsets of frame 0, face 0, slice 0
//   vtfImageBytes(format, w, h, d = 1)
//
// DDS rewrap and WebP conversion come in phase 2 (contract 2.5); they build on vtfMipLayout.

export const VTF_FORMATS = {
  [-1]: { name: 'NONE', bytes: 0 },
  0: { name: 'RGBA8888', bytes: 4 },
  1: { name: 'ABGR8888', bytes: 4 },
  2: { name: 'RGB888', bytes: 3 },
  3: { name: 'BGR888', bytes: 3 },
  4: { name: 'RGB565', bytes: 2 },
  5: { name: 'I8', bytes: 1 },
  6: { name: 'IA88', bytes: 2 },
  7: { name: 'P8', bytes: 1 },
  8: { name: 'A8', bytes: 1 },
  9: { name: 'RGB888_BLUESCREEN', bytes: 3 },
  10: { name: 'BGR888_BLUESCREEN', bytes: 3 },
  11: { name: 'ARGB8888', bytes: 4 },
  12: { name: 'BGRA8888', bytes: 4 },
  13: { name: 'DXT1', block: 8 },
  14: { name: 'DXT3', block: 16 },
  15: { name: 'DXT5', block: 16 },
  16: { name: 'BGRX8888', bytes: 4 },
  17: { name: 'BGR565', bytes: 2 },
  18: { name: 'BGRX5551', bytes: 2 },
  19: { name: 'BGRA4444', bytes: 2 },
  20: { name: 'DXT1_ONEBITALPHA', block: 8 },
  21: { name: 'BGRA5551', bytes: 2 },
  22: { name: 'UV88', bytes: 2 },
  23: { name: 'UVWQ8888', bytes: 4 },
  24: { name: 'RGBA16161616F', bytes: 8 },
  25: { name: 'RGBA16161616', bytes: 8 },
  26: { name: 'UVLX8888', bytes: 4 },
}

export const VTF_FLAGS = {
  POINTSAMPLE: 0x1,
  TRILINEAR: 0x2,
  CLAMPS: 0x4,
  CLAMPT: 0x8,
  ANISOTROPIC: 0x10,
  HINT_DXT5: 0x20,
  SRGB: 0x40,
  NORMAL: 0x80,
  NOMIP: 0x100,
  NOLOD: 0x200,
  ALL_MIPS: 0x400,
  PROCEDURAL: 0x800,
  ONEBITALPHA: 0x1000,
  EIGHTBITALPHA: 0x2000,
  ENVMAP: 0x4000,
  RENDERTARGET: 0x8000,
  DEPTHRENDERTARGET: 0x10000,
  NODEBUGOVERRIDE: 0x20000,
  SINGLECOPY: 0x40000,
  PRE_SRGB: 0x80000,
  NODEPTHBUFFER: 0x800000,
  CLAMPU: 0x2000000,
  VERTEXTEXTURE: 0x4000000,
  SSBUMP: 0x8000000,
  BORDER: 0x20000000,
}

const RESOURCE_LOW_RES = 0x01
const RESOURCE_HIGH_RES = 0x30
const RESOURCE_NO_DATA = 0x2

/** Bytes of one image (one mip of one frame, face and slice set of `d` slices). */
export function vtfImageBytes(format, width, height, depth = 1) {
  const f = VTF_FORMATS[format]
  if (!f) throw new Error(`unknown VTF format ${format}`)
  if (f.block) return Math.max(1, Math.ceil(width / 4)) * Math.max(1, Math.ceil(height / 4)) * f.block * depth
  return width * height * depth * f.bytes
}

/** Parses a VTF header. Needs the first `headerSize` bytes (at most a few hundred). */
export function parseVtfHeader(buf) {
  if (!buf || buf.length < 64 || buf.toString('latin1', 0, 4) !== 'VTF\0') throw new Error('not a VTF file')
  const major = buf.readUInt32LE(4)
  const minor = buf.readUInt32LE(8)
  if (major !== 7 || minor > 5) throw new Error(`VTF version ${major}.${minor} is not supported`)
  const headerSize = buf.readUInt32LE(12)
  const width = buf.readUInt16LE(16)
  const height = buf.readUInt16LE(18)
  const flags = buf.readUInt32LE(20)
  const frames = Math.max(1, buf.readUInt16LE(24))
  const firstFrame = buf.readUInt16LE(26)
  const reflectivity = [buf.readFloatLE(32), buf.readFloatLE(36), buf.readFloatLE(40)]
  const bumpScale = buf.readFloatLE(48)
  const format = buf.readInt32LE(52)
  const mips = buf.readUInt8(56)
  const lowFormat = buf.readInt32LE(57)
  const lowWidth = buf.readUInt8(61)
  const lowHeight = buf.readUInt8(62)
  const depth = minor >= 2 && buf.length >= 65 ? Math.max(1, buf.readUInt16LE(63)) : 1
  const envmap = (flags & VTF_FLAGS.ENVMAP) !== 0
  // Versions before 7.5 store a seventh (spheremap) face unless firstFrame is 0xffff.
  const faces = envmap ? (minor < 5 && firstFrame !== 0xffff ? 7 : 6) : 1
  if (!VTF_FORMATS[format]) throw new Error(`unknown VTF format ${format}`)

  const resources = []
  let lowResOffset = null
  let highResOffset = null
  if (minor >= 3) {
    const count = buf.readUInt32LE(68)
    if (buf.length < 80 + count * 8) throw new Error(`VTF header truncated (${count} resources)`)
    for (let i = 0; i < count; i++) {
      const o = 80 + i * 8
      const tag = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16)
      const rflags = buf[o + 3]
      const data = buf.readUInt32LE(o + 4)
      resources.push({ tag: tagName(buf, o), flags: rflags, data })
      if (tag === RESOURCE_LOW_RES && !(rflags & RESOURCE_NO_DATA)) lowResOffset = data
      if (tag === RESOURCE_HIGH_RES && !(rflags & RESOURCE_NO_DATA)) highResOffset = data
    }
  }
  const lowResBytes = lowFormat >= 0 && lowWidth && lowHeight ? vtfImageBytes(lowFormat, lowWidth, lowHeight) : 0
  if (minor < 3) {
    lowResOffset = lowResBytes ? headerSize : null
    highResOffset = headerSize + lowResBytes
  }
  const header = {
    version: [major, minor],
    headerSize,
    width,
    height,
    depth,
    flags,
    flagNames: Object.entries(VTF_FLAGS).filter(([, bit]) => flags & bit).map(([name]) => name),
    frames,
    firstFrame,
    faces,
    reflectivity,
    bumpScale,
    format,
    formatName: VTF_FORMATS[format].name,
    compressed: Boolean(VTF_FORMATS[format].block),
    mips,
    lowRes: { format: lowFormat, formatName: VTF_FORMATS[lowFormat]?.name ?? null, width: lowWidth, height: lowHeight, offset: lowResOffset, bytes: lowResBytes },
    resources,
    srgbFlag: (flags & VTF_FLAGS.SRGB) !== 0,
    oneBitAlpha: (flags & VTF_FLAGS.ONEBITALPHA) !== 0,
    eightBitAlpha: (flags & VTF_FLAGS.EIGHTBITALPHA) !== 0,
    highResOffset,
  }
  header.highResBytes = highResOffset === null ? 0 : vtfMipLayout(header).reduce((sum, m) => sum + m.bytes * frames * faces, 0)
  return header
}

function tagName(buf, o) {
  const bytes = [buf[o], buf[o + 1], buf[o + 2]]
  return bytes.every(b => b >= 0x20 && b < 0x7f) ? String.fromCharCode(...bytes) : bytes.map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * The high-res mip chain. VTF stores the smallest mip first; for each mip: frames, then faces, then
 * the depth slices. `offset` is the file offset of frame 0, face 0 of that mip, `stride` the bytes
 * between consecutive frames (faces follow each other inside a frame).
 */
export function vtfMipLayout(header) {
  const levels = []
  for (let level = 0; level < header.mips; level++) {
    const width = Math.max(1, header.width >> level)
    const height = Math.max(1, header.height >> level)
    const depth = Math.max(1, header.depth >> level)
    levels.push({ level, width, height, depth, bytes: vtfImageBytes(header.format, width, height, depth) })
  }
  if (header.highResOffset === null) return levels.map(l => ({ ...l, offset: null, stride: null }))
  let offset = header.highResOffset
  for (let level = header.mips - 1; level >= 0; level--) {
    const l = levels[level]
    l.offset = offset
    l.stride = l.bytes * header.faces
    offset += l.bytes * header.faces * header.frames
  }
  return levels
}

const clamp01 = v => Math.min(1, Math.max(0, v))

/**
 * VTF reflectivity, the texture's average linear colour (what VBSP uses for brush texdata), with the
 * same validity rule as scripts/lib/static-props.mjs: finite, each channel 0 to 4, sum above 1e-4.
 */
export function vtfReflectivity(buf) {
  if (!buf || buf.length < 44 || buf.toString('latin1', 0, 3) !== 'VTF') return null
  const r = [buf.readFloatLE(32), buf.readFloatLE(36), buf.readFloatLE(40)]
  if (!r.every(Number.isFinite) || r.some(v => v < 0 || v > 4) || r[0] + r[1] + r[2] < 1e-4) return null
  return r.map(clamp01)
}
