// Binary DMX reader (Source 2007 era, encodings 2 to 5) for particle .pcf files.
//
//   parseDmx(buf) -> { encoding, format, root, elements }
//
// Each element is `{ type, name, attrs: { <name>: value } }`; element references resolve to the element objects
// (arrays of them for element arrays), so `root.attrs.particleSystemDefinitions` is the definition list.
// Colours come back as [r, g, b, a] bytes, vectors as arrays, binary blobs as Buffers.

const T = {
  ELEMENT: 1, INT: 2, FLOAT: 3, BOOL: 4, STRING: 5, VOID: 6, OBJECTID: 7, COLOR: 8,
  VECTOR2: 9, VECTOR3: 10, VECTOR4: 11, QANGLE: 12, QUATERNION: 13, VMATRIX: 14,
}
const ARRAY_BASE = 14

export function parseDmx(buf) {
  const headerEnd = buf.indexOf(0)
  const header = buf.subarray(0, headerEnd).toString('latin1')
  const m = /dmx encoding binary (\d+) format (\S+) (\d+)/.exec(header)
  if (!m) throw new Error(`not a binary DMX file: ${JSON.stringify(header.slice(0, 60))}`)
  const enc = Number(m[1])
  if (enc < 2 || enc > 5) throw new Error(`unsupported DMX binary encoding ${enc}`)
  let o = headerEnd + 1
  const u8 = () => buf[o++]
  const i16 = () => { const v = buf.readInt16LE(o); o += 2; return v }
  const i32 = () => { const v = buf.readInt32LE(o); o += 4; return v }
  const f32 = () => { const v = buf.readFloatLE(o); o += 4; return v }
  const str = () => { const e = buf.indexOf(0, o); const s = buf.subarray(o, e).toString('latin1'); o = e + 1; return s }
  const idx = () => (enc >= 5 ? i32() : i16())
  const count = enc >= 4 ? i32() : i16()
  const strings = []
  for (let i = 0; i < count; i++) strings.push(str())
  const S = () => strings[idx()]

  const n = i32()
  const elements = []
  for (let i = 0; i < n; i++) {
    const type = S()
    const name = enc >= 4 ? S() : str()
    o += 16 // GUID
    elements.push({ type, name, attrs: {} })
  }
  const elementRef = () => {
    const k = i32()
    if (k === -1) return null
    if (k === -2) { str(); return null } // external GUID reference
    return k
  }
  const fixups = []
  const scalar = (t, inArray) => {
    switch (t) {
      case T.ELEMENT: return elementRef()
      case T.INT: return i32()
      case T.FLOAT: return f32()
      case T.BOOL: return u8() !== 0
      case T.STRING: return inArray || enc < 4 ? str() : S()
      case T.VOID: { const len = i32(); const b = Buffer.from(buf.subarray(o, o + len)); o += len; return b }
      case T.OBJECTID: o += 16; return null
      case T.COLOR: { const c = [buf[o], buf[o + 1], buf[o + 2], buf[o + 3]]; o += 4; return c }
      case T.VECTOR2: return [f32(), f32()]
      case T.VECTOR3: case T.QANGLE: return [f32(), f32(), f32()]
      case T.VECTOR4: case T.QUATERNION: return [f32(), f32(), f32(), f32()]
      case T.VMATRIX: { const a = []; for (let k = 0; k < 16; k++) a.push(f32()); return a }
      default: throw new Error(`unknown DMX attribute type ${t} at ${o}`)
    }
  }
  for (let i = 0; i < n; i++) {
    const el = elements[i]
    const na = i32()
    for (let a = 0; a < na; a++) {
      const name = S()
      const t = u8()
      if (t > ARRAY_BASE) {
        const bt = t - ARRAY_BASE
        const len = i32()
        const arr = []
        for (let k = 0; k < len; k++) arr.push(scalar(bt, true))
        el.attrs[name] = arr
        if (bt === T.ELEMENT) fixups.push([el, name, true])
      } else {
        el.attrs[name] = scalar(t, false)
        if (t === T.ELEMENT) fixups.push([el, name, false])
      }
    }
  }
  if (o !== buf.length) throw new Error(`DMX parse ended at ${o} of ${buf.length} bytes`)
  for (const [el, name, isArray] of fixups) {
    const v = el.attrs[name]
    el.attrs[name] = isArray ? v.map(k => (k === null ? null : elements[k])) : v === null ? null : elements[v]
  }
  return { encoding: enc, format: m[2], root: elements[0], elements }
}
