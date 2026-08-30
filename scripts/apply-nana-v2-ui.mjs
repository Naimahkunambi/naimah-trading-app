import fs from 'node:fs';

const file='public/nana.js';
let s=fs.readFileSync(file,'utf8');
function replaceOnce(before,after,label){if(!s.includes(before))throw new Error(`Nana v2 ${label}: marker not found`);s=s.replace(before,after)}

replaceOnce(
"function wake(){if(!state.executor.snapshot().connected)return tape('BLOCKED','Connect a Deriv account before waking Nana.');state.awake=true;renderAwake();tape('SYSTEM','Nana is awake and watching the market.');void askNana()}",
"function wake(){if(!window.__NANA_AI__?.has?.())return tape('BLOCKED','Add your OpenRouter API key on Page 1 before starting Nana.');if(!state.executor.snapshot().connected)return tape('BLOCKED','Connect a Deriv account before starting Nana.');state.awake=true;renderAwake();$('tradingGateText').textContent='NANA IS TRADING · She is watching, judging and managing the selected account by herself.';tape('SYSTEM','START TRADING pressed · Nana is awake and operating autonomously.');void askNana()}",
'wake gate');

replaceOnce(
"function sleep(reason='MANUAL SLEEP'){state.awake=false;renderAwake();tape('SYSTEM',`Nana sleeping · ${reason}`)}",
"function sleep(reason='MANUAL SLEEP'){state.awake=false;renderAwake();if($('tradingGateText'))$('tradingGateText').textContent='Trading stopped. Press START TRADING when you want Nana to operate again.';tape('SYSTEM',`Nana sleeping · ${reason}`)}",
'sleep status');

replaceOnce(
"ctx.fillStyle='#050912';ctx.fillRect(0,0,c.width,c.height);",
"ctx.fillStyle='#e9f7ff';ctx.fillRect(0,0,c.width,c.height);ctx.strokeStyle='#bdddf2';ctx.lineWidth=1;for(let gx=40;gx<c.width;gx+=80){ctx.beginPath();ctx.moveTo(gx,0);ctx.lineTo(gx,c.height);ctx.stroke()}for(let gy=40;gy<c.height;gy+=60){ctx.beginPath();ctx.moveTo(0,gy);ctx.lineTo(c.width,gy);ctx.stroke()}",
'chart sky');
replaceOnce("ctx.strokeStyle='#56f0b4';ctx.lineWidth=3;","ctx.strokeStyle='#174f93';ctx.lineWidth=4;",'chart line');
replaceOnce("ctx.fillStyle=m.kind==='BUY'?'#ffd54f':m.kind==='SELL'?'#ef4136':'#fff';","ctx.fillStyle=m.kind==='BUY'?'#41b33f':m.kind==='SELL'?'#e43d32':'#ffbf28';",'chart markers');
replaceOnce("ctx.fillStyle='#fff';ctx.font='12px monospace';","ctx.fillStyle='#17356b';ctx.font='bold 12px Verdana';",'chart labels');

fs.writeFileSync(file,s);
console.log('Nana v2 applied: AI-key start gate + bright platform-world chart.');