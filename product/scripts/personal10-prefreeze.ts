/** Existing Personal05 development scenario only; never part of the new holdout. */
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { sendParsedComparedChatRequest } from '../src/services/chatComparisonService';
import { hydrateConversationRequest, persistCompletedChat, getUserConversation } from '../src/services/conversationService';
import { resetMockConversationsForTests } from '../src/services/userDataProviders';
import type { ChatRequest } from '../src/domain/chat';

const runtime = process.env.MW10_PREFREEZE_RUNTIME!;
const append = (file: string, value: unknown) => appendFileSync(resolve(runtime, file), JSON.stringify(value) + '\n');
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const originalFetch = globalThis.fetch;
let activeTurn = 0, calls = 0, consecutiveFailures = 0, stopped = false;
const cap = Number(process.env.MW10_PREFREEZE_CAP);
globalThis.fetch = async (url, init) => {
  if (String(url) !== 'https://api.upstage.ai/v1/chat/completions') return originalFetch(url, init);
  assert(!stopped && calls < cap, 'PREFREEZE_CALL_CAP');
  const payload = JSON.parse(String(init?.body));
  const phase = payload.max_tokens === 120 ? 'rewrite' : payload.max_tokens === 100 ? 'classification' : 'generation';
  const call = ++calls, start = performance.now();
  append('attempts.jsonl', { turn: activeTurn, call, phase, started_at: new Date().toISOString() });
  try {
    const response = await originalFetch(url, init);
    const data = await response.clone().json();
    append('provider-calls.jsonl', { turn: activeTurn, call, phase, status: response.status,
      payload, prompt_sha256: sha(payload.messages), raw_answer: data.choices?.[0]?.message?.content ?? null,
      model: data.model ?? null, usage: data.usage ?? null, finish_reason: data.choices?.[0]?.finish_reason ?? null,
      duration_ms: performance.now() - start });
    consecutiveFailures = response.ok ? 0 : consecutiveFailures + 1;
    if ([401, 403, 429].includes(response.status) || consecutiveFailures >= 2) stopped = true;
    return response;
  } catch {
    append('provider-calls.jsonl', { turn: activeTurn, call, phase, status: 'network_or_parse_error',
      prompt_sha256: sha(payload.messages), usage: null, duration_ms: performance.now() - start });
    if (++consecutiveFailures >= 2) stopped = true;
    throw new Error('SANITIZED_UPSTREAM_FAILURE');
  }
};

const A = 'COMPANY_DEMO_008', B = 'COMPANY_DEMO_002';
const user = { user_id: '00000000-0000-4000-8000-000000000010',
  email: 'personal10-prefreeze@example.invalid', display_name: 'synthetic', role: 'user' as const };
const questions = new Map<number, string>([
  [5, '한빛테크에서 제가 보유한 문서와 없는 서류를 구분하고 임금체불 진정에 어떻게 사용하는지 알려주세요.'],
  [8, '다온제조에서는 제가 보유한 서류가 무엇이고, 임금체불 진정 자료로 어떻게 활용하나요?'],
  [11, '한빛테크와 다온제조의 계약서 보유 상태를 구분하고 임금체불 자료로 어떻게 활용하나요?'],
  [14, '한빛테크의 급여일과 지급 약속을 고려해, 약속일까지 입금되지 않으면 어떤 기록을 남기고 어디에 접수하나요?'],
  [17, '한빛테크와 다온제조에서 제가 갖고 있다고 말한 문서와 없는 서류를 각각 구분하고 임금체불 진정 자료로 어떻게 쓰는지 알려주세요.'],
  [20, '한빛테크에서 계약서 원본을 계속 보관 중인가요? 최근 정정과 통장 사본, 급여명세서 보유 상태를 구분하고 임금체불 자료로 어떻게 활용하는지 알려주세요.'],
  [23, '한빛테크 임금 문제로 돌아가겠습니다. 1350 상담과 정식 진정 접수는 어떻게 다른가요?'],
  [26, '1. 한빛테크 2. 다온제조 순서로 제가 말한 계약서 보유 상태를 정리하고 임금체불 진정에 필요한 다음 행동과 출처를 알려주세요.'],
]);
const statements = new Map<number, [string, string]>([
  [1, [A, '한빛테크의 급여일은 10일입니다. 근로계약서 종이 원본과 통장 사본을 갖고 있습니다. 급여명세서는 없습니다. 회사에서 9월 27일 지급하겠다는 문자를 받았습니다.']],
  [2, [B, '다온제조의 급여일은 7일입니다. 계약서 사본과 급여명세서를 갖고 있습니다.']],
  [3, [B, '정정합니다. 한빛테크의 급여일은 10일이 아니라 15일입니다.']],
  [9, [A, '정정합니다. 한빛테크의 급여일은 15일입니다. 근로계약서 원본은 분실했고 사본만 갖고 있습니다.']],
]);
resetMockConversationsForTests();
let id = '';
for (let turn = 1; turn <= 26; turn++) {
  activeTurn = turn;
  const [company_id, message] = statements.get(turn)
    ?? [turn < 12 ? (turn % 2 ? A : B) : '',
      questions.get(turn) ?? '한빛테크와 다온제조의 급여일과 지급 약속을 각각 다시 말해 주세요.'];
  const request: ChatRequest = { message, ...(company_id ? { company_id } : {}),
    ...(id ? { conversation_id: id } : {}), request_id: randomUUID(), chat_mode: 'wage', recent_messages: [] };
  const hydrated = id ? await hydrateConversationRequest(request, user) : request;
  const start = performance.now(), callStart = calls;
  const response = await sendParsedComparedChatRequest(hydrated);
  const result = response.results[0];
  assert(result && result.status !== 'fallback', 'PREFREEZE_PROVIDER_FALLBACK');
  id = await persistCompletedChat(hydrated, response, user);
  const detail = await getUserConversation(id, user);
  assert.equal(detail.turns.length, turn);
  append('turns.jsonl', { turn, request, prompt_scope: { memory: hydrated.conversation_recall?.diagnostics ?? null,
    document_statements: hydrated.conversation_recall?.document_statements ?? [] },
    result, provider_calls: calls - callStart, duration_ms: performance.now() - start });
  console.log(JSON.stringify({ turn, status: result.status, guard: result.trace.guardrail_action,
    provider_calls: calls - callStart }));
}
console.log(JSON.stringify({ development_scenario_only: true, turns: 26, calls, stopped }));
