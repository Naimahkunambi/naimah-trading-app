import fs from 'node:fs';

const file='public/nana.js';
let s=fs.readFileSync(file,'utf8');
function replaceOnce(before,after,label){if(!s.includes(before))throw new Error(`Nana auth doctor ${label}: marker not found`);s=s.replace(before,after)}

const before=`async function loadAccounts(){const appId=$('appId').value.trim(),token=$('token').value.trim();if(!appId||!token)return setAccountStatus('APP ID + TOKEN REQUIRED');setAccountStatus('LOADING...');try{const r=await fetch('/api/accounts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({appId,token}),cache:'no-store'});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||\`HTTP \${r.status}\`);state.accounts=Array.isArray(j.accounts)?j.accounts:[];$('account').innerHTML=state.accounts.length?'':'<option value="">No accounts returned</option>';state.accounts.forEach((a,i)=>{const o=document.createElement('option');o.value=String(i);o.textContent=\`\${String(a.account_type||'').toUpperCase()} · \${a.account_id} · \${a.currency||''} \${a.balance??''}\`;$('account').appendChild(o)});state.account=state.accounts[0]||null;syncAccountChoice();setAccountStatus(\`\${state.accounts.length} ACCOUNT(S) READY\`)}catch(e){setAccountStatus(\`ERROR · \${e.message}\`)}}`;

const after=`async function directDerivAccounts(appId,token){
  try{
    const r=await fetch('https://api.derivws.com/trading/v1/options/accounts',{method:'GET',headers:{'Deriv-App-ID':appId,'Authorization':\`Bearer \${token}\`,'Accept':'application/json'},cache:'no-store'});
    const j=await r.json().catch(()=>({}));
    return{transport:'DIRECT_BROWSER',ok:r.ok,status:r.status,json:j,error:j?.errors?.[0]?.message||j?.error?.message||''};
  }catch(e){return{transport:'DIRECT_BROWSER',ok:false,status:0,json:null,error:\`Browser direct request could not complete: \${e.message}\`}}
}
async function proxyDerivAccounts(appId,token){
  try{
    const r=await fetch('/api/accounts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({appId,token}),cache:'no-store'});
    const j=await r.json().catch(()=>({}));
    return{transport:'VERCEL_PROXY',ok:r.ok,status:r.status,json:j,error:j?.error||''};
  }catch(e){return{transport:'VERCEL_PROXY',ok:false,status:0,json:null,error:\`Proxy request could not complete: \${e.message}\`}}
}
function installAccounts(accounts,source){
  state.accounts=Array.isArray(accounts)?accounts:[];
  $('account').innerHTML=state.accounts.length?'':'<option value="">No accounts returned</option>';
  state.accounts.forEach((a,i)=>{const o=document.createElement('option');o.value=String(i);o.textContent=\`\${String(a.account_type||'').toUpperCase()} · \${a.account_id} · \${a.currency||''} \${a.balance??''}\`;$('account').appendChild(o)});
  state.account=state.accounts[0]||null;syncAccountChoice();setAccountStatus(\`\${state.accounts.length} ACCOUNT(S) READY · \${source}\`);
  tape('DERIV AUTH',\`Accounts loaded through \${source}.\`,{source,count:state.accounts.length});
}
async function loadAccounts(){
  const appId=$('appId').value.trim(),token=$('token').value.trim();
  if(!appId||!token)return setAccountStatus('APP ID + TOKEN REQUIRED');
  setAccountStatus('TESTING DERIV DIRECT...');
  const direct=await directDerivAccounts(appId,token);
  if(direct.ok){const data=Array.isArray(direct.json?.data)?direct.json.data:[direct.json?.data].filter(Boolean);return installAccounts(data,'DIRECT DERIV')}
  setAccountStatus(\`DIRECT \${direct.status||'BLOCKED'} · TESTING PROXY...\`);
  const proxy=await proxyDerivAccounts(appId,token);
  if(proxy.ok)return installAccounts(Array.isArray(proxy.json?.accounts)?proxy.json.accounts:[],'VERCEL PROXY');
  const directText=direct.status?\`DIRECT HTTP \${direct.status}: \${direct.error||'authentication rejected'}\`:\`DIRECT BLOCKED: \${direct.error}\`;
  const proxyText=\`PROXY HTTP \${proxy.status||'?'}: \${proxy.error||'authentication rejected'}\`;
  const same401=direct.status===401&&proxy.status===401;
  const verdict=same401?'DERIV REJECTED THE SAME CREDENTIALS BOTH DIRECTLY AND THROUGH VERCEL.':'THE TWO AUTH PATHS FAILED DIFFERENTLY.';
  setAccountStatus(\`ERROR · \${same401?'DERIV 401 BOTH PATHS':'AUTH DIAGNOSTIC FAILED'}\`);
  tape('DERIV AUTH ERROR',\`\${verdict} \${directText} · \${proxyText}\`,{directStatus:direct.status,proxyStatus:proxy.status,appIdLength:appId.length,tokenLength:token.length});
}`;

replaceOnce(before,after,'load accounts diagnostic');
fs.writeFileSync(file,s);
console.log('Nana Deriv Auth Doctor applied: direct browser + Vercel proxy comparison.');
