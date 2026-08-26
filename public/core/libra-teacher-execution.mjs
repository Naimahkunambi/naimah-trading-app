import { SaniEngine } from './engine.mjs';

let latest={mission:{},accountType:'NONE'};
const original=globalThis.__LIBRA_ORIGINAL_SANI_EXECUTE__||SaniEngine.prototype.execute;

function findSignal(id){
  try{const rows=window.LIBRA?.getSignals?.();return Array.isArray(rows)?rows.find(r=>r.signalId===id)||null:null}catch{return null}
}

SaniEngine.prototype.execute=function(signal){
  const mission=latest.mission||{},signalId=signal?.patternMeta?.signalId;
  if(!signalId||mission.status!=='ACTIVE'||mission.phase==='LEARN')return original.call(this,signal);
  if(latest.accountType!=='DEMO')return false;
  const row=findSignal(signalId),direction=signal?.direction||row?.sourceDirection||signal?.patternMeta?.sourceDirection;
  if(!row||!row.sourceApproved||!['CALL','PUT'].includes(direction)||direction!==row.sourceDirection)return false;
  const taught=window.LIBRA_TEACHER?.decisionFor?.({...row,direction});
  if(!taught?.allowed){
    window.dispatchEvent(new CustomEvent('libra-teacher-block',{detail:{...(taught||{}),signalId,at:Date.now()}}));
    return false;
  }
  window.dispatchEvent(new CustomEvent('libra-teacher-pass',{detail:{...taught,signalId,at:Date.now()}}));
  return original.call(this,signal);
};

window.addEventListener('libra-state',event=>{latest=event.detail||latest});
