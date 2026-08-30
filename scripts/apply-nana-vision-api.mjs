import fs from 'node:fs';

const file='api/nana-ai.js';
let s=fs.readFileSync(file,'utf8');
function replaceOnce(before,after,label){if(!s.includes(before))throw new Error(`Nana vision API ${label}: marker not found`);s=s.replace(before,after)}

replaceOnce(
"async function callGemini(apiKey,model,payload,groq){\n  const url=`${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;\n  const reviewPrompt=`${CORE}\\nYou are Nana's independent SECOND reviewer. Groq proposes:\\n${JSON.stringify(groq.judgment)}\\nReview the same compact market and FILMSTRIP. Do not agree just to agree. ${OUTPUT_RULE}\\nMARKET:${JSON.stringify(payload)}`;\n  const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{role:'user',parts:[{text:reviewPrompt}]}],generationConfig:{temperature:0.1,maxOutputTokens:360,responseMimeType:'application/json'}})});",
"async function callGemini(apiKey,model,payload,groq,chartImage=null){\n  const url=`${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;\n  const reviewPrompt=`${CORE}\\nYou are Nana's independent SECOND reviewer and VISUAL CHART READER. Groq proposes:\\n${JSON.stringify(groq.judgment)}\\nReview the same compact market and FILMSTRIP. If a chart image is attached, inspect the ordered visual path, slope changes, impulse size, pullback size, extension and whether the latest bounce/retrace is small or structurally meaningful. Do not agree just to agree. ${OUTPUT_RULE}\\nMARKET:${JSON.stringify(payload)}`;\n  const parts=[{text:reviewPrompt}];\n  if(chartImage&&typeof chartImage==='string'&&chartImage.startsWith('data:image/')){const m=chartImage.match(/^data:(image\\/[^;]+);base64,(.+)$/);if(m)parts.push({inline_data:{mime_type:m[1],data:m[2]}})}\n  const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{role:'user',parts}],generationConfig:{temperature:0.1,maxOutputTokens:360,responseMimeType:'application/json'}})});",
'Gemini image parts');

replaceOnce(
"const{model='qwen/qwen3.8-27b',geminiModel='gemini-2.5-flash',market,config,position,recentJudgments=[]}=req.body||{};",
"const{model='qwen/qwen3.8-27b',geminiModel='gemini-2.5-flash',market,config,position,recentJudgments=[],chartImage=null}=req.body||{};",
'read chart image');

replaceOnce(
"const gemini=await callGemini(geminiKey,geminiModel,payload,groq);",
"const gemini=await callGemini(geminiKey,geminiModel,payload,groq,chartImage);",
'call vision reviewer');

replaceOnce(
"return res.status(200).json({judgment,consensus:{groq:groq.judgment,gemini:gemini.judgment},models:{groq:groq.model,gemini:gemini.model},usage:{groq:groq.usage,gemini:gemini.usage},reviewed:true,mode:'DUO_REVIEW',schoolPages:SCHOOL.length})",
"return res.status(200).json({judgment,consensus:{groq:groq.judgment,gemini:gemini.judgment},models:{groq:groq.model,gemini:gemini.model},usage:{groq:groq.usage,gemini:gemini.usage},reviewed:true,visionUsed:Boolean(chartImage),mode:chartImage?'DUO_VISION_REVIEW':'DUO_REVIEW',schoolPages:SCHOOL.length})",
'report vision mode');

fs.writeFileSync(file,s);
console.log('Nana vision API applied: Gemini receives chart image when due; Groq remains compact text scout.');
