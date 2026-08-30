const $=id=>document.getElementById(id);
const CLIENT_KEY='nai.oauth.client';
function status(t){$('status').textContent=t}

$('loginForm').addEventListener('submit',()=>{
  const client=$('clientId').value.trim();
  if(client)sessionStorage.setItem(CLIENT_KEY,client);
  status('Opening Deriv secure login…');
});

async function completeIfReturned(){
  const q=new URLSearchParams(location.search);
  const code=q.get('code'),state=q.get('state');
  if(q.get('error')){
    status(`Deriv login failed: ${q.get('error_description')||q.get('error')}`);
    history.replaceState({},'',location.pathname);
    return false;
  }
  if(!code||!state)return false;
  status('Deriv approved. Finishing secure server session…');
  const r=await fetch('/api/deriv-session-complete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code,state}),cache:'no-store'});
  const text=await r.text();let j={};try{j=JSON.parse(text)}catch{j={error:text||`HTTP ${r.status}`}}
  history.replaceState({},'',location.pathname);
  if(!r.ok||!j.ok){status(`Login error: ${j.error||r.status}`);return false}
  return true;
}

async function sessionExists(){
  try{const r=await fetch('/api/deriv-session-accounts',{cache:'no-store'});return r.ok}catch{return false}
}

function launch(){
  document.body.classList.add('session-ready');
  const frame=$('naiFrame');
  frame.onload=()=>{
    try{
      const d=frame.contentDocument;
      const app=d.getElementById('appId'),token=d.getElementById('derivToken'),load=d.getElementById('loadAccounts');
      if(!app||!token||!load)throw new Error('NAI account controls were not found.');
      app.value='SERVER_SESSION';
      token.value='SERVER_SESSION';
      const appField=app.closest('.field'),tokenField=token.closest('.field');
      if(appField)appField.style.display='none';
      if(tokenField)tokenField.style.display='none';
      load.textContent='REFRESH DERIV ACCOUNTS';
      load.click();
    }catch(e){
      document.body.classList.remove('session-ready');
      status(`Could not open NAI: ${e.message}`);
    }
  };
}

(async()=>{
  const saved=sessionStorage.getItem(CLIENT_KEY)||'';
  if(saved)$('clientId').value=saved;
  try{
    const completed=await completeIfReturned();
    if(completed||await sessionExists())launch();
  }catch(e){status(`Login error: ${e.message}`)}
})();
