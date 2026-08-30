import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const pub=path.join(root,'public');
const port=Number(process.env.PORT||3000);
const mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png'};

async function body(req){let s='';for await(const c of req)s+=c;return s?JSON.parse(s):{}}
async function upstreamPayload(r){
  const text=await r.text();
  if(!text)return{};
  try{return JSON.parse(text)}catch{return{__plainText:text}}
}
function upstreamError(j,status){
  return j?.errors?.[0]?.message||j?.error?.message||j?.message||j?.__plainText||`Deriv request failed (${status}).`;
}
async function proxy(req,res,type){
  try{
    const b=await body(req),{appId,token}=b;
    if(!appId||!token)throw Object.assign(new Error('App ID and token are required.'),{status:400});
    let url='https://api.derivws.com/trading/v1/options/accounts',method='GET';
    if(type==='otp'){
      if(!b.accountId)throw Object.assign(new Error('Account ID is required.'),{status:400});
      url+=`/${encodeURIComponent(b.accountId)}/otp`;method='POST';
    }
    const r=await fetch(url,{method,headers:{'Deriv-App-ID':String(appId),Authorization:`Bearer ${token}`,Accept:'application/json'}});
    const j=await upstreamPayload(r);
    res.writeHead(r.status,{'content-type':'application/json','cache-control':'no-store'});
    if(!r.ok)return res.end(JSON.stringify({error:upstreamError(j,r.status)}));
    if(type==='otp'){
      const socketUrl=j?.data?.url;
      if(!socketUrl)return res.end(JSON.stringify({error:'Deriv authorized the account but returned no trading WebSocket URL.'}));
      return res.end(JSON.stringify({url:socketUrl,otpExpiresIn:120}));
    }
    const data=j?.data;
    const accounts=Array.isArray(data)?data:[data].filter(Boolean);
    return res.end(JSON.stringify({accounts}));
  }catch(e){
    res.writeHead(e.status||500,{'content-type':'application/json','cache-control':'no-store'});
    res.end(JSON.stringify({error:e.message||'Unexpected error'}));
  }
}

http.createServer(async(req,res)=>{
  if(req.method==='POST'&&req.url==='/api/accounts')return proxy(req,res,'accounts');
  if(req.method==='POST'&&req.url==='/api/otp')return proxy(req,res,'otp');
  let rel=req.url==='/'?'index.html':req.url.split('?')[0].replace(/^\//,'');
  const f=path.join(pub,rel);
  if(!f.startsWith(pub)){res.writeHead(403);return res.end();}
  try{
    const data=await fs.readFile(f);
    res.writeHead(200,{'content-type':mime[path.extname(f)]||'application/octet-stream','cache-control':'no-store'});
    res.end(data);
  }catch{res.writeHead(404);res.end('Not found');}
}).listen(port,()=>console.log(`SANI BOS Executor http://localhost:${port}`));
