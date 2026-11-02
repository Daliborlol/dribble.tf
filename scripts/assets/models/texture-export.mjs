// VTF to pack sidecars (asset contract 2.5 "Later, textures"). W-pack ships this file because M3-world's
// scripts/assets/lib/texture-export.mjs was not on `assets` when W-pack started (contract 12.2); the
// integrator who merges the second of the two dedupes them.
//
//   exportVtf(buf, { maxSize = 1024 })  -> Promise<{ dds: Buffer|null, webp: Buffer|null, info }>
//
//   - DXT1, DXT3 and DXT5 are rewrapped as DDS without re-encoding: the VTF high-res chain of frame 0,
//     face 0, reversed to DDS order (largest first). Mips larger than `maxSize` are dropped.
//   - RGBA8888, ABGR8888, RGB888, BGR888, ARGB8888, BGRA8888 and BGRX8888 become WebP (sharp, lossy q90,
//     lossless alpha), from the largest mip that fits `maxSize`.
//   - Every other format is unsupported (null, null); the material keeps its flat albedo.
//   `info` = { format, width, height, mips, frames, oneBitAlpha, srgbFlag } of what was written.

import sharp from 'sharp'
import { parseVtfHeader, vtfMipLayout } from '../lib/vtf.mjs'

const FOURCC = { 13: 'DXT1', 20: 'DXT1', 14: 'DXT3', 15: 'DXT5' }

// Byte order of the uncompressed formats, as indices into one source pixel: [r, g, b, a] (-1 = 255).
const RAW = {
  0: { bytes: 4, order: [0, 1, 2, 3] }, // RGBA8888
  1: { bytes: 4, order: [3, 2, 1, 0] }, // ABGR8888
  2: { bytes: 3, order: [0, 1, 2, -1] }, // RGB888
  3: { bytes: 3, order: [2, 1, 0, -1] }, // BGR888
  11: { bytes: 4, order: [1, 2, 3, 0] }, // ARGB8888
  12: { bytes: 4, order: [2, 1, 0, 3] }, // BGRA8888
  16: { bytes: 4, order: [2, 1, 0, -1] }, // BGRX8888
}

function ddsHeader(fourcc, width, height, mips, topBytes) {
  const h = Buffer.alloc(128)
  h.write('DDS ', 0, 'latin1')
  h.writeUInt32LE(124, 4)
  // CAPS | HEIGHT | WIDTH | PIXELFORMAT | MIPMAPCOUNT | LINEARSIZE
  h.writeUInt32LE(0x1 | 0x2 | 0x4 | 0x1000 | 0x20000 | 0x80000, 8)
  h.writeUInt32LE(height, 12)
  h.writeUInt32LE(width, 16)
  h.writeUInt32LE(topBytes, 20)
  h.writeUInt32LE(0, 24)
  h.writeUInt32LE(mips, 28)
  h.writeUInt32LE(32, 76) // pixel format size
  h.writeUInt32LE(0x4, 80) // DDPF_FOURCC
  h.write(fourcc, 84, 'latin1')
  h.writeUInt32LE(0x1000 | (mips > 1 ? 0x400000 | 0x8 : 0), 108) // TEXTURE (| MIPMAP | COMPLEX)
  return h
}

/** True when the VTF format can be written as a sidecar. */
export const vtfFormatSupported = format => format in FOURCC || format in RAW

export async function exportVtf(buf, { maxSize = 1024 } = {}) {
  const header = parseVtfHeader(buf)
  const layout = vtfMipLayout(header)
  const base = { frames: header.frames, oneBitAlpha: header.oneBitAlpha, srgbFlag: header.srgbFlag }
  if (header.highResOffset === null || !layout.length) return { dds: null, webp: null, info: null }
  let first = 0
  while (first < layout.length - 1 && Math.max(layout[first].width, layout[first].height) > maxSize) first++
  const kept = layout.slice(first)
  const top = kept[0]
  const end = buf.length
  for (const level of kept) if (level.offset === null || level.offset + level.bytes > end) throw new Error('VTF mip chain is truncated')
  const fourcc = FOURCC[header.format]
  if (fourcc) {
    const parts = [ddsHeader(fourcc, top.width, top.height, kept.length, top.bytes)]
    for (const level of kept) parts.push(buf.subarray(level.offset, level.offset + level.bytes))
    return {
      dds: Buffer.concat(parts),
      webp: null,
      info: { ...base, format: 'dds', width: top.width, height: top.height, mips: kept.length },
    }
  }
  const raw = RAW[header.format]
  if (!raw) return { dds: null, webp: null, info: null }
  const pixels = top.width * top.height
  const rgba = Buffer.alloc(pixels * 4)
  const src = buf.subarray(top.offset, top.offset + top.bytes)
  const [r, g, b, a] = raw.order
  for (let i = 0, s = 0, d = 0; i < pixels; i++, s += raw.bytes, d += 4) {
    rgba[d] = src[s + r]
    rgba[d + 1] = src[s + g]
    rgba[d + 2] = src[s + b]
    rgba[d + 3] = a < 0 ? 255 : src[s + a]
  }
  const webp = await sharp(rgba, { raw: { width: top.width, height: top.height, channels: 4 } })
    .webp({ quality: 90, alphaQuality: 100, effort: 4 })
    .toBuffer()
  return { dds: null, webp, info: { ...base, format: 'webp', width: top.width, height: top.height, mips: 1 } }
}
