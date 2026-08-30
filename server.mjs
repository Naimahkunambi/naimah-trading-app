import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import accountsHandler from './api/accounts.js';
import otpHandler from './api/otp.js';
import naiAiHandler from './api/nai-ai.js';
import derivSessionStartHandler from './api/deriv-session-start.js';
import derivSessionCompleteHandler from './api/deriv-session-complete.js';
import derivSessionAccountsHandler from './api/deriv-session-accounts.js';

const root=path.dirname(fileURLToPath(import.meta.url));
const pub=path.join(root,'public');
const port=Number(process.env.PORT||3000);
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'};

async function readBody(req){
  let s='';
  for await(const c of req)s+=c;
  if(!s)return{};
  try{return JSON.parse(s)}catch{return{}}
}

function augmentResponse(res){
  if(typeof res.status!=='function')res.status=code=>{res.statusCode=code;return res};
  if(typeof res.json!=='function')res.json=value=>{
    if(!res.headersSent)res.setHeader('content-type','application/json; charset=utf-8');
    res.end(JSON.stringify(value));
    return res;
  };
  if(typeof res.send!=='function')res.send=value=>{
    if(value!=null&&typeof value==='object'&&!Buffer.isBuffer(value)){
      if(!res.headersSent)res.setHeader('content-type','application/json; charset=utf-8');
      res.end(JSON.stringify(value));
    }else res.end(value==null?'':String(value));
    return res;
  };
  return res;
}

const API_ROUTES=new Map([
  ['/api/accounts',accountsHandler],
  ['/api/otp',otpHandler],
  ['/api/nai-ai',naiAiHandler],
  ['/api/deriv-session-start',derivSessionStartHandler],
  ['/api/deriv-session-complete',derivSessionCompleteHandler],
  ['/api/deriv-session-accounts',derivSessionAccountsHandler]
]);

async function serveApi(req,res,url){
  const handler=API_ROUTES.get(url.pathname);
  if(!handler)return false;
  req.query=Object.fromEntries(url.searchParams.entries());
  if(['POST','PUT','PATCH','DELETE'].includes(req.method||''))req.body=await readBody(req);
  augmentResponse(res);
  res.setHeader('cache-control','no-store, max-age=0');
  res.setHeader('x-content-type-options','nosniff');
  try{await handler(req,res)}catch(e){
    if(!res.writableEnded){
      res.statusCode=500;
      res.setHeader('content-type','application/json; charset=utf-8');
      res.end(JSON.stringify({error:e?.message||'Unhandled API error.'}));
    }
  }
  return true;
}

async function findPublicFile(pathname){
  let rel=pathname==='/'?'index.html':pathname.replace(/^\//,'');
  let candidate=path.join(pub,rel);
  if(!candidate.startsWith(pub))return null;
  try{const st=await fs.stat(candidate);if(st.isFile())return candidate}catch{}
  if(!path.extname(candidate)){
    const html=`${candidate}.html`;
    try{const st=await fs.stat(html);if(st.isFile())return html}catch{}
  }
  return null;
}

http.createServer(async(req,res)=>{
  const url=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);
  if(await serveApi(req,res,url))return;

  const file=await findPublicFile(url.pathname);
  if(!file){res.writeHead(404,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'});return res.end('Not found');}
  try{
    const data=await fs.readFile(file);
    res.writeHead(200,{'content-type':mime[path.extname(file)]||'application/octet-stream','cache-control':'no-store'});
    res.end(data);
  }catch{
    res.writeHead(500,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'});
    res.end('Server error');
  }
}).listen(port,()=>console.log(`SANI BOS Executor http://localhost:${port}`));
