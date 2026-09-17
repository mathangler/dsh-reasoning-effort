#!/usr/bin/env node
/**
 * check-reasoning-route.mjs — inspect how a `llm-pi-ai` route resolves, offline.
 *
 * Strictly read-only. Reports, per route:
 *   - whether the route name is a pi-ai catalog provider (i.e. inherits metadata)
 *     and, if it is not, which catalog provider serves the same base URL
 *   - the effective `api` of every model: route `api` -> catalog entry `api`
 *   - which models would resolve `reasoning: true`, and the levels the picker
 *     would actually offer (declared, inherited, or none)
 *   - each configured `compat` field: which protocols accept it, and whether any
 *     model on the route does — the exact check a strict settings write performs
 *
 * Where this revision differs from the upstream script:
 *   - install discovery derives from the environment and `process.execPath`
 *     *before* any subprocess, so it works on Windows, macOS and Linux, and in a
 *     shell that denies child processes (upstream shelled out first, and could
 *     exit 2 for a sandbox reason that had nothing to do with the config);
 *   - the compat gates are read with a brace-aware scanner and a `withhold`
 *     distinction, and when they cannot be read the script says **cannot be
 *     checked** instead of emitting a confident wrong verdict;
 *   - inherited levels use pi-ai's real rule, including its asymmetry (an absent
 *     map key is *supported* for off/minimal/low/medium/high but *unsupported*
 *     for xhigh/max), where upstream reported absent keys as offered.
 *
 * Exit codes: 0 no structural problem, 1 problem(s) found, 2 environment unreadable.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { THINKING_LEVELS, deriveFromCatalog, findOverride, loadOverrides, matchCatalogProvider, supportedLevels } from './lib/capability.mjs'
import { defaultSettingsPath, dshVersion, findInstall, loadCatalog, loadCompatGates, loadYaml } from './lib/dsh-install.mjs'
import { listRoutes, splitText } from './lib/yaml-edit.mjs'

const SKILL_DIR = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)
const flagValue = (name, fallback) => {
  const i = argv.indexOf(name)
  return i === -1 ? fallback : argv[i + 1]
}
const has = (name) => argv.includes(name)

if (has('--help') || has('-h')) {
  console.log(`usage: node check-reasoning-route.mjs [--route <name>] [--settings <path>] [--dsh-root <path>] [--json]

  --route     only report this route (default: every route under llm-pi-ai.providers)
  --settings  settings document to read (default: $DSH_HOME/settings.yaml)
  --dsh-root  dsh install root holding node_modules (default: discovered)
  --json      machine-readable output

Env: DSH_ROOT supplies the dsh root; DSH_NO_SUBPROCESS=1 skips the where/which fallback.`)
  process.exit(0)
}

const settingsPath = flagValue('--settings', defaultSettingsPath())
const wantRoute = flagValue('--route', undefined)
if (!existsSync(settingsPath)) {
  console.error(`settings document not found: ${settingsPath}`)
  process.exit(2)
}

const install = findInstall(flagValue('--dsh-root', undefined))
const yaml = loadYaml([dirname(settingsPath), SKILL_DIR])
if (yaml === undefined) {
  console.error('could not load js-yaml (it ships with DSH; point --settings at a directory that can reach it)')
  process.exit(2)
}
if (install.piAiDist === undefined) {
  console.error('could not locate the dsh install; pass --dsh-root <path containing node_modules>')
  for (const line of install.scanned) console.error(`  tried ${line}`)
  process.exit(2)
}

const text = readFileSync(settingsPath, 'utf8')
let doc
try {
  doc = yaml.load(text)
} catch (error) {
  console.error(`settings document does not parse: ${error.message}`)
  process.exit(2)
}

const catalog = loadCatalog(install.piAiDist)
const gates = loadCompatGates(install)
const overrides = loadOverrides(yaml, SKILL_DIR)
const catalogProviderIds = new Set(catalog.providers.keys())
const routes = listRoutes(splitText(text).lines).filter((r) => wantRoute === undefined || r.id === wantRoute)

const report = {
  settings: settingsPath,
  dsh: { root: install.label, version: dshVersion(install), piAiCatalog: catalog.providers.size, compatGates: gates.available },
  routes: [],
  problems: [],
  notices: [],
}

if (!gates.available) {
  report.problems.push(`compat gates unavailable (${gates.reason}) — compat fields are reported as "cannot be checked", never as unsettable`)
}

for (const route of routes) {
  const profile = doc?.['llm-pi-ai']?.providers?.[route.id] ?? {}
  const isCatalogRoute = catalogProviderIds.has(route.id)
  const match = isCatalogRoute ? { providerId: route.id, confidence: 'base-url' } : matchCatalogProvider(catalog, { baseURL: route.baseURL }, route.modelIds)
  const catalogProvider = match === undefined ? undefined : catalog.providers.get(match.providerId)
  const entry = {
    route: route.id,
    declared: !isCatalogRoute,
    api: route.api,
    baseURL: route.baseURL,
    catalogProvider: match?.providerId,
    catalogMatchConfidence: match?.confidence,
    models: [],
    compat: [],
  }

  for (const modelId of route.modelIds) {
    const base = catalogProvider?.models.get(modelId)
    const declaredModel = (profile.models ?? []).find((m) => m?.id === modelId) ?? {}
    const declaredMap = declaredModel.reasoningEfforts
    const override = findOverride(overrides.entries, { baseURL: route.baseURL, routeId: route.id, modelId })
    const api = route.api ?? base?.api
    const problems = []

    let offered
    let reasoning
    let source
    if (declaredMap === false) {
      offered = []
      reasoning = false
      source = 'declared-false'
    } else if (declaredMap !== undefined && declaredMap !== null) {
      offered = THINKING_LEVELS.filter((l) => Object.prototype.hasOwnProperty.call(declaredMap, l))
      reasoning = true
      source = 'declared'
      for (const [level, wire] of Object.entries(declaredMap)) {
        if (!THINKING_LEVELS.includes(level)) problems.push(`unknown level "${level}" (allowed: ${THINKING_LEVELS.join(', ')})`)
        else if (level !== 'off' && (typeof wire !== 'string' || wire.length === 0)) problems.push(`level "${level}" needs a non-empty wire value`)
      }
      if (!offered.some((l) => l !== 'off')) problems.push('offers no level beyond "off"; declare a thinking level or set false')
    } else if (override !== undefined) {
      const derived = deriveFromCatalog(undefined)
      const fromOverride = override.reasoning === true && typeof override.efforts === 'object' && override.efforts !== null
        ? { reasoning: true, levels: THINKING_LEVELS.filter((l) => l in override.efforts).map((l) => ({ level: l })) }
        : derived
      offered = (fromOverride.levels ?? []).map((l) => l.level)
      reasoning = fromOverride.reasoning ?? false
      source = 'overrides-file (not yet written to settings)'
    } else if (base !== undefined) {
      offered = supportedLevels(base)
      reasoning = base.reasoning === true
      source = 'catalog'
    } else {
      offered = []
      reasoning = false
      source = 'none'
      // A known-unknown, not a structural defect: nothing sources this model, so
      // nothing can be declared for it. Reported as a notice so that the exit
      // code keeps meaning "the configuration is broken".
      report.notices.push({ route: route.id, model: modelId, text: 'no catalog entry, no override and no declared reasoningEfforts — this model exposes no effort levels' })
    }

    entry.models.push({ id: modelId, api, reasoning, offered, source, problems, catalogApi: base?.api })
    for (const p of problems) report.problems.push(`route "${route.id}" model "${modelId}": ${p}`)
  }

  // Route-level compat: a strict write rejects the route when NO model speaks a
  // protocol that takes the field.
  for (const field of Object.keys(profile.compat ?? {})) {
    const offeredOn = gates.offers.get(field)
    const withheldOn = gates.withholds.get(field)
    if (!gates.available) {
      entry.compat.push({ field, verdict: 'cannot be checked (gates unavailable)' })
      continue
    }
    if (offeredOn === undefined) {
      entry.compat.push({ field, verdict: withheldOn === undefined ? 'not a known compat field' : 'withheld: catalog-only, DSH refuses it from settings.yaml' })
      report.problems.push(`route "${route.id}": compat "${field}" is ${withheldOn === undefined ? 'not a known compat field' : 'catalog-only (withheld)'}`)
      continue
    }
    const matched = entry.models.some((m) => m.api !== undefined && offeredOn.includes(m.api))
    entry.compat.push({ field, protocols: offeredOn, matched })
    if (!matched) {
      report.problems.push(`route "${route.id}": compat "${field}" has no model on a protocol that takes it (${offeredOn.join(', ')}) — a strict write rejects the whole route`)
    }
  }

  // Model-level compat is a hard error when the model's protocol does not take it.
  for (const model of profile.models ?? []) {
    for (const field of Object.keys(model?.compat ?? {})) {
      const offeredOn = gates.offers.get(field)
      const api = route.api ?? catalogProvider?.models.get(model?.id)?.api
      if (!gates.available) continue
      if (offeredOn === undefined || !offeredOn.includes(api)) {
        report.problems.push(`route "${route.id}" model "${model?.id}": compat "${field}" is not accepted on protocol "${api ?? '(unresolved)'}" — this fails resolution`)
      }
    }
  }

  report.routes.push(entry)
}

const deepseekSection = doc?.['llm-deepseek']
const deepseekNote = deepseekSection === undefined
  ? undefined
  : { section: 'llm-deepseek', provider: 'deepseek-official', levels: ['off', 'low', 'high', 'max'], note: 'built-in adapter; fixed four levels, never per-model' }

if (has('--json')) {
  console.log(JSON.stringify({ ...report, deepseek: deepseekNote }, null, 2))
} else {
  console.log(`settings    : ${settingsPath}`)
  console.log(`dsh install : ${install.label}${dshVersion(install) === undefined ? '' : ` (dsh ${dshVersion(install)})`}`)
  console.log(`pi-ai       : ${catalog.providers.size} catalog providers`)
  console.log(`compat gates: ${gates.available ? `parsed (${gates.gatesFound} gate literals)` : `UNAVAILABLE — ${gates.reason}`}`)
  if (routes.length === 0) console.log('\nno routes configured under llm-pi-ai.providers')

  for (const r of report.routes) {
    console.log(`\n${'='.repeat(72)}\nroute: ${r.route}`)
    console.log(`  route kind        : ${r.declared ? 'hand-declared (catalog knows no provider by this name)' : 'catalog route (inherits metadata)'}`)
    console.log(`  route api         : ${r.api ?? '(absent)'}`)
    if (r.baseURL !== undefined) console.log(`  baseURL           : ${r.baseURL}`)
    if (r.catalogProvider !== undefined && r.declared) {
      console.log(`  catalog provider  : ${r.catalogProvider} ${r.catalogMatchConfidence === 'model-ids' ? '(weak match: by model ids, no baseURL match)' : '(same base URL)'}`)
    } else if (r.declared) {
      console.log('  catalog provider  : none matches this base URL — every field is hand-written')
    }
    for (const m of r.models) {
      console.log(`  - ${m.id}`)
      console.log(`      api       : ${m.api ?? 'NONE  <-- compat fields cannot be matched'}`)
      console.log(`      reasoning : ${m.reasoning === true ? 'true' : 'false'}`)
      console.log(`      offered   : ${m.offered.length > 0 ? m.offered.join(', ') : '(none — the picker shows no effort levels)'}`)
      console.log(`      levels via: ${m.source}`)
      if (m.catalogApi !== undefined && m.api !== undefined && m.catalogApi !== m.api) {
        console.log(`      NOTE      : the catalog serves this model over "${m.catalogApi}", this route uses "${m.api}" — the gateway splits by path`)
      }
    }
    for (const c of r.compat) {
      if (c.verdict !== undefined) console.log(`  compat "${c.field}": ${c.verdict}`)
      else console.log(`  compat "${c.field}": protocols ${c.protocols.join(', ')} -> ${c.matched ? 'matched' : 'NO MODEL ON THIS ROUTE TAKES IT  <-- strict write rejects the whole route'}`)
    }
  }

  if (deepseekNote !== undefined) {
    console.log(`\nbuilt-in: ${deepseekNote.section} (provider ${deepseekNote.provider}) — levels ${deepseekNote.levels.join('/')}; never per-model, never written by this skill`)
  }

  console.log(`\n${'='.repeat(72)}`)
  if (report.notices.length > 0) {
    console.log(`${report.notices.length} notice(s) — nothing to fix, nothing declarable:`)
    for (const n of report.notices) console.log(`  - ${n.route}/${n.model}: ${n.text}`)
  }
  if (report.problems.length === 0) {
    console.log('OK: no structural problem found. Levels still need a live check — a listed level can be')
    console.log('    rejected by the adapter, and only a real request proves the gateway honours it.')
  } else {
    console.log(`${report.problems.length} problem(s):`)
    for (const p of report.problems) console.log(`  - ${p}`)
  }
  console.log('\nTo change a hand-declared route, use scripts/apply-reasoning-efforts.mjs (dry run by default).')
}

process.exit(report.problems.length === 0 ? 0 : 1)
