const $ = id => document.getElementById(id);
const money = value => `${Number(value||0)>=0?'+':'-'}$${Math.abs(Number(value||0)).toFixed(2)}`;
const pct = value => `${Number(value||0).toFixed(1)}%`;
const clock = ms => {
  const s=Math.max(0,Math.floor(Number(ms||0)/1000));
  return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
};
const conf = (arb,prediction) => Number(arb?.confidence ?? prediction?.confidence ?? 0);

window.LIBRA_PHASE_UI_ACTIVE = true;
const stable={headline:'',text:'',action:'',direction:'',confidence:'',lesson:'',insight:'',key:'',lastSnapshot:null};
let oracleObserver=null;

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
      <small>WHAT I ACTUALLY LEARNED AT THE LAST REVIEW</small>
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
  if(!oracleObserver){
    const oracle=document.querySelector('.libraOracle');
    if(oracle){
      oracleObserver=new MutationObserver(()=>applyStable());
      oracleObserver.observe(oracle,{subtree:true,childList:true,characterData:true});
    }
  }
}

function reviewBrain(mission={}){
  return mission.lastReview?.brain||{};
}
function thoughtFor(detail){
  const mission=detail.mission||{},arb=detail.arbitration||{},prediction=detail.prediction||{};
  const phase=mission.phase||'IDLE',reviewCount=Number(mission.reviewCount||0),mode=mission.authorityMode||'NONE';
  const rb=reviewBrain(mission);
  const lesson=rb.lastLesson||mission.reason||'I am learning silently until the review.';
  const insight=rb.lastInsight||mission.reason||'I am waiting for the first completed review.';

  if(mission.status&&mission.status!=='ACTIVE'&&mission.status!=='IDLE'&&mission.status!=='PAUSED')return{
    headline:'MISSION REVIEW.',text:`${mission.reason||'The run ended.'} ${mission.recommendation?`My recommendation: ${mission.recommendation}.`:''}`,
    action:mission.status,direction:'NONE',confidence:'',lesson,insight,key:`END:${mission.status}:${mission.lastReview?.at||0}`
  };
  if(phase==='LEARN'){
    if(reviewCount===0)return{
      headline:'FIRST I WATCH. THEN I TOUCH MONEY.',
      text:'For seven minutes SANI and I take virtual entries side by side. Nobody spends Demo money. I am learning which SANI trades to allow, which ones hurt, and when my own entry is better. I will speak again when the review is complete.',
      action:'SHADOW LEARN',direction:'NONE',confidence:'',
      lesson:'No completed review yet. I am learning silently.',
      insight:'No verdict yet. The first real report arrives at the seven-minute review.',key:'LEARN:0'
    };
    return{
      headline:'I REVIEWED IT. I AM STILL LEARNING.',text:mission.reason||'The latest review did not justify paid authority. I am collecting another block without spending Demo money.',
      action:'SHADOW LEARN',direction:'NONE',confidence:'',lesson,insight,key:`LEARN:${reviewCount}:${mission.lastReview?.at||0}`
    };
  }
  if(mode==='SANI_LEADS')return{
    headline:'SANI WON THE REVIEW. I LET HIM WORK.',text:mission.reason||'SANI has the paid edge right now. I keep learning beside him and will review authority again in seven minutes.',
    action:'SANI LEADS',direction:arb.sourceDirection||'NONE',confidence:'',lesson,insight,key:`SANI:${reviewCount}:${mission.lastReview?.at||0}`
  };
  if(mode==='LIBRA_CONTROLS')return{
    headline:"I'VE EARNED THE FINAL HAND.",text:mission.reason||'My shadow decisions have the stronger paid edge. I control which SANI trades pass, which are blocked, replaced, or led by me.',
    action:'LIBRA CONTROL',direction:arb.tradeDirection||'NONE',confidence:`${conf(arb,prediction).toFixed(0)}%`,lesson,insight,key:`LIBRA:${reviewCount}:${mission.lastReview?.at||0}`
  };
  if(mode==='TEAM')return{
    headline:'WE BOTH HAVE EDGE. I CONTROL THE HANDOFF.',text:mission.reason||'SANI and Libra are both profitable. I use retained decision memory to manage the handoff.',
    action:'TEAM',direction:arb.tradeDirection||arb.sourceDirection||'NONE',confidence:`${conf(arb,prediction).toFixed(0)}%`,lesson,insight,key:`TEAM:${reviewCount}:${mission.lastReview?.at||0}`
  };
  if(phase==='RECOVER')return{
    headline:'I AM RECOVERING SELECTIVELY.',text:mission.reason||`Run ${money(mission.runPnl)}. I am not chasing the deficit.`,
    action:'RECOVER',direction:'NONE',confidence:'',lesson,insight,key:`RECOVER:${reviewCount}:${mission.lastReview?.at||0}`
  };
  if(phase==='PROTECT')return{
    headline:'THE PROFIT NOW HAS A FLOOR.',text:mission.reason||`Peak ${money(mission.peakPnl)}. Protected floor ${money(mission.protectedFloor)}. Current ${money(mission.runPnl)}.`,
    action:'PROTECT',direction:'NONE',confidence:'',lesson,insight,key:`PROTECT:${reviewCount}:${mission.lastReview?.at||0}`
  };
  return{headline:'I AM READING THE ROOM.',text:mission.reason||'I am waiting for a mission.',action:'LISTEN',direction:'NONE',confidence:'',lesson,insight,key:`IDLE:${reviewCount}:${mission.startedAt||0}`};
}

function safeSet(id,value){const node=$(id);if(node&&node.textContent!==String(value??''))node.textContent=String(value??'')}
function applyStable(){
  if(!stable.headline)return;
  safeSet('libraVoiceHeadline',stable.headline);
  safeSet('libraVoiceText',stable.text);
  safeSet('libraVoiceAction',stable.action);
  safeSet('libraVoiceDirection',stable.direction);
  safeSet('libraVoiceConfidence',stable.confidence||'—');
  safeSet('libraLastLesson',stable.lesson||'I am learning silently until the next review.');
  safeSet('libraDeepInsight',stable.insight||'I am waiting for the next completed review.');
}
function render(detail){
  installUi();stable.lastSnapshot=detail;
  const mission=detail.mission||{},brain=detail.brain||{},shadows=detail.shadows||{};
  safeSet('libraSaniShadow',`${shadows.sani?.trades||0}T · ${money(shadows.sani?.pnl||0)}`);
  safeSet('libraShadowScore',`${shadows.libra?.trades||0}T · ${money(shadows.libra?.pnl||0)}`);
  safeSet('libraShadowEdge',money(shadows.edge||0));
  safeSet('libraActionAccuracy',pct(brain.actionAccuracy||0));
  safeSet('libraActionStates',String(brain.actionStates||0));
  safeSet('libraNextReview',mission.status==='ACTIVE'?clock(mission.reviewRemainingMs):'—');
  if($('libraHeaderState')&&mission.status==='ACTIVE')safeSet('libraHeaderState',mission.authorityMode&&mission.authorityMode!=='NONE'?mission.authorityMode:mission.phase||'ACTIVE');
  if($('libraRunStatus')&&mission.status==='ACTIVE')safeSet('libraRunStatus',`${mission.phase||'ACTIVE'} · ${mission.authorityMode||'NONE'}`);
  if($('libraReadiness')&&mission.status==='ACTIVE')safeSet('libraReadiness',`${mission.phase} · ${brain.shadowLessons||0} action lessons · ${brain.actionStates||0} retained action states · next review ${clock(mission.reviewRemainingMs)}`);
  const finished=Boolean(mission.status&&!['ACTIVE','IDLE','PAUSED'].includes(mission.status));
  if($('libraMissionNext'))$('libraMissionNext').hidden=!finished;
  if($('libraMissionRecommendation'))safeSet('libraMissionRecommendation',mission.reason||'I am reviewing the run.');
  const next=thoughtFor(detail);
  if(next.key!==stable.key)Object.assign(stable,next);
  applyStable();
}
window.addEventListener('libra-state',event=>render(event.detail||{}));
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',installUi,{once:true});else installUi();
setInterval(applyStable,500);
