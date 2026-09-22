/**
 * dsh-install.mjs — locate the DSH install, its pinned pi-ai catalog, and the
 * `dsh-llm-pi-ai` compat gates.
 *
 * Cross-platform by construction. Candidates are derived from the environment
 * and from `process.execPath` *before* any subprocess is attempted, so
 * discovery works on Windows, macOS and Linux, and inside a confined shell that
 * denies child processes (a denial degrades to "candidate not found", never a
 * crash — the previous revision of this script shelled out first and could exit
 * 2 for a sandbox reason unrelated to the user's configuration).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'

/** `$DSH_HOME`, defaulting to `~/.dsh`. */
export function dshHome() {
  return process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
}

/**
 * Every profile patch document — `$DSH_HOME/profiles/<profile>/cordis.patch.yml` — sorted by
 * path so a run is reproducible.
 *
 * DSH 0.1.7 keeps settings here, as a top-level sequence of loader entries. Each profile has
 * its own file, and only the ones carrying an `llm-pi-ai` row are interesting; the entry check
 * is a cheap text scan, so the caller can reject a file before parsing anything.
 */
export function profilePatches() {
  const dir = join(dshHome(), 'profiles')
  if (!existsSync(dir)) return []
  let names
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
  return names.map((profile) => ({ profile, path: join(dir, profile, 'cordis.patch.yml') }))
}

/** Whether a profile patch file configures the `llm-pi-ai` row (text scan, no parse). */
export function declaresPiAi(path) {
  try {
    return /^[ \t]*-[ \t]+id:[ \t]*["']?llm-pi-ai["']?[ \t]*$/m.test(readFileSync(path, 'utf8'))
  } catch {
    return false
  }
}

/**
 * The one profile patch a run should act on.
 *
 * Either an explicit `--settings <path>`, or the single profile patch that configures
 * `llm-pi-ai`. More than one is *not* picked for the user: which profile they mean is their call,
 * and each document gets its own backup, validation and report. Both scripts resolve their target
 * through here, so they can never disagree about which file is being talked about.
 */
export function resolveTarget(explicitPath) {
  if (explicitPath !== undefined) {
    const path = resolve(explicitPath)
    if (!existsSync(path)) return { error: `document not found: ${path}` }
    if (!declaresPiAi(path)) {
      return {
        error: `${path} has no "- id: llm-pi-ai" row, so it configures no providers.`,
        hint: 'This skill edits a DSH profile patch: $DSH_HOME/profiles/<profile>/cordis.patch.yml',
      }
    }
    return { target: { path, profile: undefined } }
  }
  const all = profilePatches()
  const found = all.filter((p) => existsSync(p.path) && declaresPiAi(p.path))
  if (found.length === 0) {
    return {
      error: `no profile patch under ${join(dshHome(), 'profiles')} configures llm-pi-ai`,
      candidates: all.map((p) => p.path),
      hint: 'Add the provider in the DSH GUI first (that creates the row), or pass --settings <path>.',
    }
  }
  if (found.length > 1) {
    return {
      error: `${found.length} profile patches configure llm-pi-ai; name the one to use with --settings`,
      candidates: found.map((p) => p.path),
    }
  }
  return { target: found[0] }
}

/** Global `node_modules` directories implied by the running Node binary. */
function execPathRoots() {
  const bin = dirname(process.execPath)
  const roots = [
    join(bin, 'node_modules'), // win: <prefix>\node_modules ; nvm layout
    join(bin, '..', 'node_modules'),
    join(bin, '..', 'lib', 'node_modules'), // posix: /usr/local/bin -> /usr/local/lib/node_modules
  ]
  if (process.env.NVM_BIN) roots.push(join(dirname(process.env.NVM_BIN), 'node_modules'))
  return roots.map((r) => resolve(r))
}

/**
 * Every plausible `node_modules` root that could hold `@deepseek-ai/*`, best
 * first. `--dsh-root` and `DSH_ROOT` win; the DSH profile layout is next, which
 * is the normal case for a managed install.
 */
export function candidateRoots(dshRootArg) {
  const roots = []
  if (dshRootArg !== undefined) roots.push(dshRootArg)
  if (process.env.DSH_ROOT) roots.push(process.env.DSH_ROOT)
  roots.push(join(dshHome(), 'profiles', 'node_modules'))
  roots.push(...execPathRoots())
  if (process.env.APPDATA) roots.push(join(process.env.APPDATA, 'npm', 'node_modules'))
  if (process.env.ProgramFiles) roots.push(join(process.env.ProgramFiles, 'nodejs', 'node_modules'))
  roots.push('/usr/local/lib/node_modules', '/usr/lib/node_modules', '/opt/homebrew/lib/node_modules')
  return [...new Set(roots.filter((r) => typeof r === 'string' && r.length > 0).map((r) => resolve(r)))]
}

/**
 * `where`/`which`, used only as a last resort. Skipped entirely when
 * `DSH_NO_SUBPROCESS=1`, and any failure (ENOENT on the other platform, EPERM
 * under a sandbox) is swallowed.
 */
export function pathRoots() {
  if (process.env.DSH_NO_SUBPROCESS === '1') return []
  const roots = []
  for (const probe of process.platform === 'win32' ? ['where'] : ['which']) {
    try {
      const out = spawnSync(probe, ['dsh'], { encoding: 'utf8', shell: process.platform === 'win32' })
      if (out.status !== 0 || typeof out.stdout !== 'string') continue
      for (const line of out.stdout.split(/\r?\n/)) {
        const bin = line.trim()
        if (bin.length === 0) continue
        const dir = dirname(bin)
        roots.push(join(dir, 'node_modules'), dirname(join(dir, 'node_modules')))
      }
    } catch {
      /* no subprocesses available — env-derived roots still apply */
    }
  }
  return roots
}

/** The two layouts an install can use: packages stacked in `node_modules`, or nested under the dsh package. */
function layoutsFor(root) {
  return [
    {
      root,
      piAiDist: join(root, '@earendil-works', 'pi-ai', 'dist'),
      bundle: join(root, '@deepseek-ai', 'dsh-llm-pi-ai', 'lib', 'index.js'),
      dshPackageJson: join(root, '@deepseek-ai', 'dsh', 'package.json'),
      label: root,
    },
    {
      root,
      piAiDist: join(root, '@deepseek-ai', 'dsh', 'node_modules', '@earendil-works', 'pi-ai', 'dist'),
      bundle: join(root, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai', 'lib', 'index.js'),
      dshPackageJson: join(root, '@deepseek-ai', 'dsh', 'package.json'),
      label: join(root, '@deepseek-ai', 'dsh', 'node_modules'),
    },
  ]
}

/**
 * Find the install. A candidate qualifies when the pi-ai catalog is present;
 * the adapter bundle is reported separately because some checks need it and
 * others do not.
 */
export function findInstall(dshRootArg) {
  const scanned = []
  const roots = [...candidateRoots(dshRootArg), ...pathRoots()]
  for (const root of roots) {
    for (const layout of layoutsFor(root)) {
      const hasPiAi = existsSync(layout.piAiDist)
      const hasBundle = existsSync(layout.bundle)
      if (hasPiAi) return { ...layout, hasBundle, scanned }
      scanned.push(`${layout.label} (pi-ai: no, bundle: ${hasBundle ? 'yes' : 'no'})`)
    }
  }
  return { piAiDist: undefined, bundle: undefined, label: undefined, hasBundle: false, scanned }
}

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** `js-yaml` shipped with DSH — no install step, same parser DSH itself uses. */
export function loadYaml(fromDirs) {
  const bases = [
    ...fromDirs,
    join(dshHome(), 'profiles', 'node_modules'),
    join(process.cwd(), 'node_modules'),
    // The same roots the install search uses, so a relocated or globally installed DSH resolves
    // the parser too instead of failing with "js-yaml is unreachable".
    ...candidateRoots(undefined),
  ].filter((d) => typeof d === 'string' && d.length > 0)
  for (const base of bases) {
    try {
      return createRequire(join(base, 'noop.js'))('js-yaml')
    } catch {
      /* try the next base */
    }
  }
  return undefined
}

export function dshVersion(install) {
  const pkg = install?.dshPackageJson === undefined ? undefined : readJson(install.dshPackageJson)
  return pkg?.version
}

/** Lowercase, drop a trailing slash, and treat `.../v1` as the same endpoint as `...`. */
export function normalizeBaseUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return undefined
  let out = url.trim().toLowerCase().replace(/\/+$/, '')
  out = out.replace(/\/v1$/, '')
  return out
}

/**
 * The pi-ai catalog, indexed for our two questions: "what does this model id
 * declare?" and "which catalog provider serves this base URL?".
 */
export function loadCatalog(piAiDist) {
  const providers = new Map()
  const dir = piAiDist === undefined ? undefined : join(piAiDist, 'providers', 'data')
  if (dir === undefined || !existsSync(dir)) return { providers, byBaseUrl: new Map(), available: false }
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.')).sort()) {
    const doc = readJson(join(dir, file))
    if (doc === undefined || typeof doc !== 'object' || doc === null) continue
    const providerId = file.replace(/\.json$/, '')
    const models = new Map()
    const baseUrls = new Set()
    for (const group of Object.values(doc)) {
      if (typeof group !== 'object' || group === null) continue
      for (const model of Object.values(group)) {
        if (typeof model !== 'object' || model === null || typeof model.id !== 'string') continue
        models.set(model.id, model)
        const base = normalizeBaseUrl(model.baseUrl)
        if (base !== undefined) baseUrls.add(base)
      }
    }
    providers.set(providerId, { id: providerId, models, baseUrls })
  }
  const byBaseUrl = new Map()
  for (const provider of providers.values()) {
    for (const base of provider.baseUrls) {
      byBaseUrl.set(base, [...(byBaseUrl.get(base) ?? []), provider.id])
    }
  }
  return { providers, byBaseUrl, available: providers.size > 0 }
}

const GATE_PROTOCOLS = [
  ['COMPLETIONS_COMPAT_GATE', ['openai-completions']],
  ['RESPONSES_COMPAT_GATE', ['openai-responses', 'azure-openai-responses', 'openai-codex-responses']],
  ['ANTHROPIC_COMPAT_GATE', ['anthropic-messages']],
  ['BEDROCK_COMPAT_GATE', ['bedrock-converse-stream']],
]

/**
 * Walk a JS object literal, respecting string literals so that a `}` inside a
 * string cannot close it early.
 */
function braceBody(source, openIndex) {
  let depth = 0
  let quote
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i]
    if (quote !== undefined) {
      if (ch === '\\') i++
      else if (ch === quote) quote = undefined
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i)
      i = nl === -1 ? source.length : nl
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return source.slice(openIndex + 1, i)
    }
  }
  return undefined
}

/**
 * The compat gates, read out of the adapter bundle.
 *
 * `available: false` means the gates could not be read (a minified or renamed
 * bundle). Callers MUST then report "cannot be checked" instead of concluding
 * that a field is unsettable: the previous revision scraped with a single
 * brittle regex and quietly produced an empty table, which turned "unknown"
 * into a confident, wrong answer.
 */
export function loadCompatGates(install) {
  const offers = new Map()
  const withholds = new Map()
  if (install?.bundle === undefined || !existsSync(install.bundle)) {
    return { available: false, offers, withholds, reason: 'dsh-llm-pi-ai bundle not found' }
  }
  let source
  try {
    source = readFileSync(install.bundle, 'utf8')
  } catch (error) {
    return { available: false, offers, withholds, reason: `bundle unreadable: ${error.message}` }
  }
  let found = 0
  for (const [gate, protocols] of GATE_PROTOCOLS) {
    const at = new RegExp(`\\b${gate}\\b\\s*=\\s*\\{`).exec(source)
    if (at === null) continue
    const body = braceBody(source, source.indexOf('{', at.index))
    if (body === undefined) continue
    let fields = 0
    for (const m of body.matchAll(/([A-Za-z0-9_$]+)\s*:\s*"(offer|withhold)"/g)) {
      const [, field, kind] = m
      fields++
      const table = kind === 'offer' ? offers : withholds
      table.set(field, [...new Set([...(table.get(field) ?? []), ...protocols])])
    }
    if (fields >= 5) found++
  }
  if (found === 0) {
    return {
      available: false,
      offers,
      withholds,
      reason: 'no COMPAT_GATE literal found in the adapter bundle (minified or renamed)',
    }
  }
  return { available: true, offers, withholds, reason: undefined, gatesFound: found }
}
