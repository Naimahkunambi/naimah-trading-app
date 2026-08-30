import fs from 'node:fs';

const file='public/nana.js';
let s=fs.readFileSync(file,'utf8');
const before=`async function loadAccounts(){const appId=$('appId').value.trim(),token=$('token').value.trim();if(!appId||!token)return setAccountStatus('APP ID + TOKEN REQUIRED');setAccountStatus('LOADING...');try{const r=await fetch('/api/accounts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({appId,token}),cache:'no-store'});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||\`HTTP \${r.status}\`);state.accounts=Array.isArray(j.accounts)?j.accounts:[];$('account').innerHTML=state.accounts.length?'':'<option value="">No accounts returned</option>';state.accounts.forEach((a,i)=>{const o=document.createElement('option');o.value=String(i);o.textContent=\`\${String(a.account_type||'').toUpperCase()} · \${a.account_id} · \${a.currency||''} \${a.balance??''}\`;$('account').appendChild(o)});state.account=state.accounts[0]||null;syncAccountChoice();setAccountStatus(\`\${state.accounts.length} ACCOUNT(S) READY\`)}catch(e){setAccountStatus(\`ERROR · \${e.message}\`)}}`;
const after=`async function legacyAuthorizeAccount(appId,token){
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket(\`wss://ws.derivws.com/websockets/v3?app_id=\${encodeURIComponent(appId)}\`);
    const timer=setTimeout(()=>{try{ws.close()}catch{}reject(new Error('Legacy Deriv authorization timed out.'))},12000);
    ws.onopen=()=>ws.send(JSON.stringify({authorize:token,req_id:991}));
    ws.onerror=()=>{clearTimeout(timer);try{ws.close()}catch{}reject(new Error('Legacy Deriv socket could not open.'))};
    ws.onmessage=e=>{let m;try{m=JSON.parse(String(e.data))}catch{return}if(m.req_id!==991&&m.msg_type!=='authorize')return;clearTimeout(timer);try{ws.close()}catch{}if(m.error)return reject(new Error(\`\${m.error.code||'DerivError'}: \${m.error.message||'authorization failed'}\`));const a=m.authorize||{};if(!a.loginid)return reject(new Error('Legacy Deriv returned no account.'));resolve({account_id:String(a.loginid),account_type:a.is_virtual?'demo':'real',currency:a.currency||'USD',balance:a.balance??null,legacy:true})};
  });
}
function installAccounts(accounts,label='OPTIONS API'){
  state.accounts=Array.isArray(accounts)?accounts:[];
  $('account').innerHTML=state.accounts.length?'':'<option value="">No accounts returned</option>';
  state.accounts.forEach((a,i)=>{const o=document.createElement('option');o.value=String(i);o.textContent=\`\${String(a.account_type||'').toUpperCase()} · \${a.account_id} · \${a.currency||''} \${a.balance??''}\${a.legacy?' · LEGACY':''}\`;$('account').appendChild(o)});
  state.account=state.accounts[0]||null;syncAccountChoice();setAccountStatus(\`\${state.accounts.length} ACCOUNT(S) READY · \${label}\`);
}
async function loadAccounts(){
  const appId=$('appId').value.trim(),token=$('token').value.trim();
  if(!appId||!token)return setAccountStatus('APP ID + TOKEN REQUIRED');
  setAccountStatus('CONNECTING DERIV...');
  let optionsError='';
  try{
    const r=await fetch('/api/accounts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({appId,token}),cache:'no-store'});
    const j=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(j.error||\`HTTP \${r.status}\`);
    return installAccounts(Array.isArray(j.accounts)?j.accounts:[],'OPTIONS API');
  }catch(e){optionsError=e.message}
  setAccountStatus('OPTIONS AUTH FAILED · TRYING CLASSIC DERIV...');
  try{
    const account=await legacyAuthorizeAccount(appId,token);
    installAccounts([account],'CLASSIC DERIV');
    tape('DERIV AUTH',\`Options auth failed (\${optionsError}); classic Deriv authorized successfully.\`,{transport:'legacy'});
  }catch(e){
    setAccountStatus(\`ERROR · OPTIONS: \${optionsError} · CLASSIC: \${e.message}\`);
    tape('DERIV AUTH ERROR',\`Options: \${optionsError} · Classic: \${e.message}\`);
  }
}`;
if(!s.includes(before))throw new Error('Nana legacy fallback marker not found');
s=s.replace(before,after);
fs.writeFileSync(file,s);
console.log('Nana legacy auth fallback applied.');
