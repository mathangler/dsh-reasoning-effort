# dsh-reasoning-effort

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) **agent skill** that
gives every model on a *custom* (hand-declared) provider route the thinking /
reasoning-effort levels it actually has — and answers the one question it cannot answer
itself by asking you, instead of guessing.

Custom here means exactly what DSH means by it: a route under `llm-pi-ai.providers` whose
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
5. **No "Default".** A reasoning model is given the route-level `reasoning: high`
   (configurable) so the picker drops its "Default" row and pins the level — plus
   `agent-default-model.reasoningEffort: high` for new sessions.
6. **One pass.** A single `--apply` covers new providers, new models, changed models and
   deleted models. It is idempotent and additive: it fills gaps and never rewrites a
   declaration that is already there.
7. **Three platforms.** Windows, macOS and Linux; no dependencies to install, because
   `js-yaml` is resolved out of your DSH installation.

A clean exit (`0`) therefore means *every model on every custom route is covered*.

## Install

**This skill belongs in DSH's own skills root** — `$DSH_HOME/skills`, i.e.
`~/.dsh/skills/dsh-reasoning-effort`, or `<project>/.dsh/skills/dsh-reasoning-effort` for
project scope. It is DSH-specific: it knows DSH's `settings.yaml` schema, DSH's pi-ai
catalog and DSH's adapters, and it has nothing to offer another agent. The shared
`.agents/skills` root is for skills several agents use, so do not put this one there.

### A — copy it into `~/.dsh/skills` (recommended)

**Windows (PowerShell)**

```powershell
$src  = 'C:\path\to\dsh-reasoning-effort'
$dest = "$env:USERPROFILE\.dsh\skills\dsh-reasoning-effort"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item "$src\SKILL.md","$src\README.md","$src\README.zh.md","$src\FORK-NOTES.md","$src\LICENSE","$src\data","$src\scripts" $dest -Recurse -Force
```

**macOS / Linux**

```sh
src=/path/to/dsh-reasoning-effort
dest="${DSH_HOME:-$HOME/.dsh}/skills/dsh-reasoning-effort"
mkdir -p "$dest"
cp -R "$src"/SKILL.md "$src"/README.md "$src"/README.zh.md "$src"/FORK-NOTES.md \
      "$src"/LICENSE "$src"/data "$src"/scripts "$dest"/
```

### B — clone, then copy

```sh
git clone https://github.com/mathangler/dsh-reasoning-effort /tmp/dsh-reasoning-effort
mkdir -p "${DSH_HOME:-$HOME/.dsh}/skills/dsh-reasoning-effort"
cp -R /tmp/dsh-reasoning-effort/SKILL.md /tmp/dsh-reasoning-effort/data \
      /tmp/dsh-reasoning-effort/scripts \
      "${DSH_HOME:-$HOME/.dsh}/skills/dsh-reasoning-effort/"
```

### C — when `git` cannot reach GitHub

Some sandboxes block git's transport (TCP to github.com times out, Windows schannel has no
credential handle, ssh is refused). The content can still be installed through the GitHub
API, with every file verified by recomputing git's blob id:

```sh
GH_TOKEN=$(gh auth token) node scripts/install-from-github.mjs "$HOME/.dsh/skills/dsh-reasoning-effort"
```

PowerShell equivalent:

```powershell
$env:GH_TOKEN = (gh auth token)
node scripts\install-from-github.mjs "$env:USERPROFILE\.dsh\skills\dsh-reasoning-effort"
```

The tarball is fetched from the published commit, so the installed tree is provably the
published tree rather than a copy of a local working directory.
`scripts/publish-via-api.mjs` is its counterpart — it pushes a local commit through the
same API, verifying the created tree against the local one before moving the branch.

### D — `npx skills`, used only to fetch

[`skills`](https://github.com/vercel-labs/skills) is the ecosystem CLI, and it is the
easiest way to pull this skill's files onto a machine. **It cannot install into `.dsh`**:
it knows 75+ agents but has no `dsh` target, so it writes to an agent directory instead —
and for the group whose path is `.agents/skills/` that means the *shared* root, which is
the wrong home for a DSH-specific skill. Use it as a fetch step, then move the directory
where it belongs:

```bash
npx skills add mathangler/dsh-reasoning-effort --list      # discover without installing
npx skills add mathangler/dsh-reasoning-effort -g -a cline -y --copy
```

```powershell
# then relocate it into DSH's own root, and do not keep both copies
Move-Item "$env:USERPROFILE\.agents\skills\dsh-reasoning-effort" `
          "$env:USERPROFILE\.dsh\skills\dsh-reasoning-effort"
```

- `-a cline` is any agent whose path is `.agents/skills/` (`cline`, `dexto`,
  `kimi-code-cli`, `loaf`, `sarvam-code`, `warp`, `zed`); they are interchangeable here.
- `-g` installs to `~/.agents/skills/`, without it to `./.agents/skills/`.
- `--copy` makes it a real directory instead of a symlink.
- Keeping both copies is harmless but confusing: the `.dsh` copy wins the ranking below,
  so the `.agents` one silently does nothing.

Managing that fetch-install, and skills in general:

```bash
npx skills ls -g                                  # what is installed
npx skills update -g                              # pull the latest revision
npx skills remove -g -a cline dsh-reasoning-effort -y
npx skills find reasoning                         # search the ecosystem
npx skills init my-skill                          # scaffold a new skill
npx skills use mathangler/dsh-reasoning-effort --skill dsh-reasoning-effort --agent claude-code
```

Environment: `DISABLE_TELEMETRY=1` / `DO_NOT_TRACK=1` turn off the CLI's telemetry;
`GITHUB_TOKEN` / `GH_TOKEN` are only needed for private sources or API rate limits.

### Where DSH looks for skills

| Root | Rank | Notes |
| --- | --- | --- |
| `<project>/.dsh/skills` | 100 | project scope, DSH-specific — **use this for project scope** |
| `<project>/.agents/skills` | 200 | project scope, shared between agents |
| custom directories | 300 | configured by the host |
| `$DSH_HOME/skills` | 400 | user scope, DSH-specific (default `~/.dsh/skills`) — **the recommended home** |
| `$DSH_AGENTS_HOME/skills` | 500 | user scope, shared between agents (default `~/.agents/skills`) |
| bundled with DSH | 600 | ships with the harness |

Lower rank wins, and a skill is identified by its `name`: two copies with the same name
resolve to the lower-ranked one, which is why a `.dsh` copy shadows a `.agents` copy.
`DSH_HOME` and `DSH_AGENTS_HOME` move the two user roots.

## Use it

Type `/` in the composer and pick **`dsh-reasoning-effort`**. The skill is deliberately
`disable-model-invocation: true`, so the agent never reaches for it on its own — the `/`
menu marks it *user only* — which is the right default for something that edits your
configuration. You can also ask the agent to use it by name.

Then the whole job is one command:

```sh
node scripts/apply-reasoning-efforts.mjs --apply
```

It scans every custom route, inserts what is missing, writes the route default, backs the
document up first, validates the result path by path, and reports. Two things can remain,
and neither is a silent failure:

| Left over | Why | What the run does |
| --- | --- | --- |
| a model reported as `needs-decision` | nothing sources it | lists it with recommended level sets, exits `1`; search first, then ask |
| a declaration that contradicts the evidence | you configured it by hand | reports a conflict, exits `1`; `--fix` reconciles it |

## Configure

### What it writes into `settings.yaml`

```yaml
llm-pi-ai:
  providers:
    my-gateway:                       # a custom route: the key is not a catalog provider id
      baseURL: https://…
      api: openai-completions
      reasoning: high                 # → defaultEffort: removes the picker's "Default" row
      models:
        - id: glm-5.3
          reasoningEfforts:           # the levels this model really has — no `off`, it is
            low: low                  # a model that always thinks
            high: high
            max: max
        - id: a-model-that-does-not-reason
          reasoningEfforts: false     # explicit, never merely absent
agent-default-model:
  reasoningEffort: high               # the initial selection for new sessions
```

Built-in routes and the `llm-deepseek` namespace are listed read-only and never written.

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
| `--default-effort <level\|skip>` | the level pinned as default (default `high`; `skip` disables those writes) |
| `--probe` | allow **one** minimal live request per model, to record acceptance (it costs money) |
| `--strict` | write only models whose evidence is a live probe |
| `--fix-routes` | migrate a model whose catalog protocol differs from its route's — requires an explicit `--route`, because a gateway does not always follow its catalog and this can break a working route |
| `--restore latest\|<file>` | roll the settings document back to a backup |
| `--report <path>` / `--json` | persist the markdown report / emit machine-readable output |
| `--settings <path>` / `--dsh-root <path>` | point at another document / install |

Exit codes: `0` every model covered, `1` something is pending or broken, `2` the
environment could not be read.

### Environment

| Variable | Meaning |
| --- | --- |
| `DSH_HOME` | DSH home (default `~/.dsh`) — where `settings.yaml` and the native skills root live |
| `DSH_AGENTS_HOME` | the shared user skills root (default `~/.agents`) |
| `DSH_ROOT` | the DSH install holding `node_modules`; `--dsh-root` overrides it |
| `DSH_NO_SUBPROCESS=1` | skip the `where`/`which` fallback in install discovery |

## Verify

1. **Config resolves** — `node scripts/check-reasoning-route.mjs` reports no problems.
2. **The picker offers what it should** — refresh the GUI and open the `/model` picker's
   **Effort** pane: the `Default` row is gone, `High` is preselected, and each model shows
   its real levels (a forced-thinking model has no `Off`).
3. **The wire honours it** — `--probe` records whether the gateway accepted the value.
   Understand its limit: acceptance is not proof that thinking depth changed.

To see every outcome (declare / ask / non-reasoning, plus the built-in boundary) without
touching a real install:

```sh
node scripts/apply-reasoning-efforts.mjs --settings scripts/fixture-settings.yaml
node scripts/apply-reasoning-efforts.mjs --settings scripts/fixture-builtin-settings.yaml
```

## Rollback

`--restore latest` restores the newest `settings.yaml.bak*`, keeping the current state as
`settings.yaml.bak-before-restore-<stamp>`. To undo a single model, delete its
`reasoningEfforts` (or set `false`) — the levels disappear and the previous behaviour
returns without disturbing the rest of the route.

## Known traps

- **`openai-completions` cannot send the gateway's session header.** `compat.sendSessionAffinityHeaders`
  is `"withhold"` in DSH — only the pi-ai catalog may set it — so a completions route sends
  nothing. Declaring effort does not change that.
- **A published endpoint table is not authoritative.** A gateway documenting `/responses`
  as serving only some models served 64 consecutive turns of a different model on that
  path, with no errors. Protocol differences are reported as notices, never acted on.
- **A route default is route-scoped.** The config schema has no per-model default, so a
  model on the route that does not support the pinned level keeps its `Default` row and
  fails if the route default is applied to it. The writer therefore writes the default only
  when *every* model on the route declares the level, and reports the route as not-written
  otherwise.
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
