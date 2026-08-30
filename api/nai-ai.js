const GROQ_URL='https://api.groq.com/openai/v1/chat/completions';
const GEMINI_BASE='https://generativelanguage.googleapis.com/v1beta/models';

const SCHOOL=`NAI TRADING RULES:
- Read the ordered price path, not isolated ticks. Main move is horizon-relative.
- A strong fresh impulse may be traded immediately; do not require pullback/resumption first.
- A small pause or bounce after a large directional burst is not CHOP by itself.
- UP/DOWN can contain counter-moves. Reversal needs meaningful opposite progress/structure damage.
- Structure is the sequence of meaningful highs/lows. Location and extension matter.
- CHOP means repeated back-and-forth with poor net progress, not merely mixed short horizons.
- BUY/SELL only when you judge a live directional edge. WAIT is allowed but do not wait for perfection.
- If already in a position: HOLD while thesis survives; EXIT when thesis materially deteriorates.
- Never invent data. Use only this live packet. Risk/trailing are handled outside you.`;

const OUTPUT=`Return ONLY JSON:
{"action":"BUY|SELL|WAIT|HOLD|EXIT","main_move":"UP|DOWN|NONE|TRANSITION","phase":"IMPULSE|TREND_ESTABLISHED|PULLBACK|RESUMING|EXTENDED|BREAKING|CHOP|TRANSITION|UNKNOWN","horizon":"5-20s|20-60s|1-3m|MIXED","confidence":0-100,"location":"GOOD|ACCEPTABLE|POOR|UNKNOWN","thesis":"<=120 chars","evidence":["<=80 chars","<=80 chars"],"invalidation":"<=90 chars","urgency":"NOW|SOON|NONE"}`;

const r=(v,d=2)=>Number.isFinite(Number(v))?Number(Number(v).toFixed(d)):null;
function extract(raw){if(raw&&typeof raw==='object')return raw;const t=String(raw||'').trim();try{return JSON.parse(t)}catch{}const m=t.match(/\{[\s\S]*\}/);if(m){try{return JSON.parse(m[0])}catch{}}return null}
function normalize(j={}){const pick=(v,a,f)=>a.includes(v)?v:f;return{action:pick(j.action,['BUY','SELL','WAIT','HOLD','EXIT'],'WAIT'),main_move:pick(j.main_move,['UP','DOWN','NONE','TRANSITION'],'NONE'),phase:pick(j.phase,['IMPULSE','TREND_ESTABLISHED','PULLBACK','RESUMING','EXTENDED','BREAKING','CHOP','TRANSITION','UNKNOWN'],'UNKNOWN'),horizon:pick(j.horizon,['5-20s','20-60s','1-3m','MIXED'],'MIXED'),confidence:Math.max(0,Math.min(100,Number(j.confidence)||0)),location:pick(j.location,['GOOD','ACCEPTABLE','POOR','UNKNOWN'],'UNKNOWN'),thesis:String(j.thesis||'No clear thesis.').slice(0,140),evidence:(Array.isArray(j.evidence)?j.evidence:[]).slice(0,2).map(x=>String(x).slice(0,90)),invalidation:String(j.invalidation||'Unknown').slice(0,100),urgency:pick(j.urgency,['NOW','SOON','NONE'],'NONE')}}

function slimWindow(w){if(!w)return null;return[r(w.net),r(w.range),r(w.efficiency,2),r(w.strength,1),r(w.from_high),r(w.from_low)]}
function packet(body){
  const e=body?.eyes||{},h=e.horizons||{};
  const film=(Array.isArray(e.filmstrip_10s)?e.filmstrip_10s:[]).slice(-6).map(b=>[r(b.net),r(b.range),r(b.efficiency,2),Number(b.up_steps||0),Number(b.down_steps||0),r(b.close)]);
  const swings=(Array.isArray(e.candidate_swings)?e.candidate_swings:[]).slice(-5).map(s=>[String(s.type||''),r(s.price),Number(s.ago_seconds||0)]);
  const prices=(Array.isArray(e.recent_prices)?e.recent_prices:[]).slice(-17).map(Number).filter(Number.isFinite);
  const step=Math.max(Number(e.median_step)||1,1e-9),deltas=[];
  for(let i=1;i<prices.length;i++)deltas.push(r((prices[i]-prices[i-1])/step,1));
  const p=body?.position;
  const recent=(Array.isArray(body?.recent)?body.recent:[]).slice(-1)[0];
  return{
    t:body?.trader,m:body?.mode||'demo',px:r(e.last_price),step:r(step,4),
    // horizon array = [net, range, efficiency, strength, fromHigh, fromLow]
    H:{s10:slimWindow(h.s10),s20:slimWindow(h.s20),s40:slimWindow(h.s40),s90:slimWindow(h.s90),s180:slimWindow(h.s180),s300:slimWindow(h.s300)},
    // chronological 10s blocks, oldest→newest = [net, range, efficiency, upSteps, downSteps, close]
    F10:film,
    // recent path in median-step units, preserves exact short sequence cheaply
    D:deltas,
    // [HIGH|LOW, price, secondsAgo]
    S:swings,
    P:p?{side:p.side,pnl:r(p.liveProfit),peak:r(p.peakProfit),floor:r(p.trailFloor),age:Math.max(0,Math.round((Date.now()-Number(p.boughtAt||Date.now()))/1000)),ctx:String(p.context||'').slice(0,100)}:null,
    prev:recent?{a:recent.action,m:recent.main_move,p:recent.phase,c:r(recent.confidence,0)}:null
  };
}

async function groq(key,model,payload){
  const r0=await fetch(GROQ_URL,{method:'POST',headers:{Authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify({model,reasoning_effort:'none',temperature:.25,max_completion_tokens:160,response_format:{type:'json_object'},messages:[{role:'system',content:`You are GROQ, an independent live trader inside NAI. ${SCHOOL}\n${OUTPUT}`},{role:'user',content:JSON.stringify(payload)}]})});
  const j=await r0.json().catch(()=>({}));
  if(!r0.ok)throw Object.assign(new Error(j?.error?.message||`Groq ${r0.status}`),{status:r0.status,retryAfter:Number(r0.headers.get('retry-after')||0)});
  const out=extract(j?.choices?.[0]?.message?.content);if(!out)throw Object.assign(new Error('Groq returned unreadable JSON.'),{status:502});
  return{judgment:normalize(out),model:j?.model||model,usage:j?.usage||null};
}

async function gemini(key,model,payload){
  const chosen=String(model||'').startsWith('gemini-2.5-flash')?'gemini-3.6-flash':(model||'gemini-3.6-flash');
  const url=`${GEMINI_BASE}/${encodeURIComponent(chosen)}:generateContent?key=${encodeURIComponent(key)}`;
  const prompt=`You are GEMINI, an independent live trader inside NAI. ${SCHOOL}\n${OUTPUT}\n${JSON.stringify(payload)}`;
  const r0=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{maxOutputTokens:180,responseMimeType:'application/json',thinkingConfig:{thinkingLevel:'minimal'}}})});
  const j=await r0.json().catch(()=>({}));
  if(!r0.ok)throw Object.assign(new Error(j?.error?.message||`Gemini ${r0.status}`),{status:r0.status});
  const raw=j?.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('')||'';const out=extract(raw);if(!out)throw Object.assign(new Error('Gemini returned unreadable JSON.'),{status:502});
  return{judgment:normalize(out),model:chosen,usage:j?.usageMetadata||null};
}

export default async function handler(req,res){
  if(req.method!=='POST')return res.status(405).json({error:'POST only'});
  const body=req.body||{},trader=String(body.trader||'').toUpperCase();
  if(!['GROQ','GEMINI'].includes(trader))return res.status(400).json({error:'trader must be GROQ or GEMINI'});
  if(!body.eyes)return res.status(400).json({error:'NAI Eyes packet is required.'});
  try{
    const payload=packet(body);
    if(trader==='GROQ'){
      const key=String(req.headers?.['x-nai-groq-key']||'').trim()||process.env.GROQ_API_KEY;if(!key)return res.status(503).json({error:'Groq API key missing.'});
      const result=await groq(key,body.model||'qwen/qwen3.8-27b',payload);return res.status(200).json({trader,...result});
    }
    const key=String(req.headers?.['x-nai-gemini-key']||'').trim()||process.env.GEMINI_API_KEY;if(!key)return res.status(503).json({error:'Gemini API key missing.'});
    const result=await gemini(key,body.model||'gemini-3.6-flash',payload);return res.status(200).json({trader,...result});
  }catch(e){return res.status(e.status||500).json({error:e.message||'NAI AI request failed.',retryAfter:e.retryAfter||null})}
}
