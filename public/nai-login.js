const CALLBACK='https://sani-bos-executor-git-codex-aed5c8-naimakunambi-6312s-projects.vercel.app/nai-login';
const CANONICAL_ORIGIN=new URL(CALLBACK).origin;
const AUTH='https://auth.deriv.com/oauth2/auth';
const SS={v:'nai.oauth.verifier',s:'nai.oauth.state',c:'nai.oauth.client',t:'nai.oauth.token',exp:'nai.oauth.exp'};
const $=id=>document.getElementById(id);

if(location.origin!==CANONICAL_ORIGIN){location.replace(CALLBACK);throw new Error('Redirecting to canonical NAI OAuth origin')}
$('callback').textContent=CALLBACK;

function rand(n=64){const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';const b=crypto.getRandomValues(new Uint8Array(n));return Array.from(b,x=>chars[x%chars.length]).join('')}
function b64u(bytes){return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}
async function challenge(v){const h=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v));return b64u(new Uint8Array(h))}
function status(t){$('status').textContent=t}

async function buildAuth(client){
  const verifier=rand(72),state=rand(32);
  sessionStorage.setItem(SS.v,verifier);sessionStorage.setItem(SS.s,state);sessionStorage.setItem(SS.c,client);
  const q=new URLSearchParams({response_type:'code',client_id:client,redirect_uri:CALLBACK,scope:'trade',state,code_challenge:await challenge(verifier),code_challenge_method:'S256'});
  return `${AUTH}?${q.toString()}`;
}

async function begin(){
  const client=$('clientId').value.trim();
  if(!client)return status('Enter the OAuth Client ID from your Deriv OAuth2 app.');
  const popup=window.open('about:blank','naiDerivOAuth','popup=yes,width=540,height=760,resizable=yes,scrollbars=yes');
  if(!popup){
    const authUrl=await buildAuth(client);const a=$('continueDeriv');a.href=authUrl;a.classList.add('show');status('Popup was blocked. Click the orange OPEN DERIV button.');return;
  }
  try{
    const authUrl=await buildAuth(client);
    popup.location.replace(authUrl);
    status('Deriv login popup opened. Complete login there, then return here.');
    const a=$('continueDeriv');a.href=authUrl;a.classList.add('show');
  }catch(e){try{popup.close()}catch{}status(`Could not open Deriv: ${e.message}`)}
}
$('login').onclick=begin;

async function exchangeFromCallback(){
  const q=new URLSearchParams(location.search);
  if(!q.get('code')&&!q.get('error'))return false;
  if(q.get('error')){
    const message=q.get('error_description')||q.get('error');
    if(window.opener&&!window.opener.closed){window.opener.postMessage({type:'nai-deriv-oauth-error',message},CANONICAL_ORIGIN);window.close();return true}
    status(`Deriv login failed: ${message}`);history.replaceState({},'',location.pathname);return true;
  }
  const code=q.get('code'),returnedState=q.get('state');
  if(window.opener&&!window.opener.closed){
    window.opener.postMessage({type:'nai-deriv-oauth-code',code,state:returnedState},CANONICAL_ORIGIN);
    document.body.innerHTML='<div style="font:700 18px system-ui;padding:30px">Deriv approved ✓<br>Returning to NAI...</div>';
    setTimeout(()=>window.close(),250);
    return true;
  }
  status('Deriv approved, but the original NAI window is no longer open. Start login again.');
  history.replaceState({},'',location.pathname);
  return true;
}

async function exchangeCode(code,returnedState){
  const expected=sessionStorage.getItem(SS.s),verifier=sessionStorage.getItem(SS.v),client=sessionStorage.getItem(SS.c);
  if(!returnedState||!expected||returnedState!==expected){status('OAuth state mismatch. Start login again from this NAI window.');return false}
  if(!verifier||!client){status('OAuth session expired. Start login again.');return false}
  status('Deriv approved. Finishing login...');
  const r=await fetch('/api/deriv-oauth-token',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientId:client,code,codeVerifier:verifier,redirectUri:CALLBACK}),cache:'no-store'});
  const text=await r.text();let j={};try{j=JSON.parse(text)}catch{j={error:text||`OAuth exchange failed (${r.status})`}}
  if(!r.ok||!j.accessToken){status(`OAuth error: ${j.error||r.status}`);return false}
  sessionStorage.setItem(SS.t,j.accessToken);sessionStorage.setItem(SS.exp,String(Date.now()+Number(j.expiresIn||3600)*1000));sessionStorage.removeItem(SS.v);sessionStorage.removeItem(SS.s);return true;
}

window.addEventListener('message',async e=>{
  if(e.origin!==CANONICAL_ORIGIN||!e.data)return;
  if(e.data.type==='nai-deriv-oauth-error')return status(`Deriv login failed: ${e.data.message||'Unknown OAuth error'}`);
  if(e.data.type==='nai-deriv-oauth-code'){
    try{if(await exchangeCode(e.data.code,e.data.state))launch()}catch(err){status(`OAuth error: ${err.message}`)}
  }
});

function tokenValid(){return Boolean(sessionStorage.getItem(SS.t))&&Date.now()<Number(sessionStorage.getItem(SS.exp)||0)-15000}
function launch(){const token=sessionStorage.getItem(SS.t),client=sessionStorage.getItem(SS.c);if(!token||!client)return;history.replaceState({},'',location.pathname);document.body.classList.add('oauth-ready');const frame=$('naiFrame');frame.onload=()=>{try{const d=frame.contentDocument;const app=d.getElementById('appId'),pat=d.getElementById('derivToken'),load=d.getElementById('loadAccounts');if(!app||!pat||!load)throw new Error('NAI login controls not found.');app.value=client;pat.value=token;load.click()}catch(e){document.body.classList.remove('oauth-ready');status(`Could not hand login to NAI: ${e.message}`)}}}

(async()=>{try{if(await exchangeFromCallback())return;if(tokenValid())launch()}catch(e){if(!String(e?.message||'').includes('canonical'))status(`OAuth error: ${e.message}`)}})();
