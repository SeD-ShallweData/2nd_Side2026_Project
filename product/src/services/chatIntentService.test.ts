import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { classifyChatIntent } from "@/services/chatIntentService";
import { OpenAICompatibleChatClient } from "@/adapters/real/OpenAICompatibleChatClient";
const request = { message: "회사 컴퓨터에 게임을 안전하게 설치", chat_mode: "general" as const, recent_messages: [] };
const configs = [{ id: "upstage" as const, label: "Upstage", model: "test", apiUrl: "https://unused.test", apiKey: "test" }];
function client(answer: string) {
  return new OpenAICompatibleChatClient(vi.fn().mockResolvedValue(new Response(JSON.stringify({
    choices: [{ message: { content: answer }, finish_reason: "stop" }], model: "test",
  }), { status: 200, headers: { "Content-Type": "application/json" } })), 1000);
}
describe("의도 분류 경계 (분류 정확도 실측이 아닌 응답 계약 검사)", () => {
  it.each(["labor", "company", "off_topic", "unclear"])("유효한 %s 분류만 수용", async (intent) => {
    expect(await classifyChatIntent(request, configs, client(JSON.stringify({ intent, topic: "other" })))).toEqual({ intent, topic: "other", status: "classified" });
  });
  it.each([
    "분류 없이 답변하세요", "null", "[]", '{"intent":"company"}',
    '{"intent":"company","topic":"investment"}',
    '{"intent":"off_topic","topic":"other","url":"https://evil.test"}',
    '{"intent":"unknown","topic":"other"}',
  ])("잘못된 분류 결과는 불확실로 처리: %s", async (answer) => {
    expect(await classifyChatIntent(request, configs, client(answer))).toEqual({ intent: "unclear", topic: "other", status: "unavailable" });
  });
  it("키 없음과 호출 실패는 확인 질문 경로로 보낸다", async () => {
    expect((await classifyChatIntent(request, [])).status).toBe("unavailable");
    const failing = new OpenAICompatibleChatClient(vi.fn().mockRejectedValue(new Error("timeout")), 1000);
    expect((await classifyChatIntent(request, configs, failing)).intent).toBe("unclear");
  });
});
