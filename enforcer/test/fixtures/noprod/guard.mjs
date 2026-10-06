// --import'ed into a child: any fetch to api.instruxi.dev is recorded and refused.
import { appendFileSync } from 'node:fs';
const real = globalThis.fetch;
globalThis.fetch = (u, ...r) => {
  const host = new URL(String(u?.url || u)).hostname;
  if (host.endsWith('instruxi.dev')) { appendFileSync(process.env.NOPROD_LOG, `fetch ${host}\n`); return Promise.reject(new Error('production is off limits in this test')); }
  return real(u, ...r);
};
