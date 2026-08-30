import fs from 'node:fs';

const file='public/nana.js';
let s=fs.readFileSync(file,'utf8');
function replaceOnce(before,after,label){if(!s.includes(before))throw new Error(`Nana direct account ${label}: marker not found`);s=s.replace(before,after)}

replaceOnce(
"function syncAccountChoice(){const i=Number($('account').value||0);state.account=state.accounts[i]||null;$('realConfirm').classList.toggle('hidden',accountType()!=='real');$('realUnlock').checked=false}",
"function syncAccountChoice(){const i=Number($('account').value||0);state.account=state.accounts[i]||null;const manualType=String($('manualAccountType')?.value||'').toLowerCase();const activeType=$('manualAccountId')?.value.trim()?manualType:accountType();$('realConfirm').classList.toggle('hidden',activeType!=='real');$('realUnlock').checked=false}\nfunction manualAccount(){const id=$('manualAccountId')?.value.trim();if(!id)return null;const type=String($('manualAccountType')?.value||'demo').toLowerCase();return{account_id:id,account_type:type,currency:'USD',balance:null,manual:true}}",
'sync account');

replaceOnce(
"async function connectAccount(){if(!state.account)return setAccountStatus('SELECT ACCOUNT');if(accountType()==='real'&&!$('realUnlock').checked)return setAccountStatus('CONFIRM REAL-MONEY ACCOUNT FIRST');try{setAccountStatus('CONNECTING...');await state.executor.connect({appId:$('appId').value.trim(),token:$('token').value.trim(),account:state.account});openFeed();setPage('config')}catch(e){setAccountStatus(`ERROR · ${e.message}`)}}",
"async function connectAccount(){const direct=manualAccount();const chosen=direct||state.account;if(!chosen)return setAccountStatus('LOAD ACCOUNTS OR ENTER DIRECT ACCOUNT ID');const chosenType=String(chosen.account_type||'').toLowerCase();if(chosenType==='real'&&!$('realUnlock').checked)return setAccountStatus('CONFIRM REAL-MONEY ACCOUNT FIRST');try{setAccountStatus(direct?'CONNECTING DIRECT ACCOUNT...':'CONNECTING...');await state.executor.connect({appId:$('appId').value.trim(),token:$('token').value.trim(),account:chosen});state.account=chosen;tape('DERIV CONNECT',direct?`Direct account ${chosen.account_id} sent straight to Deriv OTP. Account-list endpoint bypassed.`:`Listed account ${chosen.account_id} selected.`);openFeed();setPage('config')}catch(e){setAccountStatus(`ERROR · ${e.message}`);tape('DERIV CONNECT ERROR',e.message,{direct:Boolean(direct),accountId:chosen.account_id})}}",
'connect direct');

replaceOnce(
"$('loadAccounts').onclick=loadAccounts;$('account').onchange=syncAccountChoice;$('connectAccount').onclick=connectAccount;$('disconnectAccount').onclick=disconnectAccount;$('saveConfig').onclick=saveConfig;",
"$('loadAccounts').onclick=loadAccounts;$('account').onchange=syncAccountChoice;$('manualAccountId').oninput=syncAccountChoice;$('manualAccountType').onchange=syncAccountChoice;$('connectAccount').onclick=connectAccount;$('disconnectAccount').onclick=disconnectAccount;$('saveConfig').onclick=saveConfig;",
'wire direct');

fs.writeFileSync(file,s);
console.log('Nana direct account bypass applied: account listing is no longer required to connect.');
