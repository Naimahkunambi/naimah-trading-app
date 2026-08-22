import { StatefulBosStrategy } from './core/bos.mjs';
import { SaniEngine } from './core/engine.mjs';

const records = [];
const pendingFeatures = new Map();
const avg = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const finite = v => Number.isFinite(Number(v));

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

const originalSignal = StatefulBosStrategy.prototype.signal;
StatefulBosStrategy.prototype.signal = function patchedSignal(direction, tick, level, structure) {
  const signal = originalSignal.call(this, direction, tick, level, structure);
  signal.features = setupFeatures(this, direction, tick, level);
  return signal;
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

function executionWindow(signalEpoch, contract) {
  const entry = Number(contract?.entry_tick_time);
  const exit = Number(contract?.exit_tick_time);
  if (![signalEpoch, entry, exit].every(Number.isFinite)) return 'unknown';
  const from = Math.round(entry - signalEpoch);
  const to = Math.round(exit - signalEpoch);
  if (Math.abs((entry - signalEpoch) - from) > 0.01 || Math.abs((exit - signalEpoch) - to) > 0.01) return 'irregular';
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
  const profit = Number(contract?.profit || 0);
  records.push({
    contractId: id,
    direction: meta.direction,
    won: profit > 0,
    profit,
    executionWindow: executionWindow(meta.signalEpoch, contract),
    ...meta.features
  });
  pendingFeatures.delete(id);
  renderFeatureLab();
};

const originalReset = SaniEngine.prototype.resetSession;
SaniEngine.prototype.resetSession = function patchedResetSession(...args) {
  const result = originalReset.apply(this, args);
  records.length = 0;
  pendingFeatures.clear();
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
  ['Direction streak', r => streakBucket(r.directionStreak)],
  ['Execution window', r => r.executionWindow || 'unknown']
];

const combinations = [
  ['Breakout + structure', r => `${breakoutBucket(r.breakoutStrength)} breakout · ${rangeBucket(r.structureRangeX)} structure`],
  ['Breakout + pullback', r => `${breakoutBucket(r.breakoutStrength)} breakout · ${pullbackBucket(r.pullbackDepth)} pullback`],
  ['Volatility + momentum', r => `${volatilityBucket(r.volatilityRatio)} · ${r.aligned5 ? 'momentum aligned' : 'momentum against'}`],
  ['Volatility + breakout', r => `${volatilityBucket(r.volatilityRatio)} · ${breakoutBucket(r.breakoutStrength)} breakout`]
];

function bucketStats(rows) {
  const n = rows.length;
  const wins = rows.filter(r => r.won).length;
  const losses = n - wins;
  const pnl = rows.reduce((s, r) => s + Number(r.profit || 0), 0);
  return { n, wins, losses, wr: n ? wins / n * 100 : 0, avgPnl: n ? pnl / n : 0 };
}

function summaryRows() {
  const out = [];
  for (const [feature, bucketFn] of dimensions) {
    const groups = new Map();
    for (const r of records) {
      const bucket = bucketFn(r);
      if (!groups.has(bucket)) groups.set(bucket, []);
      groups.get(bucket).push(r);
    }
    for (const [bucket, rows] of groups) out.push({ feature, bucket, ...bucketStats(rows) });
  }
  return out;
}

function combinationRows() {
  const out = [];
  for (const [combo, bucketFn] of combinations) {
    const groups = new Map();
    for (const r of records) {
      const bucket = bucketFn(r);
      const window = r.executionWindow || 'unknown';
      const key = `${bucket}|||${window}`;
      if (!groups.has(key)) groups.set(key, { bucket, window, rows: [] });
      groups.get(key).rows.push(r);
    }
    for (const { bucket, window, rows } of groups.values()) {
      if (rows.length < 3) continue;
      out.push({ combo, bucket, window, ...bucketStats(rows) });
    }
  }
  return out.sort((a, b) => b.n - a.n || b.wr - a.wr).slice(0, 24);
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
    <div class="sectionTitle"><span>Feature Lab v2</span><small>observation only · does not filter trades</small></div>
    <div id="featureLabSummary" class="muted">Waiting for settled trades…</div>
    <div class="tableWrap"><table>
      <thead><tr><th>Feature</th><th>Bucket</th><th>N</th><th>W/L</th><th>WR</th><th>Avg P/L</th></tr></thead>
      <tbody id="featureLabRows"><tr><td colspan="6" class="empty">No settled trades yet.</td></tr></tbody>
    </table></div>
    <div class="sectionTitle"><span>Combination Lab</span><small>setup combinations × actual execution window</small></div>
    <div class="tableWrap"><table>
      <thead><tr><th>Combination</th><th>Setup bucket</th><th>Window</th><th>N</th><th>W/L</th><th>WR</th><th>Avg P/L</th></tr></thead>
      <tbody id="combinationLabRows"><tr><td colspan="7" class="empty">Waiting for combinations…</td></tr></tbody>
    </table></div>
    <p class="muted">No filtering is applied. Treat N&lt;20 as exploratory only. Combination rows appear after at least 3 matching settled trades.</p>`;
  journal.parentElement?.insertBefore(card, journal);
  return card;
}

function esc(v) {
  return String(v).replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
}

function wrClass(r) {
  if (r.n < 20) return '';
  if (r.wr >= 56) return 'positive';
  if (r.wr < 52) return 'negative';
  return '';
}

function renderFeatureLab() {
  if (!document.body) return;
  const card = ensureCard();
  if (!card) return;
  const summary = card.querySelector('#featureLabSummary');
  const body = card.querySelector('#featureLabRows');
  const comboBody = card.querySelector('#combinationLabRows');
  const all = bucketStats(records);
  const totalPnl = records.reduce((s, r) => s + r.profit, 0);
  summary.innerHTML = records.length
    ? `<b>${all.n} settled trades</b> · ${all.wins}W ${all.losses}L · WR ${all.wr.toFixed(1)}% · P/L ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}`
    : 'Waiting for settled trades…';

  const rows = summaryRows().sort((a, b) =>
    a.feature !== b.feature ? a.feature.localeCompare(b.feature) : b.n - a.n || b.wr - a.wr
  );
  body.innerHTML = rows.length
    ? rows.map(r => `<tr>
        <td>${esc(r.feature)}</td><td>${esc(r.bucket)}</td>
        <td>${r.n}${r.n >= 20 ? ' ✓' : ''}</td><td>${r.wins}/${r.losses}</td>
        <td class="${wrClass(r)}">${r.wr.toFixed(1)}%</td>
        <td class="${r.avgPnl >= 0 ? 'positive' : 'negative'}">${r.avgPnl >= 0 ? '+' : ''}${r.avgPnl.toFixed(3)}</td>
      </tr>`).join('')
    : '<tr><td colspan="6" class="empty">No settled trades yet.</td></tr>';

  const combos = combinationRows();
  comboBody.innerHTML = combos.length
    ? combos.map(r => `<tr>
        <td>${esc(r.combo)}</td><td>${esc(r.bucket)}</td><td>${esc(r.window)}</td>
        <td>${r.n}${r.n >= 20 ? ' ✓' : ''}</td><td>${r.wins}/${r.losses}</td>
        <td class="${wrClass(r)}">${r.wr.toFixed(1)}%</td>
        <td class="${r.avgPnl >= 0 ? 'positive' : 'negative'}">${r.avgPnl >= 0 ? '+' : ''}${r.avgPnl.toFixed(3)}</td>
      </tr>`).join('')
    : '<tr><td colspan="7" class="empty">Waiting for at least 3 matching trades per combination.</td></tr>';
}

window.addEventListener('DOMContentLoaded', renderFeatureLab);
