(()=>{
  let aiToken='';
  const nativeFetch=window.fetch.bind(window);
  window.__NANA_AI__={
    get token(){return aiToken},
    set token(v){aiToken=String(v||'').trim(); sync()},
    has(){return Boolean(aiToken)}
  };
  function sync(){
    const status=document.getElementById('aiTokenStatus');
    if(status) status.textContent=aiToken?'AI KEY LOADED ✓':'AI KEY NOT LOADED';
  }
  document.addEventListener('input',e=>{
    if(e.target?.id==='aiToken') window.__NANA_AI__.token=e.target.value;
  });
  window.fetch=(input,init={})=>{
    const url=typeof input==='string'?input:input?.url||'';
    if(url==='/api/nana-ai' || url.endsWith('/api/nana-ai')){
      const headers=new Headers(init.headers||{});
      if(aiToken) headers.set('X-Nana-OpenRouter-Key',aiToken);
      init={...init,headers};
    }
    return nativeFetch(input,init);
  };
  document.addEventListener('DOMContentLoaded',()=>{
    const jump=document.querySelector('[data-page-jump="chart"]');
    if(jump) jump.addEventListener('click',()=>document.querySelector('[data-page="chart"]')?.click());
    sync();
  });
})();