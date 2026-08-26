function safeTime(){return new Date().toISOString().replaceAll(':','-').replaceAll('.','-')}
function esc(value){return `"${String(value??'').replaceAll('"','""')}"`}
function download(text,name){const blob=new Blob([text],{type:'text/csv'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),500)}

function exportAudit(){
  const rows=window.LIBRA?.getSignals?.()||[],forward=window.LIBRA_FORWARD_TIMING?.snapshot?.()||{};
  const headers=[
    'created_at','mission_id','mission_phase','authority_mode','signal_id',
    'source_approved','source_direction','signal_epoch','signal_quote','sani_family','sani_edge',
    'regime',
    'legacy_shadow_outcome','legacy_shadow_profit',
    'exec_shadow_outcome','exec_shadow_entry','exec_shadow_exit','exec_shadow_entry_epoch','exec_shadow_exit_epoch','exec_shadow_offset',
    'shadow_libra_action','shadow_libra_direction','shadow_libra_outcome','shadow_libra_profit',
    'teacher_action','teacher_allowed','teacher_reason','teacher_mountain','teacher_moment','teacher_score','teacher_class',
    'execution_state','actual_contracts','actual_outcome','actual_profit','buy_ack_ms','entry_epoch','entry_spot','exit_epoch','exit_spot','signal_to_entry_ticks','entry_slip',
    'forward_version','forward_prearm_confirm','forward_median_ack_ms','forward_latency_hold',
    'brain_generation','brain_updates','brain_confidence','reason'
  ];
  const body=rows.map(row=>{
    const trades=row.actualTrades||[],trade=trades.find(t=>['WON','LOST'].includes(t.outcome))||trades[0]||{},exec=row.shadow||{};
    return[
      new Date(row.createdAt||Date.now()).toISOString(),row.missionId,row.missionPhase,row.authorityMode,row.signalId,
      row.sourceApproved,row.sourceDirection,row.signalEpoch,row.signalQuote,row.pattern?.foundationFamily,row.pattern?.foundationEdge,
      row.libra?.regime,
      row.shadowResult?.sani?.outcome,row.shadowResult?.sani?.profit,
      exec.outcome,exec.entry,exec.exit,exec.entryEpoch,exec.exitEpoch,exec.executionOffset,
      row.shadowLibra?.action,row.shadowLibra?.direction,row.shadowResult?.libra?.outcome,row.shadowResult?.libra?.profit,
      row.teacherAction,row.teacherAllowed,row.teacherReason,row.teacherMountain,row.teacherMoment,row.teacherScore,row.teacherClass,
      row.executionState,trades.length,trade.outcome,trade.profit,trade.buyAckMs,row.paidEntryEpoch??trade.entryEpoch,row.paidEntrySpot??trade.entrySpot,row.paidExitEpoch??trade.exitEpoch,row.paidExitSpot??trade.exitSpot,row.paidSignalToEntryTicks,row.paidEntrySlip,
      forward.version,forward.preArmConfirm,forward.medianBuyAckMs,forward.latencyHeld,
      row.libra?.modelGeneration,row.libra?.updates,row.libra?.confidence,row.libra?.reason||row.why
    ];
  });
  download([headers,...body].map(row=>row.map(esc).join(',')).join('\n'),`sani-libra-audit-${safeTime()}.csv`);
}

function bind(){
  const button=document.getElementById('libraExportCsv');
  if(!button||button.dataset.auditExport==='2')return;
  button.dataset.auditExport='2';
  button.addEventListener('click',event=>{event.preventDefault();event.stopImmediatePropagation();exportAudit()},true);
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind,{once:true});else bind();
setInterval(bind,1500);
window.LIBRA_AUDIT_EXPORT={export:exportAudit};
