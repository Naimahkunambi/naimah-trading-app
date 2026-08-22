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
  const pullbackDepth = range > 0 ? (direction === 'CALL' ? (high - retracePoint) / range : (retracePoint - low) / range) : undefined;
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
  originalOnBuy.call(this, message);
  const id = Number(message?.buy?.contract_id);
  if (Number.isFinite(id) && features) pendingFeatures.set(id, { features, direction });
};

const originalOnContract = SaniEngine.prototype.onContract;
SaniEngine.prototype.onContract = function patchedOnContract(contract) {
  const id = Number(contract?.contract_id);
  const settling = Boolean(contract?.is_sold || contract?.is_expired);
  originalOnContract.call(this, contract);
  if (!settling || !Number.isFinite(id)) return;
  const meta = pendingFeatures.get(id);
  if (!meta) return;
  const profit = Number(contract?.profit || 0);
  records.push({ contractId: id, direction: meta.direction, won: profit > 0, profit, ...meta.features });
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

function breakoutBucket(v) { if (!finite(v)) return 'unknown'; if (v < 0.5) return '<0.5× avg move'; if (v < 1) return '0.5–1× avg move'; if (v < 2) return '1–2× avg move'; return '≥2× avg move'; }
function pullbackBucket(v) { if (!finite(v)) return 'unknown'; if (v < 0.25) return '<25% shallow'; if (v < 0.5) return '25–50%'; if (v < 0.75) return '50–75%'; return '≥75% deep'; }
function volatilityBucket(v) { if (!finite(v)) return 'unknown'; if (v < 0.75) return 'compressed'; if (v <= 1.25) return 'normal'; return 'expanded'; }
function rangeBucket(v) { if (!finite(v)) return 'unknown'; if (v < 3) return '<3× avg move'; if (v < 6) return '3–6× avg move'; return '≥6× avg move'; }
function streakBucket(v) { if (!finite(v)) return 'unknown'; if (v <= 0) return '0'; if (v === 1) return '1'; if (v === 2) return '2'; return '3+'; }

const dimensions = [
  ['Breakout strength', r => breakoutBucket(r.breakoutStrength)],
  ['Pullback depth', r => pullbackBucket(r.pullbackDepth)],
  ['5-tick momentum', r => r.aligned5 ? 'aligned' : 'against'],
  ['Local volatility', r => volatilityBucket(r.volatilityRatio)],
  ['Structure size', r => rangeBucket(r.structureRangeX)],
  ['Direction streak', r => streakBucket(r.directionStreak)]
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
function ensureCard() {
  let card = document.getElementById('featureLabCard');
  if (card) return card;
  const journal = document.querySelector('.logCard');
  if (!journal) return null;
  card = document.createElement('section');
  card.id = 'featureLabCard';
  card.className = 'card';
  card.innerHTML = `<div class="sectionTitle"><span>Feature Lab</span><small>observation only · does not filter trades</small></div><div id="featureLabSummary" class="muted">Waiting for settled trades…</div><div class="tableWrap"><table><thead><tr><th>Feature</th><th>Bucket</th><th>N</th><th>W/L</th><th>WR</th><th>Avg P/L</th></tr></thead><tbody id="featureLabRows"><tr><td colspan="6" class="empty">No settled trades yet.</td></tr></tbody></table></div><p class="muted">Use this to discover which BOS setups deserve a future filter. Prefer buckets with at least 20 trades before trusting the percentage.</p>`;
  journal.parentElement?.insertBefore(card, journal);
  return card;
}
function esc(v) { return String(v).replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c])); }
function renderFeatureLab() {
  if (!document.body) return;
  const card = ensureCard();
  if (!card) return;
  const summary = card.querySelector('#featureLabSummary');
  const body = card.querySelector('#featureLabRows');
  const all = bucketStats(records);
  const totalPnl = records.reduce((s, r) => s + r.profit, 0);
  summary.innerHTML = records.length ? `<b>${all.n} settled trades</b> · ${all.wins}W ${all.losses}L · WR ${all.wr.toFixed(1)}% · P/L ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}` : 'Waiting for settled trades…';
  const rows = summaryRows().sort((a, b) => a.feature !== b.feature ? a.feature.localeCompare(b.feature) : b.n - a.n || b.wr - a.wr);
  body.innerHTML = rows.length ? rows.map(r => { const reliable = r.n >= 20; const wrClass = reliable && r.wr >= 56 ? 'positive' : reliable && r.wr < 52 ? 'negative' : ''; return `<tr><td>${esc(r.feature)}</td><td>${esc(r.bucket)}</td><td>${r.n}${reliable ? ' ✓' : ''}</td><td>${r.wins}/${r.losses}</td><td class="${wrClass}">${r.wr.toFixed(1)}%</td><td class="${r.avgPnl >= 0 ? 'positive' : 'negative'}">${r.avgPnl >= 0 ? '+' : ''}${r.avgPnl.toFixed(3)}</td></tr>`; }).join('') : '<tr><td colspan="6" class="empty">No settled trades yet.</td></tr>';
}
window.addEventListener('DOMContentLoaded', renderFeatureLab);
