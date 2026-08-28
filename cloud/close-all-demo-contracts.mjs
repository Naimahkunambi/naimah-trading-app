import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.join(os.homedir(), 'sani-cloud');
const CREDS_PATH = path.join(ROOT, 'deriv-demo.json');

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

async function verifyDemo(creds) {
  const r = await fetch('https://api.derivws.com/trading/v1/options/accounts', {
    headers: {
      'Deriv-App-ID': String(creds.appId),
      Authorization: `Bearer ${creds.token}`,
      Accept: 'application/json'
    }
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.errors?.[0]?.message || `Account check failed ${r.status}`);
  const rows = Array.isArray(j.data) ? j.data : [j.data].filter(Boolean);
  const account = rows.find(a => String(a.account_id) === String(creds.accountId));
  if (!account) throw new Error('Configured account was not returned by Deriv.');
  if (String(account.account_type || '').toLowerCase() === 'real') {
    throw new Error('REFUSED: configured account is REAL. This helper is Demo-only.');
  }
  return account;
}

async function otpUrl(creds) {
  const r = await fetch(
    `https://api.derivws.com/trading/v1/options/accounts/${encodeURIComponent(creds.accountId)}/otp`,
    {
      method: 'POST',
      headers: {
        'Deriv-App-ID': String(creds.appId),
        Authorization: `Bearer ${creds.token}`
      }
    }
  );
  const j = await r.json();
  if (!r.ok || !j?.data?.url) throw new Error(j?.errors?.[0]?.message || `OTP failed ${r.status}`);
  return j.data.url;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => reject(new Error('Authenticated WebSocket timeout')), 15000);
    ws.once('open', () => {
      clearTimeout(timeout);
      resolve(ws);
    });
    ws.once('error', e => {
      clearTimeout(timeout);
      reject(e);
    });
  });
}

function requester(ws) {
  let req = 8000;
  const pending = new Map();

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (!msg.req_id || !pending.has(msg.req_id)) return;
    const p = pending.get(msg.req_id);
    pending.delete(msg.req_id);
    clearTimeout(p.timeout);
    if (msg.error) p.reject(new Error(`${msg.error.code || 'DerivError'}: ${msg.error.message || 'request failed'}`));
    else p.resolve(msg);
  });

  return (payload, timeoutMs = 12000) => {
    const req_id = ++req;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(req_id);
        reject(new Error(`Timeout for ${Object.keys(payload)[0]}`));
      }, timeoutMs);
      pending.set(req_id, { resolve, reject, timeout });
      ws.send(JSON.stringify({ ...payload, req_id }));
    });
  };
}

async function portfolio(request) {
  const msg = await request({ portfolio: 1 });
  const contracts = msg?.portfolio?.contracts;
  return Array.isArray(contracts) ? contracts : [];
}

async function main() {
  if (!fs.existsSync(CREDS_PATH)) throw new Error(`Missing ${CREDS_PATH}`);
  const creds = readJson(CREDS_PATH);
  const account = await verifyDemo(creds);
  console.log(`✅ VERIFIED DEMO ${account.account_id} · ${account.currency || 'USD'} ${account.balance}`);

  const ws = await connect(await otpUrl(creds));
  const request = requester(ws);

  let open = await portfolio(request);
  console.log(`\nOPEN DEMO CONTRACTS: ${open.length}`);
  if (!open.length) {
    console.log('✅ Nothing to close. Portfolio is already FLAT.');
    ws.close();
    return;
  }

  for (const c of open) {
    const id = Number(c.contract_id);
    const type = c.contract_type || c.type || '?';
    const symbol = c.symbol || c.underlying || '?';
    const buyPrice = Number(c.buy_price ?? c.purchase_price ?? 0);
    console.log(`• ${id} · ${type} · ${symbol} · buy ${buyPrice}`);
  }

  console.log('\nClosing every OPEN contract on this DEMO account at market...');
  for (const c of open) {
    const id = Number(c.contract_id);
    if (!Number.isFinite(id)) continue;
    try {
      const r = await request({ sell: id, price: 0 });
      const soldFor = Number(r?.sell?.sold_for ?? 0);
      const balanceAfter = r?.sell?.balance_after;
      console.log(`✅ SOLD ${id} · sold_for ${soldFor}${balanceAfter != null ? ` · balance ${balanceAfter}` : ''}`);
    } catch (e) {
      console.error(`❌ COULD NOT SELL ${id}: ${e.message}`);
    }
  }

  await new Promise(r => setTimeout(r, 1200));
  open = await portfolio(request);
  console.log(`\nOPEN DEMO CONTRACTS AFTER CLOSEOUT: ${open.length}`);
  if (open.length === 0) console.log('✅ DEMO PORTFOLIO IS FLAT. Safe to install SANI Native V2 SPEED.');
  else {
    console.log('⚠️ Some contracts are still open:');
    for (const c of open) console.log(`• ${c.contract_id} · ${c.contract_type || '?'} · ${c.symbol || c.underlying || '?'}`);
    process.exitCode = 2;
  }
  ws.close();
}

main().catch(e => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
