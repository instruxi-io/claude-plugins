// Secret redaction: the same pattern set, order and output as lib/graph/lib.py redact().
const R = [
  ['pem', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$(?![\s\S]))/g, null],
  ['bearer', /(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1'],
  ['basic', /(\bBasic\s+)[A-Za-z0-9+/=]{8,}/gi, '$1'],
  ['jwt', /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, null],
  ['apikey', /(\bX-API-Key:\s*)[^\s'"]+/gi, '$1'],
  ['aws', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, null],
  ['github', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, null],
  ['slack', /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, null],
  ['env', /(\b[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*)(?!\[redacted:)(?:"[^"\n]*"|'[^'\n]*'|[^\s'"]+)/g, '$1'],
];

/** Returns [text, count]. */
export function redact(text) {
  if (typeof text !== 'string' || !text) return [text, 0];
  let total = 0;
  for (const [kind, rx, keep] of R) {
    const tag = `[redacted:${kind}]`;
    text = text.replace(rx, (...m) => { total++; return keep ? m[1] + tag : tag; });
  }
  return [text, total];
}
