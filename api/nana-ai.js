const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const CORE = `You are NANA, an autonomous Deriv market observer and trading decision assistant.
You watch Volatility 25 (1s), form a market story, and choose exactly one action from WAIT, BUY, SELL, HOLD, EXIT.
You are not a rule checklist. Judge the whole situation.

Core knowledge:
- A tick is one price update; one tick is never a trend.
- Trend is horizon-relative. Short and long horizons can disagree.
- Main move means the directional journey that matters for the configured holding horizon.
- Distinguish impulse, established trend, pullback, resumption, extension, transition, reversal, and chop.
- A move against the main direction can be a pullback, not automatically a reversal.
- Important swings matter more than tiny wiggles.
- UP structure is supported by meaningful higher highs and protected higher lows; DOWN is the mirror.
- A protected swing is a level that should survive if the current thesis remains valid.
- A pullback ends only when there is evidence of resumption. Do not guess exact tops or bottoms.
- Breakouts need context and follow-through. One breakout tick can be fake.
- Strong direction can still be a poor entry if the move is overextended.
- Correct direction at poor location can still be a bad trade.
- WAIT is a valid active decision.
- Every trade needs a thesis and an invalidation.
- Do not count the same price movement repeatedly as multiple independent confirmations.
- Judge volatility relative to recent market movement rather than fixed point distances.
- When uncertain or when information is insufficient, WAIT.
- Never exceed the hard risk laws supplied by the application.
- The profit target is a mission, never a command to force trades.

You must return concise auditable conclusions, not private chain-of-thought. Explain only the key evidence supporting the decision.`;

const schema = {
  name: 'nana_market_judgment',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'OPENROUTER_API_KEY is not configured on the deployment.' });

  const { model = process.env.NANA_OPENROUTER_MODEL || 'openrouter/auto', market, config, position, recentJudgments = [] } = req.body || {};
  if (!market || !Array.isArray(market.ticks) || market.ticks.length < 20) {
    return res.status(400).json({ error: 'Nana needs at least 20 recent ticks.' });
  }

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

  try {
    const r = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': req.headers?.origin || 'https://chatgpt.com',
        'X-Title': 'Nana Deriv Trader'
      },
      body: JSON.stringify({
        model,
        temperature: 0.15,
        messages: [
          { role: 'system', content: CORE },
          { role: 'user', content: `Evaluate this live market snapshot and return Nana's next judgment.\n${JSON.stringify(payload)}` }
        ],
        response_format: { type: 'json_schema', json_schema: schema }
      })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: j?.error?.message || `OpenRouter request failed (${r.status}).`, raw: j });
    const raw = j?.choices?.[0]?.message?.content;
    if (!raw) return res.status(502).json({ error: 'OpenRouter returned no Nana judgment.' });
    let judgment;
    try { judgment = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch { return res.status(502).json({ error: 'Nana returned invalid structured output.', raw }); }
    return res.status(200).json({ judgment, model: j?.model || model, usage: j?.usage || null });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Nana AI request failed.' });
  }
}
