import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/services/providers", () => ({ getChatProvider: vi.fn() }));

import { parseChatRequest } from "@/services/chatService";

const review = {
  analysis_status: "partial",
  items: [{ status: "review", code: "PENALTY", label: "위약금 예정", legal_basis: "근기법 제20조", extracted_text: "원문" }],
  suggested_questions: ["위약금 조항을 빼 주실 수 있나요?"],
};

describe("상담 요청의 계약서 진단 요약", () => {
  it("계약서 모드에서만 검사한 요약을 붙인다", () => {
    const contract = parseChatRequest({ message: "위약금은 어떻게 하죠?", chat_mode: "contract", contract_review: review });
    expect(contract.contract_review).toEqual({
      analysis_status: "partial",
      items: [{ status: "review", code: "PENALTY", label: "위약금 예정", legal_basis: "근로기준법 제20조" }],
      suggested_questions: ["위약금 조항을 빼 주실 수 있나요?"],
    });
    const general = parseChatRequest({ message: "위약금은 어떻게 하죠?", chat_mode: "general", contract_review: review });
    expect(general.contract_review).toBeUndefined();
  });

  it("형식이 틀린 요약은 상담을 막지 않고 버린다", () => {
    const parsed = parseChatRequest({ message: "질문", chat_mode: "contract", contract_review: { items: "x" } });
    expect(parsed.contract_review).toBeUndefined();
  });
});
