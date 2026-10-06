// A stand-in for the enforcer-graph API, just enough for the hooks (replaces test/stub_graph.py).
//
//   GET  /api/v1/graph/graphs/{g}/frontier          two runnable nodes
//   GET  /api/v1/graph/graphs/{g}/nodes             five nodes with mixed statuses
//   GET  /api/v1/mcp/health                         public; the body is stub.health (404 when null)
//   POST .../nodes/{n}/runs/{r}/heartbeat           state from stub.hb (default "ok")
//   POST .../nodes/{n}/observations                 records the body
//   POST /token                                     the refresh_token grant, form-encoded like the real one
//
// Every request is appended to stub.log as one object. Wrong key -> 401.
import http from 'node:http';

// An OAuth access token works as well as the key; stub-token-2 is what a refresh hands out.
const BEARERS = ['Bearer stub-token', 'Bearer stub-token-2'];

export async function startStub() {
  const stub = { log: [], hb: 'ok', health: null, clear() { stub.log.length = 0; } };
  const send = (res, code, body) => {
    const data = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
    res.end(data);
  };
  const authed = (req, res) => {
    if (req.headers['x-api-key'] !== 'stub-key' && !BEARERS.includes(req.headers.authorization)) {
      send(res, 401, { success: false, error: 'unauthenticated' });
      return false;
    }
    return true;
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const path = req.url;
      if (req.method === 'GET') {
        stub.log.push({ method: 'GET', path });
        if (path === '/api/v1/mcp/health') return stub.health ? send(res, 200, stub.health) : send(res, 404, { success: false });
        if (!authed(req, res)) return;
        if (path.endsWith('/frontier')) {
          return send(res, 200, { success: true, data: [
            { id: 'n1', key: 'api-contract', status: 'pending', type: 'task' },
            { id: 'n2', key: 'legal-and-key', status: 'pending', type: 'human' }] });
        }
        if (path.includes('/nodes')) {
          return send(res, 200, { success: true, data: [
            { id: 'n1', key: 'api-contract', status: 'pending' },
            { id: 'n2', key: 'legal-and-key', status: 'pending' },
            { id: 'n3', key: 'schema-judgment', status: 'running' },
            { id: 'n4', key: 'old-node', status: 'done' },
            { id: 'n5', key: 'broken', status: 'failed' }], meta: { limit: 100, offset: 0, total: 5 } });
        }
        return send(res, 404, { success: false, error: 'not_found' });
      }
      if (req.method === 'POST') {
        if (path === '/token') {
          const f = Object.fromEntries(new URLSearchParams(raw));
          stub.log.push({ method: 'POST', path: '/token', body: f });
          if (f.grant_type === 'refresh_token' && f.refresh_token === 'rt-1' && f.client_id === 'mcp_test') {
            return send(res, 200, { access_token: 'stub-token-2', refresh_token: 'rt-2', expires_in: 900, scope: 'enforcer:read enforcer:graph-runs.write' });
          }
          return send(res, 400, { error: 'invalid_grant' });
        }
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch {}
        stub.log.push({ method: 'POST', path, body, client: req.headers['x-graph-client'] });
        if (!authed(req, res)) return;
        if (path.endsWith('/heartbeat')) {
          return send(res, 200, { success: true, data: { state: stub.hb || 'ok', run_id: 'r1', attempt: 1, run_status: 'running', lease_expires_at: '2030-01-01T00:00:00Z' } });
        }
        if (path.endsWith('/observations')) return send(res, 201, { success: true, data: { id: 'o1', body: body.body } });
      }
      send(res, 404, { success: false, error: 'not_found' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  stub.port = server.address().port;
  stub.url = `http://127.0.0.1:${stub.port}`;
  stub.logText = () => stub.log.map((r) => JSON.stringify(r)).join('\n');
  stub.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  return stub;
}
