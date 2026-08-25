import { analyzeMountain } from './core/libra-mountain.mjs';

let latest={ticks:[],signals:[]};
let scheduled=false;
const $=id=>document.getElementById(id);

function schedule(){if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;drawMountain()})}
function frameRows(){const canvas=$('libraTrendCanvas');if(!canvas)return[];const all=latest.ticks||[];const tag=$('libraChartTag')?.textContent||'';if(tag.includes('HISTORY')||tag.includes('FROZEN'))return[];const match=tag.match(/(\d+) TICKS/),count=match?Number(match[1]):120;return all.slice(-Math.max(20,count||120))}
function drawMountain(){
  const canvas=$('libraTrendCanvas');if(!canvas||!canvas.offsetParent)return;const rows=frameRows();if(rows.length<7)return;
  const m=analyzeMountain(rows),ctx=canvas.getContext('2d'),dpr=Math.max(1,window.devicePixelRatio||1),rect=canvas.getBoundingClientRect(),width=rect.width,height=rect.height;
  ctx.save();ctx.setTransform(dpr,0,0,dpr,0,0);
  const quotes=rows.map(r=>Number(r.quote)),min=Math.min(...quotes),max=Math.max(...quotes),pad=(max-min||1)*.1,lo=min-pad,hi=max+pad,span=hi-lo||1,left=24,top=38,bottom=height-34,plotRight=Math.max(left+120,width-(width<760?94:175)),start=Number(rows[0].epoch),end=Number(rows.at(-1).epoch),x=e=>left+(Number(e)-start)/Math.max(1,end-start)*(plotRight-left),y=q=>bottom-(Number(q)-lo)/span*(bottom-top);
  const color=m.direction==='UP'?'#9fffd6':m.direction==='DOWN'?'#ff7896':'#f7d36a';
  ctx.font='bold 10px Courier New';ctx.fillStyle=color;ctx.fillText(`MOUNTAIN ${m.direction} · ${m.entryMode} · ALLOW ${m.allowedDirection}`,left+8,top+14);
  if(m.start){ctx.strokeStyle=color;ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(x(m.start.epoch),y(m.start.quote),6,0,Math.PI*2);ctx.stroke();ctx.fillStyle=color;ctx.font='bold 8px Courier New';ctx.fillText('MOUNTAIN START',x(m.start.epoch)+8,y(m.start.quote)-8)}
  for(const p of (m.pivots||[]).slice(-10)){if(!['HH','HL','LH','LL'].includes(p.label))continue;const px=x(p.epoch),py=y(p.quote);ctx.fillStyle=p.label==='HH'||p.label==='HL'?'#9fffd6':'#ff7896';ctx.font=p.important?'bold 11px Courier New':'bold 9px Courier New';ctx.fillText(`${p.important?'★ ':''}${p.label}`,px+4,py+(p.type==='H'?-8:13));if(p.important){ctx.strokeStyle=ctx.fillStyle;ctx.setLineDash([4,4]);ctx.beginPath();ctx.moveTo(px,py);ctx.lineTo(plotRight,py);ctx.stroke();ctx.setLineDash([])}}
  if(m.entryAnchor&&['PULLBACK_END','EARLY_MOMENTUM'].includes(m.entryMode)){const px=x(m.entryAnchor.epoch),py=y(m.entryAnchor.quote);ctx.strokeStyle='#f7d36a';ctx.lineWidth=2;ctx.beginPath();ctx.arc(px,py,10,0,Math.PI*2);ctx.stroke();ctx.fillStyle='#f7d36a';ctx.font='bold 9px Courier New';ctx.fillText(`SNIPER ${m.allowedDirection}`,px+12,py-10)}
  if(m.direction==='CHOP'){ctx.fillStyle='#f7d36a';ctx.font='bold 13px Courier New';ctx.fillText('CHOP · NO TRADE',left+20,bottom-20)}
  ctx.restore();
}
window.addEventListener('libra-state',event=>{latest={...latest,...(event.detail||{})};setTimeout(schedule,0)});
window.addEventListener('libra-mountain-state',schedule);
setInterval(schedule,520);
