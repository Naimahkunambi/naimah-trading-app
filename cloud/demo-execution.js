const fs = require('fs');
const WebSocket = require('ws');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const DERIV_MIN_STAKE = 1.00;
const DERIV_ALLOWED_MULTIPLIERS = [160, 400, 800, 1200, 1600];
const DERIV_MIN_MULTIPLIER = DERIV_ALLOWED_MULTIPLIERS[0];

class DemoExecutionBridge {
  constructor({ cometPage, lastManPage, credsPath, symbol = '1HZ25V', multiplier = DERIV_MIN_MULTIPLIER }) {
    this.pages = { COMET: cometPage, LAST_MAN: lastManPage };
    this.credsPath = credsPath;
    this.symbol = symbol;
    this.requestedMultiplier = Number(multiplier);
    this.multiplier = DERIV_ALLOWED_MULTIPLIERS.includes(this.requestedMultiplier)
      ? this.requestedMultiplier
      : DERIV_MIN_MULTIPLIER;
    this.ws = null;
    this.account = null;
    this.currency = 'USD';
    this.req = 1000;
    this.pending = new Map();
    this.running = false;
    this.timer = null;
    this.pingTimer = null;
    this.heartbeatTimer = null;
    this.seen = { COMET: new Set(), LAST_MAN: new Set() };
    this.readyAfterFlat = { COMET: false, LAST_MAN: false };
    this.live = { COMET: null, LAST_MAN: null };
    this.closed = { COMET: [], LAST_MAN: [] };
    this.statusPath = '/home/sanisol255/sani-cloud/demo-live-status.json';
    this.statePath = '/home/sanisol255/sani-cloud/demo-live-state.json';
    this.restoreState();
  }

  eventKey(e = {}) {
    return `${Number(e.at || 0)}|${String(e.type || '')}|${String(e.text || '')}`;
  }

  remember(name, event) {
    const set = this.seen[name];
    set.add(this.eventKey(event));
    if (set.size > 3500) {
      const keep = [...set].slice(-2200);
      this.seen[name] = new Set(keep);
    }
  }

  restoreState() {
    try {
      const s = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      if (s?.live) this.live = { COMET: s.live.COMET || null, LAST_MAN: s.live.LAST_MAN || null };
      if (s?.closed) this.closed = { COMET: s.closed.COMET || [], LAST_MAN: s.closed.LAST_MAN || [] };
    } catch {}
  }

  saveState() {
    try {
      fs.writeFileSync(this.statePath, JSON.stringify({ live: this.live, closed: this.closed }, null, 2));
      fs.chmodSync(this.statePath, 0o600);
    } catch {}
  }

  writeStatus(extra = {}) {
    const summarize = name => {
      const rows = this.closed[name] || [];
      const pnl = rows.reduce((s, r) => s + Number(r.demoPnl || 0), 0);
      const wins = rows.filter(r => Number(r.demoPnl || 0) > 0).length;
      return {
        live: this.live[name] ? {
          contractId: this.live[name].contractId,
          side: this.live[name].side,
          paperStake: this.live[name].paperStake,
          stake: this.live[name].stake,
          multiplier: this.live[name].multiplier,
          paperEntryAt: this.live[name].paperEntryAt,
          buyAt: this.live[name].buyAt,
          lastProfit: Number(this.live[name].lastProfit || 0)
        } : null,
        trades: rows.length,
        wins,
        losses: rows.length - wins,
        winRate: rows.length ? Number((wins / rows.length * 100).toFixed(1)) : 0,
        realized: Number(pnl.toFixed(4))
      };
    };

    const out = {
      checkedAt: new Date().toISOString(),
      demoOnly: true,
      accountId: this.account?.account_id || null,
      balance: this.account?.balance != null ? Number(this.account.balance) : null,
      currency: this.currency,
      symbol: this.symbol,
      requestedMultiplier: this.requestedMultiplier,
      multiplier: this.multiplier,
      derivAllowedMultipliers: DERIV_ALLOWED_MULTIPLIERS,
      derivMinimumStake: DERIV_MIN_STAKE,
      COMET: summarize('COMET'),
      LAST_MAN_GRAB: summarize('LAST_MAN'),
      ...extra
    };

    try { fs.writeFileSync(this.statusPath, JSON.stringify(out, null, 2)); } catch {}
  }

  async verifyDemoAccount() {
    const creds = JSON.parse(fs.readFileSync(this.credsPath, 'utf8'));
    const r = await fetch('https://api.derivws.com/trading/v1/options/accounts', {
      headers: {
        'Deriv-App-ID': String(creds.appId),
        Authorization: `Bearer ${creds.token}`,
        Accept: 'application/json'
      }
    });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch { throw new Error(`Account API returned non-JSON: ${text.slice(0, 120)}`); }
    if (!r.ok) throw new Error(j?.errors?.[0]?.message || `Account check failed ${r.status}`);
    const rows = Array.isArray(j.data) ? j.data : [j.data].filter(Boolean);
    const account = rows.find(a => String(a.account_id) === String(creds.accountId));
    if (!account) throw new Error('Configured account was not returned by Deriv.');
    if (String(account.account_type || '').toLowerCase() === 'real') {
      throw new Error('REFUSED: configured account is REAL. This bridge is permanently Demo-only.');
    }
    this.creds = creds;
    this.account = account;
    this.currency = account.currency || 'USD';
    console.log(`[DEMO LIVE] verified DEMO ${account.account_id} · ${this.currency} ${account.balance}`);
  }

  async otpUrl() {
    const r = await fetch(
      `https://api.derivws.com/trading/v1/options/accounts/${encodeURIComponent(this.creds.accountId)}/otp`,
      {
        method: 'POST',
        headers: {
          'Deriv-App-ID': String(this.creds.appId),
          Authorization: `Bearer ${this.creds.token}`
        }
      }
    );
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch { throw new Error(`OTP API returned non-JSON: ${text.slice(0, 120)}`); }
    if (!r.ok || !j?.data?.url) throw new Error(j?.errors?.[0]?.message || `OTP failed ${r.status}`);
    return j.data.url;
  }

  async connectWs() {
    const url = await this.otpUrl();
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timeout = setTimeout(() => reject(new Error('Demo WebSocket connect timeout')), 15000);
      ws.once('open', () => {
        clearTimeout(timeout);
        this.ws = ws;
        resolve();
      });
      ws.once('error', e => {
        clearTimeout(timeout);
        reject(e);
      });
    });

    this.ws.on('message', raw => this.onMessage(raw));
    this.ws.on('close', () => {
      console.log('[DEMO LIVE] authenticated socket closed. Bridge stopped rather than guessing.');
      this.running = false;
      clearInterval(this.timer);
      clearInterval(this.pingTimer);
      clearInterval(this.heartbeatTimer);
      this.writeStatus({ error: 'Authenticated WebSocket closed; restart service to reconnect.' });
    });
    this.ws.on('error', e => console.error('[DEMO LIVE WS]', e.message));

    this.pingTimer = setInterval(() => {
      try {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ ping: 1 }));
      } catch {}
    }, 25000);

    console.log('[DEMO LIVE] ✅ authenticated trading socket connected');
  }

  onMessage(raw) {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }

    if (msg.req_id && this.pending.has(msg.req_id)) {
      const p = this.pending.get(msg.req_id);
      this.pending.delete(msg.req_id);
      clearTimeout(p.timeout);
      if (msg.error) p.reject(new Error(`${msg.error.code || 'DerivError'}: ${msg.error.message || 'request failed'}`));
      else p.resolve(msg);
    }

    if (msg.msg_type === 'balance' && msg.balance) {
      this.account.balance = Number(msg.balance.balance);
      this.writeStatus();
    }

    if (msg.msg_type === 'proposal_open_contract' && msg.proposal_open_contract) {
      const c = msg.proposal_open_contract;
      const id = String(c.contract_id);
      for (const name of ['COMET', 'LAST_MAN']) {
        const live = this.live[name];
        if (!live || String(live.contractId) !== id) continue;
        if (c.profit != null) live.lastProfit = Number(c.profit) || 0;
        if (c.is_sold || ['sold', 'won', 'lost'].includes(String(c.status || '').toLowerCase())) {
          const demoPnl = Number(c.profit || live.lastProfit || 0);
          this.recordClosed(name, {
            ...live,
            demoPnl,
            exitReason: `DERIV ${String(c.status || 'CLOSED').toUpperCase()}`,
            soldFor: Number(c.sell_price || 0)
          });
          this.live[name] = null;
          this.saveState();
          this.writeStatus();
          console.log(`[DEMO LIVE] ${name} contract ${id} closed by Deriv · P/L ${demoPnl >= 0 ? '+' : ''}$${demoPnl.toFixed(2)}`);
        }
      }
    }
  }

  request(payload, timeoutMs = 12000) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Demo trading socket is not open'));
    }
    const req_id = ++this.req;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(req_id);
        reject(new Error(`Deriv request timeout: ${Object.keys(payload)[0]}`));
      }, timeoutMs);
      this.pending.set(req_id, { resolve, reject, timeout });
      this.ws.send(JSON.stringify({ ...payload, req_id }));
    });
  }

  async subscribeBalance() {
    try { await this.request({ balance: 1, subscribe: 1 }); }
    catch (e) { console.error('[DEMO LIVE] balance subscribe:', e.message); }
  }

  async restoreOpenContracts() {
    for (const name of ['COMET', 'LAST_MAN']) {
      const live = this.live[name];
      if (!live?.contractId) continue;
      try {
        await this.request({ proposal_open_contract: 1, contract_id: Number(live.contractId), subscribe: 1 });
        console.log(`[DEMO LIVE] restored ${name} contract ${live.contractId}`);
      } catch (e) {
        console.error(`[DEMO LIVE] could not restore ${name} contract ${live.contractId}:`, e.message);
      }
    }
  }

  async lockLastManGrab() {
    const page = this.pages.LAST_MAN;
    await page.waitForSelector('[data-mode="GRAB"]', { state: 'attached', timeout: 30000 });
    const current = String(await page.locator('#modeControlLabel').textContent().catch(() => '')).trim();
    if (current !== 'GRAB') {
      await page.locator('[data-mode="GRAB"]').evaluate(el => el.click());
      await sleep(150);
    }
    const after = String(await page.locator('#modeControlLabel').textContent().catch(() => '')).trim();
    if (after !== 'GRAB') throw new Error(`Could not lock LAST MAN to GRAB; UI says ${after}`);
    console.log('[DEMO LIVE] LAST MAN locked to GRAB once. No repeated mode clicks; no AUTO promotion.');
  }

  async readSnapshot(name) {
    const page = this.pages[name];
    return page.evaluate(name => {
      const runtime = name === 'COMET' ? window.COMET_RUNTIME : window.LAST_MAN_STANDING;
      let session = null;
      try { session = runtime?.getSession?.() || null; } catch {}
      if (!session) {
        const key = name === 'COMET' ? 'sani.comet.paper.v3' : 'sani.last-man-standing.paper.v1';
        try { session = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch { session = {}; }
      }
      const tape = Array.isArray(session?.tape) ? session.tape : [];
      const sideText = document.querySelector('#positionSide')?.textContent?.trim() || '';
      const active = ['LONG', 'SHORT'].includes(sideText);
      const risk = name === 'COMET'
        ? Number(document.querySelector('#riskDollars')?.value || 1)
        : Number((document.querySelector('#positionRisk')?.textContent || '').replace(/[^0-9.\-]/g, ''));
      return {
        active,
        side: active ? sideText : null,
        risk: Number.isFinite(risk) ? risk : null,
        mode: name === 'LAST_MAN' ? (document.querySelector('#positionMode')?.textContent?.trim() || '') : 'COMET',
        trades: Array.isArray(session?.trades) ? session.trades.length : 0,
        tape: tape.slice(0, 220).map(x => ({
          at: Number(x.at || 0),
          type: String(x.type || ''),
          text: String(x.text || ''),
          side: x.side || null,
          mode: x.mode || null
        }))
      };
    }, name);
  }

  async seed(name) {
    const snap = await this.readSnapshot(name);
    for (const e of snap.tape) this.remember(name, e);
    this.readyAfterFlat[name] = !snap.active;
    console.log(`[DEMO LIVE] ${name} watcher seeded · paper trades=${snap.trades} · paper active=${snap.active ? snap.side : 'FLAT'} · tape=${snap.tape.length}`);
    if (snap.active) {
      console.log(`[DEMO LIVE] ${name} existing paper position ignored. Demo starts from NEXT fresh entry after flat.`);
    }
  }

  parseStake(name, event, snap) {
    if (name === 'COMET') return Number(snap.risk || 1);
    const m = String(event.text || '').match(/risk\s+[+\-]?\$([0-9.]+)/i);
    return m ? Number(m[1]) : Number(snap.risk || 0.4);
  }

  async buyFor(name, event, snap) {
    if (this.live[name]) {
      console.log(`[DEMO LIVE] ${name} fresh ENTRY seen but Demo contract ${this.live[name].contractId} is still open. Ignored.`);
      return;
    }

    const side = event.side || (
      String(event.text).includes(' LONG ') ? 'LONG' :
      String(event.text).includes(' SHORT ') ? 'SHORT' :
      snap.side
    );
    if (!['LONG', 'SHORT'].includes(side)) {
      console.log(`[DEMO LIVE] ${name} ENTRY seen but side could not be read: ${event.text}`);
      return;
    }

    if (name === 'LAST_MAN') {
      const mode = event.mode || String(event.text).split(' ')[0];
      if (mode !== 'GRAB') {
        console.log(`[DEMO LIVE] LAST MAN ${mode || 'unknown'} entry ignored. Demo bridge is GRAB-only.`);
        return;
      }
    }

    const paperStake = this.parseStake(name, event, snap);
    if (!(paperStake > 0)) {
      console.error(`[DEMO LIVE] ${name} invalid paper stake ${paperStake}. No trade placed.`);
      return;
    }

    const stake = Math.max(DERIV_MIN_STAKE, Number(paperStake));
    if (stake !== paperStake) {
      console.log(`[DEMO LIVE] ${name} stake normalized · paper risk $${paperStake.toFixed(2)} → Deriv Demo minimum $${stake.toFixed(2)}`);
    }

    const contract_type = side === 'LONG' ? 'MULTUP' : 'MULTDOWN';
    const paperEntryAt = Number(event.at || Date.now());
    console.log(`[DEMO LIVE] 🎯 ${name} PAPER ENTRY DETECTED · ${side} · ${event.text}`);
    console.log(`[DEMO LIVE] ${name} requesting ${contract_type} · Demo stake $${stake.toFixed(2)} · paper risk $${paperStake.toFixed(2)} · x${this.multiplier}`);

    let prop;
    try {
      const r = await this.request({
        proposal: 1,
        amount: stake,
        basis: 'stake',
        contract_type,
        currency: this.currency,
        duration_unit: 's',
        multiplier: this.multiplier,
        underlying_symbol: this.symbol
      });
      prop = r.proposal;
    } catch (e) {
      console.error(`[DEMO LIVE] ${name} proposal REJECTED. No trade placed:`, e.message);
      return;
    }

    if (!prop?.id) {
      console.error(`[DEMO LIVE] ${name} proposal had no id. No trade placed.`);
      return;
    }

    const ask = Number(prop.ask_price ?? stake);
    let bought;
    try {
      const r = await this.request({ buy: prop.id, price: Number.isFinite(ask) ? ask : stake });
      bought = r.buy;
    } catch (e) {
      console.error(`[DEMO LIVE] ${name} BUY REJECTED. No retry/upsize:`, e.message);
      return;
    }

    if (!bought?.contract_id) {
      console.error(`[DEMO LIVE] ${name} buy returned no contract id.`);
      return;
    }

    const live = {
      name,
      contractId: bought.contract_id,
      side,
      paperStake,
      stake,
      multiplier: this.multiplier,
      buyPrice: Number(bought.buy_price ?? ask ?? stake),
      paperEntryAt,
      buyAt: Date.now(),
      latencyMs: Date.now() - paperEntryAt,
      lastProfit: 0
    };

    this.live[name] = live;
    this.saveState();
    this.writeStatus();
    console.log(`[DEMO LIVE] ✅ ${name} DEMO BOUGHT ${side} contract ${live.contractId} · $${stake.toFixed(2)} x${this.multiplier} · paper risk $${paperStake.toFixed(2)} · bridge latency ${live.latencyMs}ms`);

    try {
      await this.request({ proposal_open_contract: 1, contract_id: Number(live.contractId), subscribe: 1 });
    } catch (e) {
      console.error(`[DEMO LIVE] ${name} monitor subscribe:`, e.message);
    }
  }

  recordClosed(name, row) {
    this.closed[name].unshift({ ...row, closedAt: Date.now() });
    this.closed[name] = this.closed[name].slice(0, 2000);
  }

  async sellFor(name, event) {
    const live = this.live[name];
    if (!live) {
      console.log(`[DEMO LIVE] ${name} PAPER EXIT detected with no matching Demo contract. Nothing sold.`);
      return;
    }

    console.log(`[DEMO LIVE] ${name} PAPER EXIT DETECTED · selling Demo contract ${live.contractId} at market · ${event.text}`);
    try {
      const r = await this.request({ sell: Number(live.contractId), price: 0 });
      const sold = r.sell;
      const soldFor = Number(sold?.sold_for || 0);
      const demoPnl = Number((soldFor - Number(live.buyPrice || live.stake || 0)).toFixed(4));
      const row = {
        ...live,
        demoPnl,
        soldFor,
        exitReason: event.text || 'PAPER EXIT',
        paperExitAt: Number(event.at || Date.now()),
        sellAt: Date.now()
      };
      this.recordClosed(name, row);
      this.live[name] = null;
      this.saveState();
      if (sold?.balance_after != null) this.account.balance = Number(sold.balance_after);
      this.writeStatus();
      console.log(`[DEMO LIVE] ✅ ${name} DEMO SOLD · P/L ${demoPnl >= 0 ? '+' : ''}$${demoPnl.toFixed(2)} · balance ${this.account.balance}`);
    } catch (e) {
      console.error(`[DEMO LIVE] ${name} SELL FAILED. Contract remains tracked:`, e.message);
    }
  }

  async processName(name) {
    const snap = await this.readSnapshot(name);

    if (!this.readyAfterFlat[name]) {
      for (const e of snap.tape) this.remember(name, e);
      if (!snap.active) {
        this.readyAfterFlat[name] = true;
        console.log(`[DEMO LIVE] ${name} is flat. ARMED for next fresh paper entry.`);
      }
      return;
    }

    const fresh = snap.tape
      .filter(e => !this.seen[name].has(this.eventKey(e)))
      .sort((a, b) => a.at - b.at);

    for (const event of fresh) {
      this.remember(name, event);
      if (event.type === 'ENTRY') await this.buyFor(name, event, snap);
      if (event.type === 'EXIT') await this.sellFor(name, event);
    }
  }

  async tick() {
    try {
      await this.processName('COMET');
      await this.processName('LAST_MAN');
      this.writeStatus();
    } catch (e) {
      console.error('[DEMO LIVE] bridge tick:', e.message);
    }
  }

  async heartbeat() {
    try {
      const [c, l] = await Promise.all([this.readSnapshot('COMET'), this.readSnapshot('LAST_MAN')]);
      console.log(
        `[DEMO LIVE HEARTBEAT] balance=${this.account?.balance} · ` +
        `COMET paperTrades=${c.trades} demoOpen=${this.live.COMET ? 1 : 0} · ` +
        `LAST_MAN_GRAB paperTrades=${l.trades} demoOpen=${this.live.LAST_MAN ? 1 : 0}`
      );
    } catch (e) {
      console.error('[DEMO LIVE HEARTBEAT]', e.message);
    }
  }

  async start() {
    if (this.running) return;
    await this.verifyDemoAccount();
    await this.connectWs();
    await this.subscribeBalance();
    await this.lockLastManGrab();
    await this.seed('COMET');
    await this.seed('LAST_MAN');
    await this.restoreOpenContracts();
    this.running = true;
    if (this.requestedMultiplier !== this.multiplier) {
      console.log(`[DEMO LIVE] multiplier normalized · requested x${this.requestedMultiplier} → Deriv-supported x${this.multiplier}`);
    }
    this.writeStatus({ note: 'Demo multiplier execution bridge v4 active. LAST MAN is GRAB-only. Stake minimum is $1 and multiplier is normalized to a Deriv-supported value.' });
    console.log(`[DEMO LIVE] 🚦 BRIDGE V4 ACTIVE · COMET + LAST MAN GRAB → Deriv DEMO Multipliers only · min stake $1 · multiplier x${this.multiplier}`);
    this.timer = setInterval(() => this.tick(), 350);
    this.heartbeatTimer = setInterval(() => this.heartbeat(), 30000);
  }
}

module.exports = { DemoExecutionBridge };
