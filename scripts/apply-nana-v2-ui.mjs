import fs from 'node:fs';

const file='public/nana.js';
let s=fs.readFileSync(file,'utf8');
function replaceOnce(before,after,label){if(!s.includes(before))throw new Error(`Nana duo ${label}: marker not found`);s=s.replace(before,after)}

replaceOnce(
"const state={accounts:[],account:null,ticks:[],markers:[],judgments:[],tape:[],awake:false,thinking:false,feed:null,subId:null,lastAiAt:0,config:loadConfig(),executor:null};",
"const state={accounts:[],account:null,ticks:[],markers:[],judgments:[],tape:[],awake:false,thinking:false,feed:null,subId:null,lastAiAt:0,aiBackoffUntil:0,aiErrorCount:0,config:loadConfig(),executor:null};",
'state backoff');
replaceOnce(
"function loadConfig(){try{return{maxRiskPerTrade:1,maxSessionLoss:10,profitTarget:160,maxOpenTrades:1,maxTradeSeconds:300,market:'Volatility 25 (1s)',symbol:'1HZ25V',multiplier:160,model:'openrouter/auto',...JSON.parse(localStorage.getItem(KEY)||'{}')}}catch{return{maxRiskPerTrade:1,maxSessionLoss:10,profitTarget:160,maxOpenTrades:1,maxTradeSeconds:300,market:'Volatility 25 (1s)',symbol:'1HZ25V',multiplier:160,model:'openrouter/auto'}}}",
"function loadConfig(){try{const saved=JSON.parse(localStorage.getItem(KEY)||'{}');return{maxRiskPerTrade:1,maxSessionLoss:10,profitTarget:160,maxOpenTrades:1,maxTradeSeconds:300,market:'Volatility 25 (1s)',symbol:'1HZ25V',multiplier:160,model:'qwen/qwen3.8-27b',geminiModel:'gemini-2.5-flash',...saved,model:saved.model==='openai/gpt-oss-120b'||saved.model==='openrouter/auto'?'qwen/qwen3.8-27b':(saved.model||'qwen/qwen3.8-27b')}}catch{return{maxRiskPerTrade:1,maxSessionLoss:10,profitTarget:160,maxOpenTrades:1,maxTradeSeconds:300,market:'Volatility 25 (1s)',symbol:'1HZ25V',multiplier:160,model:'qwen/qwen3.8-27b',geminiModel:'gemini-2.5-flash'}}}",
'config defaults');
replaceOnce(
"function saveConfig(){state.config={...state.config,maxRiskPerTrade:Number($('maxRisk').value||1),maxSessionLoss:Number($('maxLoss').value||10),profitTarget:Number($('profitTarget').value||160),maxOpenTrades:1,maxTradeSeconds:Number($('maxTradeSeconds').value||300),market:'Volatility 25 (1s)',symbol:$('symbol').value,multiplier:Number($('multiplier').value||160),model:$('model').value.trim()||'openrouter/auto'};localStorage.setItem(KEY,JSON.stringify(state.config));syncConfig();tape('CONFIG','Nana laws saved.',state.config)}",
"function saveConfig(){state.config={...state.config,maxRiskPerTrade:Number($('maxRisk').value||1),maxSessionLoss:Number($('maxLoss').value||10),profitTarget:Number($('profitTarget').value||160),maxOpenTrades:1,maxTradeSeconds:Number($('maxTradeSeconds').value||300),market:'Volatility 25 (1s)',symbol:$('symbol').value,multiplier:Number($('multiplier').value||160),model:$('model').value.trim()||'qwen/qwen3.8-27b',geminiModel:$('geminiModel').value.trim()||'gemini-2.5-flash'};localStorage.setItem(KEY,JSON.stringify(state.config));syncConfig();tape('CONFIG','Nana laws saved.',state.config)}",
'config save');
replaceOnce(
"function syncConfig(){const c=state.config;$('maxRisk').value=c.maxRiskPerTrade;$('maxLoss').value=c.maxSessionLoss;$('profitTarget').value=c.profitTarget;$('maxTradeSeconds').value=c.maxTradeSeconds;$('symbol').value=c.symbol;$('multiplier').value=String(c.multiplier);$('model').value=c.model;$('hudMission').textContent=`+$${Number(c.profitTarget).toFixed(0)}`}",
"function syncConfig(){const c=state.config;$('maxRisk').value=c.maxRiskPerTrade;$('maxLoss').value=c.maxSessionLoss;$('profitTarget').value=c.profitTarget;$('maxTradeSeconds').value=c.maxTradeSeconds;$('symbol').value=c.symbol;$('multiplier').value=String(c.multiplier);$('model').value=c.model;$('geminiModel').value=c.geminiModel||'gemini-2.5-flash';$('hudMission').textContent=`+$${Number(c.profitTarget).toFixed(0)}`}",
'config sync');
replaceOnce(
"if(state.awake&&Date.now()-state.lastAiAt>=8000)void askNana()",
"if(state.awake&&Date.now()>=state.aiBackoffUntil){const open=Boolean(state.executor.snapshot().contract);const interval=open?8000:25000;if(Date.now()-state.lastAiAt>=interval)void askNana()}",
'AI cadence');
replaceOnce(
"body:JSON.stringify({model:state.config.model,config:{...state.config,accountMode:accountType()},market:{symbol:state.config.symbol,now:Date.now(),lastPrice:state.ticks.at(-1)?.quote,ticks:state.ticks.slice(-600),derived:derived()},position:snap.contract,recentJudgments:state.judgments.slice(-6)})",
"body:JSON.stringify({model:state.config.model,geminiModel:state.config.geminiModel,config:{...state.config,accountMode:accountType()},market:{symbol:state.config.symbol,now:Date.now(),lastPrice:state.ticks.at(-1)?.quote,ticks:state.ticks.slice(-360),derived:derived()},position:snap.contract,recentJudgments:state.judgments.slice(-3)})",
'AI request models');
replaceOnce(
"state.judgments.push({at:Date.now(),...x,model:j.model});state.judgments=state.judgments.slice(-300);renderJudgment(x);tape('JUDGMENT',`${x.action} · ${x.main_move} · ${x.phase} · ${Math.round(x.confidence)}%`,{thesis:x.thesis,evidence:(x.evidence||[]).join(' | '),model:j.model});await actOnJudgment(x)",
"state.aiErrorCount=0;state.aiBackoffUntil=0;state.judgments.push({at:Date.now(),...x,models:j.models,consensus:j.consensus});state.judgments=state.judgments.slice(-300);renderJudgment(x);tape('JUDGMENT',`${x.action} · ${x.main_move} · ${x.phase} · ${Math.round(x.confidence)}%`,{thesis:x.thesis,evidence:(x.evidence||[]).join(' | '),groq:j.consensus?.groq?.action||'',gemini:j.consensus?.gemini?.action||'',mode:j.mode||'',models:JSON.stringify(j.models||{})});await actOnJudgment(x)",
'consensus tape');
replaceOnce(
"}catch(e){$('aiStatus').textContent=`AI ERROR · ${e.message}`;tape('AI ERROR',e.message)}finally{",
"}catch(e){state.aiErrorCount+=1;const delay=Math.min(180000,30000*Math.pow(2,Math.min(3,state.aiErrorCount-1)));state.aiBackoffUntil=Date.now()+delay;$('aiStatus').textContent=`AI PAUSED ${Math.round(delay/1000)}s · ${e.message}`;tape('AI ERROR',`${e.message} · Nana will retry in ${Math.round(delay/1000)}s.`)}finally{",
'error backoff');
replaceOnce(
"function wake(){if(!state.executor.snapshot().connected)return tape('BLOCKED','Connect a Deriv account before waking Nana.');state.awake=true;renderAwake();tape('SYSTEM','Nana is awake and watching the market.');void askNana()}",
"function wake(){if(!window.__NANA_AI__?.has?.())return tape('BLOCKED','Add BOTH Groq and Gemini API keys on Page 1 before starting Nana.');if(!state.executor.snapshot().connected)return tape('BLOCKED','Connect a Deriv account before starting Nana.');state.aiBackoffUntil=0;state.aiErrorCount=0;state.awake=true;renderAwake();$('tradingGateText').textContent='NANA IS TRADING · Groq scouts in moderation; Gemini wakes for trade candidates and open positions.';tape('SYSTEM','START TRADING pressed · Nana moderated duo brain is awake.');void askNana()}",
'wake gate');
replaceOnce(
"function sleep(reason='MANUAL SLEEP'){state.awake=false;renderAwake();tape('SYSTEM',`Nana sleeping · ${reason}`)}",
"function sleep(reason='MANUAL SLEEP'){state.awake=false;renderAwake();if($('tradingGateText'))$('tradingGateText').textContent='Trading stopped. Press START TRADING when you want Nana to operate again.';tape('SYSTEM',`Nana sleeping · ${reason}`)}",
'sleep status');
replaceOnce("ctx.fillStyle='#050912';ctx.fillRect(0,0,c.width,c.height);","ctx.fillStyle='#e9f7ff';ctx.fillRect(0,0,c.width,c.height);ctx.strokeStyle='#bdddf2';ctx.lineWidth=1;for(let gx=40;gx<c.width;gx+=80){ctx.beginPath();ctx.moveTo(gx,0);ctx.lineTo(gx,c.height);ctx.stroke()}for(let gy=40;gy<c.height;gy+=60){ctx.beginPath();ctx.moveTo(0,gy);ctx.lineTo(c.width,gy);ctx.stroke()}",'chart sky');
replaceOnce("ctx.strokeStyle='#56f0b4';ctx.lineWidth=3;","ctx.strokeStyle='#174f93';ctx.lineWidth=4;",'chart line');
replaceOnce("ctx.fillStyle=m.kind==='BUY'?'#ffd54f':m.kind==='SELL'?'#ef4136':'#fff';","ctx.fillStyle=m.kind==='BUY'?'#41b33f':m.kind==='SELL'?'#e43d32':'#ffbf28';",'chart markers');
replaceOnce("ctx.fillStyle='#fff';ctx.font='12px monospace';","ctx.fillStyle='#17356b';ctx.font='bold 12px Verdana';",'chart labels');
fs.writeFileSync(file,s);
console.log('Nana moderated duo applied: compact Qwen scout + event-driven Gemini review + error backoff.');