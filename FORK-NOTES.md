# Revision notes

What this revision changes, and why. The baseline is the previously published
state, commit `541bad4` ("Add dsh-reasoning-effort skill").

Diff it yourself:

```sh
git diff 541bad4 HEAD --stat
git diff 541bad4 HEAD -- SKILL.md
```

## Revision 3: the document moved from `settings.yaml` to the profile patch

DSH 0.1.7 removed `settings.yaml`: `dsh-settings` reads it once at boot, renames it to
`settings.yaml.imported`, and moves each section into the starting profile. The document of record
is now the **profile patch**, `$DSH_HOME/profiles/<profile>/cordis.patch.yml` — a top-level sequence
of loader entries, where the provider configuration lives in the `llm-pi-ai` row at
`config.providers.<route>` and `agent-default-model` is a row of its own. Writing the old file had
become a no-op: it is imported once and never read again.

| Area | Revision 2 | Now |
| --- | --- | --- |
| Target document | `$DSH_HOME/settings.yaml`, assumed | resolved: `--settings <path>`, else the one profile patch that configures `llm-pi-ai`; more than one is reported with `exit 2` instead of picked |
| Provider location | `llm-pi-ai.providers.<route>` | `[id=llm-pi-ai].config.providers.<route>` |
| `agent-default-model` | a top-level section | a row of its own; `config.reasoningEffort` is the one field the writer ever removes from it |
| Path-diff allow-list | `llm-pi-ai.providers.*`, `agent-default-model.*` | `[id=llm-pi-ai].config.providers.*` and `[id=agent-default-model].config.reasoningEffort` (a removal arrives with a ` (removed)` suffix, stripped before the test) |
| Backup | `settings.yaml.bak-reasoning-efforts` | `<document>.bak-reasoning-efforts`, beside the patch |
| js-yaml lookup | `$DSH_HOME/profiles/node_modules` and the document's directory | plus the same roots the install search uses, so a relocated or global install still resolves the parser |
| Crash behaviour | an unexpected failure exited `1` — indistinguishable from "work is pending" | every unexpected failure and every refused write exits `2`, so an agent stops instead of retrying |
| Fixtures | `settings.yaml` shape | profile-patch shape (the same four scenarios) |
| Determinism | a catalog tie-break followed directory-read order | ties broken by id, `readdir` sorted, sibling candidates sorted |
| Encoding | LF and CRLF | plus a UTF-8 BOM, which used to hide the whole document from the line-level locators |

Verified on Windows against a copy of a real 3.7 KB profile patch: 23/23 self-test assertions, a
13-check robustness suite (determinism, unwritable backup, CRLF, BOM, restore, read-only file), and
the original failure — a model added through the GUI on a route carrying `reasoning: high` — fixed by
a single `--apply` that leaves the file byte-identical on the next run.

## Revision 2: the route default is never written

Same contract version (1), one behavioural reversal, and one piece of machinery that was built,
reviewed and then removed. The trigger was real: a model added through the GUI on a route that
already carried `reasoning: high` made every request to that model fail with
`UNSUPPORTED_REASONING_EFFORT`, because the route default is applied to the whole route.

| Area | Revision 1 | Now |
| --- | --- | --- |
| Route-level `reasoning:` | written as `high` when every model on the route declares it, so the picker drops its `Default` row | **never written**, and **removed wherever it is found**, whether or not a model currently objects to it. `Default` is the intended state: it is the one selection every model on the route can accept |
| Pinning a default | `--default-effort <level\|skip>` (default `high`) | the flag is gone; a route default is no longer a feature |
| A model that cannot take the route default | withheld the write, or removed a value already in the file | removed, always — and a route still carrying the field keeps the run out of `covered` |
| Per-model default rule | "give the incompatible models a route of their own" (`--no-default` split, reference retargeting, evidence remapping) | **removed in full**: the split, `retargetProviderForModels`, the reference retargeting and the evidence remapping. Routes are never renamed or split, so `agent-default-model` / `subagent-model-selection` never have to be re-pointed and no recorded evidence has to follow a model |
| Evidence scope | keyed by route name (`match.provider`) | keyed by **gateway** (`match.baseURL`) for the vendor facts, because the fact is about the model as that gateway serves it: two routes to the same gateway now share one answer instead of putting the same question to the user twice. `match.provider` still works, for routes that genuinely differ |
| `agent-default-model.reasoningEffort` | removed only when provably unsupported | unchanged |
| `--json` | `routeDefaultsUnmet` (only the entries that were not written) | `routeDefaults` (every route, with `action`), plus `agentDefault` |
| Fixtures | three | four: `fixture-pinned-default.yaml` adds the *safe* route default, which must come out as well, and is the one fixture that reaches exit `0` |

The environment that produced this: 39 catalog providers, two `llm-*` routes to one gateway (one
`openai-responses`, one `openai-completions`), and a model that appears on both. The self-test is
the gate — it asserts both defaults rules, the built-in boundary, and the exit code for a fully
covered document.

## Why this revision exists

The previous revision is **documentation plus a read-only validator**: its entire
filesystem surface was `existsSync` / `readdirSync` / `readFileSync`. Nothing in it
ever wrote `settings.yaml`, so its workflow was "hand-edit YAML from a snippet in
SKILL.md, then run the validator". That left three gaps:

1. **It could not apply anything.** The models on a hand-declared route kept showing
   no effort levels until someone edited the file by hand, every time.
2. **It had no notion of what a model actually supports.** Combined with (1), a
   hand-written level set was an unsourced guess — including plausible-looking ones
   that are wrong, such as giving `off` to a model that has removed the ability to
   stop thinking.
3. **Its discovery was POSIX-biased in the wrong places.** It shelled out to
   `where dsh` and `npm root -g` *before* consulting the environment, which cannot
   work on Windows (`npm` is `npm.cmd`, and `execFileSync` will not spawn it) or on
   macOS/Linux (`where` does not exist), and could exit `2` under a sandbox that denies
   child processes — for a reason unrelated to the user's configuration.

## What changed

| Area | Previous | Now |
| --- | --- | --- |
| Writing | none — hand-edit only | `scripts/apply-reasoning-efforts.mjs`, dry run by default, `--apply` to write |
| Level sets | copied by hand from a sibling model | derived from the installed pi-ai catalog, with a cited patch layer (`data/reasoning-overrides.yaml`) for what the catalog lacks |
| Evidence | not modelled | `probe` > `vendor` > `catalog` > `unknown`; unknown is reported, never written |
| Built-ins | not distinguished in the workflow | detected as `declared: !catalog.has(routeId)`; built-in and catalog routes are reported read-only and never written |
| Install discovery | `where`/`npm root -g` first, both wrapped in bare `try/catch` | env-first and subprocess-optional: `--dsh-root` → `DSH_ROOT` → `$DSH_HOME/profiles/node_modules` → roots implied by `process.execPath` → platform defaults → `where`/`which` last |
| Compat gates | one regex per gate; a minified bundle yielded a silent empty table and a confident *"cannot be set from settings.yaml"* verdict | brace-aware scanner that distinguishes `offer` from `withhold`, and reports **cannot be checked** instead of inventing a verdict |
| Inherited levels | absent map keys counted as offered (optimistic) | pi-ai's real rule, including its asymmetry: absent means supported for `off`/`minimal`/`low`/`medium`/`high`, unsupported for `xhigh`/`max` |
| Protocol mismatch | not reported | reported as a notice, with the measured counter-example to the public endpoint table recorded in SKILL.md |
| Hot reload | stated flatly as "does not hot-reload" | stated as uncertain, with both the watcher evidence and the contrary observation, and a fallback that depends on neither |
| `--help`, `--json`, `--report`, exit codes | partial | on both scripts |

## What did **not** change

- The findings about DSH internals, all of which re-checked against the installed
  artifacts: the all-or-nothing catalog lookup by route name, the seven levels, the
  declaration semantics, the `off: null` rule, the
  `sendSessionAffinityHeaders: "withhold"` trap, and the realm-sensitive
  `isPlainObject` check that stops a dynamic plugin from writing settings.
- The license and its copyright.
- `scripts/live-probe.md`, untouched.

## The file set today

| Path | Role |
| --- | --- |
| `SKILL.md` | the execution path only: five steps, the Never list, the exit codes |
| `REFERENCE.md` | the DSH internals the scripts encode, read when someone asks "why" |
| `README.md` / `README.zh.md` | install, update, uninstall, configuration, verification (human-facing) |
| `data/reasoning-overrides.yaml` | cited provider facts, evidence `vendor` |
| `data/user-decisions.yaml` | answers recorded with `--decide`, evidence `user` |
| `scripts/apply-reasoning-efforts.mjs` | the writer, plus `--self-test`, `--decide`, `--json` |
| `scripts/check-reasoning-route.mjs` | the read-only validator |
| `scripts/lib/` | install discovery, catalog and level rules, the line-level YAML editor |
| `scripts/fixture*.yaml` | four fixtures the self-test drives: declare/ask/non-reasoning, the built-in boundary, a route default that breaks a model, and a route default that breaks nothing (both must be removed) |
| `scripts/install-from-github.mjs`, `scripts/publish-via-api.mjs` | the API fallbacks for environments where git cannot reach github.com |
| `scripts/live-probe.md` | upstream, untouched |

## Keeping the prose in sync

The DSH-internals prose in `SKILL.md` and `scripts/live-probe.md` are the parts most
worth re-reading whenever DSH itself changes. `scripts/check-reasoning-route.mjs` has
diverged substantially from its first form; when merging later edits, prefer this
revision's `scripts/lib/` and port new *checks* into it rather than reverting the
discovery and gate parsing.
