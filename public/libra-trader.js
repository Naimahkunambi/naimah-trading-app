import { SaniEngine, DEFAULT_CONFIG } from './core/engine.mjs';
import { TrendBudget } from './core/trend-budget.mjs';
import { LibraBrain, LIBRA_VERSION } from './core/libra-brain.mjs';

const $ = id => document.getElementById(id);
const perfNow = () => globalThis.performance?.now?.() ?? Date.now();
const SIGNAL_KEY = 'sani.libra.signals.v1';
const BRAIN_KEY = 'sani.libra.brain.v1';
const FIXED_DURATION = 1;
const MAX_CONCURRENT = 2;
const REVIEW_MS = 7 * 60_000;
const PAYOUT = 0.92;
const BREAK_EVEN = 100 / (1 + PAYOUT);

let worker;
let workerAnalysis = null;
let accounts = [];
let selectedAccount = null;
let lastOtpContext = null;
let signals = loadArray(SIGNAL_KEY);
let localTicks = loadTicks();
let lastTickKey = localTicks.length ? `${localTicks.at(-1).epoch}:${localTicks.at(-1).quote}` : '';
let pendingForecast = null;
let lastArbitration = null;
let mission = freshMission();
const contractMeta = new Map();
const shadowPending = new Map();
const brain = new LibraBrain(loadJson(BRAIN_KEY));
const trendBudget = new TrendBudget({ shortSeconds:8, primarySeconds:21, confirmSeconds:55, flipVotes:2, flipWindowSeconds:3 });
let trendSnapshot = trendBudget.hydrate(localTicks) || null;

const engine = new SaniEngine({
  ...DEFAULT_CONFIG,
  symbol:'1HZ25V', stake:1,
  duration:FIXED_DURATION, durationUnit:'t', executionMethod:'direct',
  oneOpenContract:false, takeProfit:0, stopLoss:0, maxTrades:5000,
  maxConsecutiveLosses:0, cooldownTicks:0, maxSignalToSendMs:250,
  reconnect:true, maxReconnectAttempts:8
});

function freshMission() {
  return {
    id:'', status:'IDLE', phase:'IDLE', startedAt:0, deadlineAt:0,
    reviewStartedAt:0, nextReviewAt:0, reviewCount:0, lastReview:null,
    basePnl:0, baseTrades:0, targetProfit:30, hardStop:15, maxTrades:200,
    durationMinutes:30, goal:650, peakPnl:0, protectedFloor:0,
    reason:'Connect, then start Libra. SANI and Libra will begin together in shadow.',
    recommendation:'WAIT'
  };
}
function loadArray(key){try{const value=JSON.parse(localStorage.getItem(key)||'[]');return Array.isArray(value)?value:[]}catch{return[]}}
function loadJson(key){try{return JSON.parse(localStorage.getItem(key)||'null')}catch{return null}}
function saveSignals(){signals=signals.slice(0,6000);try{localStorage.setItem(SIGNAL_KEY,JSON.stringify(signals))}catch{}}
function persistBrain(){try{localStorage.setItem(BRAIN_KEY,JSON.stringify(brain.exportState()))}catch{}}
function currentSymbol(){return $('obsSymbol')?.value?.trim()||'1HZ25V'}
function tickKey(symbol=currentSymbol()){return `sani.observatory.ticks.${symbol}`}
function loadTicks(){try{const value=JSON.parse(localStorage.getItem(tickKey())||'[]');return Array.isArray(value)?value.map(row=>({epoch:+row.epoch,quote:+row.quote})).filter(row=>Number.isFinite(row.epoch)&&Number.isFinite(row.quote)).sort((a,b)=>a.epoch-b.epoch).slice(-10000):[]}catch{return[]}}
function upsertSignal(id,patch={}){let row=signals.find(item=>item.signalId===id);if(!row){row={signalId:id,createdAt:Date.now(),actualTrades:[]};signals.unshift(row)}Object.assign(row,patch,{updatedAt:Date.now()});row.actualTrades||=[];saveSignals();return row}
function batchSize(){return Math.max(1,Math.min(2,Math.round(Number($('ptCooldown')?.value||1))))}
function exposure(){let pending=0;for(const request of engine.pending.values())if(['buy-direct','proposal','buy-proposal'].includes(request?.kind))pending+=1;return engine.open.size+pending}
function totalSettled(){return engine.trades.filter(trade=>['won','lost'].includes(String(trade.status||'').toLowerCase())).length}
function missionRunPnl(){return Number(engine.snapshot().sessionPnL||0)-Number(mission.basePnl||0)}
function missionRunTrades(){return Math.max(0,totalSettled()-Number(mission.baseTrades||0))}
function missionPlanFromForm(){return{durationMinutes:Math.max(1,Math.min(720,Number($('libraDuration')?.value||30))),targetProfit:Math.max(0,Number($('ptTakeProfit')?.value||30)),hardStop:Math.max(.35,Number($('ptStopLoss')?.value||15)),maxTrades:Math.max(1,Math.min(5000,Math.round(Number($('ptMaxTrades')?.value||200)))),goal:Math.max(0,Number($('libraGoal')?.value||650))}}
function money(value){return `${Number(value||0)>=0?'+':'-'}$${Math.abs(Number(value||0)).toFixed(2)}`}

function missionSignals(since=0){return signals.filter(row=>row.missionId===mission.id&&Number(row.createdAt||0)>=since)}
function shadowSummary(since=0){
  const rows=missionSignals(since).filter(row=>row.shadowSettled);
  const out={comparable:rows.length,sani:{trades:0,wins:0,losses:0,pnl:0},libra:{trades:0,wins:0,losses:0,pnl:0}};
  for(const row of rows){for(const key of ['sani','libra']){const result=row.shadowResult?.[key];if(!result||result.outcome==='FLAT')continue;out[key].trades++;out[key].pnl+=Number(result.profit||0);if(result.outcome==='WON')out[key].wins++;else out[key].losses++}}
  for(const key of ['sani','libra']){const side=out[key],n=side.wins+side.losses;side.winRate=n?side.wins/n*100:0;side.avg=side.trades?side.pnl/side.trades:0;side.pnl=Number(side.pnl.toFixed(2))}
  out.edge=Number((out.libra.pnl-out.sani.pnl).toFixed(2));
  return out;
}

function derivePhase(runPnl){
  if(mission.phase==='LEARN')return'LEARN';
  if(runPnl<0)return'RECOVER';
  if(runPnl>=5)return'PROTECT';
  return'WORK';
}
function checkMission(now=Date.now()){
  const runPnl=missionRunPnl(),runTrades=missionRunTrades();
  if(mission.status!=='ACTIVE')return{stop:true,runPnl,runTrades,status:mission.status};
  mission.peakPnl=Math.max(Number(mission.peakPnl||0),runPnl);
  if(mission.peakPnl>=5)mission.protectedFloor=Math.max(Number(mission.protectedFloor||0),Math.max(1,mission.peakPnl*.6));
  if(runPnl<=-Math.abs(mission.hardStop)){mission.status='HARD STOP';mission.reason=`Hard stop reached at ${money(runPnl)}. I stop.`}
  else if(mission.targetProfit>0&&runPnl>=mission.targetProfit){mission.status='TARGET';mission.reason=`Mission target reached at ${money(runPnl)}. I lock the win.`}
  else if(mission.phase!=='LEARN'&&mission.protectedFloor>0&&runPnl<=mission.protectedFloor&&mission.peakPnl>mission.protectedFloor+.75){mission.status='PROTECTED STOP';mission.reason=`I protected ${money(mission.protectedFloor)} after peaking at ${money(mission.peakPnl)}.`}
  else if(runTrades>=mission.maxTrades){mission.status='CAP';mission.reason=`The ${mission.maxTrades}-contract cap is complete.`}
  else if(now>=mission.deadlineAt){mission.status='TIME';mission.reason=`The mission clock ended at ${money(runPnl)}.`}
  if(mission.status!=='ACTIVE'&&engine.running)engine.pause();
  if(mission.status==='ACTIVE'&&mission.phase!=='LEARN')mission.phase=derivePhase(runPnl);
  return{stop:mission.status!=='ACTIVE',runPnl,runTrades,status:mission.status};
}

function makeSnapshot(){
  const engineState=engine.snapshot(),prediction=brain.predict(localTicks),brainState=brain.snapshot(),gate=checkMission();
  const allShadow=mission.id?shadowSummary(mission.startedAt):shadowSummary(Number.MAX_SAFE_INTEGER);
  return{version:LIBRA_VERSION,ticks:localTicks,signals:[...signals].sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)),engine:engineState,analysis:workerAnalysis,trend:trendSnapshot,prediction,brain:brainState,arbitration:lastArbitration,
    shadows:allShadow,
    mission:{...mission,runPnl:gate.runPnl,runTrades:gate.runTrades,remainingMs:mission.deadlineAt?Math.max(0,mission.deadlineAt-Date.now()):0,reviewRemainingMs:mission.nextReviewAt?Math.max(0,mission.nextReviewAt-Date.now()):0},
    accountType:selectedAccount?String(selectedAccount.account_type||'DEMO').toUpperCase():'NONE'}
}
function publish(){const detail=makeSnapshot();window.dispatchEvent(new CustomEvent('libra-state',{detail}));return detail}

function learnPreviousTick(epoch,quote){
  if(!pendingForecast||Number(epoch)<=Number(pendingForecast.epoch))return;
  const actualUp=quote>pendingForecast.quote?true:quote<pendingForecast.quote?false:null;
  brain.learn(actualUp==null?{actualUp:null}:{features:pendingForecast.features,signature:pendingForecast.signature,predictedUp:pendingForecast.probabilityUp,actualUp,regime:pendingForecast.regime,confidence:pendingForecast.confidence});
  persistBrain();
}
function settleVirtual(direction,entryQuote,exitQuote){
  if(!['CALL','PUT'].includes(direction))return null;
  const actualDirection=Number(exitQuote)>Number(entryQuote)?'CALL':Number(exitQuote)<Number(entryQuote)?'PUT':'NONE';
  if(actualDirection==='NONE')return{outcome:'FLAT',profit:0,actualDirection};
  const won=direction===actualDirection;return{outcome:won?'WON':'LOST',profit:won?PAYOUT:-1,actualDirection};
}
function settleShadowOnTick(epoch,quote){
  for(const [signalId,pending] of [...shadowPending.entries()]){
    if(Number(epoch)<=Number(pending.epoch))continue;
    const row=signals.find(item=>item.signalId===signalId);if(!row){shadowPending.delete(signalId);continue}
    const actualDirection=Number(quote)>Number(pending.quote)?'CALL':Number(quote)<Number(pending.quote)?'PUT':'NONE';
    const sani=settleVirtual(pending.sourceApproved?pending.sourceDirection:'NONE',pending.quote,quote);
    const libra=settleVirtual(pending.libraDirection,pending.quote,quote);
    row.shadowSettled=true;row.shadowExitEpoch=Number(epoch);row.shadowExitQuote=Number(quote);row.shadowResult={sani,libra};
    if(['CALL','PUT'].includes(actualDirection)){
      brain.learnShadow({signature:pending.signature,regime:pending.regime,action:pending.action,tradeDirection:pending.libraDirection,sourceApproved:pending.sourceApproved,sourceDirection:pending.sourceDirection,actualDirection,confidence:pending.confidence,horizons:pending.horizons});
      persistBrain();
      row.libra.shadowLesson=brain.snapshot().lastLesson;
    }
    shadowPending.delete(signalId);saveSignals();
  }
}
function postTick(tick){
  const epoch=Number(tick?.epoch),quote=Number(tick?.quote);if(!Number.isFinite(epoch)||!Number.isFinite(quote))return;
  const key=`${epoch}:${quote}`;if(key===lastTickKey)return;
  learnPreviousTick(epoch,quote);settleShadowOnTick(epoch,quote);lastTickKey=key;localTicks.push({epoch,quote});if(localTicks.length>10000)localTicks.splice(0,localTicks.length-10000);
  trendSnapshot={...trendBudget.ingest({epoch,quote},workerAnalysis?.pattern?.direction||'NONE'),epoch};
  const forecast=brain.predict(localTicks);pendingForecast=forecast.ready?{epoch,quote,features:[...(forecast.features||[])],signature:forecast.signature,probabilityUp:forecast.probabilityUp,regime:forecast.regime,confidence:forecast.confidence}:null;
  worker?.postMessage({type:'TICK',tick:{epoch,quote}});reviewMission();publish();
}

function initWorker(){
  worker?.terminate?.();worker=new Worker('/pattern-trader-v73-worker.js',{type:'module'});
  worker.onmessage=event=>{const message=event.data||{};if(message.type==='ANALYSIS')workerAnalysis=message.analysis;else if(message.type==='DECISION')handleDecision(message.decision);else if(message.type==='SHADOW_RESULT'){const row=upsertSignal(message.signalId);row.shadow=message.shadow;row.variantOutcomes=message.variantOutcomes||row.variantOutcomes;row.addressKey=message.addressKey||row.addressKey;saveSignals()}publish()};
  worker.onerror=event=>{workerAnalysis={state:'WORKER_ERROR',reason:event.message||'Worker error'};showError(event.message||'Worker error');publish()};
  worker.postMessage({type:'INIT',ticks:localTicks,executionOffset:1,memoryRows:[]});
}
function sourceFromDecision(decision){const baseline=decision?.pattern?.baseline||{},approved=Boolean(decision?.controlApproved),tradeDirection=baseline.direction==='UP'?'CALL':baseline.direction==='DOWN'?'PUT':decision?.tradeDirection;return{approved,tradeDirection:['CALL','PUT'].includes(tradeDirection)?tradeDirection:'NONE',signalEpoch:decision?.signalEpoch,signalQuote:decision?.signalQuote,familyId:baseline.familyId||decision?.pattern?.familyId,edge:baseline.edge??decision?.pattern?.edge,why:approved?'Original v8 baseline qualified.':'Original v8 baseline is quiet.'}}

function storeDecision(decision,source,shadowArb,paidArb){
  const finalArb=paidArb||shadowArb;
  return upsertSignal(decision.signalId,{missionId:mission.id,missionPhase:mission.phase,approved:Boolean(paidArb?.approved),sourceApproved:source.approved,sourceDirection:source.tradeDirection,tradeDirection:paidArb?.tradeDirection||'NONE',signalEpoch:decision.signalEpoch,signalQuote:decision.signalQuote,duration:FIXED_DURATION,structure:decision.structure,pattern:{...decision.pattern,foundationFamily:source.familyId,foundationEdge:source.edge},sniper:decision.sniper,campaign:decision.campaign,decisionMs:decision.decisionMs,
    libra:{action:finalArb.action,shadowAction:shadowArb.action,reason:finalArb.reason,regime:finalArb.regime,direction:finalArb.direction,confidence:finalArb.confidence,probabilityUp:finalArb.probabilityUp,bestHorizon:finalArb.bestHorizon,horizons:finalArb.horizons,signature:finalArb.signature,features:finalArb.features,policyScore:finalArb.policyScore,policySamples:finalArb.policySamples,modelGeneration:finalArb.modelGeneration,updates:finalArb.updates,retainedStates:finalArb.retainedStates,lastLearnMs:finalArb.lastLearnMs},
    shadowLibra:{action:shadowArb.action,direction:shadowArb.tradeDirection,reason:shadowArb.reason,policyScore:shadowArb.policyScore,policySamples:shadowArb.policySamples},why:`${finalArb.reason} Foundation: ${source.why}`});
}

function handleDecision(decision){
  if(!decision?.signalId)return;
  const source=sourceFromDecision(decision);
  if(mission.status!=='ACTIVE')return;
  const gate=checkMission();if(gate.stop)return;
  const shadowArb=brain.decide({ticks:localTicks,sourceDecision:source,openContracts:0,runPnl:gate.runPnl,mode:'SHADOW'});
  const paidArb=mission.phase==='LEARN'?null:brain.decide({ticks:localTicks,sourceDecision:source,openContracts:exposure(),runPnl:gate.runPnl,mode:'PAID'});
  const row=storeDecision(decision,source,shadowArb,paidArb);
  shadowPending.set(decision.signalId,{epoch:Number(decision.signalEpoch),quote:Number(decision.signalQuote),sourceApproved:source.approved,sourceDirection:source.tradeDirection,action:shadowArb.action,libraDirection:shadowArb.tradeDirection,signature:shadowArb.signature,regime:shadowArb.regime,confidence:shadowArb.confidence,horizons:shadowArb.horizons});

  if(mission.phase==='LEARN'){
    row.executionState='SHADOW_ONLY';row.approved=false;row.tradeDirection='NONE';lastArbitration={...shadowArb,action:'SHADOW LEARN',approved:false,tradeDirection:shadowArb.tradeDirection,shadowDirection:shadowArb.tradeDirection,at:Date.now(),signalId:decision.signalId};saveSignals();publish();return;
  }

  const arbitration=paidArb;lastArbitration={...arbitration,at:Date.now(),signalId:decision.signalId};
  if(!arbitration.approved||!['CALL','PUT'].includes(arbitration.tradeDirection)){row.executionState=`LIBRA_${String(arbitration.action).replaceAll(' ','_')}`;saveSignals();publish();return}
  const state=engine.snapshot();if(!state.running){row.executionState='PAID_ENGINE_PAUSED';saveSignals();publish();return}if(state.safeBlocked){row.executionState='SAFE_BLOCK';saveSignals();publish();return}if(exposure()>=MAX_CONCURRENT){row.executionState='EXPOSURE_FULL';saveSignals();publish();return}
  try{
    traderConfig();const room=Math.max(0,MAX_CONCURRENT-exposure()),wanted=Math.min(batchSize(),room,Math.max(0,mission.maxTrades-missionRunTrades())),sent=[];
    for(let slot=1;slot<=wanted;slot+=1){const didSend=engine.execute({direction:arbitration.tradeDirection,structure:`libra-${String(arbitration.action).toLowerCase().replaceAll(' ','-')}-${source.familyId||decision.structure?.tag||'state'}`,epoch:decision.signalEpoch,quote:decision.signalQuote,detectedPerf:perfNow(),detectedWallMs:Date.now(),patternMeta:{signalId:decision.signalId,slot,action:arbitration.action,sourceDirection:source.tradeDirection,libraDirection:arbitration.tradeDirection,regime:arbitration.regime,confidence:arbitration.confidence}});if(didSend)sent.push(slot)}
    row.requestedBatch=sent.length;row.executionState=sent.length?`ORDER_SENT_X${sent.length}`:'NOT_SENT';if(sent.length)engine.log('success',`LIBRA ${mission.phase} · ${arbitration.action} · ${arbitration.tradeDirection} x${sent.length}.`)
  }catch(error){row.executionState='ERROR';row.error=error.message;showError(error.message)}
  saveSignals();publish();
}

function reviewMission(force=false){
  if(mission.status!=='ACTIVE')return;if(!force&&Date.now()<mission.nextReviewAt)return;
  const block=shadowSummary(mission.reviewStartedAt),brainState=brain.snapshot();mission.reviewCount+=1;mission.lastReview={...block,at:Date.now(),brain:{actionAccuracy:brainState.actionAccuracy,shadowLessons:brainState.shadowLessons,generation:brainState.generation}};mission.reviewStartedAt=Date.now();mission.nextReviewAt=Date.now()+REVIEW_MS;
  const enough=block.comparable>=25&&block.libra.trades>=12;
  const ready=enough&&block.libra.winRate>BREAK_EVEN&&block.libra.avg>0&&block.libra.pnl>block.sani.pnl&&brainState.shadowLessons>=20;
  if(mission.phase==='LEARN'){
    if(ready){mission.phase=missionRunPnl()<0?'RECOVER':'WORK';mission.reason=`I've seen enough. Libra shadow ${block.libra.winRate.toFixed(1)}% ${money(block.libra.pnl)} vs SANI ${block.sani.winRate.toFixed(1)}% ${money(block.sani.pnl)}. I earned Demo authority.`;mission.recommendation='WORK';engine.start()}
    else{mission.reason=enough?`Not yet. Libra ${block.libra.winRate.toFixed(1)}% ${money(block.libra.pnl)} vs SANI ${block.sani.winRate.toFixed(1)}% ${money(block.sani.pnl)}. I keep learning.`:`I need more fresh comparable decisions: ${block.comparable}/25. Another 7-minute shadow block.`;mission.recommendation='LEARN'}
  }else{
    const deteriorated=enough&&(block.libra.avg<=0||block.libra.pnl<block.sani.pnl-1);
    if(deteriorated){mission.phase='LEARN';mission.reason=`My edge deteriorated. Libra ${money(block.libra.pnl)} vs SANI ${money(block.sani.pnl)}. Demo orders paused; back to shadow.`;mission.recommendation='LEARN';engine.pause()}
    else{mission.reason=`Review passed. Libra shadow ${block.libra.winRate.toFixed(1)}% ${money(block.libra.pnl)} vs SANI ${block.sani.winRate.toFixed(1)}% ${money(block.sani.pnl)}.`;mission.recommendation=mission.phase}
  }
  publish();
}

const baseBuy=engine.onBuy.bind(engine);engine.onBuy=function(message){const pending=this.pending.get(Number(message.req_id)),meta=pending?.signal?.patternMeta?{...pending.signal.patternMeta}:null;baseBuy(message);const contractId=Number(message?.buy?.contract_id),trade=this.trades.find(item=>Number(item.contractId)===contractId);if(!trade||!meta?.signalId)return;trade.signalId=meta.signalId;trade.patternMeta=meta;contractMeta.set(contractId,meta);const row=upsertSignal(meta.signalId);if(!row.actualTrades.some(item=>Number(item.contractId)===contractId))row.actualTrades.push({contractId,slot:meta.slot,outcome:'OPEN',buyAckMs:trade.sendToAckMs});saveSignals();publish()};
const baseContract=engine.onContract.bind(engine);engine.onContract=function(contract){const id=Number(contract?.contract_id),meta=contractMeta.get(id)||this.trades.find(item=>Number(item.contractId)===id)?.patternMeta;baseContract(contract);if(!meta?.signalId||!(contract?.is_sold||contract?.is_expired))return;const trade=this.trades.find(item=>Number(item.contractId)===id);if(!trade)return;const row=upsertSignal(meta.signalId),item=row.actualTrades.find(entry=>Number(entry.contractId)===id)||{contractId:id,slot:meta.slot};Object.assign(item,{outcome:trade.status==='won'?'WON':trade.status==='lost'?'LOST':String(trade.status||'SOLD').toUpperCase(),profit:trade.profit,entrySpot:trade.entrySpot,exitSpot:trade.exitSpot,entryEpoch:trade.entryTickTime,exitEpoch:trade.exitTickTime,buyAckMs:trade.sendToAckMs});if(!row.actualTrades.some(entry=>Number(entry.contractId)===id))row.actualTrades.push(item);saveSignals();checkMission();publish()};
engine.onTick=function(tick){this.lastTick=tick;this.ticksSeen+=1;postTick(tick);this.emit()};engine.subscribe(()=>publish());

function traderConfig(){const plan=missionPlanFromForm(),config={...engine.config,symbol:currentSymbol(),stake:Number($('ptStake')?.value||1),takeProfit:0,stopLoss:0,maxTrades:5000,duration:FIXED_DURATION,durationUnit:'t',cooldownTicks:0,executionMethod:'direct',oneOpenContract:false,maxSignalToSendMs:250,currency:selectedAccount?.currency||'USD',maxConsecutiveLosses:0,reconnect:true,maxReconnectAttempts:8};if(!(config.stake>0))throw new Error('Stake must be greater than 0.');if(String(selectedAccount?.account_type||'').toLowerCase()==='real')throw new Error('Libra is Demo-only while her adaptive policy is being validated.');if(!engine.snapshot().running)engine.setConfig(config);return{...config,...plan}}
function auth(){const appId=$('ptAppId')?.value?.trim(),token=$('ptToken')?.value?.trim(),accountId=$('ptAccount')?.value;selectedAccount=accounts.find(account=>account.account_id===accountId)||null;if(!appId||!token)throw new Error('App ID and trade token are required.');if(!selectedAccount)throw new Error('Load and select a Deriv Demo account.');if(String(selectedAccount.account_type||'').toLowerCase()==='real')throw new Error('Choose a Demo account for Libra.');return{appId,token,accountId}}
async function api(path,body){const response=await fetch(`/api/${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),cache:'no-store'}),data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||`API ${response.status}`);return data}
async function freshWs(){const data=await api('otp',lastOtpContext||auth());if(!data.url)throw new Error('OTP response missing WebSocket URL.');return data.url}
function showError(message){if(!$('traderError'))return;$('traderError').textContent=message;$('traderError').classList.remove('hidden')}
function clearError(){if(!$('traderError'))return;$('traderError').textContent='';$('traderError').classList.add('hidden')}
function renderAccounts(){const select=$('ptAccount');if(!select)return;select.innerHTML=accounts.length?'':'<option value="">No accounts found</option>';for(const account of accounts){const option=document.createElement('option');option.value=account.account_id;option.textContent=`${String(account.account_type).toUpperCase()} · ${account.account_id} · ${account.currency} ${account.balance}`;select.appendChild(option)}const saved=localStorage.getItem('sani.deriv.accountId');if(saved&&accounts.some(account=>account.account_id===saved&&String(account.account_type).toLowerCase()!=='real'))select.value=saved;const demo=accounts.find(account=>String(account.account_type).toLowerCase()!=='real');if(demo&&(!select.value||String(accounts.find(account=>account.account_id===select.value)?.account_type).toLowerCase()==='real'))select.value=demo.account_id;selectedAccount=accounts.find(account=>account.account_id===select.value)||null;publish()}

function startMission(){clearError();try{auth();const plan=traderConfig();if(engine.running)engine.pause();shadowPending.clear();const now=Date.now();mission={...freshMission(),...plan,id:`L-${now}`,status:'ACTIVE',phase:'LEARN',startedAt:now,deadlineAt:now+plan.durationMinutes*60000,reviewStartedAt:now,nextReviewAt:now+REVIEW_MS,basePnl:Number(engine.snapshot().sessionPnL||0),baseTrades:totalSettled(),reason:'SANI and I are both shadow trading. Nobody is spending money. I am learning decisions, not just direction.',recommendation:'LEARN'};lastArbitration={action:'SHADOW LEARN',approved:false,tradeDirection:'NONE',reason:mission.reason,at:now};publish()}catch(error){showError(error.message)}}
function continueMission(minutes){if(!engine.snapshot().connected){showError('Connect the trader first.');return}const now=Date.now();mission.status='ACTIVE';mission.phase='LEARN';mission.durationMinutes=minutes;mission.deadlineAt=now+minutes*60000;mission.reviewStartedAt=now;mission.nextReviewAt=now+REVIEW_MS;mission.basePnl=Number(engine.snapshot().sessionPnL||0);mission.baseTrades=totalSettled();mission.peakPnl=0;mission.protectedFloor=0;mission.reason=`New ${minutes}-minute mission. I keep my learned brain and return to shadow first.`;engine.pause();shadowPending.clear();publish()}
function bindControls(){
  $('ptLoadAccounts')?.addEventListener('click',async()=>{clearError();try{const appId=$('ptAppId').value.trim(),token=$('ptToken').value.trim();if(!appId||!token)throw new Error('App ID and trade token are required.');$('ptLoadAccounts').disabled=true;const data=await api('accounts',{appId,token});accounts=data.accounts||[];localStorage.setItem('sani.deriv.appId',appId);sessionStorage.setItem('sani.deriv.token',token);renderAccounts()}catch(error){showError(error.message)}finally{$('ptLoadAccounts').disabled=false}});
  $('ptAccount')?.addEventListener('change',()=>{localStorage.setItem('sani.deriv.accountId',$('ptAccount').value);lastOtpContext=null;selectedAccount=accounts.find(account=>account.account_id===$('ptAccount').value)||null;publish()});
  $('ptConnect')?.addEventListener('click',async()=>{clearError();try{traderConfig();lastOtpContext=auth();$('ptConnect').disabled=true;await engine.connect(freshWs)}catch(error){showError(error.message)}finally{$('ptConnect').disabled=false;publish()}});
  $('ptDisconnect')?.addEventListener('click',()=>{mission.status='IDLE';mission.phase='IDLE';mission.reason='Trader disconnected.';engine.disconnect();lastOtpContext=null;publish()});
  $('ptStart')?.addEventListener('click',startMission);
  $('ptPause')?.addEventListener('click',()=>{mission.status='PAUSED';mission.reason='Mission paused. Memory retained.';engine.pause();publish()});
  $('ptStop')?.addEventListener('click',()=>{mission.status='STOPPED';mission.reason='Mission stopped. Memory retained.';engine.stop();publish()});
  $('ptReset')?.addEventListener('click',()=>{try{engine.resetSession();mission=freshMission();signals=[];shadowPending.clear();localStorage.removeItem(SIGNAL_KEY);publish()}catch(error){showError(error.message)}});
  $('libraClearResults')?.addEventListener('click',()=>{if(confirm('Clear Libra trade results? Her learned brain will be retained.')){signals=[];shadowPending.clear();localStorage.removeItem(SIGNAL_KEY);publish()}});
  $('libraResetBrain')?.addEventListener('click',()=>{if(confirm('Erase Libra learned memory and start her brain from zero?')){brain.importState({weights:Array(14).fill(0),bias:0,updates:0,mistakes:0,correct:0,skippedFlats:0,generation:1,stateMemory:{},actionMemory:{},regimeMemory:{},horizonMemory:{},recent:[],shadowRecent:[],shadowLessons:0,shadowMistakes:0,actionWins:0,actionLosses:0,lastLesson:'Memory reset. I am learning from zero.',lastInsight:'I am rebuilding my decision memory.',lastLearnMs:0,lastUpdateAt:0});persistBrain();pendingForecast=null;publish()}})
}

window.addEventListener('sani-observatory-analysis',event=>{const tick=event.detail;if(Number(tick?.archiveCount||0)>localTicks.length+10&&typeof window.SaniObservatory?.getTicks==='function'){const feed=window.SaniObservatory.getTicks().filter(row=>Number.isFinite(+row.epoch)&&Number.isFinite(+row.quote)).sort((a,b)=>a.epoch-b.epoch).slice(-10000);if(feed.length){localTicks=feed;lastTickKey=`${feed.at(-1).epoch}:${feed.at(-1).quote}`;trendSnapshot=trendBudget.hydrate(localTicks)||trendSnapshot;worker?.postMessage({type:'INIT',ticks:localTicks,executionOffset:1,memoryRows:[]});const f=brain.predict(localTicks);pendingForecast=f.ready?{epoch:f.epoch,quote:f.quote,features:[...(f.features||[])],signature:f.signature,probabilityUp:f.probabilityUp,regime:f.regime,confidence:f.confidence}:null;publish();return}}if(tick?.epoch!==undefined&&tick?.quote!==undefined)postTick(tick)});

function boot(){if($('ptAppId'))$('ptAppId').value=localStorage.getItem('sani.deriv.appId')||'';if($('ptToken'))$('ptToken').value=sessionStorage.getItem('sani.deriv.token')||'';bindControls();initWorker();const forecast=brain.predict(localTicks);pendingForecast=forecast.ready?{epoch:forecast.epoch,quote:forecast.quote,features:[...(forecast.features||[])],signature:forecast.signature,probabilityUp:forecast.probabilityUp,regime:forecast.regime,confidence:forecast.confidence}:null;publish();if($('ptAppId')?.value&&$('ptToken')?.value)$('ptLoadAccounts')?.click()}

window.LIBRA={version:LIBRA_VERSION,getSnapshot:()=>makeSnapshot(),getBrain:()=>brain.exportState(),getSignals:()=>signals.map(row=>structuredClone(row)),predict:()=>brain.predict(localTicks),continueMission,startMission,review:()=>reviewMission(true)};
setInterval(()=>publish(),500);
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
