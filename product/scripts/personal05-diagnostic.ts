import assert from 'node:assert/strict';
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DualLlmChatProvider } from '../src/adapters/real/DualLlmChatProvider';
import { OpenAICompatibleChatClient } from '../src/adapters/real/OpenAICompatibleChatClient';
import { getLlmProviderConfigs } from '../src/server/llmConfig';
import { reviewedLaborRetrieval } from '../src/services/reviewedLaborGuidance';
import { wageArrearsFallback } from '../src/services/wageArrearsGuidance';
import { createAnswerPlan } from '../src/services/answerPlanService';
import { finalizeConversationResponse } from '../src/services/conversationRecallService';
import type { ChatResponse, ChatRequest } from '../src/domain/chat';
const runtime=process.env.MW05_RUNTIME!;
const oldRows=readFileSync('.runtime/personal04/1790573412995-after/results.jsonl','utf8').trim().split('\n').map(line=>JSON.parse(line));
const request:ChatRequest=oldRows.find(row=>row.id==='turn10').request;
const preceding=oldRows.find(row=>row.id==='turn9').raw;
const configs=getLlmProviderConfigs().filter(c=>c.id==='upstage');
const append=(file:string,value:unknown)=>appendFileSync(resolve(runtime,file),JSON.stringify(value)+'\n');
const rag=reviewedLaborRetrieval(request.message)!;
const baseline:ChatResponse={conversation_id:'synthetic05',answer:'',answer_type:'general_guidance',sources:rag.documents.map(d=>d.source),suggested_actions:[],limitations:[],guardrail_status:'passed'};
const policy=wageArrearsFallback(request.message,baseline,rag,false)??baseline;
const nativeFetch=globalThis.fetch;
let calls=0, failures=0, stopped=false;
let active={variant:'',repeat:0};
const measured:typeof fetch=async(url,init)=>{
  assert(!stopped&&calls<8); assert.equal(String(url),'https://api.upstage.ai/v1/chat/completions');
  const payload=JSON.parse(String(init?.body));
  const number=++calls;append('attempts.jsonl',{...active,call:number});
  const start=performance.now();
  try {
    const response=await nativeFetch(url,init);const data=await response.clone().json();
    const raw=data.choices?.[0]?.message?.content??null;
    append('calls.jsonl',{...active,call:number,payload,prompt_sha256:createHash('sha256').update(JSON.stringify(payload.messages)).digest('hex'),raw_answer:raw,http_status:response.status,finish_reason:data.choices?.[0]?.finish_reason,usage:data.usage??null,model:data.model,duration_ms:performance.now()-start,exact_previous_repeat:raw===preceding});
    failures=response.ok?0:failures+1; if([401,403,429].includes(response.status)||failures>=2)stopped=true;
    assert(response.ok,'UPSTREAM_FAILURE');return response;
  } catch { stopped=true; throw new Error('SANITIZED_CALL_FAILURE'); }
};
const variants=process.env.MW05_MODE==='diagnostic'?['current','no-assistant','no-assistant-or-advice']:['current'];
try {
for(let repeat=1;repeat<=2;repeat++)for(const variant of variants){
  active={variant,repeat};
  const req=structuredClone(request);
  if(variant!=='current')req.recent_messages=req.recent_messages.filter(m=>m.role==='user');
  if(variant==='no-assistant-or-advice'&&req.conversation_memory)req.conversation_memory.content=req.conversation_memory.content.split('\n').filter(line=>!line.startsWith('기존 안내:')).join('\n');
  const before=calls;
  const comparison=await new DualLlmChatProvider(configs,new OpenAICompatibleChatClient(measured)).compare({request:req,policyBaseline:policy,ragRetrieval:rag,questionIntent:'labor',answerPlan:createAnswerPlan(req,{intent:'labor',topic:'other',company_scope:'not_applicable',status:'classified'})});
  assert(!stopped&&calls===before+1&&comparison.results[0].status!=='fallback');
  const result=finalizeConversationResponse(req,comparison).results[0];
  append('results.jsonl',{...active,request:req,question:req.message,result});console.log(JSON.stringify({...active,guard:result.trace.guardrail_action}));
}
}catch {writeFileSync(resolve(runtime,'failure.json'),JSON.stringify({calls,stopped,active}));process.exitCode=1;}
