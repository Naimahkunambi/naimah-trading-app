const $ = id => document.getElementById(id);
const REVIEW_MS = 7 * 60_000;
const PAYOUT = 0.92;
const BREAK_EVEN = 100 / (1 + PAYOUT);

const state = {
  mode:'IDLE',
  active:false,
  allowNativeStart:false,
  startedAt:0,
  reviewStartedAt:0,
  nextReviewAt:0,
  records:[],
  seen:new Set(),
  lastDetail:null,
  lastNativeMissionStatus:'IDLE',
  reviewCount:0,
  lastReview:null,
  baseSessionPnl:0,
  recommendation:''
};

const money = value => `${Number(value || 0) >= 0 ? '+' : '-'}$${Math.abs(Number(value || 0)).toFixed(2)}`;
const pct = value => `${Number(value || 0).toFixed(1)}%`;
const clock = ms => {
  const sec = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  return `${String(Math.floor(sec / 60)).padStart(2,'0')}:${String(sec % 60).padStart(2,'0')}`;
};

function installUi() {
  const stats = document.querySelector('.libraBrainStats');
  if (stats && !$('libraSaniShadow')) {
    stats.insertAdjacentHTML('beforeend', `
      <div><small>SANI SHADOW</small><strong id="libraSaniShadow">0T · $0.00</strong></div>
      <div><small>LIBRA SHADOW</small><strong id="libraShadowScore">0T · $0.00</strong></div>
      <div><small>SHADOW EDGE</small><strong id="libraShadowEdge">$0.00</strong></div>
      <div><small>NEXT SELF-REVIEW</small><strong id="libraNextReview">—</strong></div>
    `);
  }
  const sourceTitle = document.querySelector('#libraSourceLane small');
  if (sourceTitle) sourceTitle.textContent = 'SANI SHADOW SAYS';
  const finalTitle = document.querySelector('#libraFinalLane small');
  if (finalTitle) finalTitle.textContent = 'LIBRA SHADOW / FINAL HAND';
  const hint = document.querySelector('.libraCommandGrid .libraHint');
  if (hint) hint.textContent = 'START LIBRA turns SANI and Libra on together. First they both paper-trade. Every 7 minutes Libra reviews fresh evidence and only then may unlock Demo execution authority.';
  const oracleButtons = document.querySelector('.libraOracleButtons');
  if (oracleButtons && !$('libraMissionNext')) {
    oracleButtons.insertAdjacentHTML('beforebegin', `
      <section id="libraMissionNext" class="libraLesson" hidden>
        <small>LIBRA'S RECOMMENDATION</small>
        <p id="libraMissionRecommendation">I am reviewing the run.</p>
        <div class="libraOracleButtons">
          <button id="libraContinue10" type="button">CONTINUE 10 MIN</button>
          <button id="libraContinue30" type="button">CONTINUE 30 MIN</button>
          <button id="libraNewMission" type="button">NEW MISSION</button>
        </div>
      </section>
    `);
  }
  bindContinuationButtons();
}

function bindContinuationButtons() {
  if ($('libraContinue10') && !$('libraContinue10').dataset.shadowBound) {
    $('libraContinue10').dataset.shadowBound='1';
    $('libraContinue10').addEventListener('click',()=>resumeNative(10));
  }
  if ($('libraContinue30') && !$('libraContinue30').dataset.shadowBound) {
    $('libraContinue30').dataset.shadowBound='1';
    $('libraContinue30').addEventListener('click',()=>resumeNative(30));
  }
  if ($('libraNewMission') && !$('libraNewMission').dataset.shadowBound) {
    $('libraNewMission').dataset.shadowBound='1';
    $('libraNewMission').addEventListener('click',()=>beginShadowLearning(true));
  }
}

function calibrate(raw, directional=true) {
  if (!directional) return Number(raw || 0);
  return Math.min(95, 50 + Number(raw || 0) * 1.6);
}

function libraShadowDecision(row) {
  const sourceApproved = Boolean(row.sourceApproved);
  const sourceDirection = ['CALL','PUT'].includes(row.sourceDirection) ? row.sourceDirection : 'NONE';
  const rawDirection = row.libra?.direction || 'NONE';
  const libraDirection = rawDirection === 'UP' ? 'CALL' : rawDirection === 'DOWN' ? 'PUT' : 'NONE';
  const regime = row.libra?.regime || 'UNKNOWN';
  const confidence = calibrate(row.libra?.confidence, libraDirection !== 'NONE');
  const clean = !['CHOP','BALANCE'].includes(regime);
  if (regime === 'CHOP' && sourceApproved && confidence < 62) return {action:'BLOCK',direction:'NONE',confidence,regime};
  if (sourceApproved && libraDirection !== 'NONE' && libraDirection === sourceDirection) return {action:'AGREE',direction:sourceDirection,confidence,regime};
  if (sourceApproved && libraDirection !== 'NONE' && libraDirection !== sourceDirection && clean && confidence >= 68) return {action:'REPLACE',direction:libraDirection,confidence,regime};
  if (!sourceApproved && libraDirection !== 'NONE' && clean && confidence >= 72) return {action:'LEAD',direction:libraDirection,confidence,regime};
  if (sourceApproved) return {action:'YIELD',direction:sourceDirection,confidence,regime};
  return {action:'STAND DOWN',direction:'NONE',confidence,regime};
}

function firstFutureTick(ticks, epoch) {
  return (ticks || []).find(tick => Number(tick.epoch) > Number(epoch));
}

function settle(direction, entryQuote, exitQuote, stake) {
  if (!['CALL','PUT'].includes(direction)) return null;
  const actual = Number(exitQuote) > Number(entryQuote) ? 'CALL' : Number(exitQuote) < Number(entryQuote) ? 'PUT' : 'NONE';
  if (actual === 'NONE') return {outcome:'FLAT',profit:0};
  const won = direction === actual;
  return {outcome:won?'WON':'LOST',profit:won ? stake * PAYOUT : -stake};
}

function addRecord(row, detail) {
  if (!row?.signalId || state.seen.has(row.signalId) || !state.active) return;
  state.seen.add(row.signalId);
  const entryEpoch = Number(row.signalEpoch);
  const entryQuote = Number(row.signalQuote);
  if (!Number.isFinite(entryEpoch) || !Number.isFinite(entryQuote)) return;
  const stake = Math.max(0.01, Number($('ptStake')?.value || 1));
  const libra = libraShadowDecision(row);
  const record = {
    signalId:row.signalId,
    createdAt:Number(row.createdAt || Date.now()),
    epoch:entryEpoch,
    quote:entryQuote,
    stake,
    saniDirection:Boolean(row.sourceApproved) ? row.sourceDirection : 'NONE',
    libraDirection:libra.direction,
    action:libra.action,
    confidence:libra.confidence,
    regime:libra.regime,
    sani:null,
    libra:null
  };
  const exit = firstFutureTick(detail.ticks, entryEpoch);
  if (exit) settleRecord(record, exit);
  state.records.push(record);
}

function settleRecord(record, exitTick) {
  if (!record.sani && ['CALL','PUT'].includes(record.saniDirection)) record.sani = settle(record.saniDirection,record.quote,exitTick.quote,record.stake);
  if (!record.libra && ['CALL','PUT'].includes(record.libraDirection)) record.libra = settle(record.libraDirection,record.quote,exitTick.quote,record.stake);
  record.exitEpoch=Number(exitTick.epoch);
  record.exitQuote=Number(exitTick.quote);
}

function settlePending(detail) {
  const lastTick=(detail.ticks||[]).at(-1);
  if (!lastTick) return;
  for (const record of state.records) {
    if (record.exitEpoch || Number(lastTick.epoch) <= record.epoch) continue;
    settleRecord(record,lastTick);
  }
}

function summary(since=0) {
  const rows=state.records.filter(row=>row.createdAt>=since);
  const out={comparable:0,sani:{trades:0,wins:0,losses:0,pnl:0},libra:{trades:0,wins:0,losses:0,pnl:0}};
  for (const row of rows) {
    if (row.sani || row.libra) out.comparable += 1;
    for (const key of ['sani','libra']) {
      const result=row[key];
      if(!result || result.outcome==='FLAT') continue;
      out[key].trades += 1;
      out[key].pnl += Number(result.profit||0);
      if(result.outcome==='WON') out[key].wins += 1; else if(result.outcome==='LOST') out[key].losses += 1;
    }
  }
  for(const key of ['sani','libra']) {
    const side=out[key], decided=side.wins+side.losses;
    side.winRate=decided?side.wins/decided*100:0;
    side.avg=side.trades?side.pnl/side.trades:0;
    side.pnl=Number(side.pnl.toFixed(2));
  }
  out.edge=Number((out.libra.pnl-out.sani.pnl).toFixed(2));
  return out;
}

function review(force=false) {
  if(!state.active) return;
  const now=Date.now();
  if(!force && now<state.nextReviewAt) return;
  const block=summary(state.reviewStartedAt);
  state.reviewCount += 1;
  state.lastReview={...block,at:now,review:state.reviewCount};
  state.reviewStartedAt=now;
  state.nextReviewAt=now+REVIEW_MS;
  const enough=block.comparable>=25 && block.libra.trades>=12;
  const ready=enough && block.libra.winRate>BREAK_EVEN && block.libra.avg>0 && block.libra.pnl>block.sani.pnl;
  if(state.mode==='LEARN') {
    if(ready) {
      state.mode='PAID';
      state.recommendation=`I have enough fresh evidence. Libra shadow ${pct(block.libra.winRate)} ${money(block.libra.pnl)} vs SANI ${pct(block.sani.winRate)} ${money(block.sani.pnl)}. I am unlocking Demo execution.`;
      nativeStart();
    } else {
      state.recommendation=enough
        ? `Not yet. Libra shadow ${pct(block.libra.winRate)} ${money(block.libra.pnl)} vs SANI ${pct(block.sani.winRate)} ${money(block.sani.pnl)}. Another 7-minute block.`
        : `Not enough comparable setups yet: ${block.comparable}/25. SANI and Libra stay virtual for another 7 minutes.`;
    }
  } else if(state.mode==='PAID') {
    const deteriorated=enough && block.libra.avg<0 && block.libra.pnl<block.sani.pnl-1;
    if(deteriorated) {
      state.mode='LEARN';
      state.recommendation=`My shadow edge deteriorated. Libra ${money(block.libra.pnl)} vs SANI ${money(block.sani.pnl)}. I am pausing Demo orders and returning to virtual learning.`;
      $('ptPause')?.click();
    } else {
      state.recommendation=`7-minute review passed. Libra shadow ${pct(block.libra.winRate)} ${money(block.libra.pnl)} vs SANI ${pct(block.sani.winRate)} ${money(block.sani.pnl)}.`;
    }
  }
}

function nativeStart() {
  state.allowNativeStart=true;
  $('ptStart')?.click();
  queueMicrotask(()=>{state.allowNativeStart=false;});
}

function beginShadowLearning(reset=true) {
  const detail=state.lastDetail;
  if(!detail?.engine?.connected) {
    const box=$('traderError');
    if(box){box.textContent='Connect the Demo trader first. SANI and Libra need the live feed before shadow learning starts.';box.classList.remove('hidden');}
    return;
  }
  state.active=true;
  state.mode='LEARN';
  state.startedAt=Date.now();
  state.reviewStartedAt=state.startedAt;
  state.nextReviewAt=state.startedAt+REVIEW_MS;
  state.baseSessionPnl=Number(detail.engine.sessionPnL||0);
  state.recommendation='SANI and Libra are both ON in shadow. No Demo order is being sent yet.';
  if(reset){state.records=[];state.seen=new Set();state.reviewCount=0;state.lastReview=null;}
  renderController(detail);
}

function resumeNative(minutes) {
  if($('libraDuration')) $('libraDuration').value=String(minutes);
  state.active=true;
  state.mode='PAID';
  state.reviewStartedAt=Date.now();
  state.nextReviewAt=Date.now()+REVIEW_MS;
  state.recommendation=`Continuing for ${minutes} minutes without disconnecting or resetting Libra's brain.`;
  nativeStart();
}

function endRecommendation(detail) {
  const all=summary(state.startedAt);
  const pnl=Number(detail?.mission?.runPnl ?? 0);
  const prediction=detail?.prediction||{};
  if(pnl>0 && prediction.regime==='CHOP') return `BANK IT. You are ${money(pnl)} up and the current tape is CHOP.`;
  if(all.libra.avg>0 && all.libra.pnl>=all.sani.pnl && prediction.regime!=='CHOP') return `CONTINUE. Libra shadow remains ahead of SANI by ${money(all.edge)} and the tape is still usable.`;
  if(pnl<0 && all.libra.avg>0) return `CONTINUE CAREFULLY. The run is down, but Libra's shadow policy is still positive.`;
  return `STOP OR WAIT. I do not have enough fresh edge to justify forcing another run.`;
}

function renderController(detail) {
  installUi();
  const all=summary(state.startedAt);
  if($('libraSaniShadow')) $('libraSaniShadow').textContent=`${all.sani.trades}T · ${money(all.sani.pnl)}`;
  if($('libraShadowScore')) $('libraShadowScore').textContent=`${all.libra.trades}T · ${money(all.libra.pnl)}`;
  if($('libraShadowEdge')) $('libraShadowEdge').textContent=money(all.edge);
  if($('libraNextReview')) $('libraNextReview').textContent=state.active?clock(state.nextReviewAt-Date.now()):'—';
  if(state.mode==='LEARN') {
    if($('libraHeaderState')) $('libraHeaderState').textContent='SHADOW LEARN';
    if($('libraRunStatus')) $('libraRunStatus').textContent='LEARN · VIRTUAL';
    if($('libraCommandAction')) $('libraCommandAction').textContent='SHADOW LEARN';
    if($('libraCommandReason')) $('libraCommandReason').textContent=state.recommendation;
    if($('libraVoiceHeadline')) $('libraVoiceHeadline').textContent='SANI AND I ARE BOTH PAPER TRADING.';
    if($('libraVoiceText')) $('libraVoiceText').textContent=`Nobody is spending money yet. I am comparing SANI with my own decisions. Next self-review in ${clock(state.nextReviewAt-Date.now())}.`;
    if($('libraVoiceAction')) $('libraVoiceAction').textContent='SHADOW LEARN';
    if($('libraSafetyState')) $('libraSafetyState').textContent='VIRTUAL ONLY';
    if($('libraReadiness')) $('libraReadiness').textContent=`SANI ${all.sani.trades} shadow trades · LIBRA ${all.libra.trades} · review ${clock(state.nextReviewAt-Date.now())}`;
  } else if(state.mode==='PAID') {
    if($('libraHeaderState')) $('libraHeaderState').textContent='WORK';
    if($('libraCommandReason')) $('libraCommandReason').textContent=state.recommendation;
  }
  const missionStatus=detail?.mission?.status||'IDLE';
  const finished=['TIME','TARGET','HARD STOP','CAP','STOPPED'].includes(missionStatus);
  if(finished) {
    state.mode='REVIEW';
    state.recommendation=endRecommendation(detail);
    const panel=$('libraMissionNext');
    if(panel) panel.hidden=false;
    if($('libraMissionRecommendation')) $('libraMissionRecommendation').textContent=state.recommendation;
    if($('libraVoiceHeadline')) $('libraVoiceHeadline').textContent='MISSION REVIEW.';
    if($('libraVoiceText')) $('libraVoiceText').textContent=`${detail.mission.reason||''} ${state.recommendation}`.trim();
  }
}

function process(detail) {
  state.lastDetail=detail;
  installUi();
  settlePending(detail);
  const rows=[...(detail.signals||[])].sort((a,b)=>Number(a.createdAt||0)-Number(b.createdAt||0));
  for(const row of rows) addRecord(row,detail);
  review(false);
  setTimeout(()=>renderController(detail),0);
  state.lastNativeMissionStatus=detail?.mission?.status||state.lastNativeMissionStatus;
}

document.addEventListener('click',event=>{
  const start=event.target?.closest?.('#ptStart');
  if(!start) return;
  if(state.allowNativeStart) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  beginShadowLearning(true);
},true);

window.addEventListener('libra-state',event=>process(event.detail||{}));
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',installUi,{once:true}); else installUi();