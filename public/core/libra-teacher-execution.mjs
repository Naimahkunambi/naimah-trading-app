import { SaniEngine } from './engine.mjs';

let latest={mission:{},accountType:'NONE',signals:[],ticks:[]};
const original=globalThis.__LIBRA_ORIGINAL_SANI_EXECUTE__||SaniEngine.prototype.execute;
const perfNow=()=>globalThis.performance?.now?.()??Date.now();
const MAX_SIGNAL_WALL_AGE_MS=850;

// FAST PATH: libra-state already carries the live signal objects. Do not call
// window.LIBRA.getSignals() on every order because that API structured-clones
// the entire signal history. On long missions that was unnecessary work in the
// millisecond-sensitive path.
function findSignal(id){
  const rows=latest.signals||[];
  const cached=rows.find(r=>r.signalId===id);if(cached)return cached;
  try{const live=window.LIBRA?.getSignals?.();return Array.isArray(live)?live.find(r=>r.signalId===id)||null:null}catch{return null}
}
function emitDecision(taught,signalId){
  const detail={...(taught||{}),signalId,at:Date.now()};
  window.dispatchEvent(new CustomEvent('libra-teacher-decision',{detail}));
  window.dispatchEvent(new CustomEvent(taught?.allowed?'libra-teacher-pass':'libra-teacher-block',{detail}));
}
function blocked(base,action,reason,extra={}){return{...(base||{}),...extra,allowed:false,action,reason}}
function regimeSide(regime){
  const r=String(regime||'UNKNOWN').toUpperCase();
  if(r==='CHOP')return{hardBlock:true,side:'NONE',label:'CHOP'};
  if(r==='BALANCE')return{hardBlock:true,side:'NONE',label:'BALANCE'};
  if(r.startsWith('TRANSITION'))return{hardBlock:true,side:'NONE',label:r};
  if(r.includes('UP'))return{hardBlock:false,side:'CALL',label:r};
  if(r.includes('DOWN'))return{hardBlock:false,side:'PUT',label:r};
  return{hardBlock:false,side:'NONE',label:r};
}

SaniEngine.prototype.execute=function(signal){
  const gateStart=perfNow();
  const mission=latest.mission||{},signalId=signal?.patternMeta?.signalId;
  if(!signalId||mission.status!=='ACTIVE'||mission.phase==='LEARN')return original.call(this,signal);
  if(latest.accountType!=='DEMO')return false;
  const row=findSignal(signalId),direction=signal?.direction||row?.sourceDirection||signal?.patternMeta?.sourceDirection;
  if(!row||!row.sourceApproved||!['CALL','PUT'].includes(direction)||direction!==row.sourceDirection)return false;

  const liveEpoch=Number((latest.ticks||[]).at(-1)?.epoch||0),signalEpoch=Number(row.signalEpoch||signal?.epoch||0);
  const staleTicks=liveEpoch&&signalEpoch?Math.max(0,liveEpoch-signalEpoch):0;
  const signalWallAgeMs=signalEpoch?Math.max(0,Date.now()-signalEpoch*1000):0;
  const pipelineAgeMs=Math.max(0,Date.now()-Number(row.updatedAt||row.createdAt||Date.now()));

  // For a one-tick contract, a decision that survived until the NEXT market tick
  // is no longer the decision we intended to buy. Never chase it.
  if(staleTicks>0){
    const taught=blocked(null,'STALE TICK · BLOCK',`Signal ${signalEpoch} is ${staleTicks} tick(s) behind live ${liveEpoch}. The predicted window already moved; do not chase it.`,{direction,staleTicks,signalWallAgeMs,pipelineAgeMs,executionGuardMs:perfNow()-gateStart});
    emitDecision(taught,signalId);return false;
  }

  // Deriv's 1Hz tick epochs are second-granularity. In the failed run the normal
  // decision arrived ~400–500ms into that second, but one paid order was already
  // 6.4s old. 850ms leaves normal processing room while preventing a late chase.
  if(signalWallAgeMs>MAX_SIGNAL_WALL_AGE_MS){
    const taught=blocked(null,'TOO LATE · BLOCK',`Signal age ${signalWallAgeMs.toFixed(0)}ms exceeded the ${MAX_SIGNAL_WALL_AGE_MS}ms one-tick freshness budget. Skip rather than buy yesterday's idea.`,{direction,staleTicks,signalWallAgeMs,pipelineAgeMs,executionGuardMs:perfNow()-gateStart});
    emitDecision(taught,signalId);return false;
  }

  const rg=regimeSide(row?.libra?.regime||signal?.patternMeta?.regime);
  if(rg.hardBlock){
    const taught=blocked(null,`${rg.label} · HARD BLOCK`,`${rg.label} has no paid directional permission. Zero CALLs, zero PUTs.`,{direction,regime:rg.label,staleTicks,signalWallAgeMs,pipelineAgeMs,executionGuardMs:perfNow()-gateStart});
    emitDecision(taught,signalId);return false;
  }
  if(['CALL','PUT'].includes(rg.side)&&rg.side!==direction){
    const taught=blocked(null,'REGIME CONFLICT · BLOCK',`${rg.label} permits ${rg.side}; SANI proposed ${direction}. Directional disagreement is not a paid trade.`,{direction,regime:rg.label,regimeSide:rg.side,staleTicks,signalWallAgeMs,pipelineAgeMs,executionGuardMs:perfNow()-gateStart});
    emitDecision(taught,signalId);return false;
  }

  const taught=window.LIBRA_TEACHER?.decisionFor?.({...row,direction});
  const finalDecision={...(taught||{}),staleTicks,signalWallAgeMs,pipelineAgeMs,executionGuardMs:perfNow()-gateStart};
  emitDecision(finalDecision,signalId);
  if(!finalDecision?.allowed)return false;
  return original.call(this,signal);
};

window.addEventListener('libra-state',event=>{latest=event.detail||latest});
