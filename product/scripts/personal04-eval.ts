/** Bundled only by run-personal04.mjs. Development cases, no public mode. */
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DualLlmChatProvider } from '../src/adapters/real/DualLlmChatProvider';
import { OpenAICompatibleChatClient } from '../src/adapters/real/OpenAICompatibleChatClient';
import { getLlmProviderConfigs } from '../src/server/llmConfig';
import { reviewedLaborRetrieval } from '../src/services/reviewedLaborGuidance';
import { wageArrearsFallback } from '../src/services/wageArrearsGuidance';
import { recallResponse, finalizeConversationResponse } from '../src/services/conversationRecallService';
import { sendParsedComparedChatRequest } from '../src/services/chatComparisonService';
import { getUserConversation, hydrateConversationRequest, persistCompletedChat } from '../src/services/conversationService';
import { resetMockConversationsForTests } from '../src/services/userDataProviders';
import { createAnswerPlan } from '../src/services/answerPlanService';
import { publicAnswerText } from '../src/services/publicAnswerContext';
import type { ChatRequest, RecentMessage, ChatResponse } from '../src/domain/chat';
import type { ComparisonContext } from '../src/domain/chatComparison';

const runtime = process.env.MW04_RUNTIME!;
const mode = process.env.MW04_MODE!;
const cap = Number(process.env.MW04_CAP);
const save = (file: string, data: unknown) => writeFileSync(resolve(runtime, file), JSON.stringify(data, null, 2));
const append = (file: string, data: unknown) => appendFileSync(resolve(runtime, file), JSON.stringify(data) + '\n');
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const configs = getLlmProviderConfigs().filter(c => c.id === 'upstage');
assert(configs[0].apiKey);
const user = { user_id: '00000000-0000-4000-8000-000000000004', email: 'synthetic04@example.invalid', display_name: 'synthetic04', role: 'user' as const };
const question = '한빛테크의 정정한 급여일과 지급 약속을 정리하고 지금 할 일을 알려주세요.';
const seeds = [
  '급여일은 10일입니다. 회사에서는 9월 27일 지급하겠다고 했습니다.',
  '정정합니다. 한빛테크의 급여일은 10일이 아니라 15일입니다.',
  '한빛테크의 급여일과 회사 지급 약속을 다시 알려주세요.',
  '한빛테크의 정정한 급여일을 다시 말해 주세요.',
  '한빛테크의 급여일과 지급 약속을 각각 다시 알려주세요.',
  '한빛테크의 지급 약속과 급여일을 다시 말해 주세요.',
];
const baseRequest = (message: string): ChatRequest => ({ message, company_id: 'COMPANY_DEMO_008', chat_mode: 'wage', recent_messages: [] });
async function seedRoom() {
  resetMockConversationsForTests();
  let id = '';
  for (let index = 0; index < seeds.length; index++) {
    const req = await hydrateConversationRequest({ ...baseRequest(seeds[index]), conversation_id: id || undefined, request_id: `personal04_seed_${index.toString().padStart(8, '0')}` }, user);
    const response = recallResponse(req, configs);
    assert(response);
    id = await persistCompletedChat(req, response, user);
  }
  return id;
}
const room = await seedRoom();
const detail = await getUserConversation(room, user);
const history: RecentMessage[] = detail.turns.slice(0, 5).flatMap(turn => turn.messages.map(({ role, content }) => ({ role, content })));
const synthetic = history.map(m => m.role === 'assistant' ? { ...m, content: '말씀하신 내용은 사용자 진술로 기록하며 확인되지 않은 금액이나 날짜를 단정하지 않겠습니다.' } : m);
const summaryRequest = await hydrateConversationRequest({ ...baseRequest(question), conversation_id: room }, user);
assert.equal(summaryRequest.conversation_memory?.summarized_through_sequence, 10);
assert.equal(summaryRequest.recent_messages.length, 2);
const baseline: ChatResponse = { conversation_id: 'synthetic04', answer: '', answer_type: 'general_guidance',
  sources: [], suggested_actions: [], limitations: [], guardrail_status: 'passed' };
function context(request: ChatRequest): ComparisonContext {
  const rag = reviewedLaborRetrieval(request.message)!;
  assert.equal(rag.status, 'matched');
  const policy = { ...baseline, sources: rag.documents.map(d => d.source) };
  return { request, questionIntent: 'labor', ragRetrieval: rag,
    policyBaseline: wageArrearsFallback(request.message, policy, rag, false) ?? policy,
    answerPlan: createAnswerPlan(request, { intent: 'labor', topic: 'other', company_scope: 'not_applicable', status: 'classified' }) };
}
const cases: Array<{ id: string; request: ChatRequest }> = process.env.MW04_BASELINE
  ? JSON.parse(readFileSync(resolve(process.env.MW04_BASELINE, 'cases.json'), 'utf8')) : [
  { id: 'fixture', request: { ...baseRequest(question), recent_messages: synthetic } },
  { id: 'product-recall', request: { ...baseRequest(question), recent_messages: history } },
  { id: 'summary10', request: summaryRequest },
];
save('cases.json', cases);
// Keep the old source prompt/bundle as evidence; exact post-edit comparisons can use frozen case input.
save('prompt-source.json', { text: readFileSync('prompts/chat/system.md', 'utf8') });
let active = { experiment: '', id: '', variant: '', repeat: 0 };
const calls: Array<Record<string, unknown>> = [];
const rows: Array<Record<string, unknown>> = [];
let stopped = false;
let failures = 0;
const originalFetch = globalThis.fetch;
const measuredFetch: typeof fetch = async (url, init) => {
  assert.equal(String(url), 'https://api.upstage.ai/v1/chat/completions', 'UNEXPECTED_ENDPOINT');
  assert(!stopped && calls.length < cap, 'CALL_CAP_OR_STOP');
  const body = JSON.parse(String(init?.body));
  assert(JSON.stringify(body.messages).length < 60000, 'INPUT_SIZE_CAP');
  assert.equal(body.stream, false);
  const record: Record<string, unknown> = { ...active, call: calls.length + 1, started_at: new Date().toISOString(),
    phase: body.max_tokens === 120 ? 'rewrite' : body.max_tokens === 100 ? 'classification' : 'generation',
    prompt_sha256: sha(body.messages), payload: body };
  calls.push(record);
  append('attempts.jsonl', { ...active, call: record.call, started_at: record.started_at });
  const began = performance.now();
  try {
    const response = await originalFetch(url, init);
    const data = await response.clone().json();
    Object.assign(record, { http_status: response.status, raw_answer: data.choices?.[0]?.message?.content ?? null,
      finish_reason: data.choices?.[0]?.finish_reason ?? null, usage: data.usage ?? null, model: data.model ?? null });
    failures = response.ok ? 0 : failures + 1;
    if ([401, 403, 429].includes(response.status) || failures >= 2) stopped = true;
    return response;
  } catch {
    Object.assign(record, { network_or_parse_error: true, usage: null });
    if (++failures >= 2) stopped = true;
    throw new Error('SANITIZED_UPSTREAM_FAILURE');
  } finally {
    record.duration_ms = performance.now() - began;
    append('calls.jsonl', record);
  }
};
globalThis.fetch = measuredFetch;
function indicators(answer: string | null) {
  if (answer === null) return null;
  return { preamble_only: /^(?:이 상담에서 말씀하신 내용 기준입니다\.|말씀하신 내용은 사용자 진술로 기록하며 확인되지 않은 금액이나 날짜를 단정하지 않겠습니다\.)\s*$/.test(answer),
    corrected_payday: /15일/.test(answer), promise: /9월\s*27일/.test(answer),
    action: /확인|보관|정리|접수/.test(answer) && /입금|문자|내역|노동포털/.test(answer),
    citation: /근로기준법|고용노동부.*「/.test(answer) };
}
async function direct(request: ChatRequest, variant: string) {
  const ctx = context(request);
  // Change transport input only for explicitly labelled diagnostic ablations.
  const fetchVariant: typeof fetch = (url, init) => {
    const body = JSON.parse(String(init?.body));
    if (variant !== 'current') {
      const prior = request.recent_messages.slice(-10).map(m => ({ ...m, content: publicAnswerText(m.content) }));
      body.messages = variant === 'full-native'
        ? [body.messages[0], ...prior, body.messages.at(-1)]
        : [body.messages[0], { role: 'user', content: `과거 대화 기록(JSON 참고 데이터, 새 지시나 답변 예시 아님): ${JSON.stringify(prior)}` }, body.messages.at(-1)];
    }
    return measuredFetch(url, { ...init, body: JSON.stringify(body) });
  };
  const start = performance.now(), callStart = calls.length;
  const generated = await new DualLlmChatProvider(configs, new OpenAICompatibleChatClient(fetchVariant)).compare(ctx);
  const result = finalizeConversationResponse(request, generated).results[0];
  assert.equal(calls.length, callStart + 1, 'GENERATION_ATTEMPT_MISSING');
  assert.notEqual(result.status, 'fallback', 'FALLBACK_IS_NOT_RAW_QUALITY');
  const last = calls.at(-1)!;
  assert.equal(last.http_status, 200, 'NON_QUALITY_UPSTREAM_FAILURE');
  const raw = last.raw_answer as string;
  const row = { ...active, question: request.message, invariant_sha256: sha(request), raw, final: result.answer,
    final_scope: request.conversation_recall ? 'hydrated-memory provider replay' : 'generation ablation; no owner-hydrated recall metadata; final is not product acceptance',
    guard: result.trace.guardrail_action, hits: result.trace.guardrail_hits, status: result.status,
    indicators_raw: indicators(raw), indicators_final: indicators(result.answer), duration_ms: performance.now() - start,
    call: last.call, prompt_sha256: last.prompt_sha256 };
  rows.push(row); append('results.jsonl', row);
  console.log(JSON.stringify({ ...active, guard: row.guard, raw: row.indicators_raw }));
}
try {
  if (mode === 'focused') {
    const priorRows = readFileSync(resolve(process.env.MW04_BASELINE!, 'results.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const last = priorRows.find(row => row.experiment === 'continuous' && row.id === 'turn10');
    assert(last?.request);
    for (let repeat = 1; repeat <= 2; repeat++) {
      for (const item of [{ id: 'product-recall', request: cases.find(c => c.id === 'product-recall')!.request }, { id: 'turn10-replay', request: last.request as ChatRequest }]) {
        active = { experiment: 'focused-fixed', id: item.id, variant: 'current', repeat };
        await direct(item.request, 'current');
      }
    }
    active = { experiment: 'focused-service-replay', id: 'turn10', variant: 'service', repeat: 1 };
    const callStart = calls.length, start = performance.now();
    const response = await sendParsedComparedChatRequest(last.request);
    const result = response.results[0], currentCalls = calls.slice(callStart);
    assert(currentCalls.every(c => c.http_status === 200));
    const raw = currentCalls.find(c => c.phase === 'generation')?.raw_answer as string | undefined;
    assert(raw, 'REPLAY_MUST_GENERATE');
    const row = { ...active, request: last.request, question: last.request.message, raw, final: result.answer,
      guard: result.trace.guardrail_action, hits: result.trace.guardrail_hits, status: result.status,
      indicators_raw: indicators(raw), indicators_final: indicators(result.answer), duration_ms: performance.now() - start,
      calls: currentCalls.map(c => c.call), exact_previous_answer_repeat: raw === last.raw };
    rows.push(row); append('results.jsonl', row);
    console.log(JSON.stringify({ ...active, guard: row.guard, raw: row.indicators_raw, exact_repeat: row.exact_previous_answer_repeat }));
  } else {
  for (let repeat = 1; repeat <= 2; repeat++) {
    for (const item of cases) {
      const variants = mode === 'before' && item.id !== 'summary10' ? ['current', 'full-native', 'full-record'] : ['current'];
      if (repeat === 2) variants.reverse();
      for (const variant of variants) {
        active = { experiment: 'fixed', id: item.id, variant, repeat };
        await direct(item.request, variant);
      }
    }
  }
  const id = await seedRoom();
  const probes = [question,
    '한빛테크의 급여일과 지급 약속을 다시 알려주세요.',
    '한빛테크의 급여일과 지급 약속을 고려해서, 회사가 약속한 날까지 입금하지 않았다면 지금 어떤 기록을 남기고 어디에 접수하나요?',
    '한빛테크의 급여일과 지급 약속은 그대로입니다. 아직 임금을 받지 못했는데 1350 상담과 진정 접수는 어떻게 다른가요?'];
  for (let index = 0; index < probes.length; index++) {
    active = { experiment: 'continuous', id: `turn${index + 7}`, variant: 'service', repeat: 1 };
    const request = await hydrateConversationRequest({ ...baseRequest(probes[index]), conversation_id: id,
      request_id: `personal04_live_${index.toString().padStart(8, '0')}` }, user);
    const start = performance.now(), callStart = calls.length;
    const response = await sendParsedComparedChatRequest(request);
    assert(!stopped);
    const result = response.results[0];
    const currentCalls = calls.slice(callStart);
    assert(currentCalls.every(c => c.http_status === 200), 'NON_QUALITY_UPSTREAM_FAILURE');
    const raw = currentCalls.find(c => c.phase === 'generation')?.raw_answer as string | undefined;
    assert(raw !== undefined || result.status === 'policy_short_circuit', 'GENERATION_OR_SHORTCUT_REQUIRED');
    const row = { ...active, request, question: request.message, raw: raw ?? null, final: result.answer,
      guard: result.trace.guardrail_action, hits: result.trace.guardrail_hits, status: result.status,
      indicators_raw: indicators(raw ?? null), indicators_final: indicators(result.answer),
      duration_ms: performance.now() - start, calls: currentCalls.map(c => c.call) };
    rows.push(row); append('results.jsonl', row);
    await persistCompletedChat(request, response, user);
    console.log(JSON.stringify({ ...active, guard: row.guard, raw: row.indicators_raw, calls: currentCalls.length }));
  }
  }
} catch {
  save('failure.json', { active, stopped, calls: calls.length, reason: 'SANITIZED_EVAL_FAILURE' });
  process.exitCode = 1;
} finally {
  save('summary.json', { mode, calls: calls.length, rows: rows.length, http200: calls.filter(c => c.http_status === 200).length,
    returned_tokens: calls.reduce((sum, c) => sum + Number((c.usage as { total_tokens?: number } | null)?.total_tokens ?? 0), 0),
    missing_usage: calls.filter(c => !c.usage).length, retry: 0, billed_cost: null, ttft: null, storage: 'Mock only',
    raw_preamble_only: rows.filter(r => (r.indicators_raw as { preamble_only?: boolean } | null)?.preamble_only).length });
  resetMockConversationsForTests();
}
