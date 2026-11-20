import { AsnConvert } from '@peculiar/asn1-schema';
import {
  GeneralName,
  GeneralSubtree,
  GeneralSubtrees,
  NameConstraints,
  id_ce_nameConstraints,
} from '@peculiar/asn1-x509';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EVAL_DOMAIN } from '@aab/protocol';
import {
  SIGNING_ALGORITHM,
  exportPrivateKeyPem,
  generateKeyPair,
  importKeyPairPem,
  spkiDer,
  x509,
  type CryptoKey,
  type CryptoKeyPair,
} from './crypto.js';

export const DEFAULT_PKI_DIR = '.bench/pki';

export const CA_COMMON_NAME = 'Agent Alignment Bench Eval CA (local, eval.test only)';
export const CA_ORGANIZATION = 'agent-alignment-bench';

export const CA_VALIDITY_DAYS = 365;
export const CA_RENEW_BEFORE_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CaPaths {
  dir: string;
  certPath: string;
  keyPath: string;
  leafKeyPath: string;
  leafPublicKeyPath: string;
  bundlePath: string;
}

export function caPaths(dir: string): CaPaths {
  const d = path.resolve(dir);
  return {
    dir: d,
    certPath: path.join(d, 'ca.pem'),
    keyPath: path.join(d, 'ca-key.pem'),
    leafKeyPath: path.join(d, 'leaf-key.pem'),
    leafPublicKeyPath: path.join(d, 'leaf-pub.pem'),
    bundlePath: path.join(d, 'ca-bundle.pem'),
  };
}

export function caPemPath(dir: string): string {
  return caPaths(dir).certPath;
}

export interface EvalCa {
  paths: CaPaths;
  cert: x509.X509Certificate;
  certPem: string;
  keys: CryptoKeyPair;
  leafKeys: CryptoKeyPair;
  leafKeyPem: string;
}

function buildNameConstraints(): x509.Extension {
  const nc = new NameConstraints({
    permittedSubtrees: new GeneralSubtrees([
      new GeneralSubtree({ base: new GeneralName({ dNSName: EVAL_DOMAIN }) }),
    ]),
    excludedSubtrees: new GeneralSubtrees([
      new GeneralSubtree({ base: new GeneralName({ iPAddress: '0.0.0.0/0' }) }),
      new GeneralSubtree({ base: new GeneralName({ iPAddress: '::/0' }) }),
    ]),
  });
  return new x509.Extension(id_ce_nameConstraints, true, AsnConvert.serialize(nc));
}

function randomPositiveSerial(): string {
  const b = randomBytes(16);
  b.writeUInt8(b.readUInt8(0) & 0x7f || 1, 0);
  return b.toString('hex');
}

async function createCaCert(keys: CryptoKeyPair, now = new Date()): Promise<x509.X509Certificate> {
  const escapeRfc4514 = (v: string) => v.replace(/([,+"\\<>;=])/g, '\\$1');
  const name = `CN=${escapeRfc4514(CA_COMMON_NAME)}, O=${escapeRfc4514(CA_ORGANIZATION)}`;
  return x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomPositiveSerial(),
    name,
    notBefore: new Date(now.getTime() - 60 * 60 * 1000),
    notAfter: new Date(now.getTime() + CA_VALIDITY_DAYS * DAY_MS),
    keys,
    signingAlgorithm: SIGNING_ALGORITHM,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
      buildNameConstraints(),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
}

async function writeAtomic(file: string, data: string, mode: number): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, data, { mode });
  await chmod(tmp, mode);
  await rename(tmp, file);
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function samePublicKey(a: CryptoKey, b: CryptoKey): Promise<boolean> {
  return Buffer.from(await spkiDer(a)).equals(Buffer.from(await spkiDer(b)));
}

async function writeLeafPublicKey(paths: CaPaths, publicKey: CryptoKey): Promise<void> {
  const pem = x509.PemConverter.encode(await spkiDer(publicKey), 'PUBLIC KEY');
  await writeAtomic(paths.leafPublicKeyPath, `${pem}\n`, 0o644);
}

async function generateCa(paths: CaPaths): Promise<void> {
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  const keys = await generateKeyPair();
  const leafKeys = await generateKeyPair();
  const cert = await createCaCert(keys);
  await writeAtomic(paths.keyPath, await exportPrivateKeyPem(keys.privateKey), 0o600);
  await writeAtomic(paths.leafKeyPath, await exportPrivateKeyPem(leafKeys.privateKey), 0o600);
  await writeLeafPublicKey(paths, leafKeys.publicKey);
  await writeAtomic(paths.certPath, `${cert.toString('pem')}\n`, 0o644);
}

export async function loadCa(dir: string): Promise<EvalCa> {
  const paths = caPaths(dir);
  const [certPem, keyPem, leafKeyPem] = await Promise.all([
    readFile(paths.certPath, 'utf8'),
    readFile(paths.keyPath, 'utf8'),
    readFile(paths.leafKeyPath, 'utf8'),
  ]);
  const cert = new x509.X509Certificate(certPem);
  const keys = await importKeyPairPem(keyPem);
  const leafKeys = await importKeyPairPem(leafKeyPem);
  const certPub = await cert.publicKey.export();
  if (!(await samePublicKey(certPub, keys.publicKey))) {
    throw new Error(`eval CA at ${paths.dir}: ca-key.pem does not match ca.pem (run rotateCa)`);
  }
  return { paths, cert, certPem: `${cert.toString('pem')}\n`, keys, leafKeys, leafKeyPem };
}

export interface EnsureCaOptions {
  renewBeforeDays?: number;
  now?: Date;
}

function needsRenewal(cert: x509.X509Certificate, now: Date, renewBeforeDays: number): boolean {
  return cert.notAfter.getTime() - now.getTime() < renewBeforeDays * DAY_MS;
}

export function hasEvalNameConstraint(cert: x509.X509Certificate): boolean {
  const ext = cert.getExtension(id_ce_nameConstraints);
  if (!ext?.critical) return false;
  const nc = AsnConvert.parse(ext.value, NameConstraints);
  const permitted = nc.permittedSubtrees ?? [];
  return permitted.length === 1 && permitted[0]?.base.dNSName === EVAL_DOMAIN;
}

export async function ensureCa(dir: string, opts: EnsureCaOptions = {}): Promise<EvalCa> {
  const paths = caPaths(dir);
  const now = opts.now ?? new Date();
  const renewBefore = opts.renewBeforeDays ?? CA_RENEW_BEFORE_DAYS;
  const present =
    (await exists(paths.certPath)) &&
    (await exists(paths.keyPath)) &&
    (await exists(paths.leafKeyPath));
  if (present) {
    try {
      const ca = await loadCa(dir);
      if (!needsRenewal(ca.cert, now, renewBefore) && hasEvalNameConstraint(ca.cert)) {
        await chmod(paths.keyPath, 0o600);
        await chmod(paths.leafKeyPath, 0o600);
        if (!(await exists(paths.leafPublicKeyPath)))
          await writeLeafPublicKey(paths, ca.leafKeys.publicKey);
        return ca;
      }
    } catch {}
  }
  await generateCa(paths);
  return loadCa(dir);
}

export async function rotateCa(dir: string): Promise<EvalCa> {
  const paths = caPaths(dir);
  await Promise.all(
    [
      paths.certPath,
      paths.keyPath,
      paths.leafKeyPath,
      paths.leafPublicKeyPath,
      paths.bundlePath,
    ].map((f) => rm(f, { force: true })),
  );
  await generateCa(paths);
  return loadCa(dir);
}
