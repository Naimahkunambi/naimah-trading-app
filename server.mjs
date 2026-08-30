import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nanaAiHandler from './api/nana-ai.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(root, 'public');
const port = Number(process.env.PORT || 3000);
const mime = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.xml': 'application/xml', '.svg': 'image/svg+xml', '.png': 'image/png'
};

const fullHeaders = (appId, token) => ({
  'Deriv-App-ID': String(appId).trim(),
  Authorization: `Bearer ${String(token).trim()}`,
  Accept: 'application/json',
  'Content-Type': 'application/json'
});
const bearerHeaders = token => ({
  Authorization: `Bearer ${String(token).trim()}`,
  Accept: 'application/json',
  'Content-Type': 'application/json'
});

function derivError(payload = {}, status = 500) {
  const first = Array.isArray(payload?.errors) ? payload.errors[0] : null;
  const code = String(first?.code || payload?.error?.code || '').trim();
  const message = String(first?.message || payload?.error?.message || payload?.message || '').trim();
  return {
    error: message || (Number(status) === 401 ? 'Invalid or missing Deriv authentication credentials.' : 'Deriv API request failed.'),
    code: code || `HTTP_${status}`,
    status: Number(status)
  };
}

async function derivFetch(url, { method = 'GET', appId, token } = {}) {
  const attempts = [
    { mode: 'APP_ID_PLUS_BEARER', headers: fullHeaders(appId, token) },
    { mode: 'BEARER_ONLY', headers: bearerHeaders(token) }
  ];
  let last = null;
  for (const attempt of attempts) {
    const response = await fetch(url, { method, headers: attempt.headers, cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));
    last = { response, payload, mode: attempt.mode };
    if (response.ok) return last;
    if (response.status !== 401) return last;
  }
  return last;
}

async function body(req) {
  let value = '';
  for await (const chunk of req) value += chunk;
  return value ? JSON.parse(value) : {};
}

async function proxy(req, res, type) {
  try {
    const input = await body(req);
    const appId = String(input.appId || '').trim();
    const token = String(input.token || '').trim();
    if (!appId || !token) throw Object.assign(new Error('App ID and token are required.'), { status: 400 });
    let verifiedAccount = null;
    let verificationMode = '';

    if (type === 'otp' && input.demoOnly) {
      const checked = await derivFetch('https://api.derivws.com/trading/v1/options/accounts', { method: 'GET', appId, token });
      if (!checked?.response?.ok) {
        const detail = derivError(checked?.payload || {}, checked?.response?.status || 500);
        throw Object.assign(new Error(`${detail.code} · ${detail.error}`), { status: detail.status });
      }
      verificationMode = checked.mode;
      const accounts = Array.isArray(checked.payload?.data) ? checked.payload.data : [checked.payload?.data].filter(Boolean);
      verifiedAccount = accounts.find(account => String(account?.account_id || '') === String(input.accountId || ''));
      if (!verifiedAccount) throw Object.assign(new Error('REFUSED: selected account was not returned by Deriv.'), { status: 403 });
      if (!['demo', 'virtual'].includes(String(verifiedAccount.account_type || '').toLowerCase())) {
        throw Object.assign(new Error('REFUSED: Demo execution cannot authorize a real or unverified account.'), { status: 403 });
      }
    }

    let url = 'https://api.derivws.com/trading/v1/options/accounts';
    let method = 'GET';
    if (type === 'otp') {
      if (!input.accountId) throw Object.assign(new Error('Account ID is required.'), { status: 400 });
      url += `/${encodeURIComponent(input.accountId)}/otp`;
      method = 'POST';
    }

    const result = await derivFetch(url, { method, appId, token });
    const response = result.response;
    const payload = result.payload;
    const success = type === 'otp'
      ? { url: payload?.data?.url, otpExpiresIn: 120, authMode: result.mode, ...(verifiedAccount ? { account: verifiedAccount, demoOnly: true, verificationMode } : {}) }
      : { accounts: Array.isArray(payload?.data) ? payload.data : [payload?.data].filter(Boolean), authMode: result.mode };

    res.writeHead(response.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(response.ok ? success : { ...derivError(payload, response.status), authModeTried: result.mode }));
  } catch (error) {
    res.writeHead(error.status || 500, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: error.message || 'Unexpected error', status: error.status || 500 }));
  }
}

async function nanaAiProxy(req, res) {
  let parsedBody = {};
  if (req.method === 'POST') {
    try { parsedBody = await body(req); }
    catch (error) {
      res.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ error: `Invalid JSON body: ${error.message}` }));
    }
  }

  let statusCode = 200;
  const reply = {
    status(code) { statusCode = Number(code) || 200; return this; },
    json(payload) {
      if (res.writableEnded) return;
      res.writeHead(statusCode, {
        'content-type': 'application/json',
        'cache-control': 'no-store, max-age=0',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer'
      });
      res.end(JSON.stringify(payload));
    }
  };

  try {
    await nanaAiHandler({ method: req.method, body: parsedBody, headers: req.headers || {} }, reply);
  } catch (error) {
    if (!res.writableEnded) {
      res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: error?.message || 'Nana AI route failed.' }));
    }
  }
}

http.createServer(async (req, res) => {
  const cleanUrl = req.url.split('?')[0];
  if (req.method === 'POST' && cleanUrl === '/api/accounts') return proxy(req, res, 'accounts');
  if (req.method === 'POST' && cleanUrl === '/api/otp') return proxy(req, res, 'otp');
  if (cleanUrl === '/api/nana-ai') return nanaAiProxy(req, res);
  const rel = cleanUrl === '/' ? 'index.html' : cleanUrl.replace(/^\//, '');
  const file = path.join(pub, rel);
  if (!file.startsWith(pub)) { res.writeHead(403); return res.end(); }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}).listen(port, () => console.log(`SANI BOS Executor http://localhost:${port}`));
