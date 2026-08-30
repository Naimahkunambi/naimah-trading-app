import fs from 'node:fs';

const file='public/nana.js';
let s=fs.readFileSync(file,'utf8');
function one(a,b,label){if(!s.includes(a))throw new Error(`Nana trio moderation ${label}: marker missing`);s=s.replace(a,b)}

one(
"const state={accounts:[],account:null,ticks:[],markers:[],judgments:[],tape:[],awake:false,thinking:false,feed:null,subId:null,lastAiAt:0,config:loadConfig(),executor:null};",
"const state={accounts:[],account:null,ticks:[],markers:[],judgments:[],tape:[],awake:false,thinking:false,feed:null,subId:null,lastAiAt:0,aiBackoffUntil:0,aiErrorCount:0,config:loadConfig(),executor:null};",
'state');

one(
"if(state.awake&&Date.now()-state.lastAiAt>=8000)void askNana()",
"if(state.awake&&Date.now()>=state.aiBackoffUntil){const open=Boolean(state.executor.snapshot().contract);const interval=open?8000:25000;if(Date.now()-state.lastAiAt>=interval)void askNana()}",
'cadence');

one(
"ticks:state.ticks.slice(-600),derived:derived()},position:snap.contract,recentJudgments:state.judgments.slice(-6)",
"ticks:state.ticks.slice(-360),derived:derived()},position:snap.contract,recentJudgments:state.judgments.slice(-3)",
'compact request');

one(
"state.judgments.push({at:Date.now(),...x,model:j.model});state.judgments=state.judgments.slice(-300);renderJudgment(x);tape('JUDGMENT',`${x.action} · ${x.main_move} · ${x.phase} · ${Math.round(x.confidence)}%`,{thesis:x.thesis,evidence:(x.evidence||[]).join(' | '),model:j.model});await actOnJudgment(x)",
"state.aiErrorCount=0;state.aiBackoffUntil=0;state.judgments.push({at:Date.now(),...x,mode:j.mode,brains:j.brains,models:j.models});state.judgments=state.judgments.slice(-300);renderJudgment(x);tape('JUDGMENT',`${x.action} · ${x.main_move} · ${x.phase} · ${Math.round(x.confidence)}%`,{thesis:x.thesis,evidence:(x.evidence||[]).join(' | '),mode:j.mode||'',groq:j.brains?.groq?.action||'',gemini:j.brains?.gemini?.action||'',openrouter:j.brains?.openrouter?.action||''});await actOnJudgment(x)",
'journal trio');

one(
"}catch(e){$('aiStatus').textContent=`AI ERROR · ${e.message}`;tape('AI ERROR',e.message)}finally{",
"}catch(e){state.aiErrorCount+=1;const delay=Math.min(180000,30000*Math.pow(2,Math.min(3,state.aiErrorCount-1)));state.aiBackoffUntil=Date.now()+delay;$('aiStatus').textContent=`AI PAUSED ${Math.round(delay/1000)}s · ${e.message}`;tape('AI ERROR',`${e.message} · retry in ${Math.round(delay/1000)}s`)}finally{",
'backoff');

fs.writeFileSync(file,s);
console.log('Nana trio moderation applied: 25s scout, 8s open-trade, compact context, exponential backoff.');
