#!/usr/bin/env node
/**
 * apply-reasoning-efforts.mjs — give every model on a hand-declared
 * `llm-pi-ai` route the reasoning-effort levels it actually has.
 *
 * Built-in providers are never written. A route whose key is a pi-ai catalog
 * provider id inherits its capabilities from the catalog and is reported
 * read-only; only routes the catalog does not know (`declared: true` in DSH's
 * own terms) are edited, because those are the ones whose models silently have
 * no levels at all.
 *
 * The default is a dry run: nothing is written unless `--apply` is passed, and
 * every write is preceded by a timestamped backup and followed by a full
 * re-parse plus a path-level diff against what was intended.
 *
 * Exit codes: 0 nothing to do, 1 changes pending or problems found, 2 the
 * environment could not be read (install, js-yaml, or the settings document).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { analyzeLine, children, joinText, listRoutes, locateRoute, moveModelItem, createRoute, splitText, upsertNamespaceScalar, upsertReasoningEfforts, upsertRouteScalar } from './lib/yaml-edit.mjs'
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
  candidateRoots,
  defaultSettingsPath,
  dshVersion,
  findInstall,
  loadCatalog,
  loadCompatGates,
  loadYaml,
  normalizeBaseUrl,
} from './lib/dsh-install.mjs'

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ------------------------------------------------------------------ arguments
const argv = process.argv.slice(2)
const flagValue = (name, fallback) => {
  const i = argv.indexOf(name)
  return i === -1 ? fallback : argv[i + 1]
}
const flagAll = (name) => argv.flatMap((a, i) => (a === name && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? [argv[i + 1]] : []))
const has = (name) => argv.includes(name)

if (has('--help') || has('-h')) {
  console.log(`usage: node apply-reasoning-efforts.mjs [options]

  --settings <path>   settings document (default: $DSH_HOME/settings.yaml)
  --dsh-root <path>   dsh install root holding node_modules (default: discovered)
  --route <name>      limit to these routes (repeatable; default: every custom route)
  --apply             write the document (default: dry run, prints the plan)
  --fix               also replace declarations that disagree with the evidence
  --strict            write only models whose evidence is a live probe (implies --probe)
  --probe             allow ONE minimal live request per model, to record evidence
  --fix-routes        move models whose catalog protocol differs from their route's api
  --restore <ref>     restore "latest" backup, or a named backup file, then exit
  --report <path>     also write the markdown report to this file
  --json              print machine-readable JSON instead of the markdown report

Exit codes: 0 nothing to do · 1 changes pending or problems found · 2 environment unreadable`)
  process.exit(0)
}

// --------------------------------------------------------------------- restore
const settingsPath = resolve(flagValue('--settings', defaultSettingsPath()))
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
  const stamp = stampName()
  const guard = `${settingsPath}.bak-before-restore-${stamp}`
  copyFileSync(settingsPath, guard)
  copyFileSync(source, settingsPath)
  console.log(`restored : ${source}`)
  console.log(`previous : ${guard}`)
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
  console.error(`settings document not found: ${settingsPath}`)
  process.exit(2)
}
const original = readFileSync(settingsPath, 'utf8')
const install = findInstall(dshRootArg)
const yaml = loadYaml([dirname(settingsPath), SKILL_DIR])
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
  console.error(`settings document does not parse: ${error.message}`)
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
  const model = doc?.['llm-pi-ai']?.providers?.[routeId]?.models?.find?.((m) => m?.id === modelId)
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
    // A catalog route: report what it inherits, write nothing. This is the
    // "built-in providers are not touched" half of the contract.
    const models = route.modelIds.map((id) => {
      const entry = catalog.providers.get(route.id)?.models.get(id)
      const derived = deriveFromCatalog(entry)
      return { id, api: entry?.api ?? route.api, levels: derived.levels.map((l) => l.level), reasoning: derived.reasoning }
    })
    readOnly.push({ route: route.id, api: route.api, baseURL: route.baseURL, models })
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

// ------------------------------------------------------------------ defaults
// A defined `defaultEffort` is what makes the picker drop its "Default" entry, and
// the only source of one is the route-level `reasoning:` field. It applies to
// *every* model on the route — `resolveReasoningLevel` throws for a model that does
// not offer the level — so it may only be written when every model on the route
// genuinely offers it. Without this, a model sits at "Default" and the gateway's own
// default decides how hard it thinks.
const defaultLevel = flagValue('--default-effort', 'high')
const wantDefault = !['skip', 'none', 'no', 'off'].includes(defaultLevel)
if (wantDefault && !THINKING_LEVELS.includes(defaultLevel)) {
  console.error(`--default-effort must be a pi-ai level or "skip", got: ${defaultLevel}`)
  process.exit(2)
}
const offersLevel = (item) =>
  typeof item?.target === 'object' && item.target !== null && Object.prototype.hasOwnProperty.call(item.target, defaultLevel)

const routeDefaults = []
if (wantDefault) {
  for (const route of routes) {
    if (catalogProviderIds.has(route.id)) continue
    const items = plan.filter((i) => i.route === route.id)
    if (items.length === 0) continue
    const blocked = items.filter((i) => !offersLevel(i))
    const current = doc?.['llm-pi-ai']?.providers?.[route.id]?.reasoning
    const entry = { route: route.id, current, level: defaultLevel, action: 'none', why: undefined }
    if (current === defaultLevel) entry.why = `已经是 reasoning: ${defaultLevel}`
    else if (blocked.length > 0) {
      entry.action = 'blocked'
      entry.why = blocked
        .map((i) =>
          i.target === false
            ? `\`${i.model}\` 不支持思考`
            : i.action === 'needs-decision'
              ? `\`${i.model}\` 档位未确定`
              : i.action === 'skip-by-decision'
                ? `\`${i.model}\` 按你的决定未声明`
                : `\`${i.model}\` 的真实档位里没有 ${defaultLevel}`,
        )
        .join('、')
    } else if (current !== undefined) {
      entry.action = doFix ? 'replace' : 'conflict'
      entry.why = `路由已经写着 reasoning: ${current}`
    } else entry.action = 'insert'
    routeDefaults.push(entry)
  }
}

const agentDefault = { action: 'none', why: undefined }
if (wantDefault) {
  const section = doc?.['agent-default-model']
  if (section === undefined) agentDefault.why = 'settings 里没有 `agent-default-model` 段（不新建，避免写出不合 schema 的段）'
  else {
    const item = plan.find((i) => i.route === section.provider && i.model === section.model)
    if (section.reasoningEffort === defaultLevel) agentDefault.why = `已经是 ${defaultLevel}`
    else if (item === undefined) agentDefault.why = `默认模型 \`${section.provider}/${section.model}\` 不在自定义路由上（目录路线或内置提供方），不越界修改`
    else if (!offersLevel(item)) agentDefault.why = `默认模型 \`${section.provider}/${section.model}\` 的真实档位里没有 ${defaultLevel}`
    else agentDefault.action = section.reasoningEffort === undefined ? 'insert' : doFix ? 'replace' : 'conflict'
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
  out.push(`- settings：\`${settingsPath}\``)
  out.push(`- dsh 安装：\`${install.label}\`${version === undefined ? '' : ` · dsh ${version}`}`)
  out.push(`- pi-ai 目录：${catalog.providers.size} 个 provider${catalog.available ? '' : '（**未找到，能力无从判定**）'}`)
  out.push(`- compat gates：${gates.available ? '已解析' : `**不可用**（${gates.reason}）→ 跳过 compat 结论`}`)
  out.push(`- 模式：${doApply ? '**apply（会写盘）**' : 'dry-run（加 `--apply` 才写盘）'}${doFix ? ' · --fix' : ''}${doStrict ? ' · --strict' : ''}${doFixRoutes ? ' · --fix-routes' : ''}`)
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

  if (wantDefault) {
    out.push('## 默认档位（消除选择器里的 "Default"）')
    out.push('')
    out.push(`目标档位：**${defaultLevel}**（\`--default-effort <level>\` 可改，\`--default-effort skip\` 关闭本节的全部写入）。`)
    out.push('')
    out.push('路由级 `reasoning:` 是 `defaultEffort` 的唯一来源，而选择器只在 `defaultEffort === undefined` 时才插入 "Default" 项——写上它，既去掉"默认"，也把默认值定成目标档。代价是它作用于该路由的**每个**模型，遇到不支持该档的模型时请求会直接报 `UNSUPPORTED_REASONING_EFFORT`，所以只在全路由都支持时才写。')
    out.push('')
    for (const entry of routeDefaults) {
      const mark =
        entry.action === 'insert' ? '**写入**'
        : entry.action === 'replace' ? '**改写**（--fix）'
        : entry.action === 'conflict' ? '冲突（加 `--fix`）'
        : entry.action === 'blocked' ? '**未写**'
        : '无需改动'
      out.push(`- \`${entry.route}\`：${mark}${entry.why === undefined ? '' : ` —— ${entry.why}`}`)
    }
    const agentMark =
      agentDefault.action === 'none' ? '无需改动'
      : agentDefault.action === 'insert' ? '**写入**'
      : agentDefault.action === 'replace' ? '**改写**（--fix）'
      : '冲突（加 `--fix`）'
    out.push(`- \`agent-default-model.reasoningEffort\`（**新建**会话的默认档位）：${agentMark}${agentDefault.why === undefined ? '' : ` —— ${agentDefault.why}`}`)
    out.push('')
  }

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
  if (!doApply) {
    out.push('1. 干跑无误后加 `--apply` 落盘（会自动备份并逐路径校验）。')
    out.push('2. 刷新 GUI 或重开一个 dsh 进程，然后在 `/model` 选择器的 **Effort** 面板里确认档位。')
  } else {
    out.push('1. 刷新页面（或在 `/model` 选择器里重新选一次模型）后在 **Effort** 面板确认档位。')
    out.push('2. 若档位没出现，重开一个 dsh 进程；若仍不对，用 `--restore latest` 回滚。')
  }
  out.push('3. 档位"被列出"不等于"被兑现"：`--probe` 可发一次最小请求确认网关接受该取值，但它仍不能证明思考深度真的变了。')
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

  // Route-level default: this is what removes the picker's "Default" entry.
  for (const entry of routeDefaults) {
    if (entry.action !== 'insert' && entry.action !== 'replace') continue
    const written = upsertRouteScalar(text, entry.route, 'reasoning', entry.level)
    if (written.text !== undefined) text = written.text
    if (written.changed) applied.push(`路线 \`${entry.route}\` 写入 \`reasoning: ${entry.level}\`（选择器不再出现 "Default"）`)
    else if (!written.unchanged) failures.push(`\`${entry.route}\` 路由默认档位：${written.reason}`)
  }
  if (agentDefault.action === 'insert' || agentDefault.action === 'replace') {
    const written = upsertNamespaceScalar(text, 'agent-default-model', 'reasoningEffort', defaultLevel)
    if (written.text !== undefined) text = written.text
    if (written.changed) applied.push(`\`agent-default-model.reasoningEffort\` 设为 ${defaultLevel}（新建会话即默认 ${defaultLevel}）`)
    else if (!written.unchanged) failures.push(`agent-default-model.reasoningEffort：${written.reason}`)
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
    const allowed = /^(llm-pi-ai\.providers\.|agent-default-model\.)/
    const stray = changedPaths.filter((p) => !allowed.test(p))
    validation = { ok: stray.length === 0, changedPaths, stray, doc: reparsed }
    if (stray.length > 0) validation.reason = `编辑越界，改到了预期之外的路径：${stray.join(', ')}`
  }
  if (validation.ok) {
    for (const item of plan) {
      if (!WRITABLE.has(item.action)) continue
      const routeForModel = moves.some((m) => m.route === item.route && m.model === item.model) ? `${item.route}--${item.catalogApi}` : item.route
      const got = validation.doc?.['llm-pi-ai']?.providers?.[routeForModel]?.models?.find?.((m) => m?.id === item.model)?.reasoningEfforts
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
      if (entry.action !== 'insert' && entry.action !== 'replace') continue
      const got = validation.doc?.['llm-pi-ai']?.providers?.[entry.route]?.reasoning
      if (got !== entry.level) validation = { ok: false, reason: `校验失败：\`${entry.route}\` 的 reasoning 读回为 ${String(got)}` }
    }
    if (validation.ok && (agentDefault.action === 'insert' || agentDefault.action === 'replace')) {
      const got = validation.doc?.['agent-default-model']?.reasoningEffort
      if (got !== defaultLevel) validation = { ok: false, reason: `校验失败：agent-default-model.reasoningEffort 读回为 ${String(got)}` }
    }
  }
}

let backupPath
if (doApply && text !== original && validation.ok) {
  backupPath = `${settingsPath}.bak-reasoning-efforts-${stampName()}`
  copyFileSync(settingsPath, backupPath)
  writeFileSync(settingsPath, text, 'utf8')
}

// ---------------------------------------------------------------------- output
const report = buildReport()
if (reportPath !== undefined) {
  const target = resolve(reportPath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, report, 'utf8')
}

if (asJson) {
  console.log(JSON.stringify({
    settings: settingsPath,
    dsh: { root: install.label, version, piAiCatalog: catalog.providers.size, compatGates: gates.available },
    mode: { apply: doApply, fix: doFix, strict: doStrict, fixRoutes: doFixRoutes, probe: doProbe },
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

// A model awaiting a decision is unfinished work, not a success: it must not be
// possible to read a clean exit as "every model is covered". A route whose default
// could not be written counts too — that is the requirement "no Default entry"
// going unmet, and the user is the one who can resolve it (split the route, or
// accept the provider default).
const pending =
  actions.length > 0 ||
  conflicts.length > 0 ||
  undecided.length > 0 ||
  routeDefaults.some((e) => e.action === 'insert' || e.action === 'replace' || e.action === 'conflict' || e.action === 'blocked') ||
  agentDefault.action === 'insert' ||
  agentDefault.action === 'replace' ||
  agentDefault.action === 'conflict'
const broken = failures.length > 0 || !validation.ok
process.exit(broken ? 1 : pending && !doApply ? 1 : 0)
