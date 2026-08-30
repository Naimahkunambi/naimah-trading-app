export const NANA_MULTIPLIERS = Object.freeze([160, 400, 800, 1200, 1600]);

const n = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const closed = c => Boolean(c?.is_sold) || ['sold','won','lost'].includes(String(c?.status || '').toLowerCase());

export class NanaMultiplierExecutor {
  constructor({ onStatus = () => {}, onEvent = () => {} } = {}) {
    this.onStatus = onStatus;
    this.onEvent = onEvent;
    this.ws = null;
    this.pending = new Map();
    this.reqId = 200;
    this.pingTimer = null;
    this.buyPending = false;
    this.sellPending = false;
    this.legacy = false;
    this.state = this.fresh();
  }

  fresh() {
    return { connected:false, status:'OFF', accountId:'', accountType:'', currency:'USD', balance:null, contract:null, realized:0, trades:[], transport:'' };
  }
  snapshot() { return { ...this.state, contract:this.state.contract ? {...this.state.contract} : null, trades:[...this.state.trades], buyPending:this.buyPending, sellPending:this.sellPending }; }
  emit() { this.onStatus(this.snapshot()); }
  event(type, text, extra={}) { this.onEvent({ at:Date.now(), type, text, ...extra }); this.emit(); }

  async connect({ appId, token, account }) {
    if (!appId || !token || !account?.account_id) throw new Error('App ID, token and selected Deriv account are required.');
    this.state.status = 'AUTHORIZING'; this.emit();

    if (account.legacy) return this.connectLegacy({ appId, token, account });

    try {
      const response = await fetch('/api/otp', {
        method:'POST', headers:{'content-type':'application/json'},
        body:JSON.stringify({ appId, token, accountId:account.account_id, demoOnly:false }), cache:'no-store'
      });
      const payload = await response.json().catch(()=>({}));
      if (!response.ok || !payload?.url) throw new Error(payload?.error || `Deriv authorization failed (${response.status}).`);
      this.legacy = false;
      this.state.accountId = String(account.account_id);
      this.state.accountType = String(account.account_type || '').toLowerCase();
      this.state.currency = account.currency || 'USD';
      this.state.transport = 'OPTIONS API';
      if (account.balance != null) this.state.balance = n(account.balance, null);
      await this.openSocket(payload.url);
      this.state.connected = true;
      this.state.status = this.state.accountType === 'real' ? 'REAL CONNECTED' : 'DEMO CONNECTED';
      await this.request({ balance:1, subscribe:1 }).catch(()=>null);
      this.event('ACCOUNT CONNECTED', `${this.state.accountType.toUpperCase()} ${this.state.accountId} connected to Nana via Options API.`);
      return this.snapshot();
    } catch (optionsError) {
      return this.connectLegacy({ appId, token, account, optionsError });
    }
  }

  async connectLegacy({ appId, token, account, optionsError = null }) {
    this.state.status = 'TRYING LEGACY DERIV'; this.emit();
    this.legacy = true;
    await this.openSocket(`wss://ws.derivws.com/websockets/v3?app_id=${encodeURIComponent(appId)}`);
    let auth;
    try {
      auth = await this.request({ authorize: token }, 15000);
    } catch (legacyError) {
      this.disconnectSocket();
      const a = optionsError?.message ? `Options API: ${optionsError.message}. ` : '';
      throw new Error(`${a}Legacy Deriv: ${legacyError.message}`);
    }
    const z = auth?.authorize || {};
    if (!z.loginid) {
      this.disconnectSocket();
      throw new Error('Legacy Deriv authorization returned no account.');
    }
    this.state.accountId = String(z.loginid);
    this.state.accountType = z.is_virtual ? 'demo' : 'real';
    this.state.currency = z.currency || account?.currency || 'USD';
    this.state.balance = n(z.balance, account?.balance ?? null);
    this.state.transport = 'LEGACY WEBSOCKET';
    this.state.connected = true;
    this.state.status = this.state.accountType === 'real' ? 'REAL CONNECTED' : 'DEMO CONNECTED';
    await this.request({ balance:1, subscribe:1 }).catch(()=>null);
    this.event('ACCOUNT CONNECTED', `${this.state.accountType.toUpperCase()} ${this.state.accountId} connected to Nana via legacy Deriv WebSocket.`);
    return this.snapshot();
  }

  openSocket(url) {
    this.disconnectSocket();
    return new Promise((resolve,reject)=>{
      const ws = new WebSocket(url);
      const timer = setTimeout(()=>{ try{ws.close();}catch{} reject(new Error('Deriv trading socket timed out.')); },15000);
      ws.onopen=()=>{ clearTimeout(timer); this.ws=ws; this.pingTimer=setInterval(()=>{try{if(this.ws?.readyState===1)this.ws.send(JSON.stringify({ping:1}));}catch{}},25000); resolve(); };
      ws.onerror=()=>{ clearTimeout(timer); if(!this.ws) reject(new Error('Could not open Deriv trading socket.')); };
      ws.onclose=()=>{ clearTimeout(timer); if(this.ws===ws){this.ws=null; clearInterval(this.pingTimer); this.pingTimer=null; this.state.connected=false; this.state.status=this.state.contract?'DISCONNECTED · CONTRACT OPEN':'DISCONNECTED'; this.emit();} };
      ws.onmessage=e=>this.onMessage(e.data);
    });
  }
  disconnectSocket(){clearInterval(this.pingTimer);this.pingTimer=null;if(this.ws){try{this.ws.close();}catch{}}this.ws=null;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Deriv socket closed.'));}this.pending.clear();}
  disconnect(){ if(this.state.contract) throw new Error('Close Nana\'s open contract before disconnecting.'); this.disconnectSocket(); this.state.connected=false; this.state.status='OFF'; this.emit(); }
  request(payload, timeoutMs=15000){ if(!this.ws||this.ws.readyState!==1)return Promise.reject(new Error('Deriv trading socket is not open.')); const req_id=++this.reqId; return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(req_id);reject(new Error(`Deriv request timed out: ${Object.keys(payload)[0]}`));},timeoutMs);this.pending.set(req_id,{resolve,reject,timer});this.ws.send(JSON.stringify({...payload,req_id}));}); }
  onMessage(raw){let m;try{m=JSON.parse(String(raw));}catch{return;} if(m.req_id&&this.pending.has(m.req_id)){const p=this.pending.get(m.req_id);this.pending.delete(m.req_id);clearTimeout(p.timer);m.error?p.reject(new Error(`${m.error.code||'DerivError'}: ${m.error.message||'request failed'}`)):p.resolve(m);} if(m.msg_type==='balance'&&m.balance){this.state.balance=n(m.balance.balance,this.state.balance);this.emit();} if(m.msg_type!=='proposal_open_contract'||!m.proposal_open_contract||!this.state.contract)return;const c=m.proposal_open_contract;if(String(c.contract_id)!==String(this.state.contract.contractId))return;this.state.contract.liveProfit=n(c.profit,this.state.contract.liveProfit);this.state.contract.status=String(c.status||'open').toUpperCase();this.emit();if(closed(c)&&!this.sellPending)this.recordClosed({reason:`DERIV ${String(c.status||'CLOSED').toUpperCase()}`,pnl:n(c.profit,this.state.contract.liveProfit),soldFor:n(c.sell_price,0)});}

  normalizeMultiplier(v){v=Number(v);if(!NANA_MULTIPLIERS.includes(v))throw new Error(`Multiplier must be one of ${NANA_MULTIPLIERS.join(', ')}.`);return v;}

  async buy({ side, stake, stopLoss, takeProfit, multiplier=160, symbol='1HZ25V', context='' }) {
    if (!this.state.connected) throw new Error('Nana is not connected to a Deriv account.');
    if (this.state.contract || this.buyPending) return false;
    if (!['LONG','SHORT'].includes(side)) throw new Error('Side must be LONG or SHORT.');
    const actualStake=Math.max(1,Number(n(stake,1).toFixed(2)));
    const actualSL=Math.max(.1,n(stopLoss,actualStake));
    const actualTP=Math.max(.1,n(takeProfit,actualStake*2));
    const actualMultiplier=this.normalizeMultiplier(multiplier);
    const contractType=side==='LONG'?'MULTUP':'MULTDOWN';
    this.buyPending=true;this.state.status='OPENING CONTRACT';this.emit();
    try{
      const proposalPayload={proposal:1,amount:actualStake,basis:'stake',contract_type:contractType,currency:this.state.currency,limit_order:{stop_loss:actualSL,take_profit:actualTP},multiplier:actualMultiplier};
      if(this.legacy)proposalPayload.symbol=symbol;else{proposalPayload.duration_unit='s';proposalPayload.underlying_symbol=symbol;}
      const proposed=await this.request(proposalPayload);
      if(!proposed?.proposal?.id)throw new Error('Deriv returned no proposal ID.');
      const ask=n(proposed.proposal.ask_price,actualStake);
      const bought=await this.request({buy:proposed.proposal.id,price:ask});
      if(!bought?.buy?.contract_id)throw new Error('Deriv returned no contract ID.');
      this.state.contract={contractId:bought.buy.contract_id,side,stake:actualStake,stopLoss:actualSL,takeProfit:actualTP,multiplier:actualMultiplier,symbol,buyPrice:n(bought.buy.buy_price,ask),boughtAt:Date.now(),liveProfit:0,status:'OPEN',context};
      this.state.status='CONTRACT OPEN';this.event('TRADE OPENED',`${side} ${this.state.contract.contractId} · stake $${actualStake.toFixed(2)} · SL $${actualSL.toFixed(2)} · TP $${actualTP.toFixed(2)}`,{side});
      await this.request({proposal_open_contract:1,contract_id:Number(this.state.contract.contractId),subscribe:1}).catch(e=>this.event('WARNING',`Opened, but monitoring subscription failed: ${e.message}`,{side}));
      return true;
    } catch(error){this.state.status='BUY REJECTED';this.event('TRADE REJECTED',error.message,{side});return false;} finally{this.buyPending=false;this.emit();}
  }

  async sell(reason='NANA EXIT'){
    if(!this.state.contract||this.sellPending)return false;
    const tracked={...this.state.contract};this.sellPending=true;this.state.status='CLOSING CONTRACT';this.emit();
    try{const response=await this.request({sell:Number(tracked.contractId),price:0});const soldFor=n(response?.sell?.sold_for,0);if(response?.sell?.balance_after!=null)this.state.balance=n(response.sell.balance_after,this.state.balance);this.recordClosed({reason,pnl:Number((soldFor-tracked.buyPrice).toFixed(4)),soldFor});return true;}catch(error){this.state.status='SELL FAILED · CONTRACT OPEN';this.event('SELL FAILED',error.message,{side:tracked.side});return false;}finally{this.sellPending=false;this.emit();}
  }
  recordClosed({reason,pnl,soldFor}){const c=this.state.contract;if(!c)return;const row={...c,reason,pnl:n(pnl,0),soldFor:n(soldFor,0),closedAt:Date.now()};this.state.trades=[row,...this.state.trades].slice(0,1500);this.state.realized=Number((this.state.realized+row.pnl).toFixed(4));this.state.contract=null;this.state.status=this.state.connected?(this.state.accountType==='real'?'REAL CONNECTED':'DEMO CONNECTED'):'OFF';this.event('TRADE CLOSED',`${row.side} ${row.contractId} · ${reason} · ${row.pnl>=0?'+':'-'}$${Math.abs(row.pnl).toFixed(2)}`,{side:row.side});}
}
