const $ = id => document.getElementById(id);
const money = value => `${Number(value||0)>=0?'+':'-'}$${Math.abs(Number(value||0)).toFixed(2)}`;
const pct = value => `${Number(value||0).toFixed(1)}%`;
const clock = ms => {
  const s=Math.max(0,Math.floor(Number(ms||0)/1000));
  return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
};

const stable = {headline:'',text:'',action:'',direction:'',confidence:'',key:'',changedAt:0,lastSnapshot:null};

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

function thoughtFor(detail){
  const mission=detail.mission||{},brain=detail.brain||{},arb=detail.arbitration||{},prediction=detail.prediction||{},shadows=detail.shadows||{};
  const phase=mission.phase||'IDLE';
  if(mission.status&&mission.status!=='ACTIVE'&&mission.status!=='IDLE'&&mission.status!=='PAUSED')return{
    headline:'MISSION REVIEW.',
    text:`${mission.reason||'The run ended.'} ${mission.recommendation?`My recommendation: ${mission.recommendation}.`:''}`,
    action:mission.status,direction:'NONE',confidence:'',key:`END:${mission.status}:${mission.reason}`
  };
  if(phase==='LEARN')return{
    headline:'I AM STILL LEARNING THE DECISION, NOT JUST THE DIRECTION.',
    text:`SANI ${shadows.sani?.trades||0} shadow trades ${money(shadows.sani?.pnl||0)}. I have ${shadows.libra?.trades||0} shadow trades ${money(shadows.libra?.pnl||0)}. Edge ${money(shadows.edge||0)}. ${brain.lastInsight||mission.reason||''} Next review in ${clock(mission.reviewRemainingMs)}.`,
    action:'SHADOW LEARN',direction:arb.shadowDirection||arb.tradeDirection||'NONE',confidence:`${Number(prediction.confidence||0).toFixed(0)}%`,key:`LEARN:${mission.reviewCount}:${brain.generation}:${brain.lastInsight}`
  };
  if(phase==='RECOVER')return{
    headline:'I AM RECOVERING SELECTIVELY.',
    text:`Run ${money(mission.runPnl)}. I am not chasing the deficit. I am only paying for actions whose retained utility is positive. ${brain.lastInsight||mission.reason||''}`,
    action:'RECOVER',direction:arb.tradeDirection||'NONE',confidence:`${Number(arb.confidence??prediction.confidence||0).toFixed(0)}%`,key:`RECOVER:${brain.generation}:${mission.lastReview?.at||0}`
  };
  if(phase==='PROTECT')return{
    headline:'THE PROFIT NOW HAS A FLOOR.',
    text:`Peak ${money(mission.peakPnl)}. Protected floor ${money(mission.protectedFloor)}. Current ${money(mission.runPnl)}. I will keep SANI shadow-running beside me and I will step back if my edge decays.`,
    action:'PROTECT',direction:arb.tradeDirection||'NONE',confidence:`${Number(arb.confidence??prediction.confidence||0).toFixed(0)}%`,key:`PROTECT:${Math.floor(Number(mission.peakPnl||0))}:${mission.reviewCount}`
  };
  if(phase==='WORK')return{
    headline:"I'VE EARNED THE RIGHT TO WORK.",
    text:`I am executing the highest-utility action I know for this state while SANI remains my shadow benchmark. ${brain.lastInsight||mission.reason||''}`,
    action:arb.action||'WORK',direction:arb.tradeDirection||'NONE',confidence:`${Number(arb.confidence??prediction.confidence||0).toFixed(0)}%`,key:`WORK:${arb.action}:${brain.generation}:${mission.reviewCount}`
  };
  return{headline:'I AM READING THE ROOM.',text:brain.lastInsight||brain.lastLesson||'I am waiting for a mission.',action:'LISTEN',direction:'NONE',confidence:'',key:`IDLE:${brain.generation}`};
}

function shouldAccept(next){
  if(!stable.key)return true;
  if(next.key===stable.key)return false;
  const major = next.action!==stable.action || next.headline!==stable.headline;
  if(major && Date.now()-stable.changedAt>1800)return true;
  return Date.now()-stable.changedAt>6500;
}

function applyStable(){
  if(!stable.headline)return;
  if($('libraVoiceHeadline')&&$('libraVoiceHeadline').textContent!==stable.headline)$('libraVoiceHeadline').textContent=stable.headline;
  if($('libraVoiceText')&&$('libraVoiceText').textContent!==stable.text)$('libraVoiceText').textContent=stable.text;
  if($('libraVoiceAction')&&$('libraVoiceAction').textContent!==stable.action)$('libraVoiceAction').textContent=stable.action;
  if($('libraVoiceDirection')&&$('libraVoiceDirection').textContent!==stable.direction)$('libraVoiceDirection').textContent=stable.direction;
  if($('libraVoiceConfidence')&&stable.confidence&&$('libraVoiceConfidence').textContent!==stable.confidence)$('libraVoiceConfidence').textContent=stable.confidence;
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
  if($('libraDeepInsight'))$('libraDeepInsight').textContent=brain.lastInsight||brain.lastLesson||'I am still separating direction from decision quality.';
  if($('libraHeaderState')&&mission.status==='ACTIVE')$('libraHeaderState').textContent=mission.phase||'ACTIVE';
  if($('libraRunStatus')&&mission.status==='ACTIVE')$('libraRunStatus').textContent=`${mission.phase||'ACTIVE'} · ${mission.status}`;
  if($('libraReadiness')&&mission.status==='ACTIVE')$('libraReadiness').textContent=`${mission.phase} · ${brain.shadowLessons||0} action lessons · ${brain.actionStates||0} retained action states · review ${clock(mission.reviewRemainingMs)}`;
  const finished=Boolean(mission.status&&!['ACTIVE','IDLE','PAUSED'].includes(mission.status));
  if($('libraMissionNext'))$('libraMissionNext').hidden=!finished;
  if($('libraMissionRecommendation'))$('libraMissionRecommendation').textContent=mission.reason||'I am reviewing the run.';

  const next=thoughtFor(detail);
  if(shouldAccept(next)){Object.assign(stable,next,{changedAt:Date.now()});}
  applyStable();
}

window.addEventListener('libra-state',event=>render(event.detail||{}));
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',installUi,{once:true});else installUi();
setInterval(applyStable,120);
