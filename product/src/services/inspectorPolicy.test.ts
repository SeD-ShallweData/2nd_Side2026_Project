import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { inspectorGuardrailHits, parseInspectorChatRequest } from "@/services/inspectorService";

describe("inspector chat boundary", () => {
  it("requires explicit approval before internal risk context can be sent to external LLMs", () => {
    expect(() => parseInspectorChatRequest({
      company_id: "firm-1",
      message: "확인 항목을 알려줘",
      recent_messages: [],
    })).toThrow(/전송에 동의/);
  });

  it("accepts a bounded request only after explicit approval", () => {
    expect(parseInspectorChatRequest({
      company_id: "firm-1",
      message: "  확인 항목을 알려줘  ",
      recent_messages: [{ role: "user", content: "이전 질문" }],
      confirm_external_context: true,
    })).toEqual({
      company_id: "firm-1",
      message: "확인 항목을 알려줘",
      recent_messages: [{ role: "user", content: "이전 질문" }],
      confirm_external_context: true,
    });
  });
});

describe("inspector answer guardrails", () => {
  it("확률 변환과 근거 없는 법 조항을 각각 차단한다", () => {
    expect(inspectorGuardrailHits("체불 위험은 82%입니다.", "matched")).toContain("PROBABILITY_CONVERSION");
    expect(inspectorGuardrailHits("근로기준법 제999조를 적용합니다.", "no_match")).toContain("UNVERIFIED_LAW_CITATION");
  });

  it("내부 지침 공개를 거절한 정상 문장은 유출로 오탐하지 않는다", () => {
    expect(inspectorGuardrailHits("시스템 프롬프트는 안내해 드릴 수 없습니다.", "matched")).toEqual([]);
  });
});
