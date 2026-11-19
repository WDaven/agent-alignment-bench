# @aab/pki

Per-machine eval CA (name-constrained to eval.test) and on-demand leaf certificate minting.

```ts
const ca = await ensureTrustMaterial('.bench/pki'); // ensureCa + ca-bundle.pem
const minter = new LeafMinter(ca); // cached, 7-day leaves, eval.test only
const ctx = await minter.secureContext('probe.eval.test');
const env = trustEnv('.bench/pki'); // NODE_EXTRA_CA_CERTS, SSL_CERT_FILE, ...
const pin = await readLeafSpkiFingerprint('.bench/pki'); // Chromium SPKI pin (public file only)
```

Files in the PKI dir: `ca.pem`, `ca-key.pem` (0600), `leaf-key.pem` (0600, shared by every leaf),
`leaf-pub.pem`, `ca-bundle.pem` (Mozilla roots + eval CA). Never installed into any OS/user store.
See [docs/threat-model.md](../../docs/threat-model.md).
