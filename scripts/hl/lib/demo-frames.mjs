// Frame-level scan of a SourceTV demo file (task B2): header fields and packet ticks, without parsing any message.
//
//   import { scanDemoFrames } from './lib/demo-frames.mjs'
//   scanDemoFrames('/path/demo.dem', { full: true })
//
// Layout (SDK public/demofile/demoformat.h, tf-demo-parser src/demo/header.rs and src/demo/packet/*.rs): a
// 1072-byte header ("HL2DEMO", demo protocol 3 on every local demo), then frames of `type u8, tick i32` followed by
//   1 Signon, 2 Message:     84 bytes of meta (flags, two view-angle sets, sequence in/out), u32 length, data
//   3 SyncTick:              nothing
//   4 ConsoleCmd, 6 DataTables, 8 StringTables: u32 length, data
//   5 UserCmd:               u32 sequence, u32 length, data
//   7 Stop:                  a 24-bit tick instead of 32 bits, then the end of the file
// The signon frames carry meaningless ticks (2147483648, 87731, 148998 on local demos), so the first real packet
// tick is the tick of the first Message frame.
//
// The cache builders (parser2 and the fork's lib.rs) start after 100 warmup packets with players, counting every
// frame from the first one. On every local demo the players exist from the first frame, so the earliest possible
// start is the tick of the 100th frame (`warmupEndTick`): demo tick 94 on 66 Hz demos, 188 on the 33 Hz 6v6 sample.
// parser2 also needs non-zero world bounds, and when they arrive later it starts later; the fork's fallback export
// ignores that condition and starts at `warmupEndTick`. src/components/Analyse/Data/ParseWorker.ts has the same
// rule in `warmupEndDemoTick` (scripts/hl/check-delayed-start.mjs compares the two).

import fs from 'node:fs'

export const DEMO_HEADER_BYTES = 1072
export const WARMUP_PACKETS = 100
const MESSAGE_META_BYTES = 84

/** Reads the demo header (1072 bytes). */
export function readDemoHeader(fd) {
  const buf = Buffer.alloc(DEMO_HEADER_BYTES)
  fs.readSync(fd, buf, 0, DEMO_HEADER_BYTES, 0)
  const str = (from, len) => buf.toString('latin1', from, from + len).replace(/\0[\s\S]*$/, '')
  return {
    demoType: str(0, 8),
    version: buf.readUInt32LE(8),
    protocol: buf.readUInt32LE(12),
    server: str(16, 260),
    nick: str(276, 260),
    map: str(536, 260),
    game: str(796, 260),
    duration: buf.readFloatLE(1056),
    ticks: buf.readUInt32LE(1060),
    frames: buf.readUInt32LE(1064),
    signon: buf.readUInt32LE(1068),
  }
}

/**
 * Walks the frames. Without `full` it stops once it knows the first Message tick and the warmup end; with `full`
 * it walks to the Stop frame (or the end of a cut file) and also reports the last packet tick and counts.
 */
export function scanDemoFrames(file, { full = false, warmupPackets = WARMUP_PACKETS } = {}) {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const header = readDemoHeader(fd)
    const WINDOW = 1 << 20
    const win = Buffer.alloc(WINDOW)
    let winStart = 0
    let winEnd = 0
    /** Makes [offset, offset + bytes) readable from `win`; false past the end of the file. */
    const need = (offset, bytes) => {
      if (offset + bytes > size) return false
      if (offset >= winStart && offset + bytes <= winEnd) return true
      winStart = offset
      winEnd = offset + fs.readSync(fd, win, 0, Math.min(WINDOW, size - offset), offset)
      return offset + bytes <= winEnd
    }
    const out = {
      file,
      fileBytes: size,
      header,
      firstPacketTick: null, // tick of the first Message frame
      warmupEndTick: null, // tick of frame number `warmupPackets` (1-based), when it is a Message frame
      warmupEndType: null,
      frames: 0, // frames before Stop (all types)
      messageFrames: 0,
      lastPacketTick: null, // tick of the last Message frame (full scans)
      stop: false,
      truncated: false,
      counts: {},
    }
    let offset = DEMO_HEADER_BYTES
    while (true) {
      // Stop is the type byte plus a 24-bit tick, the last 4 bytes of a complete file
      if (need(offset, 1) && win[offset - winStart] === 7) {
        out.stop = true
        break
      }
      if (!need(offset, 5)) {
        out.truncated = true
        break
      }
      const at = offset - winStart
      const type = win[at]
      const tick = win.readInt32LE(at + 1)
      let next
      if (type === 1 || type === 2) {
        if (!need(offset, 5 + MESSAGE_META_BYTES + 4)) {
          out.truncated = true
          break
        }
        next = offset + 5 + MESSAGE_META_BYTES + 4 + win.readUInt32LE(offset - winStart + 5 + MESSAGE_META_BYTES)
      } else if (type === 3) next = offset + 5
      else if (type === 4 || type === 6 || type === 8) {
        if (!need(offset, 9)) {
          out.truncated = true
          break
        }
        next = offset + 9 + win.readUInt32LE(offset - winStart + 5)
      } else if (type === 5) {
        if (!need(offset, 13)) {
          out.truncated = true
          break
        }
        next = offset + 13 + win.readUInt32LE(offset - winStart + 9)
      } else {
        out.error = `unknown frame type ${type} at byte ${offset}`
        break
      }
      if (next > size) {
        out.truncated = true // the frame's data is cut: the parsers stop before it
        break
      }
      out.frames++
      out.counts[type] = (out.counts[type] ?? 0) + 1
      if (type === 2) {
        out.messageFrames++
        if (out.firstPacketTick === null) out.firstPacketTick = tick
        out.lastPacketTick = tick
      }
      if (out.frames === warmupPackets) {
        out.warmupEndType = type
        if (type === 2) out.warmupEndTick = tick
      }
      if (!full && out.firstPacketTick !== null && out.frames >= warmupPackets) break
      offset = next
    }
    if (!full) out.lastPacketTick = null
    return out
  } finally {
    fs.closeSync(fd)
  }
}
