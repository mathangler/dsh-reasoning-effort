---
name: dsh-reasoning-effort
description: Give every model on a custom (hand-declared) DSH provider route the thinking / reasoning-effort levels it actually has — a `reasoningEfforts` map for models that reason, an explicit `false` for those that do not, and a route-level default so the picker stops offering "Default". Built-in providers are never touched; a model nothing can source is researched and then put to the user as a question instead of being guessed at. Use when a model menu shows no 推理等级 / effort submenu, when a level returns UNSUPPORTED_REASONING_EFFORT, when models were added under `llm-pi-ai.providers` in settings.yaml, or when the user asks 怎么调思考等级 / 调整思考强度 / 加推理等级 / reasoning effort / thinking budget.
disable-model-invocation: true
---

# dsh-reasoning-effort

Every model on a hand-declared `llm-pi-ai.providers` route gets an explicit reasoning-effort
declaration, so the picker offers real levels instead of a "Default" row. Built-in providers
are never written. A model nothing can source is researched, then asked about — never guessed.

**Contract version 1.** If a script prints a different `contract` number, stop and tell the
user to reinstall: the files on disk do not match this document.

`$SKILL` below is this skill's directory, given to you when the skill loads (by default
`~/.dsh/skills/dsh-reasoning-effort`). Paths use forward slashes on purpose — they work
unchanged on Windows, macOS and Linux, and no value here needs quoting.

## Do exactly this

Five steps, in order. Do not improvise, and do not hand-edit YAML.

**1. Gate.**

```
node $SKILL/scripts/apply-reasoning-efforts.mjs --self-test
```

Exit `0` means this build behaves as documented on this machine. Anything else: show the
output and stop — do not go near the user's settings.

**2. Apply, and read the verdict.**

```
node $SKILL/scripts/apply-reasoning-efforts.mjs --apply --json
```

Read only `verdict`, `nextAction`, `commands` and `coverage` from the JSON. The Chinese
markdown report is for showing the user, not for you to interpret.

**3. `nextAction` decides what happens next — nothing else does.**

| `nextAction` | What you do |
| --- | --- |
| `none` | nothing pending; go to step 4 |
| `apply` | run the command in `commands`, then step 4 |
| `search-then-ask` | For each `commands` entry, first **research the model**: the provider's own documentation (`reasoning_effort`, `thinking.type`, `enable_thinking`, `thinking_budget`, `output_config.effort`), then models.dev. Found a citable page? Record what it documents with `--evidence vendor --source <url>`. Found nothing? **Ask the user** which of the listed commands to run, quoting the recommended level sets. Never pick a level set yourself. |
| `resolve-conflicts` | Tell the user which declarations disagree with the evidence, and run the `--fix` command only if they agree. |
| `report-blocker` | Nothing was written. Show the `❌` line and stop. |

**4. Verify.**

```
node $SKILL/scripts/check-reasoning-route.mjs --json
```

`problems` must be `[]`. Anything else is a finding to report, not to fix by hand.

**5. Report.** Quote the tool's `verdict` verbatim, list `coverage` per route, and name every
model still undecided. Then tell the user to open the `/model` picker's **Effort** pane: the
`Default` row should be gone and `High` preselected.

## Never

- Never edit `settings.yaml` yourself. The writer edits it with a backup and a path-scoped
  validation; a hand edit bypasses both.
- Never invent a level set, and never invent a source URL. `unknown` means ask.
- Never write to a route whose name is a pi-ai catalog id, or to `llm-deepseek`. Those are
  built-ins — the tool refuses anyway, so do not spend a turn trying.
- Never use these on your own initiative; they exist for the human: `--fix`, `--fix-routes`,
  `--restore`, `--probe`, `--strict`, `--dsh-root`, `--default-effort`.
- Never pass a flag that is not in `--help`. Unknown flags exit `2` by design; if you saw
  that error, fix your command rather than working around it.
- Never report success without step 4, and never report success while `verdict` is anything
  other than `covered`.

## Reading the tool

- Exit codes: `0` every custom route in scope is covered · `1` something is pending or broken ·
  `2` the environment or the invocation is unusable.
- `--decide <route>/<model>=<levels|false|skip>` records an answer; `--evidence vendor
  --source <url>` records a researched fact instead of a decision.
- One `--apply` covers new providers, new models, changed models and deleted models. It is
  idempotent and **additive**: it fills gaps and never rewrites a declaration that is already
  there (that needs `--fix`, which is the user's call).
- `--route` narrows the run to one route; the tool then reports `scope: partial`, and `exit 0`
  only means *those* routes are covered. Only use it when the user asks about one route.
- A route-level default is applied to **every** model on the route, so the writer removes one that
  a model cannot accept — that is the single repair it performs, and it re-adds the default once
  every model supports a level again. Never put it back by hand.
- Some routes can never carry a default: if any model on the route declares no levels at all, DSH
  would throw for that model. The report says so under 默认档位 and `routeDefaultsUnmet`; the fix
  is to give those models their own route, and that is the user's call, not yours.

## When the user asks "why"

Read `REFERENCE.md` in this skill and answer from it: the catalog-by-route-name rule, the seven
levels and what a declaration pins, the protocol differences and the session-header trap, why a
route default is route-scoped, the evidence tiers, and the write-path guarantees.
