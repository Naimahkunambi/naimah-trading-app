export default async function handler(req,res){
  if(req.method!=='POST')return res.status(405).json({error:'POST only'});
  const {appId,token,accountId}=req.body||{};if(!appId||!token||!accountId)return res.status(400).json({error:'App ID, token and account ID are required.'});
  try{const r=await fetch(`https://api.derivws.com/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,{method:'POST',headers:{'Deriv-App-ID':String(appId),Authorization:`Bearer ${token}`}});const j=await r.json();if(!r.ok)return res.status(r.status).json({error:j?.errors?.[0]?.message||'Failed to create WebSocket session.'});return res.status(200).json({url:j?.data?.url,otpExpiresIn:120});}catch(e){return res.status(500).json({error:e.message||'Unexpected error.'});}
}
