import fs from 'node:fs';
import path from 'node:path';

const GROQ_URL='https://api.groq.com/openai/v1/chat/completions';
const GEMINI_BASE='https://generativelanguage.googleapis.com/v1beta/models';
const OPENROUTER_URL='https://openrouter.ai/api/v1/chat/completions';

function loadSchool(){try{const p=path.join(process.cwd(),'public','nana-knowledge-base.json');const rows=JSON.parse(fs.readFileSync(p,'utf8'));return Array.isArray(rows)?rows:[]}catch{return[]}}
const SCHOOL=loadSchool();
const SCHOOL_TEXT=SCHOOL.map(x=>`${x.id}.${x.topic}: ${x.rule}`).join('\n');

const CORE=`You are NANA, an autonomous Deriv Volatility 25 (1s) trading analyst.
Judge the ordered price journey, not isolated indicators. WAIT is a valid active decision.
NANA TRADING SCHOOL:\n${SCHOOL_TEXT}\n
Operating principles:
- Separate main move, current phase and entry location.
- A move against the main move can be a pullback, not automatically a reversal.
- A fresh large directional impulse can be the beginning of a new main move.
- Do not call a small pause after a strong impulse CHOP just because the final few ticks bounced.
- Do not count the same movement several times as separate confirmation.
- Correct direction at poor location is still a poor trade.
- Every trade needs a thesis and invalidation.
- Profit mission never forces an entry.
- If evidence is unclear, WAIT.
- With an open position, normally HOLD or EXIT and never add another position.
- Return concise auditable conclusions only.`;

const OUTPUT=`Return ONE compact JSON object only with exactly these keys:
{"action":"WAIT|BUY|SELL|HOLD|EXIT","main_move":"UP|DOWN|NONE|TRANSITION","phase":"IMPULSE|TREND_ESTABLISHED|PULLBACK|RESUMING|EXTENDED|BREAKING|CHOP|TRANSITION|UNKNOWN","confidence":0-100,"location":"GOOD|ACCEPTABLE|POOR|UNKNOWN","thesis":"short","evidence":["short"],"invalidation":"short","expected_hold_seconds":0,"risk_note":"short"}`;

function extractJson(raw){if(raw&&typeof raw==='object')return raw;const t=String(raw||'').trim();try{return JSON.parse(t)}catch{}const m=t.match(/\{[\s\S]*\}/);if(m){try{return JSON.parse(m[0])}catch{}}return null}
function normalize(j={}){const A=['WAIT','BUY','SELL','HOLD','EXIT'],M=['UP','DOWN','NONE','TRANSITION'],P=['IMPULSE','TREND_ESTABLISHED','PULLBACK','RESUMING','EXTENDED','BREAKING','CHOP','TRANSITION','UNKNOWN'],L=['GOOD','ACCEPTABLE','POOR','UNKNOWN'];return{action:A.includes(j.action)?j.action:'WAIT',main_move:M.includes(j.main_move)?j.main_move:'NONE',phase:P.includes(j.phase)?j.phase:'UNKNOWN',confidence:Math.max(0,Math.min(100,Number(j.confidence)||0)),location:L.includes(j.location)?j.location:'UNKNOWN',thesis:String(j.thesis||'No clear thesis.').slice(0,240),evidence:(Array.isArray(j.evidence)?j.evidence:['Insufficient evidence.']).slice(0,4).map(x=>String(x).slice(0,150)),invalidation:String(j.invalidation||'Unknown').slice(0,180),expected_hold_seconds:Math.max(0,Math.min(3600,Number(j.expected_hold_seconds)||0)),risk_note:String(j.risk_note||'').slice(0,180)}}
const round=(v,d=2)=>Number.isFinite(Number(v))?Number(Number(v).toFixed(d)):null;
function sample(values,count){if(values.length<=count)return values.map(v=>round(v));const out=[];for(let i=0;i<count;i++){const idx=Math.round(i*(values.length-1)/(count-1));out.push(round(values[idx]))}return out}
function filmstrip(prices,size=10,blocks=9){const a=prices.slice(-(size*blocks));const out=[];for(let start=0;start<a.length;start+=size){const b=a.slice(start,start+size);if(b.length<2)continue;let path=0,up=0,down=0;for(let i=1;i<b.length;i++){path+=Math.abs(b[i]-b[i-1]);if(b[i]>b[i-1])up++;else if(b[i]<b[i-1])down++;}const net=b.at(-1)-b[0];out.push({open:round(b[0]),high:round(Math.max(...b)),low:round(Math.min(...b)),close:round(b.at(-1)),net:round(net),range:round(Math.max(...b)-Math.min(...b)),efficiency:round(path?Math.abs(net)/path:0,3),up,down})}return out}
function compactMarket(market={}){const rows=Array.isArray(market.ticks)?market.ticks:[];const p=rows.map(x=>Number(x?.quote)).filter(Number.isFinite);return{symbol:market.symbol,last_price:round(market.lastPrice),recent_1s:p.slice(-60).map(v=>round(v)),older_sample:sample(p.slice(Math.max(0,p.length-360),Math.max(0,p.length-60)),20),filmstrip_10s:filmstrip(p,10,9),derived:market.derived||{}}}
function compactRecent(rows=[]){return rows.slice(-2).map(x=>({action:x.action,main_move:x.main_move,phase:x.phase,confidence:round(x.confidence,0),location:x.location}))}

async function callGroq(key,payload){const model='qwen/qwen3.8-27b';const r=await fetch(GROQ_URL,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model,temperature:0.1,max_completion_tokens:320,response_format:{type:'json_object'},messages:[{role:'system',content:`${CORE}\n${OUTPUT}`},{role:'user',content:`LIVE SNAPSHOT:\n${JSON.stringify(payload)}`}]})});const j=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(j?.error?.message||`Groq failed (${r.status})`),{status:r.status,provider:'Groq'});const x=extractJson(j?.choices?.[0]?.message?.content);if(!x)throw Object.assign(new Error('Groq returned unreadable JSON.'),{status:502,provider:'Groq'});return{judgment:normalize(x),model:j?.model||model,usage:j?.usage||null}}

async function callGemini(key,payload,groq){const model='gemini-2.5-flash';const prompt=`${CORE}\nYou are Nana's independent second reviewer. Groq proposed ${JSON.stringify(groq.judgment)}. Review the SAME market independently. Do not agree merely to agree. ${OUTPUT}\nMARKET:${JSON.stringify(payload)}`;const r=await fetch(`${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{temperature:0.1,maxOutputTokens:360,responseMimeType:'application/json'}})});const j=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(j?.error?.message||`Gemini failed (${r.status})`),{status:r.status,provider:'Gemini'});const raw=j?.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('')||'';const x=extractJson(raw);if(!x)throw Object.assign(new Error('Gemini returned unreadable JSON.'),{status:502,provider:'Gemini'});return{judgment:normalize(x),model,usage:j?.usageMetadata||null}}

async function callOpenRouter(key,model,payload,groq,gemini,origin){const prompt=`${CORE}\nYou are Nana's referee. Groq says ${JSON.stringify(groq.judgment)}. Gemini says ${JSON.stringify(gemini.judgment)}. Resolve ONLY this disagreement using the SAME market snapshot. ${OUTPUT}\nMARKET:${JSON.stringify(payload)}`;const r=await fetch(OPENROUTER_URL,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json','HTTP-Referer':origin||'https://chatgpt.com','X-Title':'Nana Trader'},body:JSON.stringify({model:model||'openrouter/auto',temperature:0.1,max_tokens:360,messages:[{role:'user',content:prompt}]})});const j=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(j?.error?.message||`OpenRouter failed (${r.status})`),{status:r.status,provider:'OpenRouter'});const x=extractJson(j?.choices?.[0]?.message?.content);if(!x)throw Object.assign(new Error('OpenRouter returned unreadable JSON.'),{status:502,provider:'OpenRouter'});return{judgment:normalize(x),model:j?.model||model,usage:j?.usage||null}}

function scoutOnly(g){return normalize({...g.judgment,action:'WAIT',thesis:`Groq scout: ${g.judgment.thesis}`})}
function pairAgreement(g,m,hasPosition){const a=g.judgment,b=m.judgment;if(hasPosition){if(a.action==='EXIT'&&b.action==='EXIT')return normalize({...a,action:'EXIT',confidence:Math.round((a.confidence+b.confidence)/2),thesis:`Both brains agree to exit. ${a.thesis}`});if(a.action==='HOLD'&&b.action==='HOLD')return normalize({...a,action:'HOLD',confidence:Math.round((a.confidence+b.confidence)/2),thesis:`Both brains agree to hold. ${a.thesis}`});return null}if((a.action==='BUY'||a.action==='SELL')&&a.action===b.action)return normalize({...a,action:a.action,confidence:Math.round((a.confidence+b.confidence)/2),thesis:`Groq and Gemini agree. ${a.thesis}`});return null}
function refereeFinal(g,m,r,hasPosition){const a=g.judgment,b=m.judgment,c=r.judgment;if(hasPosition){if(c.action==='EXIT')return normalize({...c,thesis:`OpenRouter referee chose EXIT. ${c.thesis}`});return normalize({...c,action:'HOLD',thesis:`Brains disagreed. Referee did not confirm EXIT, so Nana holds. ${c.thesis}`})}const votes=[a.action,b.action,c.action];for(const side of ['BUY','SELL'])if(votes.filter(x=>x===side).length>=2)return normalize({...c,action:side,thesis:`Two of three Nana brains agree on ${side}. ${c.thesis}`});return normalize({...c,action:'WAIT',thesis:`No two-brain agreement. Nana waits. ${c.thesis}`})}

export default async function handler(req,res){
  if(req.method!=='POST')return res.status(405).json({error:'POST only'});
  const openrouter=String(req.headers?.['x-nana-openrouter-key']||'').trim();
  const groq=String(req.headers?.['x-nana-groq-key']||'').trim();
  const gemini=String(req.headers?.['x-nana-gemini-key']||'').trim();
  if(!openrouter||!groq||!gemini)return res.status(503).json({error:'Nana needs OpenRouter, Groq and Gemini keys on Page 1.'});
  const{model='openrouter/auto',market,config,position,recentJudgments=[]}=req.body||{};
  if(!market||!Array.isArray(market.ticks)||market.ticks.length<20)return res.status(400).json({error:'Nana needs at least 20 recent ticks.'});
  const payload={laws:{risk:Number(config?.maxRiskPerTrade??1),session_loss:Number(config?.maxSessionLoss??10),profit_mission:Number(config?.profitTarget??160),max_trade_seconds:Number(config?.maxTradeSeconds??300)},account_mode:config?.accountMode||'unknown',market:compactMarket(market),position:position?{side:position.side,status:position.status,liveProfit:round(position.liveProfit),boughtAt:position.boughtAt,context:String(position.context||'').slice(0,180)}:null,recent:compactRecent(recentJudgments)};
  try{
    const g=await callGroq(groq,payload);
    const hasPosition=Boolean(position);
    const serious=hasPosition||g.judgment.action==='BUY'||g.judgment.action==='SELL';
    if(!serious)return res.status(200).json({judgment:scoutOnly(g),mode:'GROQ_SCOUT',brains:{groq:g.judgment,gemini:null,openrouter:null},models:{groq:g.model,gemini:null,openrouter:null},usage:{groq:g.usage},schoolPages:SCHOOL.length});
    const m=await callGemini(gemini,payload,g);
    const agreed=pairAgreement(g,m,hasPosition);
    if(agreed)return res.status(200).json({judgment:agreed,mode:'GROQ_GEMINI_AGREE',brains:{groq:g.judgment,gemini:m.judgment,openrouter:null},models:{groq:g.model,gemini:m.model,openrouter:null},usage:{groq:g.usage,gemini:m.usage},schoolPages:SCHOOL.length});
    const o=await callOpenRouter(openrouter,model,payload,g,m,req.headers?.origin);
    return res.status(200).json({judgment:refereeFinal(g,m,o,hasPosition),mode:'OPENROUTER_REFEREE',brains:{groq:g.judgment,gemini:m.judgment,openrouter:o.judgment},models:{groq:g.model,gemini:m.model,openrouter:o.model},usage:{groq:g.usage,gemini:m.usage,openrouter:o.usage},schoolPages:SCHOOL.length});
  }catch(error){return res.status(error.status||500).json({error:`${error.provider||'Nana AI'}: ${error.message||'request failed'}`})}
}
