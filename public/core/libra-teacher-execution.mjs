import { SaniEngine } from './engine.mjs';

let latest={mission:{},accountType:'NONE'};
const original=globalThis.__LIBRA_ORIGINAL_SANI_EXECUTE__||SaniEngine.prototype.execute;

function findSignal(id){
  try{const rows=window.LIBRA?.getSignals?.();return Array.isArray(rows)?rows.find(r=>r.signalId===id)||null:null}catch{return null}
}
function emitDecision(taught,signalId){
  const detail={...(taught||{}),signalId,at:Date.now(),mountain:taught?.mountain||window.LIBRA_TEACHER?.snapshot?.()?.mountain||null};
  window.dispatchEvent(new CustomEvent('libra-teacher-decision',{detail}));
  window.dispatchEvent(new CustomEvent(taught?.allowed?'libra-teacher-pass':'libra-teacher-block',{detail}));
  return detail;
}

SaniEngine.prototype.execute=function(signal){
  const mission=latest.mission||{},signalId=signal?.patternMeta?.signalId;
  if(!signalId||mission.status!=='ACTIVE'||mission.phase==='LEARN')return original.call(this,signal);
  if(latest.accountType!=='DEMO')return false;
  const row=findSignal(signalId),direction=signal?.direction||row?.sourceDirection||signal?.patternMeta?.sourceDirection;
  if(!row||!row.sourceApproved||!['CALL','PUT'].includes(direction)||direction!==row.sourceDirection)return false;
  const taught=window.LIBRA_TEACHER?.decisionFor?.({...row,direction});
  emitDecision(taught,signalId);
  if(!taught?.allowed)return false;
  return original.call(this,signal);
};

window.addEventListener('libra-state',event=>{latest=event.detail||latest});
