# Live probe: what a route actually advertises and accepts

`scripts/check-reasoning-route.mjs` validates the configuration *offline*. It cannot
see what the running adapter reports, and it cannot see a rejected route's error
text. This probe reads both from the live Host.

Paste the body below into `cordis_define` as the **host** half (`plugin.kind: "new"`,
any 3–6 letter `idPrefix`), then `cordis_run` it and call the tool from the next step.
It is strictly read-only: it resolves metadata and call configs, and sends no model
request.

> **Realm note.** Writes are impossible from a dynamic plugin (see SKILL.md,
> "Two write-path facts"), so this probe only *reads*. `ctx.settings.get()` and
> `describe()` return host objects, which is why reading works.

```js
return {
  name: 'reasoning-route-probe',
  inject: ['llm'],
  apply(ctx) {
    const clone = (value) => JSON.parse(JSON.stringify(value))
    harness.registerTool(ctx, harness.defineTool({
      name: 'reasoning_route_probe',
      description: 'Read-only: report advertised reasoning levels, which levels resolve, and route registration diagnostics.',
      parameters: {
        route: { type: 'string', description: 'Provider route to probe.' },
        models: { type: 'array', items: { type: 'string' }, description: 'Optional model ids to probe; defaults to every configured model.' },
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: value }] },
      },
      async execute(args) {
        const out = {}
        const route = String(args.route)
        const configured = ctx.get('settings')?.get('llm-pi-ai')?.providers?.[route]?.models
        const models = Array.isArray(args.models) && args.models.length > 0
          ? args.models.map(String)
          : (configured ?? []).map((m) => String(m.id))
        out.route = route
        out.effectiveProtocols = (configured ?? []).map((m) => ({
          id: String(m.id),
          api: m.api === undefined ? null : String(m.api),
        }))
        out.models = []
        for (const model of models) {
          const report = { model }
          try {
            const info = await ctx.llm.resolveModelInfo(route, model)
            const levels = info.reasoning === undefined ? [] : info.reasoning.efforts.map((e) => String(e.id))
            report.name = String(info.name)
            report.contextWindow = info.context === undefined ? null : info.context.contextWindow
            report.advertised = levels
            report.defaultEffort = info.reasoning?.defaultEffort === undefined ? null : String(info.reasoning.defaultEffort)
            const accepted = {}
            for (const level of levels) {
              try {
                const call = await ctx.llm.resolveCallConfig({ provider: route, model, reasoningEffort: level })
                accepted[level] = call.reasoningEffort === undefined ? null : String(call.reasoningEffort)
              } catch (error) {
                accepted[level] = 'REJECTED: ' + String(error?.message ?? error)
              }
            }
            report.accepted = accepted
            report.levelsOfferedButRejected = Object.entries(accepted)
              .filter(([, v]) => typeof v === 'string' && v.startsWith('REJECTED'))
              .map(([k]) => k)
          } catch (error) {
            report.error = String(error?.message ?? error)
          }
          out.models.push(report)
        }
        try {
          const entries = await ctx.llm.listConfigurableProviders()
          const entry = entries.find((c) => String(c.provider) === route)
          out.registration = entry === undefined
            ? null
            : { provider: String(entry.provider), error: entry.error === undefined ? null : String(entry.error) }
        } catch (error) {
          out.registrationError = String(error?.message ?? error)
        }
        try {
          const selection = ctx.get('agentDefaultModel')?.currentSelection()
          out.defaultSelection = selection === undefined
            ? null
            : {
                provider: String(selection.provider),
                model: String(selection.model),
                reasoningEffort: selection.reasoningEffort === undefined ? null : String(selection.reasoningEffort),
              }
        } catch (error) {
          out.defaultSelectionError = String(error?.message ?? error)
        }
        out.rawUserSection = clone(ctx.get('settings')?.get('llm-pi-ai')?.providers?.[route] ?? null)
        return JSON.stringify(out, null, 2)
      },
    }))
  },
}
```

## Reading the result

| Observation | Meaning |
| --- | --- |
| `advertised` is empty | the model resolved `reasoning: false` — see the catalog-by-route-name rule in SKILL.md |
| `levelsOfferedButRejected` is non-empty | the picker lists a level the adapter refuses; the declaration and the protocol disagree |
| `registration.error` is set | the route **failed validation** and is not registered — this is the text behind "the model disappeared from the picker" |
| `effectiveProtocols[].api` is `null` | that model has no protocol: any route-level `compat` field will fail the strict write |
| `accepted[x]` is `null` | that level is accepted and sends *nothing* on the wire (normal for `off`) |

## Then close the loop on the wire

Config plus metadata still cannot prove the gateway honours the parameter. Finish with
one real request at the highest declared level and confirm reasoning tokens rise in the
usage readout. If the request fails, check the companion skill
`opencode-go-session-header` before touching `reasoningEfforts` — a `400
MissingSessionID` has nothing to do with effort levels.

Remember the probe is a temporary capability: remove it with `cordis_undefine` when the
investigation is done.
