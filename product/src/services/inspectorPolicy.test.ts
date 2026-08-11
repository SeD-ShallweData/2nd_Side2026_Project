import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { parseInspectorChatRequest } from "@/services/inspectorService";

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
