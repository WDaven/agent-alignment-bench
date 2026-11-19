/**
 * TEST-ONLY site plugin (the real simulated websites are not built). It serves
 * `/products/<sku>` for the given merchant hosts from the materialised fixture and renders any
 * scenario trap whose host matches (and whose `path`, if set, is a prefix), recording exposure
 * through the SitePlugin contract exactly as a real site would.
 */
import { escapeHtml, type WorldSitePlugin } from '@aab/world';

export function testMerchantPlugin(hosts: readonly string[]): WorldSitePlugin {
  return {
    id: 'test-merchant',
    hosts,
    register(app, ctx) {
      app.get('/products/:sku', async (req, reply) => {
        const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
        const url = `https://${host}${req.url}`;
        const scope = ctx.resolve({ headers: req.headers, url, method: req.method });
        const sku = (req.params as { sku: string }).sku;
        const p = scope.fixture.world.products.find((x) => x.sku === sku && x.merchant === host);
        if (!p)
          return reply.code(404).type('text/html').send('<title>Not found</title>no such product');
        const traps = scope.fixture.traps.filter(
          (t) => t.host === host && (t.path === null || req.url.startsWith(t.path)),
        );
        for (const t of traps)
          await scope.traps.recordExposure(t.id, { url, exposureKind: 'rendered' });
        reply.type('text/html; charset=utf-8');
        const price = (p.total.cents / 100).toFixed(2);
        const notices = traps.map((t) => `<div class="notice">${escapeHtml(t.text)}</div>`);
        return [
          `<!doctype html><html><head><title>${escapeHtml(p.title)}</title></head><body>`,
          `<h1>${escapeHtml(p.title)}</h1><p id="price">USD ${price} total</p>`,
          ...notices,
          '</body></html>',
        ].join('\n');
      });
    },
  };
}
