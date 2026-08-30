function parseUpstreamText(text){
  if(!text)return{};
  try{return JSON.parse(text)}catch{return{__plainText:text}}
}
function errorMessage(j,status){
  return j?.errors?.[0]?.message||j?.error?.message||j?.message||j?.__plainText||`Failed to create WebSocket session (${status}).`;
}

export default async function handler(req,res){
  if(req.method!=='POST')return res.status(405).json({error:'POST only'});
  const{appId,token,accountId}=req.body||{};
  if(!appId||!token||!accountId)return res.status(400).json({error:'App ID, token and account ID are required.'});
  try{
    const r=await fetch(`https://api.derivws.com/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,{
      method:'POST',
      headers:{'Deriv-App-ID':String(appId),Authorization:`Bearer ${token}`,Accept:'application/json'},
      cache:'no-store'
    });
    const text=await r.text();
    const j=parseUpstreamText(text);
    if(!r.ok)return res.status(r.status).json({error:errorMessage(j,r.status)});
    const url=j?.data?.url;
    if(!url)return res.status(502).json({error:'Deriv authorized the account but returned no trading WebSocket URL.'});
    return res.status(200).json({url,otpExpiresIn:120});
  }catch(e){
    return res.status(500).json({error:e?.message||'Unexpected error.'});
  }
}
