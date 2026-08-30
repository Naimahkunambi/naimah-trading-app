const CALLBACK='https://sani-bos-executor-git-codex-aed5c8-naimakunambi-6312s-projects.vercel.app/nai-login';
const TOKEN_URL='https://auth.deriv.com/oauth2/token';

function parseCookies(req){
  const raw=String(req.headers.cookie||'');
  const out={};
  for(const part of raw.split(';')){const i=part.indexOf('=');if(i<0)continue;out[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim())}
  return out;
}
function clear(name){return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`}
function cookie(name,value,maxAge=3600){return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`}
async function read(r){const t=await r.text();if(!t)return{};try{return JSON.parse(t)}catch{return{raw:t}}}

export default async function handler(req,res){
  if(req.method!=='POST')return res.status(405).json({error:'POST only'});
  const {code,state}=req.body||{};
  if(!code||!state)return res.status(400).json({error:'Missing OAuth code/state.'});
  const c=parseCookies(req),expected=c.nai_deriv_state,verifier=c.nai_deriv_verifier,clientId=c.nai_deriv_client;
  if(!expected||state!==expected)return res.status(400).json({error:'OAuth session mismatch. Start Deriv login again.'});
  if(!verifier||!clientId)return res.status(400).json({error:'OAuth session expired. Start Deriv login again.'});
  try{
    const form=new URLSearchParams({grant_type:'authorization_code',client_id:clientId,code,code_verifier:verifier,redirect_uri:CALLBACK});
    const r=await fetch(TOKEN_URL,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',accept:'application/json'},body:form,cache:'no-store'});
    const j=await read(r);
    if(!r.ok||!j.access_token)return res.status(r.status||502).json({error:j.error_description||j.error||j.message||j.raw||'Deriv OAuth token exchange failed.'});
    const maxAge=Math.max(60,Number(j.expires_in||3600));
    res.setHeader('Set-Cookie',[
      cookie('nai_deriv_access',j.access_token,maxAge),
      cookie('nai_deriv_client',clientId,maxAge),
      clear('nai_deriv_verifier'),clear('nai_deriv_state')
    ]);
    return res.status(200).json({ok:true,expiresIn:maxAge});
  }catch(e){return res.status(500).json({error:e?.message||'Deriv OAuth exchange failed.'})}
}
