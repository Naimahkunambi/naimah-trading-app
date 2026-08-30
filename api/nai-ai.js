const GROQ_URL='https://api.groq.com/openai/v1/chat/completions';
const GEMINI_BASE='https://generativelanguage.googleapis.com/v1beta/models';

const SCHOOL=`NAI TRADING RULES:
- You receive NAI Memory, not raw market spam. FULL means a refreshed market anchor. DELTA means only meaningful changes since your last delivered state plus the current anchor.
- Read the ordered price path, not isolated ticks. Main move is horizon-relative.
- A strong fresh impulse may be traded immediately; do not require pullback/resumption first.
- A small pause or bounce after a large directional burst is not CHOP by itself.
- UP/DOWN can contain counter-moves. Reversal needs meaningful opposite progress or structure damage.
- Structure is the sequence of meaningful highs/lows. Location and extension matter.
- CHOP means repeated back-and-forth with poor net progress, not merely mixed short horizons.
- BUY/SELL only when you judge a live directional edge. WAIT is allowed but do not wait for perfection.
- If already in a position: HOLD while thesis survives; EXIT when thesis materially deteriorates.
- recentResults are your own actual closed trades. Use them as evidence, good or bad, without overfitting a tiny sample.
- Never invent data. Risk, max hold and trailing are handled outside you.`;

const LEGEND=`NAI Memory encoding:
current.H horizon tuples are [net,range,efficiency,strength,fromHigh,fromLow,high,low].
current.F10 is chronological oldest→newest 10s blocks [net,range,efficiency,upSteps,downSteps,close].
current.D is the latest ordered tick-step path measured in median-step units.
current.S is [HIGH|LOW,price,secondsAgo].
delta rows are [stateId,event,value,secondsAgo].
recentResults rows are [side,finalPnl,peakPnl,holdSeconds,exitReason].`;

const OUTPUT=`After thinking, return ONLY one JSON object:
{"action":"BUY|SELL|WAIT|HOLD|EXIT","main_move":"UP|DOWN|NONE|TRANSITION","phase":"IMPULSE|TREND_ESTABLISHED|PULLBACK|RESUMING|EXTENDED|BREAKING|CHOP|TRANSITION|UNKNOWN","horizon":"5-20s|20-60s|1-3m|MIXED","confidence":0-100,"location":"GOOD|ACCEPTABLE|POOR|UNKNOWN","thesis":"<=140 chars","evidence":["<=90 chars","<=90 chars"],"invalidation":"<=100 chars","urgency":"NOW|SOON|NONE"}`;

function extract(raw){if(raw&&typeof raw==='object')return raw;const t=String(raw||'').trim();try{return JSON.parse(t)}catch{}const m=t.match(/\{[\s\S]*\}/);if(m){try{return JSON.parse(m[0])}catch{}}return null}
function normalize(j={}){const pick=(v,a,f)=>a.includes(v)?v:f;return{action:pick(j.action,['BUY','SELL','WAIT','HOLD','EXIT'],'WAIT'),main_move:pick(j.main_move,['UP','DOWN','NONE','TRANSITION'],'NONE'),phase:pick(j.phase,['IMPULSE','TREND_ESTABLISHED','PULLBACK','RESUMING','EXTENDED','BREAKING','CHOP','TRANSITION','UNKNOWN'],'UNKNOWN'),horizon:pick(j.horizon,['5-20s','20-60s','1-3m','MIXED'],'MIXED'),confidence:Math.max(0,Math.min(100,Number(j.confidence)||0)),location:pick(j.location,['GOOD','ACCEPTABLE','POOR','UNKNOWN'],'UNKNOWN'),thesis:String(j.thesis||'No clear thesis.').slice(0,160),evidence:(Array.isArray(j.evidence)?j.evidence:[]).slice(0,2).map(x=>String(x).slice(0,100)),invalidation:String(j.invalidation||'Unknown').slice(0,110),urgency:pick(j.urgency,['NOW','SOON','NONE'],'NONE')}}

function payload(body){
  const c=body?.context||null;
  if(c)return{trader:body.trader,market:body.market||'Volatility 25 (1s)',mode:body.mode||'demo',...c};
  return{trader:body.trader,market:body.market||'Volatility 25 (1s)',mode:body.mode||'demo',legacyEyes:body.eyes||null,position:body.position||null};
}

async function groq(key,model,data){
  const r=await fetch(GROQ_URL,{method:'POST',headers:{Authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify({
    model,
    reasoning_effort:'medium',
    max_completion_tokens:700,
    response_format:{type:'json_object'},
    messages:[
      {role:'system',content:`You are GROQ TRADER inside NAI. You are independent from Gemini. Think carefully about direction, phase, location, timing and your own recent results before acting.\n${SCHOOL}\n${LEGEND}\n${OUTPUT}`},
      {role:'user',content:JSON.stringify(data)}
    ]
  })});
  const j=await r.json().catch(()=>({}));
  if(!r.ok)throw Object.assign(new Error(j?.error?.message||`Groq ${r.status}`),{status:r.status,retryAfter:Number(r.headers.get('retry-after')||0)});
  const out=extract(j?.choices?.[0]?.message?.content);if(!out)throw Object.assign(new Error('Groq returned unreadable JSON.'),{status:502});
  return{judgment:normalize(out),model:j?.model||model,usage:j?.usage||null};
}

async function gemini(key,model,data){
  const chosen=String(model||'').startsWith('gemini-2.5-flash')?'gemini-3.6-flash':(model||'gemini-3.6-flash');
  const url=`${GEMINI_BASE}/${encodeURIComponent(chosen)}:generateContent?key=${encodeURIComponent(key)}`;
  const prompt=`You are GEMINI TRADER inside NAI. You are independent from Groq. Think carefully about direction, phase, location, timing and your own recent results before acting.\n${SCHOOL}\n${LEGEND}\n${OUTPUT}\nNAI MEMORY:\n${JSON.stringify(data)}`;
  const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
    contents:[{role:'user',parts:[{text:prompt}]}],
    generationConfig:{maxOutputTokens:700,responseMimeType:'application/json',thinkingConfig:{thinkingLevel:'medium'}}
  })});
  const j=await r.json().catch(()=>({}));
  if(!r.ok)throw Object.assign(new Error(j?.error?.message||`Gemini ${r.status}`),{status:r.status});
  const raw=j?.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('')||'';const out=extract(raw);if(!out)throw Object.assign(new Error('Gemini returned unreadable JSON.'),{status:502});
  return{judgment:normalize(out),model:chosen,usage:j?.usageMetadata||null};
}

export default async function handler(req,res){
  if(req.method!=='POST')return res.status(405).json({error:'POST only'});
  const body=req.body||{},trader=String(body.trader||'').toUpperCase();
  if(!['GROQ','GEMINI'].includes(trader))return res.status(400).json({error:'trader must be GROQ or GEMINI'});
  if(!body.context&&!body.eyes)return res.status(400).json({error:'NAI Memory context is required.'});
  try{
    const data=payload(body);
    if(trader==='GROQ'){
      const key=String(req.headers?.['x-nai-groq-key']||'').trim()||process.env.GROQ_API_KEY;if(!key)return res.status(503).json({error:'Groq API key missing.'});
      const result=await groq(key,body.model||'qwen/qwen3.8-27b',data);return res.status(200).json({trader,...result,stateId:Number(body?.context?.stateId||0),contextMode:body?.context?.mode||'LEGACY'});
    }
    const key=String(req.headers?.['x-nai-gemini-key']||'').trim()||process.env.GEMINI_API_KEY;if(!key)return res.status(503).json({error:'Gemini API key missing.'});
    const result=await gemini(key,body.model||'gemini-3.6-flash',data);return res.status(200).json({trader,...result,stateId:Number(body?.context?.stateId||0),contextMode:body?.context?.mode||'LEGACY'});
  }catch(e){return res.status(e.status||500).json({error:e.message||'NAI AI request failed.',retryAfter:e.retryAfter||null})}
}
