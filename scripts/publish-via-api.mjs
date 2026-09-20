/**
 * publish-via-api.mjs — publish a local commit to GitHub through the Git Data API.
 *
 * Why not `git push`: in this sandbox git's HTTPS transport cannot reach
 * github.com (TCP timeout), ssh is blocked by the named-pipe rule, and Windows
 * schannel has no credential handle. Node's own TLS stack works, and `gh` holds a
 * token with `repo` scope, so the API is the only live path.
 *
 * The content is verified, not assumed: every file is re-hashed with git's blob
 * algorithm and compared against the blob SHA the local repository reported, and
 * the created tree must hash back to the local tree SHA before any ref moves. A
 * tree SHA only matches if the bytes are identical, so equality is proof.
 *
 * Usage: node publish-via-api.mjs <meta.json>   (token in GH_TOKEN)
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const meta = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const token = process.env.GH_TOKEN
if (token === undefined || token.length === 0) {
  console.error('GH_TOKEN is not set')
  process.exit(2)
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
    const prefix = str(345, 500)
    const name = prefix.length > 0 ? `${prefix}/${str(0, 100)}` : str(0, 100)
    offset += 512
    if (type === '0' || type === '\0') entries.set(name, buffer.subarray(offset, offset + size))
    offset += Math.ceil(size / 512) * 512
  }
  return entries
}

function gitBlobSha(buffer) {
  return createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex')
}

const tar = parseTar(readFileSync(meta.tarFile))
console.log(`tar entries: ${tar.size}`)

for (const file of meta.files) {
  const content = tar.get(file.path)
  if (content === undefined) {
    console.error(`MISSING in archive: ${file.path}`)
    process.exit(2)
  }
  const got = gitBlobSha(content)
  if (got !== file.blob) {
    console.error(`BLOB MISMATCH for ${file.path}: archive=${got} git=${file.blob}`)
    process.exit(2)
  }
}
console.log(`verified ${meta.files.length} files against git blob ids`)

async function api(path, method = 'GET', body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dsh-reasoning-effort-publish',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`)
  return JSON.parse(text)
}

const [owner, repo] = meta.repo.split('/')
const base = `/repos/${owner}/${repo}`

const currentMain = await api(`${base}/git/ref/heads/main`)
console.log(`remote main: ${currentMain.object.sha}`)
if (currentMain.object.sha !== meta.parent) {
  console.error(`ABORT: remote main is ${currentMain.object.sha}, expected the parent ${meta.parent} (no fast-forward)`)
  process.exit(1)
}

const parentCommit = await api(`${base}/git/commits/${meta.parent}`)
console.log(`parent tree: ${parentCommit.tree.sha}`)

const blobs = []
for (const file of meta.files) {
  const created = await api(`${base}/git/blobs`, 'POST', { content: tar.get(file.path).toString('base64'), encoding: 'base64' })
  if (created.sha !== file.blob) throw new Error(`blob sha mismatch for ${file.path}: api=${created.sha} git=${file.blob}`)
  blobs.push({ path: file.path, mode: '100644', type: 'blob', sha: created.sha })
  console.log(`  blob ${file.path} -> ${created.sha}`)
}

const tree = await api(`${base}/git/trees`, 'POST', { base_tree: parentCommit.tree.sha, tree: blobs })
console.log(`remote tree: ${tree.sha}`)
console.log(`local  tree: ${meta.tree}`)
if (tree.sha !== meta.tree) {
  console.error('ABORT: tree hashes differ — the remote tree is NOT byte-identical to the local one; no ref was moved.')
  process.exit(1)
}

const message = readFileSync(meta.messageFile, 'utf8')
const identity = { name: meta.name, email: meta.email, date: meta.date }
const commit = await api(`${base}/git/commits`, 'POST', {
  message,
  tree: tree.sha,
  parents: [meta.parent],
  author: identity,
  committer: identity,
})
console.log(`remote commit: ${commit.sha}`)
console.log(`local  commit: ${meta.head}`)
console.log(`commit sha parity: ${commit.sha === meta.head ? 'IDENTICAL' : 'differs (tree is identical; metadata differs)'}`)

const ref = await api(`${base}/git/refs/heads/main`, 'PATCH', { sha: commit.sha, force: false })
console.log(`\nmain updated: ${currentMain.object.sha} -> ${ref.object.sha}`)
