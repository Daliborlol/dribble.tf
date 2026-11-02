// File helpers of the pack builder: atomic writes, hashing, directory walks and the out-dir rules
// of contract 2.1 (never inside a git work tree, never under /tmp).

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

/** `.<name>.partial` next to the target, fsynced, then renamed over it. */
export function writeFileAtomic(target, data) {
  const dir = path.dirname(target)
  fs.mkdirSync(dir, { recursive: true })
  const partial = path.join(dir, `.${path.basename(target)}.partial`)
  const fd = fs.openSync(partial, 'w')
  try {
    fs.writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(partial, target)
}

/** Moves `from` over `to` atomically: a rename on one filesystem, else copy to `.partial` + rename. */
export function moveFileAtomic(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  try {
    fs.renameSync(from, to)
  } catch (error) {
    if (error.code !== 'EXDEV') throw error
    const partial = path.join(path.dirname(to), `.${path.basename(to)}.partial`)
    fs.copyFileSync(from, partial)
    const fd = fs.openSync(partial, 'r+')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fs.renameSync(partial, to)
    fs.rmSync(from)
  }
}

export function sha256File(file) {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.allocUnsafe(1 << 20)
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null)
      if (!n) break
      hash.update(buf.subarray(0, n))
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

/** Relative paths (forward slashes) of every file under `root`, sorted; `skip(rel, isDir)` prunes. */
export function walkFiles(root, skip = () => false) {
  const out = []
  const visit = rel => {
    const abs = path.join(root, rel)
    for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (skip(childRel, entry.isDirectory())) continue
      if (entry.isDirectory()) visit(childRel)
      else if (entry.isFile()) out.push(childRel)
    }
  }
  visit('')
  return out.sort()
}

/** The nearest existing ancestor of `p` (itself when it exists), with symlinks resolved. */
export function nearestExisting(p) {
  let cur = path.resolve(p)
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return fs.realpathSync(cur)
}

/**
 * Why `out` may not hold a pack, or null. Refuses paths under /tmp (also through symlinks) and paths
 * inside a git work tree (contract 2.1).
 */
export function outDirProblem(out) {
  const abs = path.resolve(out)
  const underTmp = p => p === '/tmp' || p.startsWith('/tmp/')
  if (underTmp(abs) || underTmp(nearestExisting(abs))) return `${abs} is under /tmp (the /tmp quota is shared; use a dir on disk)`
  const probe = nearestExisting(abs)
  const git = spawnSync('git', ['-C', probe, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' })
  if (git.status === 0 && git.stdout.trim() === 'true') {
    const top = spawnSync('git', ['-C', probe, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim()
    return `${abs} is inside the git work tree ${top}; a pack lives outside every repository`
  }
  return null
}

/** The git HEAD of the checkout that holds `dir`, or null. */
export function gitCommit(dir) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}
