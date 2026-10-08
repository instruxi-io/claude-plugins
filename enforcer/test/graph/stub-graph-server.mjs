// A stub graph server that serves ONE runnable node and records claim, heartbeat and report calls.
// Shared by the real-worker end to end test. test/graph/stub-graph.mjs (the hook stub) is a separate, older fixture.
import http from 'node:http';

export async function startNodeStub({ graphId = 'g1', node, key = 'stub-key' }) {
  const stub = { log: [], claims: 0, heartbeats: 0, reports: [], completed: false };
  const send = (res, code, body) => {
    const data = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
    res.end(data);
  };
  const card = () => ({
    state: 'claimed',
    graph_id: graphId,
    node,
    run: { run_id: 'r1', attempt: 1, lease_expires_at: '2030-01-01T00:00:00Z' },
    acceptance: node.acceptance || [],
  });
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {}
      stub.log.push({ method: req.method, path: req.url, body });
      if (req.headers['x-api-key'] !== key && req.headers.authorization !== `Bearer ${key}`)
        return send(res, 401, { success: false, error: 'unauthenticated' });
      const p = req.url.split('?')[0];
      if (req.method === 'GET' && p.endsWith('/frontier'))
        return send(res, 200, { success: true, data: [{ id: node.node_id, key: node.key, status: 'pending', type: 'task' }] });
      if (req.method === 'POST' && /\/(next|claim)$/.test(p)) {
        stub.claims++;
        return send(res, 200, { success: true, data: card() });
      }
      if (req.method === 'POST' && p.endsWith('/heartbeat')) {
        stub.heartbeats++;
        return send(res, 200, {
          success: true,
          data: { state: 'ok', run_id: 'r1', attempt: 1, run_status: 'running', lease_expires_at: '2030-01-01T00:00:00Z' },
        });
      }
      if (req.method === 'POST' && /\/(report|complete)$/.test(p)) {
        stub.reports.push(body);
        if (body.status === 'succeeded') stub.completed = true;
        return send(res, 200, { success: true, data: { status: body.status, node_status: 'done' } });
      }
      if (req.method === 'POST' && p.endsWith('/observations')) return send(res, 201, { success: true, data: { id: 'o1' } });
      send(res, 404, { success: false, error: 'not_found' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  stub.url = `http://127.0.0.1:${server.address().port}`;
  stub.close = () =>
    new Promise((r) => {
      server.closeAllConnections?.();
      server.close(r);
    });
  return stub;
}
