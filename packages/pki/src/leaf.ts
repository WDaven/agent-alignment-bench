import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import tls from 'node:tls';
import { isEvalHost } from '@aab/protocol';
import type { EvalCa } from './ca.js';
import { SIGNING_ALGORITHM, x509 } from './crypto.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Default leaf lifetime. Chromium rejects > 398 days; we stay far below. */
export const LEAF_VALIDITY_DAYS = 7;
export const LEAF_MAX_VALIDITY_DAYS = 397;

const DNS_HOST_RE =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export class LeafHostError extends Error {
  constructor(host: string, why: string) {
    super(`refusing to mint a leaf for ${JSON.stringify(host)}: ${why}`);
    this.name = 'LeafHostError';
  }
}

/** Lower-case, strip a trailing dot, validate it is a DNS name under eval.test. */
export function normalizeLeafHost(host: string): string {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  if (isIP(h) || h.startsWith('[')) throw new LeafHostError(host, 'IP literals are not allowed');
  if (!DNS_HOST_RE.test(h)) throw new LeafHostError(host, 'not a valid DNS host name');
  if (!isEvalHost(h)) throw new LeafHostError(host, 'host is outside eval.test');
  return h;
}

export interface LeafCert {
  host: string;
  certPem: string;
  /** Shared leaf key (same for every host minted by this CA). */
  keyPem: string;
  /** Leaf followed by the CA certificate. */
  chainPem: string;
  notBefore: Date;
  notAfter: Date;
}

export interface LeafMinterOptions {
  validityDays?: number;
  /** Max cached hosts (LRU-ish eviction). Default 1000. */
  cacheSize?: number;
  now?: () => Date;
}

function randomSerial(): string {
  const b = randomBytes(16);
  b[0] = b[0]! & 0x7f || 1;
  return b.toString('hex');
}

/** Mints and caches per-host leaf certificates signed by the eval CA. */
export class LeafMinter {
  readonly ca: EvalCa;
  private readonly validityDays: number;
  private readonly cacheSize: number;
  private readonly now: () => Date;
  private readonly cache = new Map<string, Promise<LeafCert>>();
  private readonly contexts = new Map<string, { notAfter: number; ctx: tls.SecureContext }>();

  constructor(ca: EvalCa, opts: LeafMinterOptions = {}) {
    this.ca = ca;
    this.validityDays = opts.validityDays ?? LEAF_VALIDITY_DAYS;
    if (this.validityDays <= 0 || this.validityDays > LEAF_MAX_VALIDITY_DAYS) {
      throw new RangeError(`leaf validity must be 1..${LEAF_MAX_VALIDITY_DAYS} days`);
    }
    this.cacheSize = opts.cacheSize ?? 1000;
    this.now = opts.now ?? (() => new Date());
  }

  /** Get (or mint) the leaf for `host`. Throws `LeafHostError` for hosts outside eval.test. */
  async mint(host: string): Promise<LeafCert> {
    const h = normalizeLeafHost(host);
    const cached = this.cache.get(h);
    if (cached) {
      // Refresh entries that are within an hour of expiry (or that failed).
      return cached.then(
        (leaf) =>
          leaf.notAfter.getTime() - this.now().getTime() > 60 * 60 * 1000 ? leaf : this.fresh(h),
        () => this.fresh(h),
      );
    }
    return this.fresh(h);
  }

  private fresh(h: string): Promise<LeafCert> {
    const p = this.create(h);
    this.cache.delete(h);
    this.cache.set(h, p);
    while (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
      this.contexts.delete(oldest);
    }
    p.catch(() => this.cache.delete(h));
    return p;
  }

  /** A ready TLS SecureContext for `host` (leaf + CA chain), cached alongside the leaf. */
  async secureContext(host: string): Promise<tls.SecureContext> {
    const leaf = await this.mint(host);
    const c = this.contexts.get(leaf.host);
    if (c && c.notAfter === leaf.notAfter.getTime()) return c.ctx;
    const ctx = tls.createSecureContext({ cert: leaf.chainPem, key: leaf.keyPem });
    this.contexts.set(leaf.host, { notAfter: leaf.notAfter.getTime(), ctx });
    return ctx;
  }

  private async create(host: string): Promise<LeafCert> {
    const now = this.now();
    const notBefore = new Date(now.getTime() - 60 * 60 * 1000);
    const caNotAfter = this.ca.cert.notAfter.getTime();
    const notAfter = new Date(Math.min(now.getTime() + this.validityDays * DAY_MS, caNotAfter));
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: randomSerial(),
      subject: `CN=${host}`,
      issuer: this.ca.cert.subject,
      notBefore,
      notAfter,
      publicKey: this.ca.leafKeys.publicKey,
      signingKey: this.ca.keys.privateKey,
      signingAlgorithm: SIGNING_ALGORITHM,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], false),
        new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: host }], false),
        await x509.SubjectKeyIdentifierExtension.create(this.ca.leafKeys.publicKey),
        await x509.AuthorityKeyIdentifierExtension.create(this.ca.keys.publicKey, false),
      ],
    });
    const certPem = cert.toString('pem') + '\n';
    return {
      host,
      certPem,
      keyPem: this.ca.leafKeyPem,
      chainPem: certPem + this.ca.certPem,
      notBefore,
      notAfter,
    };
  }
}

const minters = new WeakMap<EvalCa, LeafMinter>();

/** Convenience: mint via a per-CA shared `LeafMinter` (in-memory cache). */
export function mintLeaf(ca: EvalCa, host: string): Promise<LeafCert> {
  let m = minters.get(ca);
  if (!m) {
    m = new LeafMinter(ca);
    minters.set(ca, m);
  }
  return m.mint(host);
}
