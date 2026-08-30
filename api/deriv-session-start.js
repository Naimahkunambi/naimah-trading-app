import crypto from 'node:crypto';

const CALLBACK='https://sani-bos-executor-git-codex-aed5c8-naimakunambi-6312s-projects.vercel.app/nai-login';
const AUTH='https://auth.deriv.com/oauth2/auth';

const b64u=b=>Buffer.from(b).toString('base64url');
const cookie=(name,value,maxAge=600)=>`${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

export default async function handler(req,res){
  const clientId=String(req.query?.client_id||'').trim();
  if(!clientId)return res.status(400).send('Missing Deriv OAuth client ID.');
  const verifier=b64u(crypto.randomBytes(48));
  const challenge=b64u(crypto.createHash('sha256').update(verifier).digest());
  const state=b64u(crypto.randomBytes(24));
  res.setHeader('Set-Cookie',[
    cookie('nai_deriv_verifier',verifier),
    cookie('nai_deriv_state',state),
    cookie('nai_deriv_client',clientId)
  ]);
  const q=new URLSearchParams({response_type:'code',client_id:clientId,redirect_uri:CALLBACK,scope:'trade',state,code_challenge:challenge,code_challenge_method:'S256'});
  res.writeHead(302,{Location:`${AUTH}?${q}`});
  res.end();
}
