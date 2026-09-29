/** Disposable local final-build conversation; actual generated replies accumulate. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
const runtime=resolve(process.argv[2]);
assert(!relative(resolve('.runtime/personal05'),runtime).startsWith('..'));
const server=JSON.parse(readFileSync(resolve(runtime,'server.json')));
assert(server.synthetic_only && server.url==='http://127.0.0.1:3127');
const base=server.url, email=`personal05-${Date.now()}@example.invalid`, password=randomBytes(12).toString('hex');
let cookie='', id, free=0;
const A='COMPANY_DEMO_008', B='COMPANY_DEMO_002';
const append=(file,data)=>appendFileSync(resolve(runtime,file),JSON.stringify(data)+'\n');
async function api(path,method='GET',body,auth=cookie){
  const response=await fetch(base+path,{method,headers:{'content-type':'application/json','sec-fetch-site':'same-origin',origin:base,...(auth?{cookie:auth}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
function record(check,extra={}){append('http-checks.jsonl',{check,...extra});console.log(JSON.stringify({check,...extra}));}
const questions=new Map([
  [5,'한빛테크에서 제가 보유한 문서와 없는 서류를 구분하고 임금체불 진정에 어떻게 사용하는지 알려주세요.'],
  [8,'다온제조에서는 제가 보유한 서류가 무엇이고, 임금체불 진정 자료로 어떻게 활용하나요?'],
  [11,'한빛테크와 다온제조의 계약서 보유 상태를 구분하고 임금체불 자료로 어떻게 활용하나요?'],
  [14,'한빛테크의 급여일과 지급 약속을 고려해, 약속일까지 입금되지 않으면 어떤 기록을 남기고 어디에 접수하나요?'],
  [17,'한빛테크와 다온제조에서 제가 갖고 있다고 말한 문서와 없는 서류를 각각 구분하고 임금체불 진정 자료로 어떻게 쓰는지 알려주세요.'],
  [20,'한빛테크에서 계약서 원본을 계속 보관 중인가요? 최근 정정과 통장 사본, 급여명세서 보유 상태를 구분하고 임금체불 자료로 어떻게 활용하는지 알려주세요.'],
  [23,'한빛테크 임금 문제로 돌아가겠습니다. 1350 상담과 정식 진정 접수는 어떻게 다른가요?'],
  [26,'1. 한빛테크 2. 다온제조 순서로 제가 말한 계약서 보유 상태를 정리하고 임금체불 진정에 필요한 다음 행동과 출처를 알려주세요.'],
]);
const statements=new Map([
 [1,[A,'한빛테크의 급여일은 10일입니다. 근로계약서 종이 원본과 통장 사본을 갖고 있습니다. 급여명세서는 없습니다. 회사에서 9월 27일 지급하겠다는 문자를 받았습니다.']],
 [2,[B,'다온제조의 급여일은 7일입니다. 계약서 사본과 급여명세서를 갖고 있습니다.']],
 [3,[B,'정정합니다. 한빛테크의 급여일은 10일이 아니라 15일입니다.']],
 [9,[A,'정정합니다. 한빛테크의 급여일은 15일입니다. 근로계약서 원본은 분실했고 사본만 갖고 있습니다.']],
]);
try{
 const signup=await api('/api/auth/signup','POST',{email,password,name:'Personal05 HTTP 합성'});assert.equal(signup.status,201);cookie=signup.cookie;
 for(let turn=1;turn<=26;turn++){
   if(turn===12 || turn===21)assert.equal((await api(`/api/conversations/${id}`,'PATCH',{active_company_id:null})).status,200);
   const [company,message]=statements.get(turn)??[turn<12?(turn%2?A:B):undefined,questions.get(turn)??'한빛테크와 다온제조의 급여일과 지급 약속을 각각 다시 말해 주세요.'];
   const request={message,company_id:company,conversation_id:id,request_id:randomUUID(),chat_mode:'wage',recent_messages:[],external_processing_consent:true};
   const start=performance.now();const result=await api('/api/chat','POST',request);
   assert.equal(result.status,200);assert.equal(result.data.conversation_persistence,'saved');id=result.data.conversation_id;
   const answer=result.data.results[0], generated=answer.metrics.usage.total_tokens!==null;
   if(generated)free++;assert(free<=10,'FREE_GENERATION_CAP');
   append('continuous.jsonl',{turn,request,result:result.data,generated,duration_ms:performance.now()-start});
   record('turn',{turn,generated,status:answer.status,guard:answer.trace.guardrail_action,checkpoint:answer.trace.memory?.summarized_through_sequence});
   if(turn===15){
     const prior=await api(`/api/conversations/${id}`);assert.equal(prior.data.turns.length,15);
     await api('/api/auth/logout','POST',{});const login=await api('/api/auth/login','POST',{email,password},'');assert.equal(login.status,200);cookie=login.cookie;
     assert.deepEqual((await api(`/api/conversations/${id}`)).data.turns,prior.data.turns);record('relogin restore15 exact');
   }
   if(turn===26){
     const replay=await api('/api/chat','POST',request);assert.equal(replay.data.idempotent_replay,true);assert.equal(replay.data.results[0].answer,answer.answer);
     assert.equal((await api(`/api/conversations/${id}`)).data.turns.length,26);record('saved replay exact26');
   }
 }
 record('continuous completed',{turns:26,free_generation:free,provider_free:26-free});
 writeFileSync(resolve(runtime,'restart.once'),'own app only');
 for(let attempt=0;attempt<60&&!existsSync(resolve(runtime,'app-restart.json'));attempt++)await new Promise(done=>setTimeout(done,500));
 assert(existsSync(resolve(runtime,'app-restart.json')));
 assert.equal((await api(`/api/conversations/${id}`)).data.turns.length,26);record('app restart restored26');
 const other=await api('/api/auth/signup','POST',{email:`other-${email}`,password,name:'Personal05 owner'},'');
 assert.equal((await api(`/api/conversations/${id}`,'GET',undefined,other.cookie)).status,404);
 assert.equal((await api('/api/auth/account','DELETE',{confirmation:'계정 삭제'},other.cookie)).status,200);record('owner isolation404');
 for(const fault of ['citation','unavailable']){
   writeFileSync(resolve(runtime,`${fault}.once`),'synthetic generation fault');
   const request={message:'한빛테크의 정정한 급여일과 지급 약속을 정리하고 임금체불 진정에 지금 필요한 행동을 알려주세요.',company_id:B,conversation_id:id,request_id:randomUUID(),chat_mode:'wage',recent_messages:[],external_processing_consent:true};
   const result=await api('/api/chat','POST',request);assert.equal(result.status,200);assert.equal(result.data.conversation_persistence,'saved');
   const answer=result.data.results[0];assert.match(answer.answer,/15일/);assert(answer.sources.length>0);
   if(fault==='citation')assert(answer.trace.guardrail_hits.includes('CITATION_ONLY_ANSWER'));
   else assert.equal(answer.status,'fallback');
   append('fault-results.jsonl',{fault,request,result:result.data});record('fault recovered',{fault,status:answer.status,guard:answer.trace.guardrail_action});
 }
}catch(error){record('FAILED',{code:error.code??'ASSERTION',message:error.message.split('\n')[0]});process.exitCode=1;}
finally{
 if(cookie){const deleted=await api('/api/auth/account','DELETE',{confirmation:'계정 삭제'});record('synthetic account cleanup',{status:deleted.status});
   assert.equal(deleted.status,200);assert.equal((await api('/api/auth/session')).data.authenticated,false);
   assert.equal((await api('/api/auth/login','POST',{email,password},'')).status,401);record('deleted session and login rejected');}
}
