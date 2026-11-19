# @aab/browser

Controlled Chromium launcher: isolated profile per role, forced proxy, CDP endpoint, trace/HAR/screenshot capture.

```ts
const b = await launchControlledBrowser({
  proxyPort: web.port,
  caDir: '.bench/pki',
  artifactsDir: 'runs/<id>',
});
b.cdpEndpoint; // http://127.0.0.1:<port> for the browser MCP server (connectOverCDP)
await b.screenshot('step-1');
await b.close(); // trace.zip + network.har written, profile deleted
```

Trust: `--ignore-certificate-errors-spki-list=<sha256 of the shared eval leaf key>` (read from the
public `leaf-pub.pem`); no system store, no `ignoreHTTPSErrors`. Point `proxyPort` at an
**intercept-only** listener — see "How Chromium trusts the eval CA" in
[docs/threat-model.md](../../docs/threat-model.md) for why.
