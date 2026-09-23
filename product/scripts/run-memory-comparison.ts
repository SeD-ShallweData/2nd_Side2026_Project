/** Bundled local worker, launched only by the fresh-PG16 controller. No HTTP route. */
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { RealConversationRepository } from '../src/adapters/real/RealConversationRepository';
import { OpenAICompatibleChatClient } from '../src/adapters/real/OpenAICompatibleChatClient';
import { DualLlmChatProvider } from '../src/adapters/real/DualLlmChatProvider';
import { registerUser } from '../src/services/authService';
import { getUserConversation } from '../src/services/conversationService';
import { maybeUpdateConversationSummary, toConversationMemoryContext } from '../src/services/conversationSummaryService';
import { closeWritePools } from '../src/server/postgresWrite';
import { rewriteFollowupQuery } from '../src/services/queryRewriteService';
import { classifyChatIntent } from '../src/services/chatIntentService';
import { sendChatMessage } from '../src/services/chatService';
import { sendParsedComparedChatRequest } from '../src/services/chatComparisonService';
import { getLlmProviderConfigs } from '../src/server/llmConfig';
import { reviewedLaborRetrieval, reviewedLaborFallback } from '../src/services/reviewedLaborGuidance';
import { getCompanyById } from '../src/services/companyService';
import { getCompanyRisk } from '../src/services/riskService';
import { ownedTurns, packMemory, scoreMemoryAnswer, type EvalTurn, type MemoryMode, type SummarySnapshot } from './memory-comparison-core';
import { HISTORY, FIXED_PROBES, CONTINUOUS_PROBES } from './memory-comparison-fixtures';
import type { SessionUserDto } from '../src/app/api/auth/authApiContract';
import type { ChatRequest } from '../src/domain/chat';
import type { ChatComparisonResponse } from '../src/domain/chatComparison';

assert.equal(process.env.MW_MEMORY_EVAL_CREATED, 'personal02-new-pg16');
for (const name of ['AUTH_DATABASE_URL', 'CONVERSATION_DATABASE_URL']) {
  const url = new URL(process.env[name]!);
  assert(url.hostname === '127.0.0.1' && url.port === '55442' && url.pathname === '/mw_personal02', 'WRONG_DB_TARGET');
}
const runtime = process.env.MW_MEMORY_EVAL_RUNTIME!;
const bundle = process.env.MW_MEMORY_EVAL_BUNDLE ?? 'all';
const resume = process.env.MW_MEMORY_EVAL_RESUME;
const previousRows: Array<Record<string, unknown>> = resume
  ? readFileSync(resolve(resume, 'results.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.valid_measurement)
  : [];
const completed = new Set(previousRows.map(row => `${row.experiment}:${row.id}:${row.mode}`));
const callCap = Number(process.env.MW_MEMORY_EVAL_CALL_CAP ?? 90);
const emit = (data: unknown) => console.log(`MEMORY_EVAL ${JSON.stringify(data)}`);
const save = (name: string, data: unknown) => writeFileSync(resolve(runtime, name), JSON.stringify(data, null, 2));
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const repository = new RealConversationRepository();
const calls: Array<Record<string, unknown>> = [];
const rows: Array<Record<string, unknown>> = [];
const summaryBuilds: Array<Record<string, unknown>> = [];
const invariantByProbe = new Map<string, string>();
for (const row of previousRows) if (row.experiment === 'fixed') invariantByProbe.set(String(row.id), String(row.invariant_sha256));
let active = { id: 'preflight', mode: 'none', experiment: 'none' };
let stop: string | null = null;
let workerPhase = 'tokenizer';
let failures = 0;
const tokenizer = spawn(resolve('integrations/rag-api/.venv/Scripts/python.exe'), ['-u', 'scripts/memory-eval-token-counter.py', process.env.MW_MEMORY_EVAL_TOKENIZER!],
  { cwd: process.cwd(), env: { ...process.env, PYTHONIOENCODING: 'utf-8', TOKENIZERS_PARALLELISM: 'false' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
tokenizer.stderr.resume();
let nextTokenId = 0;
const tokenRequests = new Map<number, { resolve: (count: number) => void; reject: (error: Error) => void }>();
createInterface({ input: tokenizer.stdout }).on('line', line => {
  const value = JSON.parse(line); tokenRequests.get(value.id)?.resolve(value.tokens); tokenRequests.delete(value.id);
});
tokenizer.on('error', () => { for (const task of tokenRequests.values()) task.reject(new Error('TOKENIZER_FAILED')); });
tokenizer.on('exit', () => { for (const task of tokenRequests.values()) task.reject(new Error('TOKENIZER_EXIT')); });
const count = (text: string) => new Promise<number>((resolveCount, reject) => {
  const id = ++nextTokenId;
  tokenRequests.set(id, { resolve: resolveCount, reject });
  tokenizer.stdin.write(JSON.stringify({ id, text }) + '\n');
});
const originalFetch = globalThis.fetch;
const measuredFetch: typeof fetch = async (url, init) => {
  if (stop || calls.length >= callCap) throw new Error(stop ?? 'PROVIDER_CALL_CAP');
  const payload = JSON.parse(String(init?.body));
  const promptTokens = await count(JSON.stringify(payload.messages));
  if (promptTokens > 12288) {
    appendFileSync(resolve(runtime, 'budget-blocks.jsonl'), JSON.stringify({ ...active, prompt_eval_tokens: promptTokens }) + '\n');
    stop = 'PROMPT_EVAL_BUDGET_EXCEEDED'; throw new Error(stop);
  }
  const phase = payload.max_tokens === 120 ? 'rewrite' : payload.max_tokens === 100 ? 'classification' : 'generation';
  const record: Record<string, unknown> = { ...active, call: calls.length + 1, phase, prompt_sha256: sha(JSON.stringify(payload.messages)),
    prompt_eval_tokens: promptTokens, temperature: payload.temperature, max_tokens: payload.max_tokens, attempt: 1 };
  calls.push(record);
  const began = performance.now();
  try {
    const response = await originalFetch(url, init);
    const data = await response.clone().json().catch(() => ({}));
    Object.assign(record, { http_status: response.status, duration_ms: performance.now() - began,
      usage: data.usage ?? null, model: data.model ?? null, raw_answer: data.choices?.[0]?.message?.content ?? null,
      finish_reason: data.choices?.[0]?.finish_reason ?? null });
    failures = response.ok ? 0 : failures + 1;
    if ([401, 403, 429].includes(response.status) || failures >= 2) stop = `UPSTREAM_${response.status}`;
    return response;
  } catch {
    Object.assign(record, { http_status: null, network_error: true, duration_ms: performance.now() - began, usage: null });
    if (++failures >= 2) stop = 'CONSECUTIVE_NETWORK_FAILURES';
    throw new Error('UPSTREAM_NETWORK_ERROR');
  } finally {
    appendFileSync(resolve(runtime, 'provider-calls.jsonl'), JSON.stringify(record) + '\n');
  }
};
globalThis.fetch = measuredFetch;
const configs = getLlmProviderConfigs().filter(config => config.id === 'upstage');
assert(configs[0]?.apiKey, 'UPSTAGE_KEY_MISSING');
const client = new OpenAICompatibleChatClient(measuredFetch, 45000);
const rag = reviewedLaborRetrieval('재직 중 미지급 임금의 회사 지급 약속 문자 기록과 진정 접수 방법')!;
assert.equal(rag.status, 'matched');
save('frozen-evidence.json', rag);

type Room = { id: string; turns: EvalTurn[]; summaries: SummarySnapshot[]; label: string };
let user: SessionUserDto;
async function readOwned(room: Room) {
  await getUserConversation(room.id, user); // Existing production owner gate first.
  return ownedTurns(await repository.findConversation(room.id), room.id, user.user_id);
}
async function append(room: Room, turn: EvalTurn, summaryEnabled: boolean, result?: ChatComparisonResponse) {
  workerPhase = `store-${room.label}-${turn.index}`;
  const started = performance.now();
  const stored = await repository.recordCompletedTurn({ owner_user_id: user.user_id, conversation_id: room.id || undefined,
    idempotency_key: randomUUID(), company_id: turn.company_id, user_message: turn.user, assistant_message: turn.assistant,
    answer_type: result?.results[0].answer_type ?? 'general_guidance', guardrail_status: result?.results[0].guardrail_status ?? 'passed',
    sources: result?.results[0].sources ?? [] });
  room.id = stored.conversation_id;
  room.turns.push(turn);
  const storageMs = performance.now() - started;
  if (summaryEnabled && room.turns.length % 5 === 0) {
    workerPhase = `summary-${room.label}-${turn.index}`;
    const began = performance.now();
    const detail = await repository.findConversation(room.id);
    assert(detail && detail.owner_user_id === user.user_id);
    assert.equal(await maybeUpdateConversationSummary(detail), true);
    const state = await repository.findSummary(room.id);
    const context = toConversationMemoryContext(state)!;
    assert.equal(context.summarized_through_sequence, room.turns.length * 2);
    room.summaries.push({ through: context.summarized_through_sequence, content: context.content });
    summaryBuilds.push({ room: room.label, through: context.summarized_through_sequence, method: 'extractive-v2',
      provider_calls: 0, provider_tokens: 0, duration_ms: performance.now() - began, content_eval_tokens: await count(context.content) });
    save('summary-builds.json', summaryBuilds);
  }
  return storageMs;
}
async function seed(label: string, turns: number, withSummary: boolean): Promise<Room> {
  const room: Room = { id: '', turns: [], summaries: [], label };
  for (const turn of HISTORY.slice(0, turns)) await append(room, { ...turn }, withSummary);
  assert.deepEqual(await readOwned(room), room.turns);
  return room;
}
async function companyContext(companyId: string | null) {
  if (!companyId) return undefined;
  const company = await getCompanyById(companyId);
  return { company_id: companyId, company_name: company.company_name, address: company.address, region: company.region,
    industry: company.industry, size_label: company.size_label, risk: await getCompanyRisk(companyId) };
}
type Probe = { id: string; company_id: string | null; question: string; expected: Array<{ fact: string; pattern: string }> };
async function runProbe(mode: MemoryMode, room: Room, probe: Probe, experiment: string, prefix = room.turns.length) {
  workerPhase = `${experiment}-${probe.id}-${mode}`;
  active = { id: probe.id, mode, experiment };
  const began = performance.now();
  const callStart = calls.length;
  const loadStart = performance.now();
  const originalTurns = mode === 'A' ? room.turns.slice(0, prefix) : (await readOwned(room)).slice(0, prefix);
  const packed = await packMemory(mode, originalTurns, room.summaries, count);
  const hydrationMs = performance.now() - loadStart;
  // No oracle, mode letter, or desired answer is supplied to the model.
  const request: ChatRequest = { message: probe.question, company_id: probe.company_id ?? undefined,
    chat_mode: 'wage', compare: false, external_processing_consent: true, recent_messages: packed.recent,
    conversation_memory: { summary_version: 'local-eval-reference-v1', summarized_through_sequence: 0, content: packed.content } };
  const rewritten = await rewriteFollowupQuery(request, configs, client);
  const intent = await classifyChatIntent({ ...request, resolved_query: rewritten.query }, configs, client);
  const baselineRequest = { ...request, recent_messages: [], conversation_memory: undefined };
  const baseline = await sendChatMessage(baselineRequest);
  baseline.conversation_id = 'local-memory-eval';
  baseline.sources = rag.documents.map(document => document.source);
  baseline.guardrail_status = 'passed';
  const policy = reviewedLaborFallback(request.message, baseline) ?? baseline;
  const company = await companyContext(probe.company_id);
  const invariantHash = sha(JSON.stringify({ question: request.message, policy, company, rag }));
  if (experiment === 'fixed') {
    const previous = invariantByProbe.get(probe.id);
    if (previous && previous !== invariantHash) throw new Error('NON_MEMORY_CONTEXT_CHANGED');
    invariantByProbe.set(probe.id, invariantHash);
  }
  // Routing and retrieval are frozen for this controlled memory experiment.
  const result = await new DualLlmChatProvider(configs, client).compare({ request, policyBaseline: policy, companyContext: company,
    ragRetrieval: rag, questionIntent: 'labor' });
  const generated = calls.slice(callStart).find(call => call.phase === 'generation');
  const answer = result.results[0];
  const attemptCalls = calls.slice(callStart);
  const row = { ...active, input_turns: prefix, history_sha256: sha(JSON.stringify(originalTurns)), invariant_sha256: invariantHash,
    memory: packed, hydration_ms: hydrationMs, request_duration_ms: performance.now() - began,
    classification: intent, rewrite_changed: rewritten.changed, rewritten_query: rewritten.query,
    raw: scoreMemoryAnswer(String(generated?.raw_answer ?? ''), probe.expected), final: scoreMemoryAnswer(answer.answer, probe.expected),
    final_answer: answer.answer, guardrail_action: answer.trace.guardrail_action, guardrail_hits: answer.trace.guardrail_hits,
    provider_status: answer.status, provider_call_numbers: attemptCalls.map(call => call.call),
    actual_provider_calls: attemptCalls.length, storage: 'REAL_PG16_OWNER_CHECKED',
    valid_measurement: attemptCalls.length === 3 && attemptCalls.every(call => call.http_status === 200) && !stop,
    usefulness_and_source_review: 'PENDING', summary_reused: packed.summary_retained,
  };
  rows.push(row);
  appendFileSync(resolve(runtime, 'results.jsonl'), JSON.stringify(row) + '\n');
  emit({ id: probe.id, mode, experiment, calls: attemptCalls.length, raw: row.raw.automated_status,
    final: row.final.automated_status, guard: row.guardrail_action, memory_tokens: packed.tokens, valid: row.valid_measurement });
  if (!row.valid_measurement) throw new Error('INVALID_MEASUREMENT_STOP');
  return result;
}

try {
  assert((await count('정정한 급여일과 다음 주')) > 0);
  workerPhase = 'register-synthetic-users';
  const registration = await registerUser({ email: `personal02-${randomUUID()}@example.invalid`, password: randomBytes(12).toString('hex'), name: '합성 평가' });
  user = registration.response.user;
  const other = (await registerUser({ email: `personal02-${randomUUID()}@example.invalid`, password: randomBytes(12).toString('hex'), name: '별도 합성' })).response.user;
  const fixedRoom = await seed('fixed-shared', 26, true);
  workerPhase = 'cross-owner-check';
  await assert.rejects(getUserConversation(fixedRoom.id, other), (error: unknown) => (error as { code: string }).code === 'CONVERSATION_NOT_FOUND');
  save('owner-check.json', { correct_owner: 'PASS', other_owner: 'REJECTED', stored_turns: 26, stored_originals_equal_fixture: true,
    checkpoints: fixedRoom.summaries.map(item => item.through), no_public_experiment_parameter: true });
  emit({ phase: 'fresh-pg-seed-and-owner', status: 'PASS', turns: 26, checkpoints: fixedRoom.summaries.map(item => item.through) });
  if (bundle === 'all' || bundle === 'fixed') {
    const orders: MemoryMode[][] = [['A', 'B', 'C'], ['B', 'C', 'A'], ['C', 'A', 'B'], ['A', 'B', 'C']];
    for (const [index, probe] of FIXED_PROBES.entries()) for (const mode of orders[index]) {
      if (!completed.has(`fixed:${probe.id}:${mode}`)) await runProbe(mode, fixedRoom, probe, 'fixed', probe.turns);
    }
  }
  if (bundle === 'all' || bundle === 'continuous') {
    // A partially completed live trajectory must not silently restart from the seed.
    assert(!previousRows.some(row => row.experiment === 'continuous'), 'PARTIAL_CONTINUITY_REQUIRES_REPLAY');
    for (const mode of ['A', 'B', 'C'] as MemoryMode[]) {
      const room = await seed(`continuous-${mode}`, 22, mode === 'C');
      for (const probe of CONTINUOUS_PROBES) {
        const result = await runProbe(mode, room, probe, 'continuous');
        const storageMs = await append(room, { index: room.turns.length + 1, company_id: probe.company_id,
          user: probe.question, assistant: result.results[0].answer }, mode === 'C', result);
        appendFileSync(resolve(runtime, 'persistence.jsonl'), JSON.stringify({ mode, id: probe.id, storage_ms: storageMs,
          stored_turns: (await readOwned(room)).length, display_answer_roundtrip: (await readOwned(room)).at(-1)?.assistant === result.results[0].answer }) + '\n');
      }
    }
  }
  if (bundle === 'all' || bundle === 'diagnostic') {
    const diagnosticIds = new Set((process.env.MW_MEMORY_EVAL_DIAGNOSTIC_IDS ?? 'AQ12,AQ21,AQ32').split(','));
    const development = JSON.parse(readFileSync('eval/answer-contract-cases.json', 'utf8')).filter((item: { split: string; id: string }) =>
      item.split === 'development' && diagnosticIds.has(item.id.split('-')[0]));
    for (const item of development) {
      active = { id: item.id, mode: 'current-product', experiment: 'diagnostic' };
      const start = calls.length;
      const result = await sendParsedComparedChatRequest({ ...item.request, external_processing_consent: true, compare: false });
      appendFileSync(resolve(runtime, 'diagnostic.jsonl'), JSON.stringify({ id: item.id, result, calls: calls.slice(start).map(call => call.call) }) + '\n');
      emit({ id: item.id, mode: 'current-product', guardrail: result.results[0].trace.guardrail_action, calls: calls.length - start });
      if (stop || calls.slice(start).some(call => call.http_status !== 200)) throw new Error('DIAGNOSTIC_PROVIDER_FAILURE');
    }
  }
} catch (error) {
  stop ??= error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'LOCAL_EVAL_FAILED';
  emit({ blocked: stop, phase: workerPhase, error_type: error instanceof Error ? error.name : 'Unknown',
    error_code: typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : null }); process.exitCode = 2;
} finally {
  globalThis.fetch = originalFetch;
  tokenizer.stdin.end();
  tokenizer.kill();
  await closeWritePools();
  save('summary.json', { stopped: stop, rows: rows.length, valid_rows: rows.filter(row => row.valid_measurement).length,
    provider_calls: calls.length, returned_tokens: calls.reduce((sum, call) => sum + ((call.usage as { total_tokens?: number })?.total_tokens ?? 0), 0),
    missing_usage_calls: calls.filter(call => !(call.usage as { total_tokens?: number })?.total_tokens).length,
    summary_builds: summaryBuilds.length, summary_provider_calls: 0, evaluator_retries: 0,
    billing_currency: null, ttft: null, user_manual_acceptance: 'NOT_RUN' });
  emit({ finished: true, rows: rows.length, provider_calls: calls.length, stop });
}
