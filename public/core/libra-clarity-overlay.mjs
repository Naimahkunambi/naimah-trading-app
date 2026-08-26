let latest={ticks:[],signals:[]};
let queued=false;
const $=id=>document.getElementById(id);

function regressionLast(rows,period){
  const slice=(rows||[]).slice(-Math.max(2,period));if(slice.length<2)return Number(slice.at(-1)?.quote||0);
  const n=slice.length,xm=(n-1)/2,ym=slice.reduce((s,r)=>s+Number(r.quote),0)/n;let num=0,den=0;
  for(let i=0;i<n;i++){num+=(i-xm)*(Number(slice[i].quote)-ym);den+=(i-xm)**2}
  const slope=den?num/den:0,intercept=ym-slope*xm;return intercept+slope*(n-1);
}
function crossAt(rows,end){const r=rows.slice(0,end+1);if(r.length<22)return null;const now=regressionLast(r,5)-regressionLast(r,21),prevRows=r.slice(0,-1),prev=regressionLast(prevRows,5)-regressionLast(prevRows,21);if(prev<=0&&now>0)return'CALL';if(prev>=0&&now<0)return'PUT';return null}
function recentCross(rows){for(let back=0;back<5;back++){const d=crossAt(rows,rows.length-1-back);if(d)return{direction:d,age:back}}return{direction:'NONE',age:99}}

function schedule(){if(queued)return;queued=true;requestAnimationFrame(()=>requestAnimationFrame(()=>{queued=false;draw()}))}
function draw(){
  const canvas=$('libraTrendCanvas');if(!canvas||!canvas.offsetParent)return;
  const tag=$('libraChartTag')?.textContent||'',match=tag.match(/(\d+) TICKS/),count=match?Number(match[1]):120;
  const rows=(latest.ticks||[]).slice(-Math.max(20,count||120));if(rows.length<2)return;
  const start=Number(rows[0].epoch),end=Number(rows.at(-1).epoch),quotes=rows.map(r=>Number(r.quote));
  const micro=rows.map((_,i)=>regressionLast(rows.slice(0,i+1),5)),structure=rows.map((_,i)=>regressionLast(rows.slice(0,i+1),21));
  const all=[...quotes,...micro,...structure],rawMin=Math.min(...all),rawMax=Math.max(...all),pad=(rawMax-rawMin||1)*.1,min=rawMin-pad,max=rawMax+pad,span=max-min||1;
  const rect=canvas.getBoundingClientRect(),width=rect.width,height=rect.height,left=24,top=38,bottom=height-34,plotRight=Math.max(left+120,width-(width<760?94:175)),xFor=e=>left+(Number(e)-start)/Math.max(1,end-start)*(plotRight-left),yFor=v=>bottom-(Number(v)-min)/span*(bottom-top),ctx=canvas.getContext('2d');
  ctx.save();
  const signals=(latest.signals||[]).filter(s=>Number(s.signalEpoch)>=start&&Number(s.signalEpoch)<=end&&s.sourceApproved);
  for(const s of signals){
    const x=xFor(s.signalEpoch),y=yFor(s.signalQuote),dir=s.sourceDirection,color=dir==='CALL'?'#47f59b':'#ff5c7c';
    ctx.strokeStyle=color;ctx.lineWidth=3.6;ctx.shadowColor=color;ctx.shadowBlur=4;ctx.beginPath();ctx.arc(x,y,6.2,0,Math.PI*2);ctx.stroke();ctx.shadowBlur=0;
  }
  // Paid orders get a clear directional triangle plus W/L dot when settled.
  for(const s of signals){
    const settled=(s.actualTrades||[]).find(t=>['WON','LOST'].includes(t.outcome));if(!settled)continue;
    const x=xFor(s.signalEpoch),y=yFor(s.signalQuote),dir=s.sourceDirection,color=dir==='CALL'?'#47f59b':'#ff5c7c';
    ctx.fillStyle=color;ctx.beginPath();if(dir==='CALL'){ctx.moveTo(x,y-13);ctx.lineTo(x-8,y+2);ctx.lineTo(x+8,y+2)}else{ctx.moveTo(x,y+13);ctx.lineTo(x-8,y-2);ctx.lineTo(x+8,y-2)}ctx.closePath();ctx.fill();
    ctx.fillStyle=settled.outcome==='WON'?'#eafff2':'#ffcfda';ctx.font='bold 10px Courier New';ctx.fillText(settled.outcome==='WON'?'✓':'×',x+10,y-8);
  }
  const cross=recentCross(rows);if(cross.direction!=='NONE'){
    const color=cross.direction==='CALL'?'#47f59b':'#ff5c7c';ctx.fillStyle=color;ctx.font='bold 10px Courier New';ctx.fillText(`CROSS ALERT · ${cross.direction} · ${cross.age}T AGO`,left+10,bottom-10);
  }
  ctx.restore();
}
window.addEventListener('libra-state',e=>{latest={...latest,...(e.detail||{})};schedule()});
setInterval(schedule,650);
