import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { readLeafSpkiFingerprint } from '@aab/pki';

export interface LaunchControlledBrowserOptions {
  /** Port of this role's MITM proxy listener. */
  proxyPort: number;
  /** Proxy host (default 127.0.0.1; inside docker the proxy service name). */
  proxyHost?: string;
  /** PKI dir created by `@aab/pki` `ensureCa` (only its public `leaf-pub.pem` is read). */
  caDir: string;
  /**
   * Fresh profile directory. Must not exist or be empty; deleted on close. Default: a new temp dir.
   */
  profileDir?: string;
  /** Where trace.zip, network.har and screenshots/ go. */
  artifactsDir: string;
  headless?: boolean;
  /** Playwright channel; default: bundled Chromium (`chromium-headless-shell` when headless). */
  channel?: string;
  /** Remote debugging port on 127.0.0.1 (0 = pick a free one). */
  cdpPort?: number;
  /** Record Playwright trace (default true). */
  trace?: boolean;
  /** Record a HAR (default true). */
  har?: boolean;
  viewport?: { width: number; height: number };
  /** Extra Chromium args (appended; cannot re-enable what we disable — later flags may override!). */
  extraArgs?: string[];
}

export interface ControlledBrowser {
  context: BrowserContext;
  /** `http://127.0.0.1:<port>` — for `chromium.connectOverCDP()` / Playwright MCP `--cdp-endpoint`. */
  cdpEndpoint: string;
  /** Browser-level DevTools websocket URL. */
  wsEndpoint: string;
  profileDir: string;
  artifactsDir: string;
  /** SPKI pin passed to `--ignore-certificate-errors-spki-list`. */
  trustedSpki: string;
  /** Chromium args we launched with (for run metadata). */
  args: readonly string[];
  /** The first page (persistent contexts open one). */
  page(): Promise<Page>;
  /** Save a PNG to `<artifactsDir>/screenshots/<name>.png` and return its path. */
  screenshot(name: string, page?: Page): Promise<string>;
  /** Stop tracing (trace.zip), close (flushes network.har), delete the profile. Idempotent. */
  close(): Promise<void>;
}

/** Features turned off: background/phone-home traffic and anything that could bypass the proxy. */
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
    // All traffic, including loopback, through this role's proxy listener.
    `--proxy-server=http://${opts.proxyHost}:${opts.proxyPort}`,
    '--proxy-bypass-list=<-loopback>',
    // Defence in depth: anything that tried to resolve a name *without* the proxy gets NXDOMAIN.
    // (With an HTTP proxy Chromium never resolves destination names itself.)
    `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${opts.proxyHost}`,
    // Trust exactly the eval CA's shared leaf key (see packages/browser/README.md).
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

/** Wait for Chromium to write DevToolsActivePort (port + browser ws path) into the profile. */
async function readDevToolsActivePort(
  profileDir: string,
  timeoutMs = 10_000,
): Promise<{ port: number; wsPath: string }> {
  const file = path.join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const [port, wsPath] = (await readFile(file, 'utf8')).split('\n');
      if (port && wsPath) return { port: Number(port), wsPath };
    } catch {
      /* not yet */
    }
    if (Date.now() > deadline) throw new Error('Chromium did not report a DevTools port');
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Launch Playwright's Chromium with a fresh persistent profile whose every request goes through
 * the given proxy listener, trusting only leaves minted by the eval CA. No OS/user trust store is
 * touched.
 */
export async function launchControlledBrowser(
  opts: LaunchControlledBrowserOptions,
): Promise<ControlledBrowser> {
  // Public material only (leaf-pub.pem): the browser host never needs a private key.
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
      ...(opts.channel ? { channel: opts.channel } : {}),
      args,
      // Never: ignoreHTTPSErrors. A certificate not from our CA must still fail.
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
    devtools = await readDevToolsActivePort(profileDir);
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

/**
 * Attach to a controlled browser over CDP (what the `browser` MCP server does). Closing the
 * returned Browser only disconnects; the owner still has to call `ControlledBrowser.close()`.
 */
export function connectToControlledBrowser(cdpEndpoint: string): Promise<Browser> {
  if (!/^(http|ws):\/\/127\.0\.0\.1:\d+/.test(cdpEndpoint)) {
    throw new Error('controlled browsers only expose CDP on 127.0.0.1');
  }
  return chromium.connectOverCDP(cdpEndpoint);
}
