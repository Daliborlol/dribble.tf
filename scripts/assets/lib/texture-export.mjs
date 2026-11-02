// VTF to DDS and WebP sidecars (asset contract 2.5 and 12.3), the one Node path every stage uses for VTFs.
//
//   exportVtf(buf, { maxSize, webp, alpha }) -> Promise<{ dds, webp, info } | { unsupported: reason }>
//
// - DXT1, DXT1_ONEBITALPHA, DXT3 and DXT5 are rewrapped as DDS without re-encoding: frame 0, face 0, the full
//   VTF mip chain reversed to DDS order (largest first). `maxSize` drops the top mips above that edge (no
//   re-encode). A VTF without mips keeps its single level; the runtime then uses LinearFilter.
// - BGRA8888, BGR888, RGBA8888, ABGR8888, RGB888 and BGRX8888 become WebP only (frame 0, the largest mip that
//   fits `maxSize`).
// - With `webp` true a DXT texture also gets a WebP fallback for devices without S3TC, decoded here from the
//   largest DXT level within `webpMaxSize` (default 512): decoded WebP costs 4 bytes a texel on the GPU, so
//   the full DDS size would break the 256 MB per map budget (contract 12.6).
// - Anything else (UV88, RGBA16161616F, I8, ...) is unsupported: the material keeps its flat albedo.
//
// `info` = { srgb, oneBitAlpha, width, height, mips, frames, format } of what was written. Output bytes depend
// only on the VTF bytes and the options (sharp's WebP encoder is deterministic for one sharp version).

import sharp from 'sharp'

import { parseVtfHeader, vtfMipLayout } from './vtf.mjs'

const DXT = { 13: 'DXT1', 20: 'DXT1', 14: 'DXT3', 15: 'DXT5' }
// VTF format -> byte order of its channels, for the uncompressed formats this exporter reads.
const PLAIN = {
  0: { order: 'rgba', bytes: 4 }, // RGBA8888
  1: { order: 'abgr', bytes: 4 }, // ABGR8888
  2: { order: 'rgb', bytes: 3 }, // RGB888
  3: { order: 'bgr', bytes: 3 }, // BGR888
  12: { order: 'bgra', bytes: 4 }, // BGRA8888
  16: { order: 'bgrx', bytes: 4 }, // BGRX8888
}

const fourCC = s => s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24)

/** A DDS file (DX9 header, FourCC DXT1/3/5) holding `levels` (largest first). */
function buildDds(name, width, height, levels) {
  const header = Buffer.alloc(128)
  header.write('DDS ', 0, 'latin1')
  header.writeUInt32LE(124, 4)
  // CAPS | HEIGHT | WIDTH | PIXELFORMAT | LINEARSIZE, plus MIPMAPCOUNT with more than one level.
  header.writeUInt32LE(0x1 | 0x2 | 0x4 | 0x1000 | 0x80000 | (levels.length > 1 ? 0x20000 : 0), 8)
  header.writeUInt32LE(height, 12)
  header.writeUInt32LE(width, 16)
  header.writeUInt32LE(levels[0].length, 20)
  header.writeUInt32LE(levels.length, 28)
  header.writeUInt32LE(32, 76) // pixel format size
  header.writeUInt32LE(0x4, 80) // DDPF_FOURCC
  header.writeUInt32LE(fourCC(name) >>> 0, 84)
  header.writeUInt32LE(0x1000 | (levels.length > 1 ? 0x400008 : 0), 108) // TEXTURE (| COMPLEX | MIPMAP)
  return Buffer.concat([header, ...levels])
}

const rgb565 = (c, out, o) => {
  out[o] = (((c >> 11) & 31) * 255 + 15) / 31 | 0
  out[o + 1] = (((c >> 5) & 63) * 255 + 31) / 63 | 0
  out[o + 2] = ((c & 31) * 255 + 15) / 31 | 0
}

/** Decodes one DXT level to RGBA8. */
export function decodeDxt(kind, data, width, height) {
  const out = Buffer.alloc(width * height * 4)
  const bw = Math.max(1, Math.ceil(width / 4))
  const bh = Math.max(1, Math.ceil(height / 4))
  const blockBytes = kind === 'DXT1' ? 8 : 16
  const colors = new Uint8Array(16)
  const alphas = new Uint8Array(8)
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const o = (by * bw + bx) * blockBytes
      const co = kind === 'DXT1' ? o : o + 8
      const c0 = data.readUInt16LE(co)
      const c1 = data.readUInt16LE(co + 2)
      rgb565(c0, colors, 0)
      rgb565(c1, colors, 4)
      colors[3] = colors[7] = 255
      if (c0 > c1 || kind !== 'DXT1') {
        for (let i = 0; i < 3; i++) {
          colors[8 + i] = (2 * colors[i] + colors[4 + i]) / 3 | 0
          colors[12 + i] = (colors[i] + 2 * colors[4 + i]) / 3 | 0
        }
        colors[11] = colors[15] = 255
      } else {
        for (let i = 0; i < 3; i++) colors[8 + i] = (colors[i] + colors[4 + i]) / 2 | 0
        colors[11] = 255
        colors[12] = colors[13] = colors[14] = colors[15] = 0
      }
      const bits = data.readUInt32LE(co + 4)
      if (kind === 'DXT5') {
        alphas[0] = data[o]
        alphas[1] = data[o + 1]
        if (alphas[0] > alphas[1]) for (let i = 1; i < 7; i++) alphas[i + 1] = ((7 - i) * alphas[0] + i * alphas[1]) / 7 | 0
        else {
          for (let i = 1; i < 5; i++) alphas[i + 1] = ((5 - i) * alphas[0] + i * alphas[1]) / 5 | 0
          alphas[6] = 0
          alphas[7] = 255
        }
      }
      for (let p = 0; p < 16; p++) {
        const x = bx * 4 + (p & 3)
        const y = by * 4 + (p >> 2)
        if (x >= width || y >= height) continue
        const d = (y * width + x) * 4
        const ci = ((bits >>> (2 * p)) & 3) * 4
        out[d] = colors[ci]
        out[d + 1] = colors[ci + 1]
        out[d + 2] = colors[ci + 2]
        let a = colors[ci + 3]
        if (kind === 'DXT3') {
          const nibble = (data[o + (p >> 1)] >> ((p & 1) * 4)) & 15
          a = nibble * 17
        } else if (kind === 'DXT5') {
          const bit = 16 + p * 3
          const byte = o + (bit >> 3)
          const v = (data[byte] | (data[byte + 1] << 8) | ((data[byte + 2] ?? 0) << 16)) >> (bit & 7)
          a = alphas[v & 7]
        }
        out[d + 3] = a
      }
    }
  }
  return out
}

function plainToRgba(order, src, width, height) {
  const n = width * height
  const out = Buffer.alloc(n * 4)
  const stride = order.length === 3 ? 3 : 4
  const idx = c => order.indexOf(c)
  const [r, g, b, a] = [idx('r'), idx('g'), idx('b'), order.includes('a') ? idx('a') : -1]
  for (let i = 0; i < n; i++) {
    const s = i * stride
    out[i * 4] = src[s + r]
    out[i * 4 + 1] = src[s + g]
    out[i * 4 + 2] = src[s + b]
    out[i * 4 + 3] = a >= 0 ? src[s + a] : 255
  }
  return out
}

/** WebP of RGBA8 pixels; the alpha channel is kept only when `keepAlpha`. */
function webpOf(rgba, width, height, keepAlpha) {
  const image = sharp(rgba, { raw: { width, height, channels: 4 } })
  return (keepAlpha ? image : image.removeAlpha()).webp({ quality: 90, alphaQuality: 100, effort: 4, smartSubsample: false }).toBuffer()
}

/**
 * @param {Buffer} buf VTF file
 * @param {{ maxSize?: number, webpMaxSize?: number, webp?: boolean }} opts
 */
export async function exportVtf(buf, opts = {}) {
  const maxSize = opts.maxSize ?? 2048
  const webpMaxSize = Math.min(maxSize, opts.webpMaxSize ?? 512)
  let header
  try {
    header = parseVtfHeader(buf)
  } catch (error) {
    return { unsupported: error.message }
  }
  if (header.highResOffset === null) return { unsupported: 'no image data' }
  if (header.depth > 1) return { unsupported: 'volume texture' }
  const layout = vtfMipLayout(header)
  let top = 0
  while (top < layout.length - 1 && Math.max(layout[top].width, layout[top].height) > maxSize) top++
  const levelData = l => buf.subarray(l.offset, l.offset + l.bytes)
  if (layout.some(l => l.offset + l.bytes > buf.length)) return { unsupported: 'truncated' }
  const first = layout[top]
  const info = {
    srgb: true,
    oneBitAlpha: header.oneBitAlpha || header.format === 20,
    width: first.width,
    height: first.height,
    mips: layout.length - top,
    frames: header.frames,
    format: header.formatName,
  }
  // WebP keeps the alpha channel whenever the VTF has one, so one item serves every VMT that uses it.
  const keepAlpha = info.oneBitAlpha || ['DXT3', 'DXT5', 'RGBA8888', 'ABGR8888', 'BGRA8888'].includes(header.formatName)
  const dxt = DXT[header.format]
  if (dxt) {
    const dds = buildDds(dxt, first.width, first.height, layout.slice(top).map(levelData))
    let w = top
    while (w < layout.length - 1 && Math.max(layout[w].width, layout[w].height) > webpMaxSize) w++
    const lw = layout[w]
    const webp = opts.webp ? await webpOf(decodeDxt(dxt, levelData(lw), lw.width, lw.height), lw.width, lw.height, keepAlpha) : null
    return { dds, webp, info: { ...info, webpWidth: lw.width, webpHeight: lw.height } }
  }
  const plain = PLAIN[header.format]
  if (!plain) return { unsupported: `format ${header.formatName}` }
  const rgba = plainToRgba(plain.order, levelData(first), first.width, first.height)
  return { dds: null, webp: await webpOf(rgba, first.width, first.height, keepAlpha), info: { ...info, mips: 1 } }
}

/**
 * GPU bytes of a texture item (asset contract 12.6): DDS as stored (header aside), WebP as
 * width x height x 4 x 4/3.
 */
export const textureGpuBytes = item =>
  item.file && item.file.endsWith('.dds') ? Math.max(0, item.bytes - 128) : Math.round(item.width * item.height * 4 * 4 / 3)

/** GPU bytes of the WebP a device without S3TC loads instead. */
export const textureWebpGpuBytes = item =>
  Math.round((item.webpWidth ?? item.width) * (item.webpHeight ?? item.height) * 4 * 4 / 3)
