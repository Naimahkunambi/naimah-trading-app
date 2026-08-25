const $ = id => document.getElementById(id);
const money = value => `${Number(value||0)>=0?'+':'-'}$${Math.abs(Number(value||0)).toFixed(2)}`;
const pct = value => `${Number(value||0).toFixed(1)}%`;
const clock = ms => {
  const s=Math.max(0,Math.floor(Number(ms||0)/1000));
  return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
};
const conf = (arb,prediction) => Number(arb?.confidence ?? prediction?.confidence ?? 0);

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
      <p id="libraDeepInsight">I am waiting for the first completed review.</p>
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
  const mission=detail.mission||{},arb=detail.arbitration||{},prediction=detail.prediction||{};
  const phase=mission.phase||'IDLE';
  const reviewCount=Number(mission.reviewCount||0);
  const mode=mission.authorityMode||'NONE';
  if(mission.status&&mission.status!=='ACTIVE'&&mission.status!=='IDLE'&&mission.status!=='PAUSED')return{
    headline:'MISSION REVIEW.',
    text:`${mission.reason||'The run ended.'} ${mission.recommendation?`My recommendation: ${mission.recommendation}.`:''}`,
    action:mission.status,direction:'NONE',confidence:'',key:`END:${mission.status}:${mission.reason}`
  };
  if(phase==='LEARN'){
    if(reviewCount===0)return{
      headline:'FIRST I WATCH. THEN I TOUCH MONEY.',
      text:'For seven minutes SANI and I take virtual entries side by side. Nobody spends Demo money. I am learning which SANI trades to allow, which ones hurt, and when my own entry is better. I will speak again when the review is complete.',
      action:'SHADOW LEARN',direction:'NONE',confidence:'',key:'LEARN:0'
    };
    return{
      headline:'I REVIEWED IT. I AM STILL LEARNING.',
      text:mission.reason||'The latest review did not justify paid authority. I am collecting another block without spending Demo money.',
      action:'SHADOW LEARN',direction:'NONE',confidence:'',key:`LEARN:${reviewCount}`
    };
  }
  if(mode==='SANI_LEADS')return{
    headline:'SANI WON THE REVIEW. I LET HIM WORK.',
    text:mission.reason||'SANI has the paid edge right now. I keep shadowing beside him, learning his weak spots, and I will only ask for more authority at the next review.',
    action:'SANI LEADS',direction:arb.sourceDirection||'NONE',confidence:'',key:`SANI:${reviewCount}`
  };
  if(mode==='LIBRA_CONTROLS')return{
    headline:"I'VE EARNED THE FINAL HAND.",
    text:mission.reason||'My shadow decisions have the stronger paid edge. I now control which SANI trades pass, which are blocked, replaced, or led by me.',
    action:'LIBRA CONTROL',direction:arb.tradeDirection||'NONE',confidence:`${conf(arb,prediction).toFixed(0)}%`,key:`LIBRA:${reviewCount}`
  };
  if(mode==='TEAM')return{
    headline:'WE BOTH HAVE EDGE. I CONTROL THE HANDOFF.',
    text:mission.reason||'SANI and Libra are both profitable. SANI keeps producing entries while I use retained decision memory to decide when to agree, block, replace, or lead.',
    action:'TEAM',direction:arb.tradeDirection||arb.sourceDirection||'NONE',confidence:`${conf(arb,prediction).toFixed(0)}%`,key:`TEAM:${reviewCount}`
  };
  if(phase==='RECOVER')return{
    headline:'I AM RECOVERING SELECTIVELY.',
    text:mission.reason||`Run ${money(mission.runPnl)}. I am not chasing the deficit.`,
    action:'RECOVER',direction:'NONE',confidence:'',key:`RECOVER:${reviewCount}`
  };
  if(phase==='PROTECT')return{
    headline:'THE PROFIT NOW HAS A FLOOR.',
    text:mission.reason||`Peak ${money(mission.peakPnl)}. Protected floor ${money(mission.protectedFloor)}. Current ${money(mission.runPnl)}.`,
    action:'PROTECT',direction:'NONE',confidence:'',key:`PROTECT:${reviewCount}:${Math.floor(Number(mission.peakPnl||0))}`
  };
  return{headline:'I AM READING THE ROOM.',text:mission.reason||'I am waiting for a mission.',action:'LISTEN',direction:'NONE',confidence:'',key:`IDLE:${reviewCount}`};
}

function applyStable(){
  if(!stable.headline)return;
  if($('libraVoiceHeadline')&&$('libraVoiceHeadline').textContent!==stable.headline)$('libraVoiceHeadline').textContent=stable.headline;
  if($('libraVoiceText')&&$('libraVoiceText').textContent!==stable.text)$('libraVoiceText').textContent=stable.text;
  if($('libraVoiceAction')&&$('libraVoiceAction').textContent!==stable.action)$('libraVoiceAction').textContent=stable.action;
  if($('libraVoiceDirection')&&$('libraVoiceDirection').textContent!==stable.direction)$('libraVoiceDirection').textContent=stable.direction;
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
  const reviewBrain=mission.lastReview?.brain||{};
  if($('libraDeepInsight'))$('libraDeepInsight').textContent=reviewBrain.lastInsight||mission.reason||'I am waiting for the first completed review.';
  if($('libraHeaderState')&&mission.status==='ACTIVE')$('libraHeaderState').textContent=mission.authorityMode&&mission.authorityMode!=='NONE'?mission.authorityMode:mission.phase||'ACTIVE';
  if($('libraRunStatus')&&mission.status==='ACTIVE')$('libraRunStatus').textContent=`${mission.phase||'ACTIVE'} · ${mission.authorityMode||'NONE'}`;
  if($('libraReadiness')&&mission.status==='ACTIVE')$('libraReadiness').textContent=`${mission.phase} · ${brain.shadowLessons||0} action lessons · ${brain.actionStates||0} retained action states · review ${clock(mission.reviewRemainingMs)}`;
  const finished=Boolean(mission.status&&!['ACTIVE','IDLE','PAUSED'].includes(mission.status));
  if($('libraMissionNext'))$('libraMissionNext').hidden=!finished;
  if($('libraMissionRecommendation'))$('libraMissionRecommendation').textContent=mission.reason||'I am reviewing the run.';
  const next=thoughtFor(detail);
  if(next.key!==stable.key)Object.assign(stable,next,{changedAt:Date.now()});
  applyStable();
}
window.addEventListener('libra-state',event=>render(event.detail||{}));
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',installUi,{once:true});else installUi();
setInterval(applyStable,250);
