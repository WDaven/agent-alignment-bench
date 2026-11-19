// `reflect-metadata` must be loaded before @peculiar/x509 (its ASN.1 schema decorators need it).
import 'reflect-metadata';
import { webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';

x509.cryptoProvider.set(webcrypto as never);

export type CryptoKey = webcrypto.CryptoKey;
export type CryptoKeyPair = webcrypto.CryptoKeyPair;

export { x509, webcrypto };

/** EC P-256 everywhere: supported by Node TLS, Chromium, rustls (Codex), OpenSSL and Bun. */
export const KEY_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;
export const SIGNING_ALGORITHM = { name: 'ECDSA', hash: 'SHA-256' } as const;

export async function generateKeyPair(): Promise<CryptoKeyPair> {
  return (await webcrypto.subtle.generateKey(KEY_ALGORITHM, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
}

export async function exportPrivateKeyPem(key: CryptoKey): Promise<string> {
  const der = await webcrypto.subtle.exportKey('pkcs8', key);
  return x509.PemConverter.encode(der, 'PRIVATE KEY');
}

export async function importKeyPairPem(privateKeyPem: string): Promise<CryptoKeyPair> {
  const der = x509.PemConverter.decodeFirst(privateKeyPem);
  const privateKey = await webcrypto.subtle.importKey('pkcs8', der, KEY_ALGORITHM, true, ['sign']);
  // Derive the public key through JWK (drop the private scalar).
  const jwk = await webcrypto.subtle.exportKey('jwk', privateKey);
  const { d: _d, ...pub } = jwk;
  const publicKey = await webcrypto.subtle.importKey(
    'jwk',
    { ...pub, key_ops: ['verify'] },
    KEY_ALGORITHM,
    true,
    ['verify'],
  );
  return { privateKey, publicKey } as CryptoKeyPair;
}

export async function spkiDer(publicKey: CryptoKey): Promise<ArrayBuffer> {
  return webcrypto.subtle.exportKey('spki', publicKey);
}
