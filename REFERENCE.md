# Reference

The DSH internals behind `SKILL.md`. Nothing here is needed to *run* the skill — the scripts
encode all of it. Read it when the user asks "why does it work that way", or when a case does
not match what the execution path promises.

## Why a hand-declared route exposes nothing

> **pi-ai's model metadata is looked up by the route name itself, and the lookup is
> all-or-nothing.**

`dsh-llm-pi-ai` resolves a route through `catalogModels(provider)`, which returns an **empty
table** unless the route key equals a pi-ai builtin provider id:

```js
// dsh-llm-pi-ai  (catalogModels)
if (!catalogProviders().has(provider)) return new Map()   // route name unknown -> nothing
```

With an empty table every model's `base` (the installed catalog entry) is `undefined`, so
**all** capability metadata falls back to hand-written values at once — including `reasoning`,
which becomes `false`, which is why the picker shows no effort levels at all. DSH's own term
for such a route is `declared: true` (`declared: !catalog.has(provider)`), and that is the
definition this skill uses for "custom".

**The corollary that makes the job tractable: the catalog still knows what to declare.** The
route *name* decides whether DSH inherits the metadata, but the catalog file itself is the
record of what each model id can do. So for a custom route we re-declare, by hand, exactly
what the catalog says — and when the gateway's base URL matches a catalog provider's, that
mapping is mechanical:

```
<dshInstall>/@earendil-works/pi-ai/dist/providers/data/<provider>.json
```

## Custom vs built-in

| Route kind | Recognised by | What the skill does |
| --- | --- | --- |
| native DeepSeek adapter, `llm-deepseek` (provider id `deepseek-official`) | a top-level namespace | read-only; `off, low, high, max`, adapter-wide, not per model |
| any pi-ai catalog provider — all 40 ids the install ships (`openai`, `anthropic`, `google`, `deepseek`, `opencode-go`, `zai`, `moonshotai`, `xai`, …) | the route key **is** a catalog id, i.e. `declared: false` | read-only; such a route *is* that built-in provider with field-level overrides and already inherits `reasoning`/`thinkingLevelMap`/`compat` |
| anything else under `llm-pi-ai.providers` | none of the above | **written** — this is what "custom" means |

It is the *route name*, not the vendor, that decides: a route called `my-gemini` pointing at
Google is custom; a route called `google` is the built-in. The tool only ever writes
`llm-pi-ai.providers` and `agent-default-model`.

One case looks like an omission and is not: **a hand-added model on a catalog route**. It
inherits nothing, so it exposes no levels — and the tool still will not write for it, because
"do not touch built-in providers" outranks "cover every model". The report says so and
suggests moving the model onto a custom route.

## The schema

```yaml
models:
  - id: new-model
    reasoningEfforts:        # a dict declares the offered levels, authoritatively
      off: null
      low: low
      high: high
      max: max
  - id: non-reasoning-model
    reasoningEfforts: false  # explicit: declare it, do not rely on absence
```

Rules, enforced at config-resolution time (`resolveModelReasoning`):

- **Keys are pi-ai's seven levels**, in escalation order: `off, minimal, low, medium, high,
  xhigh, max`. An unknown key is rejected.
- **Only `off` may be empty** (`off: null`). Every other level needs a non-empty string.
  Semantically `off: null` means "offer Off, and send nothing for it".
- A declared dict **pins every undeclared level to unsupported**: omitted keys disappear from
  the picker instead of inheriting a default.
- `xhigh` and `max` are **opt-in** and appear only when mapped explicitly.
- The value is the **wire spelling** for that level, passed through verbatim — so a gateway
  with its own vocabulary is expressed as `max: ultra`.
- At least one level beyond `off` is required; only-`off` and `{}` are errors.
- Omitting the field means "keep the installed catalog's capability" — which for a custom
  route is `false`. That is the state this skill exists to fix.

**Forced-thinking models have no `off`.** GLM-5.3 and GLM-5.3-Flash always reason: the vendor
documents three levels (low, high, max) and states that disabling reasoning is no longer
supported — `thinking.type: "disabled"` is an error. The catalog agrees by pinning `off` to
`null`. So the honest declaration is `{low, high, max}` with **no `off` key at all**. The level
set is a property of the model, not a fixed template: `kimi-k3` offers only `max`,
`hy4-preview` offers `off` and `high`, `deepseek-v4-pro` offers `off`, `high` and `max`.

## What each protocol does with the level

| effective `api` | the level becomes | session header |
| --- | --- | --- |
| `openai-responses` | `reasoning: { effort, summary: "auto" }`, the map value verbatim; with no level selected, `reasoning.effort` falls back to the map's `off` spelling or the literal `"none"` | sent natively (`session_id`) |
| `openai-completions` | `reasoning_effort`, plus a `thinking: {type}` object when `compat.thinkingFormat` says `deepseek` / `zai`; `qwen` and others reshape it | **not sent** — gated behind `compat.sendSessionAffinityHeaders`, which DSH classifies `"withhold"` and refuses from settings.yaml |
| `anthropic-messages` | **not an effort string**: the level selects a `thinking.budget_tokens` value (`off` ⇒ `thinking: {type: "disabled"}`), so a declared map's *values* are inert — the level set is what matters | not sent |

Two consequences worth stating plainly:

- **`thinkingFormat` is not a Responses field.** A Responses route ignores it.
- **Switching a route to `openai-completions` to use `thinkingFormat: deepseek` costs the
  session header.** Decide the protocol by the session-header column first, then express effort
  within it. Both protocols accept the same `reasoningEfforts` declaration.

## The "Default" row

DSH's picker offers a `Default` entry exactly when the model reports reasoning metadata *and*
no `defaultEffort` (`dsh-client-ui-model-selection/lib/client.js`):

```js
const effortChoices = reasoning === void 0 ? [] : [
  ...(reasoning.defaultEffort === void 0 ? [{ key: "provider-default", effort: void 0, label: t("effort.providerDefault") }] : []),
  ...reasoning.efforts.map((effort) => ({ key: `effort:${effort.id}`, effort: effort.id, label: effort.name })),
]
```

Choosing it sends *nothing*, and the upstream provider's own default decides how hard the model
thinks. The only source of `defaultEffort` is the **route-level** `reasoning:` field:

```js
// dsh-llm-pi-ai
function describableReasoningLevel(model, effort) {
  if (effort === void 0) return void 0
  return getSupportedThinkingLevels(model).some((level) => level === effort) ? effort : void 0
}
...defaultLevel === void 0 ? {} : { defaultEffort: ReasoningEffortId(defaultLevel) }
```

Two properties follow, and they are why the writer guards the write:

- it is **route-scoped** — the config schema has no per-model default (`modelFields` is
  `name/contextWindow/maxTokens/input/reasoningEfforts/compat`), so one non-compliant model
  forces the whole route to stay on Default;
- a model on the route that does **not** support the level keeps its `Default` row, and the
  adapter re-applies the route value at stream time
  (`resolveReasoningLevel(model, options.reasoningEffort ?? profile.reasoning)`), so *using*
  that model then fails with `UNSUPPORTED_REASONING_EFFORT`.

The writer therefore writes a route default only when **every** model on that route declares the
level, and otherwise reports the route as not-written with the models that blocked it.

`agent-default-model.reasoningEffort` is a separate, weaker knob: it is the initial selection for
a **new** session. It does not retroactively change a session that has already logged a request.

## Evidence tiers

| Tier | Where it comes from | Reaches the settings file? |
| --- | --- | --- |
| `probe` | one minimal live request this model accepted | yes (`--probe`) |
| `vendor` | the provider's own documentation, cited in `data/reasoning-overrides.yaml` | yes |
| `user` | an answer the user recorded with `--decide`, in `data/user-decisions.yaml` | yes |
| `catalog` | the installed pi-ai catalog | yes |
| `unknown` | nothing sources it | **never** — the run asks instead |

Both data files are *inputs*, not generated state: every entry needs a source or a recorded
decision, and an entry that cannot cite one does not belong there. `--evidence vendor` requires
`--source <url>` for exactly that reason.

**A sibling attestation is evidence for a question, not a licence to write.** The same model
served by another gateway can have different limits and a different wire vocabulary, which is why
the writer reports sibling candidates but refuses to derive from them.

## The public endpoint table is not authoritative

A gateway may publish an endpoint table saying which protocol path serves which model. Treat it
as a hint, never a verdict. Measured on one machine: the table listed only `grok-*` /
`gpt-5.6-luna` / `muse-spark-*` on `/responses`, yet a route configured
`api: openai-responses` at that gateway served **64 consecutive** `deepseek-flash` turns with
zero 404s and zero `MissingSessionID` errors. The catalog's per-model `api` is a *default*, not a
constraint, and the gateway's own docs call the surface undocumented.

So a protocol difference between the catalog and the route is **reported as a notice**, never
acted on. `--fix-routes` exists for a user who wants the catalog's protocols applied; it requires
an explicit `--route`, because a migration can break a route that works today.

## The write path

- Edits are **line-level and surgical**: only the located declaration (or route field) is
  inserted or replaced. Untouched lines are written back byte for byte, so comments and
  formatting survive. A parse-and-dump round trip would not.
- The parser is **strict**: an unknown flag exits 2 before anything is read. `--flag=value` is
  accepted as well as `--flag value`.
- `--apply` guarantees, in order: one backup file (`settings.yaml.bak-reasoning-efforts`,
  overwritten each run, holding the pre-write state) → the edited text is **re-parsed** → the
  result is diffed **path by path** against the original and refused if anything outside
  `llm-pi-ai.providers.*` or `agent-default-model.*` changed → every target model is read back
  and compared to what was intended.
- Re-running is **idempotent**: an already-correct declaration produces no change, and a run that
  changes nothing writes no backup.

## Two facts about DSH itself

**A dynamic Cordis plugin cannot write settings.** `dsh-settings` accepts only objects whose
prototype *is* the Host bundle's `Object.prototype`, and a dynamic plugin runs in a separate
realm, so nothing it constructs passes (`must be a plain object`). Read from a plugin, write to
the file.

**Hot reload is uncertain.** The settings file provider is wired to a watcher, and the base
config describes the document as hot-reloaded, yet a case of an external edit not being picked up
was observed. Refresh first, keep a fresh `dsh` start as the fallback, and do not claim either
behaviour. If the Models page holds unsaved state, a later GUI write can overwrite a file-level
edit.

## Platform notes

- Discovery is env-first and needs no subprocess: `--dsh-root` → `DSH_ROOT` →
  `$DSH_HOME/profiles/node_modules` → roots implied by the running Node binary → platform
  defaults → `where`/`which` last (`DSH_NO_SUBPROCESS=1` skips it).
- Everything else is Node: `node:path` joins, `\r\n`-tolerant line handling, forward slashes in
  every documented command. Nothing needs bash, `sed`, `jq` or PowerShell.
- Writing `settings.yaml` means writing outside the session workspace, so a sandbox may require
  an approval; that prompt is the user's consent, not a workaround. A permissive machine will not
  prompt for the same command — that difference is environmental, and the script's output and
  exit code are identical either way.
- Windows: never host a long-lived `dsh` in a background job (killing the job orphans the child,
  which keeps the port and makes the next start fail with `EADDRINUSE`). Recover with
  `netstat -ano | findstr ":<port>"` then `taskkill /PID <pid> /T /F`; `Get-NetTCPConnection` can
  return nothing in a confined shell while `netstat` still shows the socket.

## How far verification goes

`--probe` sends one minimal request per model and records whether the gateway **accepted** the
value. That is all it proves. It does not prove the level changed how hard the model thought, and
nothing in this skill claims otherwise.
