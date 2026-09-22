/**
 * yaml-edit.mjs — a line-level editor for a DSH profile patch
 * (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`).
 *
 * Surgical on purpose. The patch is a hand-maintained document: DSH's own writer patches
 * individual nodes so that comments, anchors and formatting survive, and a full parse-and-dump
 * round trip does not (a real example of the damage is the flow-styled, misindented
 * `settings.yaml.bak-efforts` left behind by a naive writer). Everything here therefore works on
 * the original text and only ever inserts, replaces or removes whole line ranges that it located
 * by indentation — untouched lines are written back byte for byte.
 *
 * Shape: a top-level sequence of loader entries, `- id: <entry>` / `name:` / `config:`. The
 * provider configuration lives in the `llm-pi-ai` row at `config.providers.<route>`.
 */
import { THINKING_LEVELS } from './capability.mjs'

export function splitText(text) {
  // A byte-order mark is not part of the first key, and `\s` in the key regex would count it as
  // indentation — one line deeper than every other line, which silently hides the whole document.
  // It is carried separately and written back, so the file keeps whatever encoding it had.
  const bom = text.charCodeAt(0) === 0xfeff
  const content = bom ? text.slice(1) : text
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const finalNewline = content.endsWith('\n')
  const body = finalNewline ? content.slice(0, -1) : content
  return { lines: body.split(/\r?\n/), eol, finalNewline, bom }
}

export function joinText({ lines, eol, finalNewline, bom }) {
  return (bom === true ? '\ufeff' : '') + lines.join(eol) + (finalNewline ? eol : '')
}

const KEY_LINE = /^(\s*)(?:-\s+)?("[^"]+"|'[^']+'|[A-Za-z0-9_.\-$]+)\s*:(.*)$/

/** `{ indent, key, value, itemIndent? }` for a mapping key or sequence item. */
export function analyzeLine(line) {
  const item = /^(\s*)-\s+(.*)$/.exec(line)
  if (item !== null) {
    const inner = KEY_LINE.exec(item[2])
    if (inner === null) return { indent: item[1].length, itemIndent: item[1].length, key: undefined }
    return {
      indent: item[1].length + 2,
      itemIndent: item[1].length,
      key: unquote(inner[2]),
      value: inner[3].trim(),
    }
  }
  const m = KEY_LINE.exec(line)
  if (m === null) return { indent: line.length - line.trimStart().length, key: undefined }
  return { indent: m[1].length, key: unquote(m[2]), value: m[3].trim() }
}

function unquote(raw) {
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) return raw.slice(1, -1)
  return raw
}

function isBlank(line) {
  return line.trim().length === 0 || line.trimStart().startsWith('#')
}

/** Exclusive end of the block owned by a key line at `indent`. */
export function blockEnd(lines, keyLine, indent) {
  let i = keyLine + 1
  for (; i < lines.length; i++) {
    if (isBlank(lines[i])) continue
    const info = analyzeLine(lines[i])
    const effective = info.itemIndent === undefined ? info.indent : info.itemIndent
    if (effective <= indent) break
  }
  return i
}

/** Direct children (mapping keys and sequence items) of `[start, end)`. */
export function children(lines, start, end) {
  const out = []
  let i = start
  while (i < end) {
    const line = lines[i]
    if (isBlank(line)) {
      i++
      continue
    }
    const info = analyzeLine(line)
    const effective = info.itemIndent === undefined ? info.indent : info.itemIndent
    const childIndent = out.length === 0 ? effective : out[0].effectiveIndent
    const stop = blockEnd(lines, i, effective)
    out.push({ keyLine: i, start: i, end: stop, indent: info.indent, effectiveIndent: effective, key: info.key, value: info.value, raw: line })
    i = stop >= childIndent ? Math.max(stop, i + 1) : i + 1
  }
  return out
}

function childIndentOf(lines, start, end) {
  for (let i = start; i < end; i++) {
    if (isBlank(lines[i])) continue
    const info = analyzeLine(lines[i])
    return info.itemIndent === undefined ? info.indent : info.itemIndent
  }
  return undefined
}

/** The key `[start, end)` block owned by `key`, as the block's first direct child. */
export function childByKey(lines, start, end, key) {
  const indent = childIndentOf(lines, start, end)
  if (indent === undefined) return undefined
  for (const child of children(lines, start, end)) {
    if (child.effectiveIndent === indent && child.key === key) return child
  }
  return undefined
}

/**
 * The `llm-pi-ai` row of a DSH *profile patch* document.
 *
 * DSH 0.1.7 keeps settings in `$DSH_HOME/profiles/<profile>/cordis.patch.yml`, a top-level
 * **sequence** of loader entries (`- id: <entry>` / `name:` / `config:`). That file replaced
 * `settings.yaml`, which 0.1.7 imports once and then renames, so the provider configuration now
 * sits at `[<the llm-pi-ai row>].config.providers.<route>` — one level deeper than the old
 * top-level `llm-pi-ai.providers.<route>`. Every locator below goes through here, so the rest of
 * the editor never has to know which shape it is looking at.
 */
export function locatePatchEntry(lines, entryId) {
  const entries = children(lines, 0, lines.length)
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    const onItem = analyzeLine(lines[entry.start])
    if (onItem.key !== 'id' || onItem.value.replace(/["']/g, '') !== entryId) continue
    // `keyLine + 1`, not `keyLine`: `children()` measures indentation from the lines *inside* a
    // block, and the item line itself (`- id: …`) sits one level out.
    return { index, entry, id: entryId, config: childByKey(lines, entry.start + 1, entry.end, 'config') }
  }
  return undefined
}

/** The `providers` mapping inside the `llm-pi-ai` row (`undefined` when the row has no config). */
export function locateProvidersBlock(lines, entryId = 'llm-pi-ai') {
  const found = locatePatchEntry(lines, entryId)
  if (found === undefined) return undefined
  if (found.config === undefined) return { ...found, providers: undefined }
  return { ...found, providers: childByKey(lines, found.config.start + 1, found.config.end, 'providers') }
}

/** The `providers` map of an already-parsed profile patch document (same lookup, on data). */
export function providersOf(doc, entryId = 'llm-pi-ai') {
  for (const row of Array.isArray(doc) ? doc : []) {
    if (row !== null && typeof row === 'object' && row.id === entryId) return row?.config?.providers
  }
  return undefined
}

/** The `config` object of an already-parsed patch entry, e.g. `agent-default-model`. */
export function entryConfigOf(doc, entryId) {
  for (const row of Array.isArray(doc) ? doc : []) {
    if (row !== null && typeof row === 'object' && row.id === entryId) return row?.config
  }
  return undefined
}

/**
 * `{ keyLine, start, end, models, routeIndent }` for a route under the `llm-pi-ai` row's
 * `config.providers`, or `undefined` when the document does not have it.
 */
export function locateRoute(lines, routeId) {
  const block = locateProvidersBlock(lines)
  const providers = block?.providers
  if (providers === undefined) return undefined
  const indent = childIndentOf(lines, providers.keyLine + 1, providers.end)
  if (indent === undefined) return undefined
  for (const child of children(lines, providers.keyLine + 1, providers.end)) {
    if (child.effectiveIndent === indent && child.key === routeId) {
      const models = childByKey(lines, child.keyLine + 1, child.end, 'models')
      return { keyLine: child.keyLine, start: child.start, end: child.end, routeIndent: indent, models, providers }
    }
  }
  return undefined
}

/** The sequence item whose `id:` is `modelId`, inside a route's `models` block. */
export function locateModelItem(lines, route, modelId) {
  if (route?.models === undefined) return undefined
  const indent = childIndentOf(lines, route.models.keyLine + 1, route.models.end)
  if (indent === undefined) return undefined
  for (const item of children(lines, route.models.keyLine + 1, route.models.end)) {
    if (item.effectiveIndent !== indent) continue
    // `- id: x` puts the id on the item line itself; `- name: ...` + `id:` later also occurs.
    const onItem = analyzeLine(lines[item.start])
    if (onItem.key === 'id' && onItem.value.replace(/["']/g, '') === modelId) return item
    const idChild = childByKey(lines, item.start, item.end, 'id')
    if (idChild !== undefined && /^["']?([^"']+)["']?$/.test(idChild.value) && idChild.value.replace(/["']/g, '') === modelId) {
      return item
    }
  }
  return undefined
}

function scalar(value) {
  return /^[A-Za-z0-9_.\-]+$/.test(value) ? value : JSON.stringify(value)
}

/**
 * Render the declaration as the block style DSH itself writes. `false` renders a
 * single line, because a model that does not reason is a decision worth stating.
 */
export function renderEfforts(fieldIndent, efforts) {
  const pad = ' '.repeat(fieldIndent)
  if (efforts === false) return [`${pad}reasoningEfforts: false`]
  const inner = ' '.repeat(fieldIndent + 2)
  const lines = [`${pad}reasoningEfforts:`]
  for (const level of THINKING_LEVELS) {
    if (!Object.prototype.hasOwnProperty.call(efforts, level)) continue
    const wire = efforts[level]
    lines.push(`${inner}${level}: ${wire === null ? 'null' : scalar(String(wire))}`)
  }
  return lines
}

function sameBlock(lines, start, end, rendered) {
  const current = lines.slice(start, end).filter((l) => !isBlank(l)).map((l) => l.trim())
  const wanted = rendered.map((l) => l.trim())
  return current.length === wanted.length && current.every((l, i) => l === wanted[i])
}

function trimTrailingBlank(lines, start, end) {
  let stop = end
  while (stop > start && isBlank(lines[stop - 1])) stop--
  return stop
}

/**
 * Ensure `models[<modelId>].reasoningEfforts` is exactly `efforts`.
 *
 * `efforts` is either a `{ level: wire }` object (with `null` allowed only for
 * `off`) or `false`, which declares a non-reasoning model explicitly so that the
 * capability never rests on a field's absence.
 *
 * Idempotent: a declaration that already matches produces no change. A flow-style
 * map (`reasoningEfforts: { ... }`) on a single line is replaced wholesale.
 */
export function upsertReasoningEfforts(text, routeId, modelId, efforts) {
  const parts = splitText(text)
  const { lines } = parts
  const route = locateRoute(lines, routeId)
  if (route === undefined) return { changed: false, reason: `route "${routeId}" not found in the llm-pi-ai row's providers` }
  if (route.models === undefined) return { changed: false, reason: `route "${routeId}" has no "models" list` }
  const item = locateModelItem(lines, route, modelId)
  if (item === undefined) return { changed: false, reason: `model "${modelId}" not found on route "${routeId}"` }

  // Fields live one level inside the sequence item: for `- id: x` the item line
  // already carries a key, so the field indent is the key's indent, not the
  // dash's. (Using the dash indent here is exactly the bug that produced a
  // `bad indentation of a mapping entry` document.)
  const fieldIndent = item.indent
  const rendered = renderEfforts(fieldIndent, efforts)

  const header = /^\s*reasoningEfforts\s*:/.exec(lines[item.start])
  let existing
  for (let i = item.start; i < item.end; i++) {
    if (/^\s*reasoningEfforts\s*:/.test(lines[i])) {
      existing = { start: i, end: /\{/.test(lines[i]) ? i + 1 : blockEnd(lines, i, analyzeLine(lines[i]).indent) }
      break
    }
  }

  if (existing !== undefined) {
    if (sameBlock(lines, existing.start, existing.end, rendered)) return { changed: false, reason: 'already correct', unchanged: true }
    lines.splice(existing.start, existing.end - existing.start, ...rendered)
    return { changed: true, text: joinText(parts), action: 'replaced', itemIndent: fieldIndent }
  }

  const at = trimTrailingBlank(lines, item.start, item.end)
  lines.splice(at, 0, ...rendered)
  return { changed: true, text: joinText(parts), action: 'inserted', itemIndent: fieldIndent }
}

/** Remove a model entry from a route. Refuses to empty the list. */
export function removeModelItem(text, routeId, modelId) {
  const parts = splitText(text)
  const { lines } = parts
  const route = locateRoute(lines, routeId)
  const item = route === undefined ? undefined : locateModelItem(lines, route, modelId)
  if (route === undefined || item === undefined) return { changed: false, reason: 'model not found' }
  const indent = childIndentOf(lines, route.models.keyLine + 1, route.models.end)
  const siblings = children(lines, route.models.keyLine + 1, route.models.end).filter((c) => c.effectiveIndent === indent)
  if (siblings.length <= 1) return { changed: false, reason: `refusing to empty the model list on route "${routeId}"` }
  const stop = trimTrailingBlank(lines, item.start, item.end)
  const removed = lines.splice(item.start, stop - item.start)
  return { changed: true, text: joinText(parts), removed, removedCount: removed.length }
}

/** Move a model entry verbatim onto another route, re-indenting as needed. */
export function moveModelItem(text, fromRouteId, toRouteId, modelId) {
  const parts = splitText(text)
  const lines = parts.lines
  const from = locateRoute(lines, fromRouteId)
  const item = from === undefined ? undefined : locateModelItem(lines, from, modelId)
  if (item === undefined) return { changed: false, reason: `model "${modelId}" not found on route "${fromRouteId}"` }
  const stop = trimTrailingBlank(lines, item.start, item.end)
  const block = lines.slice(item.start, stop)
  const extracted = removeModelItem(joinText(parts), fromRouteId, modelId)
  if (!extracted.changed) return extracted

  const appended = appendModelItem(extracted.text, toRouteId, block)
  if (!appended.changed) return appended
  return { changed: true, text: appended.text, action: 'moved' }
}

/** Append a model entry (lines from elsewhere) to a route's `models` list. */
export function appendModelItem(text, routeId, blockLines) {
  const parts = splitText(text)
  const { lines } = parts
  const route = locateRoute(lines, routeId)
  if (route === undefined) return { changed: false, reason: `route "${routeId}" not found` }
  if (route.models === undefined) return { changed: false, reason: `route "${routeId}" has no "models" list` }
  const indent = childIndentOf(lines, route.models.keyLine + 1, route.models.end) ?? route.models.indent + 2
  const at = trimTrailingBlank(lines, route.models.keyLine + 1, route.models.end)
  lines.splice(at, 0, ...reindent(blockLines, indent))
  return { changed: true, text: joinText(parts) }
}

/**
 * Create a route under the `llm-pi-ai` row's `config.providers`, copying the credential and
 * display name from an existing route so the new one authenticates identically.
 */
export function createRoute(text, routeId, { api, baseURL, apiKeyEnv, displayName, modelBlock }) {
  const parts = splitText(text)
  const { lines } = parts
  const located = locateProvidersBlock(lines)
  if (located === undefined) return { changed: false, reason: 'no patch entry with id "llm-pi-ai"' }
  const providers = located.providers
  if (providers === undefined) return { changed: false, reason: 'the "llm-pi-ai" entry has no config.providers' }
  const indent = childIndentOf(lines, providers.keyLine + 1, providers.end)
  if (providers === undefined) return { changed: false, reason: 'the "llm-pi-ai" row has an empty config.providers' }
  if (locateRoute(lines, routeId) !== undefined) return { changed: false, reason: `route "${routeId}" already exists` }

  const pad = ' '.repeat(indent)
  const inner = ' '.repeat(indent + 2)
  const modelIndent = ' '.repeat(indent + 4)
  const fields = []
  if (displayName !== undefined) fields.push(`${inner}displayName: ${JSON.stringify(displayName)}`)
  if (apiKeyEnv !== undefined) fields.push(`${inner}apiKeyEnv: ${apiKeyEnv}`)
  if (baseURL !== undefined) fields.push(`${inner}baseURL: ${baseURL}`)
  if (api !== undefined) fields.push(`${inner}api: ${api}`)
  const block = [`${pad}${routeId}:`, ...fields, `${inner}models:`]
  for (const line of reindent(modelBlock, modelIndent)) block.push(line)

  const at = trimTrailingBlank(lines, providers.keyLine + 1, providers.end)
  lines.splice(at, 0, ...block)
  return { changed: true, text: joinText(parts), indent }
}

/** Remove a scalar field from a route block. */
export function removeRouteScalar(text, routeId, key) {
  const parts = splitText(text)
  const { lines } = parts
  const route = locateRoute(lines, routeId)
  if (route === undefined) return { changed: false, reason: `route "${routeId}" not found` }
  const fieldIndent = childIndentOf(lines, route.keyLine + 1, route.end) ?? route.routeIndent + 2
  return removeChildScalar(parts, route.keyLine, route.end, fieldIndent, key)
}

/**
 * Remove a scalar field from a patch entry's `config` block, e.g.
 * `- id: agent-default-model` → `config.reasoningEffort`.
 *
 * Needed for the one destructive repair outside a route: a global default the configured
 * default model cannot accept makes the first request of every new session fail.
 */
export function removePatchConfigScalar(text, entryId, key) {
  const parts = splitText(text)
  const { lines } = parts
  const found = locatePatchEntry(lines, entryId)
  if (found === undefined) return { changed: false, reason: `no patch entry with id "${entryId}"` }
  if (found.config === undefined) return { changed: false, reason: `patch entry "${entryId}" has no config block` }
  const indent = childIndentOf(lines, found.config.keyLine + 1, found.config.end)
  if (indent === undefined) {
    // A flow-style `config: { … }` on one line has no lines to edit. Refusing loudly beats
    // guessing: the caller reports it instead of leaving a value that still breaks requests.
    return { changed: false, reason: `patch entry "${entryId}" has a single-line config; cannot remove ${key} in place` }
  }
  return removeChildScalar(parts, found.config.keyLine, found.config.end, indent, key)
}

function removeChildScalar(parts, blockStart, blockStop, indent, key) {
  const { lines } = parts
  for (let i = blockStart + 1; i < blockStop; i++) {
    const info = analyzeLine(lines[i])
    if (info.itemIndent !== undefined || info.indent !== indent || info.key !== key) continue
    const stop = /[{[]/.test(lines[i]) ? i + 1 : blockEnd(lines, i, indent)
    lines.splice(i, stop - i)
    return { changed: true, text: joinText(parts), action: 'removed' }
  }
  return { changed: false, reason: `${key} is not set`, unchanged: true }
}

/**
 * Re-anchor a block of lines to a new first-line indent, keeping the relative indentation of
 * everything under it. Flattening each line with `trimStart()` first would drop a sequence item's
 * fields onto the dash line, which YAML reads as a bad mapping entry.
 */
export function reindent(blockLines, indent) {
  if (blockLines.length === 0) return []
  const first = blockLines[0]
  const base = first.length - first.trimStart().length
  const delta = indent - base
  if (delta === 0) return [...blockLines]
  return blockLines.map((line) => {
    if (line.trim().length === 0) return line
    if (delta > 0) return ' '.repeat(delta) + line
    const leading = line.length - line.trimStart().length
    return line.slice(Math.min(-delta, leading))
  })
}

/** Every route under the `llm-pi-ai` row's `config.providers`, as `{ id, api, baseURL, modelIds }`. */
export function listRoutes(lines) {
  const providers = locateProvidersBlock(lines)?.providers
  if (providers === undefined) return []
  const indent = childIndentOf(lines, providers.keyLine + 1, providers.end)
  if (indent === undefined) return []
  const out = []
  for (const child of children(lines, providers.keyLine + 1, providers.end)) {
    if (child.effectiveIndent !== indent || child.key === undefined) continue
    const api = childByKey(lines, child.keyLine + 1, child.end, 'api')
    const baseURL = childByKey(lines, child.keyLine + 1, child.end, 'baseURL')
    const apiKeyEnv = childByKey(lines, child.keyLine + 1, child.end, 'apiKeyEnv')
    const displayName = childByKey(lines, child.keyLine + 1, child.end, 'displayName')
    const models = childByKey(lines, child.keyLine + 1, child.end, 'models')
    const modelIds = []
    if (models !== undefined) {
      for (const item of children(lines, models.keyLine + 1, models.end)) {
        const onItem = analyzeLine(lines[item.start])
        if (onItem.key === 'id') modelIds.push(onItem.value.replace(/["']/g, ''))
        else {
          const idChild = childByKey(lines, item.start, item.end, 'id')
          if (idChild !== undefined) modelIds.push(idChild.value.replace(/["']/g, ''))
        }
      }
    }
    out.push({
      id: child.key,
      api: api?.value,
      baseURL: baseURL?.value,
      apiKeyEnv: apiKeyEnv?.value,
      displayName: displayName?.value,
      modelIds,
      keyLine: child.keyLine,
      start: child.start,
      end: child.end,
    })
  }
  return out
}
