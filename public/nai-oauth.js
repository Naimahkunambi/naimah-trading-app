const CALLBACK='https://sani-bos-executor-git-codex-aed5c8-naimakunambi-6312s-projects.vercel.app/nai';
const AUTH_URL='https://auth.deriv.com/oauth2/auth';
const SS={verifier:'nai.deriv.pkce.verifier',state:'nai.deriv.oauth.state',client:'nai.deriv.oauth.client'};
const $=id=>document.getElementById(id);

function randomString(length=64){
  const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes=crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes,b=>chars[b%chars.length]).join('');
}
function base64url(bytes){
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
async function challenge(verifier){
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(hash));
}
function status(text){const el=$('oauthStatus');if(el)el.textContent=text}

function injectUi(){
  const card=[...document.querySelectorAll('.panel')].find(x=>x.querySelector('h2')?.textContent.includes('DERIV ACCOUNT'));
  if(!card||$('derivOauthClient'))return;
  const box=document.createElement('div');
  box.className='oauth-box';
  box.innerHTML=`<div class="oauth-title">🔐 LOGIN WITH DERIV</div>
    <div class="form-grid">
      <div class="field full"><label>DERIV OAUTH CLIENT ID</label><input id="derivOauthClient" autocomplete="off" placeholder="Your registered OAuth2 app ID"></div>
      <div class="field full"><button id="derivOauthLogin" class="arcade-btn green wide">LOGIN WITH DERIV</button></div>
    </div>
    <div id="oauthStatus" class="status">Recommended login. No PAT copy/paste. Callback: ${CALLBACK}</div>
    <details class="legacy-login"><summary>Manual token fallback</summary><p>If OAuth is unavailable, the App ID + PAT fields below still work as a fallback.</p></details>`;
  const form=card.querySelector('.form-grid');
  card.insertBefore(box,form);
  $('derivOauthLogin').onclick=startLogin;
}

async function startLogin(){
  const clientId=$('derivOauthClient')?.value.trim();
  if(!clientId)return status('Enter the OAuth Client ID from your registered Deriv OAuth2 app.');
  const verifier=randomString(72),oauthState=randomString(32),codeChallenge=await challenge(verifier);
  sessionStorage.setItem(SS.verifier,verifier);
  sessionStorage.setItem(SS.state,oauthState);
  sessionStorage.setItem(SS.client,clientId);
  const q=new URLSearchParams({response_type:'code',client_id:clientId,redirect_uri:CALLBACK,scope:'trade',state:oauthState,code_challenge:codeChallenge,code_challenge_method:'S256'});
  status('Opening Deriv secure login...');
  location.assign(`${AUTH_URL}?${q.toString()}`);
}

async function handleCallback(){
  const q=new URLSearchParams(location.search);
  const error=q.get('error');
  if(error){status(`Deriv login cancelled/failed: ${q.get('error_description')||error}`);history.replaceState({},'',location.pathname);return;}
  const code=q.get('code');
  if(!code)return;
  const returnedState=q.get('state');
  const expectedState=sessionStorage.getItem(SS.state);
  const verifier=sessionStorage.getItem(SS.verifier);
  const clientId=sessionStorage.getItem(SS.client);
  if(!returnedState||!expectedState||returnedState!==expectedState){status('Deriv login blocked: OAuth state mismatch. Start login again.');return;}
  if(!verifier||!clientId){status('Deriv login session expired. Press LOGIN WITH DERIV again.');return;}
  status('Deriv approved. Finishing secure login...');
  try{
    const r=await fetch('/api/deriv-oauth-token',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientId,code,codeVerifier:verifier,redirectUri:CALLBACK}),cache:'no-store'});
    const text=await r.text();let j={};try{j=JSON.parse(text)}catch{j={error:text||`OAuth exchange failed (${r.status})`}}
    if(!r.ok||!j.accessToken)throw new Error(j.error||`OAuth exchange failed (${r.status})`);
    sessionStorage.removeItem(SS.verifier);sessionStorage.removeItem(SS.state);
    $('appId').value=clientId;
    $('derivToken').value=j.accessToken;
    status(`DERIV LOGIN READY · token expires in about ${Math.max(1,Math.round(Number(j.expiresIn||3600)/60))} min. Loading accounts...`);
    history.replaceState({},'',location.pathname);
    $('loadAccounts')?.click();
  }catch(e){status(`DERIV OAUTH ERROR · ${e.message}`);}
}

injectUi();
handleCallback();
