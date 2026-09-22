/**
 * capability.mjs — turn "what the installed pi-ai catalog declares about this
 * model" into the exact `reasoningEfforts` map this provider entry needs.
 *
 * The catalog is the primary source of truth because it *is* the file of record
 * DSH ships: a route named after a catalog provider inherits these values with
 * no configuration at all. This module lets a hand-declared route inherit the
 * same capability explicitly, without inventing anything.
 *
 * Evidence levels, weakest to strongest:
 *   unknown  nothing sources this model — the writer stops and asks
 *   catalog  derived from the installed pi-ai catalog
 *   user     a decision the user recorded in `data/user-decisions.yaml`
 *   vendor   a provider's own documentation, recorded in `data/reasoning-overrides.yaml`
 *   probe    a minimal live request was accepted for this exact model
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeBaseUrl } from './dsh-install.mjs'

/** pi-ai's levels, in escalation order. DSH rejects any other key. */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export const EVIDENCE_RANK = { unknown: 0, catalog: 1, user: 2, vendor: 3, probe: 4 }

/**
 * pi-ai's own rule (`getSupportedThinkingLevels`), including its asymmetry:
 * an absent key means *supported* for off/minimal/low/medium/high but
 * *unsupported* for xhigh/max.
 */
export function supportedLevels(entry) {
  if (entry?.reasoning !== true) return ['off']
  return THINKING_LEVELS.filter((level) => {
    const mapped = entry.thinkingLevelMap?.[level]
    if (mapped === null) return false
    if (level === 'xhigh' || level === 'max') return mapped !== undefined
    return true
  })
}

/**
 * The wire value DSH should send for a level: the catalog's spelling when it has
 * one, and the level's own name when it does not. `off` is special — DSH only
 * allows it to be empty, which means "send no reasoning parameter".
 */
function wireFor(entry, level) {
  const mapped = entry?.thinkingLevelMap?.[level]
  if (typeof mapped === 'string' && mapped.length > 0) return mapped
  return level === 'off' ? null : level
}

/**
 * Derive the declaration for one catalog entry.
 *
 * `declarable: false` means DSH would refuse the map — either the model does not
 * reason at all, or the only offered level is `off` (DSH requires at least one
 * level beyond it). Both cases are reported, never written.
 */
export function deriveFromCatalog(entry) {
  if (entry === undefined) return { reasoning: undefined, levels: [], declarable: false, reason: 'not in catalog' }
  if (entry.reasoning !== true) {
    return { reasoning: false, levels: [], declarable: false, evidence: 'catalog', reason: 'the catalog marks it as non-reasoning' }
  }
  const levels = supportedLevels(entry).map((level) => ({ level, wire: wireFor(entry, level) }))
  const beyondOff = levels.filter((l) => l.level !== 'off')
  if (beyondOff.length === 0) {
    return {
      reasoning: true,
      levels,
      declarable: false,
      reason: 'the catalog offers only "off", which DSH refuses as a declaration',
      source: 'catalog',
    }
  }
  return { reasoning: true, levels, declarable: true, source: 'catalog', evidence: 'catalog' }
}

/** `reasoningEfforts` as plain data: level -> wire string, or null for `off`. */
export function toEffortsMap(levels) {
  const out = {}
  for (const level of THINKING_LEVELS) {
    const hit = levels.find((l) => l.level === level)
    if (hit !== undefined) out[level] = hit.wire
  }
  return out
}

/** Human-facing level list, e.g. `off, low, high, max`. */
export function levelNames(levels) {
  return levels.map((l) => l.level)
}

/** The two patch layers, both under `data/`: cited provider facts, and user decisions. */
export const OVERRIDE_FILES = ['reasoning-overrides.yaml', 'user-decisions.yaml']

/**
 * Load the patch layers. `reasoning-overrides.yaml` holds cited vendor facts;
 * `user-decisions.yaml` holds answers the user gave when nothing could be sourced
 * (see `--decide`). Both are *patch* layers: an entry may only ever add knowledge,
 * and nothing in them is inferred.
 */
export function loadOverrides(yaml, skillDir) {
  const files = []
  const entries = []
  const errors = []
  for (const name of OVERRIDE_FILES) {
    const path = join(skillDir, 'data', name)
    files.push(path)
    if (!existsSync(path)) continue
    let doc
    try {
      doc = yaml.load(readFileSync(path, 'utf8'))
    } catch (error) {
      errors.push(`${name}: ${error.message}`)
      continue
    }
    for (const entry of Array.isArray(doc?.entries) ? doc.entries : []) {
      if (typeof entry === 'object' && entry !== null) entries.push({ ...entry, __file: name })
    }
  }
  return { files, entries, errors }
}

/** Find the override covering this route + model, if any. */
export function findOverride(overrides, { baseURL, routeId, modelId }) {
  const base = normalizeBaseUrl(baseURL)
  return overrides.find((entry) => {
    const match = entry.match ?? {}
    if (match.model !== modelId) return false
    if (match.provider !== undefined && match.provider !== routeId) return false
    if (match.baseURL !== undefined && normalizeBaseUrl(match.baseURL) !== base) return false
    return true
  })
}

/** Turn an override entry into the same shape `deriveFromCatalog` returns. */
export function deriveFromOverride(entry) {
  if (entry?.reasoning !== true) {
    return { reasoning: entry?.reasoning === false ? false : undefined, levels: [], declarable: false, reason: 'override does not declare reasoning' }
  }
  const raw = entry.efforts
  if (typeof raw !== 'object' || raw === null) {
    return { reasoning: true, levels: [], declarable: false, reason: 'override has no efforts map' }
  }
  const levels = THINKING_LEVELS.filter((level) => Object.prototype.hasOwnProperty.call(raw, level)).map((level) => ({
    level,
    wire: raw[level] === null ? null : String(raw[level]),
  }))
  const beyondOff = levels.filter((l) => l.level !== 'off')
  if (beyondOff.length === 0) {
    return { reasoning: true, levels, declarable: false, reason: 'override offers no level beyond "off"' }
  }
  return {
    reasoning: true,
    levels,
    declarable: true,
    source: 'override',
    evidence: entry.evidence ?? 'vendor',
    sourceUrl: entry.source,
    note: entry.note,
  }
}

/**
 * Which catalog provider serves this route? Primary key is the gateway (base
 * URL with `/v1` normalised away), because the same model id can be served
 * differently by two gateways. Falling back to "the only provider that declares
 * every model id on this route" is unambiguous when it applies, and is reported
 * as the weaker match it is.
 */
export function matchCatalogProvider(catalog, profile, modelIds) {
  const base = normalizeBaseUrl(profile?.baseURL)
  if (base !== undefined) {
    const ids = catalog.byBaseUrl.get(base) ?? []
    if (ids.length > 0) {
      // Sorted first, so a tie in the hit count is broken by id instead of by whatever order the
      // catalog directory happened to be read in: two machines — or two runs on one machine — must
      // choose the same provider, or the level sets derived from it would differ.
      const chosen = [...ids]
        .sort((a, b) => (a === b ? 0 : a < b ? -1 : 1))
        .map((id) => ({ id, hits: modelIds.filter((m) => catalog.providers.get(id)?.models.has(m)).length }))
        .sort((a, b) => b.hits - a.hits || (a.id === b.id ? 0 : a.id < b.id ? -1 : 1))[0]
      return { providerId: chosen.id, confidence: 'base-url', alternateIds: ids.filter((id) => id !== chosen.id).sort() }
    }
  }
  const candidates = [...catalog.providers.values()].filter((p) => modelIds.length > 0 && modelIds.every((m) => p.models.has(m)))
  if (candidates.length === 1) return { providerId: candidates[0].id, confidence: 'model-ids' }
  return undefined
}

/**
 * Variants of a catalog id that count as "the same model".
 *
 * Only a *vendor prefix* is stripped, and only when that prefix carries no digits: catalog ids
 * arrive as `minimax/minimax-m2.5`, `minimax.minimax-m2.5` and `MiniMaxAI/MiniMax-M2.5`, where
 * the segment before the separator is a vendor name. Splitting unconditionally would also turn
 * `mimo-v2.6-flash` into `flash`, which would then "match" `glm-5.3-flash` — two unrelated
 * models.
 */
function idVariants(id) {
  const raw = String(id)
  const out = new Set([raw.toLowerCase()])
  for (const separator of ['/', '.']) {
    const at = raw.lastIndexOf(separator)
    if (at <= 0) continue
    const prefix = raw.slice(0, at)
    const rest = raw.slice(at + 1)
    if (/\d/.test(prefix) || rest.length < 3) continue
    out.add(rest.toLowerCase())
  }
  return out
}

/**
 * The same model as *other* catalog providers know it.
 *
 * A custom route frequently carries a model whose exact entry is missing for that
 * gateway while several other providers attest to the same id. That is honest
 * context for the one question this skill refuses to answer on its own, so it is
 * surfaced as candidates — never written, because another provider's limits are
 * not this gateway's limits.
 */
export function siblingCandidates(catalog, modelId, excludeProviderId) {
  const wanted = idVariants(modelId)
  const out = []
  for (const provider of catalog.providers.values()) {
    if (provider.id === excludeProviderId) continue
    for (const [id, entry] of provider.models) {
      const variants = idVariants(id)
      if (![...variants].some((v) => wanted.has(v))) continue
      const derived = deriveFromCatalog(entry)
      out.push({
        providerId: provider.id,
        id,
        api: entry.api,
        reasoning: entry.reasoning === true,
        levels: derived.levels.map((l) => l.level),
        explicitMap: entry.thinkingLevelMap !== undefined,
      })
    }
  }
  // Sorted so the candidate list in the report — and therefore the recommended level sets derived
  // from it — does not depend on catalog iteration order.
  return out.sort((a, b) =>
    (a.providerId === b.providerId ? 0 : a.providerId < b.providerId ? -1 : 1) ||
    (a.id === b.id ? 0 : a.id < b.id ? -1 : 1),
  )
}
