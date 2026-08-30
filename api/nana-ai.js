import fs from 'node:fs';
import path from 'node:path';

const GROQ_URL='https://api.groq.com/openai/v1/chat/completions';
const GEMINI_BASE='https://generativelanguage.googleapis.com/v1beta/models';

function loadSchool(){try{const p=path.join(process.cwd(),'public','nana-knowledge-base.json');const rows=JSON.parse(fs.readFileSync(p,'utf8'));return Array.isArray(rows)?rows:[]}catch{return[]}}
const SCHOOL=loadSchool();
// Keep Nana's full school in her brain, but keep each lesson to one compact sentence.
const SCHOOL_TEXT=SCHOOL.map(x=>`${x.id}.${x.topic}: ${x.rule}`).join('\n');

const CORE=`You are NANA, an autonomous Deriv Volatility 25 (1s) trading analyst.
Judge the whole price path, not isolated indicators. WAIT is a valid active decision.

NANA TRADING SCHOOL:
${SCHOOL_TEXT}

Operating principles:
- Separate main move, current phase and entry location.
- A move against the main move can be a pullback, not automatically a reversal.
- Do not count the same movement repeatedly as separate confirmation.
- Correct direction at poor location is still a bad trade.
- Every trade needs a thesis and invalidation.
- Profit mission never forces a trade.
- If evidence is unclear, WAIT.
- If a position is open, normally HOLD or EXIT; never add another position.
- Give concise auditable conclusions only, not private chain-of-thought.`;

const OUTPUT_RULE=`Return ONE compact JSON object only:
{"action":"WAIT|BUY|SELL|HOLD|EXIT","main_move":"UP|DOWN|NONE|TRANSITION","phase":"IMPULSE|TREND_ESTABLISHED|PULLBACK|RESUMING|EXTENDED|BREAKING|CHOP|TRANSITION|UNKNOWN","confidence":0-100,"location":"GOOD|ACCEPTABLE|POOR|UNKNOWN","thesis":"short","evidence":["short"],"invalidation":"short","expected_hold_seconds":0,"risk_note":"short"}`;

function extractJson(raw){if(raw&&typeof raw==='object')return raw;const text=String(raw||'').trim();try{return JSON.parse(text)}catch{}const m=text.match(/\{[\s\S]*\}/);if(m){try{return JSON.parse(m[0])}catch{}}return null}
function normalize(j={}){const actions=['WAIT','BUY','SELL','HOLD','EXIT'];const moves=['UP','DOWN','NONE','TRANSITION'];const phases=['IMPULSE','TREND_ESTABLISHED','PULLBACK','RESUMING','EXTENDED','BREAKING','CHOP','TRANSITION','UNKNOWN'];const locations=['GOOD','ACCEPTABLE','POOR','UNKNOWN'];return{action:actions.includes(j.action)?j.action:'WAIT',main_move:moves.includes(j.main_move)?j.main_move:'NONE',phase:phases.includes(j.phase)?j.phase:'UNKNOWN',confidence:Math.max(0,Math.min(100,Number(j.confidence)||0)),location:locations.includes(j.location)?j.location:'UNKNOWN',thesis:String(j.thesis||'No clear thesis.').slice(0,220),evidence:(Array.isArray(j.evidence)?j.evidence:['Insufficient evidence.']).slice(0,4).map(x=>String(x).slice(0,140)),invalidation:String(j.invalidation||'Unknown').slice(0,160),expected_hold_seconds:Math.max(0,Math.min(3600,Number(j.expected_hold_seconds)||0)),risk_note:String(j.risk_note||'').slice(0,160)}}

function round(v,d=2){const n=Number(v);return Number.isFinite(n)?Number(n.toFixed(d)):null}
function sampled(values,count){if(values.length<=count)return values.map(v=>round(v));const out=[];for(let i=0;i<count;i++){const idx=Math.round(i*(values.length-1)/(count-1));out.push(round(values[idx]))}return out}
function compactMarket(market={}){
  const rows=Array.isArray(market.ticks)?market.ticks:[];
  const prices=rows.map(x=>Number(x?.quote)).filter(Number.isFinite);
  const recent=prices.slice(-72).map(v=>round(v));
  const older=prices.slice(Math.max(0,prices.length-360),Math.max(0,prices.length-72));
  return{
    symbol:market.symbol,
    last_price:round(market.lastPrice),
    recent_prices_1s:recent,
    prior_context_sample:sampled(older,24),
    derived:market.derived||{}
  };
}
function compactJudgments(rows=[]){return rows.slice(-2).map(x=>({action:x.action,main_move:x.main_move,phase:x.phase,confidence:round(x.confidence,0),location:x.location}))}

async function callGroq(apiKey,model,payload){
  const r=await fetch(GROQ_URL,{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({model,temperature:0.1,max_completion_tokens:320,response_format:{type:'json_object'},messages:[{role:'system',content:`${CORE}\n${OUTPUT_RULE}`},{role:'user',content:`LIVE SNAPSHOT:\n${JSON.stringify(payload)}`} ]})});
  const j=await r.json().catch(()=>({}));
  if(!r.ok){const retryAfter=Number(r.headers.get('retry-after')||0);throw Object.assign(new Error(j?.error?.message||`Groq failed (${r.status})`),{status:r.status,provider:'Groq',retryAfter})}
  const out=extractJson(j?.choices?.[0]?.message?.content);if(!out)throw Object.assign(new Error('Groq returned an unreadable judgment.'),{status:502,provider:'Groq'});
  return{judgment:normalize(out),model:j?.model||model,usage:j?.usage||null}
}

async function callGemini(apiKey,model,payload,groq){
  const url=`${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const reviewPrompt=`${CORE}\nYou are Nana's independent SECOND reviewer. Groq proposes:\n${JSON.stringify(groq.judgment)}\nReview the same compact market. Do not agree just to agree. ${OUTPUT_RULE}\nMARKET:${JSON.stringify(payload)}`;
  const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{role:'user',parts:[{text:reviewPrompt}]}],generationConfig:{temperature:0.1,maxOutputTokens:360,responseMimeType:'application/json'}})});
  const j=await r.json().catch(()=>({}));
  if(!r.ok)throw Object.assign(new Error(j?.error?.message||`Gemini failed (${r.status})`),{status:r.status,provider:'Gemini'});
  const raw=j?.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('')||'';const out=extractJson(raw);if(!out)throw Object.assign(new Error('Gemini returned an unreadable judgment.'),{status:502,provider:'Gemini'});
  return{judgment:normalize(out),model,usage:j?.usageMetadata||null}
}

function scoutOnly(g,hasPosition){const a=g.judgment;if(hasPosition)return normalize({...a,action:a.action==='EXIT'?'HOLD':'HOLD',thesis:`Groq scout: ${a.thesis}`});return normalize({...a,action:'WAIT',thesis:`Groq scout is watching. Gemini review is reserved for trade candidates. ${a.thesis}`})}
function combine(g,g2,hasPosition){const a=g.judgment,b=g2.judgment;const sameEntry=(a.action==='BUY'||a.action==='SELL')&&a.action===b.action;const bothHold=a.action==='HOLD'&&b.action==='HOLD';const anyExit=hasPosition&&(a.action==='EXIT'||b.action==='EXIT');let finalAction='WAIT';let reason='The two brains did not agree on a new entry.';
  if(hasPosition){if(anyExit){finalAction='EXIT';reason='At least one independent brain sees enough deterioration to exit.'}else if(bothHold){finalAction='HOLD';reason='Both brains agree the position still deserves to be held.'}else{finalAction='HOLD';reason='The brains disagree, so Nana keeps monitoring rather than flipping impulsively.'}}
  else if(sameEntry){finalAction=a.action;reason='Groq and Gemini independently agree on the same entry direction.'}
  const confidence=sameEntry?Math.round((a.confidence+b.confidence)/2):Math.min(a.confidence,b.confidence);
  const chosen=finalAction==='EXIT'?(a.action==='EXIT'?a:b):sameEntry?{...a,confidence}:b;
  return normalize({...chosen,action:finalAction,confidence,thesis:`${reason} ${chosen.thesis}`.slice(0,220),evidence:[`Groq ${a.action}/${a.phase}/${Math.round(a.confidence)}%`,`Gemini ${b.action}/${b.phase}/${Math.round(b.confidence)}%`,...(chosen.evidence||[])].slice(0,4)})
}

export default async function handler(req,res){
  if(req.method!=='POST')return res.status(405).json({error:'POST only'});
  const groqKey=String(req.headers?.['x-nana-groq-key']||'').trim()||process.env.NANA_GROQ_API_KEY||process.env.GROQ_API_KEY;
  const geminiKey=String(req.headers?.['x-nana-gemini-key']||'').trim()||process.env.NANA_GEMINI_API_KEY||process.env.GEMINI_API_KEY;
  if(!groqKey||!geminiKey)return res.status(503).json({error:'Nana needs both Groq and Gemini API keys on the Power Up page.'});
  const{model='qwen/qwen3.8-27b',geminiModel='gemini-2.5-flash',market,config,position,recentJudgments=[]}=req.body||{};
  if(!market||!Array.isArray(market.ticks)||market.ticks.length<20)return res.status(400).json({error:'Nana needs at least 20 recent ticks.'});
  const payload={laws:{risk:Number(config?.maxRiskPerTrade??1),session_loss:Number(config?.maxSessionLoss??10),profit_mission:Number(config?.profitTarget??160),max_trade_seconds:Number(config?.maxTradeSeconds??300)},account_mode:config?.accountMode||'unknown',market:compactMarket(market),position:position?{side:position.side,status:position.status,liveProfit:round(position.liveProfit),boughtAt:position.boughtAt,context:String(position.context||'').slice(0,180)}:null,recent:compactJudgments(recentJudgments)};
  try{
    const groq=await callGroq(groqKey,model,payload);
    const hasPosition=Boolean(position);
    const needsReview=hasPosition||groq.judgment.action==='BUY'||groq.judgment.action==='SELL';
    if(!needsReview){const judgment=scoutOnly(groq,false);return res.status(200).json({judgment,consensus:{groq:groq.judgment,gemini:null},models:{groq:groq.model,gemini:null},usage:{groq:groq.usage,gemini:null},reviewed:false,mode:'GROQ_SCOUT',schoolPages:SCHOOL.length})}
    const gemini=await callGemini(geminiKey,geminiModel,payload,groq);
    const judgment=combine(groq,gemini,hasPosition);
    return res.status(200).json({judgment,consensus:{groq:groq.judgment,gemini:gemini.judgment},models:{groq:groq.model,gemini:gemini.model},usage:{groq:groq.usage,gemini:gemini.usage},reviewed:true,mode:'DUO_REVIEW',schoolPages:SCHOOL.length})
  }catch(error){return res.status(error.status||500).json({error:`${error.provider||'Nana AI'}: ${error.message||'request failed'}`,retryAfter:error.retryAfter||null})}
}
