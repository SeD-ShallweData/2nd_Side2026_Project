import { beforeEach, describe, expect, it } from "vitest";
import { PolicyChatProvider } from "@/adapters/mock/MockChatProvider";
import { MockCompanyRepository } from "@/adapters/mock/MockCompanyRepository";
import { MockContractReviewProvider } from "@/adapters/mock/MockContractReviewProvider";
import { MockRiskProvider } from "@/adapters/mock/MockRiskProvider";
import { getSignalStatusLabel } from "@/domain/riskPresentation";
import { MOCK_COMPANIES } from "@/mocks/companies";
import { MOCK_RISKS } from "@/mocks/risks";
import { parseChatRequest, sendChatMessage } from "@/services/chatService";
import { getCompanyById, searchCompanies } from "@/services/companyService";
import { MAX_CONTRACT_SIZE, reviewContract, validateContractRequest } from "@/services/contractService";
import {
  getChatProvider,
  getCompanyRepository,
  getContractReviewProvider,
  getRiskProvider,
} from "@/services/providers";
import { assertRiskIdentity, getCompanyRisk, getFreshnessFromValidUntil } from "@/services/riskService";
import { normalizeSearchText } from "@/utils/text";

beforeEach(() => {
  process.env.APP_DATA_MODE = "mock";
  process.env.MOCK_DELAY_MS = "0";
});

describe("검색과 company_id 정합성", () => {
  it("유니코드·대소문자·여러 공백을 같은 검색 문자열로 정규화한다", () => {
    expect(normalizeSearchText("  ＨanBit   TECH ")).toBe("hanbittech");
    expect(normalizeSearchText("OO   건설")).toBe("oo건설");
  });

  it("검색에서 선택한 company_id가 상세와 Risk 조회까지 유지된다", async () => {
    const search = await searchCompanies("다온제조");
    const selected = search.items[0];
    const company = await getCompanyById(selected.company_id);
    const risk = await getCompanyRisk(selected.company_id);

    expect(company.company_id).toBe(selected.company_id);
    expect(risk.company_id).toBe(selected.company_id);
    expect(risk.company_name).toBe(selected.company_name);
  });

  it("동명이인 사업장의 ID·주소·업종을 서로 다르게 유지한다", async () => {
    const result = await searchCompanies("OO건설");
    expect(result.items).toHaveLength(2);
    expect(new Set(result.items.map((item) => item.company_id)).size).toBe(2);
    expect(new Set(result.items.map((item) => item.address)).size).toBe(2);
    expect(new Set(result.items.map((item) => item.industry)).size).toBe(2);
  });

  it("선택한 회사와 다른 Risk 식별값을 차단한다", () => {
    const company = MOCK_COMPANIES[0];
    const mismatched = { ...MOCK_RISKS.COMPANY_DEMO_001, company_id: "COMPANY_DEMO_002" };
    expect(() => assertRiskIdentity(company, mismatched)).toThrow("선택한 사업장과 분석 결과가 일치하지 않습니다");
  });
});

describe("신호 정책과 데이터 노출", () => {
  it.each([
    ["COMPANY_DEMO_002", "normal", "normal"],
    ["COMPANY_DEMO_001", "watch", "review"],
    ["UNKNOWN_WAGE_001", "unknown", "watch"],
    ["UNKNOWN_SAFETY_001", "review", "unknown"],
    ["UNKNOWN_001", "unknown", "unknown"],
  ] as const)("%s의 임금 %s / 산업재해 %s 조합을 유지한다", async (companyId, wage, safety) => {
    const result = await getCompanyRisk(companyId);
    expect(result.wage_risk.level).toBe(wage);
    expect(result.safety_context.level).toBe(safety);
  });

  it("normal 표시를 안전 판정으로 바꾸지 않는다", () => {
    expect(getSignalStatusLabel("normal")).toBe("뚜렷한 이상 신호 없음");
    expect(getSignalStatusLabel("normal")).not.toContain("안전");
    expect(MOCK_RISKS.COMPANY_DEMO_002.wage_risk.summary).not.toContain("안전");
    expect(MOCK_RISKS.COMPANY_DEMO_002.safety_context.summary).not.toContain("안전한 사업장");
  });

  it("unknown은 자료 부족으로 표시하고 근거를 만들지 않는다", async () => {
    const result = await getCompanyRisk("UNKNOWN_001");
    expect(getSignalStatusLabel("unknown")).toContain("자료 부족");
    expect(result.wage_risk.evidence_items).toEqual([]);
    expect(result.safety_context.evidence_items).toEqual([]);
    expect(result.sources).toEqual([]);
  });

  it("valid_until을 기준으로 stale 상태를 계산한다", () => {
    expect(getFreshnessFromValidUntil("2026-06-30", new Date("2026-08-04T12:00:00+09:00"))).toBe("expired");
    expect(getFreshnessFromValidUntil("2026-08-04", new Date("2026-08-04T12:00:00+09:00"))).toBe("current");
  });

  it("출처가 없는 데이터에 출처를 생성하지 않는다", async () => {
    expect((await getCompanyRisk("UNKNOWN_001")).sources).toHaveLength(0);
  });

  it("사용자용 Risk 데이터에 내부 모델 필드가 없다", () => {
    const serialized = JSON.stringify(Object.values(MOCK_RISKS));
    for (const field of [
      "raw_probability",
      "percentile",
      "shap_value",
      "internal_score",
      "model_threshold",
      "hidden_prompt",
      "system_prompt",
    ]) {
      expect(serialized).not.toContain(field);
    }
  });

  it("Risk 공급자 오류를 unavailable UI가 처리할 수 있는 503으로 전달한다", async () => {
    await expect(getCompanyRisk("ERROR_001")).rejects.toMatchObject({
      code: "RISK_SOURCE_UNAVAILABLE",
      status: 503,
      retryable: true,
    });
  });

  it("Mock 데이터와 사용자 문구에 금지된 확정 표현이 없다", () => {
    const publicCopy = JSON.stringify({ risks: MOCK_RISKS });
    for (const phrase of [
      "안전한 회사입니다",
      "위험한 회사입니다",
      "임금체불이 발생할 것입니다",
      "임금체불 가능성이 확실합니다",
      "입사하지 마세요",
      "입사해도 됩니다",
      "산재가 발생할 것입니다",
      "문제가 없는 사업장입니다",
      "AI가 보장합니다",
      "정상 등급이므로 안전합니다",
    ]) {
      expect(publicCopy).not.toContain(phrase);
    }
  });
});

describe("챗봇 정책 가드레일", () => {
  it.each(["이 회사 안전한가요?", "여기 입사해도 돼요?"])("회사 미선택 질문을 제한한다: %s", async (message) => {
    const response = await sendChatMessage(parseChatRequest({ message, chat_mode: "general", recent_messages: [] }));
    expect(response.answer_type).toBe("clarification");
    expect(response.sources).toEqual([]);
    expect(response.suggested_actions.some((action) => action.code === "SEARCH_COMPANY")).toBe(true);
  });

  it.each(["이 회사 안전한가요?", "여기 입사해도 돼요?"])("선택 회사에 대해서도 결론을 대신하지 않는다: %s", async (message) => {
    const response = await sendChatMessage(
      parseChatRequest({ message, company_id: "COMPANY_DEMO_002", chat_mode: "general", recent_messages: [] }),
    );
    expect(response.answer_type).toBe("company_context");
    expect(response.guardrail_status).toBe("limited");
    expect(response.answer).toContain("확정할 수는 없습니다");
  });

  it("향후 임금체불을 예측하거나 단정하지 않는다", async () => {
    const response = await sendChatMessage(
      parseChatRequest({
        message: "이 회사는 임금을 체불할 거죠?",
        company_id: "COMPANY_DEMO_001",
        chat_mode: "wage",
        recent_messages: [],
      }),
    );
    expect(response.answer).toContain("확정할 수 없습니다");
    expect(response.guardrail_status).toBe("limited");
  });

  it("다른 회사 질문에 현재 회사와 다른 Risk 데이터를 섞지 않는다", async () => {
    const response = await sendChatMessage(
      parseChatRequest({
        message: "다온제조는 안전한가요?",
        company_id: "COMPANY_DEMO_001",
        chat_mode: "general",
        recent_messages: [],
      }),
    );
    expect(response.answer_type).toBe("clarification");
    expect(response.answer).toContain("현재 상담에는 OO건설만 연결");
    expect(response.sources).toEqual([]);
    expect(response.answer).not.toContain(MOCK_RISKS.COMPANY_DEMO_002.wage_risk.summary);
  });

  it("근거 없는 노동법 질문은 출처를 만들지 않고 공식 확인을 안내한다", async () => {
    const response = await sendChatMessage(
      parseChatRequest({
        message: "해외 본사면 대표 개인재산으로 바로 받을 수 있나요?",
        chat_mode: "general",
        recent_messages: [],
      }),
    );
    expect(response.answer_type).toBe("insufficient_evidence");
    expect(response.sources).toEqual([]);
    expect(response.answer).toContain("1350");
  });
});

describe("계약서 검증과 Mock 결과", () => {
  it("정상 PDF 파일 메타데이터를 허용한다", () => {
    expect(() =>
      validateContractRequest({
        file_metadata: { file_name: "contract.pdf", content_type: "application/pdf", size_bytes: 1_024 },
      }),
    ).not.toThrow();
  });

  it("지원하지 않는 파일 형식을 차단한다", () => {
    expect(() =>
      validateContractRequest({
        file_metadata: { file_name: "contract.exe", content_type: "application/octet-stream", size_bytes: 100 },
      }),
    ).toThrow("PDF, PNG, JPG");
  });

  it("10MB를 초과한 파일을 차단한다", () => {
    expect(() =>
      validateContractRequest({
        file_metadata: {
          file_name: "large.pdf",
          content_type: "application/pdf",
          size_bytes: MAX_CONTRACT_SIZE + 1,
        },
      }),
    ).toThrow("10MB 이하");
  });

  it("누락 항목이 없는 Mock 결과를 제공한다", async () => {
    const result = await reviewContract({ scenario_id: "complete" });
    expect(result.analysis_status).toBe("mocked");
    expect(result.missing_items).toEqual([]);
  });

  it("누락 항목이 여러 개인 Mock 결과를 제공한다", async () => {
    const result = await reviewContract({ scenario_id: "default" });
    expect(result.missing_items.length).toBeGreaterThan(1);
  });
});

describe("Adapter 선택", () => {
  it("Mock Mode에서 모든 Mock Adapter를 선택한다", () => {
    expect(getCompanyRepository()).toBeInstanceOf(MockCompanyRepository);
    expect(getRiskProvider()).toBeInstanceOf(MockRiskProvider);
    expect(getChatProvider()).toBeInstanceOf(PolicyChatProvider);
    expect(getContractReviewProvider()).toBeInstanceOf(MockContractReviewProvider);
  });
});
