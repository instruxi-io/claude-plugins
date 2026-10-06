// Swagger 2.0 -> OpenAPI 3.0 for the subset swaggo emits (the same shape
// enforcer-v3-mcp/scripts/sync-spec.mjs feeds to swagger2openapi, without the
// dependency, so the plugin stays zero-install). Deterministic: same input,
// same bytes out.
const SIMPLE = ['type', 'format', 'items', 'enum', 'default', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems', 'multipleOf'];
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'];

const fixRefs = (v) => {
  if (Array.isArray(v)) return v.map(fixRefs);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === '$ref' && typeof x === 'string') o[k] = x.replace('#/definitions/', '#/components/schemas/');
      else if (k === 'x-nullable') o.nullable = x;
      else o[k] = fixRefs(x);
    }
    return o;
  }
  return v;
};

const pick = (src) => Object.fromEntries(SIMPLE.filter((k) => src[k] !== undefined).map((k) => [k, fixRefs(src[k])]));

function convertParams(params, consumes) {
  const out = []; let body = null; const form = {}; const required = [];
  for (const p of params || []) {
    if (p.in === 'body') {
      body = { required: !!p.required, description: p.description, content: Object.fromEntries(consumes.map((c) => [c, { schema: fixRefs(p.schema || {}) }])) };
      if (!body.description) delete body.description;
    } else if (p.in === 'formData') {
      form[p.name] = { ...pick(p), ...(p.description ? { description: p.description } : {}) };
      if (p.required) required.push(p.name);
    } else {
      const { name, in: where, description, required: req } = p;
      const np = { name, in: where };
      if (description) np.description = description;
      if (req || where === 'path') np.required = true;
      np.schema = pick(p);
      out.push(np);
    }
  }
  if (Object.keys(form).length) {
    const ct = consumes.find((c) => /form|multipart/.test(c)) || 'multipart/form-data';
    body = { content: { [ct]: { schema: { type: 'object', properties: form, ...(required.length ? { required } : {}) } } } };
  }
  return { parameters: out, requestBody: body };
}

export function swagger2ToOpenapi3(s2) {
  if (!s2 || !String(s2.swagger || '').startsWith('2')) throw new Error('not a Swagger 2.0 document');
  const gConsumes = s2.consumes?.length ? s2.consumes : ['application/json'];
  const gProduces = s2.produces?.length ? s2.produces : ['application/json'];
  const doc = { openapi: '3.0.0', info: fixRefs(s2.info || {}) };
  if (s2.host || s2.basePath) {
    const scheme = (s2.schemes && s2.schemes[0]) || 'https';
    doc.servers = [{ url: s2.host ? `${scheme}://${s2.host}${s2.basePath || ''}` : s2.basePath }];
  }
  if (s2.tags) doc.tags = s2.tags;
  doc.paths = {};
  for (const [path, item] of Object.entries(s2.paths || {})) {
    const pi = {};
    for (const [m, op] of Object.entries(item)) {
      if (m === 'parameters') { pi.parameters = convertParams(item.parameters, gConsumes).parameters; continue; }
      if (!METHODS.includes(m)) { pi[m] = fixRefs(op); continue; }
      const consumes = op.consumes?.length ? op.consumes : gConsumes;
      const produces = op.produces?.length ? op.produces : gProduces;
      const { parameters, requestBody } = convertParams(op.parameters, consumes);
      const { parameters: _p, consumes: _c, produces: _pr, responses, ...rest } = op;
      const n = { ...fixRefs(rest) };
      if (parameters.length) n.parameters = parameters;
      if (requestBody) n.requestBody = requestBody;
      n.responses = {};
      for (const [code, r] of Object.entries(responses || {})) {
        const nr = { description: r.description ?? '' };
        if (r.schema) nr.content = Object.fromEntries(produces.map((c) => [c, { schema: fixRefs(r.schema) }]));
        if (r.headers) nr.headers = Object.fromEntries(Object.entries(r.headers).map(([h, v]) => [h, { description: v.description, schema: pick(v) }]));
        n.responses[code] = nr;
      }
      pi[m] = n;
    }
    doc.paths[path] = pi;
  }
  const comps = {};
  if (s2.definitions) comps.schemas = fixRefs(s2.definitions);
  if (s2.securityDefinitions) {
    comps.securitySchemes = Object.fromEntries(Object.entries(s2.securityDefinitions).map(([k, d]) => {
      if (d.type === 'basic') return [k, { type: 'http', scheme: 'basic' }];
      if (d.type === 'oauth2') return [k, { type: 'oauth2', flows: { [d.flow === 'accessCode' ? 'authorizationCode' : d.flow]: { authorizationUrl: d.authorizationUrl, tokenUrl: d.tokenUrl, scopes: d.scopes || {} } } }];
      return [k, d];
    }));
  }
  if (Object.keys(comps).length) doc.components = comps;
  if (s2.security) doc.security = s2.security;
  return doc;
}
