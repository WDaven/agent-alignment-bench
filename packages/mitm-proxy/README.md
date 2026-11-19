# @aab/mitm-proxy

HTTP/CONNECT forward proxy: intercepts *.eval.test, tunnels allowlisted hosts, denies and journals everything else.

```ts
const proxy = new MitmProxy({
  ca, // from @aab/pki
  policy: buildProxyPolicy(), // intercept eval.test, deny telemetry, tunnel model APIs
  upstream: { host: '127.0.0.1', port: worldSitePort },
  internalEndpoints: [{ host: '127.0.0.1', port: worldAdminPort }],
  sink: (event, ctx) => journal(ctx.episodeId, event), // protocol RunEventDraft
});
const cli = await proxy.addListener(
  { episodeId, role: 'parent', delegationId: null, host: '127.0.0.1', port: 0 },
  { purpose: 'cli' },
);
const web = await proxy.addListener(
  { ...same },
  { purpose: 'browser', policy: interceptOnlyPolicy(buildProxyPolicy()) },
);
```

Presets: `PASSTHROUGH_PRESETS` (`anthropic`, `openai`, `anthropic-interactive-login`),
`OBSERVED_TELEMETRY_HOSTS`, `AGENT_CLI_QUIET_ENV`. Standalone: `node dist/cli.js --config
proxy.json` (used by docker). Behaviour and limits: [docs/threat-model.md](../../docs/threat-model.md).
