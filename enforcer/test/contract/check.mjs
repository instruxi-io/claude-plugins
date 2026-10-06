// The contract checker: a used.json call list against an OpenAPI 3 document per service.
// Pure functions, no network: the test loads the locked specs (or a directory of specs the nightly fetched) and calls check().

const STD_HEADERS = new Set(['content-type', 'accept', 'user-agent', 'x-request-id', 'x-api-key', 'authorization', 'idempotency-key']);
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'];

/** Resolve `$ref` and merge `allOf`; the result has `properties`, `items`, `additionalProperties` as the spec gives them. */
export function resolve(doc, schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 20) return {};
  if (schema.$ref) {
    const name = String(schema.$ref).replace('#/components/schemas/', '');
    return resolve(doc, doc.components?.schemas?.[name], depth + 1);
  }
  if (Array.isArray(schema.allOf)) {
    const merged = { ...schema }; delete merged.allOf;
    for (const part of schema.allOf) {
      const r = resolve(doc, part, depth + 1);
      merged.properties = { ...(merged.properties || {}), ...(r.properties || {}) };
      if (r.additionalProperties !== undefined) merged.additionalProperties = r.additionalProperties;
      if (r.items && !merged.items) merged.items = r.items;
    }
    return merged;
  }
  return schema;
}

/** Is `path` (a.b.c) a field of `schema`? Arrays are looked through; an open object (additionalProperties) accepts any key. */
export function hasField(doc, schema, path) {
  let s = resolve(doc, schema);
  for (const key of path.split('.')) {
    while (s.type === 'array' || (s.items && !s.properties)) s = resolve(doc, s.items);
    if (s.properties && Object.hasOwn(s.properties, key)) { s = resolve(doc, s.properties[key]); continue; }
    if (s.additionalProperties) return true;                      // a free-form object: anything goes below here
    if (!s.properties && !s.type && !s.items) return true;       // an untyped schema (`{}`): nothing is claimed
    return false;
  }
  return true;
}

const segs = (p) => p.split('/').filter(Boolean);
const isParam = (s) => /^\{.*\}$/.test(s);

/** Spec operations whose path template matches the used one: a `{}` in the used path stands for any segment. */
export function matchPaths(doc, usedPath) {
  const u = segs(usedPath);
  const out = [];
  for (const [p, item] of Object.entries(doc.paths || {})) {
    const s = segs(p);
    if (s.length !== u.length) continue;
    if (s.every((seg, i) => seg === u[i] || isParam(seg) || u[i] === '{}')) out.push([p, item]);
  }
  // an exact template (same literals) before a looser one
  return out.sort(([a], [b]) => segs(b).filter((x) => !isParam(x)).length - segs(a).filter((x) => !isParam(x)).length);
}

export function operation(doc, method, usedPath) {
  for (const [p, item] of matchPaths(doc, usedPath)) {
    const op = item[method.toLowerCase()];
    if (op) return { path: p, op, item };
  }
  return null;
}

const jsonSchema = (content) => content?.['application/json']?.schema ?? content?.['*/*']?.schema ?? Object.values(content || {})[0]?.schema;
export const requestSchema = (op) => jsonSchema(op.requestBody?.content);
export function responseSchema(op) {
  for (const code of Object.keys(op.responses || {}).filter((c) => /^2/.test(c)).sort()) {
    const s = jsonSchema(op.responses[code]?.content);
    if (s) return s;
  }
  return undefined;
}
const headerParams = (op, item) => new Set([...(item.parameters || []), ...(op.parameters || [])].filter((p) => p.in === 'header').map((p) => String(p.name).toLowerCase()));

/** Violations of one used call: [{id, kind, field?, message}]. kinds: path, method, sent, read, header. */
export function checkCall(call, doc) {
  const out = [];
  const v = (kind, message, field) => out.push({ id: call.id, kind, ...(field ? { field } : {}), message });
  const paths = matchPaths(doc, call.path);
  if (!paths.length) { v('path', `${call.service}: no path ${call.path} in the spec`); return out; }
  const found = operation(doc, call.method, call.path);
  if (!found) { v('method', `${call.service}: ${call.path} exists but not for ${call.method} (spec has ${METHODS.filter((m) => paths.some(([, i]) => i[m])).join(', ').toUpperCase()})`); return out; }
  const { op, item } = found;
  if (call.sends?.length) {
    const rs = requestSchema(op);
    for (const f of call.sends) if (!rs) v('sent', `${call.method} ${call.path} sends ${f} but the spec takes no JSON body`, f); else if (!hasField(doc, rs, f)) v('sent', `${call.method} ${call.path} sends ${f}, not in the request schema`, f);
  }
  if (call.reads?.length) {
    const rs = responseSchema(op);
    for (const f of call.reads) if (!rs) v('read', `${call.method} ${call.path} reads ${f} but the spec has no JSON response`, f); else if (!hasField(doc, rs, f)) v('read', `${call.method} ${call.path} reads ${f}, not in the response schema`, f);
  }
  const allowed = headerParams(op, item);
  for (const h of call.headers || []) if (!STD_HEADERS.has(h.toLowerCase()) && !allowed.has(h.toLowerCase())) v('header', `${call.method} ${call.path} names header ${h}, not a parameter in the spec`, h);
  return out;
}

/** All violations of a used.json `calls` list; `docs` maps service -> OpenAPI 3 document. */
export function check(calls, docs) {
  return calls.flatMap((c) => (docs[c.service] ? checkCall(c, docs[c.service]) : [{ id: c.id, kind: 'path', message: `no spec loaded for service ${c.service}` }]));
}
