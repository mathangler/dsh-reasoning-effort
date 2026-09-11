---
name: dsh-reasoning-effort
description: Make a DSH model route expose selectable thinking / reasoning effort levels (and diagnose why the level picker is missing, empty, or rejects a level). Covers the pi-ai catalog-by-route-name rule, the per-model and per-route `reasoningEfforts` schema, the `openai-responses` vs `openai-completions` protocol decision, and validation errors such as "no model on the route speaks a protocol that takes it". Use when adding a new/hand-declared model to `llm-pi-ai` in settings.yaml, when the model menu shows no 推理等级 / reasoning effort submenu, when a level returns UNSUPPORTED_REASONING_EFFORT, when `reasoningEfforts`/`thinkingFormat` config is rejected, or the user asks 怎么调思考等级 / 调整思考强度 / 加推理等级 / reasoning effort / thinking budget.
disable-model-invocation: true
---

# Reasoning effort for a DSH model route

This skill covers making thinking depth **selectable in the model picker** for any
route served by `@deepseek-ai/dsh-llm-pi-ai`, with a worked, verified recipe for an
OpenCode Go / Zen route carrying a model pi-ai does not know yet.

It does **not** cover the `openai-completions` `MissingSessionID` failure — that is
the companion skill `opencode-go-session-header`, and the two interact (see
"Protocol choice", which is the trap that bites hardest).

## When this applies

- The model menu has **no 推理等级 / "Effort" submenu** for a route you added.
- You added a **new or hand-declared model** (pi-ai has not catalogued it yet).
- A level is **listed but rejected**: `does not support reasoning effort "<x>"`.
- A config write is **refused** with a compat/protocol error (see the triage table).
- The whole route **vanished from the picker** after a settings edit.

## The one rule that explains most surprises

> **pi-ai's model metadata is looked up by the route name itself, and the lookup is
> all-or-nothing.**

`llm-pi-ai` resolves a route through `catalogModels(provider)`, which returns an
**empty table** unless the route key equals a pi-ai builtin provider id:

```js
// dsh-llm-pi-ai  (catalogModels)
if (!catalogProviders().has(provider)) return new Map()   // route name unknown -> nothing
```

With that empty table, each configured model's `base` (the "installed catalog entry")
is `undefined`, so **everything falls back to hand-written values at once**:

| Field | Catalog route | Hand-declared route name |
| --- | --- | --- |
| display name | catalog's | yours or the raw id |
| contextWindow | catalog's (e.g. 1,000,000) | route default (262,144) |
| `reasoning` | catalog's | **`false`** — this is why the picker is empty |
| `thinkingLevelMap` | catalog's | absent |
| `compat` (e.g. `thinkingFormat`) | catalog's | absent |

**Consequence: one new model can strip capability metadata from the catalog-known
models beside it**, if they share a route whose name is not a catalog provider id.
That is usually enough to make the two-routes decision below.

There is **no alias mechanism** — route name → catalog provider. The whole path
(`resolveProfiles` → `catalogModels` → `resolveRouteModels` → `buildProvider`)
uses the route key throughout. Renaming a custom route to a catalog provider id
also makes it collide with that provider's own route and binds it to the wrong
credential (see "Two routes, or one?").

### If the route name *is* a catalog provider, just name the model

A catalog-backed route inherits `reasoning`, `thinkingLevelMap` and `compat`
per model with **no fields at all**:

```yaml
llm-pi-ai:
  providers:
    opencode-go:
      apiKeyEnv: OPENCODE_GO_API_KEY
      models:
        - id: deepseek-v4-flash      # capabilities come from the catalog
```

Confirm inheritance by resolving the route (see `scripts/check-reasoning-route.mjs`);
if `reasoning.efforts` is non-empty you are done. Everything below is for routes
whose name the catalog does not know, or for models it has not catalogued.

## Triaging a route: which protocol, and who owns the session header

Run the shipped script first — it reads `settings.yaml`, the pi-ai catalog and the
pinned bundles, and prints the effective protocol per model plus any compat
mismatch:

```
node "<skill>/scripts/check-reasoning-route.mjs" --route opencode-go-custom
```

Then walk this table, because **the protocol decides both how effort travels and
whether the gateway's session header is sent at all**:

| effective `api` | reasoning travels as | gateway session header | verdict |
| --- | --- | --- | --- |
| `openai-responses` | `reasoning: { effort, summary }`, mapped through `model.thinkingLevelMap` — a Responses route **ignores** `thinkingFormat` (the field does not exist in pi-ai's Responses compat type) | sent natively (`session_id`) | **default choice when the gateway needs a session id** |
| `openai-completions` | `reasoning_effort`, and DeepSeek's `thinking: {type}` when `compat.thinkingFormat: deepseek` | **not sent** — gated behind `compat.sendSessionAffinityHeaders`, which DSH classifies `"withhold"` at both `COMPLETIONS_COMPAT_GATE` and `RESPONSES_COMPAT_GATE`, so it cannot be enabled from settings.yaml | only if you have applied the session-header patch |
| `anthropic-messages` | provider-specific | not sent (same gate) | rare for this use |

**The trap.** `thinkingFormat: deepseek` looks like the thing that "makes thinking
work", so it is tempting to move a route to `openai-completions` to use it. On an
OpenCode Go / Zen gateway that route **also loses the session id**, and the very
next turn dies with `400 MissingSessionID` — an unrelated-looking failure that the
level-picker work did not ask for. Decide the protocol by the **session-header**
column first, then express effort within that protocol.

Both protocols accept the same `reasoningEfforts` declaration, so you normally get
levels without trading the header away.

## The schema

`reasoningEfforts` may be declared on a route's model entry (or in
`modelOverrides`, which is refused for non-catalog routes — those must restate the
whole `models` list):

```yaml
models:
  - id: new-model
    name: Display Name
    contextWindow: 1000000
    maxTokens: 384000
    reasoningEfforts: { off: null, low: low, high: high, max: max }
  - id: non-reasoning-model
    reasoningEfforts: false        # explicit: declare it, do not rely on absence
```

Rules, enforced at config-resolution time:

- **Keys must be pi-ai's seven levels**, in escalation order:
  `off, minimal, low, medium, high, xhigh, max`. An unknown key is rejected.
  You cannot invent `ultra` / `extreme`.
- **Only `off` may map to an empty value** (`off: null`). Every other level needs a
  non-empty wire string.
- Declaring the dict **pins every undeclared level to unsupported** — a declared dict
  is authoritative, so list every level you want offered. Keys you omit disappear
  from the picker instead of inheriting a default.
- `xhigh` and `max` are **opt-in**: they exist only when you map them explicitly.
- The value is the **wire spelling** sent for that level (so `max: ultra` renames a
  level for a gateway with its own vocabulary).
- `false` declares a non-reasoning model; omitting the field means "keep the
  installed catalog's capability" (which is `false` for a route the catalog does not
  know).
- The route also accepts a default: `reasoning: <level>` at route level materializes
  `defaultEffort`. It sets the default only — it does **not** make the picker appear.

Levels become visible because the adapter reports them as the model's
`reasoning.efforts`; the picker renders exactly that list.

## Validation errors and what they mean

Writes to `settings.yaml` are validated, and a rejected route **disappears from the
model picker entirely** (the route is not registered, so the failure surfaces as a
missing model far from its cause). Messages seen in practice:

| Message | Cause | Fix |
| --- | --- | --- |
| `sets compat "<field>", but no model on the route speaks a protocol that takes it; it exists on <protocols>` | a route-level `compat` field no model on the route can accept — almost always **every model's `api` resolved to `undefined`** because you removed the route-level `api` and the route is not in the catalog | state the route's `api` explicitly, or move the field to individual models |
| `does not support reasoning effort "<x>"` | the level is not in the model's resolved level set (undeclared level, or `reasoning` is `false`) | declare it in `reasoningEfforts`, or pick a declared level |
| route vanished with no visible error | the route failed validation; inspect the provider entry's `error` in the Models page or via the live probe | fix the field named in `error` |
| `modelOverrides ... does not describe this route` | `modelOverrides` needs a catalog route | use a full `models` list with the fields on the entries |

A field belongs to the protocols whose upstream compat type declares it: a
**model-level** switch its protocol does not take fails resolution, while a
**route-level** one skips past models it cannot fit.

## Recipe: a new model on a gateway that needs a session header

The verified arrangement for OpenCode Go / Zen (gateway requires a session id;
pi-ai does not know the new model):

```yaml
llm-pi-ai:
  providers:
    opencode-go-custom:
      displayName: OpenCode Zen (go)
      apiKeyEnv: OPENCODE_GO_CUSTOM_API_KEY     # keep the route's own credential
      baseURL: https://opencode.ai/zen/go/v1
      api: openai-responses                     # session_id is sent natively
      models:
        - id: new-reasoning-model
          name: New Model
          contextWindow: 1000000
          maxTokens: 384000
          reasoningEfforts: { off: null, low: low, high: high, max: max }
```

Deliberately **absent**: any route-level `compat` (nothing to gate for Responses),
and `thinkingFormat` (not a Responses field). Effort still travels, through
`reasoning.effort`, because the Responses implementation maps the selected level
through `model.thinkingLevelMap` — which is exactly what `reasoningEfforts` builds.

Copy the level set from a sibling model in the pi-ai catalog when one exists, so a
future pi-ai release that catalogues the model makes your declaration redundant
rather than contradictory:

```
<dshRoot>/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/providers/data/<provider>.json
```

### Two routes, or one?

- **Keep one route, declare everything by hand** when the custom credential must stay
  separate from a catalog provider's own route (route name is what selects the
  credential, and a catalog provider id is already taken by the official route).
- **Split the route in two** when you also want automatic inheritance for the
  catalog-known models: one route whose name **is** a catalog provider id carrying
  only catalog-known models, and a hand-declared route for the new model. A route's
  `api` is a single value, so models on different protocols (an
  `anthropic-messages` model beside `openai-completions` ones) also force a split.
- **Renaming a custom route to a catalog provider id** buys inheritance but collides
  with that provider's own route and binds its credential — only do it if you truly
  mean to replace it.

## Verify, or you will ship a picker that does nothing

A level appearing in the picker only proves metadata resolved. It does not prove the
provider accepts what is sent.

1. **Config resolves** — run `scripts/check-reasoning-route.mjs`. It reports the
   effective protocol per model and flags compat/protocol mismatches that strict
   writes reject.
2. **Levels are accepted, not just listed** — from a live session, resolve each level;
   `listed but rejected` is a real state that a visual check misses.
3. **Wire behaviour** — send one request at a high level and confirm reasoning tokens
   rise. This is the only step that catches "the parameter is accepted by DSH but not
   honoured (or rejected) by the gateway", so it cannot be inferred from config.

### Live probe (read-only)

`scripts/live-probe.md` contains a ready-to-paste dynamic Cordis Host plugin that
reports the default model selection, every advertised level, and which levels
`resolveCallConfig` accepts. It also prints a route's registration diagnostic, which
is where a rejected route's error text lives.

### What the gateway's model list does **not** tell you

`llm.discoverModels` hits `GET {baseURL}/models`. On OpenCode Zen that endpoint
answers the **same flat id list for every protocol path** you ask about
(`openai-completions`, `openai-responses`, `anthropic-messages`), so:

- it cannot tell you which protocol a given model actually speaks;
- it cannot validate your credential (the listing answered without one);
- a model appearing there does **not** mean your route will work — protocol and
  session-header requirements still apply per route.

Treat it as a name-discovery aid only. Reading the pinned pi-ai catalog for the
protocol is the reliable way.

## Two write-path facts (each cost an hour to learn)

**A dynamic Cordis plugin cannot write settings.** `dsh-settings` validates its
input with a realm-sensitive check:

```js
// dsh-settings
function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;   // the HOST bundle's Object.prototype
}
```

A dynamic Host plugin runs in a **separate realm**, so everything it constructs (an
object literal, `JSON.parse` output, even a `ctx.provide`/`ctx.get` round trip) fails
that identity test. Symptom: `settings replace for "<ns>" must be a plain object`, or
`settings mutate ... ops must be {op:'set'|'unset', path}` — with structurally valid
input. Readers are unaffected (`settings.get()` / `describe()` return host objects),
so **inspect from a plugin, write to the file.**

**Editing `settings.yaml` externally does not hot-reload a running process.** The
file provider's watcher has been observed not to fire: appending a byte to the file
left the Host's in-memory text length unchanged. Config changes therefore require a
**fresh `dsh` process** — the new process reads the file at startup. Do not promise a
user that a file edit applies live, and do not conclude a config is wrong because a
running process still reports the old value.

**Edit the file as block YAML.** The shipped web profile writes `providers:` as a
multi-line flow map, and mismatched brace indentation inside it silently corrupts the
whole document (`missed comma between flow collection entries`). Rewriting the
section as block YAML removes the class of error. Always parse the result with the
pinned `js-yaml` before finishing — the script does this.

## Operating notes (Windows)

- **Never host a long-lived `dsh` in a background job.** Killing the job kills only
  the wrapper; the `dsh` child is orphaned and keeps the port, so the next start fails
  with `EADDRINUSE`. If it happens: `netstat -ano | findstr ":<port>"` to get the PID,
  then `taskkill /PID <pid> /T /F` (`/T` is the part that matters).
- The settings document lives outside the session workspace, so writing it needs a
  sandbox escalation; that prompt is the user's consent, not a workaround.
- `Get-NetTCPConnection` can return nothing in a confined shell while `netstat -ano`
  still shows the socket — prefer `netstat` for port forensics.
- The GUI's `/api/*` is a WebSocket/SSE upgrade behind a launch-token cookie, not a
  REST surface; do not try to read the model catalog from it. Verify in the browser.

## Rollback

Keep a copy of the settings document before editing (`settings.yaml.bak-*`). To
revert, restore it and start a fresh `dsh`. If only one model misbehaves, remove that
model's `reasoningEfforts` (or set it `false`) rather than reverting the route: the
levels disappear and the previous behaviour returns without disturbing other models.
