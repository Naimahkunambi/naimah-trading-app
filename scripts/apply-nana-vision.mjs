import fs from 'node:fs';

const file='public/nana.js';
let s=fs.readFileSync(file,'utf8');
function replaceOnce(before,after,label){if(!s.includes(before))throw new Error(`Nana vision ${label}: marker not found`);s=s.replace(before,after)}

replaceOnce(
"const state={accounts:[],account:null,ticks:[],markers:[],judgments:[],tape:[],awake:false,thinking:false,feed:null,subId:null,lastAiAt:0,aiBackoffUntil:0,aiErrorCount:0,config:loadConfig(),executor:null};",
"const state={accounts:[],account:null,ticks:[],markers:[],judgments:[],tape:[],awake:false,thinking:false,feed:null,subId:null,lastAiAt:0,lastVisionAt:0,aiBackoffUntil:0,aiErrorCount:0,config:loadConfig(),executor:null};",
'state vision clock');

replaceOnce(
"async function askNana(){",
`function captureChartVision(){
  const source=$('chartCanvas');
  if(!source||!source.width||!source.height)return null;
  try{
    const out=document.createElement('canvas');
    out.width=720;out.height=320;
    const ctx=out.getContext('2d');
    ctx.fillStyle='#e9f7ff';ctx.fillRect(0,0,out.width,out.height);
    ctx.drawImage(source,0,0,out.width,out.height);
    return out.toDataURL('image/jpeg',0.52);
  }catch{return null}
}

async function askNana(){`,
'capture chart');

replaceOnce(
"async function askNana(){if(state.thinking||!state.awake||state.ticks.length<120)return;state.thinking=true;state.lastAiAt=Date.now();$('aiStatus').textContent='NANA IS LOOKING...';const snap=state.executor.snapshot();try{",
"async function askNana(){if(state.thinking||!state.awake||state.ticks.length<120)return;state.thinking=true;state.lastAiAt=Date.now();$('aiStatus').textContent='NANA IS LOOKING...';const snap=state.executor.snapshot();const open=Boolean(snap.contract);const visionEvery=open?24000:60000;const visionDue=Date.now()-state.lastVisionAt>=visionEvery;const chartImage=visionDue?captureChartVision():null;if(chartImage)state.lastVisionAt=Date.now();try{",
'vision cadence');

replaceOnce(
"body:JSON.stringify({model:state.config.model,geminiModel:state.config.geminiModel,config:{...state.config,accountMode:accountType()},market:{symbol:state.config.symbol,now:Date.now(),lastPrice:state.ticks.at(-1)?.quote,ticks:state.ticks.slice(-360),derived:derived()},position:snap.contract,recentJudgments:state.judgments.slice(-3)})",
"body:JSON.stringify({model:state.config.model,geminiModel:state.config.geminiModel,chartImage,config:{...state.config,accountMode:accountType()},market:{symbol:state.config.symbol,now:Date.now(),lastPrice:state.ticks.at(-1)?.quote,ticks:state.ticks.slice(-360),derived:derived()},position:snap.contract,recentJudgments:state.judgments.slice(-3)})",
'send chart image');

replaceOnce(
"mode:j.mode||'',models:JSON.stringify(j.models||{})",
"mode:j.mode||'',vision:j.visionUsed?'CHART+DATA':'DATA',models:JSON.stringify(j.models||{})",
'tape vision');

replaceOnce(
"state.aiBackoffUntil=0;state.aiErrorCount=0;state.awake=true;",
"state.aiBackoffUntil=0;state.aiErrorCount=0;state.lastVisionAt=0;state.awake=true;",
'reset vision');

fs.writeFileSync(file,s);
console.log('Nana vision applied: compact chart image every 60s flat / 24s in-position, with structured filmstrip between vision checks.');
