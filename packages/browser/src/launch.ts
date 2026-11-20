import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { readLeafSpkiFingerprint } from '@aab/pki';

export interface LaunchControlledBrowserOptions {
  proxyPort: number;
  proxyHost?: string;
  caDir: string;
  profileDir?: string;
  artifactsDir: string;
  headless?: boolean;
  chromiumSandbox?: boolean;
  devToolsTimeoutMs?: number;
  channel?: string;
  cdpPort?: number;
  trace?: boolean;
  har?: boolean;
  viewport?: { width: number; height: number };
  extraArgs?: string[];
}

export interface ControlledBrowser {
  context: BrowserContext;
  cdpEndpoint: string;
  wsEndpoint: string;
  profileDir: string;
  artifactsDir: string;
  trustedSpki: string;
  args: readonly string[];
  page(): Promise<Page>;
  screenshot(name: string, page?: Page): Promise<string>;
  close(): Promise<void>;
}

const DISABLED_FEATURES = [
  'AutofillServerCommunication',
  'CertificateTransparencyComponentUpdater',
  'DnsOverHttps',
  'InterestFeedContentSuggestions',
  'MediaRouter',
  'NetworkTimeServiceQuerying',
  'OptimizationHints',
  'PrivacySandboxSettings4',
  'SafeBrowsingBetterTelemetryAcrossReports',
  'Translate',
  'WebRtcHideLocalIpsWithMdns',
];

export function controlledChromiumArgs(opts: {
  proxyHost: string;
  proxyPort: number;
  spki: string;
  cdpPort: number;
}): string[] {
  return [
    `--proxy-server=http://${opts.proxyHost}:${opts.proxyPort}`,
    '--proxy-bypass-list=<-loopback>',
    `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${opts.proxyHost}`,
    `--ignore-certificate-errors-spki-list=${opts.spki}`,
    '--disable-quic',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-domain-reliability',
    '--disable-client-side-phishing-detection',
    '--disable-breakpad',
    '--metrics-recording-only',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-pings',
    '--dns-prefetch-disable',
    '--password-store=basic',
    '--use-mock-keychain',
    ...(process.platform === 'linux' ? ['--disable-dev-shm-usage'] : []),
    `--disable-features=${DISABLED_FEATURES.join(',')}`,
    `--remote-debugging-address=127.0.0.1`,
    `--remote-debugging-port=${opts.cdpPort}`,
  ];
}

async function freshProfileDir(dir: string | undefined): Promise<string> {
  if (!dir) return mkdtemp(path.join(os.tmpdir(), 'aab-chromium-profile-'));
  const d = path.resolve(dir);
  try {
    const entries = await readdir(d);
    if (entries.length > 0)
      throw new Error(`profileDir ${d} is not empty; profiles are single-use`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  await mkdir(d, { recursive: true, mode: 0o700 });
  return d;
}

async function readDevToolsActivePort(
  profileDir: string,
  timeoutMs: number,
): Promise<{ port: number; wsPath: string }> {
  const file = path.join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const [port, wsPath] = (await readFile(file, 'utf8')).split('\n');
      if (port && wsPath) return { port: Number(port), wsPath };
    } catch {}
    if (Date.now() > deadline) throw new Error('Chromium did not report a DevTools port');
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function launchControlledBrowser(
  opts: LaunchControlledBrowserOptions,
): Promise<ControlledBrowser> {
  const spki = await readLeafSpkiFingerprint(opts.caDir);
  const profileDir = await freshProfileDir(opts.profileDir);
  const artifactsDir = path.resolve(opts.artifactsDir);
  await mkdir(path.join(artifactsDir, 'screenshots'), { recursive: true });
  const args = [
    ...controlledChromiumArgs({
      proxyHost: opts.proxyHost ?? '127.0.0.1',
      proxyPort: opts.proxyPort,
      spki,
      cdpPort: opts.cdpPort ?? 0,
    }),
    ...(opts.extraArgs ?? []),
  ];
  const harPath = path.join(artifactsDir, 'network.har');
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless: opts.headless ?? true,
      chromiumSandbox: opts.chromiumSandbox ?? false,
      ...(opts.channel ? { channel: opts.channel } : {}),
      args,
      ignoreHTTPSErrors: false,
      serviceWorkers: 'block',
      acceptDownloads: false,
      viewport: opts.viewport ?? { width: 1280, height: 800 },
      ...(opts.har === false ? {} : { recordHar: { path: harPath, mode: 'full' as const } }),
    });
  } catch (e) {
    await rm(profileDir, { recursive: true, force: true });
    throw e;
  }
  const tracing = opts.trace !== false;
  if (tracing) await context.tracing.start({ screenshots: true, snapshots: true, sources: false });

  let devtools: { port: number; wsPath: string };
  try {
    devtools = await readDevToolsActivePort(profileDir, opts.devToolsTimeoutMs ?? 30_000);
  } catch (e) {
    await context.close().catch(() => {});
    await rm(profileDir, { recursive: true, force: true });
    throw e;
  }
  const cdpEndpoint = `http://127.0.0.1:${devtools.port}`;
  const wsEndpoint = `ws://127.0.0.1:${devtools.port}${devtools.wsPath}`;

  let closed: Promise<void> | null = null;
  const browser: ControlledBrowser = {
    context,
    cdpEndpoint,
    wsEndpoint,
    profileDir,
    artifactsDir,
    trustedSpki: spki,
    args,
    async page() {
      return context.pages()[0] ?? (await context.newPage());
    },
    async screenshot(name, page) {
      const safe = name.replace(/[^A-Za-z0-9._-]/g, '_');
      const file = path.join(artifactsDir, 'screenshots', `${safe}.png`);
      await (page ?? (await browser.page())).screenshot({ path: file, fullPage: true });
      return file;
    },
    close() {
      closed ??= (async () => {
        try {
          if (tracing)
            await context.tracing
              .stop({ path: path.join(artifactsDir, 'trace.zip') })
              .catch(() => {});
          await context.close();
        } finally {
          await rm(profileDir, { recursive: true, force: true, maxRetries: 3 });
        }
      })();
      return closed;
    },
  };
  return browser;
}

export function connectToControlledBrowser(cdpEndpoint: string): Promise<Browser> {
  if (!/^(http|ws):\/\/127\.0\.0\.1:\d+/.test(cdpEndpoint)) {
    throw new Error('controlled browsers only expose CDP on 127.0.0.1');
  }
  return chromium.connectOverCDP(cdpEndpoint);
}
