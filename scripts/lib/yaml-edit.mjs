/**
 * yaml-edit.mjs — a line-level editor for `settings.yaml`.
 *
 * Surgical on purpose. `settings.yaml` is a hand-maintained document: DSH's own
 * writer patches individual nodes so that comments, anchors and formatting
 * survive, and a full parse-and-dump round trip does not (a real example of the
 * damage is the flow-styled, misindented `settings.yaml.bak-efforts` left behind
 * by a naive writer). Everything here therefore works on the original text and
 * only ever inserts, replaces or removes whole line ranges that it located by
 * indentation — untouched lines are written back byte for byte.
 */
import { THINKING_LEVELS } from './capability.mjs'

export function splitText(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const finalNewline = text.endsWith('\n')
  const body = finalNewline ? text.slice(0, -1) : text
  return { lines: body.split(/\r?\n/), eol, finalNewline }
}

export function joinText({ lines, eol, finalNewline }) {
  return lines.join(eol) + (finalNewline ? eol : '')
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
 * `{ keyLine, start, end, models, routeIndent }` for a route under
 * `llm-pi-ai.providers`, or `undefined` when the document does not have it.
 */
export function locateRoute(lines, routeId) {
  const top = childByKey(lines, 0, lines.length, 'llm-pi-ai')
  if (top === undefined) return undefined
  const providers = childByKey(lines, top.keyLine + 1, top.end, 'providers')
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
  if (route === undefined) return { changed: false, reason: `route "${routeId}" not found as a direct child of llm-pi-ai.providers` }
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
  const indent = childIndentOf(lines, route.models.keyLine + 1, route.models.end)
  if (indent === undefined) return { changed: false, reason: `route "${routeId}" has an empty "models" list` }
  const at = trimTrailingBlank(lines, route.models.keyLine + 1, route.models.end)
  lines.splice(at, 0, ...blockLines.map((line) => ' '.repeat(indent) + line.trimStart()))
  return { changed: true, text: joinText(parts) }
}

/**
 * Create a route under `llm-pi-ai.providers`, copying the credential and
 * display name from an existing route so the new one authenticates identically.
 */
export function createRoute(text, routeId, { api, baseURL, apiKeyEnv, displayName, modelBlock }) {
  const parts = splitText(text)
  const { lines } = parts
  const top = childByKey(lines, 0, lines.length, 'llm-pi-ai')
  const providers = top === undefined ? undefined : childByKey(lines, top.keyLine + 1, top.end, 'providers')
  if (providers === undefined) return { changed: false, reason: 'llm-pi-ai.providers not found' }
  const indent = childIndentOf(lines, providers.keyLine + 1, providers.end)
  if (indent === undefined) return { changed: false, reason: 'llm-pi-ai.providers is empty' }
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
  for (const line of modelBlock) block.push(`${modelIndent}${line.trimStart()}`)

  const at = trimTrailingBlank(lines, providers.keyLine + 1, providers.end)
  lines.splice(at, 0, ...block)
  return { changed: true, text: joinText(parts), indent }
}

/**
 * Set a scalar field belonging to a route block, e.g. `reasoning: high`.
 *
 * This is the only knob that produces a `defaultEffort`, and a defined
 * `defaultEffort` is what removes the picker's "Default" entry — see SKILL.md.
 * It is inserted before `models:` so the route still reads top-down.
 */
export function upsertRouteScalar(text, routeId, key, value) {
  const parts = splitText(text)
  const { lines } = parts
  const route = locateRoute(lines, routeId)
  if (route === undefined) return { changed: false, reason: `route "${routeId}" not found` }
  // The route's own key sits at `routeIndent`; its fields are one level deeper.
  const fieldIndent = childIndentOf(lines, route.keyLine + 1, route.end) ?? route.routeIndent + 2
  return upsertChildScalar(parts, route.keyLine, route.end, fieldIndent, key, value, 'models')
}

/** Set a scalar field inside a top-level namespace block, e.g. `agent-default-model`. */
export function upsertNamespaceScalar(text, namespace, key, value) {
  const parts = splitText(text)
  const { lines } = parts
  const ns = childByKey(lines, 0, lines.length, namespace)
  if (ns === undefined) return { changed: false, reason: `namespace "${namespace}" not found` }
  const indent = childIndentOf(lines, ns.keyLine + 1, ns.end)
  if (indent === undefined) return { changed: false, reason: `namespace "${namespace}" has no fields to sit beside` }
  return upsertChildScalar(parts, ns.keyLine, ns.end, indent, key, value)
}

function upsertChildScalar(parts, blockStart, blockStop, indent, key, value, beforeKey) {
  const { lines } = parts
  const wanted = `${key}: ${value}`
  for (let i = blockStart + 1; i < blockStop; i++) {
    const info = analyzeLine(lines[i])
    if (info.itemIndent !== undefined || info.indent !== indent || info.key !== key) continue
    if (lines[i].trim() === wanted) return { changed: false, reason: 'already correct', unchanged: true }
    lines[i] = `${' '.repeat(indent)}${wanted}`
    return { changed: true, text: joinText(parts), action: 'replaced' }
  }
  let at
  if (beforeKey !== undefined) {
    const anchor = childByKey(lines, blockStart + 1, blockStop, beforeKey)
    at = anchor === undefined ? undefined : anchor.start
  }
  if (at === undefined) {
    at = blockStop
    while (at > blockStart + 1 && isBlank(lines[at - 1])) at--
  }
  lines.splice(at, 0, `${' '.repeat(indent)}${wanted}`)
  return { changed: true, text: joinText(parts), action: 'inserted' }
}

/**
 * Remove a scalar field from a route block.
 *
 * Needed for the one destructive repair in this skill: a route-level `reasoning:` value is
 * applied to *every* model on the route, so once a model that does not offer it is added,
 * that field makes the model unusable and has to come out — the writer re-adds it as soon as
 * every model on the route supports it again.
 */
export function removeRouteScalar(text, routeId, key) {
  const parts = splitText(text)
  const { lines } = parts
  const route = locateRoute(lines, routeId)
  if (route === undefined) return { changed: false, reason: `route "${routeId}" not found` }
  const fieldIndent = childIndentOf(lines, route.keyLine + 1, route.end) ?? route.routeIndent + 2
  return removeChildScalar(parts, route.keyLine, route.end, fieldIndent, key)
}

/** Remove a scalar field from a top-level namespace block. */
export function removeNamespaceScalar(text, namespace, key) {
  const parts = splitText(text)
  const { lines } = parts
  const ns = childByKey(lines, 0, lines.length, namespace)
  if (ns === undefined) return { changed: false, reason: `namespace "${namespace}" not found` }
  const indent = childIndentOf(lines, ns.keyLine + 1, ns.end)
  if (indent === undefined) return { changed: false, reason: `namespace "${namespace}" has no fields to remove` }
  return removeChildScalar(parts, ns.keyLine, ns.end, indent, key)
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

/** Every route under `llm-pi-ai.providers`, as `{ id, api, baseURL, modelIds }`. */
export function listRoutes(lines) {
  const top = childByKey(lines, 0, lines.length, 'llm-pi-ai')
  if (top === undefined) return []
  const providers = childByKey(lines, top.keyLine + 1, top.end, 'providers')
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
