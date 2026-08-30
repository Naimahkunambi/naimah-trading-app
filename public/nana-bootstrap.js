(()=>{
  let groqToken='';
  let geminiToken='';
  const nativeFetch=window.fetch.bind(window);
  window.__NANA_AI__={
    get groq(){return groqToken},
    get gemini(){return geminiToken},
    set groq(v){groqToken=String(v||'').trim();sync()},
    set gemini(v){geminiToken=String(v||'').trim();sync()},
    has(){return Boolean(groqToken&&geminiToken)},
    status(){return{groq:Boolean(groqToken),gemini:Boolean(geminiToken)}}
  };
  function sync(){
    const groqStatus=document.getElementById('groqTokenStatus');
    const geminiStatus=document.getElementById('geminiTokenStatus');
    const duoStatus=document.getElementById('aiTokenStatus');
    if(groqStatus)groqStatus.textContent=groqToken?'GROQ READY ✓':'GROQ KEY REQUIRED';
    if(geminiStatus)geminiStatus.textContent=geminiToken?'GEMINI READY ✓':'GEMINI KEY REQUIRED';
    if(duoStatus)duoStatus.textContent=groqToken&&geminiToken?'NANA DUO READY ✓':'ADD BOTH AI KEYS';
  }
  document.addEventListener('input',e=>{
    if(e.target?.id==='groqToken')window.__NANA_AI__.groq=e.target.value;
    if(e.target?.id==='geminiToken')window.__NANA_AI__.gemini=e.target.value;
  });
  window.fetch=(input,init={})=>{
    const url=typeof input==='string'?input:input?.url||'';
    if(url==='/api/nana-ai'||url.endsWith('/api/nana-ai')){
      const headers=new Headers(init.headers||{});
      if(groqToken)headers.set('X-Nana-Groq-Key',groqToken);
      if(geminiToken)headers.set('X-Nana-Gemini-Key',geminiToken);
      init={...init,headers};
    }
    return nativeFetch(input,init);
  };
  document.addEventListener('DOMContentLoaded',()=>{
    const jump=document.querySelector('[data-page-jump="chart"]');
    if(jump)jump.addEventListener('click',()=>document.querySelector('[data-page="chart"]')?.click());
    sync();
  });
})();