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

// This exact immutable Nana deployment is proven by runtime logs to return 200
// for both /api/accounts and /api/otp with the user's current Deriv setup.
// Keep Deriv auth anchored there while the new deployment only changes Nana's AI brain.
const PROVEN_AUTH_ORIGIN = 'https://sani-bos-executor-nadf3822w-naimakunambi-6312s-projects.vercel.app';

async function body(req) {
  let value = '';
  for await (const chunk of req) value += chunk;
  return value ? JSON.parse(value) : {};
}

async function provenDerivProxy(req, res, route) {
  try {
    const input = await body(req);
    const response = await fetch(`${PROVEN_AUTH_ORIGIN}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(input),
      cache: 'no-store',
      redirect: 'follow'
    });
    const text = await response.text();
    res.writeHead(response.status, {
      'content-type': response.headers.get('content-type') || 'application/json',
      'cache-control': 'no-store'
    });
    res.end(text);
  } catch (error) {
    res.writeHead(502, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: `Working Nana auth bridge failed: ${error.message || 'unknown error'}` }));
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
    await nanaAiHandler({
      method: req.method,
      body: parsedBody,
      headers: req.headers || {}
    }, reply);
  } catch (error) {
    if (!res.writableEnded) {
      res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: error?.message || 'Nana AI route failed.' }));
    }
  }
}

http.createServer(async (req, res) => {
  const cleanUrl = req.url.split('?')[0];
  if (req.method === 'POST' && cleanUrl === '/api/accounts') return provenDerivProxy(req, res, '/api/accounts');
  if (req.method === 'POST' && cleanUrl === '/api/otp') return provenDerivProxy(req, res, '/api/otp');
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
