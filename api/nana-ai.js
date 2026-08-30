import fs from 'node:fs';
import path from 'node:path';

const GROQ_URL='https://api.groq.com/openai/v1/chat/completions';
const GEMINI_BASE='https://generativelanguage.googleapis.com/v1beta/models';

function loadSchool(){try{const p=path.join(process.cwd(),'public','nana-knowledge-base.json');const rows=JSON.parse(fs.readFileSync(p,'utf8'));return Array.isArray(rows)?rows:[]}catch{return[]}}
const SCHOOL=loadSchool();
const SCHOOL_TEXT=SCHOOL.map(x=>`${x.id}. ${x.topic}: ${x.rule}`).join('\n');

const CORE=`You are NANA, an autonomous Deriv Volatility 25 (1s) trading analyst.
You must judge the whole market situation, not blindly follow indicators. WAIT is a valid active decision.

NANA TRADING SCHOOL:
${SCHOOL_TEXT}

Operating principles:
- Trend is horizon-relative. Distinguish impulse, trend, pullback, resumption, extension, transition, reversal and chop.
- A move against the main move can be a pullback rather than a reversal.
- Location matters. Correct direction at a terrible location is still a bad trade.
- Do not count the same price movement multiple times as independent evidence.
- Important swings matter more than tiny wiggles.
- Every trade needs a thesis and invalidation.
- Profit mission never forces a trade.
- If evidence is unclear, WAIT.
- If a position is already open, normally choose HOLD or EXIT, never add another position.
- Return concise auditable conclusions only, never hidden chain-of-thought.`;

const OUTPUT_RULE=`Return ONE JSON object only with these exact keys:
action: WAIT|BUY|SELL|HOLD|EXIT
main_move: UP|DOWN|NONE|TRANSITION
phase: IMPULSE|TREND_ESTABLISHED|PULLBACK|RESUMING|EXTENDED|BREAKING|CHOP|TRANSITION|UNKNOWN
confidence: number 0-100
location: GOOD|ACCEPTABLE|POOR|UNKNOWN
thesis: short string
evidence: array of 1-5 short strings
invalidation: short string
expected_hold_seconds: number 0-3600
risk_note: short string`;

function extractJson(raw){if(raw&&typeof raw==='object')return raw;const text=String(raw||'').trim();try{return JSON.parse(text)}catch{}const m=text.match(/\{[\s\S]*\}/);if(m){try{return JSON.parse(m[0])}catch{}}return null}
function normalize(j={}){const actions=['WAIT','BUY','SELL','HOLD','EXIT'];const moves=['UP','DOWN','NONE','TRANSITION'];const phases=['IMPULSE','TREND_ESTABLISHED','PULLBACK','RESUMING','EXTENDED','BREAKING','CHOP','TRANSITION','UNKNOWN'];const locations=['GOOD','ACCEPTABLE','POOR','UNKNOWN'];return{action:actions.includes(j.action)?j.action:'WAIT',main_move:moves.includes(j.main_move)?j.main_move:'NONE',phase:phases.includes(j.phase)?j.phase:'UNKNOWN',confidence:Math.max(0,Math.min(100,Number(j.confidence)||0)),location:locations.includes(j.location)?j.location:'UNKNOWN',thesis:String(j.thesis||'No clear thesis.').slice(0,280),evidence:(Array.isArray(j.evidence)?j.evidence:['Insufficient evidence.']).slice(0,5).map(x=>String(x).slice(0,180)),invalidation:String(j.invalidation||'Unknown').slice(0,220),expected_hold_seconds:Math.max(0,Math.min(3600,Number(j.expected_hold_seconds)||0)),risk_note:String(j.risk_note||'').slice(0,220)}}

async function callGroq(apiKey,model,payload){const r=await fetch(GROQ_URL,{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({model,temperature:0.15,max_completion_tokens:700,response_format:{type:'json_object'},messages:[{role:'system',content:`${CORE}\n${OUTPUT_RULE}`},{role:'user',content:`Evaluate this market snapshot.\n${JSON.stringify(payload)}`} ]})});const j=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(j?.error?.message||`Groq failed (${r.status})`),{status:r.status,provider:'Groq'});const out=extractJson(j?.choices?.[0]?.message?.content);if(!out)throw Object.assign(new Error('Groq returned an unreadable judgment.'),{status:502,provider:'Groq'});return{judgment:normalize(out),model:j?.model||model,usage:j?.usage||null}}

async function callGemini(apiKey,model,payload,groq){const url=`${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;const reviewPrompt=`${CORE}\n\nYou are the SECOND independent reviewer. Groq already produced this proposal:\n${JSON.stringify(groq.judgment)}\n\nReview the SAME raw market snapshot below. Do not agree just to agree. Correct Groq when needed. ${OUTPUT_RULE}\n\nMARKET:\n${JSON.stringify(payload)}`;const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{role:'user',parts:[{text:reviewPrompt}]}],generationConfig:{temperature:0.15,maxOutputTokens:700,responseMimeType:'application/json'}})});const j=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(j?.error?.message||`Gemini failed (${r.status})`),{status:r.status,provider:'Gemini'});const raw=j?.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('')||'';const out=extractJson(raw);if(!out)throw Object.assign(new Error('Gemini returned an unreadable judgment.'),{status:502,provider:'Gemini'});return{judgment:normalize(out),model,usage:j?.usageMetadata||null}}

function combine(g,g2,hasPosition){const a=g.judgment,b=g2.judgment;const sameEntry=(a.action==='BUY'||a.action==='SELL')&&a.action===b.action;const bothHold=a.action==='HOLD'&&b.action==='HOLD';const anyExit=hasPosition&&(a.action==='EXIT'||b.action==='EXIT');let finalAction='WAIT';let reason='The two brains did not agree on a new entry.';
if(hasPosition){if(anyExit){finalAction='EXIT';reason='At least one independent brain sees enough deterioration to exit.'}else if(bothHold){finalAction='HOLD';reason='Both brains agree the open position still deserves to be held.'}else{finalAction='HOLD';reason='The brains disagree, so Nana avoids an unnecessary exit and keeps monitoring.'}}
else if(sameEntry){finalAction=a.action;reason='Groq and Gemini independently agree on the same entry direction.'}
const confidence=sameEntry?Math.round((a.confidence+b.confidence)/2):Math.min(a.confidence,b.confidence);
const chosen=finalAction==='EXIT'?(a.action==='EXIT'?a:b):sameEntry?{...a,confidence}:b;
return normalize({...chosen,action:finalAction,confidence,thesis:`${reason} ${chosen.thesis}`.slice(0,280),evidence:[`Groq: ${a.action} · ${a.main_move} · ${a.phase} · ${Math.round(a.confidence)}%`,`Gemini: ${b.action} · ${b.main_move} · ${b.phase} · ${Math.round(b.confidence)}%`,...(chosen.evidence||[])].slice(0,5)})}

export default async function handler(req,res){if(req.method!=='POST')return res.status(405).json({error:'POST only'});const groqKey=String(req.headers?.['x-nana-groq-key']||'').trim()||process.env.NANA_GROQ_API_KEY||process.env.GROQ_API_KEY;const geminiKey=String(req.headers?.['x-nana-gemini-key']||'').trim()||process.env.NANA_GEMINI_API_KEY||process.env.GEMINI_API_KEY;if(!groqKey||!geminiKey)return res.status(503).json({error:'Nana needs both Groq and Gemini API keys on the Power Up page.'});const{model='openai/gpt-oss-120b',geminiModel='gemini-2.5-flash',market,config,position,recentJudgments=[]}=req.body||{};if(!market||!Array.isArray(market.ticks)||market.ticks.length<20)return res.status(400).json({error:'Nana needs at least 20 recent ticks.'});const payload={hard_laws:{market:config?.market||'Volatility 25 (1s)',maxRiskPerTrade:Number(config?.maxRiskPerTrade??1),maxSessionLoss:Number(config?.maxSessionLoss??10),profitTarget:Number(config?.profitTarget??160),maxOpenTrades:Number(config?.maxOpenTrades??1),maxTradeSeconds:Number(config?.maxTradeSeconds??300)},account_mode:config?.accountMode||'unknown',market_summary:{symbol:market.symbol,now:market.now,last_price:market.lastPrice,ticks:market.ticks.slice(-600),derived:market.derived||{}},open_position:position||null,recent_judgments:recentJudgments.slice(-6)};try{const groq=await callGroq(groqKey,model,payload);const gemini=await callGemini(geminiKey,geminiModel,payload,groq);const judgment=combine(groq,gemini,Boolean(position));return res.status(200).json({judgment,consensus:{groq:groq.judgment,gemini:gemini.judgment},models:{groq:groq.model,gemini:gemini.model},usage:{groq:groq.usage,gemini:gemini.usage},schoolPages:SCHOOL.length})}catch(error){return res.status(error.status||500).json({error:`${error.provider||'Nana AI'}: ${error.message||'request failed'}`})}}
