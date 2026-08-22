import test from 'node:test';
import assert from 'node:assert/strict';
import { SaniEngine } from '../public/core/engine.mjs';

class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  emit(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
  close() { this.readyState = 3; }
}

async function connectedEngine(config = {}) {
  const engine = new SaniEngine({
    stake: 1, duration: 1, durationUnit: 't', symbol: '1HZ25V',
    takeProfit: 0, stopLoss: 0, maxTrades: 5, ...config
  }, { WebSocketClass: FakeWebSocket });
  await engine.connect(async () => 'wss://fake.test/otp');
  const ws = FakeWebSocket.instances.at(-1);
  ws.emit({ msg_type: 'portfolio', portfolio: { contracts: [] } });
  return { engine, ws };
}

function emitTicks(ws, prices, start = 1) {
  for (let i = 0; i < prices.length; i += 1) {
    ws.emit({ msg_type: 'tick', tick: { epoch: start + i, quote: prices[i] } });
  }
}

test('full bull path sends direct CALL, records ACK, settles and updates P/L', async () => {
  const { engine, ws } = await connectedEngine();
  engine.start();
  emitTicks(ws, [10, 8, 9, 12, 10, 11, 13]);
  const buyReq = ws.sent.find(x => x.buy === '1');
  assert.ok(buyReq, 'direct buy request should be sent');
  assert.equal(buyReq.parameters.contract_type, 'CALL');
  assert.equal(buyReq.parameters.underlying_symbol, '1HZ25V');

  ws.emit({ msg_type: 'buy', req_id: buyReq.req_id, buy: {
    contract_id: 101, buy_price: 1, payout: 1.92,
    purchase_time: 7, start_time: 7, transaction_id: 55, balance_after: 999,
    longcode: 'test', shortcode: 'test'
  }});
  assert.equal(engine.snapshot().openContracts, 1);

  ws.emit({ msg_type: 'proposal_open_contract', proposal_open_contract: {
    contract_id: 101, is_sold: 1, profit: 0.92, entry_spot: 13, exit_spot: 14
  }});
  const s = engine.snapshot();
  assert.equal(s.wins, 1);
  assert.equal(s.losses, 0);
  assert.equal(s.sessionPnL, 0.92);
  assert.equal(s.trades[0].status, 'won');
});

test('full bear path sends direct PUT', async () => {
  const { engine, ws } = await connectedEngine();
  engine.start();
  emitTicks(ws, [10, 12, 11, 8, 10, 9, 7], 100);
  const buyReq = ws.sent.find(x => x.buy === '1');
  assert.ok(buyReq);
  assert.equal(buyReq.parameters.contract_type, 'PUT');
});

test('one-open-contract lock includes a pending unacknowledged order', async () => {
  const { engine, ws } = await connectedEngine();
  engine.start();
  emitTicks(ws, [10, 8, 9, 12, 10, 11, 13]);
  assert.equal(ws.sent.filter(x => x.buy === '1').length, 1);
  // Directly ask the engine to execute another signal while first order is pending.
  engine.execute({ direction: 'CALL', epoch: 99, quote: 20, detectedPerf: performance.now(), detectedWallMs: Date.now() });
  assert.equal(ws.sent.filter(x => x.buy === '1').length, 1);
});

test('unknown portfolio position activates safe pause', async () => {
  const engine = new SaniEngine({}, { WebSocketClass: FakeWebSocket });
  await engine.connect(async () => 'wss://fake.test/otp2');
  const ws = FakeWebSocket.instances.at(-1);
  ws.emit({ msg_type: 'portfolio', portfolio: { contracts: [{ contract_id: 999, contract_type: 'CALL', underlying_symbol: '1HZ25V' }] } });
  assert.equal(engine.snapshot().safeBlocked, true);
  assert.throws(() => engine.start(), /Safe-pause/);
});
