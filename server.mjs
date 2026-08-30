import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(root, 'public');
const port = Number(process.env.PORT || 3000);
const mime = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.xml': 'application/xml', '.svg': 'image/svg+xml', '.png': 'image/png'
};
const headers = (appId, token) => ({ 'Deriv-App-ID': String(appId), Authorization: `Bearer ${token}`, Accept: 'application/json' });

async function body(req) {
  let value = '';
  for await (const chunk of req) value += chunk;
  return value ? JSON.parse(value) : {};
}

async function proxy(req, res, type) {
  try {
    const input = await body(req);
    const { appId, token } = input;
    if (!appId || !token) throw Object.assign(new Error('App ID and token are required.'), { status: 400 });
    let verifiedAccount = null;

    if (type === 'otp' && input.demoOnly) {
      const checked = await fetch('https://api.derivws.com/trading/v1/options/accounts', {
        method: 'GET', headers: headers(appId, token), cache: 'no-store'
      });
      const checkedPayload = await checked.json().catch(() => ({}));
      if (!checked.ok) throw Object.assign(new Error(checkedPayload?.errors?.[0]?.message || 'Could not verify Demo account.'), { status: checked.status });
      const accounts = Array.isArray(checkedPayload?.data) ? checkedPayload.data : [checkedPayload?.data].filter(Boolean);
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
    const response = await fetch(url, { method, headers: headers(appId, token), cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));
    const success = type === 'otp'
      ? { url: payload?.data?.url, otpExpiresIn: 120, ...(verifiedAccount ? { account: verifiedAccount, demoOnly: true } : {}) }
      : { accounts: Array.isArray(payload.data) ? payload.data : [payload.data].filter(Boolean) };
    res.writeHead(response.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(response.ok ? success : { error: payload?.errors?.[0]?.message || 'Deriv API error' }));
  } catch (error) {
    res.writeHead(error.status || 500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: error.message || 'Unexpected error' }));
  }
}

http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/accounts') return proxy(req, res, 'accounts');
  if (req.method === 'POST' && req.url === '/api/otp') return proxy(req, res, 'otp');
  const rel = req.url === '/' ? 'index.html' : req.url.split('?')[0].replace(/^\//, '');
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
