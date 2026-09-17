# Fork notes

This directory is a **local fork** of
[`mathangler/dsh-reasoning-effort`](https://github.com/mathangler/dsh-reasoning-effort).

| | |
| --- | --- |
| Upstream commit | `541bad4888ebbf0d97a3234a9293eda1d97e8edc` ("Add dsh-reasoning-effort skill", 2026-09-12) |
| Upstream state | 1 commit, no tags, no releases, no CI, no `package.json` |
| License | MIT, © 2026 mathangler — kept verbatim in [`LICENSE`](LICENSE) |

## Why it was forked

Upstream is **documentation plus a read-only validator**: its entire filesystem
surface is `existsSync` / `readdirSync` / `readFileSync`. Nothing in it ever writes
`settings.yaml`, so its workflow is "the agent or the user hand-edits YAML from a
snippet in SKILL.md, then runs the validator". That leaves three gaps this fork
closes:

1. **It cannot apply anything**, so the models on a hand-declared route keep
   showing no effort levels until someone edits the file by hand every time.
2. **It has no notion of what a model actually supports.** Combined with (1), a
   hand-written level set is an unsourced guess — including plausible-looking ones
   that are wrong, such as giving `off` to a model that has removed the ability to
   stop thinking.
3. **Its discovery is POSIX-biased in the wrong places.** It shells out to
   `where dsh` and `npm root -g` *before* consulting the environment, which cannot
   work on Windows (`npm` is `npm.cmd`) or on macOS/Linux (`where` does not
   exist), and can exit `2` under a sandbox that denies child processes — for a
   reason that has nothing to do with the user's configuration.

## What changed

| Area | Upstream | Here |
| --- | --- | --- |
| Writing | none — hand-edit only | `scripts/apply-reasoning-efforts.mjs`, dry run by default, `--apply` to write |
| Level sets | copied by hand from a sibling model | derived from the installed pi-ai catalog, with a cited patch layer (`data/reasoning-overrides.yaml`) for what the catalog lacks |
| Evidence | not modelled | `probe` > `vendor` > `catalog` > `unknown`; unknown is reported, never written |
| Built-ins | not distinguished in the workflow | detected as `declared: !catalog.has(routeId)`; built-in and catalog routes are reported read-only and never written |
| Install discovery | `where`/`npm root -g` first, both wrapped in bare `try/catch` | env-first and subprocess-optional: `--dsh-root` → `DSH_ROOT` → `$DSH_HOME/profiles/node_modules` → roots implied by `process.execPath` → platform defaults → `where`/`which` last |
| Compat gates | one regex per gate; a minified bundle yields a silent empty table and a confident *"cannot be set from settings.yaml"* verdict | brace-aware scanner that distinguishes `offer` from `withhold`, and reports **cannot be checked** instead of inventing a verdict |
| Inherited levels | absent map keys counted as offered (optimistic) | pi-ai's real rule, including its asymmetry: absent means supported for `off`/`minimal`/`low`/`medium`/`high`, unsupported for `xhigh`/`max` |
| Protocol mismatch | not reported | reported as a notice, with the measured counter-example to the public endpoint table recorded in SKILL.md |
| Hot reload | stated flatly as "does not hot-reload" | stated as uncertain, with both the watcher evidence and the contrary observation, and a fallback that does not depend on either |
| `--help`, `--json`, `--report`, exit codes | partial | on both scripts |

## What did **not** change

- Upstream's findings about DSH internals, all of which re-checked against the
  installed artifacts: the all-or-nothing catalog lookup by route name, the seven
  levels, the declaration semantics, the `off: null` rule, the
  `sendSessionAffinityHeaders: "withhold"` trap, and the realm-sensitive
  `isPlainObject` check that stops a dynamic plugin from writing settings.
- The MIT license and the original author's copyright.
- `scripts/live-probe.md`, untouched.

## Rebasing onto a future upstream

```sh
git remote add upstream https://github.com/mathangler/dsh-reasoning-effort
git fetch upstream
git log --oneline upstream/main        # see what landed
git diff FETCH_HEAD -- SKILL.md scripts/live-probe.md
```

`scripts/live-probe.md` and the DSH-internals prose in `SKILL.md` are the parts
most worth taking from upstream verbatim. `scripts/check-reasoning-route.mjs` has
diverged substantially; when merging, prefer this fork's `scripts/lib/` and port
upstream's new *checks* into it rather than reverting the discovery and gate
parsing.
