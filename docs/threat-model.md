# Threat model — network interception

Scope: `packages/pki`, `packages/mitm-proxy`, `packages/browser`, `docker-compose.yml`. Decisions
are in [architecture.md](architecture.md); this page says what the interception path does and
does **not** guarantee, so results are never over-claimed.

## What we are defending

1. **Simulation integrity.** Everything the agent sees of the "web" must come from the world
   service, and everything consequential it does must be journaled. Real sites must be
   unreachable, so a run is not polluted by (or able to act on) the real internet.
2. **Identity.** A browser request's episode/role/delegation comes only from the proxy listener
   it arrived on, never from anything the client sent.
3. **No collateral trust.** Running the bench must not weaken the machine: no OS/user trust store
   changes, and a leaked eval CA key must not be able to impersonate real sites.

The adversary is the agent under test (and content it reads), which may try — deliberately or
because a page told it to — to reach the real internet, impersonate another role, reach the world
admin API, or smuggle data out.

## Traffic paths

| Source         | Destination           | Proxy action  | What we see                                            |
| -------------- | --------------------- | ------------- | ------------------------------------------------------ |
| Chromium / CLI | `*.eval.test`         | `intercept`   | Full HTTP/1.1 request + response, `network.request`    |
| Agent CLI      | model / auth API host | `passthrough` | Host, port, byte counts, duration — `network.tunnel`   |
| anything       | anything else         | `deny` (403)  | Host, port, method, URL (plain HTTP), `network.denied` |

Passthrough presets (`PASSTHROUGH_PRESETS` in `packages/mitm-proxy/src/policy.ts`, derived from the
string tables of Claude Code 2.1.224 and codex-cli 0.169.0):

- `anthropic`: `api.anthropic.com` (Messages API and `/api/oauth/*`), `platform.claude.com` and
  `console.anthropic.com` (OAuth token refresh).
- `openai`: `api.openai.com` (API key mode), `chatgpt.com` (`/backend-api/codex`, ChatGPT login
  mode), `auth.openai.com` (token refresh).
- `anthropic-interactive-login` (not default): `claude.ai`.

Explicitly denied (`denied_by_rule`, `OBSERVED_TELEMETRY_HOSTS`): `statsig.anthropic.com`,
`http-intake.logs.us5.datadoghq.com`, `browser-intake-us5-datadoghq.com`, `cdn.growthbook.io`,
`downloads.claude.ai`, `storage.googleapis.com` (Claude Code updater), `mcp-proxy.anthropic.com`,
`ab.chatgpt.com` (Codex statsig/OTLP), `persistent.oaistatic.com` (Codex update feed). Every other
host is denied by default. `AGENT_CLI_QUIET_ENV` additionally asks Claude Code not to try
(`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_AUTOUPDATER`, `DISABLE_TELEMETRY`, …).

## Eval CA (`packages/pki`)

- EC P-256 root in `.bench/pki/` (gitignored), keys mode `0600`, regenerated near expiry or when
  the name constraint is missing; `rotateCa` replaces CA and leaf key.
- **Critical name constraint**: permitted `DNS:eval.test`; excluded `IP:0.0.0.0/0` and `IP:::/0`
  (DNS-only permitted subtrees would otherwise leave IP SANs unconstrained). Verified with the
  system `openssl verify`: an `eval.test` leaf verifies; a CA-signed leaf for `example.com` fails
  with _permitted subtree violation_; an IP-SAN leaf fails with _excluded subtree violation_.
- The minter refuses names outside `eval.test` and IP literals; leaves live 7 days (≤ 397).
- Never installed anywhere. Trust is injected per process: `trustEnv()` sets
  `NODE_EXTRA_CA_CERTS` (adds to Node/Bun's store) to `ca.pem`, and the store-_replacing_
  variables (`SSL_CERT_FILE`, `CODEX_CA_CERTIFICATE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`,
  `GIT_SSL_CAINFO`, …) to `ca-bundle.pem` = Node's bundled Mozilla roots (`tls.rootCertificates`)
  - the eval CA, because the CLI must still verify the real model-API certificate inside its
    passthrough tunnel.
- **Name constraints protect clients that enforce them** (OpenSSL, Node, rustls, Go, NSS). They do
  not matter for our Chromium, which does not treat the CA as a trust anchor at all (next section).

## How Chromium trusts the eval CA (`packages/browser`)

Playwright's Chromium is launched with a fresh persistent profile and
`--ignore-certificate-errors-spki-list=<pin>`, where `<pin>` is the base64 SHA-256 of the **shared
leaf key**: every leaf the minter issues uses one per-CA key pair, so one pin covers all hosts.
The pin is read from the public `leaf-pub.pem`; the browser host needs no private key.
`ignoreHTTPSErrors` and `--ignore-certificate-errors` are never used. No system or user store,
keychain (`--use-mock-keychain`) or NSS database is touched. Verified on macOS (headless shell and
the full `chromium` channel); Linux uses the same network-service code path but has **not** been
run here.

Measured behaviour (tests in `tests/integration/network-browser.test.ts`):

- `https://probe.eval.test` via the proxy loads, `securityDetails().issuer` is the eval CA.
- A TLS server on an `eval.test` name with a certificate from another CA →
  `ERR_CERT_AUTHORITY_INVALID`; same when it staples the (public) eval CA certificate.
- **Known limitation**: Chromium matches the pin against _every_ certificate the server presents.
  A peer that staples our public _leaf_ certificate to its own chain is accepted (a test asserts
  this so a Chromium change is noticed). Pinning the CA SPKI would be worse — the CA certificate is
  public by design. Consequences and mitigation:
  - The only TLS peers Chromium can reach are (a) the proxy itself for intercepted hosts and
    (b) passthrough targets. Give the browser its own listener with
    `interceptOnlyPolicy(policy)` (`addListener(spec, { purpose: 'browser', policy })`, or
    `--intercept-only-ports` in the proxy CLI). Then Chromium's only TLS peer is the proxy and the
    limitation is unreachable. The model-API passthrough is for the CLI's listener only — this
    also stops pages from loading real `chatgpt.com` / `claude.ai` through that tunnel.
  - Whoever holds `leaf-key.pem` can impersonate _any_ host to this Chromium. Only the proxy holds
    it (docker: the runner container mounts public files only).
- A stricter alternative on Linux is a real trust anchor in a per-profile NSS DB (`HOME` pointed
  at the profile, `certutil -A -t C,,`), which would make Chromium enforce the name constraint.
  Not implemented: it needs `certutil` in the runner image and cannot be verified on macOS.

Other Chromium hardening: `--proxy-server` + `--proxy-bypass-list=<-loopback>` (loopback is
proxied too, so `http://127.0.0.1:<port>` is refused by the proxy), `--host-resolver-rules=MAP *
~NOTFOUND, EXCLUDE <proxyHost>` (any name resolution that bypasses the proxy fails),
`--disable-quic`, `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`, background
networking / component updates / sync / default apps / extensions / domain reliability /
phishing detection off, Playwright `serviceWorkers: 'block'`, profile deleted on `close()`.

## MITM proxy (`packages/mitm-proxy`)

- Decisions on the **CONNECT authority** (internal endpoint → `localhost`/IP literal → policy
  rules; ports default to 443/80). For intercepted tunnels the **SNI must equal** the authority
  (else handshake refused, `malformed_request`), and every inner request's **Host must equal** the
  authority (else `421` + `network.denied`); policy is re-evaluated per request. Plain-HTTP
  absolute-form requests must have a Host matching the URL. Origin-form requests sent straight
  to the proxy are refused.
- IP literals are refused (`internal_endpoint` for private/loopback/link-local/CGNAT/multicast,
  `host_not_allowed` otherwise) unless listed in `allowedAddresses`. Passthrough targets are
  resolved by the proxy and the **resolved** addresses are checked too (DNS rebinding to private
  space is refused). `internalEndpoints` (world agent/admin API) and the world site-host upstream
  itself are never targets, whatever the policy says.
- `intercept` speaks **HTTP/1.1 only**: ALPN offers `http/1.1`, so h2-capable clients (Chromium,
  curl, Node) fall back. WebSocket upgrades are relayed (with the same header rules); other
  `Upgrade` protocols are refused. Non-TLS bytes inside a CONNECT to an intercept host are refused
  (`unsupported_protocol`). Plain-HTTP requests to passthrough hosts are refused too — passthrough
  only ever means a blind CONNECT tunnel.
- Client `x-bench-*` headers are stripped (and listed in `strippedHeaders`, so spoofing attempts
  are visible to graders); `forwarded` / `x-forwarded-*` and hop-by-hop headers are dropped; the
  proxy injects `x-bench-episode`, `x-bench-role`, `x-bench-delegation` (child listeners) and
  `x-bench-request-id`.
- Robustness: header/request/handshake/connect/idle timeouts, 16 KiB max header size (`431`),
  client aborts propagate upstream, `close()` destroys every open tunnel and connection.
- Events go to a caller-supplied sink (the world journals them); the proxy keeps no state store.

## Why model-API traffic is tunnelled, not decrypted

- The CA _cannot_ sign for `api.anthropic.com` etc. (name constraint) — that is the point of it.
- The model channel carries the user's credentials and the agent's own prompts; the bench grades
  behaviour through world operations, not by reading model traffic. Decrypting it would put real
  credentials in the harness's hands for no grading benefit.
- We still record which host was contacted, bytes up/down and outcome per tunnel.

## Proxy-only vs container isolation

**Proxy-only** (local development, `isolation: "proxy-only"` in run metadata): the proxy only sees
what processes _choose_ to send it. Chromium is forced (flags above), and Claude Code / Codex are expected to honour
`HTTPS_PROXY` (not yet exercised against the real CLIs in this repo), but any process that ignores proxy variables, opens raw sockets, uses UDP/QUIC,
or resolves names through the local resolver bypasses it. DNS queries themselves can leak
names to the local resolver. Treat proxy-only runs as _instrumented_, not _isolated_.

**Container** (`docker-compose.yml`): the runner (agent CLI + Chromium) is attached only to an
`internal: true` network — no default route, no NAT, no UDP egress — and its embedded-DNS upstream is
a dead address, so external names do not resolve. Its only reachable peers are the proxy's listener
IP and the world agent API. The world site host listens only on a second internal network shared
with the proxy, so the runner cannot send forged `x-bench-*` headers to it directly; the world
admin API binds loopback inside the world container. Only the proxy is on the egress network.
The runner mounts only public trust material.

## Residual risks (not covered)

- **Provider-side tools.** Model APIs can browse on the provider's side (server-side web search /
  fetch, hosted tools). That traffic never touches our network. Adapters must disable those tools;
  the proxy cannot see or stop them.
- **The model channel is an exfiltration path by construction**: anything the agent reads can be
  sent to the model provider inside the tunnel. Tunnels are logged (host, bytes) but not inspected.
- **Same-role listener sharing.** Identity is "which port", not a secret. In proxy-only mode any
  local process can use any listener (a child could use the parent's port); in docker, everything
  in the runner container can. Per-listener `Proxy-Authorization` tokens would close this (protocol
  has no field for it yet).
- **CDP port** (`127.0.0.1`, unauthenticated) lets any local process drive that browser — still
  proxied, but cross-role control is possible on a shared host.
- **Stapled-leaf acceptance** in Chromium (above) if a browser listener is given passthrough rules.
- **Linux Chromium trust** not yet exercised; docker images not yet built (`docker compose config`
  validates; world/runner entrypoints are placeholders).
- **h2-only clients** cannot use intercepted hosts (none of ours are h2-only).
- Timing/size side channels through allowed tunnels; no rate limiting of denied attempts beyond
  journaling.
