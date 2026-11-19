import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ensureCa } from '@aab/pki';
import { controlledChromiumArgs, launchControlledBrowser } from './index.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'aab-browser-unit-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('controlledChromiumArgs', () => {
  const args = controlledChromiumArgs({
    proxyHost: '127.0.0.1',
    proxyPort: 9999,
    spki: 'AAAA',
    cdpPort: 0,
  });

  it('forces every request (incl. loopback) through the proxy and pins only the leaf SPKI', () => {
    expect(args).toContain('--proxy-server=http://127.0.0.1:9999');
    expect(args).toContain('--proxy-bypass-list=<-loopback>');
    expect(args).toContain('--ignore-certificate-errors-spki-list=AAAA');
    expect(args).not.toContain('--ignore-certificate-errors');
    expect(args.some((a) => a.startsWith('--host-resolver-rules=MAP * ~NOTFOUND'))).toBe(true);
  });

  it('turns off QUIC, non-proxied WebRTC UDP and background traffic', () => {
    for (const f of [
      '--disable-quic',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-default-apps',
      '--disable-extensions',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
    ]) {
      expect(args).toContain(f);
    }
  });
});

describe('launchControlledBrowser', () => {
  it('refuses to reuse a non-empty profile directory', async () => {
    await ensureCa(path.join(tmp, 'pki'));
    const profile = path.join(tmp, 'used-profile');
    mkdirSync(profile);
    writeFileSync(path.join(profile, 'Cookies'), 'x');
    await expect(
      launchControlledBrowser({
        proxyPort: 1,
        caDir: path.join(tmp, 'pki'),
        profileDir: profile,
        artifactsDir: path.join(tmp, 'art'),
      }),
    ).rejects.toThrow(/not empty/);
  });
});
