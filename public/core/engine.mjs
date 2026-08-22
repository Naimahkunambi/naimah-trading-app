import { StatefulBosStrategy } from './bos.mjs';
import { ShadowTimingLab } from './shadow-lab.mjs';
import { directBuyRequest, proposalRequest } from './protocol.mjs';

export const DEFAULT_CONFIG = {
  symbol: '1HZ25V',
  currency: 'USD',
  stake: 1,
  duration: 1,
  durationUnit: 't',
  bullEnabled: true,
  bearEnabled: true,
  executionMethod: 'direct',
  oneOpenContract: true,
  takeProfit: 2,
  stopLoss: 3,
  maxTrades: 10,
  maxConsecutiveLosses: 0,
  cooldownTicks: 0,
  shadowHorizons: [1, 2, 3],
  maxSignalToSendMs: 250,
  reconnect: true,
  maxReconnectAttempts: 8
};

const perfNow = () => globalThis.performance?.now?.() ?? Date.now();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class SaniEngine {
  constructor(config = {}, hooks = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.hooks = hooks;
    this.strategy = new StatefulBosStrategy(this.config);
    this.shadow = new ShadowTimingLab(this.config.shadowHorizons);
    this.listeners = new Set();
    this.pending = new Map();
    this.open = new Map();
    this.req = 100;
    this.ws = undefined;
    this.wsUrlProvider = undefined;
    this.manualDisconnect = false;
    this.reconnectAttempts = 0;
    this.reconnecting = false;
    this.resumeAfterReconnect = false;
    this.safeBlocked = false;
    this.portfolioChecked = false;
    this.ambiguousExecution = false;
    this.unknownOpenContracts = [];
    this.resetStats(false);
    this.status = 'idle';
    this.connected = false;
    this.running = false;
  }

  resetStats(emit = true) {
    this.ticksSeen = 0;
    this.bosCount = 0;
    this.sessionPnL = 0;
    this.wins = 0;
    this.losses = 0;
    this.consecutiveLosses = 0;
    this.cooldownRemaining = 0;
    this.balance = undefined;
    this.lastTick = undefined;
    this.lastSignal = undefined;
    this.lastError = undefined;
    this.trades = [];
    this.logs = [];
    this.open?.clear?.();
    this.unknownOpenContracts = [];
    this.safeBlocked = false;
    this.portfolioChecked = false;
    this.ambiguousExecution = false;
    if (emit) this.emit();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  setConfig(patch) {
    if (this.running) throw new Error('Stop the engine before changing settings.');
    this.config = { ...this.config, ...patch };
    this.strategy.setConfig(this.config);
    this.shadow.setHorizons(this.config.shadowHorizons);
    this.emit();
  }

  /**
   * Accepts either a ready-to-use OTP WebSocket URL or an async provider that
   * returns a fresh OTP URL. Provider mode enables safe reconnect because OTPs
   * are one-use/short-lived.
   */
  async connect(wsUrlOrProvider) {
    this.manualDisconnect = false;
    this.wsUrlProvider = typeof wsUrlOrProvider === 'function' ? wsUrlOrProvider : async () => wsUrlOrProvider;
    this.reconnectAttempts = 0;
    await this.openConnection();
  }

  async openConnection() {
    this.closeSocketOnly();
    this.portfolioChecked = false;
    this.status = this.reconnecting ? 'reconnecting' : 'connecting';
    this.log('info', this.reconnecting ? 'Requesting fresh Deriv OTP and reconnecting…' : 'Opening authenticated Deriv WebSocket…');
    this.emit();

    const WS = this.hooks.WebSocketClass || globalThis.WebSocket;
    if (!WS) throw new Error('WebSocket is unavailable in this runtime.');
    if (!this.wsUrlProvider) throw new Error('No WebSocket URL provider configured.');

    const wsUrl = await this.wsUrlProvider();
    if (!wsUrl) throw new Error('OTP response did not include a WebSocket URL.');

    await new Promise((resolve, reject) => {
      const ws = new WS(wsUrl);
      this.ws = ws;
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { ws.close(); } catch {}
          reject(new Error('WebSocket connection timed out.'));
        }
      }, 10000);

      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.connected = true;
        this.status = 'ready';
        this.bind(ws);
        this.send({ balance: 1, subscribe: 1, req_id: this.nextReq('balance') });
        this.send({ ticks: this.config.symbol, subscribe: 1, req_id: this.nextReq('ticks') });
        this.send({ proposal_open_contract: 1, subscribe: 1, req_id: this.nextReq('contracts') });
        // Portfolio is a recovery/safety check. Unknown open positions block new buys.
        this.send({ portfolio: 1, req_id: this.nextReq('portfolio') });
        this.log('success', `Connected. Streaming ${this.config.symbol}.`);
        this.reconnectAttempts = 0;
        this.reconnecting = false;
        this.emit();
        resolve();
      };

      ws.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('Deriv WebSocket connection failed.'));
        }
      };
    });
  }

  start() {
    if (!this.connected || !this.ws) throw new Error('Connect first.');
    if (!this.portfolioChecked) throw new Error('Waiting for Deriv portfolio safety check.');
    if (this.safeBlocked) throw new Error('Safe-pause is active because the account has an open position this engine cannot safely reconcile. Resolve it in Deriv, then reconnect.');
    this.running = true;
    this.resumeAfterReconnect = true;
    this.status = 'running';
    this.log('success', 'Engine armed. Waiting for fresh BOS.');
    this.emit();
  }

  pause() {
    this.running = false;
    this.resumeAfterReconnect = false;
    this.status = this.connected ? 'paused' : 'idle';
    this.log('warn', 'New purchases paused. Open contracts continue to be monitored.');
    this.emit();
  }

  stop() {
    this.running = false;
    this.resumeAfterReconnect = false;
    this.status = 'stopped';
    this.log('warn', 'Session stopped. Open contracts continue to be monitored while connected.');
    this.emit();
  }

  disconnect(emit = true) {
    this.manualDisconnect = true;
    this.running = false;
    this.resumeAfterReconnect = false;
    this.connected = false;
    this.reconnecting = false;
    this.closeSocketOnly();
    this.status = 'idle';
    if (emit) this.emit();
  }

  closeSocketOnly() {
    if (!this.ws) return;
    try {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close?.();
    } catch {}
    this.ws = undefined;
    this.connected = false;
  }

  resetSession() {
    if (this.running) throw new Error('Stop first.');
    if (this.open.size) throw new Error('Cannot reset while this engine still has an open contract.');
    this.strategy.reset();
    this.shadow = new ShadowTimingLab(this.config.shadowHorizons);
    this.resetStats();
  }

  bind(ws) {
    ws.onmessage = event => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      this.handleMessage(message);
    };
    ws.onclose = () => this.handleDisconnect('Deriv WebSocket disconnected.');
    ws.onerror = () => {
      // onclose normally follows; keep the UI diagnostic concise.
      this.lastError = 'Deriv WebSocket network error.';
      this.emit();
    };
  }

  async handleDisconnect(reason) {
    if (this.manualDisconnect) return;
    const wasRunning = this.running || this.resumeAfterReconnect;
    if (this.hasPendingTrade()) {
      this.ambiguousExecution = true;
      this.safeBlocked = true;
      this.log('error', 'SAFE PAUSE: connection dropped while an order request was in flight. Verify account transactions before restarting.');
    }
    this.pending.clear();
    this.connected = false;
    this.running = false;
    this.resumeAfterReconnect = wasRunning;
    this.lastError = reason;
    this.log('error', `${reason} New purchases are paused.`);
    this.emit();

    if (!this.config.reconnect || !this.wsUrlProvider) {
      this.status = 'error';
      this.emit();
      return;
    }

    if (this.reconnecting) return;
    this.reconnecting = true;
    while (!this.manualDisconnect && this.reconnectAttempts < Number(this.config.maxReconnectAttempts || 0)) {
      this.reconnectAttempts += 1;
      const delay = Math.min(15000, 750 * (2 ** (this.reconnectAttempts - 1)));
      this.status = 'reconnecting';
      this.log('warn', `Reconnect attempt ${this.reconnectAttempts}/${this.config.maxReconnectAttempts} in ${delay}ms.`);
      this.emit();
      await sleep(delay);
      try {
        await this.openConnection();
        // Wait for portfolio response before any automatic resume.
        for (let i = 0; i < 25 && this.connected && !this.portfolioChecked; i += 1) await sleep(100);
        if (!this.portfolioChecked) {
          this.safeBlocked = true;
          this.status = 'safe-paused';
          this.log('error', 'SAFE PAUSE: portfolio recovery check timed out.');
          this.emit();
          return;
        }
        if (this.resumeAfterReconnect && !this.safeBlocked && this.connected) {
          this.running = true;
          this.status = 'running';
          this.log('success', 'Reconnected and resumed after account safety check.');
          this.emit();
        }
        return;
      } catch (error) {
        this.lastError = error.message;
        this.log('error', `Reconnect failed: ${error.message}`);
      }
    }
    this.reconnecting = false;
    this.status = 'error';
    this.log('error', 'Reconnect limit reached. Manual reconnect required.');
    this.emit();
  }

  handleMessage(message) {
    if (message.error) {
      const p = this.pending.get(Number(message.req_id));
      this.lastError = `${message.error.code || 'Error'}: ${message.error.message || 'Deriv error'}`;
      this.log('error', this.lastError);
      if (p?.kind === 'buy-direct') this.log('warn', 'Direct buy failed. Proposal → Buy is available as a diagnostic fallback.');
      this.pending.delete(Number(message.req_id));
      this.emit();
      return;
    }

    if (message.msg_type === 'tick' && message.tick) {
      this.onTick({ epoch: Number(message.tick.epoch), quote: Number(message.tick.quote) });
    } else if (message.msg_type === 'balance' && message.balance) {
      this.balance = Number(message.balance.balance);
      this.emit();
    } else if (message.msg_type === 'proposal' && message.proposal) {
      this.onProposal(message);
    } else if (message.msg_type === 'buy' && message.buy) {
      this.onBuy(message);
    } else if (message.msg_type === 'proposal_open_contract' && message.proposal_open_contract) {
      this.onContract(message.proposal_open_contract);
    } else if (message.msg_type === 'portfolio' && message.portfolio) {
      this.onPortfolio(message.portfolio);
    }
  }

  onPortfolio(portfolio) {
    this.portfolioChecked = true;
    const contracts = Array.isArray(portfolio.contracts) ? portfolio.contracts : [];
    const unknown = contracts.filter(c => !this.open.has(Number(c.contract_id)));
    this.unknownOpenContracts = unknown.map(c => ({
      contractId: Number(c.contract_id),
      direction: c.contract_type,
      symbol: c.underlying_symbol
    }));
    this.safeBlocked = this.ambiguousExecution || this.unknownOpenContracts.length > 0;
    if (this.safeBlocked) {
      this.running = false;
      this.resumeAfterReconnect = false;
      this.status = 'safe-paused';
      const reason = this.ambiguousExecution
        ? 'a connection drop left an order request in an ambiguous state'
        : `${this.unknownOpenContracts.length} open account position(s) were not created by this engine instance`;
      this.log('error', `SAFE PAUSE: ${reason}.`);
    } else if (this.status === 'safe-paused') {
      this.status = 'ready';
    }
    this.emit();
  }

  onTick(tick) {
    const receivedPerf = perfNow();
    const receivedWallMs = Date.now();
    this.lastTick = tick;
    this.ticksSeen += 1;
    this.shadow.onTick(tick);

    if (this.cooldownRemaining > 0) {
      this.cooldownRemaining -= 1;
      if (this.cooldownRemaining === 0) {
        this.strategy.resetStructure();
        this.log('success', 'Cooldown complete. Fresh structure required.');
      }
    }

    const evt = this.strategy.push(tick);
    for (const rawSignal of evt?.signals || []) {
      const signal = {
        ...rawSignal,
        detectedPerf: perfNow(),
        detectedWallMs: Date.now(),
        tickReceivedPerf: receivedPerf,
        tickReceivedWallMs: receivedWallMs
      };
      this.bosCount += 1;
      this.lastSignal = signal;
      this.shadow.addSignal(signal, signal.quote);
      this.log('info', `${signal.direction} ${signal.structure} @ ${signal.quote}`);
      if (this.running) this.execute(signal);
    }
    this.emit();
  }

  hasPendingTrade() {
    for (const p of this.pending.values()) {
      if (p?.kind === 'buy-direct' || p?.kind === 'proposal' || p?.kind === 'buy-proposal') return true;
    }
    return false;
  }

  execute(signal) {
    if (!this.running || this.cooldownRemaining > 0 || this.safeBlocked) return;
    if (this.config.oneOpenContract && (this.open.size || this.hasPendingTrade())) {
      this.log('warn', `${signal.direction} skipped: one-open-contract lock.`);
      return;
    }
    if (this.trades.length >= Number(this.config.maxTrades)) return this.hitStop('trade cap');
    if (Number(this.config.takeProfit) > 0 && this.sessionPnL >= Number(this.config.takeProfit)) return this.hitStop('take profit');
    if (Number(this.config.stopLoss) > 0 && this.sessionPnL <= -Math.abs(Number(this.config.stopLoss))) return this.hitStop('stop loss');

    const reqId = ++this.req;
    const sentPerf = perfNow();
    const sentWallMs = Date.now();
    const detectedPerf = Number(signal.detectedPerf ?? sentPerf);
    const signalToSendMs = sentPerf - detectedPerf;
    if (Number(this.config.maxSignalToSendMs) > 0 && signalToSendMs > Number(this.config.maxSignalToSendMs)) {
      this.log('warn', `Signal-to-send ${signalToSendMs.toFixed(1)}ms exceeded ${this.config.maxSignalToSendMs}ms guard; skipped.`);
      return;
    }

    const kind = this.config.executionMethod === 'direct' ? 'buy-direct' : 'proposal';
    this.pending.set(reqId, { kind, signal, detectedPerf, sentPerf, sentWallMs });
    try {
      const payload = this.config.executionMethod === 'direct'
        ? directBuyRequest(signal.direction, this.config, reqId)
        : proposalRequest(signal.direction, this.config, reqId);
      this.send(payload);
      this.log('info', `${signal.direction} order sent in ${signalToSendMs.toFixed(1)}ms (${this.config.executionMethod}).`);
    } catch (error) {
      this.pending.delete(reqId);
      throw error;
    }
  }

  onProposal(message) {
    const p = this.pending.get(Number(message.req_id));
    if (!p?.signal) return;
    this.pending.delete(Number(message.req_id));
    const reqId = ++this.req;
    const sentPerf = perfNow();
    const sentWallMs = Date.now();
    this.pending.set(reqId, {
      kind: 'buy-proposal',
      signal: p.signal,
      detectedPerf: p.detectedPerf,
      sentPerf,
      sentWallMs,
      proposalRoundTripMs: sentPerf - p.sentPerf
    });
    this.send({ buy: String(message.proposal.id), price: Number(this.config.stake), req_id: reqId });
  }

  onBuy(message) {
    const p = this.pending.get(Number(message.req_id));
    if (!p?.signal) return;
    this.pending.delete(Number(message.req_id));
    const ackPerf = perfNow();
    const ackWallMs = Date.now();
    const b = message.buy;
    const startTime = Number(b.start_time);
    const purchaseTime = Number(b.purchase_time);
    const trade = {
      id: String(b.contract_id),
      contractId: Number(b.contract_id),
      direction: p.signal.direction,
      status: 'open',
      stake: Number(this.config.stake),
      duration: Number(this.config.duration),
      durationUnit: this.config.durationUnit,
      executionMethod: this.config.executionMethod,
      buyPrice: Number(b.buy_price),
      payout: Number(b.payout),
      signalEpoch: p.signal.epoch,
      signalQuote: p.signal.quote,
      signalDetectedWallMs: p.signal.detectedWallMs,
      buySentWallMs: p.sentWallMs,
      buyAckWallMs: ackWallMs,
      signalToSendMs: p.sentPerf - p.detectedPerf,
      sendToAckMs: ackPerf - p.sentPerf,
      signalToAckMs: ackPerf - p.detectedPerf,
      proposalRoundTripMs: p.proposalRoundTripMs,
      purchaseTime,
      startTime,
      serverPurchaseDelayMs: Number.isFinite(purchaseTime) ? (purchaseTime - p.signal.epoch) * 1000 : undefined,
      serverStartDelayMs: Number.isFinite(startTime) ? (startTime - p.signal.epoch) * 1000 : undefined
    };
    this.trades.unshift(trade);
    this.open.set(trade.contractId, trade);
    this.log('success', `${trade.direction} bought #${trade.contractId}. ACK ${trade.sendToAckMs.toFixed(0)}ms · Deriv start Δ ${trade.serverStartDelayMs ?? '—'}ms.`);
    this.persist();
    this.emit();
  }

  onContract(contract) {
    const id = Number(contract.contract_id);
    const trade = this.open.get(id);
    if (!trade) return;
    if (contract.entry_spot !== undefined) trade.entrySpot = Number(contract.entry_spot);
    if (contract.exit_spot !== undefined) trade.exitSpot = Number(contract.exit_spot);
    if (contract.entry_tick_time !== undefined) trade.entryTickTime = Number(contract.entry_tick_time);
    if (contract.exit_tick_time !== undefined) trade.exitTickTime = Number(contract.exit_tick_time);
    if (!contract.is_sold && !contract.is_expired) return;

    const profit = Number(contract.profit || 0);
    trade.profit = profit;
    trade.status = profit > 0 ? 'won' : profit < 0 ? 'lost' : 'sold';
    trade.settledAtMs = Date.now();
    this.sessionPnL += profit;
    this.open.delete(id);

    if (profit > 0) {
      this.wins += 1;
      this.consecutiveLosses = 0;
    } else {
      this.losses += 1;
      this.consecutiveLosses += 1;
    }

    this.log(profit > 0 ? 'success' : 'warn', `${trade.direction} ${trade.status.toUpperCase()} ${profit >= 0 ? '+' : ''}${profit.toFixed(2)} · session ${this.sessionPnL >= 0 ? '+' : ''}${this.sessionPnL.toFixed(2)}.`);

    if (
      Number(this.config.maxConsecutiveLosses) > 0 &&
      this.consecutiveLosses >= Number(this.config.maxConsecutiveLosses) &&
      Number(this.config.cooldownTicks) > 0
    ) {
      this.cooldownRemaining = Number(this.config.cooldownTicks);
      this.consecutiveLosses = 0;
      this.strategy.resetStructure();
      this.log('warn', `Cooldown ${this.config.cooldownTicks} unique ticks.`);
    }

    if (Number(this.config.takeProfit) > 0 && this.sessionPnL >= Number(this.config.takeProfit)) this.hitStop('take profit');
    else if (Number(this.config.stopLoss) > 0 && this.sessionPnL <= -Math.abs(Number(this.config.stopLoss))) this.hitStop('stop loss');
    else if (this.trades.length >= Number(this.config.maxTrades)) this.hitStop('trade cap');

    this.persist();
    this.emit();
  }

  hitStop(reason) {
    this.running = false;
    this.resumeAfterReconnect = false;
    this.status = 'stopped';
    this.log('warn', `Session stopped by ${reason}.`);
    this.emit();
  }

  send(payload) {
    if (!this.ws || this.ws.readyState !== 1) throw new Error('WebSocket is not open.');
    this.ws.send(JSON.stringify(payload));
  }

  nextReq(kind) {
    const id = ++this.req;
    this.pending.set(id, { kind, sentPerf: perfNow(), detectedPerf: perfNow() });
    return id;
  }

  log(level, message) {
    const row = { at: Date.now(), level, message };
    this.logs.unshift(row);
    this.logs = this.logs.slice(0, 400);
    this.hooks.onLog?.(row);
  }

  persist() { this.hooks.onPersist?.(this.snapshot()); }

  emit() {
    const s = this.snapshot();
    for (const fn of this.listeners) fn(s);
    this.hooks.onSnapshot?.(s);
  }

  snapshot() {
    return {
      status: this.status,
      connected: this.connected,
      running: this.running,
      safeBlocked: this.safeBlocked,
      portfolioChecked: this.portfolioChecked,
      ambiguousExecution: this.ambiguousExecution,
      unknownOpenContracts: this.unknownOpenContracts.map(x => ({ ...x })),
      balance: this.balance,
      currency: this.config.currency,
      lastTick: this.lastTick,
      ticksSeen: this.ticksSeen,
      bosCount: this.bosCount,
      sessionPnL: this.sessionPnL,
      wins: this.wins,
      losses: this.losses,
      consecutiveLosses: this.consecutiveLosses,
      cooldownRemaining: this.cooldownRemaining,
      openContracts: this.open.size,
      pendingTrade: this.hasPendingTrade(),
      trades: this.trades.map(t => ({ ...t })),
      shadow: this.shadow.snapshot(),
      lastSignal: this.lastSignal ? { ...this.lastSignal } : undefined,
      lastError: this.lastError,
      logs: [...this.logs],
      config: { ...this.config }
    };
  }

  exportCsv() {
    const headers = [
      'contract_id','direction','status','stake','duration','duration_unit','execution_method','buy_price','profit',
      'signal_epoch','signal_quote','signal_to_send_ms','send_to_ack_ms','signal_to_ack_ms','server_purchase_delay_ms',
      'server_start_delay_ms','purchase_time','start_time','entry_spot','exit_spot','entry_tick_time','exit_tick_time'
    ];
    const rows = this.trades.map(t => [
      t.contractId,t.direction,t.status,t.stake,t.duration,t.durationUnit,t.executionMethod,t.buyPrice,t.profit ?? '',
      t.signalEpoch,t.signalQuote,t.signalToSendMs?.toFixed?.(2) ?? '',t.sendToAckMs?.toFixed?.(2) ?? '',
      t.signalToAckMs?.toFixed?.(2) ?? '',t.serverPurchaseDelayMs ?? '',t.serverStartDelayMs ?? '',t.purchaseTime ?? '',
      t.startTime ?? '',t.entrySpot ?? '',t.exitSpot ?? '',t.entryTickTime ?? '',t.exitTickTime ?? ''
    ]);
    return [headers, ...rows]
      .map(row => row.map(v => `"${String(v).replaceAll('"', '""')}"`).join(','))
      .join('\n');
  }
}
