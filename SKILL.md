---
name: dsh-reasoning-effort
description: Make every model on a hand-declared (custom) DSH provider route expose the thinking / reasoning-effort levels it actually has, and diagnose why a level picker is missing, empty, or rejects a level. Every model on such a route ends up with an explicit declaration — a `reasoningEfforts` map, or an explicit `false` — because a missing field silently means "no reasoning"; a model nothing can source is put to the user as a question instead of being guessed at. Covers the pi-ai catalog-by-route-name rule, the per-model `reasoningEfforts` schema, the openai-responses / openai-completions / anthropic-messages protocol decision, the evidence rules that keep a declaration honest, and the two shipped scripts — `scripts/apply-reasoning-efforts.mjs` (a writer, dry run by default) and `scripts/check-reasoning-route.mjs` (a read-only validator). Built-in providers are never written. Works on Windows, macOS and Linux. Use when a model menu shows no 推理等级 / reasoning-effort submenu, when a level returns UNSUPPORTED_REASONING_EFFORT, when adding models under `llm-pi-ai.providers` in settings.yaml, or when the user asks 怎么调思考等级 / 调整思考强度 / 加推理等级 / reasoning effort / thinking budget.
disable-model-invocation: true
---

# Reasoning effort for a DSH model route

This skill makes thinking depth **selectable in the model picker** for the models
on a hand-declared `llm-pi-ai` route. It does that by writing a per-model
`reasoningEfforts` map into `~/.dsh/settings.yaml`, and it writes only what the
evidence supports.

Two things it deliberately does **not** do:

- It never writes a built-in provider. Routes whose key *is* a pi-ai catalog
  provider id inherit their capabilities already, and `llm-deepseek`
  (provider id `deepseek-official`) has its own fixed four levels.
- It never guesses a level. A model nothing can source is put to the user as a
  question, never filled in with a plausible-looking guess.

## The coverage contract

Every model on a hand-declared route ends up in exactly one of three states, and
**what the provider is called has nothing to do with it**:

| State | How it lands in the file |
| --- | --- |
| supports reasoning | an explicit `reasoningEfforts` map with the levels it really has |
| does not reason | an explicit `reasoningEfforts: false` |
| not determinable | nothing written; the run **stops and asks**, and exits non-zero |

The third row is the point: on a hand-declared route a missing field *means*
"no reasoning", so an undeclared model is indistinguishable from a decision that
it does not reason. Leaving it undone silently is therefore not an option — the
run treats an open question as unfinished work (`exit 1`, with a `需要你决定`
section) rather than as success, so a clean exit really does mean every model is
covered.

This is why the scan is over **every route under `llm-pi-ai.providers`** rather
than over a list of provider names: add a provider or a model, run the skill
again, and the new models are covered in the same pass. It is idempotent, so
models that are already correct are left byte-for-byte alone.

### No provider default: pin the level

A reasoning model whose route declares no `reasoning:` is offered a **Default** row,
and choosing it sends *nothing* — the upstream provider's own default then decides
how hard the model thinks. DSH shows that row exactly when the model has no
`defaultEffort`, and the only knob that creates one is the **route-level** field:

```yaml
llm-pi-ai:
  providers:
    my-gateway:
      baseURL: https://…
      api: openai-completions
      reasoning: high        # becomes defaultEffort for every model on the route
```

So the writer, unless told otherwise, sets `reasoning: high` on every hand-declared
route (`--default-effort <level>` to change it, `--default-effort skip` to disable)
plus `agent-default-model.reasoningEffort: high` — the initial selection for **new**
sessions. Two properties of the field are why this is guarded rather than
unconditional:

- it is **route-scoped**: the config schema has no per-model default, so one
  non-compliant model forces the whole route to stay on Default;
- a model on the route that does **not** support the level keeps its Default row,
  and the adapter re-applies `profile.reasoning` at stream time — so *using* that
  model fails with `UNSUPPORTED_REASONING_EFFORT`.

The writer therefore writes a route default only when **every** model on that route
declares the level, and otherwise reports the route as `未写` together with the
models that blocked it, so the requirement is never silently half-met.

## The one rule that explains most surprises

> **pi-ai's model metadata is looked up by the route name itself, and the lookup
> is all-or-nothing.**

`llm-pi-ai` resolves a route through `catalogModels(provider)`, which returns an
**empty table** unless the route key equals a pi-ai builtin provider id:

```js
// dsh-llm-pi-ai  (catalogModels)
if (!catalogProviders().has(provider)) return new Map()   // route name unknown -> nothing
```

With an empty table every model's `base` (the installed catalog entry) is
`undefined`, so **all** capability metadata falls back to hand-written values at
once — including `reasoning`, which becomes `false`, which is why the picker's
Effort pane is empty. DSH's own term for such a route is `declared: true`
(`declared: !catalog.has(provider)`), and that is also the definition this skill
uses for "custom provider".

**The corollary that makes the whole job tractable: the catalog still knows what
to declare.** The route *name* decides whether DSH inherits the metadata, but the
catalog file itself is still the record of what each model id can do. So for a
custom route you re-declare, by hand, exactly what the catalog says — and when the
gateway's base URL matches a catalog provider's, that mapping is mechanical.

```
<dshInstall>/@earendil-works/pi-ai/dist/providers/data/<provider>.json
```

One gateway is one catalog provider even when it speaks three protocols: its
models are grouped by `api`, and each model carries `api`, `reasoning`,
`thinkingLevelMap` and `compat`. Read it before inventing anything.

## Sources of truth, strongest first

| Source | Where it comes from | Reaches the settings file? |
| --- | --- | --- |
| probe | one minimal live request this model accepted | yes (`--probe`) |
| vendor | the provider's own documentation, recorded in `data/reasoning-overrides.yaml` | yes |
| user | an answer the user recorded via `--decide`, in `data/user-decisions.yaml` | yes |
| catalog | the installed pi-ai catalog | yes |
| unknown | nothing | **never** — the run asks the user instead |

`data/reasoning-overrides.yaml` holds cited provider facts and
`data/user-decisions.yaml` holds the answers to questions nothing else could
settle. Both are *patch* layers: every entry needs a source or a recorded
decision, and an entry that cannot cite one does not belong there.

## The schema

```yaml
models:
  - id: new-model
    contextWindow: 1000000
    reasoningEfforts:        # a dict declares the offered levels, authoritatively
      off: null
      low: low
      high: high
      max: max
  - id: non-reasoning-model
    reasoningEfforts: false  # explicit: declare it, do not rely on absence
```

Rules, enforced at config-resolution time (`resolveModelReasoning`):

- **Keys are pi-ai's seven levels**, in escalation order:
  `off, minimal, low, medium, high, xhigh, max`. An unknown key is rejected.
- **Only `off` may be empty** (`off: null`). Every other level needs a non-empty
  string. Semantically `off: null` means "offer Off, and send nothing for it".
- A declared dict **pins every undeclared level to unsupported**. Omitted keys
  disappear from the picker; they do not inherit a default.
- `xhigh` and `max` are **opt-in** and only appear when mapped explicitly.
- The value is the **wire spelling for that level**. It is passed through
  verbatim — so a gateway with its own vocabulary is expressed with `max: ultra`.
- At least one level beyond `off` is required. Only-`off` and `{}` are errors.
- Omitting the field means "keep the installed catalog's capability" — which for a
  custom route is `false`. That is the state this skill fixes.

### Forced-thinking models have no `off`

Do not assume `off` is available. GLM-5.3 and GLM-5.3-Flash **always reason**:
the vendor documents three effort levels (low, high, max) and states that
disabling reasoning is no longer supported — sending `thinking.type: "disabled"`
is an error, and existing callers were told to migrate. The catalog agrees by
pinning `off` to `null`. The honest declaration for those models is therefore
**`{low, high, max}` with no `off` key at all.**

That is the pattern to apply everywhere: the level set is a property of the
model, not a fixed template. `kimi-k3` offers only `max`; `hy4-preview` offers
`off` and `high`; `deepseek-v4-pro` offers `off`, `high` and `max`.

## What each protocol does with the level

The protocol decides **how the level travels** and whether the gateway's session
header is sent at all. It does not change which levels exist.

| effective `api` | the level becomes | session header |
| --- | --- | --- |
| `openai-responses` | `reasoning: { effort, summary: "auto" }`, the map value verbatim; with no level selected, `reasoning.effort` falls back to the map's `off` spelling or the literal `"none"` | sent natively (`session_id`) |
| `openai-completions` | `reasoning_effort`, plus a `thinking: {type}` object when `compat.thinkingFormat` says `deepseek` / `zai`; `qwen` and others reshape it differently | **not sent** — gated behind `compat.sendSessionAffinityHeaders`, which DSH classifies `"withhold"` and refuses from settings.yaml |
| `anthropic-messages` | **not an effort string at all**: the level selects a `thinking.budget_tokens` value (off ⇒ `thinking: {type: "disabled"}`), so a declared map's *values* are inert here and only the level set matters | not sent |

Two consequences worth stating plainly:

- **`thinkingFormat` is not a Responses field.** A Responses route ignores it.
- **Switching a route to `openai-completions` to use `thinkingFormat: deepseek`
  costs the session header.** Decide the protocol by the session-header column
  first, then express effort within it. Both protocols accept the same
  `reasoningEfforts` declaration.

## The public endpoint table is not authoritative

A gateway may publish an endpoint table saying which protocol path serves which
model. **Treat it as a hint, never as a verdict.** Measured on this machine: the
table lists only `grok-*` / `gpt-5.6-luna` / `muse-spark-*` on `/responses`, yet a
route configured `api: openai-responses` at that gateway served 64 consecutive
`deepseek-flash` turns with zero 404s and zero `MissingSessionID` errors. The
catalog's per-model `api` is a *default*, not a constraint, and the gateway's own
docs call the surface undocumented.

So: a protocol difference between the catalog entry and the route is **reported as
a notice**, never acted on. `--fix-routes` exists for a user who wants the
catalog's protocols applied, and it is off by default.

## The scripts

Both are plain Node ESM with no dependencies of their own — `js-yaml` is resolved
out of the DSH install, the same parser DSH uses.

### `scripts/apply-reasoning-efforts.mjs` — the writer

```sh
node scripts/apply-reasoning-efforts.mjs                  # dry run: print the plan
node scripts/apply-reasoning-efforts.mjs --apply          # back up, write, re-validate
node scripts/apply-reasoning-efforts.mjs --route my-route # limit to one route
node scripts/apply-reasoning-efforts.mjs --fix            # also replace conflicting declarations
node scripts/apply-reasoning-efforts.mjs --probe          # allow ONE minimal live request per model
node scripts/apply-reasoning-efforts.mjs --strict --probe # write only probe-verified models
node scripts/apply-reasoning-efforts.mjs --restore latest # roll back to the newest backup

# record the answer to a question nothing could settle, then apply in one pass
node scripts/apply-reasoning-efforts.mjs --decide 'my-route/my-model=low,high,max' --apply
node scripts/apply-reasoning-efforts.mjs --decide 'my-route/my-model=false'   # it does not reason
node scripts/apply-reasoning-efforts.mjs --decide 'my-route/my-model=skip'    # leave it, stop asking

# record a *searched* fact instead of a decision: needs a citation, lands in the
# cited layer rather than the decisions layer
node scripts/apply-reasoning-efforts.mjs --evidence vendor --source <url> \
  --decide 'my-route/my-model=low,high,max' --apply

# the default level (default: high). "skip" turns off the route/default writes
node scripts/apply-reasoning-efforts.mjs --default-effort xhigh --apply
node scripts/apply-reasoning-efforts.mjs --default-effort skip --apply

# see every outcome (declare / ask / non-reasoning) without touching a real install
node scripts/apply-reasoning-efforts.mjs --settings scripts/fixture-settings.yaml
```

What `--apply` guarantees, in order:

1. a timestamped backup (`settings.yaml.bak-reasoning-efforts-<stamp>`) is written first;
2. the edited text is **re-parsed** — a document that does not parse is not written;
3. the parsed result is compared against the original **path by path**, and the
   write is refused if anything outside `llm-pi-ai.providers.*` changed;
4. every intended model is read back and compared to the target map.

The edit itself is line-level and surgical: only the located `reasoningEfforts`
block is inserted or replaced. Untouched lines are written back byte for byte —
`settings.yaml` is hand-maintained, and a parse-and-dump round trip normalises and
can drop comments. Re-running the writer is idempotent: an already-correct map
produces no change.

Exit codes: `0` every model is covered (and no route default was blocked), `1`
something is pending or broken — a change to write, a conflict, a problem, **a model
still waiting on your decision, or a route whose default could not be written** — and
`2` the environment could not be read.

### When the catalog has nothing: search, then ask

The writer does not guess, so a model with no evidence becomes `needs-decision` and
the run exits non-zero. Work the question in this order:

1. **Search and verify.** Look the model up — the provider's own documentation first
   (`reasoning_effort`, `thinking:{type}`, `enable_thinking`, `thinking_budget`,
   `output_config.effort`), then aggregator catalogs such as models.dev. Record a
   citable answer *with its URL*, and let the writer apply it:

   ```sh
   node scripts/apply-reasoning-efforts.mjs --evidence vendor --source <url> \
     --decide '<route>/<model>=low,high,max' --apply
   ```

2. **Only if that finds nothing, ask the user** with the `ask_user_question` tool —
   one question per model — offering the concrete alternatives the report already
   computed from sibling attestations:

   - the **intersection** of what other gateways declare (most likely to be accepted),
   - the **majority** set (with its count),
   - the **union** (most complete, but may contain a value one gateway rejects),
   - "it does not reason",
   - "leave it undeclared for now".

3. **Record the answer and apply in the same pass** (omit `--evidence vendor` for a
   user decision), then re-run to confirm `exit 0`:

   ```sh
   node scripts/apply-reasoning-efforts.mjs --decide '<route>/<model>=off,low,high,max' --apply
   ```

Two cautions:

- **A sibling is evidence for a question, not a licence to write.** The same model
  served by another gateway can have different limits and a different wire
  vocabulary — which is exactly why the writer refuses to derive from it silently.
- **A recorded decision is remembered**, so the same model is never asked about
  twice. Delete its entry from `data/user-decisions.yaml` to be asked again.

### `scripts/check-reasoning-route.mjs` — the validator

Read-only. Per route it reports whether the route is hand-declared, which catalog
provider serves the same base URL, the effective `api` per model, the levels the
picker would offer and where they come from, and whether each configured `compat`
field is accepted on a protocol that actually carries a model.

It distinguishes **problems** (things that break resolution) from **notices**
(models with no evidence — nothing to fix). When the compat gates cannot be read
from the adapter bundle it says *cannot be checked* rather than emitting a
confident wrong answer.

## Built-in providers: read-only, by contract

- `llm-deepseek` (provider id `deepseek-official`) advertises exactly
  `off, low, high, max` — four levels, adapter-wide, not per model. Its
  `reasoningEffort` is a free string validated at dispatch.
- A route whose key is one of pi-ai's catalog provider ids is an *override* of
  that provider, not a new provider (`declared: false`). It already inherits
  reasoning metadata, so there is nothing to declare and this skill writes
  nothing. Both are reported read-only so the user can compare.

## Two write-path facts

**A dynamic Cordis plugin cannot write settings.** `dsh-settings` accepts only
objects whose prototype *is* the Host bundle's `Object.prototype`, and a dynamic
plugin runs in a separate realm, so nothing it constructs passes
(`must be a plain object`). Read from a plugin, write to the file.

**Hot reload: do not promise it either way.** The settings file provider is wired
to a watcher, and the base config describes the document as hot-reloaded; yet the
upstream author observed an external edit that a running process did not pick up.
The honest posture: write the file, then have the user refresh the picker, and
keep a fresh `dsh` start as the fallback rather than claiming either behaviour.
`settings.yaml` is also edited by DSH's own Models page — if the GUI holds unsaved
state, a file-level edit can be overwritten by a later GUI write.

## Windows / macOS / Linux

Discovery is env-first and never requires a subprocess: `--dsh-root`, `DSH_ROOT`,
`$DSH_HOME/profiles/node_modules`, then the global `node_modules` implied by the
running Node binary, then platform defaults, and only last `where`/`which`
(`DSH_NO_SUBPROCESS=1` skips it). Upstream shelled out first, which failed on
Windows (`npm` is `npm.cmd`, `execFileSync` cannot spawn it), failed on macOS and
Linux (`where` does not exist), and could exit `2` under a sandbox that denies
child processes.

Everything else is Node: `node:path` joins, `\r\n`-tolerant line handling, LF
normalised by `.gitattributes`. Nothing in the pipeline needs bash, `sed`, `jq` or
PowerShell.

Windows notes that cost time to learn:

- **Never host a long-lived `dsh` in a background job.** Killing the job kills the
  wrapper; the orphaned `dsh` keeps the port, and the next start fails with
  `EADDRINUSE`. Recover with `netstat -ano | findstr ":<port>"` then
  `taskkill /PID <pid> /T /F`.
- `Get-NetTCPConnection` can return nothing in a confined shell while `netstat`
  still shows the socket.
- `settings.yaml` lives outside the session workspace, so writing it needs a
  sandbox escalation; that prompt is the user's consent, not a workaround.

## Verify, or ship a picker that does nothing

1. **Config resolves** — run `check-reasoning-route.mjs`; expect no problems.
2. **The picker shows the levels** — refresh the GUI and open the `/model`
   picker's **Effort** pane. The Settings → Models page deliberately has no effort
   control: effort is a per-model capability and the models under one provider
   disagree about it.
3. **The wire honours it** — `--probe` sends one minimal request per model and
   records whether the gateway accepted the value. Understand its limit: it proves
   acceptance, **not** that thinking depth actually changed. Only measuring
   reasoning tokens does that, and nothing here claims to.

## Rollback

`--restore latest` restores the newest `settings.yaml.bak*`, keeping the current
state as `settings.yaml.bak-before-restore-<stamp>`. To undo one model, remove its
`reasoningEfforts` (or set `false`) — the levels disappear and the previous
behaviour returns without disturbing the rest of the route.
