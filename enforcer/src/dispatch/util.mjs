// Shared helpers for the dispatcher's pure modules (ported from bin/graph-dispatch).

export const CLIP = 4000;

export function clip(s, n = CLIP) {
  if (s.length <= n) return s;
  const half = Math.floor(n / 2) - 20;
  return s.slice(0, half) + `\n…[clipped ${s.length - 2 * half} chars]…\n` + s.slice(s.length - half);
}

// Python's json.dumps(x, sort_keys=True): ", " and ": " separators, ASCII-escaped.
export function pyJson(v, sortKeys = true) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') {
    return JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  }
  if (typeof v === 'number' || typeof v === 'boolean') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map((x) => pyJson(x, sortKeys)).join(', ') + ']';
  let keys = Object.keys(v);
  if (sortKeys) keys = keys.sort();
  return '{' + keys.map((k) => pyJson(k) + ': ' + pyJson(v[k], sortKeys)).join(', ') + '}';
}

// ISO timestamp -> epoch ms, or null.
export function parseTs(s) {
  if (!s) return null;
  const t = Date.parse(String(s));
  return Number.isNaN(t) ? null : t;
}

export const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
export const truthy = (x) =>
  !(x === undefined || x === null || x === false || x === 0 || x === '' || (Array.isArray(x) && x.length === 0) || (isObj(x) && Object.keys(x).length === 0));
