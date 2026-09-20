/**
 * install-from-github.mjs — install the skill from the GitHub repository itself.
 *
 * git's transport cannot reach github.com from this sandbox, so "install from the
 * repo" is done through the GitHub API: resolve the ref, read the commit's tree,
 * download the blobs (one tarball, falling back to per-blob), and verify every
 * file by recomputing git's blob id. A blob id only matches if the bytes match, so
 * a successful run proves the installed tree is the published tree.
 *
 * Usage: node install-from-github.mjs <dest-dir>   (token in GH_TOKEN)
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { dirname, join } from 'node:path'

const repo = 'mathangler/dsh-reasoning-effort'
const ref = process.env.DSH_SKILL_REF ?? 'main'
const dest = process.argv[2]
const token = process.env.GH_TOKEN
if (dest === undefined) {
  console.error('usage: install-from-github.mjs <dest-dir>')
  process.exit(2)
}
if (token === undefined || token.length === 0) {
  console.error('GH_TOKEN is not set')
  process.exit(2)
}

const headers = {
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'dsh-reasoning-effort-install',
}

async function api(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers })
  const text = await res.text()
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}: ${text.slice(0, 300)}`)
  return JSON.parse(text)
}

function gitBlobSha(buffer) {
  return createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex')
}

function parseTar(buffer) {
  const entries = new Map()
  let offset = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) break
    const str = (start, end) => header.subarray(start, end).toString('utf8').replace(/\0.*$/s, '').trim()
    const size = parseInt(str(124, 136) || '0', 8)
    const type = String.fromCharCode(header[156])
    const raw = `${str(345, 500)}${str(345, 500).length > 0 ? '/' : ''}${str(0, 100)}`
    offset += 512
    const body = buffer.subarray(offset, offset + size)
    offset += Math.ceil(size / 512) * 512
    if (type !== '0' && type !== '\0') continue
    if (raw.length > 0) entries.set(raw, body)
  }
  return entries
}

/**
 * GitHub's tarball wraps everything in `<repo>-<sha>/`. Strip that one segment,
 * derived from the entries themselves rather than guessed from the first header
 * (which is a pax global header, not a file).
 */
function stripCommonPrefix(map) {
  const keys = [...map.keys()]
  if (keys.length === 0) return map
  const firsts = new Set(keys.map((k) => k.split('/')[0]))
  if (firsts.size !== 1) return map
  const prefix = `${[...firsts][0]}/`
  if (!keys.every((k) => k.startsWith(prefix))) return map
  const out = new Map()
  for (const [key, value] of map) out.set(key.slice(prefix.length), value)
  return out
}

const refInfo = await api(`/repos/${repo}/git/ref/heads/${ref}`)
const commitSha = refInfo.object.sha
const commit = await api(`/repos/${repo}/git/commits/${commitSha}`)
const tree = await api(`/repos/${repo}/git/trees/${commit.tree.sha}?recursive=1`)
const blobsWanted = tree.tree.filter((e) => e.type === 'blob')
console.log(`repo      : ${repo}@${ref}`)
console.log(`commit    : ${commitSha}`)
console.log(`tree      : ${commit.tree.sha}`)
console.log(`blobs     : ${blobsWanted.length}`)

let files = new Map()
let via = 'none'
try {
  const res = await fetch(`https://api.github.com/repos/${repo}/tarball/${commitSha}`, {
    headers: { ...headers, accept: 'application/vnd.github+json' },
  })
  if (!res.ok) throw new Error(`tarball -> ${res.status}`)
  const gz = Buffer.from(await res.arrayBuffer())
  const tar = gunzipSync(gz)
  files = stripCommonPrefix(parseTar(tar))
  via = 'tarball'
} catch (error) {
  console.log(`tarball unavailable (${error.message}); falling back to per-blob downloads`)
  for (const entry of blobsWanted) {
    const blob = await api(`/repos/${repo}/git/blobs/${entry.sha}`)
    files.set(entry.path, Buffer.from(blob.content, 'base64'))
  }
  via = 'per-blob API'
}
console.log(`source    : ${via}`)

for (const entry of blobsWanted) {
  const content = files.get(entry.path)
  if (content === undefined) {
    console.error(`MISSING from download: ${entry.path}`)
    process.exit(1)
  }
  const got = gitBlobSha(content)
  if (got !== entry.sha) {
    console.error(`BLOB MISMATCH ${entry.path}: downloaded=${got} repo=${entry.sha}`)
    process.exit(1)
  }
}
console.log(`verified  : ${blobsWanted.length}/${blobsWanted.length} files match the published blob ids`)

rmSync(dest, { recursive: true, force: true })
for (const entry of blobsWanted) {
  const target = join(dest, entry.path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, files.get(entry.path))
}
console.log(`installed : ${dest}`)
for (const entry of blobsWanted) console.log(`  ${entry.path}`)
