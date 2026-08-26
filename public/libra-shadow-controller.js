// Libra's former external shadow wrapper is retired.
// This slot now loads the complete SCHOOL → TEACH SANI → SANI WORK bridge.
import './core/libra-execution-base.mjs';
import './core/libra-sniper.mjs';
import './core/libra-teacher.mjs';
import './core/libra-teacher-execution.mjs';
import './core/libra-audit-export.mjs';

let reviewQueued=false;
let lastReviewKey='';

function requestTeacherReview(detail={}){
  const mission=detail.mission||{};
  if(mission.status!=='ACTIVE'||Number(mission.reviewCount||0)<1||detail.accountType!=='DEMO'||!detail.engine?.connected)return;
  const teacher=window.LIBRA_TEACHER?.snapshot?.();
  if(!teacher?.workReady)return;
  const key=`${mission.id}:${mission.reviewCount}:${teacher.stage}:${teacher.observations}`;
  if(key===lastReviewKey||reviewQueued)return;
  lastReviewKey=key;reviewQueued=true;
  setTimeout(()=>{reviewQueued=false;window.LIBRA?.review?.()},0);
}

window.addEventListener('libra-state',event=>requestTeacherReview(event.detail||{}));
