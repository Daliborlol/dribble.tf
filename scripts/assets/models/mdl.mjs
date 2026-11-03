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

// Sequence facts for the player animation export (as/tpanim): the blend parameters, pose keys, per-bone weights and
// fade times of every local sequence (mstudioseqdesc_t, 212 bytes), and each local animation's motion over one
// loop (mstudioanimdesc_t, 100 bytes, its last mstudiomovement_t). Offsets are relative to each struct.
//
//   mdlSequences(buf)  -> [{ name, flags, groupSize, paramIndex, paramStart, paramEnd, poseKeys, weights, fadeIn, fadeOut }]
//   mdlAnimMotion(buf) -> [{ name, frames, fps, motion: [x, y, z] | null }]

function header(buf) {
  if (!buf || buf.length < 308 || buf.toString('latin1', 0, 4) !== 'IDST') throw new Error('not an MDL file')
  const version = buf.readInt32LE(4)
  if (version < 44 || version > 49) throw new Error(`MDL version ${version} is not supported`)
  return { bones: buf.readInt32LE(156) }
}

export function mdlSequences(buf) {
  const { bones } = header(buf)
  const count = buf.readInt32LE(188)
  const index = buf.readInt32LE(192)
  const out = []
  for (let i = 0; i < count; i++) {
    const at = index + i * 212
    if (at + 212 > buf.length) break
    const groupSize = [buf.readInt32LE(at + 68), buf.readInt32LE(at + 72)]
    const posekey = buf.readInt32LE(at + 160)
    const poseKeys = []
    if (posekey > 0) for (let k = 0; k < groupSize[0] + groupSize[1]; k++) poseKeys.push(buf.readFloatLE(at + posekey + 4 * k))
    const wl = buf.readInt32LE(at + 156)
    const weights = []
    if (wl > 0 && at + wl + bones * 4 <= buf.length) for (let b = 0; b < bones; b++) weights.push(buf.readFloatLE(at + wl + 4 * b))
    out.push({
      name: readName(buf, at + buf.readInt32LE(at + 4)),
      flags: buf.readInt32LE(at + 12),
      groupSize,
      paramIndex: [buf.readInt32LE(at + 76), buf.readInt32LE(at + 80)],
      paramStart: [buf.readFloatLE(at + 84), buf.readFloatLE(at + 88)],
      paramEnd: [buf.readFloatLE(at + 92), buf.readFloatLE(at + 96)],
      poseKeys,
      weights,
      fadeIn: buf.readFloatLE(at + 104),
      fadeOut: buf.readFloatLE(at + 108),
    })
  }
  return out
}

export function mdlAnimMotion(buf) {
  header(buf)
  const count = buf.readInt32LE(180)
  const index = buf.readInt32LE(184)
  const out = []
  for (let i = 0; i < count; i++) {
    const at = index + i * 100
    if (at + 100 > buf.length) break
    const moves = buf.readInt32LE(at + 20)
    const mi = buf.readInt32LE(at + 24)
    let motion = null
    if (moves > 0 && mi > 0) {
      const m = at + mi + (moves - 1) * 44
      if (m + 44 <= buf.length) motion = [0, 1, 2].map(j => buf.readFloatLE(m + 32 + 4 * j))
    }
    out.push({ name: readName(buf, at + buf.readInt32LE(at + 4)), fps: buf.readFloatLE(at + 8), frames: buf.readInt32LE(at + 16), motion })
  }
  return out
}

// Material names and $cdmaterials search dirs (studiohdr_t numtextures/textureindex at 204/208, mstudiotexture_t
// 64 bytes with a struct-relative name, numcdtextures/cdtextureindex at 212/216 as header-relative offsets).
//
//   mdlMaterials(buf) -> { names: string[], dirs: string[] }
export function mdlMaterials(buf) {
  header(buf)
  const at = (count, index, size) => count > 0 && count < 1024 && index > 0 && index + count * size <= buf.length
  const names = []
  const dirs = []
  const nt = buf.readInt32LE(204), ti = buf.readInt32LE(208)
  if (at(nt, ti, 64)) for (let i = 0; i < nt; i++) names.push(readName(buf, ti + i * 64 + buf.readInt32LE(ti + i * 64)))
  const nc = buf.readInt32LE(212), ci = buf.readInt32LE(216)
  if (at(nc, ci, 4)) for (let i = 0; i < nc; i++) dirs.push(readName(buf, buf.readInt32LE(ci + i * 4)))
  return { names: names.filter(Boolean), dirs }
}
