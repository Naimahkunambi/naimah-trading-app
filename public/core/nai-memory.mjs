const JOURNAL_KEY='nai.ai.journal.v1';
const FULL_REFRESH_MS=180000;
const MAX_EVENTS=700;
const OWNERS=['GROQ','GEMINI'];

const num=v=>Number(v);
const finite=v=>Number.isFinite(num(v));
const round=(v,d=2)=>finite(v)?Number(num(v).toFixed(d)):null;
const sign=v=>num(v)>0?'UP':num(v)<0?'DOWN':'FLAT';

function safeParse(raw,fallback){try{return JSON.parse(raw)||fallback}catch{return fallback}}
function compactPosition(p){return p?{id:String(p.contractId||''),side:p.side,pnl:round(p.liveProfit),peak:round(p.peakProfit),floor:round(p.trailFloor),gap:round(p.trailGap),ageSec:Math.max(0,Math.round((Date.now()-Number(p.boughtAt||Date.now()))/1000)),ctx:String(p.context||'').slice(0,120)}:null}
function horizonTuple(w){return w?[round(w.net),round(w.range),round(w.efficiency,3),round(w.strength,1),round(w.from_high),round(w.from_low),round(w.high),round(w.low)]:null}
function filmTuple(b){return b?[round(b.net),round(b.range),round(b.efficiency,3),Number(b.up_steps||0),Number(b.down_steps||0),round(b.close)]:null}
function swingTuple(s){return s?[String(s.type||''),round(s.price),Number(s.ago_seconds||0)]:null}

function currentAnchor(eyes,{full=false}={}){
  const h=eyes?.horizons||{};
  const recent=(Array.isArray(eyes?.recent_prices)?eyes.recent_prices:[]).map(Number).filter(Number.isFinite);
  const step=Math.max(Number(eyes?.median_step)||1,1e-9),d=[];
  for(let i=Math.max(1,recent.length-(full?18:12));i<recent.length;i++)d.push(round((recent[i]-recent[i-1])/step,1));
  return{
    px:round(eyes?.last_price),step:round(step,4),
    H:{s10:horizonTuple(h.s10),s20:horizonTuple(h.s20),s40:horizonTuple(h.s40),s90:horizonTuple(h.s90),s180:horizonTuple(h.s180),s300:horizonTuple(h.s300)},
    F10:(Array.isArray(eyes?.filmstrip_10s)?eyes.filmstrip_10s:[]).slice(full?-8:-4).map(filmTuple),
    S:(Array.isArray(eyes?.candidate_swings)?eyes.candidate_swings:[]).slice(full?-6:-4).map(swingTuple),
    D:d
  };
}

function lastSwingKey(eyes){const s=eyes?.candidate_swings?.at(-1);return s?`${s.type}:${round(s.price)}:${Number(s.ago_seconds||0)}`:''}
function meaningfulDirection(w,step,mult=2){if(!w||Math.abs(Number(w.net)||0)<step*mult)return'FLAT';return sign(w.net)}
function eventFacts(previous,current,stateId,at){
  if(!previous||!current)return[{id:stateId,at,k:'MEMORY_START',v:`px ${round(current?.last_price)}`,major:true}];
  const out=[],step=Math.max(Number(current.median_step)||1,1e-9),ph=previous.horizons||{},ch=current.horizons||{};
  const add=(k,v,major=false)=>out.push({id:stateId,at,k,v,major});
  for(const [key,mult] of [['s20',2],['s40',2.5],['s90',3],['s180',4]]){
    const a=meaningfulDirection(ph[key],step,mult),b=meaningfulDirection(ch[key],step,mult);
    if(a!==b&&a!=='FLAT'&&b!=='FLAT')add(`FLIP_${key.toUpperCase()}`,`${a}→${b} net ${round(ch[key]?.net)}`,key==='s90'||key==='s180');
  }
  if(finite(ch.s90?.low)&&finite(ph.s90?.low)&&ch.s90.low<ph.s90.low-step*.5)add('NEW_90S_LOW',`${round(ch.s90.low)} net ${round(ch.s90.net)}`);
  if(finite(ch.s90?.high)&&finite(ph.s90?.high)&&ch.s90.high>ph.s90.high+step*.5)add('NEW_90S_HIGH',`${round(ch.s90.high)} net ${round(ch.s90.net)}`);
  const p10=Number(ph.s10?.strength||0),c10=Number(ch.s10?.strength||0);
  if(Math.abs(c10-p10)>=1.8&&Math.abs(Number(ch.s10?.net||0))>=step*3)add(c10>p10?'ACCEL_10S':'DECEL_10S',`strength ${round(p10,1)}→${round(c10,1)} net ${round(ch.s10.net)}`);
  const pEff=Number(ph.s20?.efficiency||0),cEff=Number(ch.s20?.efficiency||0);
  if(Math.abs(cEff-pEff)>=.22&&Math.abs(Number(ch.s20?.net||0))>=step*3)add(cEff>pEff?'EFFICIENCY_UP_20S':'EFFICIENCY_DOWN_20S',`${round(pEff,2)}→${round(cEff,2)} net ${round(ch.s20.net)}`);
  if(lastSwingKey(previous)!==lastSwingKey(current)){const s=current.candidate_swings?.at(-1);if(s)add('NEW_SWING',`${s.type} ${round(s.price)} ${Number(s.ago_seconds||0)}s ago`);}
  return out.slice(0,5);
}

export class NaiMemory{
  constructor({storage=globalThis.localStorage}={}){
    this.storage=storage;this.stateId=0;this.lastEyes=null;this.events=[];this.lastUpdate={meaningful:false,major:false,events:[]};
    const saved=safeParse(this.storage?.getItem(JOURNAL_KEY)||'null',{});
    this.traders={};
    for(const owner of OWNERS)this.traders[owner]={lastSeenId:0,lastFullAt:0,forceFull:true,forceReason:'START',journal:Array.isArray(saved?.[owner])?saved[owner].slice(-80):[]};
  }
  seed(eyes){if(!eyes)return;this.stateId=Math.max(1,this.stateId+1);this.lastEyes=eyes;const ev={id:this.stateId,at:Date.now(),k:'FULL_MARKET_SEED',v:`px ${round(eyes.last_price)}`,major:true};this.events.push(ev);this.lastUpdate={meaningful:true,major:true,events:[ev],stateId:this.stateId};for(const owner of OWNERS)this.forceFull(owner,'MARKET_SEED');}
  ingest(previous,current,{at=Date.now()}={}){
    if(!current)return this.lastUpdate;
    this.stateId+=1;
    const events=eventFacts(previous||this.lastEyes,current,this.stateId,at);
    this.lastEyes=current;
    if(events.length){this.events.push(...events);if(this.events.length>MAX_EVENTS)this.events.splice(0,this.events.length-MAX_EVENTS)}
    const major=events.some(e=>e.major);
    this.lastUpdate={meaningful:events.length>0,major,events,stateId:this.stateId};
    if(major)for(const owner of OWNERS)this.forceFull(owner,events.find(e=>e.major)?.k||'MAJOR_CHANGE');
    return this.lastUpdate;
  }
  forceFull(owner='ALL',reason='REFRESH'){
    const targets=owner==='ALL'?OWNERS:[owner];
    for(const who of targets){if(!this.traders[who])continue;this.traders[who].forceFull=true;this.traders[who].forceReason=reason;}
  }
  contextFor(owner,{position=null,recentJudgment=null,trigger='EVENT',now=Date.now()}={}){
    const t=this.traders[owner];if(!t||!this.lastEyes)return null;
    const unseen=this.events.filter(e=>e.id>t.lastSeenId);
    const dueFull=t.forceFull||!t.lastSeenId||now-t.lastFullAt>=FULL_REFRESH_MS||unseen.length>24||unseen.some(e=>e.major);
    const mode=dueFull?'FULL':'DELTA';
    const deltas=unseen.slice(dueFull?-12:-10).map(e=>[e.id,e.k,e.v,Math.max(0,Math.round((now-e.at)/1000))]);
    const recentTrades=t.journal.slice(-3).map(x=>[x.side,round(x.pnl),round(x.peak),x.holdSec,String(x.exit||'').slice(0,70)]);
    return{
      mode,stateId:this.stateId,generatedAt:now,trigger,refreshReason:dueFull?t.forceReason||'PERIODIC':'',
      current:currentAnchor(this.lastEyes,{full:dueFull}),
      delta:deltas,
      position:compactPosition(position),
      previous:recentJudgment?{action:recentJudgment.action,move:recentJudgment.main_move,phase:recentJudgment.phase,confidence:round(recentJudgment.confidence,0),thesis:String(recentJudgment.thesis||'').slice(0,100)}:null,
      recentResults:recentTrades
    };
  }
  markDelivered(owner,context,at=Date.now()){
    const t=this.traders[owner];if(!t||!context)return;
    t.lastSeenId=Math.max(t.lastSeenId,Number(context.stateId||0));
    if(context.mode==='FULL'){t.lastFullAt=at;t.forceFull=false;t.forceReason='';}
  }
  recordTrade(owner,trade){
    const t=this.traders[owner];if(!t||!trade)return;
    const row={at:Number(trade.closedAt||Date.now()),side:String(trade.side||''),pnl:round(trade.pnl),peak:round(trade.peakProfit),holdSec:Math.max(0,Math.round((Number(trade.closedAt||Date.now())-Number(trade.boughtAt||Date.now()))/1000)),entry:String(trade.context||'').slice(0,140),exit:String(trade.reason||'').slice(0,100)};
    t.journal=[...t.journal,row].slice(-80);this.persistJournals();this.forceFull(owner,'TRADE_CLOSED');
  }
  persistJournals(){try{const out={};for(const owner of OWNERS)out[owner]=this.traders[owner].journal;this.storage?.setItem(JOURNAL_KEY,JSON.stringify(out))}catch{}}
  snapshot(){return{stateId:this.stateId,events:this.events.length,lastUpdate:{...this.lastUpdate},traders:Object.fromEntries(OWNERS.map(o=>[o,{lastSeenId:this.traders[o].lastSeenId,lastFullAt:this.traders[o].lastFullAt,journalCount:this.traders[o].journal.length}]))}}
}
