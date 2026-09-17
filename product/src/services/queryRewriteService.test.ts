import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { OpenAICompatibleChatClient } from "@/adapters/real/OpenAICompatibleChatClient";
import type { ChatRequest } from "@/domain/chat";
import type { LlmProviderConfig } from "@/server/llmConfig";
import { rewriteFollowupQuery } from "@/services/queryRewriteService";

const CONFIG: LlmProviderConfig = {
  id: "upstage",
  label: "Upstage",
  apiKey: "test-key",
  apiUrl: "https://up.test/chat",
  model: "solar",
};

const REQUEST: ChatRequest = {
  message: "그럼 어디에 신고해?",
  chat_mode: "wage",
  recent_messages: [
    { role: "user", content: "월급이 두 달째 밀렸어요." },
    { role: "assistant", content: "임금체불 자료를 먼저 정리하세요." },
  ],
};

describe("follow-up query rewrite", () => {
  it("CSH 규칙대로 후속 질문을 RAG용 독립 질문으로 바꾼다", async () => {
    let body: { temperature?: number; max_tokens?: number; messages?: Array<{ content: string }> } = {};
    const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        model: "solar",
        choices: [{ message: { content: "임금체불은 어디에 신고하나요?" }, finish_reason: "stop" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const result = await rewriteFollowupQuery(REQUEST, [CONFIG], new OpenAICompatibleChatClient(fakeFetch));
    expect(result).toEqual({ query: "임금체불은 어디에 신고하나요?", changed: true });
    expect(body).toMatchObject({ temperature: 0, max_tokens: 120 });
    expect(body.messages?.[0].content).toContain("독립 질문");
  });

  it("재작성 공급자가 실패해도 생략형 후속 질문은 마지막 사용자 발화와 함께 검색한다", async () => {
    const fakeFetch = (async () => new Response("blocked", { status: 401 })) as typeof fetch;
    await expect(rewriteFollowupQuery(
      REQUEST,
      [CONFIG],
      new OpenAICompatibleChatClient(fakeFetch),
    )).resolves.toEqual({ query: "월급이 두 달째 밀렸어요. 그럼 어디에 신고해?", changed: true });
  });

  it("재작성 결과가 원문 그대로여도 assistant 안내 대신 마지막 사용자 발화만 결합한다", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({
      model: "solar",
      choices: [{ message: { content: REQUEST.message }, finish_reason: "stop" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    const result = await rewriteFollowupQuery(REQUEST, [CONFIG], new OpenAICompatibleChatClient(fakeFetch));
    expect(result).toEqual({ query: "월급이 두 달째 밀렸어요. 그럼 어디에 신고해?", changed: true });
    expect(result.query).not.toContain("자료를 먼저 정리하세요");
  });

  it("대화 이력이 없으면 추가 LLM 호출을 하지 않는다", async () => {
    const fakeFetch = vi.fn() as unknown as typeof fetch;
    const result = await rewriteFollowupQuery(
      { ...REQUEST, recent_messages: [] },
      [CONFIG],
      new OpenAICompatibleChatClient(fakeFetch),
    );
    expect(result).toEqual({ query: REQUEST.message, changed: false });
    expect(fakeFetch).not.toHaveBeenCalled();
  });
});
