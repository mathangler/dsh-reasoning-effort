#!/usr/bin/env node
/**
 * apply-reasoning-efforts.mjs — give every model on a hand-declared `llm-pi-ai` route the
 * reasoning-effort levels it actually has.
 *
 * The document it edits is a DSH **profile patch**,
 * `$DSH_HOME/profiles/<profile>/cordis.patch.yml`: a top-level sequence of loader entries, one
 * of which is `- id: llm-pi-ai` and carries `config.providers.<route>`. That file replaced
 * `settings.yaml`, which DSH 0.1.7 imports once on boot and then renames — so the old file is
 * no longer read by DSH and this skill does not write it.
 *
 * Built-in providers are never written. A route whose key is a pi-ai catalog provider id
 * inherits its capabilities from the catalog and is reported read-only; only routes the catalog
 * does not know (`declared: true` in DSH's own terms) are edited, because those are the ones
 * whose models silently have no levels at all.
 *
 * The default is a dry run: nothing is written unless `--apply` is passed, and every write is
 * preceded by a backup and followed by a full re-parse plus a path-level diff against what was
 * intended.
 *
 * Exit codes: 0 nothing to do, 1 changes pending or problems found, 2 the environment could not
 * be read (install, js-yaml, or the profile patch), or an unexpected failure.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  createRoute,
  entryConfigOf,
  joinText,
  listRoutes,
  locateRoute,
  moveModelItem,
  providersOf,
  removePatchConfigScalar,
  removeRouteScalar,
  splitText,
  upsertReasoningEfforts,
} from './lib/yaml-edit.mjs'
import {
  THINKING_LEVELS,
  deriveFromCatalog,
  deriveFromOverride,
  findOverride,
  loadOverrides,
  matchCatalogProvider,
  siblingCandidates,
  toEffortsMap,
} from './lib/capability.mjs'
import {
  dshVersion,
  findInstall,
  loadCatalog,
  loadCompatGates,
  loadYaml,
  normalizeBaseUrl,
  resolveTarget,
} from './lib/dsh-install.mjs'

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ------------------------------------------------------------------ arguments
// Strict on purpose. An unknown or misspelled flag used to be ignored, so `--appply`
// produced a complete, plausible report while changing nothing — the worst failure mode
// for a tool an agent drives, because the agent has no way to notice. Every valid flag is
// listed here, and anything else exits 2 before a single file is read.
const CONTRACT = 1
const VALUE_FLAGS = new Set(['--settings', '--dsh-root', '--route', '--decide', '--evidence', '--source', '--report', '--restore'])
const BOOLEAN_FLAGS = new Set(['--apply', '--fix', '--strict', '--probe', '--fix-routes', '--json', '--timestamped-backup', '--self-test', '--help', '-h'])

const argv = []
for (const token of process.argv.slice(2)) {
  const inline = /^(--[a-z-]+)=(.*)$/.exec(token)
  if (inline === null) argv.push(token)
  else argv.push(inline[1], inline[2])
}
const unknown = []
for (let i = 0; i < argv.length; i++) {
  const token = argv[i]
  if (!token.startsWith('-')) {
    if (i === 0 || !VALUE_FLAGS.has(argv[i - 1])) unknown.push(token)
    continue
  }
  if (BOOLEAN_FLAGS.has(token)) continue
  if (VALUE_FLAGS.has(token)) {
    if (argv[i + 1] === undefined) unknown.push(`${token} (missing value)`)
    continue
  }
  unknown.push(token)
}
if (unknown.length > 0) {
  console.error(`unknown or malformed argument(s): ${unknown.join(', ')}`)
  console.error(`allowed: ${[...BOOLEAN_FLAGS, ...VALUE_FLAGS].join(' ')}`)
  console.error('nothing was read and nothing was written; run --help for usage')
  process.exit(2)
}
const flagValue = (name, fallback) => {
  const i = argv.indexOf(name)
  return i === -1 ? fallback : argv[i + 1]
}
const flagAll = (name) => argv.flatMap((a, i) => (a === name && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? [argv[i + 1]] : []))
const has = (name) => argv.includes(name)

/**
 * An unexpected failure must not leave the caller reading exit `1`.
 *
 * `1` means "work is pending" — a state an agent reacts to by running the suggested command. A
 * crash reported as `1` therefore gets treated as normal progress. `2` means "the invocation or
 * the environment is unusable", which is what a crash is, and it makes the caller stop and look.
 */
process.on('uncaughtException', (error) => {
  console.error(`❌ unexpected failure: ${error?.stack ?? error}`)
  console.error('Nothing beyond the last completed step was changed; the backup file holds the state from before this run.')
  process.exit(2)
})

/**
 * The profile patch this run applies to, or exit 2 with the reason and the places that were looked
 * at (see `resolveTarget` in lib/dsh-install.mjs — the checker resolves it the same way).
 */
function discoverTargets() {
  const resolved = resolveTarget(flagValue('--settings', undefined))
  if (resolved.error !== undefined) {
    console.error(resolved.error)
    for (const path of resolved.candidates ?? []) console.error(`  ${path}`)
    if (resolved.hint !== undefined) console.error(resolved.hint)
    process.exit(2)
  }
  return [resolved.target]
}

if (has('--help') || has('-h')) {
  console.log(`usage: node apply-reasoning-efforts.mjs [options]

  --settings <path>   process one profile patch (repeatable; default: every profile patch
                      under $DSH_HOME/profiles that configures llm-pi-ai)
  --dsh-root <path>   dsh install root holding node_modules (default: discovered)
  --route <name>      limit to these routes (repeatable; default: every custom route)
  --apply             write the document (default: dry run, prints the plan)
  --fix               also replace declarations that disagree with the evidence
  --strict            write only models whose evidence is a live probe (implies --probe)
  --probe             allow ONE minimal live request per model, to record evidence
  --fix-routes        move models whose catalog protocol differs from their route's api
  --restore <ref>     restore "latest" backup, or a named backup file, then exit
  --timestamped-backup
                      name each backup with a timestamp instead of overwriting the
                      single <document>.bak-reasoning-efforts
  --decide <spec>     record an answer: <route>/<model>=<levels|false|skip>
  --evidence <kind>   with --decide: "user" (default) or "vendor" (requires --source)
  --source <url>      the citation for an --evidence vendor fact
  --self-test         run the shipped fixtures, assert the contract, then exit
  --report <path>     also write the markdown report to this file
  --json              machine-readable output, including verdict and nextAction

  A route-level \`reasoning:\` is never written, and removed whenever it is present: DSH
  applies it to every model on the route, so one model that lacks that level makes the
  whole route fail (see REFERENCE.md, "the route default").

Exit codes: 0 every custom route is covered · 1 something is pending or broken ·
            2 the environment or the invocation is unusable
Contract:   ${CONTRACT} (SKILL.md states the contract it expects)`)
  process.exit(0)
}

// ------------------------------------------------------------------ self-test
// The gate the agent runs before touching a real document: it drives the writer against
// both shipped fixtures in a temp directory and asserts the contract. Exit 0 means this
// build behaves the way SKILL.md says on this machine — the same assertions on Windows,
// macOS and Linux, so a platform-specific breakage surfaces before the user's settings do.
if (has('--self-test')) {
  const installArg = flagValue('--dsh-root', undefined)
  const yaml = loadYaml([SKILL_DIR, findInstall(installArg).root])
  if (yaml === undefined) {
    console.error('self-test: js-yaml is unreachable (it ships with DSH), so nothing can be checked')
    process.exit(2)
  }
  const writer = fileURLToPath(import.meta.url)
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-reasoning-selftest-'))
  const results = []
  const check = (name, ok, detail) => results.push({ name, ok: ok === true, detail })
  const modelOf = (doc, routeId, modelId) => (providersOf(doc)?.[routeId]?.models ?? []).find((m) => m?.id === modelId)
  const levelsOf = (doc, routeId, modelId) => {
    const declared = modelOf(doc, routeId, modelId)?.reasoningEfforts
    if (declared === undefined) return undefined
    if (declared === false) return false
    return Object.keys(declared).join(',')
  }
  const runFixture = (fixture) => {
    const target = join(tmp, fixture)
    copyFileSync(join(SKILL_DIR, 'scripts', fixture), target)
    const before = yaml.load(readFileSync(target, 'utf8'))
    const status = spawnSync(process.execPath, [writer, '--settings', target, '--apply'], { stdio: 'ignore' }).status
    return { before, after: yaml.load(readFileSync(target, 'utf8')), status }
  }
  const routeDefaultsOf = (doc, routeId) => providersOf(doc)?.[routeId]?.reasoning
  const relatedSurvive = (doc) => entryConfigOf(doc, 'locale')?.preference === 'zh'

  // Fixture A: a catalog model, a model only other gateways attest to, and a model that does
  // not reason. Nothing sources union-alpha, so it must stay unwritten, no route default may be
  // written, and the run must say so with a non-zero exit.
  const a = runFixture('fixture-settings.yaml')
  check('A: a catalog model gets the levels the catalog declares', levelsOf(a.after, 'fixture-gateway', 'glm-5.3') === 'low,high,max', levelsOf(a.after, 'fixture-gateway', 'glm-5.3'))
  check('A: a model with no evidence is left unwritten', levelsOf(a.after, 'fixture-gateway', 'union-alpha') === undefined, String(levelsOf(a.after, 'fixture-gateway', 'union-alpha')))
  check('A: a non-reasoning model is declared explicitly false', levelsOf(a.after, 'fixture-bedrock', 'mistral.ministral-3-14b-instruct') === false, String(levelsOf(a.after, 'fixture-bedrock', 'mistral.ministral-3-14b-instruct')))
  check('A: no route default is ever written', routeDefaultsOf(a.after, 'fixture-gateway') === undefined, String(routeDefaultsOf(a.after, 'fixture-gateway')))
  check('A: unrelated rows survive', relatedSurvive(a.after))
  check('A: exits 1 while a decision is pending', a.status === 1, `exit ${a.status}`)

  // Fixture B: the built-in boundary. A catalog route, a catalog route carrying a model the
  // catalog does not know, and the native llm-deepseek row must come back untouched; the custom
  // route is the only place allowed to change.
  const b = runFixture('fixture-builtin-settings.yaml')
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y)
  check('B: the catalog route is untouched', same(providersOf(b.after)?.deepseek, providersOf(b.before)?.deepseek))
  check('B: a catalog route carrying an unknown model is untouched', same(providersOf(b.after)?.['opencode-go'], providersOf(b.before)?.['opencode-go']))
  check('B: the llm-deepseek row is untouched', same(entryConfigOf(b.after, 'llm-deepseek'), entryConfigOf(b.before, 'llm-deepseek')))
  check('B: the custom route is covered', levelsOf(b.after, 'my-gateway', 'glm-5.3') === 'low,high,max', levelsOf(b.after, 'my-gateway', 'glm-5.3'))
  check('B: the global default is not written (one value cannot be checked against every model)', entryConfigOf(b.after, 'agent-default-model')?.reasoningEffort === undefined, String(entryConfigOf(b.after, 'agent-default-model')?.reasoningEffort))
  check('B: exits 1 while a decision is pending', b.status === 1, `exit ${b.status}`)

  // Fixture C: the regression that mattered in practice. A route default of `high` on a route that
  // also carries a model offering no levels at all. The value has to come out, because DSH applies
  // it to every model on the route and that model would fail with UNSUPPORTED_REASONING_EFFORT —
  // and the old check order ("does the value already match?") never looked.
  const c = runFixture('fixture-breaking-default.yaml')
  check('C: the route default that breaks a model is removed', routeDefaultsOf(c.after, 'mixed-route') === undefined, String(routeDefaultsOf(c.after, 'mixed-route')))
  check('C: a global default unsafe for the default model is removed', entryConfigOf(c.after, 'agent-default-model')?.reasoningEffort === undefined, String(entryConfigOf(c.after, 'agent-default-model')?.reasoningEffort))
  check('C: the model with real levels is still covered', levelsOf(c.after, 'mixed-route', 'glm-5.3') === 'low,high,max', levelsOf(c.after, 'mixed-route', 'glm-5.3'))
  check('C: the model with no levels is left unwritten', levelsOf(c.after, 'mixed-route', 'fixture-unknown-model') === undefined, String(levelsOf(c.after, 'mixed-route', 'fixture-unknown-model')))
  check('C: unrelated rows survive', relatedSurvive(c.after))
  check('C: exits 1 while a decision is pending', c.status === 1, `exit ${c.status}`)

  // Fixture D: the same field, but safe for every model on the route. It still has to be removed —
  // "safe" only describes today's model list, and the next model added turns the line into the
  // failure fixture C reproduces. The global `agent-default-model.reasoningEffort` is the opposite
  // case: it is the picker's own field holding the user's choice, and the model it names really
  // offers `high`, so it stays. With every model covered, this is also the fixture that must reach
  // exit 0 — the only one where "nothing pending" is the correct answer.
  const d = runFixture('fixture-pinned-default.yaml')
  check('D: a route default that no model objects to is removed as well', routeDefaultsOf(d.after, 'pinned-route') === undefined, String(routeDefaultsOf(d.after, 'pinned-route')))
  check('D: every model keeps the levels the catalog declares', levelsOf(d.after, 'pinned-route', 'glm-5.3') === 'low,high,max' && levelsOf(d.after, 'pinned-route', 'glm-5.3-flash') === 'low,high,max', `${levelsOf(d.after, 'pinned-route', 'glm-5.3')} / ${levelsOf(d.after, 'pinned-route', 'glm-5.3-flash')}`)
  check('D: a global default the default model supports is left alone', entryConfigOf(d.after, 'agent-default-model')?.reasoningEffort === 'high', String(entryConfigOf(d.after, 'agent-default-model')?.reasoningEffort))
  check('D: unrelated rows survive', relatedSurvive(d.after))
  check('D: exits 0 — every model declared and no route default left', d.status === 0, `exit ${d.status}`)

  const failed = results.filter((r) => !r.ok)
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok || r.detail === undefined ? '' : `  (got ${r.detail})`}`)
  console.log(`\nself-test ${results.length - failed.length}/${results.length} · contract ${CONTRACT}${failed.length === 0 ? ' · this build behaves as documented here' : ' · STOP: this build does not behave as documented'}`)
  rmSync(tmp, { recursive: true, force: true })
  process.exit(failed.length === 0 ? 0 : 1)
}

// --------------------------------------------------------------- the target(s)
const targets = discoverTargets()
const settingsPath = targets[0].path
const profileLabel = targets[0].profile
// A single backup file, overwritten on every write, holding the state from *before* the
// last operation — an apply or a restore. That makes it a one-step undo rather than an
// archive, which is what the document needs: it is regenerated from the configuration on
// every run, so a pile of timestamped copies only accumulates noise. Pass
// `--timestamped-backup` to get the timestamped names back.
const backupFile = `${settingsPath}.bak-reasoning-efforts`
const nextBackupFile = () => (has('--timestamped-backup') ? `${backupFile}-${stampName()}` : backupFile)
const restoreRef = flagValue('--restore', undefined)
if (restoreRef !== undefined) {
  const dirName = dirname(settingsPath)
  let source
  if (restoreRef === 'latest') {
    const backups = readdirSync(dirName)
      .filter((f) => f.startsWith(`${basename(settingsPath)}.bak`))
      .map((f) => ({ f, mtime: statSync(join(dirName, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    source = backups[0] === undefined ? undefined : join(dirName, backups[0].f)
  } else {
    source = resolve(restoreRef)
  }
  if (source === undefined || !existsSync(source)) {
    console.error(`no backup to restore (looked for ${basename(settingsPath)}.bak* in ${dirName})`)
    process.exit(2)
  }
  // Read before writing: with a single backup file the guard and the source are the same
  // path, which is intentional — afterwards the file holds whatever settings held, so a
  // second restore toggles back.
  const bytes = readFileSync(source)
  const guard = nextBackupFile()
  try {
    copyFileSync(settingsPath, guard)
    writeFileSync(settingsPath, bytes)
  } catch (error) {
    console.error(`❌ could not restore ${settingsPath}: ${error.message}`)
    process.exit(2)
  }
  console.log(`restored : ${source}`)
  console.log(`backup   : ${guard} now holds the state this restore replaced`)
  console.log('A running dsh process may need a fresh start to pick this up.')
  process.exit(0)
}

const dshRootArg = flagValue('--dsh-root', undefined)
const onlyRoutes = new Set(flagAll('--route'))
const doApply = has('--apply')
const doFix = has('--fix')
const doStrict = has('--strict')
const doProbe = has('--probe') || doStrict
const doFixRoutes = has('--fix-routes')
const asJson = has('--json')
const reportPath = flagValue('--report', undefined)

// ---------------------------------------------------------------- --decide
// Records the answer to the one question this tool will not answer for you: what
// a model offers when neither the installed catalog nor a cited vendor page says.
// It is a recorder, not a guesser — the value has to come from the user.
const decideSpecs = flagAll('--decide')
if (decideSpecs.length > 0) {
  const evidenceKind = flagValue('--evidence', 'user')
  const sourceUrl = flagValue('--source', undefined)
  if (evidenceKind !== 'user' && evidenceKind !== 'vendor') {
    console.error(`--evidence must be "user" or "vendor", got: ${evidenceKind}`)
    process.exit(2)
  }
  if (evidenceKind === 'vendor' && (sourceUrl === undefined || sourceUrl.length === 0)) {
    console.error('--evidence vendor requires --source <url>: a vendor fact without a citation does not belong in the layer')
    process.exit(2)
  }
  // A searched fact belongs in the cited layer; an answer to a question belongs in
  // the decisions layer. Keeping them apart is what makes the evidence auditable.
  const layerName = evidenceKind === 'vendor' ? 'reasoning-overrides.yaml' : 'user-decisions.yaml'
  const layerPath = join(SKILL_DIR, 'data', layerName)
  const yamlForDecisions = loadYaml([SKILL_DIR])
  if (yamlForDecisions === undefined || typeof yamlForDecisions.dump !== 'function') {
    console.error('could not load js-yaml to record a decision')
    process.exit(2)
  }
  const existing = existsSync(layerPath) ? yamlForDecisions.load(readFileSync(layerPath, 'utf8')) : undefined
  const entries = Array.isArray(existing?.entries) ? existing.entries.filter((e) => typeof e === 'object' && e !== null) : []
  const recorded = []
  for (const spec of decideSpecs) {
    const eq = spec.indexOf('=')
    const slash = spec.indexOf('/')
    if (eq === -1 || slash === -1 || slash >= eq) {
      console.error(`--decide expects <route>/<model>=<levels|false|skip>, got: ${spec}`)
      process.exit(2)
    }
    const routeId = spec.slice(0, slash)
    const modelId = spec.slice(slash + 1, eq)
    const value = spec.slice(eq + 1).trim()
    const entry = {
      match: { provider: routeId, model: modelId },
      decidedAt: new Date().toISOString().slice(0, 10),
      evidence: evidenceKind,
    }
    if (sourceUrl !== undefined) entry.source = sourceUrl
    if (value === 'skip') {
      entry.decision = 'skip'
      entry.note = `${evidenceKind} decision: leave undeclared`
    } else if (value === 'false' || value === 'no' || value === 'none') {
      entry.reasoning = false
      entry.note = `${evidenceKind} decision: non-reasoning model`
    } else {
      const efforts = {}
      for (const token of value.split(',').map((t) => t.trim()).filter((t) => t.length > 0)) {
        const [level, wire] = token.split('=').map((t) => t.trim())
        if (!THINKING_LEVELS.includes(level)) {
          console.error(`"${level}" is not a pi-ai level (allowed: ${THINKING_LEVELS.join(', ')})`)
          process.exit(2)
        }
        efforts[level] = level === 'off' && (wire === undefined || wire === 'null') ? null : (wire ?? level)
      }
      if (!Object.keys(efforts).some((l) => l !== 'off')) {
        console.error(`--decide "${spec}" offers no level beyond "off"`)
        process.exit(2)
      }
      entry.reasoning = true
      entry.efforts = efforts
      entry.note = `${evidenceKind} decision`
    }
    const at = entries.findIndex((e) => e?.match?.provider === routeId && e?.match?.model === modelId)
    if (at === -1) entries.push(entry)
    else entries[at] = { ...entries[at], ...entry }
    recorded.push(`${routeId}/${modelId} = ${value}  [${evidenceKind}${sourceUrl === undefined ? '' : ` via ${sourceUrl}`}]`)
  }
  // Keep whatever documentation the layer already carries: only the data part is
  // regenerated, so the explanation at the top of the file survives.
  let header = `# Recorded by \`apply-reasoning-efforts.mjs --decide --evidence ${evidenceKind}\`; see SKILL.md.\n`
  if (existsSync(layerPath)) {
    const prior = readFileSync(layerPath, 'utf8')
    const at = prior.search(/^version:/m)
    if (at > 0) header = prior.slice(0, at)
  }
  mkdirSync(dirname(layerPath), { recursive: true })
  writeFileSync(layerPath, header + yamlForDecisions.dump({ version: 1, entries }, { lineWidth: 200, noRefs: true }), 'utf8')
  console.log(`recorded ${recorded.length} ${evidenceKind} fact(s) in ${layerPath}:`)
  for (const line of recorded) console.log(`  - ${line}`)
  console.log('')
}

// A gateway does not necessarily follow the protocols its catalog entry declares
// — measured on this machine, an `openai-responses` route served a model the
// catalog (and the gateway's own published endpoint table) puts on
// `openai-completions`, 64 turns running, with no errors. So migrating a route
// is an explicit, per-route decision and never a sweep: a global `--fix-routes`
// could "fix" a route that is working today and break it.
if (doFixRoutes && onlyRoutes.size === 0) {
  console.error('--fix-routes requires an explicit --route <name>.')
  console.error('The catalog\'s per-model `api` is a default, not a constraint: a gateway may serve a model')
  console.error('on a path the catalog does not name for it. Migrating is therefore a per-route decision,')
  console.error('and it carries the risk of breaking a route that works today.')
  process.exit(2)
}

function stampName() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

// ------------------------------------------------------------------- discovery
if (!existsSync(settingsPath)) {
  console.error(`profile patch not found: ${settingsPath}`)
  process.exit(2)
}
const original = readFileSync(settingsPath, 'utf8')
const install = findInstall(dshRootArg)
// The parser is the one DSH itself ships, resolved from the install that was just discovered —
// not from `$DSH_HOME` alone, so a relocated or globally installed DSH still resolves it.
const yaml = loadYaml([dirname(settingsPath), SKILL_DIR, install.root])
if (yaml === undefined) {
  console.error('could not load js-yaml (it ships with DSH; pass --settings from a directory that can reach it)')
  process.exit(2)
}
if (install.piAiDist === undefined) {
  console.error('could not locate the dsh install; pass --dsh-root <path containing node_modules>')
  for (const line of install.scanned) console.error(`  tried ${line}`)
  process.exit(2)
}
let doc
try {
  doc = yaml.load(original)
} catch (error) {
  console.error(`the profile patch does not parse: ${error.message}`)
  process.exit(2)
}

const catalog = loadCatalog(install.piAiDist)
const gates = loadCompatGates(install)
const overrides = loadOverrides(yaml, SKILL_DIR)
const version = dshVersion(install)
const catalogProviderIds = new Set(catalog.providers.keys())

// ---------------------------------------------------------------- the analysis
const parts = splitText(original)
const routes = listRoutes(parts.lines).filter((r) => onlyRoutes.size === 0 || onlyRoutes.has(r.id))

/** Read the *configured* reasoningEfforts map straight out of the parsed document. */
function configuredEfforts(routeId, modelId) {
  const model = providersOf(doc)?.[routeId]?.models?.find?.((m) => m?.id === modelId)
  if (model === undefined) return undefined
  return { has: Object.prototype.hasOwnProperty.call(model, 'reasoningEfforts'), value: model.reasoningEfforts }
}

function sameEfforts(a, b) {
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => (a[k] ?? null) === (b[k] ?? null))
}

const plan = []
const readOnly = []
const warnings = []

for (const route of routes) {
  const isCustom = !catalogProviderIds.has(route.id)
  const profile = { baseURL: route.baseURL, api: route.api, apiKeyEnv: route.apiKeyEnv, displayName: route.displayName }

  if (!isCustom) {
    // A catalog route is a *built-in* provider, even when the settings file
    // overrides it. Report what it inherits and write nothing. The one case worth
    // flagging is a model added by hand to a catalog route that the catalog does not
    // know: it has no reasoning metadata at all, and this skill will still not write
    // for it, because "do not touch built-in providers" outranks "cover every model".
    const models = route.modelIds.map((id) => {
      const entry = catalog.providers.get(route.id)?.models.get(id)
      const derived = deriveFromCatalog(entry)
      return { id, api: entry?.api ?? route.api, levels: derived.levels.map((l) => l.level), reasoning: derived.reasoning, inCatalog: entry !== undefined }
    })
    readOnly.push({ route: route.id, api: route.api, baseURL: route.baseURL, models })
    for (const model of models) {
      if (!model.inCatalog) {
        warnings.push(
          `\`${route.id}\` 是目录内置路由（只读），但其中的模型 \`${model.id}\` 不在目录里、因而没有任何思考档位；按"不动内置提供方"的规则本技能不写它。要给它档位，需要把它放到一条自定义路由上。`,
        )
      } else if (model.reasoning !== true) {
        warnings.push(`\`${route.id}\`（内置）中的 \`${model.id}\` 目录标记为不支持思考，属正常状态，只读呈现。`)
      }
    }
    continue
  }

  const match = matchCatalogProvider(catalog, profile, route.modelIds)
  if (match === undefined) {
    warnings.push(`route "${route.id}": 无法在 pi-ai 目录里按 baseURL 定位同源 provider，路径上的模型只能靠人工覆盖表`)
  } else if (match.confidence === 'model-ids') {
    warnings.push(`route "${route.id}": 目录按 baseURL 没匹配上，改按"模型 id 全部命中"判定为 "${match.providerId}"（弱匹配）`)
  }
  const catalogProvider = match === undefined ? undefined : catalog.providers.get(match.providerId)

  for (const modelId of route.modelIds) {
    const entry = catalogProvider?.models.get(modelId)
    const override = findOverride(overrides.entries, { baseURL: route.baseURL, routeId: route.id, modelId })
    const derived = override !== undefined ? deriveFromOverride(override) : deriveFromCatalog(entry)
    const current = configuredEfforts(route.id, modelId)
    const target = derived.declarable ? toEffortsMap(derived.levels) : undefined

    const item = {
      route: route.id,
      api: route.api,
      baseURL: route.baseURL,
      model: modelId,
      catalogApi: entry?.api,
      evidence: derived.evidence ?? (override !== undefined ? (override.evidence ?? 'user') : entry !== undefined ? 'catalog' : 'unknown'),
      evidenceSource: derived.sourceUrl,
      reason: derived.reason,
      current: current?.has === true ? current.value : undefined,
      target,
      levels: derived.levels.map((l) => l.level),
      action: 'none',
      note: undefined,
    }

    if (entry !== undefined && route.api !== undefined && entry.api !== undefined && entry.api !== route.api) {
      item.protocolMismatch = { catalogApi: entry.api, routeApi: route.api }
    }

    // A recorded "leave it undeclared" answer is a settled question, not a gap.
    if (override?.decision === 'skip') {
      item.action = 'skip-by-decision'
      item.note = '你已决定该模型暂不声明档位'
    } else if (derived.reasoning === false) {
      // The evidence says it does not reason. State that explicitly rather than
      // leaving the capability to a field's absence, so "no effort levels" is a
      // decision on the record instead of an accident.
      item.target = false
      if (current?.has === true && current.value === false) {
        item.action = 'none'
        item.note = 'already declared as a non-reasoning model'
      } else if (current?.has === true) {
        item.action = doFix ? 'mark-non-reasoning' : 'conflict'
        item.note = '证据显示不支持思考，但文件里声明了档位'
      } else {
        item.action = 'mark-non-reasoning'
        item.note = '证据显示不支持思考，写成显式 false'
      }
    } else if (target === undefined) {
      // Nothing sources this model. Do not guess, do not leave it silently
      // undeclared: stop and put the question to the user.
      item.action = 'needs-decision'
      item.note = derived.reason ?? 'no evidence for this model'
      item.candidates = siblingCandidates(catalog, modelId, catalogProvider?.id)
    } else if (current?.has !== true) {
      item.action = 'insert'
    } else if (current.value === false) {
      item.action = doFix ? 'replace' : 'conflict'
      item.note = 'declared as a non-reasoning model while the evidence says it reasons'
    } else if (!sameEfforts(current.value, target)) {
      item.action = doFix ? 'replace' : 'conflict'
      item.note = `declared ${Object.keys(current.value ?? {}).join('/')} vs evidence ${Object.keys(target).join('/')}`
    } else {
      item.action = 'none'
      item.note = 'already matches the evidence'
    }
    if (doStrict && item.action !== 'needs-decision' && item.action !== 'skip-by-decision' && item.evidence !== 'probe') {
      item.action = 'skip-strict'
      item.note = `--strict: evidence is "${item.evidence}", not a live probe`
    }
    plan.push(item)
  }
}

// ---------------------------------------------------------------------- probe
async function probeModel(item) {
  const key = item.apiKeyEnv === undefined ? undefined : process.env[item.apiKeyEnv]
  if (key === undefined || key.length === 0) return { attempted: false, reason: `env ${item.apiKeyEnv ?? '(none)'} is not set` }
  if (item.target === undefined) return { attempted: false, reason: 'no target levels to probe' }
  const level = item.levels.filter((l) => l !== 'off').pop()
  const wire = item.target[level]
  const base = (item.baseURL ?? '').replace(/\/+$/, '')
  const headers = { 'content-type': 'application/json' }
  let url
  let body
  if (item.api === 'openai-responses') {
    url = `${base}/responses`
    headers.authorization = `Bearer ${key}`
    body = { model: item.model, input: 'ping', max_output_tokens: 16, reasoning: { effort: wire } }
  } else if (item.api === 'anthropic-messages') {
    url = `${base}/messages`
    headers['x-api-key'] = key
    headers['anthropic-version'] = '2023-06-01'
    body = { model: item.model, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }], thinking: { type: 'enabled', budget_tokens: 1024 } }
  } else {
    url = `${base}/chat/completions`
    headers.authorization = `Bearer ${key}`
    body = { model: item.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16, reasoning_effort: wire }
  }
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
    const text = (await res.text()).slice(0, 400)
    return { attempted: true, ok: res.ok, status: res.status, level, url, detail: res.ok ? undefined : text }
  } catch (error) {
    return { attempted: true, ok: false, status: 0, level, url, detail: error.message }
  }
}

if (doProbe) {
  for (const item of plan) {
    if (item.action === 'skip-no-evidence') continue
    item.probe = await probeModel({ ...item, apiKeyEnv: routes.find((r) => r.id === item.route)?.apiKeyEnv })
    if (item.probe?.ok === true) item.evidence = 'probe'
  }
}

// ------------------------------------------------------------------- route fix
const moves = []
if (doFixRoutes) {
  for (const item of plan) {
    if (item.protocolMismatch === undefined) continue
    moves.push(item)
  }
}

// ------------------------------------------------------------------- reporting
/** Actions that change the document. */
const WRITABLE = new Set(['insert', 'replace', 'mark-non-reasoning'])
const actions = plan.filter((i) => WRITABLE.has(i.action))
const conflicts = plan.filter((i) => i.action === 'conflict')
const skipped = plan.filter((i) => i.action === 'skip-strict')
const undecided = plan.filter((i) => i.action === 'needs-decision')
const byDecision = plan.filter((i) => i.action === 'skip-by-decision')

// --------------------------------------------------------------- route default
// DSH has exactly one way to pin a default effort: the *route-level* `reasoning:` field, the
// only source of `defaultEffort`. It is also the most dangerous field in this document, because
// the adapter applies it to every model on the route — `resolveReasoningLevel(model,
// options.reasoningEffort ?? profile.reasoning)` — and throws UNSUPPORTED_REASONING_EFFORT for a
// model that does not offer that level, a model that does not reason at all included. A route
// default is therefore only "safe" until the next model is added to that route, which is exactly
// how a working configuration breaks: adding one model through the GUI is enough.
//
// So this skill never writes one. With no route default the picker offers "默认" and each model
// falls back to whatever its gateway does by default — a value every model can always accept.
// An existing value is removed whether or not it currently breaks a model: a currently safe one
// is still a value applied route-wide, so it would pin the picker away from "默认" and re-arm the
// same failure for the next model added.
const supportsLevel = (item, level) =>
  typeof item?.target === 'object' && item.target !== null && Object.prototype.hasOwnProperty.call(item.target, level)

const routeDefaults = []
for (const route of routes) {
  if (catalogProviderIds.has(route.id)) continue
  const items = plan.filter((i) => i.route === route.id)
  if (items.length === 0) continue
  const current = providersOf(doc)?.[route.id]?.reasoning
  const describe = (item) =>
    item.target === false
      ? `\`${item.model}\` 不支持思考`
      : item.action === 'needs-decision'
        ? `\`${item.model}\` 档位未确定`
        : item.action === 'skip-by-decision'
          ? `\`${item.model}\` 按你的决定未声明`
          : `\`${item.model}\` 的真实档位里没有该档`
  const entry = { route: route.id, current, action: 'none', why: undefined, blockedBy: [] }

  if (current === undefined) {
    entry.why = '没有路由级默认档（本技能不写入）：选择器显示"默认"，每个模型用网关自己的默认值'
  } else {
    // Support is checked, not assumed: a previous revision announced "already reasoning: high —
    // nothing to do" without ever asking whether every model on the route offers it, so a route
    // default that had just made a newly added model unusable sat in the file unreported.
    entry.action = 'remove'
    entry.blockedBy = items.filter((i) => !supportsLevel(i, current)).map((i) => i.model)
    entry.why =
      entry.blockedBy.length > 0
        ? `现有的 \`reasoning: ${current}\` 会被套用到该路由的**每个**模型，而 ${items
            .filter((i) => !supportsLevel(i, current))
            .map(describe)
            .join('、')}——这些模型的请求会以 UNSUPPORTED_REASONING_EFFORT 失败，因此移除它先把可用性恢复`
        : `现有的 \`reasoning: ${current}\` 目前对全路由都安全，但仍然移除：路由级默认档会把选择器的默认档从"默认"改成 ${current}，并且下次往这条路由加一个不支持该档的模型时直接报错`
  }
  routeDefaults.push(entry)
}

// `agent-default-model.reasoningEffort` is a *global* value: it applies to whatever model a new
// session happens to start on, so it cannot be checked against one model and trusted. It is also
// the picker's own field — selecting a model or a level rewrites it. So this writer does not
// create it and does not clear a choice the user made; it removes the value only when it can prove
// the configured default model does not offer it, which would fail the first request of every new
// session.
const agentDefault = { action: 'none', why: undefined }
{
  const section = entryConfigOf(doc, 'agent-default-model')
  const current = section?.reasoningEffort
  if (section === undefined) agentDefault.why = '该 profile 补丁里没有 `agent-default-model` 条目'
  else if (current === undefined) agentDefault.why = '未设置（不主动写入：它是全局值，只作用于新建会话，选择器一换模型就会改写它）'
  else {
    const item = plan.find((i) => i.route === section.provider && i.model === section.model)
    if (item === undefined) agentDefault.why = `\`${current}\` 保留：默认模型 \`${section.provider}/${section.model}\` 不在自定义路由上，无法证明它不支持该档`
    else if (supportsLevel(item, current)) agentDefault.why = `\`${current}\` 保留：默认模型 \`${section.provider}/${section.model}\` 支持它`
    else {
      agentDefault.action = 'remove-unsafe'
      agentDefault.why = `默认模型 \`${section.provider}/${section.model}\` 的真实档位里没有 ${current}，新建会话的第一条请求就会失败，因此移除`
    }
  }
}

function levelsOf(map) {
  if (map === undefined) return '(无)'
  if (map === false) return '(非推理模型)'
  return THINKING_LEVELS.filter((l) => Object.prototype.hasOwnProperty.call(map, l)).join(' / ')
}

/**
 * Turn sibling attestations into the concrete choices to put to the user: the
 * intersection (most likely to be accepted everywhere), the most common exact set,
 * and the union (most complete, but may include a value one gateway rejects).
 */
function levelPlans(candidates) {
  const sets = candidates.filter((c) => c.reasoning && c.levels.length > 0).map((c) => c.levels)
  if (sets.length === 0) return undefined
  const order = (levels) => THINKING_LEVELS.filter((l) => levels.includes(l))
  const intersection = order(sets.reduce((a, b) => a.filter((l) => b.includes(l))))
  const union = order([...new Set(sets.flat())])
  const counts = new Map()
  for (const set of sets) {
    const key = order(set).join(',')
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const [majority, majorityCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  return { intersection, majority: majority.split(',').filter((l) => l.length > 0), majorityCount, union, samples: sets.length }
}

function buildReport() {
  const out = []
  out.push('# 思考强度核对报告（自定义提供方）')
  out.push('')
  out.push(`- 目标文档：\`${settingsPath}\`${profileLabel === undefined ? '' : `（profile ${profileLabel}）`}`)
  out.push(`- dsh 安装：\`${install.label}\`${version === undefined ? '' : ` · dsh ${version}`}`)
  out.push(`- pi-ai 目录：${catalog.providers.size} 个 provider${catalog.available ? '' : '（**未找到，能力无从判定**）'}`)
  out.push(`- compat gates：${gates.available ? '已解析' : `**不可用**（${gates.reason}）→ 跳过 compat 结论`}`)
  out.push(`- 模式：${doApply ? '**apply（会写盘）**' : 'dry-run（加 `--apply` 才写盘）'}${doFix ? ' · --fix' : ''}${doStrict ? ' · --strict' : ''}${doFixRoutes ? ' · --fix-routes' : ''}`)
  out.push(`- 契约：contract ${CONTRACT}${scope === 'partial' ? ' · **部分模式**：`--route` 限定了路由，exit 0 只代表这些路由已覆盖' : ' · 覆盖范围内全部自定义路由'}`)
  out.push(`- **结论 ${verdict}** → 下一步：**${nextAction}**`)
  out.push('')

  out.push('## 自定义提供方（可写入）')
  out.push('')
  if (plan.length === 0) {
    out.push('（没有自定义提供方，或没有任何模型）')
    out.push('')
  } else {
    // Coverage headline: the contract is that *every* model on a hand-declared
    // route ends up either declared or explicitly waiting on a decision — never
    // silently undeclared.
    const byRoute = new Map()
    for (const item of plan) {
      const b = byRoute.get(item.route) ?? { levels: 0, nonReasoning: 0, undecided: 0, byDecision: 0 }
      if (item.target === false) b.nonReasoning++
      else if (item.action === 'needs-decision') b.undecided++
      else if (item.action === 'skip-by-decision') b.byDecision++
      else b.levels++
      byRoute.set(item.route, b)
    }
    for (const [routeId, b] of byRoute) {
      const bits = [`${b.levels} 个有思考档位`]
      if (b.nonReasoning > 0) bits.push(`${b.nonReasoning} 个显式非推理`)
      if (b.byDecision > 0) bits.push(`${b.byDecision} 个按你的决定不声明`)
      if (b.undecided > 0) bits.push(`**${b.undecided} 个待你决定**`)
      out.push(`- \`${routeId}\`：${b.levels + b.nonReasoning + b.undecided + b.byDecision} 个模型 —— ${bits.join('，')}`)
    }
    out.push('')
    out.push('| 路线 | 模型 | 现状 | 目标 | 依据 | 动作 |')
    out.push('| --- | --- | --- | --- | --- | --- |')
    for (const item of plan) {
      const actionText =
        item.action === 'insert' ? '**新增声明**'
        : item.action === 'replace' ? '**改写声明**'
        : item.action === 'mark-non-reasoning' ? '**显式声明为非推理**'
        : item.action === 'needs-decision' ? '**需要你决定**'
        : item.action === 'skip-by-decision' ? '按你的决定不声明'
        : item.action === 'conflict' ? '冲突（加 `--fix` 才对）'
        : item.action === 'skip-strict' ? '跳过（--strict）'
        : '无需改动'
      out.push(`| \`${item.route}\` | \`${item.model}\` | ${levelsOf(item.current)} | ${levelsOf(item.target)} | ${item.evidence} | ${actionText} |`)
    }
    out.push('')
    for (const item of plan) {
      const bits = []
      if (item.evidenceSource !== undefined) bits.push(`来源：${item.evidenceSource}`)
      if (item.note !== undefined) bits.push(item.note)
      if (item.protocolMismatch !== undefined) {
        bits.push(`协议与目录不同：目录把该模型标为 \`${item.protocolMismatch.catalogApi}\`，本路线是 \`${item.protocolMismatch.routeApi}\`（网关按路径分流；公开端点表已被实测证伪为非权威，故此处只提示、不判定故障）`)
      }
      if (item.probe !== undefined) {
        bits.push(item.probe.attempted
          ? `实发探测：${item.probe.ok ? `已接受（HTTP ${item.probe.status}，档位 ${item.probe.level}）` : `被拒/失败（HTTP ${item.probe.status}）${item.probe.detail === undefined ? '' : ` — ${item.probe.detail.slice(0, 160)}`}`}`
          : `实发探测：跳过（${item.probe.reason}）`)
      }
      if (bits.length > 0) out.push(`- \`${item.route}/${item.model}\`：${bits.join(' · ')}`)
    }
    out.push('')
    out.push('依据等级：`probe`（实发已证实）＞`vendor`（厂商文档）＞`user`（你记录的决定）＞`catalog`（目录声明，网关未实证）＞`unknown`（据此**不写入**，只提问）。')
    out.push('')
  }

  if (moves.length > 0) {
    out.push('## 路线迁移建议（--fix-routes）')
    out.push('')
    out.push('⚠️ 这一项**不能**按公开端点表当判据：本机实测过一条 openai-responses 路线连续 64 次成功服务目录标为')
    out.push('`openai-completions` 的模型。目录里的 `api` 是**默认值**，不是约束。因此迁移必须逐路线显式决定')
    out.push('（`--fix-routes` 要求同时给出 `--route <名称>`），而且它有**弄坏一条当前可用路线**的风险。')
    out.push('')
    for (const item of moves) {
      out.push(`- \`${item.route}/${item.model}\`：目录把它标为 \`${item.catalogApi}\`，而本路线是 \`${item.protocolMismatch.routeApi}\`。`)
    }
    out.push('')
  }

  if (readOnly.length > 0) {
    out.push('## 目录路线（只读，本技能永不写入）')
    out.push('')
    out.push('| 路线 | api | 模型 → 继承到的档位 |')
    out.push('| --- | --- | --- |')
    for (const r of readOnly) {
      const models = r.models.map((m) => `\`${m.id}\`${m.levels.length > 0 ? ` → ${m.levels.join('/')}` : ' → 无'}`).join('，')
      out.push(`| \`${r.route}\` | ${r.api ?? '(缺省)'} | ${models} |`)
    }
    out.push('')
  }

  const builtinDeepSeek = doc?.['llm-deepseek']
  if (builtinDeepSeek !== undefined) {
    out.push('## 内置提供方（只读）')
    out.push('')
    out.push(`- \`llm-deepseek\`（provider id \`deepseek-official\`）：档位固定为 **off / low / high / max**（4 档），无 per-model 声明。`)
    out.push('')
  }

  out.push('## 默认档位（路由级 `reasoning:` 一律不保留）')
  out.push('')
  out.push('DSH 里唯一能固定默认档的是**路由级** `reasoning:`，而它会被套用到该路由的**每个**模型——遇到不支持该档的模型（含非推理模型），请求直接以 `UNSUPPORTED_REASONING_EFFORT` 失败。所以本技能不写入它，并且在发现时移除它：默认档保持"默认"，由网关自己决定，这是每个模型都能接受的取值。')
  out.push('')
  for (const entry of routeDefaults) {
    const mark = entry.action === 'remove' ? '**移除**' : '无需改动'
    out.push(`- \`${entry.route}\`：${mark}${entry.why === undefined ? '' : ` —— ${entry.why}`}`)
  }
  const agentMark =
    agentDefault.action === 'none' ? '无需改动'
    : agentDefault.action === 'remove-unsafe' ? '**移除（修复）**'
    : '冲突（加 `--fix`）'
  out.push(`- \`agent-default-model.reasoningEffort\`（**新建**会话的初始档位，选择器自己会写它）：${agentMark}${agentDefault.why === undefined ? '' : ` —— ${agentDefault.why}`}`)
  out.push('')

  if (undecided.length > 0) {
    out.push('## 需要你决定 —— 技能不会替你猜')
    out.push('')
    out.push('这些模型既不在 pi-ai 目录里，也没有可引用的厂商文档，所以技能**不会**写入任何档位：猜一个写进去等于撒谎。给一个答案，技能会把它记进 `data/user-decisions.yaml` 并据此补全。')
    out.push('')
    for (const item of undecided) {
      out.push(`### \`${item.route}/${item.model}\``)
      out.push('')
      out.push(`- 现状：${levelsOf(item.current)}｜未写入原因：${item.note}`)
      const candidates = Array.isArray(item.candidates) ? item.candidates : []
      if (candidates.length > 0) {
        out.push('- 同族旁证（**其他网关的条目，不是本条路线**；只供你判断，技能不会据此写入）：')
        for (const c of candidates.slice(0, 6)) {
          const levels = c.levels.length > 0 ? c.levels.join('/') : '(无档位)'
          out.push(`  - \`${c.providerId}\` 的 \`${c.id}\`（${c.api}，${c.explicitMap ? 'declares a map' : 'no map'}）→ ${levels}`)
        }
        if (candidates.length > 6) out.push(`  - …另有 ${candidates.length - 6} 条`)
      } else {
        out.push('- 同族旁证：无（目录里没有任何 provider 收录过这个 id）')
      }
      const plans = levelPlans(candidates)
      const spec = (levels) => `--decide '${item.route}/${item.model}=${levels.join(',')}'`
      if (plans !== undefined) {
        out.push(`- 推荐方案（来自 ${plans.samples} 条同族旁证，选一个告诉我即可）：`)
        const seen = new Set()
        const offer = (levels, why) => {
          const key = levels.join(',')
          if (levels.length === 0 || seen.has(key)) return
          seen.add(key)
          out.push(`  - \`${spec(levels)}\` —— ${why}`)
        }
        offer(plans.intersection, '交集：最保守，也最可能被真正接受')
        offer(plans.majority, `多数派：${plans.samples} 条里有 ${plans.majorityCount} 条是这一套`)
        offer(plans.union, '并集：最全，但可能含个别网关不认的档位')
      } else {
        out.push('- 推荐档位：**没有可推荐的**——目录里没有任何 provider 收录过这个 id。建议先实测，或者你直接给档位。')
      }
      out.push('- 其他选项：')
      out.push(`  - 声明为不支持思考：\`--decide '${item.route}/${item.model}=false'\``)
      out.push(`  - 暂不声明、技能不再来问：\`--decide '${item.route}/${item.model}=skip'\``)
      out.push(`  - 你自己给档位：\`--decide '${item.route}/${item.model}=<${THINKING_LEVELS.join('|')}>'\``)
      out.push('- 或者先实测一次（每个模型一次最小请求，会产生费用）：`--probe`')
      out.push('')
    }
    out.push('记录之后重跑一次（可与 `--apply` 同一次调用）即可补全这些模型。')
    out.push('')
  }

  out.push('## 观察与警告')
  out.push('')
  // Entries that no longer match a configured model. Harmless, but worth pruning
  // after a provider or a model is deleted — which is the only cleaning up that a
  // deletion ever needs, because declarations live on the model entries themselves.
  const configuredKeys = new Set(plan.map((i) => `${i.route}/${i.model}`))
  const staleEntries = overrides.entries.filter(
    (e) =>
      typeof e?.match?.provider === 'string' &&
      typeof e?.match?.model === 'string' &&
      !configuredKeys.has(`${e.match.provider}/${e.match.model}`),
  )
  if (warnings.length === 0 && conflicts.length === 0 && skipped.length === 0 && staleEntries.length === 0) out.push('- 无。')
  for (const w of warnings) out.push(`- ${w}`)
  for (const c of conflicts) out.push(`- 冲突：\`${c.route}/${c.model}\` ${c.note}。默认不动，加 \`--fix\` 才对齐。`)
  for (const s of skipped) out.push(`- 未写入：\`${s.route}/${s.model}\`（${s.note}）`)
  if (staleEntries.length > 0) {
    out.push(`- 以下记录对应的模型已不在配置里（删掉 provider 或模型之后就是这样）。留着无害，可自行清理：${staleEntries.map((e) => `\`${e.match.provider}/${e.match.model}\``).join('、')}`)
  }
  out.push('- `openai-completions` 路线上发不出任何会话头：`sendSessionAffinityHeaders` 在 DSH 里是 `withhold`，只能由 pi-ai 目录设置，而 opencode-go 的 completions 条目都没带。声明思考强度**不会**改变这一点。')
  out.push('')

  out.push('## 下一步')
  out.push('')
  if (verdict === 'covered') {
    out.push(`- 结论 **covered**：范围内的自定义路由上，每个模型都有显式声明${scope === 'partial' ? '（部分模式）' : ''}。`)
    out.push('- 刷新页面（或在 `/model` 选择器里重新选一次模型）后在 **Effort** 面板确认：推理模型里有一项 **默认** 且预选它；非推理模型没有任何档位可选项。')
    out.push('- 档位"被列出"不等于"被兑现"：`--probe` 能确认网关接受该取值，但**不能**证明思考深度真的变了。')
  } else if (verdict === 'blocked') {
    out.push('- 结论 **blocked**：有写入被拒绝或校验失败，文档未被改动。先按上面的 ❌ 信息修环境，再重跑同一命令。')
  } else {
    out.push(`- 结论 **${verdict}**，下一步 **${nextAction}**。按下面这些命令原样执行即可，不需要自行推导：`)
    out.push('')
    out.push('```')
    for (const c of commands) out.push(c)
    out.push('```')
  }
  out.push('')
  return out.join('\n')
}

// ------------------------------------------------------------------- mutations
let text = original
const applied = []
const failures = []

if (doApply && doFixRoutes && moves.length > 0) {
  for (const item of moves) {
    const targetId = `${item.route}--${item.catalogApi}`
    const sourceRoute = routes.find((r) => r.id === item.route)
    if (locateRoute(splitText(text).lines, targetId) === undefined) {
      const base = item.catalogApi === 'anthropic-messages' ? normalizeBaseUrl(item.baseURL) : item.baseURL
      const created = createRoute(text, targetId, {
        api: item.catalogApi,
        baseURL: base,
        apiKeyEnv: sourceRoute?.apiKeyEnv,
        displayName: `${sourceRoute?.displayName ?? item.route} (${item.catalogApi})`,
        modelBlock: [],
      })
      if (!created.changed) {
        failures.push(`路线迁移：无法创建 \`${targetId}\`（${created.reason}）`)
        continue
      }
      text = created.text
      applied.push(`创建路线 \`${targetId}\`（api: ${item.catalogApi}）`)
    }
    const moved = moveModelItem(text, item.route, targetId, item.model)
    if (!moved.changed) {
      failures.push(`路线迁移：\`${item.route}/${item.model}\` 未迁移（${moved.reason}）`)
      continue
    }
    text = moved.text
    applied.push(`迁移 \`${item.model}\`：\`${item.route}\` → \`${targetId}\``)
  }
}

if (doApply) {
  for (const item of plan) {
    if (!WRITABLE.has(item.action)) continue
    const routeForModel = moves.some((m) => m.route === item.route && m.model === item.model) ? `${item.route}--${item.catalogApi}` : item.route
    const result = upsertReasoningEfforts(text, routeForModel, item.model, item.target)
    if (result.text !== undefined) text = result.text
    if (result.changed) applied.push(`${result.action === 'inserted' ? '新增' : '改写'} \`${routeForModel}/${item.model}\` → ${levelsOf(item.target)}`)
    else if (!result.unchanged) failures.push(`\`${item.model}\`：${result.reason}`)
  }

  // Route-level default: the one field this skill removes rather than writes. It is applied to
  // every model on the route, so leaving the wrong value behind breaks requests that have nothing
  // to do with the model that was just added.
  for (const entry of routeDefaults) {
    if (entry.action !== 'remove') continue
    const removed = removeRouteScalar(text, entry.route, 'reasoning')
    if (removed.text !== undefined) text = removed.text
    if (removed.changed) {
      applied.push(
        `路线 \`${entry.route}\` 移除 \`reasoning: ${entry.current}\`（${
          entry.blockedBy.length > 0
            ? `它会让 ${entry.blockedBy.join('、')} 的请求报错，先恢复可用性`
            : '路由级默认档一律不保留，默认档回到"默认"'
        }）`,
      )
    } else if (!removed.unchanged) failures.push(`\`${entry.route}\` 移除路由默认：${removed.reason}`)
  }
  if (agentDefault.action === 'remove-unsafe') {
    const removed = removePatchConfigScalar(text, 'agent-default-model', 'reasoningEffort')
    if (removed.text !== undefined) text = removed.text
    if (removed.changed) applied.push('移除 `agent-default-model.reasoningEffort`（对默认模型不可用，会让新建会话的第一条请求失败）')
    else if (!removed.unchanged) failures.push(`agent-default-model.reasoningEffort：${removed.reason}`)
  }
}

// ------------------------------------------------------------------ validation
function flatten(value, prefix, out) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      const key = v !== null && typeof v === 'object' && typeof v.id === 'string' ? `[id=${v.id}]` : `[${i}]`
      flatten(v, prefix + key, out)
    })
    return out
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix.length === 0 ? k : `${prefix}.${k}`, out)
    return out
  }
  out.set(prefix, JSON.stringify(value))
  return out
}

let validation = { ok: true }
if (text !== original) {
  let reparsed
  try {
    reparsed = yaml.load(text)
  } catch (error) {
    validation = { ok: false, reason: `编辑后的文档无法解析：${error.message}` }
  }
  if (validation.ok) {
    const before = flatten(doc, '', new Map())
    const after = flatten(reparsed, '', new Map())
    const changedPaths = []
    for (const [path, value] of after) if (!before.has(path) || before.get(path) !== value) changedPaths.push(path)
    for (const [path] of before) if (!after.has(path)) changedPaths.push(`${path} (removed)`)
    // Only the `llm-pi-ai` row's providers may change, plus the single field this skill removes
    // from the `agent-default-model` row. `flatten` names a sequence element that carries an `id`
    // as `[id=<id>]`, so this allow-list does not depend on where a row sits in the file; a
    // removal arrives as the same path with a ` (removed)` suffix, which is stripped first.
    const allowed = /^\[id=llm-pi-ai\]\.config\.providers\.|^\[id=agent-default-model\]\.config\.reasoningEffort$/
    const stray = changedPaths.filter((p) => !allowed.test(p.replace(/ \(removed\)$/, '')))
    validation = { ok: stray.length === 0, changedPaths, stray, doc: reparsed }
    if (stray.length > 0) validation.reason = `编辑越界，改到了预期之外的路径：${stray.join(', ')}`
  }
  if (validation.ok) {
    for (const item of plan) {
      if (!WRITABLE.has(item.action)) continue
      const routeForModel = moves.some((m) => m.route === item.route && m.model === item.model) ? `${item.route}--${item.catalogApi}` : item.route
      const got = providersOf(validation.doc)?.[routeForModel]?.models?.find?.((m) => m?.id === item.model)?.reasoningEfforts
      if (item.target === false) {
        if (got !== false) {
          validation = { ok: false, reason: `校验失败：\`${routeForModel}/${item.model}\` 应为显式 false` }
          break
        }
        continue
      }
      if (got === undefined || got === false) {
        validation = { ok: false, reason: `校验失败：\`${routeForModel}/${item.model}\` 写入后读不到 reasoningEfforts` }
        break
      }
      const gotMap = Object.fromEntries(THINKING_LEVELS.filter((l) => l in got).map((l) => [l, got[l] ?? null]))
      if (!sameEfforts(gotMap, item.target)) {
        validation = { ok: false, reason: `校验失败：\`${routeForModel}/${item.model}\` 读回的值与目标不符` }
        break
      }
    }
    for (const entry of routeDefaults) {
      if (!validation.ok) break
      if (entry.action !== 'remove') continue
      const got = providersOf(validation.doc)?.[entry.route]?.reasoning
      if (got !== undefined) validation = { ok: false, reason: `校验失败：\`${entry.route}\` 的 reasoning 未被移除（读回 ${String(got)}）` }
    }
    if (validation.ok && agentDefault.action === 'remove-unsafe') {
      const got = entryConfigOf(validation.doc, 'agent-default-model')?.reasoningEffort
      if (got !== undefined) validation = { ok: false, reason: `校验失败：agent-default-model.reasoningEffort 未被移除（读回 ${String(got)}）` }
    }
  }
}

let backupPath
if (doApply && text !== original && validation.ok) {
  backupPath = nextBackupFile()
  // The write is the one step that can fail for reasons outside this program's control — a
  // read-only file, a missing directory, a lock held by the running DSH. It is reported as exit 2
  // ("this invocation could not run"), never as exit 1 ("there is work to do"), because an agent
  // reads 1 as ordinary progress and would retry the same command forever.
  try {
    copyFileSync(settingsPath, backupPath)
    writeFileSync(settingsPath, text, 'utf8')
  } catch (error) {
    console.error(`❌ could not write ${settingsPath}: ${error.message}`)
    console.error(`The document was NOT changed. Backup attempted: ${backupPath}`)
    console.error('If DSH or an editor holds the file, close it and run the same command again.')
    process.exit(2)
  }
}

// ---------------------------------------------------------------------- output
// ---------------------------------------------------------------------- verdict
// One machine-readable conclusion, so an agent does not have to interpret a report. The
// exit code follows it exactly: 0 only for `covered`, which means every model on every
// custom route in scope has an explicit declaration *and* no route-level default is left.
const scope = onlyRoutes.size === 0 ? 'all' : 'partial'
const coverage = routes
  .filter((r) => !catalogProviderIds.has(r.id))
  .map((r) => {
    const items = plan.filter((i) => i.route === r.id)
    return {
      route: r.id,
      models: items.length,
      withLevels: items.filter((i) => typeof i.target === 'object' && i.target !== null).length,
      nonReasoning: items.filter((i) => i.target === false).length,
      undecided: items.filter((i) => i.action === 'needs-decision').length,
    }
  })
// A route-level default in the document is unfinished work, always: it is a value applied to every
// model on the route, so it has to come out before the document can be called covered. It is
// *reported* as a removal rather than as a permanent condition, and the exit code carries it, so a
// dry run cannot be mistaken for "nothing to do".
const routeDefaultRemovals = routeDefaults.filter((e) => e.action === 'remove')
const pendingWork = actions.length > 0 || conflicts.length > 0 || routeDefaultRemovals.length > 0

let verdict
if (failures.length > 0 || !validation.ok) verdict = 'blocked'
else if (undecided.length > 0) verdict = 'needs-decision'
else if (conflicts.length > 0) verdict = 'conflicts'
else if (!doApply && pendingWork) verdict = 'pending'
else verdict = 'covered'

const commands = []
let nextAction = 'none'
if (verdict === 'blocked') {
  nextAction = 'report-blocker'
} else if (undecided.length > 0) {
  nextAction = 'search-then-ask'
  for (const item of undecided) {
    const plans = levelPlans(Array.isArray(item.candidates) ? item.candidates : [])
    const seen = new Set()
    for (const levels of [plans?.intersection, plans?.majority, plans?.union]) {
      if (!Array.isArray(levels) || levels.length === 0) continue
      const key = levels.join(',')
      if (seen.has(key)) continue
      seen.add(key)
      commands.push(`node scripts/apply-reasoning-efforts.mjs --decide ${item.route}/${item.model}=${key} --apply`)
    }
    commands.push(`node scripts/apply-reasoning-efforts.mjs --decide ${item.route}/${item.model}=false --apply`)
    commands.push(`node scripts/apply-reasoning-efforts.mjs --decide ${item.route}/${item.model}=skip --apply`)
  }
} else if (conflicts.length > 0) {
  nextAction = 'resolve-conflicts'
  commands.push('node scripts/apply-reasoning-efforts.mjs --fix --apply')
} else if (verdict === 'pending') {
  nextAction = 'apply'
  commands.push('node scripts/apply-reasoning-efforts.mjs --apply')
}

const report = buildReport()
if (reportPath !== undefined) {
  const target = resolve(reportPath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, report, 'utf8')
}

if (asJson) {
  console.log(JSON.stringify({
    contract: CONTRACT,
    settings: settingsPath,
    dsh: { root: install.label, version, piAiCatalog: catalog.providers.size, compatGates: gates.available },
    mode: { apply: doApply, fix: doFix, strict: doStrict, fixRoutes: doFixRoutes, probe: doProbe, scope },
    verdict,
    nextAction,
    commands,
    coverage,
    routeDefaults: routeDefaults.map((e) => ({ route: e.route, current: e.current, action: e.action, blockedBy: e.blockedBy, why: e.why })),
    agentDefault: { action: agentDefault.action, why: agentDefault.why },
    plan,
    moves: moves.map((m) => ({ route: m.route, model: m.model, catalogApi: m.catalogApi, routeApi: m.routeApi })),
    readOnly,
    warnings,
    applied,
    failures,
    validation,
    backup: backupPath,
  }, null, 2))
} else {
  console.log(report)
  if (doApply) {
    console.log('## 已执行')
    console.log('')
    if (applied.length === 0) console.log('- 没有需要写入的改动。')
    for (const line of applied) console.log(`- ${line}`)
    for (const line of failures) console.log(`- ⚠️ ${line}`)
    if (backupPath !== undefined) console.log(`- 备份：\`${backupPath}\``)
    if (!validation.ok) console.log(`- ❌ 未写盘：${validation.reason}`)
    console.log('')
  }
}

// A model awaiting a decision is unfinished work, not a success: it must not be possible
// to read a clean exit as "every model is covered". The exit code follows the verdict.
process.exit(verdict === 'covered' ? 0 : 1)
