import { analyzeMountain } from './core/libra-mountain.mjs';

const $ = id => document.getElementById(id);
const money = v => `${Number(v || 0) >= 0 ? '+' : '-'}$${Math.abs(Number(v || 0)).toFixed(2)}`;
const clamp = (v, min, max) => Math.max(min, Math.min(max, Number(v) || 0));
const KEY = 'sani.comet.paper.v2';
const PUBLIC_WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';
const MAX_TICKS = 5000;
const HISTORY_COUNT = 1200;

let ws = null;
let subscriptionId = null;
let manualDisconnect = true;
let reconnectTimer = null;
let reconnectAttempt = 0;
let ticks = [];
let page = 0;
let auto = false;
let position = null;
let session = loadSession();
let latestMountain = analyzeMountain([]);

function freshSession() {
  return { pnl: 0, trades: [], tape: [], peak: 0, trough: 0, maxDrawdown: 0, equity: 0 };
}
function loadSession() {
  try {
    return { ...freshSession(), ...(JSON.parse(localStorage.getItem(KEY) || 'null') || {}) };
  } catch {
    return freshSession();
  }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(session)); } catch {}
}
function addTape(type, text, extra = {}) {
  session.tape.unshift({ at: Date.now(), type, text, ...extra });
  session.tape = session.tape.slice(0, 800);
  save();
  renderTape();
}
function setFeedStatus(text, ok = false) {
  const el = $('cometFeedStatus');
  if (!el) return;
  el.textContent = text;
  el.dataset.ok = ok ? '1' : '0';
}
function setAccountStatus(text, ok = false) {
  const el = $('cometAccountStatus');
  if (!el) return;
  el.textContent = text;
  el.dataset.ok = ok ? '1' : '0';
}
function symbol() { return $('cometSymbol')?.value?.trim() || '1HZ25V'; }
function dedupe(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const epoch = Number(row?.epoch), quote = Number(row?.quote);
    if (Number.isFinite(epoch) && Number.isFinite(quote)) map.set(`${epoch}:${quote}`, { epoch, quote });
  }
  return [...map.values()].sort((a, b) => a.epoch - b.epoch);
}
function tickStep(rows = ticks) {
  const d = [];
  for (let i = Math.max(1, rows.length - 80); i < rows.length; i++) d.push(Math.abs(rows[i].quote - rows[i - 1].quote));
  d.sort((a, b) => a - b);
  return d.length ? d[Math.floor(d.length / 2)] || 1 : 1;
}
function allowedSide(m) {
  return m?.allowedDirection === 'CALL' ? 'LONG' : m?.allowedDirection === 'PUT' ? 'SHORT' : 'NONE';
}

function candidate(m) {
  if (!auto || position || !m?.ready) return null;
  if (!['UP', 'DOWN'].includes(m.direction)) return null;
  if (!['WAIT_PULLBACK_END', 'PULLBACK_END', 'EARLY_MOMENTUM'].includes(m.entryMode)) return null;

  const quote = Number(ticks.at(-1)?.quote);
  if (!Number.isFinite(quote)) return null;

  const riskDollars = Math.max(.1, Number($('riskDollars')?.value || 1));
  const targetR = clamp($('targetR')?.value || 2, 1, 8);
  const step = tickStep();
  const side = m.direction === 'UP' ? 'LONG' : 'SHORT';
  const structureStop = Number(m.important?.quote);
  let stop = Number.isFinite(structureStop) ? structureStop : side === 'LONG' ? quote - step * 4 : quote + step * 4;
  if (side === 'LONG' && stop >= quote) stop = quote - step * 3;
  if (side === 'SHORT' && stop <= quote) stop = quote + step * 3;

  const riskDistance = Math.abs(quote - stop);
  if (!(riskDistance > 0)) return null;

  const target = side === 'LONG' ? quote + riskDistance * targetR : quote - riskDistance * targetR;
  const units = riskDollars / riskDistance;
  return {
    side, entry: quote, stop, target, units, riskDollars, targetR,
    openedAt: Date.now(), openedEpoch: ticks.at(-1)?.epoch,
    mountain: structuredClone(m), bestR: 0, trailStop: stop
  };
}
function openPosition(c) {
  position = c;
  addTape('ENTRY', `${c.side} opened @ ${c.entry.toFixed(2)} · stop ${c.stop.toFixed(2)} · target ${c.target.toFixed(2)}`, { side: c.side });
  renderAll();
}
function unrealized(p = position, quote = ticks.at(-1)?.quote) {
  if (!p || !Number.isFinite(Number(quote))) return { pnl: 0, r: 0 };
  const delta = p.side === 'LONG' ? Number(quote) - p.entry : p.entry - Number(quote);
  const pnl = delta * p.units;
  return { pnl, r: p.riskDollars ? pnl / p.riskDollars : 0 };
}
function closePaperPosition(reason, quote = ticks.at(-1)?.quote) {
  if (!position || !Number.isFinite(Number(quote))) return;
  const u = unrealized(position, quote);
  const trade = {
    ...position, exit: Number(quote), closedAt: Date.now(),
    pnl: Number(u.pnl.toFixed(4)), r: Number(u.r.toFixed(4)), reason
  };
  session.trades.unshift(trade);
  session.pnl = Number((session.pnl + trade.pnl).toFixed(4));
  session.equity = session.pnl;
  session.peak = Math.max(session.peak, session.equity);
  session.trough = Math.min(session.trough, session.equity);
  session.maxDrawdown = Math.max(session.maxDrawdown, session.peak - session.equity);
  addTape('EXIT', `${trade.side} closed ${reason} · ${money(trade.pnl)} · ${trade.r.toFixed(2)}R`, { side: trade.side });
  position = null;
  save();
  renderAll();
}
function managePosition(m) {
  if (!position) return;
  const q = Number(ticks.at(-1)?.quote);
  if (!Number.isFinite(q)) return;
  const u = unrealized(position, q);
  position.bestR = Math.max(position.bestR || 0, u.r);

  const thesisBroken =
    (position.side === 'LONG' && m.direction === 'DOWN') ||
    (position.side === 'SHORT' && m.direction === 'UP') ||
    m.direction === 'CHOP';

  if (position.side === 'LONG' && q <= position.trailStop) return closePaperPosition('STOP / INVALIDATION', q);
  if (position.side === 'SHORT' && q >= position.trailStop) return closePaperPosition('STOP / INVALIDATION', q);
  if (position.side === 'LONG' && q >= position.target) return closePaperPosition('TARGET', q);
  if (position.side === 'SHORT' && q <= position.target) return closePaperPosition('TARGET', q);
  if (thesisBroken) return closePaperPosition('MOUNTAIN REVERSAL', q);

  if (u.r >= 1) {
    const risk = Math.abs(position.entry - position.stop);
    const protect = position.side === 'LONG' ? position.entry + risk * .15 : position.entry - risk * .15;
    position.trailStop = position.side === 'LONG' ? Math.max(position.trailStop, protect) : Math.min(position.trailStop, protect);
  }
  if (u.r >= 1.5 && Number.isFinite(Number(m.important?.quote))) {
    const s = Number(m.important.quote);
    if (position.side === 'LONG' && s > position.trailStop && s < q) position.trailStop = s;
    if (position.side === 'SHORT' && s < position.trailStop && s > q) position.trailStop = s;
  }
}
function ingestTick(epoch, quote, render = true) {
  epoch = Number(epoch); quote = Number(quote);
  if (!Number.isFinite(epoch) || !Number.isFinite(quote)) return;
  const last = ticks.at(-1);
  if (last && last.epoch === epoch && last.quote === quote) return;
  ticks.push({ epoch, quote });
  if (ticks.length > MAX_TICKS) ticks.splice(0, ticks.length - MAX_TICKS);
  latestMountain = analyzeMountain(ticks);
  managePosition(latestMountain);
  if (!position) {
    const c = candidate(latestMountain);
    if (c) openPosition(c);
  }
  if (render) renderAll();
}
function ingestHistory(history) {
  const prices = history?.prices || [];
  const times = history?.times || [];
  const rows = prices.map((quote, i) => ({ epoch: Number(times[i]), quote: Number(quote) }));
  ticks = dedupe([...ticks, ...rows]).slice(-MAX_TICKS);
  latestMountain = analyzeMountain(ticks);
  renderAll();
}

function closeFeed() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (!ws) return;
  try {
    if (subscriptionId && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ forget: subscriptionId }));
  } catch {}
  try { ws.close(); } catch {}
  ws = null;
  subscriptionId = null;
}
function scheduleReconnect() {
  if (manualDisconnect || reconnectTimer || reconnectAttempt >= 6) return;
  reconnectAttempt += 1;
  const delay = Math.min(12000, 700 * (2 ** (reconnectAttempt - 1)));
  setFeedStatus(`RETRY ${reconnectAttempt}/6`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    openFeed();
  }, delay);
}
function openFeed() {
  closeFeed();
  setFeedStatus('CONNECTING');
  try {
    ws = new WebSocket(PUBLIC_WS_URL);
    ws.onopen = () => {
      reconnectAttempt = 0;
      setFeedStatus('LOADING', true);
      const s = symbol();
      ws.send(JSON.stringify({ ticks_history: s, count: HISTORY_COUNT, end: 'latest', style: 'ticks', req_id: 1 }));
      ws.send(JSON.stringify({ ticks: s, subscribe: 1, req_id: 2 }));
    };
    ws.onmessage = event => {
      let d;
      try { d = JSON.parse(String(event.data)); } catch { return; }
      if (d.error) {
        const msg = d.error.message || d.error.code || 'Market data error';
        setFeedStatus('ERROR');
        addTape('ERROR', `Market feed: ${msg}`);
        return;
      }
      if (d.msg_type === 'history' && d.history) {
        ingestHistory(d.history);
        setFeedStatus('LIVE', true);
        addTape('SYSTEM', `Loaded ${ticks.length.toLocaleString()} ticks of market context.`);
      }
      if (d.msg_type === 'tick' && d.tick) {
        subscriptionId = d.subscription?.id || subscriptionId;
        ingestTick(d.tick.epoch, d.tick.quote);
        setFeedStatus('LIVE', true);
      }
    };
    ws.onerror = () => {
      setFeedStatus('ERROR');
      addTape('ERROR', 'Public market WebSocket error.');
    };
    ws.onclose = () => {
      ws = null;
      subscriptionId = null;
      if (manualDisconnect) setFeedStatus('OFFLINE');
      else scheduleReconnect();
    };
  } catch (error) {
    setFeedStatus('ERROR');
    addTape('ERROR', error?.message || 'Could not open market feed.');
    scheduleReconnect();
  }
}
function connect() {
  manualDisconnect = false;
  reconnectAttempt = 0;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  addTape('SYSTEM', `Connecting ${symbol()} through Deriv public market feed.`);
  openFeed();
}
function disconnect() {
  manualDisconnect = true;
  closeFeed();
  setFeedStatus('OFFLINE');
}

async function loadAccounts() {
  const appId = $('cometAppId')?.value?.trim();
  const token = $('cometToken')?.value?.trim();
  if (!appId || !token) {
    setAccountStatus('APP ID + TOKEN');
    return;
  }
  const btn = $('cometLoadAccounts');
  btn.disabled = true;
  setAccountStatus('LOADING');
  try {
    const r = await fetch('/api/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId, token })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `Account load failed (${r.status})`);

    const accounts = Array.isArray(d.accounts) ? d.accounts : [];
    const demos = accounts.filter(a => String(a.account_type || '').toLowerCase() !== 'real');
    const sel = $('cometAccount');
    sel.innerHTML = '';
    if (!demos.length) sel.innerHTML = '<option value="">No Demo accounts</option>';
    for (const a of demos) {
      const o = document.createElement('option');
      o.value = a.account_id;
      o.textContent = `DEMO · ${a.account_id} · ${a.currency || ''} ${a.balance ?? ''}`;
      sel.appendChild(o);
    }
    setAccountStatus(demos.length ? `${demos.length} DEMO READY` : 'NO DEMO', demos.length > 0);
    sessionStorage.setItem('sani.comet.token', token);
    localStorage.setItem('sani.comet.appId', appId);
    addTape('SYSTEM', demos.length ? `Loaded ${demos.length} Demo account(s).` : 'No Demo account returned.');
  } catch (error) {
    setAccountStatus('ERROR');
    addTape('ERROR', `Account load: ${error?.message || 'unknown error'}`);
  } finally {
    btn.disabled = false;
  }
}

function switchPage(n) {
  page = clamp(n, 0, 5);
  document.querySelectorAll('[data-comet-page]').forEach((el, i) => {
    const on = i === page;
    el.classList.toggle('active', on);
    el.setAttribute('aria-hidden', String(!on));
  });
  document.querySelectorAll('[data-comet-target]').forEach(btn => btn.classList.toggle('active', Number(btn.dataset.cometTarget) === page));
  if (page === 1) drawChart();
}
function renderAll() {
  const q = Number(ticks.at(-1)?.quote);
  $('cometTickCount').textContent = ticks.length.toLocaleString();
  $('cometLastQuote').textContent = Number.isFinite(q) ? `${symbol()} · ${q.toFixed(2)}` : 'waiting for price';
  $('mapMountain').textContent = latestMountain.direction || 'WARMING';
  $('mapPermission').textContent = `${allowedSide(latestMountain)} ONLY`;
  $('mapMoment').textContent = latestMountain.entryMode || '—';
  $('mapReason').textContent = latestMountain.reason || 'waiting for shape';

  const u = unrealized();
  $('mapHand').textContent = position ? position.side : auto ? 'SCANNING' : 'STAND DOWN';
  $('mapThesis').textContent = position ? `${position.side} thesis alive · trail ${position.trailStop.toFixed(2)}` : auto ? 'Waiting for a Libra-quality directional window.' : 'Paper auto is paused.';
  $('mapR').textContent = `${u.r.toFixed(2)}R`;
  $('mapRisk').textContent = position ? `risk ${money(position.riskDollars)} · target ${position.targetR.toFixed(2)}R` : 'risk not armed';

  $('positionHeadline').textContent = position ? `${position.side} the mountain.` : 'Waiting for a worthy move.';
  $('positionSub').textContent = position ? 'Noise can wiggle. The thesis exits only at structural invalidation, target, or earned trail.' : 'COMET can watch forever. It does not need to manufacture a trade.';
  $('positionSide').textContent = position ? position.side : 'STAND DOWN';
  $('positionEntry').textContent = position ? position.entry.toFixed(2) : '—';
  $('positionStop').textContent = position ? position.trailStop.toFixed(2) : '—';
  $('positionTarget').textContent = position ? position.target.toFixed(2) : '—';
  $('positionPnl').textContent = money(u.pnl);
  $('positionR').textContent = `${u.r.toFixed(2)}R`;

  $('cometPnl').textContent = money(session.pnl + u.pnl);
  $('cometState').textContent = auto ? 'PAPER ACTIVE' : 'PAPER LAB';
  const goal = Math.max(1, Number($('goalDollars')?.value || 650));
  $('goalFill').style.width = `${clamp(session.pnl / goal * 100, 0, 100)}%`;
  $('goalCaption').textContent = `${money(session.pnl)} / $${goal.toFixed(0)}`;
  $('footerGoal').textContent = `$${goal.toFixed(0)}`;
  renderResults();
  renderTape();
  if (page === 1) drawChart();
}
function renderResults() {
  const trades = session.trades || [];
  const wins = trades.filter(t => t.pnl > 0).length;
  $('statPnl').textContent = money(session.pnl);
  $('statTrades').textContent = trades.length;
  $('statWinRate').textContent = `${trades.length ? (wins / trades.length * 100).toFixed(1) : '0.0'}%`;
  $('statBest').textContent = money(trades.length ? Math.max(...trades.map(t => t.pnl)) : 0);
  $('statWorst').textContent = money(trades.length ? Math.min(...trades.map(t => t.pnl)) : 0);
  $('statDrawdown').textContent = money(-Math.abs(session.maxDrawdown || 0));
  const body = $('resultsBody');
  if (!trades.length) {
    body.innerHTML = '<tr><td colspan="7">No positions closed yet.</td></tr>';
    return;
  }
  body.innerHTML = trades.slice(0, 100).map(t => `<tr><td>${new Date(t.closedAt).toLocaleTimeString()}</td><td>${t.side}</td><td>${t.entry.toFixed(2)}</td><td>${t.exit.toFixed(2)}</td><td>${t.reason}</td><td>${t.r.toFixed(2)}R</td><td>${money(t.pnl)}</td></tr>`).join('');
}
function renderTape() {
  const list = $('tapeList'), rows = session.tape || [];
  $('tapeCount').textContent = `${rows.length} EVENTS`;
  list.innerHTML = rows.length ? rows.slice(0, 200).map(r => `<div class="tapeEvent"><span>${new Date(r.at).toLocaleTimeString()}</span><b>${r.type}</b><span>${r.text}</span><em>${r.side || ''}</em></div>`).join('') : '<p>Nothing yet.</p>';
}
function drawChart() {
  const c = $('cometChart');
  if (!c) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(600, c.clientWidth), h = Math.max(380, c.clientHeight);
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#080709'; ctx.fillRect(0, 0, w, h);

  const rows = ticks.slice(-260);
  if (rows.length < 2) {
    ctx.fillStyle = '#b98ca0'; ctx.font = '12px monospace';
    ctx.fillText('CONNECT LIVE MARKET TO DRAW COMET', 28, 40);
    return;
  }
  const pad = { l: 42, r: 84, t: 30, b: 36 };
  const qs = rows.map(r => r.quote), lo = Math.min(...qs), hi = Math.max(...qs), range = hi - lo || 1;
  const x = i => pad.l + i / (rows.length - 1) * (w - pad.l - pad.r);
  const y = q => pad.t + (hi - q) / range * (h - pad.t - pad.b);

  ctx.strokeStyle = 'rgba(255,183,216,.10)'; ctx.lineWidth = 1;
  for (let i = 0; i < 6; i++) {
    const yy = pad.t + i / 5 * (h - pad.t - pad.b);
    ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(w - pad.r, yy); ctx.stroke();
  }

  ctx.strokeStyle = '#8df5df'; ctx.lineWidth = 1.8; ctx.beginPath();
  rows.forEach((r, i) => i ? ctx.lineTo(x(i), y(r.quote)) : ctx.moveTo(x(i), y(r.quote)));
  ctx.stroke();

  const m = analyzeMountain(rows);
  const piv = m.pivots || [];
  if (piv.length > 1) {
    ctx.strokeStyle = '#ff8fc3'; ctx.lineWidth = 1.3; ctx.setLineDash([7, 6]); ctx.beginPath();
    let started = false;
    for (const p of piv) {
      const idx = rows.findIndex(r => r.epoch === p.epoch && r.quote === p.quote);
      if (idx < 0) continue;
      if (!started) { ctx.moveTo(x(idx), y(p.quote)); started = true; } else ctx.lineTo(x(idx), y(p.quote));
    }
    ctx.stroke(); ctx.setLineDash([]);
  }

  const line = (q, color, label) => {
    if (!Number.isFinite(Number(q))) return;
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash([5, 4]); ctx.beginPath();
    ctx.moveTo(pad.l, y(q)); ctx.lineTo(w - pad.r, y(q)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = color; ctx.font = '10px monospace'; ctx.fillText(label, w - pad.r + 8, y(q) + 3);
  };
  if (position) {
    line(position.trailStop, '#ff6677', 'STOP');
    line(position.target, '#67e7a0', 'TARGET');
    line(position.entry, '#ffacd0', 'ENTRY');
  }
  for (const t of (session.trades || []).slice(0, 20)) {
    const idx = rows.findIndex(r => r.epoch === t.openedEpoch);
    if (idx < 0) continue;
    ctx.fillStyle = t.side === 'LONG' ? '#79f0b4' : '#ff687a';
    ctx.beginPath();
    if (t.side === 'LONG') {
      ctx.moveTo(x(idx), y(t.entry) - 8); ctx.lineTo(x(idx) - 6, y(t.entry) + 5); ctx.lineTo(x(idx) + 6, y(t.entry) + 5);
    } else {
      ctx.moveTo(x(idx), y(t.entry) + 8); ctx.lineTo(x(idx) - 6, y(t.entry) - 5); ctx.lineTo(x(idx) + 6, y(t.entry) - 5);
    }
    ctx.closePath(); ctx.fill();
  }
  ctx.fillStyle = '#ffb3d2'; ctx.font = '11px monospace';
  ctx.fillText(`LIBRA MOUNTAIN: ${m.direction} · ${m.entryMode} · ${allowedSide(m)}`, pad.l, 18);
}

function bind() {
  document.querySelectorAll('[data-comet-target]').forEach(b => b.addEventListener('click', () => switchPage(Number(b.dataset.cometTarget))));
  document.querySelectorAll('[data-next]').forEach(b => b.addEventListener('click', () => switchPage(page + 1)));
  document.querySelectorAll('[data-prev]').forEach(b => b.addEventListener('click', () => switchPage(page - 1)));
  $('cometConnect').addEventListener('click', connect);
  $('cometDisconnect').addEventListener('click', disconnect);
  $('cometLoadAccounts').addEventListener('click', loadAccounts);
  $('startAuto').addEventListener('click', () => { auto = true; addTape('SYSTEM', 'AUTO PAPER armed. COMET will wait for a directional setup.'); renderAll(); });
  $('pauseAuto').addEventListener('click', () => { auto = false; addTape('SYSTEM', 'AUTO PAPER paused.'); renderAll(); });
  $('closePosition').addEventListener('click', () => closePaperPosition('MANUAL CLOSE'));
  $('resetComet').addEventListener('click', () => {
    if (position) closePaperPosition('RESET CLOSE');
    session = freshSession(); position = null; auto = false; save(); renderAll();
  });
  ['riskDollars', 'targetR', 'goalDollars'].forEach(id => $(id).addEventListener('input', renderAll));
  window.addEventListener('resize', () => page === 1 && drawChart());
}
function boot() {
  const savedId = localStorage.getItem('sani.comet.appId');
  if (savedId) $('cometAppId').value = savedId;
  const tok = sessionStorage.getItem('sani.comet.token');
  if (tok) $('cometToken').value = tok;
  bind();
  switchPage(0);
  renderAll();
  setFeedStatus('OFFLINE');
  const sel = $('cometAccount');
  if (sel?.value) setAccountStatus('DEMO READY', true);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
