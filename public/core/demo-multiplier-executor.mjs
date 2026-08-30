export const DERIV_DEMO_MIN_STAKE = 1;
export const DERIV_MULTIPLIERS = Object.freeze([160, 400, 800, 1200, 1600]);

const asNumber = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const isClosed = contract => Boolean(contract?.is_sold) || ['sold', 'won', 'lost'].includes(String(contract?.status || '').toLowerCase());

export class DemoMultiplierExecutor {
  constructor({
    engine,
    fetchImpl = globalThis.fetch?.bind(globalThis),
    WebSocketImpl = globalThis.WebSocket,
    storage = globalThis.localStorage,
    onStatus = () => {},
    onEvent = () => {}
  } = {}) {
    if (!engine) throw new Error('Executor engine name is required.');
    this.engine = String(engine);
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.storage = storage;
    this.onStatus = onStatus;
    this.onEvent = onEvent;
    this.storageKey = `sani.${this.engine.toLowerCase().replaceAll('_', '-')}.demo-multiplier.v1`;
    this.ws = null;
    this.pending = new Map();
    this.reqId = 100;
    this.pingTimer = null;
    this.buyPending = false;
    this.sellPending = false;
    this.exitRequested = '';
    this.state = this.loadState();
    this.emitStatus();
  }

  freshState() {
    return {
      armed: false,
      status: 'OFF',
      accountId: '',
      accountType: '',
      currency: 'USD',
      balance: null,
      contract: null,
      realized: 0,
      trades: []
    };
  }

  loadState() {
    try {
      const saved = JSON.parse(this.storage?.getItem(this.storageKey) || 'null') || {};
      return { ...this.freshState(), ...saved, armed: false, status: 'OFF' };
    } catch {
      return this.freshState();
    }
  }

  saveState() {
    try {
      const safe = { ...this.state, armed: false, status: 'OFF' };
      this.storage?.setItem(this.storageKey, JSON.stringify(safe));
    } catch {}
  }

  snapshot() {
    return {
      ...this.state,
      contract: this.state.contract ? { ...this.state.contract } : null,
      trades: [...(this.state.trades || [])],
      buyPending: this.buyPending,
      sellPending: this.sellPending
    };
  }

  emitStatus() {
    this.onStatus(this.snapshot());
  }

  event(type, text, extra = {}) {
    this.onEvent({ at: Date.now(), type, text, ...extra });
    this.emitStatus();
  }

  async arm({ appId, token, accountId }) {
    if (this.state.armed) return this.snapshot();
    if (!appId || !token || !accountId) throw new Error('Load and select a Deriv Demo account first.');
    if (!this.fetchImpl || !this.WebSocketImpl) throw new Error('Browser trading connection is unavailable.');

    this.state.status = 'VERIFYING DEMO';
    this.emitStatus();
    const response = await this.fetchImpl('/api/otp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId, token, accountId, demoOnly: true }),
      cache: 'no-store'
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.url) {
      this.state.status = 'REFUSED';
      this.emitStatus();
      throw new Error(payload?.error || `Demo authorization failed (${response.status}).`);
    }

    const account = payload.account || {};
    const accountType = String(account.account_type || '').toLowerCase();
    if (!['demo', 'virtual'].includes(accountType)) {
      this.state.status = 'REFUSED';
      this.emitStatus();
      throw new Error('REFUSED: selected account was not verified as Demo.');
    }

    this.state.accountId = String(account.account_id || accountId);
    this.state.accountType = accountType;
    this.state.currency = account.currency || this.state.currency || 'USD';
    if (account.balance != null) this.state.balance = asNumber(account.balance, null);
    this.state.status = 'CONNECTING';
    this.emitStatus();
    await this.openSocket(payload.url);
    this.state.armed = true;
    this.state.status = 'DEMO EXECUTION ACTIVE';
    await this.request({ balance: 1, subscribe: 1 }).catch(() => null);

    if (this.state.contract?.contractId) {
      await this.request({
        proposal_open_contract: 1,
        contract_id: Number(this.state.contract.contractId),
        subscribe: 1
      });
      this.event('DEMO RESTORED', `${this.engine} resumed Demo contract ${this.state.contract.contractId}.`, { side: this.state.contract.side });
    } else {
      this.event('DEMO ARMED', `${this.engine} will place actual contracts in Demo ${this.state.accountId}.`);
    }
    this.saveState();
    return this.snapshot();
  }

  openSocket(url) {
    this.closeSocket();
    return new Promise((resolve, reject) => {
      const ws = new this.WebSocketImpl(url);
      const timeout = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error('Deriv Demo WebSocket connection timed out.'));
      }, 15000);
      ws.onopen = () => {
        clearTimeout(timeout);
        this.ws = ws;
        this.pingTimer = setInterval(() => {
          try { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ ping: 1 })); } catch {}
        }, 25000);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timeout);
        if (!this.ws) reject(new Error('Could not connect to Deriv Demo trading WebSocket.'));
      };
      ws.onclose = () => {
        clearTimeout(timeout);
        if (this.ws === ws) {
          this.ws = null;
          clearInterval(this.pingTimer);
          this.pingTimer = null;
          this.state.armed = false;
          this.state.status = this.state.contract ? 'DISCONNECTED · CONTRACT OPEN' : 'DISCONNECTED';
          this.emitStatus();
        }
      };
      ws.onmessage = event => this.onMessage(event.data);
    });
  }

  closeSocket() {
    clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.ws) {
      try { this.ws.close(); } catch {}
    }
    this.ws = null;
  }

  request(payload, timeoutMs = 15000) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('Deriv Demo trading socket is not open.'));
    const req_id = ++this.reqId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(req_id);
        reject(new Error(`Deriv request timed out: ${Object.keys(payload)[0]}`));
      }, timeoutMs);
      this.pending.set(req_id, { resolve, reject, timeout });
      this.ws.send(JSON.stringify({ ...payload, req_id }));
    });
  }

  onMessage(raw) {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (message.req_id && this.pending.has(message.req_id)) {
      const pending = this.pending.get(message.req_id);
      this.pending.delete(message.req_id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(`${message.error.code || 'DerivError'}: ${message.error.message || 'request failed'}`));
      else pending.resolve(message);
    }
    if (message.msg_type === 'balance' && message.balance) {
      this.state.balance = asNumber(message.balance.balance, this.state.balance);
      this.saveState();
      this.emitStatus();
    }
    if (message.msg_type !== 'proposal_open_contract' || !message.proposal_open_contract || !this.state.contract) return;
    const contract = message.proposal_open_contract;
    if (String(contract.contract_id) !== String(this.state.contract.contractId)) return;
    this.state.contract.liveProfit = asNumber(contract.profit, this.state.contract.liveProfit);
    this.state.contract.status = String(contract.status || 'open').toUpperCase();
    this.emitStatus();
    if (isClosed(contract) && !this.sellPending) {
      this.recordClosed({
        reason: `DERIV ${String(contract.status || 'CLOSED').toUpperCase()}`,
        demoPnl: asNumber(contract.profit, this.state.contract.liveProfit),
        soldFor: asNumber(contract.sell_price, 0)
      });
    }
  }

  normalizeStake(stake) {
    return Math.max(DERIV_DEMO_MIN_STAKE, Number(asNumber(stake, DERIV_DEMO_MIN_STAKE).toFixed(2)));
  }

  normalizeMultiplier(multiplier) {
    const value = Number(multiplier);
    if (!DERIV_MULTIPLIERS.includes(value)) throw new Error(`Multiplier must be one of ${DERIV_MULTIPLIERS.join(', ')}.`);
    return value;
  }

  async buy({ side, stake, targetR = 2, multiplier = 160, symbol = '1HZ25V', context = '' } = {}) {
    if (!this.state.armed) return false;
    if (this.state.contract || this.buyPending) {
      this.event('DEMO BLOCKED', `${this.engine} one-contract rule blocked a second Demo entry.`);
      return false;
    }
    if (!['LONG', 'SHORT'].includes(side)) throw new Error('Demo side must be LONG or SHORT.');
    const actualStake = this.normalizeStake(stake);
    const actualMultiplier = this.normalizeMultiplier(multiplier);
    const actualTargetR = Math.max(0.1, asNumber(targetR, 2));
    const takeProfit = Number((actualStake * actualTargetR).toFixed(2));
    const contractType = side === 'LONG' ? 'MULTUP' : 'MULTDOWN';
    this.buyPending = true;
    this.exitRequested = '';
    this.state.status = 'BUYING DEMO';
    this.emitStatus();
    try {
      const proposed = await this.request({
        proposal: 1,
        amount: actualStake,
        basis: 'stake',
        contract_type: contractType,
        currency: this.state.currency,
        duration_unit: 's',
        limit_order: {
          stop_loss: actualStake,
          take_profit: takeProfit
        },
        multiplier: actualMultiplier,
        underlying_symbol: symbol
      });
      if (!proposed?.proposal?.id) throw new Error('Deriv returned no proposal ID.');
      const ask = asNumber(proposed.proposal.ask_price, actualStake);
      const bought = await this.request({ buy: proposed.proposal.id, price: ask });
      if (!bought?.buy?.contract_id) throw new Error('Deriv returned no contract ID.');
      this.state.contract = {
        contractId: bought.buy.contract_id,
        side,
        stake: actualStake,
        requestedStake: asNumber(stake, actualStake),
        stopLoss: actualStake,
        takeProfit,
        targetR: actualTargetR,
        multiplier: actualMultiplier,
        symbol,
        buyPrice: asNumber(bought.buy.buy_price, ask),
        boughtAt: Date.now(),
        liveProfit: 0,
        status: 'OPEN',
        context
      };
      this.state.status = 'DEMO CONTRACT OPEN';
      this.saveState();
      this.event('DEMO BUY', `${side} contract ${this.state.contract.contractId} · $${actualStake.toFixed(2)} ×${actualMultiplier} · SL $${actualStake.toFixed(2)} · TP $${takeProfit.toFixed(2)}${context ? ` · ${context}` : ''}`, { side });
      await this.request({ proposal_open_contract: 1, contract_id: Number(this.state.contract.contractId), subscribe: 1 }).catch(error => {
        this.event('DEMO WARNING', `Contract opened, monitor subscription failed: ${error.message}`, { side });
      });
      if (this.exitRequested) await this.sell(this.exitRequested);
      return true;
    } catch (error) {
      this.state.status = 'DEMO BUY REJECTED';
      this.event('DEMO REJECTED', `No Demo contract bought: ${error.message}`, { side });
      return false;
    } finally {
      this.buyPending = false;
      this.emitStatus();
    }
  }

  async sell(reason = 'ENGINE EXIT') {
    if (this.buyPending && !this.state.contract) {
      this.exitRequested = reason;
      this.event('DEMO EXIT QUEUED', `Exit arrived while Demo buy was confirming: ${reason}`);
      return false;
    }
    if (!this.state.contract || this.sellPending) return false;
    const tracked = { ...this.state.contract };
    this.sellPending = true;
    this.state.status = 'SELLING DEMO';
    this.emitStatus();
    try {
      const response = await this.request({ sell: Number(tracked.contractId), price: 0 });
      const soldFor = asNumber(response?.sell?.sold_for, 0);
      if (response?.sell?.balance_after != null) this.state.balance = asNumber(response.sell.balance_after, this.state.balance);
      this.recordClosed({
        reason,
        demoPnl: Number((soldFor - tracked.buyPrice).toFixed(4)),
        soldFor
      });
      return true;
    } catch (error) {
      this.state.status = 'DEMO SELL FAILED · CONTRACT OPEN';
      this.event('DEMO SELL FAILED', `Contract ${tracked.contractId} is still tracked: ${error.message}`, { side: tracked.side });
      return false;
    } finally {
      this.sellPending = false;
      this.exitRequested = '';
      this.emitStatus();
    }
  }

  recordClosed({ reason, demoPnl, soldFor }) {
    const tracked = this.state.contract;
    if (!tracked) return;
    const row = { ...tracked, reason, demoPnl: asNumber(demoPnl, 0), soldFor: asNumber(soldFor, 0), closedAt: Date.now() };
    this.state.trades = [row, ...(this.state.trades || [])].slice(0, 1000);
    this.state.realized = Number((asNumber(this.state.realized, 0) + row.demoPnl).toFixed(4));
    this.state.contract = null;
    this.state.status = this.state.armed ? 'DEMO EXECUTION ACTIVE' : 'OFF';
    this.saveState();
    this.event('DEMO SOLD', `${row.side} contract ${row.contractId} · ${reason} · ${row.demoPnl >= 0 ? '+' : '-'}$${Math.abs(row.demoPnl).toFixed(2)}`, { side: row.side });
  }

  disarm() {
    if (this.state.contract || this.buyPending || this.sellPending) throw new Error('Cannot disarm while a Demo contract is open or confirming. Close it first.');
    this.closeSocket();
    this.state.armed = false;
    this.state.status = 'OFF';
    this.saveState();
    this.event('DEMO DISARMED', `${this.engine} Demo execution is off.`);
  }
}
