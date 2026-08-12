import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { ChatResponse } from "@/domain/chat";
import { ResponsesClientError } from "@/server/responses/responsesClient";
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

describe("Responses chat service adapter", () => {
  it("도구 실행 결과를 기존 ChatComparisonResponse의 단일 결과로 매핑한다", async () => {
    const { send, run } = setup();

    const result = await send(REQUEST);

    expect(result.execution_mode).toBe("openai_responses");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      provider: "openai",
      provider_label: "OpenAI Responses",
      model: "gpt-test-2026",
      status: "success",
      answer: RUN.answer,
      sources: [{ name: "국가법령정보센터", document_id: "law-43" }],
      metrics: { latency_ms: 321, usage: RUN.usage },
      trace: {
        tool_round_count: 1,
        tool_call_count: 1,
        tool_names: ["retrieve_labor_law"],
        response_id: "resp_1",
      },
    });
    const runRequest = run.mock.calls[0][0];
    expect(runRequest.instructions).toContain("retrieve_labor_law");
    expect(runRequest.instructions).toContain("정책 버전");
    expect(runRequest.input).toEqual([
      { role: "assistant", content: "앞선 안내" },
      { role: "user", content: REQUEST.message },
    ]);
  });

  it("검색으로 확인하지 않은 법령 인용은 정책 baseline으로 교체한다", async () => {
    const unverifiedRun: ResponsesRunResult = {
      ...RUN,
      answer: "근로기준법 제99조에 따라 반드시 승소합니다.",
      toolRounds: 0,
      toolCalls: [],
      ledger: {
        ragStatus: "unavailable",
        citations: [],
        sources: [],
        retrievedDocumentCount: 0,
      },
    };
    const { send } = setup(BASELINE, unverifiedRun);

    const result = await send(REQUEST);

    expect(result.results[0]).toMatchObject({
      status: "guardrail_replaced",
      answer: BASELINE.answer,
      sources: BASELINE.sources,
      guardrail_status: "limited",
      trace: {
        guardrail_action: "replaced",
        guardrail_hits: expect.arrayContaining([
          "LEGAL_CERTAINTY",
          "UNVERIFIED_LAW_CITATION",
        ]),
      },
    });
  });

  it("Responses 설정·API 실패 시 dual API를 부르지 않고 정책 답변으로 fallback한다", async () => {
    const error = new ResponsesClientError(
      "OPENAI_API_KEY_MISSING",
      "OpenAI API 키가 설정되지 않았습니다.",
      false,
      0,
    );
    const { send } = setup(BASELINE, error);

    const result = await send(REQUEST);

    expect(result.results[0]).toMatchObject({
      provider: "openai",
      model: "gpt-test",
      status: "fallback",
      answer: BASELINE.answer,
      error: {
        code: "OPENAI_API_KEY_MISSING",
        retryable: false,
      },
    });
  });

  it("도구 실패 뒤 모델이 성공을 주장해도 정책 답변으로 강제 대체한다", async () => {
    const failedToolRun: ResponsesRunResult = {
      ...RUN,
      answer: "사업장 위험 정보를 확인했습니다.",
      toolCalls: [
        {
          call_id: "call_bad",
          name: "get_company_risk",
          ok: false,
          error_code: "COMPANY_CONTEXT_MISMATCH",
          latency_ms: 1,
          cached: false,
        },
      ],
      ledger: {
        ragStatus: "unavailable",
        citations: [],
        sources: [],
        retrievedDocumentCount: 0,
      },
    };
    const { send } = setup(BASELINE, failedToolRun);

    const result = await send(REQUEST);

    expect(result.results[0]).toMatchObject({
      status: "fallback",
      answer: BASELINE.answer,
      sources: BASELINE.sources,
      guardrail_status: "limited",
      trace: { guardrail_action: "fallback" },
      error: {
        code: "COMPANY_CONTEXT_MISMATCH",
        retryable: false,
      },
    });
  });

  it("계약서 도구 성공 시 사업장 검색 대신 계약 전용 메타데이터를 사용한다", async () => {
    const contractBaseline: ChatResponse = {
      ...BASELINE,
      answer: "질문을 더 구체적으로 알려주세요.",
      answer_type: "clarification",
      suggested_actions: [
        { code: "SEARCH_COMPANY", label: "사업장 검색", priority: "now" },
        { code: "CALL_1350", label: "고용노동부 1350", priority: "next" },
      ],
      limitations: ["현재 답변은 안전정책에 따른 기본 안내입니다."],
    };
    const contractRun: ResponsesRunResult = {
      ...RUN,
      answer: "업로드된 계약서에서 근로기준법 제17조 관련 확인 항목을 정리했습니다.",
      toolCalls: [
        {
          call_id: "call_contract",
          name: "review_contract",
          ok: true,
          error_code: null,
          latency_ms: 25,
          cached: false,
        },
      ],
      ledger: {
        ragStatus: "unavailable",
        citations: ["근로기준법 제17조"],
        sources: [],
        retrievedDocumentCount: 0,
      },
    };
    const { send } = setup(contractBaseline, contractRun);
    const file = new File(["contract"], "contract.pdf", { type: "application/pdf" });

    const result = await send(
      {
        message: "현재 업로드한 계약서를 검토해 주세요.",
        chat_mode: "contract",
        recent_messages: [],
      },
      {
        toolContext: {
          contractRequest: {
            file,
            file_metadata: {
              file_name: file.name,
              content_type: file.type,
              size_bytes: file.size,
            },
          },
        },
      },
    );

    expect(result.results[0]).toMatchObject({
      status: "success",
      answer: contractRun.answer,
      answer_type: "general_guidance",
      suggested_actions: [
        { code: "VERIFY_CONTRACT_ITEMS" },
        { code: "KEEP_CONTRACT_COPY" },
      ],
    });
    expect(result.results[0].suggested_actions.map((action) => action.code)).not.toEqual(
      expect.arrayContaining(["SEARCH_COMPANY", "CALL_1350"]),
    );
    expect(result.results[0].limitations.join(" ")).toContain("계약");
    expect(result.results[0].limitations).not.toContain(
      "현재 답변은 안전정책에 따른 기본 안내입니다.",
    );
  });

  it("업로드가 있는데 runner가 계약 도구 호출 없이 답하면 정책 fallback한다", async () => {
    const noToolRun: ResponsesRunResult = {
      ...RUN,
      answer: "도구 없이 계약서를 검토했다고 주장합니다.",
      toolRounds: 0,
      toolCalls: [],
      ledger: {
        ragStatus: "unavailable",
        citations: [],
        sources: [],
        retrievedDocumentCount: 0,
      },
    };
    const { send } = setup(BASELINE, noToolRun);
    const file = new File(["contract"], "contract.pdf", { type: "application/pdf" });

    const result = await send(
      {
        message: "현재 업로드한 계약서를 검토해 주세요.",
        chat_mode: "contract",
        recent_messages: [],
      },
      {
        toolContext: {
          contractRequest: {
            file,
            file_metadata: {
              file_name: file.name,
              content_type: file.type,
              size_bytes: file.size,
            },
          },
        },
      },
    );

    expect(result.results[0]).toMatchObject({
      status: "fallback",
      answer: BASELINE.answer,
      error: {
        code: "OPENAI_RESPONSES_CONTRACT_TOOL_REQUIRED",
        retryable: true,
      },
    });
  });

  it("긴급 질문은 설정과 OpenAI runner를 건드리지 않고 즉시 정책 응답한다", async () => {
    const emergency: ChatResponse = {
      ...BASELINE,
      answer: "즉시 안전한 곳으로 이동하고 119에 신고하세요.",
      answer_type: "emergency_guidance",
      guardrail_status: "escalated",
    };
    const { send, dependencies, createRunner } = setup(emergency);

    const result = await send({
      message: "작업장에서 사고가 났어요",
      chat_mode: "safety",
      recent_messages: [],
    });

    expect(result.execution_mode).toBe("policy_short_circuit");
    expect(result.results[0]).toMatchObject({
      status: "policy_short_circuit",
      model: "policy-only",
      answer: emergency.answer,
    });
    expect(dependencies.getConfig).not.toHaveBeenCalled();
    expect(createRunner).not.toHaveBeenCalled();
  });
});
