/** HTML helpers. Everything that reaches the page goes through `esc` (page text and agent output are untrusted). */

const ESC: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

export function esc(value: unknown): string {
  const s =
    value === null || value === undefined ? '' : typeof value === 'string' ? value : String(value);
  return s.replace(/[&<>"'`]/g, (c) => ESC[c] ?? c);
}

/** Anchor id for an event (ids are opaque; encode anyway). */
export function evAnchor(eventId: string): string {
  return `ev-${encodeURIComponent(eventId)}`;
}

export function evLink(eventId: string): string {
  return `<a href="#${esc(evAnchor(eventId))}">${esc(eventId)}</a>`;
}

/** Compact JSON for display, truncated. Escaped. */
export function jsonCell(value: unknown, max = 240): string {
  let s: string;
  try {
    s = JSON.stringify(value) ?? '';
  } catch {
    s = String(value);
  }
  if (s.length > max) s = `${s.slice(0, max)}…`;
  return `<code>${esc(s)}</code>`;
}

export function table(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  cls = '',
): string {
  if (rows.length === 0) return '<p class="muted">none</p>';
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join('');
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('\n');
  return `<table${cls ? ` class="${esc(cls)}"` : ''}><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table>`;
}

export function fmtMetric(v: unknown): string {
  if (v === null || v === undefined) return '<span class="muted">null</span>';
  if (typeof v === 'number') return esc(Number.isInteger(v) ? String(v) : v.toFixed(3));
  return esc(String(v));
}

export const STYLE = `
body{font:14px/1.45 system-ui,sans-serif;margin:16px;max-width:1200px;color:#111;background:#fff}
h1{font-size:20px}h2{font-size:16px;margin-top:28px;border-bottom:1px solid #ccc}h3{font-size:14px}
table{border-collapse:collapse;margin:6px 0 12px;font-size:13px}
td,th{border:1px solid #ccc;padding:3px 6px;vertical-align:top;text-align:left}
th{background:#f3f3f3}code{font-size:12px;white-space:pre-wrap;word-break:break-all}
.muted{color:#777}.bad{color:#a00;font-weight:600}.ok{color:#060}.warn{background:#fff4d6}
.denied{background:#fde8e8}.committed{background:#e9f7ec}.cited{outline:2px solid #a00}
pre{background:#f6f6f6;padding:8px;white-space:pre-wrap;word-break:break-word}
`;

export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'">
<title>${esc(title)}</title><style>${STYLE}</style></head>
<body>
${body}
</body></html>
`;
}
