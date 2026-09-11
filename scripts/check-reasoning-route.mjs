#!/usr/bin/env node
/**
 * check-reasoning-route.mjs — inspect how a `llm-pi-ai` route resolves, offline.
 *
 * Reads:
 *   - the settings document (`$DSH_HOME/settings.yaml`, overridable with --settings)
 *   - the pi-ai catalog pinned by the dsh install (--dsh-root to override discovery)
 *   - dsh-llm-pi-ai's compat gates, to classify each compat field by protocol
 *
 * Reports, per route:
 *   - whether the route name is a pi-ai catalog provider (i.e. inherits metadata)
 *   - the effective `api` of every model: route `api` -> catalog entry `api` -> none
 *   - which models would resolve `reasoning: true` and their offered levels
 *   - for each configured `compat` field: which protocols accept it, and whether any
 *     model on the route does (the exact check strict settings writes perform)
 *
 * Strictly read-only. Exits 1 when a check fails, 0 otherwise.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

// ---------------------------------------------------------------- arguments
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  return i === -1 ? fallback : args[i + 1]
}
const has = (name) => args.includes(name)
const settingsPath = flag('--settings', join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'settings.yaml'))
const wantRoute = flag('--route', undefined)
const dshRootArg = flag('--dsh-root', undefined)

if (has('--help') || has('-h')) {
  console.log(`usage: node check-reasoning-route.mjs [--route <name>] [--settings <path>] [--dsh-root <path>]

  --route     only report this route (default: every route under llm-pi-ai.providers)
  --settings  settings document to read (default: $DSH_HOME/settings.yaml)
  --dsh-root  dsh install root holding node_modules (default: discovered)

Env: DSH_ROOT may supply the dsh root instead of --dsh-root.`)
  process.exit(0)
}

// ------------------------------------------------------------ dsh root / yaml
function dshCandidateRoots() {
  const roots = []
  if (dshRootArg) roots.push(dshRootArg)
  if (process.env.DSH_ROOT) roots.push(process.env.DSH_ROOT)
  const profileModules = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'node_modules')
  roots.push(profileModules)
  try {
    for (const line of execFileSync('where', ['dsh'], { encoding: 'utf8' }).split(/\r?\n/)) {
      const bin = line.trim()
      if (bin.length === 0) continue
      const nodeModules = join(dirname(bin), 'node_modules')
      roots.push(nodeModules, dirname(nodeModules))
    }
  } catch { /* dsh not on PATH */ }
  try {
    roots.push(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim())
  } catch { /* npm unavailable */ }
  if (process.env.APPDATA) roots.push(join(process.env.APPDATA, 'npm', 'node_modules'))
  roots.push(join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node_modules'))
  return [...new Set(roots.filter((r) => typeof r === 'string' && r.length > 0))]
}

/**
 * The two layouts an install can use: package directories stacked directly in a
 * `node_modules`, or nested under the dsh package's own `node_modules`.
 */
function buildLayouts(root) {
  return [
    {
      piAiDist: join(root, '@earendil-works', 'pi-ai', 'dist'),
      bundle: join(root, '@deepseek-ai', 'dsh-llm-pi-ai', 'lib', 'index.js'),
      label: root,
    },
    {
      piAiDist: join(root, '@deepseek-ai', 'dsh', 'node_modules', '@earendil-works', 'pi-ai', 'dist'),
      bundle: join(root, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai', 'lib', 'index.js'),
      label: join(root, '@deepseek-ai', 'dsh', 'node_modules'),
    },
  ]
}

/** Prefer a layout whose adapter bundle exists, then one whose pi-ai exists. */
function findInstall() {
  const scanned = []
  for (const root of dshCandidateRoots()) {
    for (const layout of buildLayouts(root)) {
      const hasPiAi = existsSync(layout.piAiDist)
      const hasBundle = existsSync(layout.bundle)
      if (hasPiAi && hasBundle) return layout
      scanned.push(`${layout.label} (pi-ai:${hasPiAi ? 'y' : 'n'}, bundle:${hasBundle ? 'y' : 'n'})`)
    }
  }
  return { piAiDist: undefined, bundle: undefined, scanned }
}

function requireYaml(fromDir) {
  for (const base of [fromDir, join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'node_modules')]) {
    if (base === undefined) continue
    try {
      return createRequire(join(base, 'noop.js'))('js-yaml')
    } catch { /* try next */ }
  }
  return undefined
}

const install = findInstall()
const piAiDist = install.piAiDist
const dshPiAiBundle = install.bundle
if (piAiDist === undefined) {
  console.error('could not locate the dsh install; pass --dsh-root <path containing node_modules>')
  console.error('scanned:')
  for (const line of install.scanned ?? []) console.error(`  ${line}`)
  process.exit(2)
}

const yaml = requireYaml(dirname(settingsPath)) ?? requireYaml(dshRoot)
if (yaml === undefined) {
  console.error('could not load js-yaml; pass --settings from a directory with js-yaml reachable')
  process.exit(2)
}

console.log(`settings   : ${settingsPath}`)
console.log(`dsh install: ${install.label}`)
console.log(`pi-ai dist : ${existsSync(piAiDist) ? 'found' : 'MISSING'}`)
console.log(`adapter    : ${existsSync(dshPiAiBundle) ? 'found' : 'MISSING (compat gates unavailable)'}`)

// ------------------------------------------------------------- pi-ai catalog
function catalogProviders() {
  const dir = join(piAiDist, 'providers', 'data')
  if (!existsSync(dir)) return new Map()
  const out = new Map()
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.'))) {
    let doc
    try {
      doc = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    } catch { continue }
    const models = new Map()
    for (const group of Object.values(doc)) {
      for (const model of Object.values(group)) models.set(model.id, model)
    }
    out.set(file.replace(/\.json$/, ''), models)
  }
  return out
}
const catalog = catalogProviders()

// ------------------------------------------------- compat field -> protocols
/** Protocol sets a compat field is accepted on, parsed from dsh-llm-pi-ai's gates. */
function compatProtocols() {
  const table = new Map()
  if (!existsSync(dshPiAiBundle)) return table
  const source = readFileSync(dshPiAiBundle, 'utf8')
  for (const [gate, protocols] of [
    ['COMPLETIONS_COMPAT_GATE', ['openai-completions']],
    ['RESPONSES_COMPAT_GATE', ['openai-responses', 'azure-openai-responses', 'openai-codex-responses']],
    ['ANTHROPIC_COMPAT_GATE', ['anthropic-messages']],
    ['BEDROCK_COMPAT_GATE', ['bedrock-converse-stream']],
  ]) {
    const at = source.indexOf(`const ${gate} = {`)
    if (at === -1) continue
    const end = source.indexOf('\n};', at)
    const body = source.slice(at, end === -1 ? source.length : end)
    for (const line of body.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9_]+)\s*:\s*"(offer|withhold)"/.exec(line)
      if (m === null || m[2] !== 'offer') continue
      table.set(m[1], [...(table.get(m[1]) ?? []), ...protocols])
    }
  }
  return table
}
const compatTable = compatProtocols()

// ------------------------------------------------------------- the route check
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const doc = yaml.load(readFileSync(settingsPath, 'utf8'))
const providers = doc?.['llm-pi-ai']?.providers ?? {}
const routeNames = wantRoute === undefined ? Object.keys(providers) : [wantRoute]

if (routeNames.length === 0) {
  console.log('\nno routes configured under llm-pi-ai.providers')
  process.exit(0)
}

let failures = 0
for (const name of routeNames) {
  const profile = providers[name]
  console.log(`\n${'='.repeat(72)}\nroute: ${name}`)
  if (profile === undefined) {
    console.log('  not configured')
    failures++
    continue
  }
  const catalogModels = catalog.get(name)
  const isCatalogRoute = catalogModels !== undefined
  console.log(`  catalog route        : ${isCatalogRoute ? 'yes (inherits metadata)' : 'no (every field must be hand-written)'}`)
  if (!isCatalogRoute) {
    console.log(`  known provider ids   : ${[...catalog.keys()].slice(0, 6).join(', ')}, ...`)
  }
  console.log(`  route api            : ${profile.api ?? '(absent)'}`)

  const configured = profile.models ?? []
  const overrides = profile.modelOverrides ?? {}
  if (configured.length === 0 && Object.keys(overrides).length > 0 && !isCatalogRoute) {
    console.log('  ERROR: modelOverrides needs a catalog route; list models explicitly instead')
    failures++
  }

  const entries = configured.length > 0
    ? configured.map((m) => ({ id: m.id, declared: m, override: undefined }))
    : [...(catalogModels ?? new Map()).keys()].map((id) => ({ id, declared: undefined, override: overrides[id] }))

  const resolved = []
  for (const entry of entries) {
    const base = catalogModels?.get(entry.id)
    const api = profile.api ?? base?.api
    const declared = entry.declared ?? entry.override ?? {}
    const efforts = declared.reasoningEfforts
    const inheritsReasoning = efforts === undefined ? base?.reasoning === true : false
    const reasoning = efforts === false
      ? false
      : efforts !== undefined
        ? true
        : inheritsReasoning
    const offered = efforts !== undefined && efforts !== false
      ? LEVELS.filter((level) => Object.prototype.hasOwnProperty.call(efforts, level))
      : (inheritsReasoning ? LEVELS.filter((level) => (base?.thinkingLevelMap ?? {})[level] !== null) : [])
    const problems = []
    if (efforts !== undefined && efforts !== false && !(efforts === null)) {
      for (const [level, wire] of Object.entries(efforts)) {
        if (!LEVELS.includes(level)) problems.push(`unknown level "${level}" (allowed: ${LEVELS.join(', ')})`)
        else if (level !== 'off' && (typeof wire !== 'string' || wire.length === 0)) problems.push(`level "${level}" needs a non-empty wire value`)
      }
      if (!Object.keys(efforts).some((l) => l !== 'off')) problems.push('offers no level beyond "off"; declare a thinking level or set false')
    }
    resolved.push({ id: entry.id, api, reasoning, offered, problems, source: efforts !== undefined ? 'declared' : (inheritsReasoning ? 'catalog' : 'none') })
    console.log(`  - ${entry.id}`)
    console.log(`      api          : ${api ?? 'NONE  <-- sets compat fields cannot be matched'}`)
    console.log(`      reasoning    : ${reasoning === true ? 'true' : 'false'}`)
    console.log(`      offered      : ${offered.length > 0 ? offered.join(', ') : '(none — picker will show no effort levels)'}`)
    console.log(`      levels from  : ${resolved.at(-1).source}`)
    for (const p of problems) {
      console.log(`      PROBLEM      : ${p}`)
      failures++
    }
  }

  // The exact check strict settings writes perform.
  for (const field of Object.keys(profile.compat ?? {})) {
    const takers = compatTable.get(field)
    if (takers === undefined) {
      console.log(`  compat "${field}": not in dsh-llm-pi-ai's gates (cannot be set from settings.yaml)`)
      continue
    }
    const matched = resolved.some((m) => m.api !== undefined && takers.includes(m.api))
    console.log(`  compat "${field}": protocols ${takers.join(', ')} -> ${matched ? 'matched' : 'NO MODEL ON THIS ROUTE TAKES IT  <-- strict write rejects the whole route'}`)
    if (!matched) {
      failures++
      console.log(`      fix: state the route's api (e.g. api: ${takers[0]}), or move the field onto individual models`)
    }
  }
}

console.log(`\n${'='.repeat(72)}`)
if (failures === 0) {
  console.log('OK: no structural problems found. Levels still need a live check — a listed level can')
  console.log('    still be rejected by the adapter, and only a real request proves the gateway honours it.')
} else {
  console.log(`${failures} problem(s) found.`)
}
process.exit(failures === 0 ? 0 : 1)
