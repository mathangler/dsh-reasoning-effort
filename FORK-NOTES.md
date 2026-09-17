# Revision notes

What this revision changes, and why. The baseline is the previously published
state, commit `541bad4` ("Add dsh-reasoning-effort skill").

Diff it yourself:

```sh
git diff 541bad4 HEAD --stat
git diff 541bad4 HEAD -- SKILL.md
```

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

## Keeping the prose in sync

The DSH-internals prose in `SKILL.md` and `scripts/live-probe.md` are the parts most
worth re-reading whenever DSH itself changes. `scripts/check-reasoning-route.mjs` has
diverged substantially from its first form; when merging later edits, prefer this
revision's `scripts/lib/` and port new *checks* into it rather than reverting the
discovery and gate parsing.
