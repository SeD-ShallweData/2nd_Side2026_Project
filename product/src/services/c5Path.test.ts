import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { ChatResponse } from "@/domain/chat";
import type { OpenAIResponsesConfig } from "@/server/responses/responsesConfig";
import type { ResponsesRunResult } from "@/server/responses/responsesRunner";
import {
  createResponsesChatSender,
  type ResponsesChatDependencies,
} from "@/services/responsesChatService";

const BASELINE: ChatResponse = {
  answer: "자료를 확인하고 공식 창구에 문의하세요.",
  answer_type: "general_guidance",
  sources: [{ name: "고용노동부 안내", document_id: "MOEL_GUIDE" }],
  suggested_actions: [
    { code: "CALL_1350", label: "고용노동부 1350", priority: "next" },
  ],
  limitations: ["개별 법률 판단을 대신하지 않습니다."],
  guardrail_status: "passed",
  conversation_id: "conv_1",
};

const CONFIG: OpenAIResponsesConfig = {
  apiKey: "test-key",
  apiUrl: "https://openai.test/v1/responses",
  model: "gpt-test",
  timeoutMs: 5_000,
  runTimeoutMs: 60_000,
  maxOutputTokens: 900,
  maxToolRounds: 4,
  maxToolCalls: 8,
  store: false,
};

const RUN: ResponsesRunResult = {
  answer: "확인된 범위에서 임금 자료를 먼저 정리하세요.",
  model: "gpt-test-2026",
  status: "completed",
  finishReason: null,
  usage: {
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    cached_tokens: 10,
    reasoning_tokens: 5,
  },
  latencyMs: 321,
  upstreamRequestId: "req_1",
  responseId: "resp_1",
  toolRounds: 1,
  toolCalls: [
    {
      call_id: "call_1",
      name: "retrieve_labor_law",
      ok: true,
      error_code: null,
      latency_ms: 12,
      cached: false,
    },
  ],
  ledger: {
    ragStatus: "matched",
    citations: ["근로기준법 제43조"],
    sources: [{ name: "국가법령정보센터", document_id: "law-43" }],
    retrievedDocumentCount: 1,
  },
};

function setup(
  baseline: ChatResponse = BASELINE,
  runValue: ResponsesRunResult | Error = RUN,
) {
  const run = vi.fn();
  if (runValue instanceof Error) run.mockRejectedValue(runValue);
  else run.mockResolvedValue(runValue);
  const createRunner = vi.fn(() => ({ run }));
  const dependencies: ResponsesChatDependencies = {
    sendPolicyMessage: vi.fn().mockResolvedValue(baseline),
    getConfig: vi.fn(() => CONFIG),
    createRunner,
    loadSystemPrompt: vi.fn(() => "돈워리 안전 시스템 프롬프트"),
  };
  return {
    send: createResponsesChatSender(dependencies),
    dependencies,
    createRunner,
    run,
  };
}

const REQUEST = {
  message: "임금 지급일을 어떻게 확인하나요?",
  chat_mode: "wage",
  recent_messages: [{ role: "assistant", content: "앞선 안내" }],
};

describe('C5 contract success with retrieval failure', () => {
  it.each([
    ['no_match', true, 'no_match', 'success'],
    ['unavailable_data', true, 'unavailable', 'success'],
    ['tool_error', false, 'unavailable', 'success'],
  ] as const)('%s preserves verified contract answer', async (_name, ok, ragStatus, expected) => {
    const answer = '계약서의 서면 명시 항목을 확인하세요 (근로기준법 제17조).';
    const contractRun: ResponsesRunResult = {
      ...RUN, answer,
      toolCalls: [
        { call_id: 'contract', name: 'review_contract', ok: true, error_code: null, latency_ms: 1, cached: false },
        { call_id: 'rag', name: 'retrieve_labor_law', ok, error_code: ok ? null : 'TOOL_EXECUTION_FAILED', latency_ms: 1, cached: false },
      ],
      ledger: { ragStatus, citations: ['근로기준법 제17조'], sources: [], retrievedDocumentCount: 0 },
    };
    const { send } = setup(BASELINE, contractRun);
    const file = new File(['synthetic'], 'synthetic.pdf', { type: 'application/pdf' });
    const result = await send({ ...REQUEST, chat_mode: 'contract' }, {
      toolContext: { contractRequest: { file, file_metadata: { file_name: file.name, content_type: file.type, size_bytes: file.size } } },
    });
    expect(result.results[0].status).toBe(expected);
    expect(result.results[0].answer).toBe(answer);
    expect(result.results[0].suggested_actions.map(a => a.code)).toContain('VERIFY_CONTRACT_ITEMS');
    expect(result.results[0].error).toBeUndefined();
    if (!ok) expect(result.results[0].limitations.join(' ')).toContain('검색 도구 일부가 실패');
  });

  it('still rejects fabricated citations when contract evidence exists', async () => {
    const { send } = setup(BASELINE, {
      ...RUN, answer: '근로기준법 제999조에 따라 지급하세요.',
      toolCalls: [
        { call_id: 'contract', name: 'review_contract', ok: true, error_code: null, latency_ms: 1, cached: false },
        { call_id: 'rag', name: 'retrieve_labor_law', ok: false, error_code: 'TOOL_EXECUTION_FAILED', latency_ms: 1, cached: false },
      ],
      ledger: { ragStatus: 'no_match', citations: ['근로기준법 제17조'], sources: [], retrievedDocumentCount: 0 },
    });
    const result = await send(REQUEST);
    expect(result.results[0].status).toBe('guardrail_replaced');
    expect(result.results[0].trace.guardrail_hits).toContain('UNVERIFIED_LAW_CITATION');
  });

  it.each(['review_contract', 'get_company_risk', 'search_company'] as const)(
    'keeps fallback for %s failure even after a contract success', async (name) => {
      const { send } = setup(BASELINE, {
        ...RUN,
        toolCalls: [
          { call_id: 'contract', name: 'review_contract', ok: true, error_code: null, latency_ms: 1, cached: false },
          { call_id: 'rag', name: 'retrieve_labor_law', ok: false, error_code: 'TOOL_EXECUTION_FAILED', latency_ms: 1, cached: false },
          { call_id: 'critical', name, ok: false, error_code: 'CRITICAL_FAILED', latency_ms: 1, cached: false },
        ],
      });
      const result = await send(REQUEST);
      expect(result.results[0].status).toBe('fallback');
      expect(result.results[0].answer).toBe(BASELINE.answer);
      expect(result.results[0].error?.code).toBe('CRITICAL_FAILED');
    },
  );

  it('keeps fallback for retrieval error without successful contract review', async () => {
    const { send } = setup(BASELINE, {
      ...RUN,
      toolCalls: [{ call_id: 'rag', name: 'retrieve_labor_law', ok: false, error_code: 'TOOL_EXECUTION_FAILED', latency_ms: 1, cached: false }],
    });
    const result = await send(REQUEST);
    expect(result.results[0].status).toBe('fallback');
    expect(result.results[0].answer).toBe(BASELINE.answer);
  });
});
