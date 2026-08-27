const addComet=()=>{
  const nav=document.querySelector('.libraLabs');
  if(!nav||nav.querySelector('a[href="/comet.html"]'))return;
  const a=document.createElement('a');
  a.href='/comet.html';
  a.textContent='COMET';
  a.title='COMET directional paper trading lab';
  nav.appendChild(a);
};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',addComet,{once:true});else addComet();
