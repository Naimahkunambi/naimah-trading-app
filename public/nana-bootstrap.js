(()=>{
  let openrouter='';
  let groq='';
  let gemini='';
  const nativeFetch=window.fetch.bind(window);

  window.__NANA_AI__={
    get openrouter(){return openrouter},
    get groq(){return groq},
    get gemini(){return gemini},
    set openrouter(v){openrouter=String(v||'').trim();sync()},
    set groq(v){groq=String(v||'').trim();sync()},
    set gemini(v){gemini=String(v||'').trim();sync()},
    has(){return Boolean(openrouter&&groq&&gemini)},
    status(){return{openrouter:Boolean(openrouter),groq:Boolean(groq),gemini:Boolean(gemini)}}
  };

  function sync(){
    const orStatus=document.getElementById('openrouterTokenStatus');
    const groqStatus=document.getElementById('groqTokenStatus');
    const geminiStatus=document.getElementById('geminiTokenStatus');
    const overall=document.getElementById('aiTokenStatus');
    if(orStatus)orStatus.textContent=openrouter?'OPENROUTER READY ✓':'OPENROUTER KEY REQUIRED';
    if(groqStatus)groqStatus.textContent=groq?'GROQ READY ✓':'GROQ KEY REQUIRED';
    if(geminiStatus)geminiStatus.textContent=gemini?'GEMINI READY ✓':'GEMINI KEY REQUIRED';
    if(overall)overall.textContent=openrouter&&groq&&gemini?'NANA TRIO READY ✓':'ADD ALL 3 AI KEYS';
  }

  document.addEventListener('input',e=>{
    if(e.target?.id==='aiToken')window.__NANA_AI__.openrouter=e.target.value;
    if(e.target?.id==='groqToken')window.__NANA_AI__.groq=e.target.value;
    if(e.target?.id==='geminiToken')window.__NANA_AI__.gemini=e.target.value;
  });

  window.fetch=(input,init={})=>{
    const url=typeof input==='string'?input:input?.url||'';
    if(url==='/api/nana-ai'||url.endsWith('/api/nana-ai')){
      const headers=new Headers(init.headers||{});
      if(openrouter)headers.set('X-Nana-OpenRouter-Key',openrouter);
      if(groq)headers.set('X-Nana-Groq-Key',groq);
      if(gemini)headers.set('X-Nana-Gemini-Key',gemini);
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