import http from 'node:http';
import { buildWorkerEngine } from './worker-lib.mjs';

const port = Number(process.env.WORKER_PORT || 8787);
const key = process.env.WORKER_CONTROL_KEY || '';
if (!key && process.env.WORKER_ALLOW_INSECURE_LOCAL !== 'true') {
  throw new Error('WORKER_CONTROL_KEY is required. Set WORKER_ALLOW_INSECURE_LOCAL=true only for local testing.');
}

let engine = null;
let workerMeta = {};
let last = { status: 'idle', connected: false, worker: workerMeta };
let building = null;

const auth = req => !key || req.headers['x-worker-key'] === key;
async function getBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}
function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}
async function ensure() {
  if (engine?.snapshot().connected) return engine;
  if (building) return building;
  building = buildWorkerEngine({ onSnapshot: snapshot => { last = { ...snapshot, worker: workerMeta }; } })
    .then(result => {
      engine = result.engine;
      workerMeta = { accountType: result.context.account.account_type, accountId: result.context.accountId };
      last = { ...engine.snapshot(), worker: workerMeta };
      return engine;
    })
    .finally(() => { building = null; });
  return building;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', process.env.WORKER_CORS_ORIGIN || '*');
  res.setHeader('access-control-allow-headers', 'content-type,x-worker-key');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (!auth(req)) return json(res, 401, { error: 'Unauthorized' });

  try {
    if (req.url === '/health' && req.method === 'GET') return json(res, 200, { ok: true, status: last.status, connected: Boolean(last.connected) });
    if (req.url === '/status' && req.method === 'GET') return json(res, 200, engine ? { ...engine.snapshot(), worker: workerMeta } : last);

    if (req.url === '/connect' && req.method === 'POST') {
      const e = await ensure();
      return json(res, 200, { ...e.snapshot(), worker: workerMeta });
    }
    if (req.url === '/start' && req.method === 'POST') {
      const e = await ensure();
      const body = await getBody(req);
      if (Object.keys(body).length) e.setConfig(body);
      e.start();
      return json(res, 200, { ...e.snapshot(), worker: workerMeta });
    }
    if (req.url === '/pause' && req.method === 'POST') {
      engine?.pause();
      return json(res, 200, engine ? { ...engine.snapshot(), worker: workerMeta } : last);
    }
    if (req.url === '/stop' && req.method === 'POST') {
      engine?.stop();
      return json(res, 200, engine ? { ...engine.snapshot(), worker: workerMeta } : last);
    }
    if (req.url === '/reset' && req.method === 'POST') {
      const e = await ensure();
      e.resetSession();
      return json(res, 200, { ...e.snapshot(), worker: workerMeta });
    }
    if (req.url === '/config' && req.method === 'POST') {
      const e = await ensure();
      const body = await getBody(req);
      e.setConfig(body);
      return json(res, 200, { ...e.snapshot(), worker: workerMeta });
    }
    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    return json(res, 500, { error: error.message || 'Unexpected worker error.' });
  }
});

server.listen(port, async () => {
  console.log(`SANI worker control listening on :${port}`);
  if (process.env.AUTO_START === 'true') {
    try {
      const e = await ensure();
      e.start();
    } catch (error) {
      console.error('AUTO_START failed:', error.message);
    }
  }
});
