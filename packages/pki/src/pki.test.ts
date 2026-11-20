import { execFileSync, spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SIGNING_ALGORITHM, x509 } from './crypto.js';
import {
  LeafHostError,
  LeafMinter,
  caPaths,
  ensureCa,
  ensureTrustMaterial,
  leafSpkiFingerprint,
  mintLeaf,
  readLeafSpkiFingerprint,
  rotateCa,
  spkiFingerprint,
  trustEnv,
  type EvalCa,
} from './index.js';

const hasOpenssl = spawnSync('openssl', ['version']).status === 0;

let dir: string;
let ca: EvalCa;

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aab-pki-'));
  ca = await ensureCa(path.join(dir, 'pki'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function opensslVerify(caFile: string, leafPem: string, host?: string) {
  const leafFile = path.join(dir, `leaf-${Math.random().toString(36).slice(2)}.pem`);
  writeFileSync(leafFile, leafPem);
  const args = ['verify', '-CAfile', caFile, '-purpose', 'sslserver'];
  if (host) args.push('-verify_hostname', host);
  args.push(leafFile);
  const r = spawnSync('openssl', args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}

async function forgeLeaf(sans: { type: 'dns' | 'ip'; value: string }[]): Promise<string> {
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: '0badc0de',
    subject: `CN=${sans[0]!.value}`,
    issuer: ca.cert.subject,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 86_400_000),
    publicKey: ca.leafKeys.publicKey,
    signingKey: ca.keys.privateKey,
    signingAlgorithm: SIGNING_ALGORITHM,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      new x509.SubjectAlternativeNameExtension(sans),
    ],
  });
  return `${cert.toString('pem')}\n`;
}

describe('ensureCa', () => {
  it('writes cert + keys with private key mode 0600', () => {
    const p = caPaths(path.join(dir, 'pki'));
    expect(statSync(p.keyPath).mode & 0o777).toBe(0o600);
    expect(statSync(p.leafKeyPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(p.certPath, 'utf8')).toContain('BEGIN CERTIFICATE');
  });

  it('is a CA with a critical name constraint permitting only eval.test', () => {
    const c = new X509Certificate(ca.certPem);
    expect(c.ca).toBe(true);
    const bc = ca.cert.getExtension(x509.BasicConstraintsExtension);
    expect(bc?.ca).toBe(true);
    expect(bc?.critical).toBe(true);
    const ku = ca.cert.getExtension(x509.KeyUsagesExtension);
    expect(ku && ku.usages & x509.KeyUsageFlags.keyCertSign).toBeTruthy();
    const nc = ca.cert.getExtension('2.5.29.30');
    expect(nc?.critical).toBe(true);
    if (hasOpenssl) {
      const text = execFileSync('openssl', ['x509', '-noout', '-text'], {
        input: ca.certPem,
        encoding: 'utf8',
      });
      expect(text).toMatch(/X509v3 Name Constraints: critical/);
      expect(text).toMatch(/Permitted:\s*\n\s*DNS:eval\.test/);
      expect(text).toMatch(/Excluded:\s*\n\s*IP:0\.0\.0\.0\/0\.0\.0\.0/);
    }
  });

  it('is idempotent and rotateCa replaces it', async () => {
    const again = await ensureCa(path.join(dir, 'pki'));
    expect(again.cert.serialNumber).toBe(ca.cert.serialNumber);
    expect(await leafSpkiFingerprint(again)).toBe(await leafSpkiFingerprint(ca));

    const other = path.join(dir, 'rot');
    const a = await ensureCa(other);
    const b = await rotateCa(other);
    expect(b.cert.serialNumber).not.toBe(a.cert.serialNumber);
    expect(await leafSpkiFingerprint(b)).not.toBe(await leafSpkiFingerprint(a));
    const c = await ensureCa(other);
    expect(c.cert.serialNumber).toBe(b.cert.serialNumber);
  });

  it('renews a CA close to expiry', async () => {
    const d = path.join(dir, 'renew');
    const a = await ensureCa(d);
    const b = await ensureCa(d, { now: new Date(a.cert.notAfter.getTime() - 86_400_000) });
    expect(b.cert.serialNumber).not.toBe(a.cert.serialNumber);
  });
});

describe('mintLeaf', () => {
  it('mints a short-lived serverAuth leaf with SAN and caches it', async () => {
    const leaf = await mintLeaf(ca, 'Probe.Eval.Test.');
    expect(leaf.host).toBe('probe.eval.test');
    const c = new X509Certificate(leaf.certPem);
    expect(c.subjectAltName).toBe('DNS:probe.eval.test');
    expect(c.checkIssued(new X509Certificate(ca.certPem))).toBe(true);
    expect(c.ca).toBe(false);
    const days = (Date.parse(c.validTo) - Date.parse(c.validFrom)) / 86_400_000;
    expect(days).toBeLessThan(398);
    expect(c.keyUsage).toContain('1.3.6.1.5.5.7.3.1');
    expect(await mintLeaf(ca, 'probe.eval.test')).toBe(leaf);
  });

  it('uses one shared leaf key so the leaf SPKI is constant', async () => {
    const a = await mintLeaf(ca, 'a.eval.test');
    const b = await mintLeaf(ca, 'shop-b.eval.test');
    expect(spkiFingerprint(a.certPem)).toBe(spkiFingerprint(b.certPem));
    expect(spkiFingerprint(a.certPem)).toBe(await leafSpkiFingerprint(ca));
    expect(spkiFingerprint(a.certPem)).not.toBe(spkiFingerprint(ca.certPem));
    expect(await readLeafSpkiFingerprint(ca.paths.dir)).toBe(spkiFingerprint(a.certPem));
    expect(statSync(ca.paths.leafPublicKeyPath).mode & 0o777).toBe(0o644);
  });

  it('matches the SPKI pin openssl computes', async () => {
    if (!hasOpenssl) return;
    const leaf = await mintLeaf(ca, 'pin.eval.test');
    const pub = execFileSync('openssl', ['x509', '-pubkey', '-noout'], { input: leaf.certPem });
    const der = execFileSync('openssl', ['pkey', '-pubin', '-outform', 'der'], { input: pub });
    const pin = execFileSync('openssl', ['dgst', '-sha256', '-binary'], { input: der });
    expect(pin.toString('base64')).toBe(spkiFingerprint(leaf.certPem));
  });

  it.each([
    'example.com',
    'eval.test.evil.com',
    'evileval.test',
    '127.0.0.1',
    '[::1]',
    'a..eval.test',
    '',
  ])('refuses %j', async (host) => {
    await expect(new LeafMinter(ca).mint(host)).rejects.toBeInstanceOf(LeafHostError);
  });

  it('rejects validity beyond the Chromium limit', () => {
    expect(() => new LeafMinter(ca, { validityDays: 400 })).toThrow(RangeError);
  });
});

describe.skipIf(!hasOpenssl)('openssl verification', () => {
  it('an eval.test leaf verifies against the CA', async () => {
    const leaf = await mintLeaf(ca, 'probe.eval.test');
    const r = opensslVerify(ca.paths.certPath, leaf.certPem, 'probe.eval.test');
    expect(r.out).toMatch(/: OK/);
    expect(r.ok).toBe(true);
  });

  it('a leaf for example.com signed by the CA key is rejected (name constraint)', async () => {
    const forged = await forgeLeaf([{ type: 'dns', value: 'example.com' }]);
    const r = opensslVerify(ca.paths.certPath, forged, 'example.com');
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/permitted subtree violation/i);
  });

  it('a leaf with an IP SAN signed by the CA key is rejected (excluded subtree)', async () => {
    const forged = await forgeLeaf([{ type: 'ip', value: '93.184.216.34' }]);
    const r = opensslVerify(ca.paths.certPath, forged);
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/excluded subtree violation/i);
  });
});

describe('TLS round trip with only the eval CA trusted', () => {
  it('Node verifies a minted leaf', async () => {
    const minter = new LeafMinter(ca);
    const server = tls.createServer({
      SNICallback: (name, cb) =>
        minter.secureContext(name).then(
          (ctx) => cb(null, ctx),
          (err: Error) => cb(err),
        ),
    });
    server.on('secureConnection', (s) => s.end('hi'));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    try {
      const socket = tls.connect({
        host: '127.0.0.1',
        port,
        servername: 'probe.eval.test',
        ca: ca.certPem,
      });
      await once(socket, 'secureConnect');
      expect(socket.authorized).toBe(true);
      const [data] = (await once(socket, 'data')) as [Buffer];
      expect(data.toString()).toBe('hi');
      socket.destroy();
    } finally {
      server.close();
    }
  });
});

describe('trust material', () => {
  it('writes a bundle with Mozilla roots + the eval CA and an env block', async () => {
    const d = path.join(dir, 'trust');
    const t = await ensureTrustMaterial(d);
    const bundle = readFileSync(t.paths.bundlePath, 'utf8');
    const count = bundle.match(/BEGIN CERTIFICATE/g)?.length ?? 0;
    expect(count).toBe(tls.rootCertificates.length + 1);
    expect(bundle).toContain(t.certPem.trim());
    const env = trustEnv(d);
    expect(env.NODE_EXTRA_CA_CERTS).toBe(t.paths.certPath);
    expect(env.SSL_CERT_FILE).toBe(t.paths.bundlePath);
    expect(env.CODEX_CA_CERTIFICATE).toBe(t.paths.bundlePath);
    expect(env.REQUESTS_CA_BUNDLE).toBe(t.paths.bundlePath);
    expect(env.CURL_CA_BUNDLE).toBe(t.paths.bundlePath);
  });
});
