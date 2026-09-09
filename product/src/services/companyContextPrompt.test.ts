/**
 * 사업장 컨텍스트가 상담 프롬프트에 실제로 실리는지 검사한다.
 *
 * 사용자 신고 — "사업장 화면에서 'AI에게 물어보기'로 넘어가면 챗봇이 그 회사를
 * 기억하지 못한다". 화면과 API 사이의 연결은 코드로 이어져 있었으므로, 실제로
 * 확인할 것은 **모델에게 나가는 시스템 프롬프트에 사업장이 들어 있는가** 였다.
 *
 * LLM 을 부르지 않는다. fetch 를 가로채 나가는 요청 본문을 그대로 본다.
 *
 * 함께 지키는 것이 하나 더 있다. 모델에게 주는 사업장 판정은 화면용 응답과 다른
 * **정리된 사본**이다(`publicSignalForPrompt`). 등급 토큰·근거 코드·내부 배치
 * 이름·생성 시각이 빠지고 순위 표기가 "상위 구간"으로 바뀐다. 프롬프트에
 * "등급·순위를 말하지 마세요"라고 적어도 컨텍스트에 값이 있으면 모델이 옮기기
 * 때문에, 주입 단계에서 지운다. 그 사본이 무너지면 여기서 걸린다.
 */

import { describe, expect, it, vi } from "vitest";

// 시스템 프롬프트를 파일에서 읽게 되면서 server-only 모듈을 거친다.
vi.mock("server-only", () => ({}));

import { DualLlmChatProvider } from "@/adapters/real/DualLlmChatProvider";
import { OpenAICompatibleChatClient } from "@/adapters/real/OpenAICompatibleChatClient";
import type { ChatResponse } from "@/domain/chat";
import type { ComparisonContext } from "@/domain/chatComparison";
import type { CompanyRiskResult } from "@/domain/risk";
import type { LlmProviderConfig } from "@/server/llmConfig";

const CONFIGS: LlmProviderConfig[] = [
  { id: "upstage", label: "Upstage Solar", apiKey: "test-upstage", apiUrl: "https://upstage.test/chat", model: "solar-test" },
  { id: "skt", label: "SKT A.X", apiKey: "test-skt", apiUrl: "https://skt.test/chat", model: "ax-test" },
];

const BASELINE: ChatResponse = {
  answer: "확인된 근거가 없어 공식 창구를 안내합니다.",
  answer_type: "general_guidance",
  sources: [],
  suggested_actions: [],
  limitations: ["이 결과만으로 향후 상황을 확정할 수 없습니다."],
  guardrail_status: "limited",
  conversation_id: "conv_company",
};

/**
 * 내부 값이 섞인 판정 결과. 실제 MlRiskProvider 가 만드는 모양이며,
 * 여기 있는 값들이 프롬프트로 새면 안 된다.
 */
const RISK: CompanyRiskResult = {
  company_id: "firm_0001",
  company_name: "샘플H물류 주식회사",
  data_as_of: "2026-08-31",
  target_month: "2026-08",
  generated_at: "2026-09-01T02:11:00Z",
  valid_until: "2026-10-01",
  freshness: "current",
  wage_risk: {
    availability: "ready",
    level: "normal",
    summary: "현재 공개 가능한 안정 신호가 확인됐습니다. 다만 안전 인증이나 입사 권고를 뜻하지 않습니다.",
    evidence_codes: ["SAFE_RECOMMENDATION_STABLE"],
    evidence_items: [
      {
        code: "SAFE_RECOMMENDATION_STABLE",
        label: "안정 신호 판정",
        description: "공개 판정에서 안정 신호 3개가 확인됐습니다.",
      },
    ],
    confidence: "sufficient",
    official_listing: { status: "not_listed", as_of: null, source_name: "임금체불 공개 명단" },
  },
  safety_context: {
    availability: "ready",
    scope: "region_industry",
    level: "watch",
    summary: "우선 확인 범위가 '상위1%'으로 표시됐습니다.",
    region: "인천광역시",
    industry: "육상 화물 운송업",
    evidence_codes: ["PUBLISHED_SAFETY_PRIORITY_BAND"],
    evidence_items: [
      {
        code: "PUBLISHED_SAFETY_PRIORITY_BAND",
        label: "공표 확인 우선순위 '상위1%' 구간",
        description: "최신 배치에서 산출된 지역·업종 단위 신호입니다.",
      },
    ],
    confidence: "sufficient",
    disclaimer: "지역·업종 단위 맥락이며 개별 사업장의 사고 위험이 아닙니다.",
  },
  sources: [{ name: "임금체불 공개 명단", category: "wage", organization: "고용노동부" }],
};

function contextWithCompany(): ComparisonContext {
  return {
    request: {
      message: "이 회사 어떤가요?",
      chat_mode: "general",
      company_id: "firm_0001",
      recent_messages: [],
    },
    policyBaseline: BASELINE,
    companyContext: {
      company_id: "firm_0001",
      company_name: "샘플H물류 주식회사",
      address: "인천광역시 서구 예시로 100",
      region: "인천광역시",
      industry: "육상 화물 운송업",
      size_label: "중소기업",
      risk: RISK,
    },
    ragRetrieval: {
      query: "이 회사 어떤가요?",
      status: "no_match",
      threshold: 0.42,
      documents: [],
    },
  };
}

function okResponse() {
  return new Response(
    JSON.stringify({
      id: "req_test",
      model: "test-model",
      choices: [{ message: { content: "확인할 항목을 안내합니다." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/** 두 모델에 나간 시스템 프롬프트를 돌려준다. */
async function systemPrompts(context: ComparisonContext): Promise<string[]> {
  const captured: string[] = [];
  const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
    captured.push(body.messages[0].content);
    return okResponse();
  }) as typeof fetch;

  await new DualLlmChatProvider(CONFIGS, new OpenAICompatibleChatClient(fakeFetch, 5_000)).compare(context);
  return captured;
}

describe("사업장 컨텍스트 주입", () => {
  it("사업장을 선택한 상담은 회사 정보가 시스템 프롬프트에 들어간다", async () => {
    const [prompt] = await systemPrompts(contextWithCompany());

    expect(prompt).toContain("샘플H물류 주식회사");
    expect(prompt).toContain("firm_0001");
    expect(prompt).toContain("인천광역시");
    expect(prompt).toContain("육상 화물 운송업");
    // 사람이 읽을 요약문과 면책 문구는 남는다. 모델이 실제로 써야 할 재료다.
    expect(prompt).toContain("안전 인증이나 입사 권고를 뜻하지 않습니다");
    expect(prompt).toContain("개별 사업장의 사고 위험이 아닙니다");
    // 명단 등재 여부는 자료 그대로 전달된다.
    expect(prompt).toContain("not_listed");
  });

  it("사업장 절이 프롬프트에 있고 적용 조건이 붙어 있다", async () => {
    const [prompt] = await systemPrompts(contextWithCompany());

    expect(prompt).toContain("[사업장 컨텍스트");
    expect(prompt).toContain("company가 null이면 이 절 전체를 무시하세요");
    expect(prompt).toContain("사업장 자료에서 관측된 사실만 전하고 판정하지 마세요");
  });

  it("내부 값은 모델에게 넘어가지 않는다", async () => {
    const [prompt] = await systemPrompts(contextWithCompany());

    // 등급 토큰·근거 코드·내부 배치 이름·생성 시각은 주입 사본에서 걷어낸다.
    for (const forbidden of [
      "PUBLISHED_SAFETY_PRIORITY_BAND",
      "SAFE_RECOMMENDATION_STABLE",
      "상위1%",
      "generated_at",
      "2026-09-01T02:11:00Z",
      "evidence_codes",
    ]) {
      expect(prompt, `내부 값 ${forbidden} 이 프롬프트로 샜다`).not.toContain(forbidden);
    }
    // 순위 표기는 "상위 구간"으로 바뀐다.
    expect(prompt).toContain("상위 구간");
  });

  it("사업장을 선택하지 않은 상담에는 company가 null로 들어간다", async () => {
    const context = contextWithCompany();
    delete (context as { companyContext?: unknown }).companyContext;
    delete (context.request as { company_id?: string }).company_id;

    const [prompt] = await systemPrompts(context);

    expect(prompt).toContain('"company":null');
    expect(prompt).not.toContain("샘플H물류");
  });

  it("두 모델에 같은 사업장 컨텍스트가 나간다", async () => {
    const prompts = await systemPrompts(contextWithCompany());

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toBe(prompts[1]);
  });
});
