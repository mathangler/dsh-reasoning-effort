# dsh-reasoning-effort

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) **agent skill**
that gives every model on a *custom* (hand-declared) provider route the thinking /
reasoning-effort levels it actually has — and diagnoses the three ways a level
picker usually goes wrong.

It exists because DSH's picker shows an **Effort** pane only when the adapter
reports reasoning levels for the selected model, and a hand-declared route never
inherits that metadata: pi-ai is looked up **by route name**, all-or-nothing, so
every model on a route the catalog does not know falls back to `reasoning: false`
and the pane stays empty. This skill derives each model's real level set from the
pi-ai catalog that ships with DSH, writes it as a per-model `reasoningEfforts`
declaration, and refuses to write anything it cannot source.

The guarantee is **coverage**, not best effort: every model on every hand-declared
route ends up with either an explicit `reasoningEfforts` map or an explicit
`reasoningEfforts: false`. A model nothing can source is never left silently
undeclared — on such a route a missing field already *means* "no reasoning" — so
the run stops, prints the question, and exits non-zero until you answer it.

> 中文说明见 [README.zh.md](README.zh.md). What this revision changes, and why:
> [FORK-NOTES.md](FORK-NOTES.md).

## What it does

| Symptom | What this skill does |
| --- | --- |
| The model menu has no 推理等级 / "Effort" pane | Finds every hand-declared route, derives each model's real levels, and declares them |
| A level is listed but a request fails with `does not support reasoning effort` | Reconciles the declaration with the catalog (`--fix`), because a declared map is authoritative and pins undeclared levels to unsupported |
| Levels look wrong — e.g. a model that can no longer stop thinking is offered `Off` | The level set comes from evidence, not a template: a forced-thinking model gets no `off` key at all |
| A config write is refused and the route vanishes from the picker | `check-reasoning-route.mjs` reports compat/protocol mismatches offline, before anything restarts |
| Levels appear but reasoning never changes | `--probe` (opt-in) records whether the gateway accepts the value — and the docs are explicit that acceptance is not proof of behaviour |
| A model is in no catalog and no doc mentions it | Nothing is written. The run stops and asks, offering what *other* gateways say about the same model id, plus the explicit alternatives |

## Install

A directory under the DSH skills root. No build step, no dependencies to install —
`js-yaml` is resolved out of your DSH installation.

**Windows (PowerShell)**

```powershell
$src = "C:\path\to\dsh-reasoning-effort"
$dest = "$env:USERPROFILE\.dsh\skills\dsh-reasoning-effort"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item "$src\SKILL.md","$src\README.md","$src\README.zh.md","$src\FORK-NOTES.md","$src\LICENSE","$src\data","$src\scripts" $dest -Recurse -Force
```

**macOS / Linux**

```sh
src=/path/to/dsh-reasoning-effort
dest="${DSH_HOME:-$HOME/.dsh}/skills/dsh-reasoning-effort"
mkdir -p "$dest"
cp -R "$src"/SKILL.md "$src"/README.md "$src"/README.zh.md "$src"/FORK-NOTES.md "$src"/LICENSE "$src"/data "$src"/scripts "$dest"/
```

The skills root is `${DSH_HOME:-$HOME/.dsh}/skills`. Start a new session (or
reload the skills panel) and the skill is available.

## Use it without an agent

The two scripts are standalone Node ESM. Node is already present — DSH runs on it.

### Apply the levels

```sh
node scripts/apply-reasoning-efforts.mjs                    # dry run (default): print the plan
node scripts/apply-reasoning-efforts.mjs --apply            # back up, write, re-validate
node scripts/apply-reasoning-efforts.mjs --route opencode-go-0
node scripts/apply-reasoning-efforts.mjs --apply --fix      # also reconcile conflicting declarations
node scripts/apply-reasoning-efforts.mjs --apply --probe    # allow 1 minimal live request per model
node scripts/apply-reasoning-efforts.mjs --apply --strict --probe   # write only probe-verified models
node scripts/apply-reasoning-efforts.mjs --restore latest   # roll back to the newest backup

# answer a question nothing could settle, then apply in the same pass
node scripts/apply-reasoning-efforts.mjs --decide 'my-route/my-model=low,high,max' --apply
node scripts/apply-reasoning-efforts.mjs --decide 'my-route/my-model=false'   # it does not reason
node scripts/apply-reasoning-efforts.mjs --decide 'my-route/my-model=skip'    # leave it, stop asking

# see every outcome (declare / ask / non-reasoning) against a fixture, touching nothing real
node scripts/apply-reasoning-efforts.mjs --settings scripts/fixture-settings.yaml
```

A dry run against a typical gateway route looks like this:

| route | model | current | target | evidence | action |
| --- | --- | --- | --- | --- | --- |
| `my-gateway` | `glm-5.3-flash` | (none) | low / high / max | catalog | **declare** |
| `my-gateway` | `deepseek-v4-pro` | (none) | off / high / max | catalog | **declare** |
| `my-gateway` | `minimax-m2.5` | (none) | (none) | unknown | leave alone |

`--apply` then: writes a timestamped backup, re-parses the edited document,
refuses the write if anything outside `llm-pi-ai.providers.*` changed, and reads
every target model back to confirm. The edit is line-level and surgical, so
untouched lines — including comments — survive byte for byte, and re-running is
idempotent.

Exit codes: `0` every model is covered, `1` something is pending or broken — a
change to write, a conflict, a problem, **or a model still waiting on your
decision** — and `2` the environment (install, `js-yaml`, or the settings
document) could not be read.

### Check a route

```sh
node scripts/check-reasoning-route.mjs                  # every route, read-only
node scripts/check-reasoning-route.mjs --route my-route --json
```

Reports per route: hand-declared or catalog-backed, which catalog provider serves
the same base URL, the effective `api` per model, the levels the picker would
offer and where they come from, protocol differences against the catalog, and
whether each `compat` field is accepted on a protocol that carries a model.
Problems (which break resolution) are separated from notices (models with no
evidence — nothing to fix).

Both scripts accept `--settings <path>` and `--dsh-root <path>`; `DSH_ROOT` and
`DSH_HOME` are honoured, and `DSH_NO_SUBPROCESS=1` skips the `where`/`which`
fallback entirely.

## Evidence, not templates

Every declaration carries a source, and the level set is never assumed:

| Evidence | Meaning | Written? |
| --- | --- | --- |
| `probe` | one minimal live request for this model was accepted | yes |
| `vendor` | the provider's own documentation (`data/reasoning-overrides.yaml`, with a URL) | yes |
| `user` | an answer you recorded with `--decide` (`data/user-decisions.yaml`) | yes |
| `catalog` | the pi-ai catalog that ships with DSH | yes |
| `unknown` | nothing sources this model | **no** — the run asks you instead |

This matters more than it sounds. `glm-5.3` and `glm-5.3-flash` **always** reason:
the vendor removed the ability to disable thinking and errors on
`thinking.type: "disabled"`, so their honest declaration is `{low, high, max}` —
with no `off` key. A template would have handed them an `Off` option that fails.

## Verify

1. `node scripts/check-reasoning-route.mjs` — no problems.
2. Refresh the GUI and open the `/model` picker's **Effort** pane. (The
   Settings → Models page deliberately has no effort control: effort is a
   per-model capability and models under one provider disagree about it.)
3. Optional: `--probe` to confirm the gateway *accepts* the value. Acceptance is
   not proof that thinking depth changed — measure reasoning tokens for that.

## Scope and safety

- **Built-in providers are never written.** `llm-deepseek` (provider id
  `deepseek-official`) has a fixed four levels; routes whose key is a pi-ai
  catalog provider id already inherit their metadata. Both are reported read-only.
- **Read-only by default.** Nothing touches `settings.yaml` without `--apply`.
- **Reversible.** Every write is preceded by a timestamped backup;
  `--restore latest` puts it back.
- **No guessing.** A model with no evidence is left exactly as it was.

## Known traps (recorded so they are not rediscovered)

- **`openai-completions` cannot send the gateway's session header.**
  `compat.sendSessionAffinityHeaders` is `"withhold"` in DSH — only the pi-ai
  catalog may set it — so a completions route sends nothing. Declaring effort does
  not change that.
- **A published endpoint table is not authoritative.** A gateway documenting
  `/responses` as serving only some models still served 64 consecutive turns of a
  different model on that path, with no errors. Protocol differences are reported
  as notices, never acted on automatically.
- **`anthropic-messages` maps levels to a thinking budget**, not to an effort
  string, so a declared map's *values* are inert on that protocol — the level set
  is the part that matters.
- **A dynamic Cordis plugin cannot write settings** (realm-sensitive
  `isPlainObject`). Read from a plugin, write to the file.
- **Hot reload is uncertain.** The settings provider is wired to a watcher, yet a
  case of an external edit not being picked up was observed. Refresh first; keep a
  fresh `dsh` start as the fallback. If the Models page holds unsaved state, a
  later GUI write can overwrite a file-level edit.

## License

MIT — see [LICENSE](LICENSE). © 2026 mathangler.
