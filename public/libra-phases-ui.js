const $ = id => document.getElementById(id);
const money = value => `${Number(value||0)>=0?'+':'-'}$${Math.abs(Number(value||0)).toFixed(2)}`;
const pct = value => `${Number(value||0).toFixed(1)}%`;
const clock = ms => {
  const s=Math.max(0,Math.floor(Number(ms||0)/1000));
  return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
};
const conf = (arb,prediction) => Number(arb?.confidence ?? prediction?.confidence ?? 0);

const stable={headline:'',text:'',action:'',direction:'',confidence:'',reviewKey:'',phase:'',lastSnapshot:null};

function installUi(){
  const stats=document.querySelector('.libraBrainStats');
  if(stats&&!$('libraSaniShadow'))stats.insertAdjacentHTML('beforeend',`
    <div><small>SANI SHADOW</small><strong id="libraSaniShadow">0T · +$0.00</strong></div>
    <div><small>LIBRA SHADOW</small><strong id="libraShadowScore">0T · +$0.00</strong></div>
    <div><small>SHADOW EDGE</small><strong id="libraShadowEdge">+$0.00</strong></div>
    <div><small>ACTION ACCURACY</small><strong id="libraActionAccuracy">0.0%</strong></div>
    <div><small>ACTION MEMORY</small><strong id="libraActionStates">0</strong></div>
    <div><small>NEXT SELF-REVIEW</small><strong id="libraNextReview">—</strong></div>`);
  const lesson=document.querySelector('.libraLesson');
  if(lesson&&!$('libraDeepThought'))lesson.insertAdjacentHTML('afterend',`
    <div class="libraLesson" id="libraDeepThought">
      <small>WHAT I ACTUALLY LEARNED</small>
      <p id="libraDeepInsight">I am still separating direction from decision quality.</p>
    </div>`);
  const buttons=document.querySelector('.libraOracleButtons');
  if(buttons&&!$('libraContinue10'))buttons.insertAdjacentHTML('beforebegin',`
    <section id="libraMissionNext" class="libraLesson" hidden>
      <small>LIBRA'S NEXT MOVE</small>
      <p id="libraMissionRecommendation">I am reviewing the run.</p>
      <div class="libraOracleButtons">
        <button id="libraContinue10" type="button">CONTINUE 10 MIN</button>
        <button id="libraContinue30" type="button">CONTINUE 30 MIN</button>
        <button id="libraReviewNow" type="button">REVIEW NOW</button>
      </div>
    </section>`);
  if($('libraContinue10')&&!$('libraContinue10').dataset.bound){$('libraContinue10').dataset.bound='1';$('libraContinue10').onclick=()=>window.LIBRA?.continueMission?.(10)}
  if($('libraContinue30')&&!$('libraContinue30').dataset.bound){$('libraContinue30').dataset.bound='1';$('libraContinue30').onclick=()=>window.LIBRA?.continueMission?.(30)}
  if($('libraReviewNow')&&!$('libraReviewNow').dataset.bound){$('libraReviewNow').dataset.bound='1';$('libraReviewNow').onclick=()=>window.LIBRA?.review?.()}
}

function reviewSnapshot(detail){
  const mission=detail.mission||{},brain=detail.brain||{},shadows=detail.shadows||{};
  const last=mission.lastReview||null;
  if(last?.cumulative)return {sani:last.cumulative.sani,libra:last.cumulative.libra,edge:last.cumulative.edge,insight:last.brain?.lastInsight||last.brain?.lastLesson||mission.reason||''};
  if(last?.block)return {sani:last.block.sani,libra:last.block.libra,edge:last.block.edge,insight:last.brain?.lastInsight||last.brain?.lastLesson||mission.reason||''};
  return {sani:shadows.sani||{},libra:shadows.libra||{},edge:shadows.edge||0,insight:mission.reason||brain.lastInsight||''};
}

function thoughtFor(detail){
  const mission=detail.mission||{},brain=detail.brain||{},arb=detail.arbitration||{},prediction=detail.prediction||{};
  const phase=mission.phase||'IDLE';
  const snap=reviewSnapshot(detail);
  if(mission.status&&mission.status!=='ACTIVE'&&mission.status!=='IDLE'&&mission.status!=='PAUSED')return{
    headline:'MISSION REVIEW.',
    text:`${mission.reason||'The run ended.'} ${mission.recommendation?`My recommendation: ${mission.recommendation}.`:''}`,
    action:mission.status,direction:'NONE',confidence:'',reviewKey:`END:${mission.status}:${mission.reason}`,phase
  };
  if(phase==='LEARN')return{
    headline:mission.reviewCount>0?'I REVIEWED IT. I AM STILL LEARNING.':'FIRST I WATCH. THEN I TOUCH MONEY.',
    text:mission.reviewCount>0
      ? `${mission.reason||''} Last completed review: SANI ${snap.sani?.trades||0} trades ${money(snap.sani?.pnl||0)}; Libra ${snap.libra?.trades||0} trades ${money(snap.libra?.pnl||0)}; edge ${money(snap.edge||0)}. I keep learning silently until the next seven-minute review.`
      : `For seven minutes SANI and I take virtual entries side by side. Nobody spends Demo money. I am learning which SANI trades to allow, block, replace, and when I should lead. I will speak again when the review is complete.`,
    action:'SHADOW LEARN',direction:'NONE',confidence:'',reviewKey:`LEARN:${mission.reviewCount}:${mission.lastReview?.at||mission.startedAt||0}`,phase
  };
  if(phase==='RECOVER')return{
    headline:'I AM RECOVERING SELECTIVELY.',
    text:`${mission.reason||''} I am not chasing the deficit. SANI still proposes trades, and I control the final paid hand while shadow-scoring both of us for the next review.`,
    action:'RECOVER',direction:'NONE',confidence:'',reviewKey:`RECOVER:${mission.reviewCount}:${mission.lastReview?.at||0}`,phase
  };
  if(phase==='PROTECT')return{
    headline:'THE PROFIT NOW HAS A FLOOR.',
    text:`${mission.reason||''} Peak ${money(mission.peakPnl)}. Protected floor ${money(mission.protectedFloor)}. I will not rewrite this page every tick. My next report comes at the seven-minute review unless the mission stops.`,
    action:'PROTECT',direction:'NONE',confidence:'',reviewKey:`PROTECT:${mission.reviewCount}:${mission.lastReview?.at||0}`,phase
  };
  if(phase==='WORK')return{
    headline:"I'VE SEEN ENOUGH. NOW WE WORK TOGETHER.",
    text:`${mission.reason||''} SANI continues generating its entries. I am not replacing SANI as the strategy. I am controlling the final hand: allow good SANI entries, block the mistakes I learned, replace when the opposite has better retained utility, and lead only when I have a stronger edge.`,
    action:'WORK',direction:'NONE',confidence:'',reviewKey:`WORK:${mission.reviewCount}:${mission.lastReview?.at||0}`,phase
  };
  return{headline:'I AM READING THE ROOM.',text:mission.reason||brain.lastInsight||brain.lastLesson||'I am waiting for a mission.',action:'LISTEN',direction:'NONE',confidence:'',reviewKey:`IDLE:${mission.status}:${mission.startedAt||0}`,phase};
}

function setStable(next){
  if(stable.reviewKey===next.reviewKey&&stable.phase===next.phase)return;
  Object.assign(stable,next);
}
function applyStable(){
  if(!stable.headline)return;
  if($('libraVoiceHeadline'))$('libraVoiceHeadline').textContent=stable.headline;
  if($('libraVoiceText'))$('libraVoiceText').textContent=stable.text;
  if($('libraVoiceAction'))$('libraVoiceAction').textContent=stable.action;
  if($('libraVoiceDirection'))$('libraVoiceDirection').textContent=stable.direction;
  if($('libraVoiceConfidence'))$('libraVoiceConfidence').textContent=stable.confidence||'—';
}
function render(detail){
  installUi();stable.lastSnapshot=detail;
  const mission=detail.mission||{},brain=detail.brain||{},shadows=detail.shadows||{};
  if($('libraSaniShadow'))$('libraSaniShadow').textContent=`${shadows.sani?.trades||0}T · ${money(shadows.sani?.pnl||0)}`;
  if($('libraShadowScore'))$('libraShadowScore').textContent=`${shadows.libra?.trades||0}T · ${money(shadows.libra?.pnl||0)}`;
  if($('libraShadowEdge'))$('libraShadowEdge').textContent=money(shadows.edge||0);
  if($('libraActionAccuracy'))$('libraActionAccuracy').textContent=pct(brain.actionAccuracy||0);
  if($('libraActionStates'))$('libraActionStates').textContent=String(brain.actionStates||0);
  if($('libraNextReview'))$('libraNextReview').textContent=mission.status==='ACTIVE'?clock(mission.reviewRemainingMs):'—';
  if($('libraDeepInsight')){
    const reviewInsight=mission.lastReview?.brain?.lastInsight||mission.lastReview?.brain?.lastLesson;
    $('libraDeepInsight').textContent=reviewInsight||mission.reason||'I am learning silently. The detailed lesson updates at the seven-minute review.';
  }
  if($('libraHeaderState')&&mission.status==='ACTIVE')$('libraHeaderState').textContent=mission.phase||'ACTIVE';
  if($('libraRunStatus')&&mission.status==='ACTIVE')$('libraRunStatus').textContent=`${mission.phase||'ACTIVE'} · ${mission.status}`;
  if($('libraReadiness')&&mission.status==='ACTIVE')$('libraReadiness').textContent=`${mission.phase} · ${brain.shadowLessons||0} action lessons · ${brain.actionStates||0} retained action states · next review ${clock(mission.reviewRemainingMs)}`;
  const finished=Boolean(mission.status&&!['ACTIVE','IDLE','PAUSED'].includes(mission.status));
  if($('libraMissionNext'))$('libraMissionNext').hidden=!finished;
  if($('libraMissionRecommendation'))$('libraMissionRecommendation').textContent=mission.reason||'I am reviewing the run.';
  setStable(thoughtFor(detail));
  applyStable();
}
window.addEventListener('libra-state',event=>render(event.detail||{}));
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',installUi,{once:true});else installUi();
setInterval(applyStable,250);
