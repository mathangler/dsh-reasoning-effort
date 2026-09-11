# dsh-reasoning-effort

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) **agent skill** for
making a model route expose selectable **thinking / reasoning effort** levels — and for
diagnosing the three ways it usually goes wrong.

It exists because DSH's picker shows an "Effort" submenu only when the adapter reports
reasoning levels for the selected model, and for a hand-declared provider route that
never happens by accident. The skill carries the rule that explains the symptom, the
configuration schema, the protocol decision that decides whether the levels are merely
*listed* or actually *sent*, and a validator you can run before touching a live session.

> 中文说明见 [README.zh.md](README.zh.md).

## What it solves

| Symptom | What the skill tells you |
| --- | --- |
| The model menu has no 推理等级 / "Effort" submenu | The route name is not a pi-ai catalog provider, so `reasoning` resolved to `false` — metadata is looked up **by route name**, all-or-nothing |
| Adding one new model stripped context size / capabilities from the others | Same cause: one route name cannot both be a catalog provider and carry an uncatalogued model |
| A level is listed but a request fails with `does not support reasoning effort` | `reasoningEfforts` pins every undeclared level to unsupported; the declared set is authoritative |
| A config write is refused and the whole route disappears from the picker | A route-level `compat` field no model on the route can accept (usually because `api` resolved to nothing) |
| Levels appear, but reasoning tokens never move | The protocol sends no reasoning parameter — a Responses route ignores `thinkingFormat` |

## The one rule worth remembering

**pi-ai's model metadata is looked up by the route name itself, and the lookup is
all-or-nothing.** A route whose key is not a pi-ai builtin provider id gets an empty
catalog table, so *every* model on it falls back to hand-written values at once:
display name, `contextWindow` (to the route default), `reasoning: false`,
`thinkingLevelMap`, and `compat`. That single fact explains most "why is my capability
missing" reports.

## The trap

`compat: { thinkingFormat: deepseek }` looks like the thing that makes thinking work, so
it is tempting to move a route to `api: openai-completions` to use it. On an OpenCode Go
/ Zen gateway that also **drops the session id** (`session_id` is sent natively only by
the `openai-responses` implementation; `openai-completions` gates it behind
`compat.sendSessionAffinityHeaders`, which DSH classifies `"withhold"` and cannot be
enabled from settings). The next turn then fails with `400 MissingSessionID` — a failure
that has nothing to do with effort levels, arriving as a side effect of the change.

Both protocols accept the same `reasoningEfforts` declaration, so you normally get levels
**without** trading the session header away. Choose the protocol by the session-header
column, then express effort within it.

## Install

The skill is a directory under the DSH skills root. No build step.

**Windows (PowerShell)**

```powershell
git clone https://github.com/mathangler/dsh-reasoning-effort "$env:TEMP\dsh-reasoning-effort"
$dest = "$env:USERPROFILE\.dsh\skills\dsh-reasoning-effort"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item "$env:TEMP\dsh-reasoning-effort\SKILL.md","$env:TEMP\dsh-reasoning-effort\scripts" $dest -Recurse -Force
```

**macOS / Linux**

```sh
git clone https://github.com/mathangler/dsh-reasoning-effort /tmp/dsh-reasoning-effort
mkdir -p "${DSH_HOME:-$HOME/.dsh}/skills/dsh-reasoning-effort"
cp -R /tmp/dsh-reasoning-effort/SKILL.md /tmp/dsh-reasoning-effort/scripts \
      "${DSH_HOME:-$HOME/.dsh}/skills/dsh-reasoning-effort/"
```

The skills root is `${DSH_HOME:-$HOME/.dsh}/skills`; `DSH_HOME` overrides it. Start a new
session (or reload the skills panel) and the skill is available.

## Use it without an agent

`scripts/check-reasoning-route.mjs` is a standalone validator — no DSH process needed. It
reads your settings document, the pi-ai catalog pinned by your dsh install, and
`dsh-llm-pi-ai`'s compat gates, then reports per model: whether the route inherits catalog
metadata, the **effective protocol**, which levels would be offered, and whether any
configured `compat` field has a model that can accept it.

```sh
node scripts/check-reasoning-route.mjs                      # every route
node scripts/check-reasoning-route.mjs --route my-route     # one route
node scripts/check-reasoning-route.mjs --settings /path/to/settings.yaml
```

Exit code is `0` when no structural problem is found, `1` when one is, `2` when the dsh
install cannot be located (pass `--dsh-root` then). It reproduces the exact strict-write
check that makes a misconfigured route vanish from the model picker, so it catches the
mistake *before* you restart anything.

`scripts/live-probe.md` holds a ready-to-paste dynamic Cordis Host plugin that reports
what the **running** adapter advertises and which levels `resolveCallConfig` accepts —
the check that catches "listed but rejected", plus a rejected route's error text.

## Verify in three steps

1. **Config resolves** — `check-reasoning-route.mjs`.
2. **Levels are accepted, not just listed** — the live probe.
3. **The wire honours it** — one real request at a high level, confirming reasoning tokens
   rise. Only this step proves the gateway accepts what DSH sends; config alone cannot.

## Two facts that save an hour each

- **A dynamic Cordis plugin cannot write settings.** `dsh-settings` accepts only objects
  whose prototype *is* the Host bundle's `Object.prototype`, and a dynamic plugin runs in
  a separate realm, so nothing it constructs passes (`must be a plain object`). Read from
  a plugin, write to the file.
- **Editing `settings.yaml` externally does not hot-reload a running process.** The file
  provider's watcher has been observed not to fire. Config changes need a fresh `dsh`
  process. Corollary: never conclude a config is wrong because a running process still
  reports the old value.

## Related

- `opencode-go-session-header` — the OpenCode Go / Zen `400 MissingSessionID` fix. Read it
  **before** changing a route's protocol; the two interact.

## License

MIT — see [LICENSE](LICENSE).
