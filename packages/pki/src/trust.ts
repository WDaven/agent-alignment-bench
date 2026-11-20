import { X509Certificate, createHash, createPublicKey } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import tls from 'node:tls';
import { caPaths, ensureCa, type EnsureCaOptions, type EvalCa } from './ca.js';
import { webcrypto } from './crypto.js';

export function spkiFingerprint(certPem: string | Buffer): string {
  const der = new X509Certificate(certPem).publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('base64');
}

export function spkiFingerprintFromDer(spki: ArrayBuffer | Uint8Array): string {
  return createHash('sha256')
    .update(spki instanceof Uint8Array ? spki : new Uint8Array(spki))
    .digest('base64');
}

export async function leafSpkiFingerprint(ca: EvalCa): Promise<string> {
  return spkiFingerprintFromDer(await webcrypto.subtle.exportKey('spki', ca.leafKeys.publicKey));
}

export async function readLeafSpkiFingerprint(dir: string): Promise<string> {
  const pem = await readFile(caPaths(dir).leafPublicKeyPath, 'utf8');
  const der = createPublicKey(pem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('base64');
}

export interface TrustBundleOptions {
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

export async function writeTrustBundle(ca: EvalCa, opts: TrustBundleOptions = {}): Promise<string> {
  const file = ca.paths.bundlePath;
  const body = `${[
    ...baseRoots(opts).map((c) => c.trim()),
    `# eval.test only (name-constrained)\n${ca.certPem.trim()}`,
  ].join('\n')}\n`;
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

export function trustEnv(dir: string): Record<string, string> {
  const p = caPaths(dir);
  return {
    NODE_EXTRA_CA_CERTS: p.certPath,
    SSL_CERT_FILE: p.bundlePath,
    CODEX_CA_CERTIFICATE: p.bundlePath,
    REQUESTS_CA_BUNDLE: p.bundlePath,
    CURL_CA_BUNDLE: p.bundlePath,
    GIT_SSL_CAINFO: p.bundlePath,
    NPM_CONFIG_CAFILE: p.bundlePath,
    CARGO_HTTP_CAINFO: p.bundlePath,
    AWS_CA_BUNDLE: p.bundlePath,
    DENO_CERT: p.certPath,
  };
}

export async function ensureTrustMaterial(
  dir: string,
  opts: EnsureCaOptions & TrustBundleOptions = {},
): Promise<EvalCa> {
  const ca = await ensureCa(dir, opts);
  await writeTrustBundle(ca, opts);
  return ca;
}
