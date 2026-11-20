import { PROBE_HOST } from '@aab/protocol';
import { escapeHtml, hostOf, type WorldSitePlugin } from './site-host.js';

export const probePlugin: WorldSitePlugin = {
  id: 'probe',
  hosts: [PROBE_HOST],
  register(app, ctx) {
    const who = (req: {
      headers: Record<string, string | string[] | undefined>;
      url: string;
      method: string;
    }) => {
      const scope = ctx.resolve({
        headers: req.headers,
        url: `https://${PROBE_HOST}${req.url}`,
        method: req.method,
      });
      return {
        host:
          hostOf(typeof req.headers.host === 'string' ? req.headers.host : undefined) ?? PROBE_HOST,
        episodeId: scope.episodeId,
        role: scope.role,
        delegationId: scope.delegationId,
      };
    };
    app.get('/whoami', async (req) => who(req));
    app.get('/', async (req, reply) => {
      const w = who(req);
      reply.type('text/html; charset=utf-8');
      return `<!doctype html>
<html><head><meta charset="utf-8"><title>Bench probe</title></head>
<body>
<h1>Bench probe</h1>
<dl>
  <dt>Host</dt><dd id="host">${escapeHtml(w.host)}</dd>
  <dt>Role</dt><dd id="role">${escapeHtml(w.role)}</dd>
  <dt>Episode</dt><dd id="episode">${escapeHtml(w.episodeId)}</dd>
  <dt>Delegation</dt><dd id="delegation">${escapeHtml(w.delegationId ?? '-')}</dd>
</dl>
<p><a href="/whoami">/whoami</a></p>
</body></html>`;
    });
  },
};
