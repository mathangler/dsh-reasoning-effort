---
name: dsh-reasoning-effort
description: Give every model on a custom (hand-declared) DSH provider route the thinking / reasoning-effort levels it actually has — a `reasoningEfforts` map for models that reason, an explicit `false` for those that do not, and no route-level default, so each model keeps the gateway's own default ("默认"). Built-in providers are never touched; a model nothing can source is researched and then put to the user as a question instead of being guessed at. Use when a model menu shows no 推理等级 / effort submenu, when a level returns UNSUPPORTED_REASONING_EFFORT, when a provider or model was added in the DSH GUI, or when the user asks 怎么调思考等级 / 调整思考强度 / 加推理等级 / reasoning effort / thinking budget.
disable-model-invocation: true
---

# dsh-reasoning-effort

Every model on a hand-declared provider route gets an explicit reasoning-effort declaration, so
the picker offers the levels the model really has. No route-level default is ever written: each
model keeps the gateway's own default ("默认"), which is the one value every model can accept.
Built-in providers are never written. A model nothing can source is researched, then asked
about — never guessed.

**The document is a DSH profile patch**: `$DSH_HOME/profiles/<profile>/cordis.patch.yml`, a
top-level sequence of loader entries where the `llm-pi-ai` row carries `config.providers.<route>`.
The tools find it themselves (an explicit `--settings <path>` overrides that), so no path has to be
guessed. `settings.yaml` is *not* used: DSH 0.1.7 imports it once at boot and renames it, so writing
it would change nothing.

**Two distributions ship DSH, and each has its own profile.** The desktop app creates and uses
`desktop`; the CLI uses `web` / `headless`. Both keep everything under the same `$DSH_HOME`, so the
skill is installed once and serves both — but each one's providers live in **its own** patch. A run
resolves the profile from `DSH_PROFILE_DIR` / `DSH_PROFILE`, which every command inside a DSH
session inherits, and reports it as `distribution`: it configures the build it is running in, never
the other one. From a plain shell (no DSH environment) with more than one candidate, it stops with
`exit 2` and lists them instead of choosing.

**If `node` is not usable, use the shipped wrapper.** The desktop build carries its own Node, and a
machine can have a `node` on PATH that does not run (an nvm shim with no active version):

```
$SKILL/scripts/run-apply.cmd <args>       Windows
$SKILL/scripts/run-apply.sh  <args>       macOS / Linux
$SKILL/scripts/run-check.cmd|sh <args>    the read-only checker, same resolution
```

Each wrapper uses the Node of the build it is in: `$DSH_SKILL_NODE` if set, then — in a desktop
session — the desktop build's own Node, then `node` on PATH *(verified by running it, not just
found)*, then the desktop's Node again as a fallback for a machine whose PATH has no usable node,
then the app's executable run as Node, and only then `exit 2` listing what it tried.

**Contract version 1.** If a script prints a different `contract` number, stop and tell the
user to reinstall: the files on disk do not match this document.

`$SKILL` below is this skill's directory, given to you when the skill loads (by default
`~/.dsh/skills/dsh-reasoning-effort`). **Arguments** use forward slashes on purpose — they work
unchanged on Windows, macOS and Linux and need no quoting. The one exception is a Windows wrapper
that the shell has to *execute*: give that path backslashes (`$SKILL\scripts\run-apply.cmd`),
because cmd splits `scripts/run-apply.cmd` at the slash and tries to run `scripts`. PowerShell accepts
either. Quote the path if the skills directory contains a space.

## Do exactly this

Five steps, in order, through the wrapper. Do not improvise, do not substitute flags, and do not
hand-edit YAML. The wrapper picks the Node to use — the desktop build's own Node first when the
desktop build is installed, because that one is always present and matches the app; otherwise `node`
on PATH — and **every run prints the `node` it used**, so this can be confirmed instead of assumed.

| | command form |
| --- | --- |
| Windows | `$SKILL\scripts\run-apply.cmd <args>` |
| macOS / Linux | `sh $SKILL/scripts/run-apply.sh <args>` |

The read-only checker has the same pair: `run-check.cmd` / `run-check.sh`.

**1. Gate.**

```
$SKILL\scripts\run-apply.cmd --self-test          Windows
sh $SKILL/scripts/run-apply.sh --self-test        macOS / Linux
```

Exit `0` means this build behaves as documented on this machine. Anything else: show the
output and stop — do not go near the user's settings.

**2. Apply, and read the verdict.**

```
$SKILL\scripts\run-apply.cmd --apply --json          Windows
sh $SKILL/scripts/run-apply.sh --apply --json        macOS / Linux
```

Read only `verdict`, `nextAction`, `commands` and `coverage` from the JSON. Everything else — the
Chinese markdown report, `plan`, `flavor`, `node` — is for showing the user.

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
$SKILL\scripts\run-check.cmd --json          Windows
sh $SKILL/scripts/run-check.sh --json        macOS / Linux
```

`problems` must be `[]`. Anything else is a finding to report, not to fix by hand.

**5. Report.** Quote the tool's `verdict` verbatim, list `coverage` per route, and name every
model still undecided. Then tell the user to open the `/model` picker's **Effort** pane: a
reasoning model lists exactly the levels `coverage` reports and comes up on **默认**, and a model
declared `false` has no effort pane at all.

## Never

- Never edit the profile patch yourself. The writer edits it with a backup, a path-scoped
  validation and a read-back; a hand edit bypasses all three.
- Never invent a level set, and never invent a source URL. `unknown` means ask.
- Never write to a route whose name is a pi-ai catalog id, or to `llm-deepseek`. Those are
  built-ins — the tool refuses anyway, so do not spend a turn trying.
- Never use these on your own initiative; they exist for the human: `--fix`, `--fix-routes`,
  `--restore`, `--probe`, `--strict`, `--dsh-root`.
- Never pass a flag that is not in `--help`. Unknown flags exit `2` by design; if you saw
  that error, fix your command rather than working around it.
- Never report success without step 4, and never report success while `verdict` is anything
  other than `covered`.

## Reading the tool

- Exit codes: `0` every custom route in scope is covered · `1` something is pending or broken ·
  `2` the environment or the invocation is unusable.
- The run states two facts you never have to infer: `flavor` (`distribution` in the text) — the
  build whose document is being edited, `desktop` or `cli`, and why it thinks so — and `node` — the
  Node that ran the script. If `flavor.kind` is not the build the user is sitting in, stop and report
  that instead of editing.
- `exit 2` with a list of profile patches means the profile could not be decided (a plain shell with
  no DSH environment and several candidates). Do not pick one: ask, or use `--settings <path>`.
- `--decide <route>/<model>=<levels|false|skip>` records an answer; `--evidence vendor
  --source <url>` records a researched fact instead of a decision.
- One `--apply` covers new providers, new models, changed models and deleted models. It is
  idempotent and **additive**: it fills gaps and never rewrites a declaration that is already
  there (that needs `--fix`, which is the user's call).
- `--route` narrows the run to one route; the tool then reports `scope: partial`, and `exit 0`
  only means *those* routes are covered. Only use it when the user asks about one route.
- A route-level `reasoning:` is **never** written, and is removed whenever it is present — whether
  or not a model currently objects to it. DSH applies that value to every model on the route, so
  one model without that level (a non-reasoning model included) fails every request with
  `UNSUPPORTED_REASONING_EFFORT`. That removal is the only repair the writer performs; never put
  the field back by hand, and never "fix" a route by giving models a route of their own.
- `agent-default-model.reasoningEffort` is the picker's own field — the level a *new* session
  starts on, and the user's choice. The writer leaves it alone unless it can prove the configured
  default model does not offer that level, which would fail the first request of every new session.
- With no route default, `Default` is what the picker shows, and that is the intended state: it is
  the only selection every model on the route can accept.

## When the user asks "why"

Read `REFERENCE.md` in this skill and answer from it: where the settings live now, the
catalog-by-route-name rule, the seven levels and what a declaration pins, the protocol differences
and the session-header trap, why a route default is route-scoped, the evidence tiers, and the
write-path guarantees.
