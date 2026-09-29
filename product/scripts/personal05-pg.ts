/** New personal05 tmpfs database only. No schema or role mutations. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { registerUser } from '../src/services/authService';
import { getConversationRepository, getAuthRepository } from '../src/services/userDataProviders';
import { claimConversationRequest, completeClaimedConversationRequest, rememberGeneratedResponse, cachedGeneratedResponse, deleteUserConversation, hydrateConversationRequest } from '../src/services/conversationService';
import { recallResponse } from '../src/services/conversationRecallService';
import { closeWritePools } from '../src/server/postgresWrite';
import { ServiceError } from '../src/utils/errors';
for (const key of ['AUTH_DATABASE_URL','CONVERSATION_DATABASE_URL']) {
  const target = new URL(process.env[key]!);
  assert(target.hostname === '127.0.0.1' && target.port === '55442' && target.pathname === '/mw_personal05');
}
const outcomes:string[]=[];
try {
  const registered=await registerUser({email:`pg05-${randomUUID()}@example.invalid`,password:randomBytes(12).toString('hex'),name:'Personal05 synthetic'});
  const user=registered.response.user;
  const request={message:'급여일은 15일입니다.',request_id:randomUUID(),chat_mode:'wage' as const,recent_messages:[]};
  const claim=await claimConversationRequest(request,user);
  const full={...request,conversation_id:claim.conversation_id,conversation_request_lease_token:claim.lease_token!};
  const generated=recallResponse(request,[{id:'upstage',label:'synthetic',model:'none'}])!;
  rememberGeneratedResponse(user,request.request_id,generated);
  const repository=getConversationRepository(), original=repository.completeRequest.bind(repository);
  repository.completeRequest=async()=>{throw new ServiceError('CONVERSATION_PERSISTENCE_FAILED','Synthetic service-boundary failure',503,true);};
  try {await assert.rejects(completeClaimedConversationRequest(full,generated,user),{code:'CONVERSATION_PERSISTENCE_FAILED'});}
  finally {repository.completeRequest=original;}
  assert.equal((await repository.findConversation(claim.conversation_id))!.turns.length,0);
  const cached=cachedGeneratedResponse(user,request.request_id)!;assert(cached);
  await completeClaimedConversationRequest(full,cached,user);
  assert.equal((await repository.findConversation(claim.conversation_id))!.turns.length,1);
  assert.equal(cachedGeneratedResponse(user,request.request_id),null);
  outcomes.push('injected service save failure -> real PG cached save-only retry; generation0');
  const pending={...request,conversation_id:claim.conversation_id,request_id:randomUUID()};
  const late=await claimConversationRequest(pending,user);
  await deleteUserConversation(claim.conversation_id,user);
  await assert.rejects(completeClaimedConversationRequest({...pending,conversation_request_lease_token:late.lease_token!},generated,user),{code:'CONVERSATION_NOT_FOUND'});
  await assert.rejects(hydrateConversationRequest(pending,user),{code:'CONVERSATION_NOT_FOUND'});
  assert.equal(await repository.findConversation(claim.conversation_id),null);
  outcomes.push('real PG deletion rejects late completion and memory hydration');
  assert(await getAuthRepository().deleteAccount(registered.session.token));
  writeFileSync(resolve(process.env.MW_MEMORY_EVAL_RUNTIME!,'pg-recovery.json'),JSON.stringify({passed:true,outcomes,schema_changes:0,provider_calls:0},null,2));
  console.log('MEMORY_EVAL '+JSON.stringify({personal05_pg_recovery:'PASS',checks:outcomes.length}));
}catch(error){console.log('MEMORY_EVAL '+JSON.stringify({personal05_pg_recovery:'FAIL',code:(error as {code?:string}).code??'ASSERTION'}));process.exitCode=1;}
finally {await closeWritePools();}
