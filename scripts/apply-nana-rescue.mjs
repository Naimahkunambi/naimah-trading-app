import fs from 'node:fs';

const jsFile='public/nana.js';
let s=fs.readFileSync(jsFile,'utf8');
const one=(a,b,label)=>{if(!s.includes(a))throw new Error(`Nana rescue ${label}: marker missing`);s=s.replace(a,b)};

one(
"const state={accounts:[],account:null,ticks:[],markers:[],judgments:[],tape:[],awake:false,thinking:false,feed:null,subId:null,lastAiAt:0,aiBackoffUntil:0,aiErrorCount:0,config:loadConfig(),executor:null};",
"const state={accounts:[],account:null,ticks:[],markers:[],judgments:[],tape:[],awake:false,thinking:false,feed:null,subId:null,lastAiAt:0,aiBackoffUntil:0,aiErrorCount:0,observeOnly:false,config:loadConfig(),executor:null};",
'state');

one(
"async function connectAccount(){if(!state.account)return setAccountStatus('SELECT ACCOUNT');if(accountType()==='real'&&!$('realUnlock').checked)return setAccountStatus('CONFIRM REAL-MONEY ACCOUNT FIRST');try{setAccountStatus('CONNECTING...');await state.executor.connect({appId:$('appId').value.trim(),token:$('token').value.trim(),account:state.account});openFeed();setPage('config')}catch(e){setAccountStatus(`ERROR · ${e.message}`)}}",
"async function connectAccount(){state.observeOnly=false;if(!state.account)return setAccountStatus('SELECT ACCOUNT');if(accountType()==='real'&&!$('realUnlock').checked)return setAccountStatus('CONFIRM REAL-MONEY ACCOUNT FIRST');try{setAccountStatus('CONNECTING...');await state.executor.connect({appId:$('appId').value.trim(),token:$('token').value.trim(),account:state.account});openFeed();setPage('config')}catch(e){setAccountStatus(`ERROR · ${e.message}`)}}",
'connect');

one(
"async function actOnJudgment(x){const s=state.executor.snapshot(),p=s.contract;if(!state.awake)return;if(!p&&(x.action==='BUY'||x.action==='SELL'))",
"async function actOnJudgment(x){if(state.observeOnly){if(x.action==='BUY'||x.action==='SELL')tape('OBSERVE SIGNAL',`${x.action} candidate · ${x.main_move} · ${x.phase} · ${Math.round(x.confidence)}%`,{thesis:x.thesis});return;}const s=state.executor.snapshot(),p=s.contract;if(!state.awake)return;if(!p&&(x.action==='BUY'||x.action==='SELL'))",
'observe action');

one(
"function wake(){if(!window.__NANA_AI__?.has?.())return tape('BLOCKED','Add BOTH Groq and Gemini API keys on Page 1 before starting Nana.');if(!state.executor.snapshot().connected)return tape('BLOCKED','Connect a Deriv account before starting Nana.');state.aiBackoffUntil=0;state.aiErrorCount=0;state.awake=true;renderAwake();$('tradingGateText').textContent='NANA IS TRADING · Groq scouts in moderation; Gemini wakes for trade candidates and open positions.';tape('SYSTEM','START TRADING pressed · Nana moderated duo brain is awake.');void askNana()}",
"function wake(){if(!window.__NANA_AI__?.has?.())return tape('BLOCKED','Add BOTH Groq and Gemini API keys on Page 1 before starting Nana.');if(!state.observeOnly&&!state.executor.snapshot().connected)return tape('BLOCKED','Connect Deriv first, or choose OBSERVE ONLY on Page 1.');state.aiBackoffUntil=0;state.aiErrorCount=0;state.awake=true;renderAwake();$('tradingGateText').textContent=state.observeOnly?'OBSERVE ONLY · Nana can see and judge the live market but CANNOT place trades.':'NANA IS TRADING · Groq scouts in moderation; Gemini wakes for trade candidates and open positions.';tape('SYSTEM',state.observeOnly?'OBSERVE ONLY started · execution is disabled.':'START TRADING pressed · Nana moderated duo brain is awake.');void askNana()}",
'wake');

one(
"config:{...state.config,accountMode:accountType()},market:",
"config:{...state.config,accountMode:state.observeOnly?'observe_only':accountType()},market:",
'account mode');

s += `\n\nfunction startObserveOnly(){\n  if(!window.__NANA_AI__?.has?.())return setAccountStatus('ADD BOTH AI KEYS FIRST');\n  state.observeOnly=true;\n  state.awake=false;\n  setAccountStatus('OBSERVE ONLY · NO DERIV EXECUTION');\n  openFeed();\n  setPage('config');\n  tape('SYSTEM','Observe Only enabled. Nana can analyze V25 but execution is physically disabled.');\n}\n\nasync function pkceChallenge(verifier){\n  const bytes=new TextEncoder().encode(verifier);\n  const hash=await crypto.subtle.digest('SHA-256',bytes);\n  return btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');\n}\nfunction randomUrlSafe(size=48){const a=new Uint8Array(size);crypto.getRandomValues(a);return btoa(String.fromCharCode(...a)).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');}\nasync function startDerivOauth(){\n  const clientId=String(document.getElementById('appId')?.value||'').trim();\n  if(!clientId)return setAccountStatus('ENTER DERIV OAUTH APP ID FIRST');\n  const verifier=randomUrlSafe(64),stateValue=randomUrlSafe(32);\n  const challenge=await pkceChallenge(verifier);\n  const redirectUri=location.origin+location.pathname;\n  sessionStorage.setItem('nana.oauth.verifier',verifier);\n  sessionStorage.setItem('nana.oauth.state',stateValue);\n  sessionStorage.setItem('nana.oauth.clientId',clientId);\n  sessionStorage.setItem('nana.oauth.redirectUri',redirectUri);\n  const u=new URL('https://auth.deriv.com/oauth2/auth');\n  u.searchParams.set('response_type','code');u.searchParams.set('client_id',clientId);u.searchParams.set('redirect_uri',redirectUri);u.searchParams.set('scope','trade account_manage');u.searchParams.set('state',stateValue);u.searchParams.set('code_challenge',challenge);u.searchParams.set('code_challenge_method','S256');\n  location.href=u.toString();\n}\nasync function finishDerivOauth(){\n  const p=new URLSearchParams(location.search),code=p.get('code'),returned=p.get('state');if(!code)return;\n  const expected=sessionStorage.getItem('nana.oauth.state'),verifier=sessionStorage.getItem('nana.oauth.verifier'),clientId=sessionStorage.getItem('nana.oauth.clientId'),redirectUri=sessionStorage.getItem('nana.oauth.redirectUri');\n  history.replaceState({},'',location.pathname);\n  if(!expected||returned!==expected)return setAccountStatus('OAUTH STATE CHECK FAILED');\n  try{setAccountStatus('DERIV OAUTH · EXCHANGING...');const r=await fetch('/api/deriv-oauth-exchange',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientId,code,codeVerifier:verifier,redirectUri})});const j=await r.json().catch(()=>({}));if(!r.ok||!j.accessToken)throw new Error(j.error||'OAuth exchange failed');\n    document.getElementById('appId').value=clientId;document.getElementById('token').value=j.accessToken;setAccountStatus('DERIV OAUTH READY · LOADING ACCOUNTS...');await loadAccounts();\n  }catch(e){setAccountStatus('OAUTH ERROR · '+e.message)}\n}\ndocument.getElementById('observeOnly')?.addEventListener('click',startObserveOnly);\ndocument.getElementById('derivOauth')?.addEventListener('click',startDerivOauth);\nvoid finishDerivOauth();\n`;

fs.writeFileSync(jsFile,s);
console.log('Nana rescue applied: Observe Only + Deriv OAuth PKCE.');
