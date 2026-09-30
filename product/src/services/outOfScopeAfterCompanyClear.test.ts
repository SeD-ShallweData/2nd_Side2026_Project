/**
 * E-1 / 결정 42 「범위 밖 질문 분기」 회귀.
 *
 * 시나리오: 회사 선택 → 선택 해제 → 범위 밖 질문.
 * 실제 경로(정책 baseline PolicyChatProvider + Mock 회사·위험 자료, 재작성, 의도 분류기,
 * Answer Plan, 정책 단축 응답)를 그대로 타고, 외부 호출만 가짜 fetch로 대신한다.
 * 최종 생성기(DualLlmChatProvider)는 기존 테스트처럼 호출 여부와 입력만 기록한다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  compare: vi.fn(),
  retrieve: vi.fn(),
  intentAnswer: { value: "" },
  rewriteAnswer: { value: "" },
  intentInputs: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/adapters/real/DualLlmChatProvider", () => ({
  CHAT_POLICY_VERSION: "test",
  DualLlmChatProvider: class {
    compare(context: unknown) { return mocks.compare(context); }
  },
}));
vi.mock("@/services/ragService", () => ({ retrieveLaborLawContext: mocks.retrieve }));
vi.mock("@/server/llmConfig", () => ({
  getLlmProviderConfigs: () => [
    { id: "upstage", label: "Upstage", model: "solar-test", apiUrl: "https://unused.test", apiKey: "test" },
  ],
  getLlmTimeoutMs: () => 5_000,
}));

import { INTENT_SYSTEM_PROMPT } from "@/services/chatIntentService";
import { sendChatMessage } from "@/services/chatService";
import { sendParsedComparedChatRequest } from "@/services/chatComparisonService";
import type { ChatRequest, RecentMessage } from "@/domain/chat";

const COMPANY_ID = "COMPANY_DEMO_001";
const COMPANY_NAME = "OO건설";
const OUT_OF_SCOPE_QUESTION = "회사 컴퓨터에 게임 설치하는 방법 알려줘";
const CARD_QUESTION = "인천 OO건설 임금 카드의 추가 확인 신호는 무슨 뜻인가요?";
/** chatComparisonService.outOfScopeResponse 의 고정 범위 안내. */
const SCOPE_NOTICE = "이 상담은 노동·근로계약과 회사의 임금·안전 정보를 다룹니다. 해당 질문은 이 상담에서 답하기 어렵습니다.";
const SCOPE_LIMITATION = "질문 의도에 따른 범위 안내이며 회사에 대한 평가가 아닙니다.";
/** 선택했던 회사(Mock COMPANY_DEMO_001)의 요약·지표·신호 문구. 해제 뒤 답변에 섞이면 안 된다. */
const COMPANY_TRACES = [
  COMPANY_NAME, "인천", "일부 변동 신호", "최근 가입자 수 감소", "최근 이직 변동 관측",
  "임금 지급 카드", "임금 지급 관련 결과", "산업재해 카드", "산업재해 정보", "확인 신호",
];

const RECALL: NonNullable<ChatRequest["conversation_recall"]> = {
  facts: [],
  companies: [{ company_id: COMPANY_ID, company_name: COMPANY_NAME, region: "인천광역시", address: "인천광역시 서구 샘플로 10" }],
  company_history: [{ company_id: COMPANY_ID, company_name: COMPANY_NAME, turn_index: 1 }],
  diagnostics: {
    summary_status: "ready", summary_version: "extractive-v4", summarized_through_sequence: 0,
    stored_message_count: 2, hydrated_recent_count: 2, summary_included: false,
    recall_fact_count: 0, legacy_recall_rebuilt: false,
  },
};

function completion(content: string): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content }, finish_reason: "stop" }], model: "solar-test",
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

/** 분류기와 재작성기만 응답하는 가짜 공급자. 그 밖의 네트워크 호출은 실패시킨다. */
const fakeFetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ role: string; content: string }> };
  const system = body.messages?.[0]?.content ?? "";
  if (system === INTENT_SYSTEM_PROMPT) {
    mocks.intentInputs.push(JSON.parse(body.messages?.[1]?.content ?? "{}"));
    return completion(mocks.intentAnswer.value);
  }
  return completion(mocks.rewriteAnswer.value);
});

function intent(value: { intent: string; topic?: string; company_scope?: string }) {
  mocks.intentAnswer.value = JSON.stringify({
    intent: value.intent, topic: value.topic ?? "other", company_scope: value.company_scope ?? "not_applicable",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.intentInputs.length = 0;
  vi.stubEnv("APP_DATA_MODE", "mock");
  vi.stubEnv("COMPANY_DATA_MODE", "mock");
  vi.stubEnv("MOCK_DELAY_MS", "0");
  vi.stubGlobal("fetch", fakeFetch);
  mocks.compare.mockResolvedValue({ execution_mode: "single_api", results: [] });
  mocks.retrieve.mockRejectedValue(new Error("범위 밖 경로에서는 노동법 검색을 호출하지 않아야 합니다."));
  mocks.rewriteAnswer.value = "";
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function expectScopeNoticeWithoutCompany(response: Awaited<ReturnType<typeof sendParsedComparedChatRequest>>) {
  expect(mocks.compare).not.toHaveBeenCalled();
  expect(mocks.retrieve).not.toHaveBeenCalled();
  expect(response.execution_mode).toBe("policy_short_circuit");
  expect(response.results).toHaveLength(1);
  const [result] = response.results;
  expect(result.answer).toContain(SCOPE_NOTICE);
  expect(result.limitations).toContain(SCOPE_LIMITATION);
  expect(result.answer_type).toBe("clarification");
  expect(result.sources).toEqual([]);
  expect(result.trace.guardrail_hits).toEqual(["INTENT_OUT_OF_SCOPE"]);
  expect(result.trace.question_intent).toBe("off_topic");
  expect(result.trace.company_context_attached).toBe(false);
  const visible = JSON.stringify({
    answer: result.answer, sources: result.sources,
    suggested_actions: result.suggested_actions, limitations: result.limitations,
  });
  for (const trace of COMPANY_TRACES) expect(visible, `회사 흔적: ${trace}`).not.toContain(trace);
  return result;
}

describe("E-1 회사 선택 → 선택 해제 → 범위 밖 질문", () => {
  it("대조: 회사를 선택한 상태에서는 선택 회사의 카드·지표 맥락이 실제로 붙는다", async () => {
    intent({ intent: "company", company_scope: "specific" });
    await sendParsedComparedChatRequest({
      message: CARD_QUESTION, company_id: COMPANY_ID, chat_mode: "wage", recent_messages: [], conversation_recall: RECALL,
    });
    expect(mocks.compare).toHaveBeenCalledOnce();
    const context = mocks.compare.mock.calls[0][0];
    expect(context.questionIntent).toBe("company");
    expect(context.companyContext.company_id).toBe(COMPANY_ID);
    expect(context.policyBaseline.answer).toContain(COMPANY_NAME);
    expect(context.policyBaseline.answer).toContain("최근 가입자 수 감소");
    expect(mocks.intentInputs[0].company_selected).toBe(true);
  });

  it("대조: 같은 범위 밖 질문도 회사가 선택돼 있으면 정책 baseline에는 회사 요약이 들어 있다", async () => {
    const baseline = await sendChatMessage({
      message: OUT_OF_SCOPE_QUESTION, company_id: COMPANY_ID, chat_mode: "general", recent_messages: [],
    });
    expect(baseline.answer_type).toBe("company_context");
    expect(baseline.answer).toContain(`${COMPANY_NAME}의 임금 지급 관련 결과`);
  });

  it("선택을 해제한 뒤 범위 밖 질문에는 이전 회사 요약·지표 없이 범위 안내만 준다", async () => {
    // 1턴: 회사 선택 상태의 카드 질문
    intent({ intent: "company", company_scope: "specific" });
    await sendParsedComparedChatRequest({
      message: CARD_QUESTION, company_id: COMPANY_ID, chat_mode: "wage", recent_messages: [], conversation_recall: RECALL,
    });
    const firstContext = mocks.compare.mock.calls[0][0];
    expect(firstContext.companyContext.company_id).toBe(COMPANY_ID);
    const history: RecentMessage[] = [
      { role: "user", content: CARD_QUESTION },
      { role: "assistant", content: firstContext.policyBaseline.answer },
    ];
    mocks.compare.mockClear();
    mocks.intentInputs.length = 0;

    // 2턴: 선택 해제(company_id 없음). 소유 대화 이력·회사 이력은 남아 있다.
    // 재작성기가 이전 회사명을 끌어오는 최악의 경우도 함께 본다.
    mocks.rewriteAnswer.value = `${COMPANY_NAME} ${OUT_OF_SCOPE_QUESTION}`;
    intent({ intent: "off_topic" });
    const response = await sendParsedComparedChatRequest({
      message: OUT_OF_SCOPE_QUESTION, company_id: undefined, chat_mode: "general",
      recent_messages: history, conversation_recall: RECALL,
    });

    const result = expectScopeNoticeWithoutCompany(response);
    expect(result.trace.context_mode).toBe("general");
    expect(mocks.intentInputs).toHaveLength(1);
    expect(mocks.intentInputs[0].company_selected).toBe(false);
    expect(mocks.intentInputs[0].resolved_query).toBe(`${COMPANY_NAME} ${OUT_OF_SCOPE_QUESTION}`);
  });

  it("회사가 계속 선택돼 있어도 범위 밖 질문은 회사 요약 대신 범위 안내로 끝난다", async () => {
    intent({ intent: "off_topic" });
    const response = await sendParsedComparedChatRequest({
      message: OUT_OF_SCOPE_QUESTION, company_id: COMPANY_ID, chat_mode: "general",
      recent_messages: [], conversation_recall: RECALL,
    });
    const result = expectScopeNoticeWithoutCompany(response);
    expect(result.trace.context_mode).toBe("company");
  });
});
