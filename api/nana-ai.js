import fs from 'node:fs';
import path from 'node:path';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

function loadSchool() {
  try {
    const p = path.join(process.cwd(), 'public', 'nana-knowledge-base.json');
    const rows = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}
const SCHOOL = loadSchool();
const SCHOOL_TEXT = SCHOOL.map(x => `${x.id}. ${x.topic}: ${x.rule}`).join('\n');

const CORE = `You are NANA, an autonomous Deriv market observer and trading decision assistant.
You watch Volatility 25 (1s), form a market story, and choose exactly one action from WAIT, BUY, SELL, HOLD, EXIT.
You are not a rule checklist. Judge the whole situation. You do not need to trade. WAIT is a valid decision.

NANA TRADING SCHOOL:
${SCHOOL_TEXT}

Important operating principles:
- Use the school as market knowledge, not as automatic if/then triggers.
- Do not count the same movement repeatedly under several labels and call it extra confirmation.
- Judge the whole path, location, structure, volatility, open position, and risk laws together.
- A profit target is a mission, not permission to force entries.
- When the evidence is genuinely unclear, WAIT.
- If a position is open, choose HOLD or EXIT unless there is an exceptional reason otherwise. Never recommend adding another position.
- Return concise auditable conclusions, not private chain-of-thought. Explain only the key evidence supporting the decision.`;

const schema = {
  name: 'nana_market_judgment', strict: true,
  schema: {
    type: 'object', additionalProperties: false,
    required: ['action','main_move','phase','confidence','location','thesis','evidence','invalidation','expected_hold_seconds','risk_note'],
    properties: {
      action: { type: 'string', enum: ['WAIT','BUY','SELL','HOLD','EXIT'] },
      main_move: { type: 'string', enum: ['UP','DOWN','NONE','TRANSITION'] },
      phase: { type: 'string', enum: ['IMPULSE','TREND_ESTABLISHED','PULLBACK','RESUMING','EXTENDED','BREAKING','CHOP','TRANSITION','UNKNOWN'] },
      confidence: { type: 'number', minimum: 0, maximum: 100 },
      location: { type: 'string', enum: ['GOOD','ACCEPTABLE','POOR','UNKNOWN'] },
      thesis: { type: 'string', maxLength: 280 },
      evidence: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', maxLength: 180 } },
      invalidation: { type: 'string', maxLength: 220 },
      expected_hold_seconds: { type: 'number', minimum: 0, maximum: 3600 },
      risk_note: { type: 'string', maxLength: 220 }
    }
  }
};

function extractJson(raw) {
  if (raw && typeof raw === 'object') return raw;
  const text = String(raw || '').trim();
  try { return JSON.parse(text); } catch {}
  const match = text.match(/\{[\s\S]*\}/);
  if (match) { try { return JSON.parse(match[0]); } catch {} }
  return null;
}

async function callOpenRouter(apiKey, body, headers) {
  const r = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  return { r, j };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.NANA_OPENROUTER_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'OPENROUTER_API_KEY is not configured on the deployment.' });

  const { model = process.env.NANA_OPENROUTER_MODEL || 'openrouter/auto', market, config, position, recentJudgments = [] } = req.body || {};
  if (!market || !Array.isArray(market.ticks) || market.ticks.length < 20) return res.status(400).json({ error: 'Nana needs at least 20 recent ticks.' });

  const hardLaws = {
    market: config?.market || 'Volatility 25 (1s)',
    maxRiskPerTrade: Number(config?.maxRiskPerTrade ?? 1),
    maxSessionLoss: Number(config?.maxSessionLoss ?? 10),
    profitTarget: Number(config?.profitTarget ?? 160),
    maxOpenTrades: Number(config?.maxOpenTrades ?? 1),
    maxTradeSeconds: Number(config?.maxTradeSeconds ?? 300)
  };

  const payload = {
    hard_laws: hardLaws,
    account_mode: config?.accountMode || 'unknown',
    market_summary: {
      symbol: market.symbol,
      now: market.now,
      last_price: market.lastPrice,
      ticks: market.ticks.slice(-600),
      derived: market.derived || {}
    },
    open_position: position || null,
    recent_judgments: recentJudgments.slice(-6)
  };

  const userMessage = `Evaluate this live market snapshot. Return only Nana's next structured judgment.\n${JSON.stringify(payload)}`;
  const baseBody = { model, temperature: 0.15, messages: [{ role: 'system', content: CORE }, { role: 'user', content: userMessage }] };
  const metaHeaders = { 'HTTP-Referer': req.headers?.origin || 'https://chatgpt.com', 'X-Title': 'Nana Deriv Trader' };

  try {
    let { r, j } = await callOpenRouter(apiKey, { ...baseBody, response_format: { type: 'json_schema', json_schema: schema } }, metaHeaders);
    if (!r.ok && [400, 404, 422].includes(r.status)) {
      ({ r, j } = await callOpenRouter(apiKey, {
        ...baseBody,
        messages: [
          { role: 'system', content: `${CORE}\nReturn one JSON object only. Required keys: action, main_move, phase, confidence, location, thesis, evidence, invalidation, expected_hold_seconds, risk_note.` },
          { role: 'user', content: userMessage }
        ]
      }, metaHeaders));
    }
    if (!r.ok) return res.status(r.status).json({ error: j?.error?.message || `OpenRouter request failed (${r.status}).`, raw: j });
    const raw = j?.choices?.[0]?.message?.content;
    const judgment = extractJson(raw);
    if (!judgment) return res.status(502).json({ error: 'Nana returned an unreadable judgment.', raw });
    return res.status(200).json({ judgment, model: j?.model || model, usage: j?.usage || null, schoolPages: SCHOOL.length });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Nana AI request failed.' });
  }
}
