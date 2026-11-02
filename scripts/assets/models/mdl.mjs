// The few MDL header facts the bsp-to-glb studio manifest does not carry (asset contract 12.4).
//
//   mdlPoseParams(buf) -> { [name]: { min, max, loop } }   (studiohdr_t localposeparam, versions 44 to 49)

const readName = (buf, offset) => {
  if (offset <= 0 || offset >= buf.length) return ''
  const end = buf.indexOf(0, offset)
  return buf.toString('latin1', offset, end < 0 ? buf.length : end)
}

export function mdlPoseParams(buf) {
  if (!buf || buf.length < 308 || buf.toString('latin1', 0, 4) !== 'IDST') throw new Error('not an MDL file')
  const version = buf.readInt32LE(4)
  if (version < 44 || version > 49) throw new Error(`MDL version ${version} is not supported`)
  const count = buf.readInt32LE(300)
  const index = buf.readInt32LE(304)
  const out = {}
  if (count <= 0 || count > 64 || index <= 0 || index + count * 20 > buf.length) return out
  for (let i = 0; i < count; i++) {
    const at = index + i * 20
    const name = readName(buf, at + buf.readInt32LE(at))
    if (!name) continue
    const round = v => Math.round(v * 1e4) / 1e4
    out[name] = { min: round(buf.readFloatLE(at + 8)), max: round(buf.readFloatLE(at + 12)), loop: round(buf.readFloatLE(at + 16)) }
  }
  return out
}
