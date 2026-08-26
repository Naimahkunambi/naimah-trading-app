// Libra's former external shadow wrapper is retired.
// This slot now loads the mountain/sniper learner and the teacher bridge.
// SANI remains the execution hand; Libra learns, certifies, teaches, and audits.
import './core/libra-sniper.mjs';
import { installTeacherExecution } from './core/libra-teacher.mjs';

installTeacherExecution();

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
