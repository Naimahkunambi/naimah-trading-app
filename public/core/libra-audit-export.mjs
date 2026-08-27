function safeTime(){return new Date().toISOString().replaceAll(':','-').replaceAll('.','-')}
function esc(value){return `"${String(value??'').replaceAll('"','""')}"`}
function download(text,name){const blob=new Blob([text],{type:'text/csv'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),500)}
function isoFromEpoch(epoch){const n=Number(epoch);if(!Number.isFinite(n)||n<=0)return'';return new Date(n>1e12?n:n*1000).toISOString()}
function executionDiagnostic(row){
  if(row?.executionState==='TEACHER_BLOCKED'&&row?.teacherAllowed===true)return'ENGINE_REJECTED_AFTER_TEACHER_PASS';
  if(row?.executionState==='TEACHER_BLOCKED')return'TEACHER_REJECTED';
  if(row?.executionState==='PAID_ENGINE_PAUSED')return'ENGINE_NOT_RUNNING';
  if(row?.executionState==='EXPOSURE_FULL')return'EXPOSURE_LOCK';
  if(row?.executionState==='SAFE_BLOCK')return'SAFE_BLOCK';
  if(String(row?.executionState||'').startsWith('ORDER_SENT'))return'ORDER_SENT';
  return row?.executionState||'';
}

function exportAudit(){
  const snapshot=window.LIBRA?.getSnapshot?.()||{},rows=window.LIBRA?.getSignals?.()||[],forward=window.LIBRA_FORWARD_TIMING?.snapshot?.()||{},mission=snapshot.mission||{},engine=snapshot.engine||{};
  const headers=[
    'row_type','created_at','mission_id','mission_phase','authority_mode','signal_id',
    'source_approved','source_direction','signal_epoch','signal_quote','sani_family','sani_edge',
    'regime',
    'legacy_shadow_outcome','legacy_shadow_profit',
    'exec_shadow_outcome','exec_shadow_entry','exec_shadow_exit','exec_shadow_entry_epoch','exec_shadow_exit_epoch','exec_shadow_offset',
    'shadow_libra_action','shadow_libra_direction','shadow_libra_outcome','shadow_libra_profit',
    'teacher_action','teacher_allowed','teacher_reason','teacher_mountain','teacher_moment','teacher_score','teacher_class',
    'execution_state','execution_diagnostic','actual_contracts','actual_outcome','actual_profit','buy_ack_ms','entry_epoch','entry_spot','exit_epoch','exit_spot','signal_to_entry_ticks','entry_slip',
    'forward_version','forward_prearm_confirm','forward_median_ack_ms','forward_latency_hold',
    'mission_status','mission_run_pnl','mission_peak_pnl','mission_protected_floor','mission_target_profit','mission_hard_stop','mission_run_trades','mission_max_trades','mission_duration_minutes','mission_goal','mission_started_at','mission_deadline_at',
    'engine_status','engine_running','engine_connected','engine_safe_blocked','engine_session_pnl','engine_wins','engine_losses','engine_trade_count','engine_last_error',
    'brain_generation','brain_updates','brain_confidence','reason'
  ];
  const common=[
    forward.version,forward.preArmConfirm,forward.medianBuyAckMs,forward.latencyHeld,
    mission.status,mission.runPnl,mission.peakPnl,mission.protectedFloor,mission.targetProfit,mission.hardStop,mission.runTrades,mission.maxTrades,mission.durationMinutes,mission.goal,isoFromEpoch(mission.startedAt),isoFromEpoch(mission.deadlineAt),
    engine.status,engine.running,engine.connected,engine.safeBlocked,engine.sessionPnL,engine.wins,engine.losses,Array.isArray(engine.trades)?engine.trades.length:0,engine.lastError
  ];
  const representedContracts=new Set();
  const body=rows.map(row=>{
    const trades=row.actualTrades||[];for(const t of trades)if(Number.isFinite(Number(t.contractId)))representedContracts.add(Number(t.contractId));
    const trade=trades.find(t=>['WON','LOST'].includes(t.outcome))||trades[0]||{},exec=row.shadow||{};
    return[
      'SIGNAL',new Date(row.createdAt||Date.now()).toISOString(),row.missionId,row.missionPhase,row.authorityMode,row.signalId,
      row.sourceApproved,row.sourceDirection,row.signalEpoch,row.signalQuote,row.pattern?.foundationFamily,row.pattern?.foundationEdge,
      row.libra?.regime,
      row.shadowResult?.sani?.outcome,row.shadowResult?.sani?.profit,
      exec.outcome,exec.entry,exec.exit,exec.entryEpoch,exec.exitEpoch,exec.executionOffset,
      row.shadowLibra?.action,row.shadowLibra?.direction,row.shadowResult?.libra?.outcome,row.shadowResult?.libra?.profit,
      row.teacherAction,row.teacherAllowed,row.teacherReason,row.teacherMountain,row.teacherMoment,row.teacherScore,row.teacherClass,
      row.executionState,executionDiagnostic(row),trades.length,trade.outcome,trade.profit,trade.buyAckMs,row.paidEntryEpoch??trade.entryEpoch,row.paidEntrySpot??trade.entrySpot,row.paidExitEpoch??trade.exitEpoch,row.paidExitSpot??trade.exitSpot,row.paidSignalToEntryTicks,row.paidEntrySlip,
      ...common,
      row.libra?.modelGeneration,row.libra?.updates,row.libra?.confidence,row.libra?.reason||row.why
    ];
  });

  // The signal ledger is intentionally capped for browser memory. Preserve any settled paid
  // trades whose original signal row has already rolled out of that cap so the audit can still
  // reconstruct the complete paid P/L curve, peak and drawdown.
  for(const trade of engine.trades||[]){
    const contractId=Number(trade?.contractId);if(Number.isFinite(contractId)&&representedContracts.has(contractId))continue;
    const status=String(trade?.status||'').toLowerCase();if(!['won','lost'].includes(status))continue;
    const meta=trade?.patternMeta||{};
    body.push([
      'PAID_LEDGER',isoFromEpoch(trade.entryTickTime||trade.exitTickTime),mission.id,mission.phase,mission.authorityMode,trade.signalId||meta.signalId||'',
      true,meta.sourceDirection||trade.direction||'', '', '', '', '',
      meta.regime||'',
      '','',
      '','','','','','',
      '','','','',
      '','','','','','','',
      'SETTLED_PAID_LEDGER','PAID_TRADE_PRESERVED',1,status==='won'?'WON':'LOST',trade.profit,trade.sendToAckMs,trade.entryTickTime,trade.entrySpot,trade.exitTickTime,trade.exitSpot,'','',
      ...common,
      '','','','Paid trade preserved from engine ledger after its signal row rolled out of the 6,000-signal browser cap.'
    ]);
  }

  download([headers,...body].map(row=>row.map(esc).join(',')).join('\n'),`sani-libra-audit-${safeTime()}.csv`);
}

function bind(){
  const button=document.getElementById('libraExportCsv');
  if(!button||button.dataset.auditExport==='3')return;
  button.dataset.auditExport='3';
  button.addEventListener('click',event=>{event.preventDefault();event.stopImmediatePropagation();exportAudit()},true);
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind,{once:true});else bind();
setInterval(bind,1500);
window.LIBRA_AUDIT_EXPORT={export:exportAudit};
