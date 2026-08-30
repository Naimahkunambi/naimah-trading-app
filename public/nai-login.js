const CALLBACK='https://sani-bos-executor-git-codex-aed5c8-naimakunambi-6312s-projects.vercel.app/nai-login';
const AUTH='https://auth.deriv.com/oauth2/auth';
const SS={v:'nai.oauth.verifier',s:'nai.oauth.state',c:'nai.oauth.client',t:'nai.oauth.token',exp:'nai.oauth.exp'};
const $=id=>document.getElementById(id);
$('callback').textContent=CALLBACK;

function rand(n=64){const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';const b=crypto.getRandomValues(new Uint8Array(n));return Array.from(b,x=>chars[x%chars.length]).join('')}
function b64u(bytes){return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}
async function challenge(v){const h=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v));return b64u(new Uint8Array(h))}
function status(t){$('status').textContent=t}

async function begin(){const client=$('clientId').value.trim();if(!client)return status('Enter the OAuth Client ID from your Deriv OAuth2 app.');const verifier=rand(72),state=rand(32);sessionStorage.setItem(SS.v,verifier);sessionStorage.setItem(SS.s,state);sessionStorage.setItem(SS.c,client);const q=new URLSearchParams({response_type:'code',client_id:client,redirect_uri:CALLBACK,scope:'trade',state,code_challenge:await challenge(verifier),code_challenge_method:'S256'});status('Opening Deriv secure login...');location.assign(`${AUTH}?${q}`)}
$('login').onclick=begin;

async function exchange(){const q=new URLSearchParams(location.search);if(q.get('error')){status(`Deriv login failed: ${q.get('error_description')||q.get('error')}`);history.replaceState({},'',location.pathname);return}const code=q.get('code');if(!code)return false;const state=q.get('state'),expected=sessionStorage.getItem(SS.s),verifier=sessionStorage.getItem(SS.v),client=sessionStorage.getItem(SS.c);if(!state||state!==expected)return status('OAuth state mismatch. Start login again.'),false;if(!verifier||!client)return status('OAuth session expired. Start login again.'),false;status('Deriv approved. Finishing login...');const r=await fetch('/api/deriv-oauth-token',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientId:client,code,codeVerifier:verifier,redirectUri:CALLBACK}),cache:'no-store'});const text=await r.text();let j={};try{j=JSON.parse(text)}catch{j={error:text||`OAuth exchange failed (${r.status})`}}if(!r.ok||!j.accessToken){status(`OAuth error: ${j.error||r.status}`);return false}sessionStorage.setItem(SS.t,j.accessToken);sessionStorage.setItem(SS.exp,String(Date.now()+Number(j.expiresIn||3600)*1000));sessionStorage.removeItem(SS.v);sessionStorage.removeItem(SS.s);history.replaceState({},'',location.pathname);return true}

function tokenValid(){return Boolean(sessionStorage.getItem(SS.t))&&Date.now()<Number(sessionStorage.getItem(SS.exp)||0)-15000}
function launch(){const token=sessionStorage.getItem(SS.t),client=sessionStorage.getItem(SS.c);if(!token||!client)return;document.body.classList.add('oauth-ready');const frame=$('naiFrame');frame.onload=()=>{try{const d=frame.contentDocument;const app=d.getElementById('appId'),pat=d.getElementById('derivToken'),load=d.getElementById('loadAccounts');if(!app||!pat||!load)throw new Error('NAI login controls not found.');app.value=client;pat.value=token;load.click()}catch(e){document.body.classList.remove('oauth-ready');status(`Could not hand login to NAI: ${e.message}`)}}}

(async()=>{try{const exchanged=await exchange();if(exchanged||tokenValid())launch()}catch(e){status(`OAuth error: ${e.message}`)}})();
