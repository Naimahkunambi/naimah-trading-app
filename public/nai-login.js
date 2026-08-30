const CALLBACK='https://sani-bos-executor-git-codex-aed5c8-naimakunambi-6312s-projects.vercel.app/nai-login';
const CANONICAL_ORIGIN=new URL(CALLBACK).origin;
const AUTH='https://auth.deriv.com/oauth2/auth';
const SS={v:'nai.oauth.verifier',s:'nai.oauth.state',c:'nai.oauth.client',t:'nai.oauth.token',exp:'nai.oauth.exp'};
const CALLBACK_KEY='nai.oauth.callback.v1';
const CHANNEL='nai-deriv-oauth-v1';
const $=id=>document.getElementById(id);

if(location.origin!==CANONICAL_ORIGIN){location.replace(CALLBACK);throw new Error('Redirecting to canonical NAI OAuth origin')}
$('callback').textContent=CALLBACK;

function rand(n=64){const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';const b=crypto.getRandomValues(new Uint8Array(n));return Array.from(b,x=>chars[x%chars.length]).join('')}
function b64u(bytes){return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}
async function challenge(v){const h=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v));return b64u(new Uint8Array(h))}
function status(t){$('status').textContent=t}
function channel(){try{return new BroadcastChannel(CHANNEL)}catch{return null}}

async function buildAuth(client){
  const verifier=rand(72),state=rand(32);
  sessionStorage.setItem(SS.v,verifier);sessionStorage.setItem(SS.s,state);sessionStorage.setItem(SS.c,client);
  localStorage.removeItem(CALLBACK_KEY);
  const q=new URLSearchParams({response_type:'code',client_id:client,redirect_uri:CALLBACK,scope:'trade',state,code_challenge:await challenge(verifier),code_challenge_method:'S256'});
  return `${AUTH}?${q.toString()}`;
}

async function begin(){
  const client=$('clientId').value.trim();
  if(!client)return status('Enter the OAuth Client ID from your Deriv OAuth2 app.');
  let popup=null;
  try{popup=window.open('about:blank','naiDerivOAuth','popup=yes,width=540,height=760,resizable=yes,scrollbars=yes')}catch{}
  const authUrl=await buildAuth(client);
  const a=$('continueDeriv');a.href=authUrl;a.classList.add('show');
  if(!popup){status('Popup blocked. Click the orange OPEN DERIV button.');return}
  try{popup.location.href=authUrl;status('Deriv login opened. Complete login there; NAI will receive approval automatically.')}catch{status('Browser blocked popup navigation. Click the orange OPEN DERIV button.')}
}
$('login').onclick=()=>void begin();

function publishCallback(payload){
  const msg={...payload,ts:Date.now()};
  try{localStorage.setItem(CALLBACK_KEY,JSON.stringify(msg))}catch{}
  const bc=channel();if(bc){try{bc.postMessage(msg)}catch{}setTimeout(()=>bc.close(),250)}
}

async function handleCallbackPage(){
  const q=new URLSearchParams(location.search);
  if(!q.get('code')&&!q.get('error'))return false;
  if(q.get('error'))publishCallback({type:'error',message:q.get('error_description')||q.get('error')});
  else publishCallback({type:'code',code:q.get('code'),state:q.get('state')});
  history.replaceState({},'',location.pathname);
  document.body.innerHTML='<div style="min-height:100vh;display:grid;place-items:center;background:#61cdf7;font:800 20px system-ui;color:#173b73"><div style="background:white;padding:30px 38px;border-radius:24px;box-shadow:0 8px 0 #2174ad;text-align:center">Deriv approved ✓<br><small style="font-size:14px">Returning approval to NAI… You can close this window if it stays open.</small></div></div>';
  setTimeout(()=>{try{window.close()}catch{}},700);
  return true;
}

async function exchangeCode(code,returnedState){
  const expected=sessionStorage.getItem(SS.s),verifier=sessionStorage.getItem(SS.v),client=sessionStorage.getItem(SS.c);
  if(!returnedState||!expected||returnedState!==expected){status('OAuth state mismatch. Start login again from this NAI window.');return false}
  if(!verifier||!client){status('OAuth session expired. Start login again.');return false}
  status('Deriv approved. Finishing secure login…');
  const r=await fetch('/api/deriv-oauth-token',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientId:client,code,codeVerifier:verifier,redirectUri:CALLBACK}),cache:'no-store'});
  const text=await r.text();let j={};try{j=JSON.parse(text)}catch{j={error:text||`OAuth exchange failed (${r.status})`}}
  if(!r.ok||!j.accessToken){status(`OAuth error: ${j.error||r.status}`);return false}
  sessionStorage.setItem(SS.t,j.accessToken);sessionStorage.setItem(SS.exp,String(Date.now()+Number(j.expiresIn||3600)*1000));sessionStorage.removeItem(SS.v);sessionStorage.removeItem(SS.s);localStorage.removeItem(CALLBACK_KEY);return true;
}

let consuming=false;
async function consumeCallback(msg){
  if(consuming||!msg||Date.now()-Number(msg.ts||0)>120000)return;
  consuming=true;
  try{
    if(msg.type==='error'){status(`Deriv login failed: ${msg.message||'Unknown OAuth error'}`);return}
    if(msg.type==='code'&&msg.code){if(await exchangeCode(msg.code,msg.state))launch()}
  }catch(e){status(`OAuth error: ${e.message}`)}finally{consuming=false}
}

const bc=channel();if(bc)bc.onmessage=e=>void consumeCallback(e.data);
window.addEventListener('storage',e=>{if(e.key===CALLBACK_KEY&&e.newValue){try{void consumeCallback(JSON.parse(e.newValue))}catch{}}});
setInterval(()=>{try{const raw=localStorage.getItem(CALLBACK_KEY);if(raw)void consumeCallback(JSON.parse(raw))}catch{}},700);

function tokenValid(){return Boolean(sessionStorage.getItem(SS.t))&&Date.now()<Number(sessionStorage.getItem(SS.exp)||0)-15000}
function launch(){const token=sessionStorage.getItem(SS.t),client=sessionStorage.getItem(SS.c);if(!token||!client)return;history.replaceState({},'',location.pathname);document.body.classList.add('oauth-ready');const frame=$('naiFrame');frame.onload=()=>{try{const d=frame.contentDocument;const app=d.getElementById('appId'),pat=d.getElementById('derivToken'),load=d.getElementById('loadAccounts');if(!app||!pat||!load)throw new Error('NAI login controls not found.');app.value=client;pat.value=token;load.click()}catch(e){document.body.classList.remove('oauth-ready');status(`Could not hand login to NAI: ${e.message}`)}}}

(async()=>{try{if(await handleCallbackPage())return;if(tokenValid())launch();else{try{const raw=localStorage.getItem(CALLBACK_KEY);if(raw)void consumeCallback(JSON.parse(raw))}catch{}}}catch(e){if(!String(e?.message||'').includes('canonical'))status(`OAuth error: ${e.message}`)}})();
