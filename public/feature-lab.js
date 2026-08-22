import { StatefulBosStrategy } from './core/bos.mjs';
import { SaniEngine } from './core/engine.mjs';

const ACTUAL_KEY = 'sani.featureLab.actual.v3';
const RESEARCH_KEY = 'sani.featureLab.research.v3';
const MAX_RECORDS = 5000;

const load = key => {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
};
const save = (key, rows) => {
  try { localStorage.setItem(key, JSON.stringify(rows.slice(-MAX_RECORDS))); } catch {}
};

const actualRecords = load(ACTUAL_KEY);
const researchRecords = load(RESEARCH_KEY);
const pendingFeatures = new Map();
const pendingResearch = new Map();
let researchSeq = 0;

const avg = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const finite = v => Number.isFinite(Number(v));
const resultFor = (direction, start, end) => direction === 'PUT' ? Number(end) < Number(start) : Number(end) > Number(start);

function setupFeatures(strategy, direction, tick, level) {
  const quotes = strategy.ticks.map(t => Number(t.quote)).filter(Number.isFinite);
  const moves = quotes.slice(1).map((q, i) => q - quotes[i]);
  const absMoves = moves.map(Math.abs);
  const avgAbs3 = avg(absMoves.slice(-3));
  const avgAbs5 = avg(absMoves.slice(-5));
  const avgAbs10 = avg(absMoves.slice(-10));
  const qNow = Number(tick.quote);
  const q3 = quotes.length >= 4 ? quotes.at(-4) : qNow;
  const q5 = quotes.length >= 6 ? quotes.at(-6) : qNow;
  const momentum3 = qNow - q3;
  const momentum5 = qNow - q5;
  const aligned3 = direction === 'CALL' ? momentum3 > 0 : momentum3 < 0;
  const aligned5 = direction === 'CALL' ? momentum5 > 0 : momentum5 < 0;
  const structure = direction === 'CALL' ? strategy.bull : strategy.bear;
  const high = Number(structure.high);
  const low = Number(structure.low);
  const range = Math.abs(high - low);
  const retracePoint = direction === 'CALL' ? Number(structure.hl) : Number(structure.lh);
  const pullbackDepth = range > 0
    ? (direction === 'CALL' ? (high - retracePoint) / range : (retracePoint - low) / range)
    : undefined;
  const breakoutDistance = Math.abs(qNow - Number(level));
  let streak = 0;
  for (let i = moves.length - 1; i >= 0; i -= 1) {
    const aligned = direction === 'CALL' ? moves[i] > 0 : moves[i] < 0;
    if (!aligned) break;
    streak += 1;
  }
  return {
    breakoutDistance,
    breakoutStrength: avgAbs5 > 0 ? breakoutDistance / avgAbs5 : undefined,
    pullbackDepth,
    momentum3,
    momentum5,
    aligned3,
    aligned5,
    avgAbs3,
    avgAbs5,
    avgAbs10,
    volatilityRatio: avgAbs10 > 0 ? avgAbs3 / avgAbs10 : undefined,
    structureRange: range,
    structureRangeX: avgAbs10 > 0 ? range / avgAbs10 : undefined,
    directionStreak: streak
  };
}

function registerResearch(signal, strategy) {
  if (!signal?.features) return;
  const id = `${signal.id || signal.direction + '-' + signal.epoch}-${++researchSeq}`;
  pendingResearch.set(id, {
    id,
    direction: signal.direction,
    signalEpoch: Number(signal.epoch),
    signalQuote: Number(signal.quote),
    symbol: strategy?.config?.symbol || 'unknown',
    features: { ...signal.features },
    quotes: [Number(signal.quote)],
    windows: {}
  });
}

function advanceResearch(tick) {
  const quote = Number(tick?.quote);
  if (!Number.isFinite(quote)) return;
  for (const [id, item] of [...pendingResearch.entries()]) {
    const offset = item.quotes.length;
    if (offset < 1 || offset > 4) continue;
    const previous = item.quotes.at(-1);
    item.quotes.push(quote);
    const label = `T+${offset - 1}→${offset}`;
    item.windows[label] = resultFor(item.direction, previous, quote) ? 'won' : 'lost';
    if (offset === 4) {
      researchRecords.push({
        id: item.id,
        direction: item.direction,
        signalEpoch: item.signalEpoch,
        signalQuote: item.signalQuote,
        symbol: item.symbol,
        ...item.features,
        windows: { ...item.windows }
      });
      if (researchRecords.length > MAX_RECORDS) researchRecords.splice(0, researchRecords.length - MAX_RECORDS);
      pendingResearch.delete(id);
      save(RESEARCH_KEY, researchRecords);
      renderFeatureLab();
    }
  }
}

const originalSignal = StatefulBosStrategy.prototype.signal;
StatefulBosStrategy.prototype.signal = function patchedSignal(direction, tick, level, structure) {
  const signal = originalSignal.call(this, direction, tick, level, structure);
  signal.features = setupFeatures(this, direction, tick, level);
  registerResearch(signal, this);
  return signal;
};

const originalOnTick = SaniEngine.prototype.onTick;
SaniEngine.prototype.onTick = function patchedOnTick(tick) {
  advanceResearch(tick);
  return originalOnTick.call(this, tick);
};

const originalOnBuy = SaniEngine.prototype.onBuy;
SaniEngine.prototype.onBuy = function patchedOnBuy(message) {
  const p = this.pending?.get?.(Number(message.req_id));
  const features = p?.signal?.features ? { ...p.signal.features } : undefined;
  const direction = p?.signal?.direction;
  const signalEpoch = Number(p?.signal?.epoch);
  originalOnBuy.call(this, message);
  const id = Number(message?.buy?.contract_id);
  if (Number.isFinite(id) && features) pendingFeatures.set(id, { features, direction, signalEpoch });
};

function executionWindow(signalEpoch, source) {
  const entry = Number(source?.entryTickTime ?? source?.entry_tick_time);
  const exit = Number(source?.exitTickTime ?? source?.exit_tick_time);
  if (![signalEpoch, entry, exit].every(Number.isFinite)) return 'unknown';
  const from = Math.round(entry - signalEpoch);
  const to = Math.round(exit - signalEpoch);
  return `T+${from}→${to}`;
}

const originalOnContract = SaniEngine.prototype.onContract;
SaniEngine.prototype.onContract = function patchedOnContract(contract) {
  const id = Number(contract?.contract_id);
  const settling = Boolean(contract?.is_sold || contract?.is_expired);
  originalOnContract.call(this, contract);
  if (!settling || !Number.isFinite(id)) return;
  const meta = pendingFeatures.get(id);
  if (!meta) return;
  const settledTrade = this.trades?.find?.(t => Number(t.contractId) === id);
  const profit = Number(settledTrade?.profit ?? contract?.profit ?? 0);
  actualRecords.push({
    contractId: id,
    direction: meta.direction,
    won: profit > 0,
    profit,
    executionWindow: executionWindow(meta.signalEpoch, settledTrade || contract),
    ...meta.features
  });
  if (actualRecords.length > MAX_RECORDS) actualRecords.splice(0, actualRecords.length - MAX_RECORDS);
  pendingFeatures.delete(id);
  save(ACTUAL_KEY, actualRecords);
  renderFeatureLab();
};

const originalReset = SaniEngine.prototype.resetSession;
SaniEngine.prototype.resetSession = function patchedResetSession(...args) {
  const result = originalReset.apply(this, args);
  pendingFeatures.clear();
  pendingResearch.clear();
  renderFeatureLab();
  return result;
};

function breakoutBucket(v) {
  if (!finite(v)) return 'unknown';
  if (v < 0.5) return '<0.5×';
  if (v < 1) return '0.5–1×';
  if (v < 2) return '1–2×';
  return '≥2×';
}
function pullbackBucket(v) {
  if (!finite(v)) return 'unknown';
  if (v < 0.25) return '<25%';
  if (v < 0.5) return '25–50%';
  if (v < 0.75) return '50–75%';
  return '≥75%';
}
function volatilityBucket(v) {
  if (!finite(v)) return 'unknown';
  if (v < 0.75) return 'compressed';
  if (v <= 1.25) return 'normal';
  return 'expanded';
}
function rangeBucket(v) {
  if (!finite(v)) return 'unknown';
  if (v < 3) return '<3×';
  if (v < 6) return '3–6×';
  return '≥6×';
}
function streakBucket(v) {
  if (!finite(v)) return 'unknown';
  if (v <= 0) return '0';
  if (v === 1) return '1';
  if (v === 2) return '2';
  return '3+';
}

const dimensions = [
  ['Breakout strength', r => `${breakoutBucket(r.breakoutStrength)} avg move`],
  ['Pullback depth', r => pullbackBucket(r.pullbackDepth)],
  ['5-tick momentum', r => r.aligned5 ? 'aligned' : 'against'],
  ['Local volatility', r => volatilityBucket(r.volatilityRatio)],
  ['Structure size', r => `${rangeBucket(r.structureRangeX)} avg move`],
  ['Direction streak', r => streakBucket(r.directionStreak)]
];

const combinations = [
  ['Breakout + structure', r => `${breakoutBucket(r.breakoutStrength)} breakout · ${rangeBucket(r.structureRangeX)} structure`],
  ['Breakout + pullback', r => `${breakoutBucket(r.breakoutStrength)} breakout · ${pullbackBucket(r.pullbackDepth)} pullback`],
  ['Volatility + momentum', r => `${volatilityBucket(r.volatilityRatio)} · ${r.aligned5 ? 'momentum aligned' : 'momentum against'}`],
  ['Volatility + breakout', r => `${volatilityBucket(r.volatilityRatio)} · ${breakoutBucket(r.breakoutStrength)} breakout`]
];

function bucketStats(rows, resultKey = 'won') {
  const n = rows.length;
  const wins = rows.filter(r => Boolean(r[resultKey])).length;
  const losses = n - wins;
  const pnl = rows.reduce((s, r) => s + Number(r.profit || 0), 0);
  return { n, wins, losses, wr: n ? wins / n * 100 : 0, avgPnl: n ? pnl / n : 0 };
}

function actualSummaryRows() {
  const out = [];
  for (const [feature, bucketFn] of dimensions) {
    const groups = new Map();
    for (const r of actualRecords) {
      const bucket = bucketFn(r);
      if (!groups.has(bucket)) groups.set(bucket, []);
      groups.get(bucket).push(r);
    }
    for (const [bucket, rows] of groups) out.push({ feature, bucket, ...bucketStats(rows) });
  }
  const windows = new Map();
  for (const r of actualRecords) {
    const bucket = r.executionWindow || 'unknown';
    if (!windows.has(bucket)) windows.set(bucket, []);
    windows.get(bucket).push(r);
  }
  for (const [bucket, rows] of windows) out.push({ feature: 'Actual execution window', bucket, ...bucketStats(rows) });
  return out;
}

function shadowWindowRows() {
  const labels = ['T+0→1', 'T+1→2', 'T+2→3', 'T+3→4'];
  return labels.map(label => {
    const rows = researchRecords.filter(r => r.windows?.[label]);
    const wins = rows.filter(r => r.windows[label] === 'won').length;
    const losses = rows.length - wins;
    return { label, n: rows.length, wins, losses, wr: rows.length ? wins / rows.length * 100 : 0 };
  });
}

function researchFeatureRows(windowLabel = 'T+1→2') {
  const out = [];
  for (const [feature, bucketFn] of dimensions) {
    const groups = new Map();
    for (const r of researchRecords) {
      if (!r.windows?.[windowLabel]) continue;
      const bucket = bucketFn(r);
      if (!groups.has(bucket)) groups.set(bucket, []);
      groups.get(bucket).push(r);
    }
    for (const [bucket, rows] of groups) {
      const wins = rows.filter(r => r.windows[windowLabel] === 'won').length;
      out.push({ feature, bucket, window: windowLabel, n: rows.length, wins, losses: rows.length - wins, wr: rows.length ? wins / rows.length * 100 : 0 });
    }
  }
  return out;
}

function researchCombinationRows() {
  const labels = ['T+0→1', 'T+1→2', 'T+2→3', 'T+3→4'];
  const out = [];
  for (const [combo, bucketFn] of combinations) {
    for (const label of labels) {
      const groups = new Map();
      for (const r of researchRecords) {
        if (!r.windows?.[label]) continue;
        const bucket = bucketFn(r);
        if (!groups.has(bucket)) groups.set(bucket, []);
        groups.get(bucket).push(r);
      }
      for (const [bucket, rows] of groups) {
        if (rows.length < 5) continue;
        const wins = rows.filter(r => r.windows[label] === 'won').length;
        out.push({ combo, bucket, window: label, n: rows.length, wins, losses: rows.length - wins, wr: rows.length ? wins / rows.length * 100 : 0 });
      }
    }
  }
  return out.sort((a, b) => b.n - a.n || b.wr - a.wr).slice(0, 32);
}

function ensureCard() {
  let card = document.getElementById('featureLabCard');
  if (card) return card;
  const journal = document.querySelector('.logCard');
  if (!journal) return null;
  card = document.createElement('section');
  card.id = 'featureLabCard';
  card.className = 'card';
  card.innerHTML = `
    <div class="sectionTitle"><span>Feature Lab v3</span><small>persistent actual validation · no filtering</small></div>
    <div id="featureLabSummary" class="muted">Waiting for settled trades…</div>
    <div class="tableWrap"><table>
      <thead><tr><th>Feature</th><th>Bucket</th><th>N</th><th>W/L</th><th>WR</th><th>Avg P/L</th></tr></thead>
      <tbody id="featureLabRows"><tr><td colspan="6" class="empty">No settled trades yet.</td></tr></tbody>
    </table></div>

    <div class="sectionTitle"><span>Persistent Research Lab</span><small>every BOS · shadow only · survives Reset</small></div>
    <div id="researchSummary" class="muted">Waiting for four post-BOS ticks…</div>
    <div class="tableWrap"><table>
      <thead><tr><th>Window</th><th>N</th><th>W/L</th><th>WR</th></tr></thead>
      <tbody id="researchWindowRows"><tr><td colspan="4" class="empty">No shadow research yet.</td></tr></tbody>
    </table></div>

    <div class="sectionTitle"><span>T+1→2 Feature Research</span><small>the execution-matched shadow window</small></div>
    <div class="tableWrap"><table>
      <thead><tr><th>Feature</th><th>Bucket</th><th>N</th><th>W/L</th><th>WR</th></tr></thead>
      <tbody id="researchFeatureRows"><tr><td colspan="5" class="empty">No research buckets yet.</td></tr></tbody>
    </table></div>

    <div class="sectionTitle"><span>Combination Lab v2</span><small>setup combinations × all four shadow windows</small></div>
    <div class="tableWrap"><table>
      <thead><tr><th>Combination</th><th>Setup bucket</th><th>Window</th><th>N</th><th>W/L</th><th>WR</th></tr></thead>
      <tbody id="combinationLabRows"><tr><td colspan="6" class="empty">Waiting for combinations…</td></tr></tbody>
    </table></div>
    <div class="actions compact"><button id="clearResearchBtn" type="button">Clear research history</button></div>
    <p class="muted">Actual and shadow histories now persist across Reset Session and refresh. N&lt;20 is exploratory. The lab never blocks or approves a trade.</p>`;
  journal.parentElement?.insertBefore(card, journal);
  card.querySelector('#clearResearchBtn')?.addEventListener('click', () => {
    if (!confirm('Clear all persistent Feature Lab and Research Lab history?')) return;
    actualRecords.length = 0;
    researchRecords.length = 0;
    pendingFeatures.clear();
    pendingResearch.clear();
    localStorage.removeItem(ACTUAL_KEY);
    localStorage.removeItem(RESEARCH_KEY);
    renderFeatureLab();
  });
  return card;
}

function esc(v) {
  return String(v).replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
}
function wrClass(n, wr) {
  if (n < 20) return '';
  if (wr >= 56) return 'positive';
  if (wr < 52) return 'negative';
  return '';
}

function renderFeatureLab() {
  if (!document.body) return;
  const card = ensureCard();
  if (!card) return;

  const actual = bucketStats(actualRecords);
  const totalPnl = actualRecords.reduce((s, r) => s + Number(r.profit || 0), 0);
  card.querySelector('#featureLabSummary').innerHTML = actualRecords.length
    ? `<b>${actual.n} persistent actual trades</b> · ${actual.wins}W ${actual.losses}L · WR ${actual.wr.toFixed(1)}% · P/L ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}`
    : 'Waiting for settled trades…';

  const actualRows = actualSummaryRows().sort((a, b) => a.feature !== b.feature ? a.feature.localeCompare(b.feature) : b.n - a.n || b.wr - a.wr);
  card.querySelector('#featureLabRows').innerHTML = actualRows.length
    ? actualRows.map(r => `<tr><td>${esc(r.feature)}</td><td>${esc(r.bucket)}</td><td>${r.n}${r.n >= 20 ? ' ✓' : ''}</td><td>${r.wins}/${r.losses}</td><td class="${wrClass(r.n, r.wr)}">${r.wr.toFixed(1)}%</td><td class="${r.avgPnl >= 0 ? 'positive' : 'negative'}">${r.avgPnl >= 0 ? '+' : ''}${r.avgPnl.toFixed(3)}</td></tr>`).join('')
    : '<tr><td colspan="6" class="empty">No settled trades yet.</td></tr>';

  card.querySelector('#researchSummary').innerHTML = researchRecords.length
    ? `<b>${researchRecords.length} persistent BOS setups fully scored</b> · ${pendingResearch.size} currently waiting for post-BOS ticks`
    : `${pendingResearch.size ? pendingResearch.size + ' BOS setup(s) waiting for post-BOS ticks…' : 'Waiting for BOS signals…'}`;

  const windowRows = shadowWindowRows();
  card.querySelector('#researchWindowRows').innerHTML = windowRows.some(r => r.n)
    ? windowRows.map(r => `<tr><td>${esc(r.label)}</td><td>${r.n}${r.n >= 50 ? ' ✓' : ''}</td><td>${r.wins}/${r.losses}</td><td class="${wrClass(r.n, r.wr)}">${r.n ? r.wr.toFixed(1) + '%' : '—'}</td></tr>`).join('')
    : '<tr><td colspan="4" class="empty">No completed shadow setups yet.</td></tr>';

  const featureRows = researchFeatureRows().sort((a, b) => a.feature !== b.feature ? a.feature.localeCompare(b.feature) : b.n - a.n || b.wr - a.wr);
  card.querySelector('#researchFeatureRows').innerHTML = featureRows.length
    ? featureRows.map(r => `<tr><td>${esc(r.feature)}</td><td>${esc(r.bucket)}</td><td>${r.n}${r.n >= 20 ? ' ✓' : ''}</td><td>${r.wins}/${r.losses}</td><td class="${wrClass(r.n, r.wr)}">${r.wr.toFixed(1)}%</td></tr>`).join('')
    : '<tr><td colspan="5" class="empty">No T+1→2 feature research yet.</td></tr>';

  const combos = researchCombinationRows();
  card.querySelector('#combinationLabRows').innerHTML = combos.length
    ? combos.map(r => `<tr><td>${esc(r.combo)}</td><td>${esc(r.bucket)}</td><td>${esc(r.window)}</td><td>${r.n}${r.n >= 20 ? ' ✓' : ''}</td><td>${r.wins}/${r.losses}</td><td class="${wrClass(r.n, r.wr)}">${r.wr.toFixed(1)}%</td></tr>`).join('')
    : '<tr><td colspan="6" class="empty">Waiting for at least 5 matching shadow setups per combination.</td></tr>';
}

window.addEventListener('DOMContentLoaded', renderFeatureLab);
