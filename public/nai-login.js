const CALLBACK='https://sani-bos-executor-git-codex-aed5c8-naimakunambi-6312s-projects.vercel.app/nai-login';
const AUTH='https://oauth.deriv.com/oauth2/authorize';
const APP_KEY='nai.legacy.appId';
const ACCOUNTS_KEY='nai.legacy.accounts';
const $=id=>document.getElementById(id);
$('callback').textContent=CALLBACK;

function status(t){$('status').textContent=t}
function parseReturnedAccounts(){
  const q=new URLSearchParams(location.search);
  const rows=[];
  for(let i=1;i<=20;i++){
    const account=q.get(`acct${i}`),token=q.get(`token${i}`),currency=q.get(`cur${i}`);
    if(!account||!token)continue;
    const upper=String(account).toUpperCase();
    const type=upper.startsWith('VRTC')||upper.startsWith('VR')?'demo':'real';
    rows.push({account_id:account,token,currency:currency||'USD',account_type:type});
  }
  return rows;
}
function renderReturned(rows){
  $('startPanel').style.display='none';
  $('successPanel').classList.add('show');
  $('accounts').innerHTML=rows.map(a=>`<div class="account-pill">${a.account_type.toUpperCase()} · ${a.account_id} · ${a.currency}</div>`).join('');
}
function begin(){
  const appId=$('legacyAppId').value.trim();
  if(!/^\d+$/.test(appId))return status('Enter the numeric App ID from your legacy Deriv application.');
  sessionStorage.setItem(APP_KEY,appId);
  status('Opening Deriv login…');
  // Classic Deriv OAuth uses the redirect URL registered on the application.
  location.href=`${AUTH}?app_id=${encodeURIComponent(appId)}`;
}
$('login').onclick=begin;
$('enterNai').onclick=()=>location.replace('/nai');

const rows=parseReturnedAccounts();
if(rows.length){
  sessionStorage.setItem(ACCOUNTS_KEY,JSON.stringify(rows));
  history.replaceState({},'',location.pathname);
  renderReturned(rows);
}else{
  const appId=sessionStorage.getItem(APP_KEY)||'';
  if(appId)$('legacyAppId').value=appId;
}
