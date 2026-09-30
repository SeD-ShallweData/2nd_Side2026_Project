import { beforeEach, describe, expect, it } from "vitest";
import { PolicyChatProvider } from "@/adapters/mock/MockChatProvider";
import { MockCompanyRepository } from "@/adapters/mock/MockCompanyRepository";
import { MockRiskProvider } from "@/adapters/mock/MockRiskProvider";
import { parseChatRequest } from "@/services/chatService";

beforeEach(() => {
  process.env.APP_DATA_MODE = "mock";
  process.env.MOCK_DELAY_MS = "0";
});

const provider = new PolicyChatProvider(new MockCompanyRepository(), new MockRiskProvider());

describe("상담 경로의 외국어 긴급 안내", () => {
  it("태국어 추락 신고에 태국어 고정 긴급 안내로 답한다", async () => {
    const response = await provider.sendMessage(parseChatRequest({ message: "เพื่อนร่วมงานตกจากที่สูง", chat_mode: "general" }));
    expect(response.answer_type).toBe("emergency_guidance");
    expect(response.guardrail_status).toBe("escalated");
    expect(response.answer).toContain("119");
    expect(response.answer).toContain("โทร 119");
    expect(response.suggested_actions[0].label).toBe("ไปยังที่ปลอดภัยทันที");
  });

  it("화면 언어가 베트남어면 중국어로 써도 베트남어로 답한다", async () => {
    const response = await provider.sendMessage(parseChatRequest({ message: "手被机器夹住了", chat_mode: "general", ui_locale: "vi" }));
    expect(response.answer_type).toBe("emergency_guidance");
    expect(response.answer).toContain("Gọi 119");
  });

  it("지원 예정 언어의 긴급 신고는 영어로 답한다", async () => {
    const response = await provider.sendMessage(parseChatRequest({ message: "он без сознания", chat_mode: "general" }));
    expect(response.answer).toContain("Call 119");
  });

  it("한국어 긴급 안내는 그대로다", async () => {
    const response = await provider.sendMessage(parseChatRequest({ message: "작업 중에 동료가 추락해서 의식이 없어요", chat_mode: "general" }));
    expect(response.answer_type).toBe("emergency_guidance");
    expect(response.answer).not.toContain("(한국어)");
  });

  it("알 수 없는 ui_locale 은 버린다", () => {
    expect(parseChatRequest({ message: "질문", chat_mode: "general", ui_locale: "xx" }).ui_locale).toBeUndefined();
    expect(parseChatRequest({ message: "질문", chat_mode: "general", ui_locale: "th" }).ui_locale).toBe("th");
  });
});
