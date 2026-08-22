import { directionResult, matchTraceToTrade } from './core/window-match-core.mjs';

const NativeWebSocket = globalThis.WebSocket;
const tracesByReq = new Map();
const tracesByContract = new Map();
const completed = new Map();
const recentTicks = [];
let tickSeq = 0;
let lastProposalTrace;

function currentTick() { return recentTicks.at(-1); }

function makeTrace(direction, reqId) {
  const t0 = currentTick();
  if (!t0) return undefined;
  return {
    reqId: Number(reqId),
    direction,
    signalEpoch: Number(t0.epoch),
    signalQuote: Number(t0.quote),
    signalSeq: t0.seq,
    ticks: [{ offset: 0, ...t0 }],
    windows: []
  };
}

function advanceTrace(trace, tick) {
  const offset = tick.seq - trace.signalSeq;
  if (offset < 1 || offset > 4) return;
  if (!trace.ticks.some(x => x.offset === offset)) trace.ticks.push({ offset, ...tick });
  const prev = trace.ticks.find(x => x.offset === offset - 1);
  if (!prev) return;
  const label = `${offset - 1}→${offset}`;
  if (trace.windows.some(w => w.label === label)) return;
  trace.windows.push({
    label,
    from: offset - 1,
    to: offset,
    startEpoch: Number(prev.epoch),
    endEpoch: Number(tick.epoch),
    startQuote: Number(prev.quote),
    endQuote: Number(tick.quote),
    result: directionResult(trace.direction, prev.quote, tick.quote)
  });
}

function onTick(tick) {
  tickSeq += 1;
  const row = { seq: tickSeq, epoch: Number(tick.epoch), quote: Number(tick.quote) };
  recentTicks.push(row);
  if (recentTicks.length > 32) recentTicks.shift();
  for (const trace of tracesByReq.values()) advanceTrace(trace, row);
  for (const trace of tracesByContract.values()) advanceTrace(trace, row);
}

function settle(contract) {
  const id = Number(contract.contract_id);
  const trace = tracesByContract.get(id);
  if (!trace || (!contract.is_sold && !contract.is_expired)) return;
  const trade = {
    contractId: id,
    profit: Number(contract.profit || 0),
    entrySpot: contract.entry_spot,
    exitSpot: contract.exit_spot,
    entryTickTime: contract.entry_tick_time,
    exitTickTime: contract.exit_tick_time
  };
  const match = matchTraceToTrade(trace, trade);
  completed.set(id, { trace, trade, match });
  tracesByContract.delete(id);
  queueMicrotask(renderMatches);
  setTimeout(renderMatches, 50);
  setTimeout(renderMatches, 300);
}

function inspectIncoming(raw) {
  let m;
  try { m = JSON.parse(String(raw)); } catch { return; }
  if (m.msg_type === 'tick' && m.tick) onTick(m.tick);
  if (m.msg_type === 'buy' && m.buy) {
    const trace = tracesByReq.get(Number(m.req_id)) || lastProposalTrace;
    if (trace) {
      tracesByReq.delete(Number(m.req_id));
      trace.contractId = Number(m.buy.contract_id);
      tracesByContract.set(trace.contractId, trace);
    }
  }
  if (m.msg_type === 'proposal_open_contract' && m.proposal_open_contract) settle(m.proposal_open_contract);
}

function inspectOutgoing(raw) {
  let m;
  try { m = JSON.parse(String(raw)); } catch { return; }
  if (m.proposal && m.contract_type) {
    lastProposalTrace = makeTrace(m.contract_type, m.req_id);
    return;
  }
  if (m.buy === '1' && m.parameters?.contract_type) {
    const trace = makeTrace(m.parameters.contract_type, m.req_id);
    if (trace) tracesByReq.set(Number(m.req_id), trace);
  } else if (m.buy && m.buy !== '1' && lastProposalTrace) {
    lastProposalTrace.reqId = Number(m.req_id);
    tracesByReq.set(Number(m.req_id), lastProposalTrace);
  }
}

if (NativeWebSocket) {
  globalThis.WebSocket = class SaniObservedWebSocket extends NativeWebSocket {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', event => inspectIncoming(event.data));
    }
    send(data) {
      inspectOutgoing(data);
      return super.send(data);
    }
  };
}

function labelFor(match) {
  if (!match) return '<span class="diag-muted">outside trace</span>';
  const agreement = match.agreement ? '✓' : '✕';
  const quality = match.quality === 'exact' ? 'exact' : match.quality === 'outside-lab' ? 'outside lab' : 'nearest';
  const cls = match.agreement ? 'diag-ok' : 'diag-warn';
  return `<span class="${cls}"><b>T+${match.matchedWindow}</b> ${quality} ${agreement}</span>`;
}

function renderMatches() {
  const table = document.querySelector('#tradeRows')?.closest('table');
  if (!table) return;
  const head = table.querySelector('thead tr');
  if (head && !head.querySelector('[data-window-match-head]')) {
    const th = document.createElement('th');
    th.dataset.windowMatchHead = '1';
    th.textContent = 'Window match';
    head.appendChild(th);
  }

  const rows = document.querySelectorAll('#tradeRows tr');
  for (const row of rows) {
    const first = row.querySelector('td');
    if (!first) continue;
    if (first.classList.contains('empty')) {
      first.colSpan = 8;
      continue;
    }
    const id = Number(first.textContent.replace(/\D/g, ''));
    let cell = row.querySelector('[data-window-match]');
    if (!cell) {
      cell = document.createElement('td');
      cell.dataset.windowMatch = '1';
      row.appendChild(cell);
    }
    cell.innerHTML = completed.has(id) ? labelFor(completed.get(id).match) : '<span class="diag-muted">waiting…</span>';
  }

  let note = document.getElementById('windowMatchNote');
  if (!note) {
    note = document.createElement('p');
    note.id = 'windowMatchNote';
    note.className = 'muted';
    note.innerHTML = '<b>Execution Window Match v3:</b> exact = Deriv entry/exit tick times map directly to one Timing Lab window. ✓ means the shadow window and actual contract agree.';
    table.parentElement?.after(note);
  }
}

const observer = new MutationObserver(renderMatches);
window.addEventListener('DOMContentLoaded', () => {
  renderMatches();
  const rows = document.getElementById('tradeRows');
  if (rows) observer.observe(rows, { childList: true, subtree: true });
});
