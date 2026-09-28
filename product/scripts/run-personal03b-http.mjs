/** Real local HTTP/auth/storage, disposable synthetic users only. Requires --serve harness. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

const runtime = resolve(process.argv[2]);
assert(!relative(resolve('.runtime/personal03'), runtime).startsWith('..'));
assert(execFileSync('git', ['check-ignore', runtime], { encoding: 'utf8' }).trim());
const server = JSON.parse(readFileSync(resolve(runtime, 'server.json')));
assert.equal(server.synthetic_only, true); assert.equal(server.url, 'http://127.0.0.1:3127');
const base = server.url;
const password = randomBytes(14).toString('hex');
const email = `personal03b-${Date.now()}@example.invalid`;
let cookie = '', id;
const outcomes = [];
const remainingOnly = process.argv.includes('--remaining-only');
const record = (name, result) => { outcomes.push({ name, ...result }); appendFileSync(resolve(runtime, 'http-checks.jsonl'), JSON.stringify({ name, ...result }) + '\n'); console.log(JSON.stringify({ name, ...result })); };
async function api(path, method = 'GET', body, auth = cookie, headers = {}) {
  const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin',
    origin: base, ...(auth ? { cookie: auth } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
async function chat(message, company_id, extra = {}) {
  const request = { message, company_id, conversation_id: id, request_id: randomUUID(), chat_mode: 'wage',
    recent_messages: [], external_processing_consent: true, ...extra };
  const result = await api('/api/chat', 'POST', request);
  assert.equal(result.status, 200); assert.equal(result.data.conversation_persistence, 'saved');
  id = result.data.conversation_id;
  return { ...result.data, input: request };
}
const A = 'COMPANY_DEMO_008', B = 'COMPANY_DEMO_002';
try {
  const signup = await api('/api/auth/signup', 'POST', { email, password, name: 'Personal03B HTTP 합성' });
  assert.equal(signup.status, 201); cookie = signup.cookie;
  const turns = [
    [A, '한빛테크에서는 9월 27일 지급하겠다는 문자를 받았습니다. 급여일은 10일입니다.'],
    [B, '다온제조의 급여일은 7일입니다.'],
    [A, '다온제조에서는 아직 지급 약속을 받은 적이 없습니다.'],
    [A, '정정합니다. 다온제조의 급여일은 7일이 아니라 8일입니다.'],
  ];
  for (let index = 0; index < (remainingOnly ? 4 : 26); index++) {
    const [company, message] = turns[index] ?? [index % 2 ? B : A, '한빛테크와 다온제조의 급여일과 지급 약속을 각각 어떻게 말했는지 알려주세요.'];
    const result = await chat(message, company);
    assert.equal(result.results[0].trace.rag_reason, 'conversation_recall_no_retrieval');
    if (index >= 4) {
      assert.match(result.results[0].answer, /한빛테크[^\n]*10일[^\n]*9월 27일/);
      assert.match(result.results[0].answer, /다온제조[^\n]*8일[^\n]*약속을 받지 않았/);
    }
  }
  if (!remainingOnly) {
  record('26-turn company attribution', { pass: true, turns: 26, provider_calls: 0 });
  const detail = await api(`/api/conversations/${id}`);
  assert.equal(detail.data.turns.length, 26);
  assert.equal(detail.data.turns[2].company_id, A);
  assert(detail.data.turns[2].messages[0].content.includes('다온제조'));
  assert.equal((await api(`/api/conversations/${id}`, 'PATCH', { active_company_id: null })).status, 200);
  await api('/api/auth/logout', 'POST', {});
  const login = await api('/api/auth/login', 'POST', { email, password }, '');
  assert.equal(login.status, 200); cookie = login.cookie;
  const restored = await chat('한빛테크와 다온제조의 급여일과 지급 약속을 각각 어떻게 말했는지 알려주세요.');
  assert.match(restored.results[0].answer, /다온제조[^\n]*8일[^\n]*약속을 받지 않았/);
  assert.equal(restored.results[0].trace.memory.summarized_through_sequence, 50);
  const replay = await api('/api/chat', 'POST', restored.input);
  assert.equal(replay.data.idempotent_replay, true);
  record('clear relogin checkpoint50 replay', { pass: true, provider_calls: 0 });
  }
  const other = await api('/api/auth/signup', 'POST', { email: `other-${email}`, password, name: 'Personal03B owner 합성' }, '');
  assert.equal((await api(`/api/conversations/${id}`, 'GET', undefined, other.cookie)).status, 404);
  assert.equal((await api('/api/auth/account', 'DELETE', { confirmation: '계정 삭제' }, other.cookie)).status, 200);
  const favorite = await api(`/api/users/me/favorites/${A}`, 'PUT');
  assert([200, 201].includes(favorite.status));
  assert.equal((await api('/api/users/me/favorites')).status, 200);
  assert.equal((await api('/api/contracts/review', 'POST', { text: '합성 계약' }, '', { 'sec-fetch-site': 'cross-site' })).status, 403);
  record('owner favorite contract protection', { pass: true });
  const question = '정정한 급여일과 회사 지급 약속을 정리하고 지금 할 일을 알려주세요.';
  const live = await chat(question, B);
  assert.match(live.results[0].answer, /8일/); assert.match(live.results[0].answer, /약속을 받지 않았/);
  assert.notEqual(live.results[0].trace.rag_reason, 'conversation_recall_no_retrieval');
  record('live mixed next action', { status: live.results[0].status, hits: live.results[0].trace.guardrail_hits, sources: live.results[0].sources.length });
  if (!process.argv.includes('--live-only')) {
  writeFileSync(resolve(runtime, 'citation.once'), 'synthetic fault, not provider quality');
  const citation = await chat(question, B);
  assert(citation.results[0].trace.guardrail_hits.includes('CITATION_ONLY_ANSWER'));
  assert(citation.results[0].answer.length > 100);
  record('citation-only injected recovery', { pass: true, status: citation.results[0].status, sources: citation.results[0].sources.length });
  writeFileSync(resolve(runtime, 'unavailable.once'), 'synthetic fault');
  const unavailable = await chat(question, B);
  assert.match(unavailable.results[0].answer, /8일/);
  record('provider-unavailable injected recovery', { status: unavailable.results[0].status, sources: unavailable.results[0].sources.length });
  }
  assert.equal((await api('/api/auth/account', 'DELETE', { confirmation: '계정 삭제' })).status, 200);
  assert.equal((await api('/api/auth/session')).data.authenticated, false);
  assert.equal((await api('/api/auth/login', 'POST', { email, password }, '')).status, 401);
  record('DELETE200 old-session login invalidation', { pass: true });
} catch (error) {
  record('FAILED', { code: error.code ?? 'CHECK_FAILED', message: error.message });
  process.exitCode = 1;
} finally {
  writeFileSync(resolve(runtime, 'http-checks-summary.json'), JSON.stringify({ completed: !process.exitCode, outcomes }, null, 2));
}
