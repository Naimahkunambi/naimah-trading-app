const TOKEN_URL='https://auth.deriv.com/oauth2/token';

async function readPayload(r){
  const text=await r.text();
  if(!text)return{};
  try{return JSON.parse(text)}catch{return{raw:text}}
}

export default async function handler(req,res){
  if(req.method!=='POST')return res.status(405).json({error:'POST only'});
  const {clientId,code,codeVerifier,redirectUri}=req.body||{};
  if(!clientId||!code||!codeVerifier||!redirectUri){
    return res.status(400).json({error:'clientId, code, codeVerifier and redirectUri are required.'});
  }
  if(!String(redirectUri).startsWith('https://')){
    return res.status(400).json({error:'OAuth redirect URI must use HTTPS.'});
  }
  try{
    const form=new URLSearchParams({
      grant_type:'authorization_code',
      client_id:String(clientId),
      code:String(code),
      code_verifier:String(codeVerifier),
      redirect_uri:String(redirectUri)
    });
    const r=await fetch(TOKEN_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:form,cache:'no-store'});
    const j=await readPayload(r);
    if(!r.ok){
      return res.status(r.status).json({error:j?.error_description||j?.error?.message||j?.error||j?.message||j?.raw||`Deriv OAuth token exchange failed (${r.status}).`});
    }
    if(!j?.access_token)return res.status(502).json({error:'Deriv OAuth returned no access token.'});
    return res.status(200).json({accessToken:j.access_token,tokenType:j.token_type||'Bearer',expiresIn:Number(j.expires_in||3600),refreshToken:j.refresh_token||null});
  }catch(e){
    return res.status(500).json({error:e?.message||'Deriv OAuth exchange failed.'});
  }
}
