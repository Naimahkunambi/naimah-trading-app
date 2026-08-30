const num=v=>Number(v);
const finite=v=>Number.isFinite(num(v));
const round=(v,d=2)=>finite(v)?Number(num(v).toFixed(d)):null;

function prices(ticks){return ticks.map(x=>num(x?.quote)).filter(Number.isFinite)}
function median(values){if(!values.length)return 0;const a=[...values].sort((x,y)=>x-y);const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2}
function statsFromRows(rows,label){const p=prices(rows);if(p.length<2)return null;const open=p[0],close=p.at(-1),high=Math.max(...p),low=Math.min(...p),net=close-open;let path=0,up=0,down=0;for(let i=1;i<p.length;i++){const d=p[i]-p[i-1];path+=Math.abs(d);if(d>0)up++;else if(d<0)down++}return{label,open:round(open),high:round(high),low:round(low),close:round(close),net:round(net),range:round(high-low),efficiency:round(path?Math.abs(net)/path:0,3),up_steps:up,down_steps:down}}
function windowStats(ticks,n){const rows=ticks.slice(-n);const p=prices(rows);if(p.length<2)return null;const s=statsFromRows(rows,`${n}s`);const steps=[];for(let i=1;i<p.length;i++)steps.push(Math.abs(p[i]-p[i-1]));return{...s,median_step:round(median(steps),4),from_high:round(p.at(-1)-Math.max(...p)),from_low:round(p.at(-1)-Math.min(...p))}}
function blocks(ticks,size,count){const tail=ticks.slice(-(size*count));const out=[];for(let i=0;i<tail.length;i+=size){const block=tail.slice(i,i+size);if(block.length>=Math.max(2,Math.floor(size*.6)))out.push(statsFromRows(block,`${size}s#${out.length+1}`))}return out.filter(Boolean)}
function candidateSwings(ticks){const p=prices(ticks.slice(-240));if(p.length<15)return[];const diffs=[];for(let i=1;i<p.length;i++)diffs.push(Math.abs(p[i]-p[i-1]));const threshold=Math.max(median(diffs)*4,1e-9);const swings=[];let lastType=null,lastPrice=p[0],lastIdx=0;for(let i=2;i<p.length-2;i++){const v=p[i];const isHigh=v>=p[i-1]&&v>=p[i-2]&&v>p[i+1]&&v>=p[i+2];const isLow=v<=p[i-1]&&v<=p[i-2]&&v<p[i+1]&&v<=p[i+2];if(!isHigh&&!isLow)continue;const type=isHigh?'HIGH':'LOW';if(Math.abs(v-lastPrice)<threshold)continue;if(type===lastType){const better=type==='HIGH'?v>lastPrice:v<lastPrice;if(better&&swings.length){swings[swings.length-1]={type,price:round(v),ago_seconds:p.length-1-i};lastPrice=v;lastIdx=i}continue}swings.push({type,price:round(v),ago_seconds:p.length-1-i});lastType=type;lastPrice=v;lastIdx=i}return swings.slice(-8)}
function strength(window,medianStep){if(!window||!medianStep)return 0;const displacement=Math.abs(window.net)/(medianStep*Math.max(1,Math.sqrt((window.up_steps||0)+(window.down_steps||0))));return round(displacement*(.5+.5*(window.efficiency||0)),2)}

export function buildNaiEyes(ticks){
  const clean=ticks.filter(x=>finite(x?.quote)).slice(-900);const p=prices(clean);if(p.length<20)return null;
  const steps=[];for(let i=Math.max(1,p.length-120);i<p.length;i++)steps.push(Math.abs(p[i]-p[i-1]));const med=Math.max(median(steps),1e-9);
  const w10=windowStats(clean,10),w20=windowStats(clean,20),w40=windowStats(clean,40),w90=windowStats(clean,90),w180=windowStats(clean,180),w300=windowStats(clean,300);
  const recent=p.slice(-24).map(v=>round(v));
  return{
    last_price:round(p.at(-1)),
    median_step:round(med,4),
    horizons:{s10:{...w10,strength:strength(w10,med)},s20:{...w20,strength:strength(w20,med)},s40:{...w40,strength:strength(w40,med)},s90:{...w90,strength:strength(w90,med)},s180:{...w180,strength:strength(w180,med)},s300:{...w300,strength:strength(w300,med)}},
    filmstrip_5s:blocks(clean,5,8),
    filmstrip_10s:blocks(clean,10,12),
    filmstrip_30s:blocks(clean,30,8),
    candidate_swings:candidateSwings(clean),
    recent_prices:recent,
    note:'Ordered measurements only. AI decides direction, phase and trade.'
  }
}

export function meaningfulMarketEvent(previous,current){
  if(!current)return false;if(!previous)return true;
  const a=current.horizons?.s10,b=previous.horizons?.s10,c=current.horizons?.s20,d=previous.horizons?.s20;
  const med=current.median_step||1;
  const flip=(a?.net||0)*(b?.net||0)<0;
  const burst=Math.abs((a?.net||0)-(b?.net||0))>med*4;
  const twentyBurst=Math.abs((c?.net||0)-(d?.net||0))>med*6;
  const swingChanged=JSON.stringify(current.candidate_swings?.slice(-2))!==JSON.stringify(previous.candidate_swings?.slice(-2));
  return flip||burst||twentyBurst||swingChanged;
}
