# dsh-reasoning-effort

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) **agent skill** that
gives every model on a *custom* (hand-declared) provider route the thinking /
reasoning-effort levels it actually has — and answers the one question it cannot answer
itself by asking you, instead of guessing.

Custom here means exactly what DSH means by it: a provider in the `llm-pi-ai` row of the profile
patch whose
key is **not** one of the pi-ai catalog provider ids. Such a route inherits nothing —
pi-ai is looked up **by route name**, all-or-nothing — so every model on it falls back to
`reasoning: false` and the picker shows no effort levels at all. This skill derives each
model's real level set from the catalog DSH ships, writes it as a per-model
`reasoningEfforts` declaration, and refuses to write anything it cannot source.

> 中文说明见 [README.zh.md](README.zh.md). Revision history and the diff against the
> previous published state: [FORK-NOTES.md](FORK-NOTES.md).

## What it guarantees

1. **Coverage.** Every model on every custom route ends up with an explicit declaration:
   a `reasoningEfforts` map, or an explicit `reasoningEfforts: false`. Never left to a
   field's absence — on such a route absence *means* "no reasoning", so an undeclared
   model is indistinguishable from a decision that it does not reason.
2. **Evidence, not templates.** Levels come from the installed pi-ai catalog, from a cited
   provider page, or from a decision you recorded. Nothing is invented.
3. **No guessing.** A model nothing can source is not written: the run lists it with
   concrete recommended level sets and exits non-zero until you answer. Search first, ask
   second.
4. **Built-in providers are never touched.** That is the native `llm-deepseek` namespace,
   all 40 pi-ai catalog provider ids, and any other `llm-*` namespace. It is the *route
   name* that decides, not the vendor: a route called `my-gemini` is custom, a route called
   `google` is the built-in.
5. **No route default, on purpose.** The route-level `reasoning:` field is *never* written and is
   removed when it is found: it applies to every model on the route, so leaving it there pins the
   picker away from `Default` and breaks the route the moment a model that lacks the level is
   added. Each model therefore keeps the gateway's own default — "默认" in the picker — which is
   the one selection every model on the route can accept.
6. **One pass.** A single `--apply` covers new providers, new models, changed models and
   deleted models. It is idempotent and additive: it fills gaps and never rewrites a
   declaration that is already there.
7. **Three platforms.** Windows, macOS and Linux; no dependencies to install, because
   `js-yaml` is resolved out of your DSH installation.

A clean exit (`0`) therefore means *every model on every custom route is covered*.

### Why it behaves the same on every platform and under every model

The scripts are deterministic, so the variance would come from the *choices* made while driving
them. The workflow is therefore a closed loop: one entry point, and no judgement calls.

| Step | Command | Gate |
| --- | --- | --- |
| 1 | `apply-reasoning-efforts.mjs --self-test` | exit `0` = this build behaves as documented on this machine |
| 2 | `apply-reasoning-efforts.mjs --apply --json` | read `verdict`, `nextAction`, `commands` |
| 3 | the `commands` for that `nextAction` | `search-then-ask` and `resolve-conflicts` need the user's answer first |
| 4 | `check-reasoning-route.mjs --json` | `problems` must be `[]` |
| 5 | report the `verdict` verbatim | never claim success while it is not `covered` |

What makes that hold:

- **Unknown flags exit `2`** instead of being ignored. A mistyped `--apply` used to produce a
  complete, plausible report while changing nothing — the one failure mode an agent cannot notice.
- **`--json` is the contract**: `verdict`, `nextAction`, `commands`, `coverage`, `contract`.
- **`--route` marks the run `scope: partial`**, so a narrow run cannot be read as full coverage.
- **Both scripts print `contract 1`**, which `SKILL.md` checks against its own copy, so a stale
  or half-updated install cannot silently diverge.
- **Commands are written one way for all three platforms**: forward slashes, no value quoting, no
  shell redirection, no `VAR=$(...)`.

`SKILL.md` is the execution path — about one page, with no internals in it. `REFERENCE.md` holds
the mechanisms behind it (the catalog-by-route-name rule, the protocol table, why no route default
is ever written, the evidence tiers) and is read only when the user asks why.

## Install

This skill is DSH-specific: it understands DSH's profile-patch schema (the `llm-pi-ai` row and its
`config.providers`), DSH's pi-ai catalog
and DSH's adapters, and it has nothing to offer any other agent. So it belongs in **DSH's
own skills root** — the `.dsh` one, never the shared `.agents/skills` root:

| Scope | Directory |
| --- | --- |
| user (recommended) | `$DSH_HOME/skills/dsh-reasoning-effort` — by default `~/.dsh/skills/dsh-reasoning-effort` |
| project | `<project>/.dsh/skills/dsh-reasoning-effort` |

### With git — recommended, because it also gives you updates

Clone straight into place, so the skill directory *is* the checkout:

**macOS / Linux**

```sh
git clone https://github.com/mathangler/dsh-reasoning-effort.git \
  "${DSH_HOME:-$HOME/.dsh}/skills/dsh-reasoning-effort"
```

**Windows (PowerShell)**

```powershell
git clone https://github.com/mathangler/dsh-reasoning-effort.git `
  "$env:USERPROFILE\.dsh\skills\dsh-reasoning-effort"
```

There is nothing to build and nothing to install: both scripts are plain Node ESM and
resolve `js-yaml` out of your DSH installation. A `.git` directory inside the skills root is
harmless — DSH looks for `SKILL.md` and reads the rest as resources.

For project scope, run the same command from the project root with
`.dsh/skills/dsh-reasoning-effort` as the destination.

### From a local copy

Use this if you would rather not keep a checkout inside the skills root.

**macOS / Linux**

```sh
src=/path/to/dsh-reasoning-effort
dest="${DSH_HOME:-$HOME/.dsh}/skills/dsh-reasoning-effort"
mkdir -p "$dest"
cp -R "$src"/SKILL.md "$src"/README.md "$src"/README.zh.md "$src"/FORK-NOTES.md \
      "$src"/LICENSE "$src"/data "$src"/scripts "$dest"/
```

**Windows (PowerShell)**

```powershell
$src  = 'C:\path\to\dsh-reasoning-effort'
$dest = "$env:USERPROFILE\.dsh\skills\dsh-reasoning-effort"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item "$src\SKILL.md","$src\README.md","$src\README.zh.md","$src\FORK-NOTES.md","$src\LICENSE","$src\data","$src\scripts" $dest -Recurse -Force
```

### When `git` cannot reach GitHub

Some sandboxes block git's transport — TCP to github.com times out, Windows schannel has no
credential handle, ssh is refused. Fetch the installer through a channel that does work
(here, the GitHub API via `gh`) and let it verify every file against the published blob ids:

**macOS / Linux**

```sh
gh api -H 'Accept: application/vnd.github.raw' \
  repos/mathangler/dsh-reasoning-effort/contents/scripts/install-from-github.mjs \
  > /tmp/install-from-github.mjs
GH_TOKEN=$(gh auth token) node /tmp/install-from-github.mjs \
  "$HOME/.dsh/skills/dsh-reasoning-effort"
```

**Windows (PowerShell)**

```powershell
gh api -H 'Accept: application/vnd.github.raw' `
  repos/mathangler/dsh-reasoning-effort/contents/scripts/install-from-github.mjs |
  Set-Content -Path "$env:TEMP\install-from-github.mjs" -Encoding utf8
$env:GH_TOKEN = (gh auth token)
node "$env:TEMP\install-from-github.mjs" "$env:USERPROFILE\.dsh\skills\dsh-reasoning-effort"
```

It resolves the published commit's tree, downloads the blobs, recomputes each git blob id,
and refuses to write anything that does not match — so what lands is provably the published
tree, not a copy of someone's working directory. `scripts/publish-via-api.mjs` is its
counterpart for pushing.

### Update

| Installed with | Update with |
| --- | --- |
| git clone | `git -C "${DSH_HOME:-$HOME/.dsh}/skills/dsh-reasoning-effort" pull --ff-only` |
| local copy | re-run the copy, or the API installer (it replaces the directory wholesale) |

Windows:

```powershell
git -C "$env:USERPROFILE\.dsh\skills\dsh-reasoning-effort" pull --ff-only
```

**Read this before your first pull.** `data/reasoning-overrides.yaml` and
`data/user-decisions.yaml` are *your* inputs — the vendor facts you cited and the answers
you gave with `--decide`. If you edited them in place, a pull can conflict. Either keep
those edits on a branch of your own, or keep your entries in a file outside the checkout.
The scripts never write to them on their own.

After updating, re-check and re-apply:

```sh
node scripts/check-reasoning-route.mjs
node scripts/apply-reasoning-efforts.mjs --apply
```

### Uninstall

**macOS / Linux**

```sh
rm -rf "${DSH_HOME:-$HOME/.dsh}/skills/dsh-reasoning-effort"
```

**Windows (PowerShell)**

```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\skills\dsh-reasoning-effort"
```

For a project-scoped install, delete `<project>/.dsh/skills/dsh-reasoning-effort` the same
way.

**Uninstalling the skill does not undo its edits.** The `reasoningEfforts` declarations and the
removal of a route-level `reasoning:` stay in the profile patch — they are ordinary configuration,
not something the skill injects at runtime. Run `--restore latest` *before* removing the directory
(see [Rollback](#rollback)), or delete the declarations by hand.

### Where DSH looks for skills

Reference, so the precedence is not a surprise. Lower rank wins, and a skill is identified
by its `name` — two copies with the same name resolve to the lower-ranked one.

| Root | Rank | Notes |
| --- | --- | --- |
| `<project>/.dsh/skills` | 100 | project scope, DSH-specific — the project home for this skill |
| `<project>/.agents/skills` | 200 | project scope, shared between agents |
| custom directories | 300 | configured by the host |
| `$DSH_HOME/skills` | 400 | user scope, DSH-specific — the recommended home for this skill |
| `$DSH_AGENTS_HOME/skills` | 500 | user scope, shared between agents |
| bundled with DSH | 600 | ships with the harness |

`DSH_HOME` and `DSH_AGENTS_HOME` move the two user roots.

## Use it

Type `/` in the composer and pick **`dsh-reasoning-effort`**. The skill is deliberately
`disable-model-invocation: true`, so the agent never reaches for it on its own — the `/`
menu marks it *user only* — which is the right default for something that edits your
configuration. You can also ask the agent to use it by name.

Then the whole job is one command — but run the gate first:

```sh
node scripts/apply-reasoning-efforts.mjs --self-test   # exit 0 = this build behaves as documented
node scripts/apply-reasoning-efforts.mjs --apply       # the whole job
```

It scans every custom route, inserts what is missing, removes a route-level default it finds,
backs the document up first, validates the result path by path, and reports. Two things can
remain, and neither is a silent failure:

| Left over | Why | What the run does |
| --- | --- | --- |
| a model reported as `needs-decision` | nothing sources it | lists it with recommended level sets, exits `1`; search first, then ask |
| a declaration that contradicts the evidence | you configured it by hand | reports a conflict, exits `1`; `--fix` reconciles it |

## Configure

### What it writes, and into which file

The document is a **profile patch** — `$DSH_HOME/profiles/<profile>/cordis.patch.yml` — which is
where DSH 0.1.7 keeps its settings (it imports the old `settings.yaml` once at boot and renames it,
so the old file is no longer read). The skill finds the patch itself; `--settings <path>` pins one
when a machine has several.

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      my-gateway:                     # a custom route: the key is not a catalog provider id
        baseURL: https://…
        api: openai-completions
        # no `reasoning:` here, ever: it is route-wide, and one model without that level
        # (a non-reasoning model included) would fail every request with
        # UNSUPPORTED_REASONING_EFFORT. The picker's "默认" row is the intended state.
        models:
          - id: glm-5.3
            reasoningEfforts:         # the levels this model really has — no `off`, it is
              low: low                # a model that always thinks
              high: high
              max: max
          - id: a-model-that-does-not-reason
            reasoningEfforts: false   # explicit, never merely absent
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    reasoningEffort: high             # the picker's field for new sessions: written by the GUI,
                                      # removed by this skill only if the default model cannot take it
```

Only the `llm-pi-ai` row's `config.providers` and that one `agent-default-model` field are ever
touched, and every other row comes back byte for byte. Built-in routes (a provider key that *is* a
catalog id) and the `llm-deepseek` row are listed read-only and never written.

### Two rules about the defaults, both learned the hard way

- **A route-level `reasoning:` is applied to every model on the route**, and DSH throws
  `UNSUPPORTED_REASONING_EFFORT` for a model that does not offer it — including a model that declares
  no levels at all and one that does not reason. So the writer never creates the field, and removes
  it wherever it finds it, whether or not a model currently objects to it: keeping a *currently safe*
  value would still pin the picker away from `Default` and re-arm the same failure for the next model
  added through the GUI. With no route default, `Default` is what the picker shows — and that is the
  point. A run cannot be `covered` while any custom route still carries the field.
- **`agent-default-model.reasoningEffort` is never written.** It is the picker's own field — the
  initial level for a *new* session, rewritten whenever you pick a model or a level — so the writer
  does not clear a choice you made. It removes the value only when it can prove the configured
  default model does not offer that level, which would fail the first request of every new session.

### The two data layers

| File | Holds | Evidence |
| --- | --- | --- |
| `data/reasoning-overrides.yaml` | cited provider facts | `vendor`, with a `source` URL |
| `data/user-decisions.yaml` | answers you gave when nothing could be sourced | `user` |

Both are inputs, not generated state: edit them by hand or let `--decide` write them.

```sh
# a searched fact — needs a citation, and lands in the cited layer
node scripts/apply-reasoning-efforts.mjs --evidence vendor --source <url> \
  --decide 'my-gateway/my-model=low,high,max' --apply

# your answer to a question the tool refused to guess at
node scripts/apply-reasoning-efforts.mjs --decide 'my-gateway/my-model=off,low,high,max' --apply
node scripts/apply-reasoning-efforts.mjs --decide 'my-gateway/my-model=false'   # does not reason
node scripts/apply-reasoning-efforts.mjs --decide 'my-gateway/my-model=skip'    # leave it, stop asking
```

### Flags

| Flag | Effect |
| --- | --- |
| *(none)* | dry run: print the plan, change nothing |
| `--apply` | write (backup → edit → re-parse → path-scoped diff → read-back → write) |
| `--route <name>` | limit to a route (repeatable) |
| `--fix` | also reconcile a declaration that contradicts the evidence |
| `--probe` | allow **one** minimal live request per model, to record acceptance (it costs money) |
| `--strict` | write only models whose evidence is a live probe |
| `--fix-routes` | migrate a model whose catalog protocol differs from its route's — requires an explicit `--route`, because a gateway does not always follow its catalog and this can break a working route |
| `--restore latest\|<file>` | roll the profile patch back to its backup |
| `--timestamped-backup` | name each backup with a timestamp instead of overwriting the single one |
| `--report <path>` / `--json` | persist the markdown report / emit machine-readable output (`verdict`, `nextAction`, `commands`, `coverage`, `contract`) |
| `--self-test` | drive the writer against both shipped fixtures and assert the contract; the gate to run first |
| *(anything unrecognised)* | rejected with exit `2` before a single file is read — never silently ignored |
| `--settings <path>` / `--dsh-root <path>` | point at another document / install |

Exit codes: `0` every custom route **in scope** is covered (with `--route` the scope is that
route, and the tool says `scope: partial`), `1` something is pending or broken, `2` the
environment or the invocation is unusable.

### Environment

| Variable | Meaning |
| --- | --- |
| `DSH_HOME` | DSH home (default `~/.dsh`) — where `profiles/` (the profile patches) and the native skills root live |
| `DSH_AGENTS_HOME` | the shared user skills root (default `~/.agents`) |
| `DSH_ROOT` | the DSH install holding `node_modules`; `--dsh-root` overrides it |
| `DSH_NO_SUBPROCESS=1` | skip the `where`/`which` fallback in install discovery |

## Verify

1. **Config resolves** — `node scripts/check-reasoning-route.mjs` reports no problems.
2. **The picker offers what it should** — refresh the GUI and open the `/model` picker's
   **Effort** pane: a reasoning model lists exactly the levels the report gave it and comes up on
   **默认**, and a model declared `false` has no effort pane at all.
3. **The wire honours it** — `--probe` records whether the gateway accepted the value.
   Understand its limit: acceptance is not proof that thinking depth changed.

To see every outcome (declare / ask / non-reasoning, the built-in boundary, and the two kinds of
route default) without touching a real install:

```sh
node scripts/apply-reasoning-efforts.mjs --settings scripts/fixture-settings.yaml
node scripts/apply-reasoning-efforts.mjs --settings scripts/fixture-builtin-settings.yaml
node scripts/apply-reasoning-efforts.mjs --settings scripts/fixture-breaking-default.yaml
node scripts/apply-reasoning-efforts.mjs --settings scripts/fixture-pinned-default.yaml
```

## Rollback

Exactly one backup file is kept per document: `cordis.patch.yml.bak-reasoning-efforts`, beside the
patch, overwritten on every write and always holding the state from *before* the last operation. It
is a one-step undo, not an archive. `--restore latest` restores it and moves the state it replaced
back into the same file, so restoring twice toggles between the two states. To undo a single model,
delete its `reasoningEfforts` (or set `false`) — the levels disappear and the previous behaviour
returns without disturbing the rest of the route. Pass `--timestamped-backup` if you would rather
have timestamped copies.

## Known traps

- **`openai-completions` cannot send the gateway's session header.** `compat.sendSessionAffinityHeaders`
  is `"withhold"` in DSH — only the pi-ai catalog may set it — so a completions route sends
  nothing. Declaring effort does not change that.
- **A published endpoint table is not authoritative.** A gateway documenting `/responses`
  as serving only some models served 64 consecutive turns of a different model on that
  path, with no errors. Protocol differences are reported as notices, never acted on.
- **A route default is route-scoped.** The config schema has no per-model default, so the field
  applies to every model on the route: one model that does not offer the level — including a
  non-reasoning model — fails with `UNSUPPORTED_REASONING_EFFORT`, and the picker's `Default` row
  disappears for all of them. That is why the writer never writes it and always removes it. If you
  *want* a pinned default, set it by hand and accept that the next model you add through the GUI can
  break the route; the skill will report and remove it on its next run.
- **`anthropic-messages` maps levels to a thinking budget**, not to an effort string, so a
  declared map's values are inert there — the level set is the part that matters.
- **A dynamic Cordis plugin cannot write settings** (realm-sensitive `isPlainObject`). Read
  from a plugin, write to the file.
- **Hot reload is uncertain.** The settings provider is wired to a watcher, yet a case of an
  external edit not being picked up was observed. Refresh first; keep a fresh `dsh` start as
  the fallback. If the Models page holds unsaved state, a later GUI write can overwrite a
  file-level edit.

## License

MIT — see [LICENSE](LICENSE). © 2026 mathangler.
