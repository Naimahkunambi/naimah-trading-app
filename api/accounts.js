export default async function handler(req,res){
  if(req.method!=='POST')return res.status(405).json({error:'POST only'});
  const {appId,token}=req.body||{};if(!appId||!token)return res.status(400).json({error:'App ID and token are required.'});
  try{const r=await fetch('https://api.derivws.com/trading/v1/options/accounts',{headers:{'Deriv-App-ID':String(appId),Authorization:`Bearer ${token}`}});const j=await r.json();if(!r.ok)return res.status(r.status).json({error:j?.errors?.[0]?.message||'Failed to load accounts.'});return res.status(200).json({accounts:Array.isArray(j.data)?j.data:[j.data].filter(Boolean)});}catch(e){return res.status(500).json({error:e.message||'Unexpected error.'});}
}
