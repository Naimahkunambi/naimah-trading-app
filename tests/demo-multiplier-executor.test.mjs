import test from 'node:test';
import assert from 'node:assert/strict';
import { DemoMultiplierExecutor } from '../public/core/demo-multiplier-executor.mjs';

class MemoryStorage {
  constructor() { this.data = new Map(); }
  getItem(key) { return this.data.get(key) ?? null; }
  setItem(key, value) { this.data.set(key, String(value)); }
}

class FakeSocket {
  static instances = [];
  static OPEN = 1;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeSocket.instances.push(this);
    queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
  }
  send(raw) {
    const request = JSON.parse(raw);
    this.sent.push(request);
    if (request.balance) this.reply({ req_id: request.req_id, msg_type: 'balance', balance: { balance: 8198.59 } });
    if (request.proposal) this.reply({ req_id: request.req_id, msg_type: 'proposal', proposal: { id: 'proposal-1', ask_price: request.amount } });
    if (request.buy) this.reply({ req_id: request.req_id, msg_type: 'buy', buy: { contract_id: 991, buy_price: request.price } });
    if (request.proposal_open_contract) this.reply({ req_id: request.req_id, msg_type: 'proposal_open_contract', proposal_open_contract: { contract_id: request.contract_id, status: 'open', profit: 0 } });
    if (request.sell) this.reply({ req_id: request.req_id, msg_type: 'sell', sell: { sold_for: 1.42, balance_after: 8200.01 } });
  }
  reply(message) { queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(message) })); }
  close() { this.readyState = 3; queueMicrotask(() => this.onclose?.()); }
}

const demoFetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    url: 'wss://demo.example.test',
    demoOnly: true,
    account: { account_id: 'DOT9001', account_type: 'demo', currency: 'USD', balance: 8198.59 }
  })
});

test('arms only verified Demo, buys multiplier, monitors and sells', async () => {
  FakeSocket.instances.length = 0;
  const events = [];
  const executor = new DemoMultiplierExecutor({
    engine: 'COMET', fetchImpl: demoFetch, WebSocketImpl: FakeSocket, storage: new MemoryStorage(),
    onEvent: event => events.push(event)
  });
  await executor.arm({ appId: 'app', token: 'token', accountId: 'DOT9001' });
  assert.equal(executor.snapshot().armed, true);
  assert.equal(executor.snapshot().balance, 8198.59);

  await executor.buy({ side: 'LONG', stake: 0.4, targetR: 2, multiplier: 160, symbol: '1HZ25V', context: 'GRAB' });
  const socket = FakeSocket.instances[0];
  const proposal = socket.sent.find(message => message.proposal === 1);
  assert.deepEqual({ amount: proposal.amount, type: proposal.contract_type, multiplier: proposal.multiplier }, { amount: 1, type: 'MULTUP', multiplier: 160 });
  assert.deepEqual(proposal.limit_order, { stop_loss: 1, take_profit: 2 });
  assert.equal(executor.snapshot().contract.contractId, 991);

  await executor.sell('ENGINE EXIT');
  assert.equal(executor.snapshot().contract, null);
  assert.equal(executor.snapshot().realized, 0.42);
  assert.equal(executor.snapshot().trades.length, 1);
  assert.ok(events.some(event => event.type === 'DEMO BUY'));
  assert.ok(events.some(event => event.type === 'DEMO SOLD'));
  executor.disarm();
});

test('refuses authorization payload that is not explicitly Demo', async () => {
  const executor = new DemoMultiplierExecutor({
    engine: 'LAST_MAN',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ url: 'wss://real', account: { account_id: 'CR1', account_type: 'real' } }) }),
    WebSocketImpl: FakeSocket,
    storage: new MemoryStorage()
  });
  await assert.rejects(() => executor.arm({ appId: 'app', token: 'token', accountId: 'CR1' }), /REFUSED/);
  assert.equal(executor.snapshot().armed, false);
});

test('rejects unsupported multipliers before placing a proposal', async () => {
  FakeSocket.instances.length = 0;
  const executor = new DemoMultiplierExecutor({ engine: 'COMET', fetchImpl: demoFetch, WebSocketImpl: FakeSocket, storage: new MemoryStorage() });
  await executor.arm({ appId: 'app', token: 'token', accountId: 'DOT9001' });
  await assert.rejects(() => executor.buy({ side: 'SHORT', stake: 1, multiplier: 999, symbol: '1HZ25V' }), /Multiplier must be one of/);
  assert.equal(FakeSocket.instances[0].sent.some(message => message.proposal === 1), false);
  executor.disarm();
});
