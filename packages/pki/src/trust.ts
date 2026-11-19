import { X509Certificate, createHash, createPublicKey } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import tls from 'node:tls';
import { caPaths, ensureCa, type EnsureCaOptions, type EvalCa } from './ca.js';
import { webcrypto } from './crypto.js';

/**
 * Base64 SHA-256 of a certificate's SubjectPublicKeyInfo — the format Chromium's
 * `--ignore-certificate-errors-spki-list` and HPKP-style pins use.
 */
export function spkiFingerprint(certPem: string | Buffer): string {
  const der = new X509Certificate(certPem).publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('base64');
}

/** SPKI fingerprint of a raw SPKI DER blob. */
export function spkiFingerprintFromDer(spki: ArrayBuffer | Uint8Array): string {
  return createHash('sha256')
    .update(spki instanceof Uint8Array ? spki : new Uint8Array(spki))
    .digest('base64');
}

/**
 * SPKI fingerprint shared by every leaf this CA mints (they all use one key pair). This is what
 * the controlled Chromium is told to accept; the CA's own SPKI is deliberately NOT used, because
 * Chromium matches the pin against every certificate the server presents and the CA certificate
 * is public (anyone could staple it to their chain).
 */
export async function leafSpkiFingerprint(ca: EvalCa): Promise<string> {
  return spkiFingerprintFromDer(await webcrypto.subtle.exportKey('spki', ca.leafKeys.publicKey));
}

/**
 * Leaf SPKI pin read from the PUBLIC files of a PKI dir (`leaf-pub.pem`). Needs no private key, so
 * the browser host (e.g. the docker runner) can mount only ca.pem / ca-bundle.pem / leaf-pub.pem.
 */
export async function readLeafSpkiFingerprint(dir: string): Promise<string> {
  const pem = await readFile(caPaths(dir).leafPublicKeyPath, 'utf8');
  const der = createPublicKey(pem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('base64');
}

export interface TrustBundleOptions {
  /**
   * Also include the platform store (`tls.getCACertificates('system')`, Node >= 22.15). Read-only;
   * off by default so the bundle is reproducible and never depends on the host keychain.
   */
  includeSystem?: boolean;
}

function baseRoots(opts: TrustBundleOptions): string[] {
  const roots = new Set<string>(tls.rootCertificates);
  if (opts.includeSystem) {
    const get = (tls as unknown as { getCACertificates?: (t: string) => string[] })
      .getCACertificates;
    for (const c of get?.('system') ?? []) roots.add(c.trim());
  }
  return [...roots];
}

/**
 * Write `ca-bundle.pem` = Node's bundled Mozilla roots (+ optionally system roots) + the eval CA.
 * Needed for variables like SSL_CERT_FILE / CODEX_CA_CERTIFICATE that REPLACE the default store:
 * the agent CLI must still verify the real model-API certificate through the passthrough tunnel.
 */
export async function writeTrustBundle(ca: EvalCa, opts: TrustBundleOptions = {}): Promise<string> {
  const file = ca.paths.bundlePath;
  const body =
    [
      ...baseRoots(opts).map((c) => c.trim()),
      `# eval.test only (name-constrained)\n${ca.certPem.trim()}`,
    ].join('\n') + '\n';
  let current: string | null = null;
  try {
    current = await readFile(file, 'utf8');
  } catch {
    current = null;
  }
  if (current !== body) {
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, body, { mode: 0o644 });
    await rename(tmp, file);
  }
  return file;
}

/**
 * Environment block that makes common TLS stacks trust the eval CA *for that process only*.
 *
 * - Variables that ADD to the default store get the bare CA (`ca.pem`).
 * - Variables that REPLACE the default store get the combined bundle (`ca-bundle.pem`), so the
 *   model API (reached through a blind tunnel with its real certificate) still verifies.
 *
 * Call `writeTrustBundle` (or `ensureTrustMaterial`) first so the bundle exists.
 */
export function trustEnv(dir: string): Record<string, string> {
  const p = caPaths(dir);
  return {
    // Node / Bun (Claude Code): appended to the built-in Mozilla store.
    NODE_EXTRA_CA_CERTS: p.certPath,
    // OpenSSL-based clients, Python ssl, Go (on Linux), rustls-native-certs: REPLACES the store.
    SSL_CERT_FILE: p.bundlePath,
    // Codex CLI (Rust/rustls): replaces system roots.
    CODEX_CA_CERTIFICATE: p.bundlePath,
    REQUESTS_CA_BUNDLE: p.bundlePath,
    CURL_CA_BUNDLE: p.bundlePath,
    GIT_SSL_CAINFO: p.bundlePath,
    NPM_CONFIG_CAFILE: p.bundlePath,
    CARGO_HTTP_CAINFO: p.bundlePath,
    AWS_CA_BUNDLE: p.bundlePath,
    // Deno: adds.
    DENO_CERT: p.certPath,
  };
}

/** `ensureCa` + `writeTrustBundle`: everything a launcher needs before setting `trustEnv`. */
export async function ensureTrustMaterial(
  dir: string,
  opts: EnsureCaOptions & TrustBundleOptions = {},
): Promise<EvalCa> {
  const ca = await ensureCa(dir, opts);
  await writeTrustBundle(ca, opts);
  return ca;
}
