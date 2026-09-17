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

import { analyzeLine, children, joinText, listRoutes, locateRoute, moveModelItem, createRoute, splitText, upsertReasoningEfforts } from './lib/yaml-edit.mjs'
import {
  THINKING_LEVELS,
  deriveFromCatalog,
  deriveFromOverride,
  findOverride,
  loadOverrides,
  matchCatalogProvider,
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
      evidence: derived.evidence ?? (derived.source === 'catalog' ? 'catalog' : 'unknown'),
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

    if (target === undefined) {
      item.action = 'skip-no-evidence'
      item.note = derived.reason ?? 'no evidence for this model'
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
    if (doStrict && item.action !== 'skip-no-evidence' && item.evidence !== 'probe') {
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
const actions = plan.filter((i) => i.action === 'insert' || i.action === 'replace')
const conflicts = plan.filter((i) => i.action === 'conflict')
const skipped = plan.filter((i) => i.action === 'skip-no-evidence' || i.action === 'skip-strict')

function levelsOf(map) {
  if (map === undefined) return '(无)'
  if (map === false) return '(非推理模型)'
  return THINKING_LEVELS.filter((l) => Object.prototype.hasOwnProperty.call(map, l)).join(' / ')
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
    out.push('| 路线 | 模型 | 现状 | 目标 | 依据 | 动作 |')
    out.push('| --- | --- | --- | --- | --- | --- |')
    for (const item of plan) {
      const actionText =
        item.action === 'insert' ? '**新增声明**'
        : item.action === 'replace' ? '**改写声明**'
        : item.action === 'conflict' ? '冲突（加 `--fix` 才对）'
        : item.action === 'skip-strict' ? '跳过（--strict）'
        : item.action === 'skip-no-evidence' ? '不动（无依据）'
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
    out.push('依据等级：`probe`（实发已证实）＞`vendor`（厂商文档）＞`catalog`（目录声明，网关未实证）＞`unknown`。')
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

  out.push('## 观察与警告')
  out.push('')
  if (warnings.length === 0 && conflicts.length === 0 && skipped.length === 0) out.push('- 无。')
  for (const w of warnings) out.push(`- ${w}`)
  for (const c of conflicts) out.push(`- 冲突：\`${c.route}/${c.model}\` ${c.note}。默认不动，加 \`--fix\` 才对齐。`)
  for (const s of skipped) out.push(`- 未写入：\`${s.route}/${s.model}\`（${s.note}）`)
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
    if (item.action !== 'insert' && item.action !== 'replace') continue
    const routeForModel = moves.some((m) => m.route === item.route && m.model === item.model) ? `${item.route}--${item.catalogApi}` : item.route
    const result = upsertReasoningEfforts(text, routeForModel, item.model, item.target)
    if (result.text !== undefined) text = result.text
    if (result.changed) applied.push(`${result.action === 'inserted' ? '新增' : '改写'} \`${routeForModel}/${item.model}\` → ${levelsOf(item.target)}`)
    else if (!result.unchanged) failures.push(`\`${item.model}\`：${result.reason}`)
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
    const allowed = /^llm-pi-ai\.providers\./
    const stray = changedPaths.filter((p) => !allowed.test(p))
    validation = { ok: stray.length === 0, changedPaths, stray, doc: reparsed }
    if (stray.length > 0) validation.reason = `编辑越界，改到了预期之外的路径：${stray.join(', ')}`
  }
  if (validation.ok) {
    for (const item of plan) {
      if (item.action !== 'insert' && item.action !== 'replace') continue
      const routeForModel = moves.some((m) => m.route === item.route && m.model === item.model) ? `${item.route}--${item.catalogApi}` : item.route
      const got = validation.doc?.['llm-pi-ai']?.providers?.[routeForModel]?.models?.find?.((m) => m?.id === item.model)?.reasoningEfforts
      if (got === undefined) {
        validation = { ok: false, reason: `校验失败：\`${routeForModel}/${item.model}\` 写入后读不到 reasoningEfforts` }
        break
      }
      const gotMap = Object.fromEntries(THINKING_LEVELS.filter((l) => l in got).map((l) => [l, got[l] ?? null]))
      if (!sameEfforts(gotMap, item.target)) {
        validation = { ok: false, reason: `校验失败：\`${routeForModel}/${item.model}\` 读回的值与目标不符` }
        break
      }
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

const pending = actions.length > 0 || conflicts.length > 0
const broken = failures.length > 0 || !validation.ok
process.exit(broken ? 1 : pending && !doApply ? 1 : 0)
