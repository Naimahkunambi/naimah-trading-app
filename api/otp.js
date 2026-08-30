function parseUpstreamText(text){if(!text)return{};try{return JSON.parse(text)}catch{return{__plainText:text}}}
function errorMessage(j,status){return j?.errors?.[0]?.message||j?.error?.message||j?.message||j?.__plainText||`Failed to create WebSocket session (${status}).`}
function cookies(req){const out={};for(const p of String(req.headers.cookie||'').split(';')){const i=p.indexOf('=');if(i<0)continue;out[p.slice(0,i).trim()]=decodeURIComponent(p.slice(i+1).trim())}return out}
export default async function handler(req,res){
  if(req.method!=='POST')return res.status(405).json({error:'POST only'});
  const body=req.body||{},c=cookies(req);
  const appId=c.nai_deriv_client||body.appId;
  const token=c.nai_deriv_access||body.token;
  const accountId=body.accountId;
  if(!accountId)return res.status(400).json({error:'Account ID is required.'});
  if(!appId||!token)return res.status(401).json({error:'No active Deriv login. Use LOGIN WITH DERIV first.'});
  try{
    const r=await fetch(`https://api.derivws.com/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,{method:'POST',headers:{'Deriv-App-ID':String(appId),Authorization:`Bearer ${token}`,Accept:'application/json'},cache:'no-store'});
    const j=parseUpstreamText(await r.text());
    if(!r.ok)return res.status(r.status).json({error:errorMessage(j,r.status)});
    const url=j?.data?.url;
    if(!url)return res.status(502).json({error:'Deriv authorized the account but returned no trading WebSocket URL.'});
    return res.status(200).json({url,otpExpiresIn:120,session:Boolean(c.nai_deriv_access)});
  }catch(e){return res.status(500).json({error:e?.message||'Unexpected error.'})}
}
