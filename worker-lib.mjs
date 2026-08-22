import fs from 'node:fs';
import path from 'node:path';
import { SaniEngine, DEFAULT_CONFIG } from './public/core/engine.mjs';

export function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export function workerConfigFromEnv() {
  return {
    ...DEFAULT_CONFIG,
    symbol: process.env.DERIV_SYMBOL || DEFAULT_CONFIG.symbol,
    currency: process.env.DERIV_CURRENCY || DEFAULT_CONFIG.currency,
    stake: Number(process.env.STAKE || DEFAULT_CONFIG.stake),
    duration: Number(process.env.DURATION || DEFAULT_CONFIG.duration),
    durationUnit: process.env.DURATION_UNIT || DEFAULT_CONFIG.durationUnit,
    executionMethod: process.env.EXECUTION_METHOD || DEFAULT_CONFIG.executionMethod,
    takeProfit: Number(process.env.TP || DEFAULT_CONFIG.takeProfit),
    stopLoss: Number(process.env.SL || DEFAULT_CONFIG.stopLoss),
    maxTrades: Number(process.env.MAX_TRADES || DEFAULT_CONFIG.maxTrades),
    bullEnabled: process.env.BULL_ENABLED !== 'false',
    bearEnabled: process.env.BEAR_ENABLED !== 'false',
    oneOpenContract: process.env.ONE_OPEN_CONTRACT !== 'false',
    maxConsecutiveLosses: Number(process.env.LOSS_STREAK || 0),
    cooldownTicks: Number(process.env.COOLDOWN_TICKS || 0),
    maxSignalToSendMs: Number(process.env.MAX_SIGNAL_TO_SEND_MS || DEFAULT_CONFIG.maxSignalToSendMs),
    reconnect: true,
    maxReconnectAttempts: Number(process.env.MAX_RECONNECT_ATTEMPTS || DEFAULT_CONFIG.maxReconnectAttempts)
  };
}

export async function getWorkerAccountContext() {
  const appId = requiredEnv('DERIV_APP_ID');
  const token = requiredEnv('DERIV_TOKEN');
  const accountId = requiredEnv('DERIV_ACCOUNT_ID');
  const response = await fetch('https://api.derivws.com/trading/v1/options/accounts', {
    headers: { 'Deriv-App-ID': appId, Authorization: `Bearer ${token}` },
    cache: 'no-store'
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json?.errors?.[0]?.message || 'Failed to load Deriv accounts.');
  const accounts = Array.isArray(json.data) ? json.data : [json.data].filter(Boolean);
  const account = accounts.find(a => a.account_id === accountId);
  if (!account) throw new Error(`DERIV_ACCOUNT_ID ${accountId} was not returned by Deriv.`);
  const real = String(account.account_type).toLowerCase() === 'real';
  if (real && process.env.ALLOW_REAL !== 'I_UNDERSTAND_REAL') {
    throw new Error('Worker refused a real-money account. Set ALLOW_REAL=I_UNDERSTAND_REAL deliberately to unlock it.');
  }
  return { appId, token, accountId, account };
}

export function makeWsUrlProvider({ appId, token, accountId }) {
  return async () => {
    const response = await fetch(
      `https://api.derivws.com/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,
      { method: 'POST', headers: { 'Deriv-App-ID': appId, Authorization: `Bearer ${token}` }, cache: 'no-store' }
    );
    const json = await response.json();
    if (!response.ok || !json?.data?.url) throw new Error(json?.errors?.[0]?.message || 'Deriv OTP failed.');
    return json.data.url;
  };
}

export async function buildWorkerEngine({ onSnapshot } = {}) {
  const ctx = await getWorkerAccountContext();
  const config = { ...workerConfigFromEnv(), currency: ctx.account.currency || 'USD' };
  const dataDir = path.resolve(process.env.DATA_DIR || 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const statePath = path.join(dataDir, 'worker-state.json');
  const engine = new SaniEngine(config, {
    onLog: row => console.log(new Date(row.at).toISOString(), row.level.toUpperCase(), row.message),
    onSnapshot: snapshot => onSnapshot?.(snapshot),
    onPersist: snapshot => fs.writeFileSync(statePath, JSON.stringify(snapshot, null, 2))
  });
  await engine.connect(makeWsUrlProvider(ctx));
  // The engine will not permit Start until the portfolio safety response arrives.
  for (let i = 0; i < 30 && !engine.snapshot().portfolioChecked; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!engine.snapshot().portfolioChecked) throw new Error('Timed out waiting for portfolio safety check.');
  return { engine, context: ctx, statePath };
}
