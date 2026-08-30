function parseCookies(req){const out={};for(const part of String(req.headers.cookie||'').split(';')){const i=part.indexOf('=');if(i<0)continue;out[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim())}return out}
async function read(r){const t=await r.text();if(!t)return{};try{return JSON.parse(t)}catch{return{raw:t}}}
export default async function handler(req,res){
  if(req.method!=='POST')return res.status(405).json({error:'POST only'});
  const {accountId}=req.body||{};
  if(!accountId)return res.status(400).json({error:'Account ID required.'});
  const c=parseCookies(req),token=c.nai_deriv_access,clientId=c.nai_deriv_client;
  if(!token||!clientId)return res.status(401).json({error:'No active Deriv session.'});
  try{
    const r=await fetch(`https://api.derivws.com/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,{method:'POST',headers:{'Deriv-App-ID':String(clientId),Authorization:`Bearer ${token}`,Accept:'application/json'},cache:'no-store'});
    const j=await read(r);
    if(!r.ok)return res.status(r.status).json({error:j?.errors?.[0]?.message||j?.error?.message||j?.message||j?.raw||'Could not create Deriv trading session.'});
    const url=j?.data?.url;
    if(!url)return res.status(502).json({error:'Deriv returned no WebSocket URL.'});
    return res.status(200).json({url});
  }catch(e){return res.status(500).json({error:e?.message||'Could not create Deriv trading session.'})}
}
