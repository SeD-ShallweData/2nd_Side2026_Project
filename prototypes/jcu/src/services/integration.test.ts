import { beforeAll, describe, expect, it } from "vitest";
import { parseChatRequest, sendChatMessage } from "@/services/chatService";
import { searchCompanies } from "@/services/companyService";
import { reviewContract, validateContractRequest } from "@/services/contractService";
import { getCompanyRisk } from "@/services/riskService";

beforeAll(() => {
  process.env.APP_DATA_MODE = "mock";
  process.env.MOCK_DELAY_MS = "0";
});

describe("사업장 검색", () => {
  it("한 글자 검색을 허용한다", async () => {
    const result = await searchCompanies("O");
    expect(result.items.length).toBeGreaterThan(0);
  });

  it("공백을 정규화하고 동명이인 결과를 모두 반환한다", async () => {
    const result = await searchCompanies("OO 건설");
    expect(result.total).toBe(2);
    expect(new Set(result.items.map((item) => item.company_id)).size).toBe(2);
  });

  it("영문 대소문자와 별칭을 구분하지 않는다", async () => {
    const result = await searchCompanies("hanbit tech");
    expect(result.items[0]?.company_id).toBe("COMPANY_DEMO_008");
    expect(result.items[0]?.match_type).toBe("alias");
  });

  it("결과 없음은 빈 목록이다", async () => {
    const result = await searchCompanies("존재하지않는회사");
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("error 쿼리로 Mock API 오류를 재현한다", async () => {
    await expect(searchCompanies("error")).rejects.toMatchObject({
      code: "COMPANY_SOURCE_UNAVAILABLE",
      status: 503,
    });
  });
});

describe("사업장 신호", () => {
  it("임금과 산업재해 결과를 분리한다", async () => {
    const result = await getCompanyRisk("COMPANY_DEMO_001");
    expect(result.wage_risk.level).toBe("watch");
    expect(result.safety_context.level).toBe("review");
    expect(result.safety_context.scope).toBe("region_industry");
  });

  it("unknown을 normal로 바꾸지 않는다", async () => {
    const result = await getCompanyRisk("UNKNOWN_SAFETY_001");
    expect(result.wage_risk.level).toBe("review");
    expect(result.safety_context.level).toBe("unknown");
    expect(result.safety_context.summary).toContain("자료가 부족");
  });

  it("만료 데이터를 명시한다", async () => {
    const result = await getCompanyRisk("EXPIRED_001");
    expect(result.freshness).toBe("expired");
    expect(result.valid_until).toBe("2026-06-30");
  });

  it("사용자 응답에 원시 모델 필드가 없다", async () => {
    const serialized = JSON.stringify(await getCompanyRisk("COMPANY_DEMO_001"));
    expect(serialized).not.toContain("raw_probability");
    expect(serialized).not.toContain("percentile");
    expect(serialized).not.toContain("shap_value");
    expect(serialized).not.toContain("risk_ratio");
  });
});

describe("Mock 챗봇", () => {
  it("회사 선택 전 회사 질문에는 선택을 요청한다", async () => {
    const request = parseChatRequest({
      message: "이 회사는 안전한가요?",
      chat_mode: "general",
      recent_messages: [],
    });
    const response = await sendChatMessage(request);
    expect(response.answer_type).toBe("clarification");
    expect(response.answer).toContain("사업장 검색");
  });

  it("안전 여부와 입사 결정을 단정하지 않는다", async () => {
    const request = parseChatRequest({
      message: "이 회사는 안전한가요? 입사해도 돼요?",
      company_id: "COMPANY_DEMO_002",
      chat_mode: "general",
      recent_messages: [],
    });
    const response = await sendChatMessage(request);
    expect(response.answer_type).toBe("company_context");
    expect(response.guardrail_status).toBe("limited");
    expect(response.answer).toContain("확정할 수는 없습니다");
    expect(response.answer).not.toContain("안전한 회사입니다");
    expect(response.answer).not.toContain("입사해도 됩니다");
  });

  it("선택한 회사의 unknown 결과만 설명한다", async () => {
    const request = parseChatRequest({
      message: "왜 추가 확인이 필요한가요?",
      company_id: "UNKNOWN_001",
      chat_mode: "general",
      recent_messages: [],
    });
    const response = await sendChatMessage(request);
    expect(response.answer_type).toBe("company_context");
    expect(response.guardrail_status).toBe("limited");
    expect(response.answer).toContain("미래산업");
    expect(response.answer).toContain("세부 확인 신호가 제공되지 않았습니다");
  });

  it("즉각적인 사고 질문은 긴급 안내를 우선한다", async () => {
    const request = parseChatRequest({
      message: "현장에서 사고 났고 사람이 다쳤어요",
      chat_mode: "safety",
      recent_messages: [],
    });
    const response = await sendChatMessage(request);
    expect(response.answer_type).toBe("emergency_guidance");
    expect(response.guardrail_status).toBe("escalated");
    expect(response.answer).toContain("안전");
  });

  it("공식 문서 근거가 없는 복잡한 법률 질문은 추측하지 않는다", async () => {
    const request = parseChatRequest({
      message: "해외 본사가 있으면 밀린 월급을 대표 개인재산으로 바로 받을 수 있나요?",
      chat_mode: "general",
      recent_messages: [],
    });
    const response = await sendChatMessage(request);
    expect(response.answer_type).toBe("insufficient_evidence");
    expect(response.guardrail_status).toBe("limited");
    expect(response.sources).toHaveLength(0);
    expect(response.suggested_actions.some((action) => action.code === "CALL_1350")).toBe(true);
  });
});

describe("Mock 계약서 검토", () => {
  it("지원하지 않는 파일 형식을 거절한다", () => {
    expect(() =>
      validateContractRequest({
        file_metadata: {
          file_name: "contract.txt",
          content_type: "text/plain",
          size_bytes: 100,
        },
      }),
    ).toThrowError("PDF, PNG, JPG");
  });

  it("기본 Mock 검토 결과를 반환한다", async () => {
    const result = await reviewContract({ scenario_id: "default" });
    expect(result.analysis_status).toBe("mocked");
    expect(result.missing_items.map((item) => item.code)).toContain("PAYDAY");
    expect(result.limitations.join(" ")).toContain("법적 효력");
  });

  it("완성 계약서 시나리오도 법률 확정 판정을 하지 않는다", async () => {
    const result = await reviewContract({ scenario_id: "complete" });
    expect(result.missing_items).toEqual([]);
    expect(result.limitations.join(" ")).toContain("유효성을 확정하지 않습니다");
  });

  it("Real 계약 분석 장애를 계약 기능 안에서만 Mock으로 전환한다", async () => {
    process.env.APP_DATA_MODE = "real";
    process.env.ENABLE_MOCK_FALLBACK = "true";
    try {
      const result = await reviewContract({ scenario_id: "default" });
      expect(result.analysis_status).toBe("mocked");
      expect(result.warnings.join(" ")).toContain("Mock 검토 결과");
    } finally {
      process.env.APP_DATA_MODE = "mock";
    }
  });
});
