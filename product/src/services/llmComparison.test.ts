import { describe, expect, it } from "vitest";
import { DualLlmChatProvider } from "@/adapters/real/DualLlmChatProvider";
import { OpenAICompatibleChatClient } from "@/adapters/real/OpenAICompatibleChatClient";
import type { ChatResponse } from "@/domain/chat";
import type { ComparisonContext } from "@/domain/chatComparison";
import type { LlmProviderConfig } from "@/server/llmConfig";

const CONFIGS: LlmProviderConfig[] = [
  { id: "upstage", label: "Upstage Solar", apiKey: "test-upstage-secret", apiUrl: "https://upstage.test/chat", model: "solar-test" },
  { id: "skt", label: "SKT A.X", apiKey: "test-skt-secret", apiUrl: "https://skt.test/chat", model: "ax-test" },
];

const BASELINE: ChatResponse = {
  answer: "현재 정보만으로 안전 여부를 확정할 수 없습니다. 공식 기관을 통해 추가 확인하세요.",
  answer_type: "general_guidance",
  sources: [],
  suggested_actions: [{ code: "CALL_1350", label: "고용노동부 1350 확인", priority: "next" }],
  limitations: ["이 결과만으로 향후 상황을 확정할 수 없습니다."],
  guardrail_status: "limited",
  conversation_id: "conv_test",
};

const CONTEXT: ComparisonContext = {
  request: {
    message: "입사해도 될까요?",
    chat_mode: "general",
    recent_messages: [],
  },
  policyBaseline: BASELINE,
};

function payload(answer: string, model: string) {
  return {
    id: `req_${model}`,
    model,
    choices: [{ message: { content: answer }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 40 },
      completion_tokens_details: { reasoning_tokens: 3 },
    },
  };
}

describe("실제 LLM 비교 Provider", () => {
  it("두 모델에 동일한 메시지와 생성 설정을 전달하고 상세 지표를 정규화한다", async () => {
    const bodies: unknown[] = [];
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const isUpstage = String(input).includes("upstage");
      return new Response(JSON.stringify(payload(isUpstage ? "업스테이지 답변" : "SKT 답변", isUpstage ? "solar-live" : "ax-live")), {
        status: 200,
        headers: { "Content-Type": "application/json", "x-request-id": isUpstage ? "up-req" : "skt-req" },
      });
    }) as typeof fetch;

    const provider = new DualLlmChatProvider(CONFIGS, new OpenAICompatibleChatClient(fakeFetch, 5_000));
    const result = await provider.compare(CONTEXT);

    expect(result.results).toHaveLength(2);
    expect(result.results.map((item) => item.status)).toEqual(["success", "success"]);
    expect(result.results[0].metrics.usage).toMatchObject({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
    expect(result.results[1].trace.upstream_request_id).toBe("skt-req");
    const [upstageBody, sktBody] = bodies as Array<Record<string, unknown>>;
    expect(upstageBody.messages).toEqual(sktBody.messages);
    expect(upstageBody).toMatchObject({ temperature: 0.1, max_tokens: 700, stream: false });
    expect(sktBody).toMatchObject({ temperature: 0.1, max_tokens: 700, stream: false });
  });

  it("정책 위반 답변은 기준 안내로 교체하고 규칙을 기록한다", async () => {
    const fakeFetch = (async (input: RequestInfo | URL) => {
      const unsafe = String(input).includes("upstage");
      return new Response(JSON.stringify(payload(unsafe ? "이 회사는 안전한 회사입니다." : "확인 항목을 살펴보세요.", "test-model")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await new DualLlmChatProvider(CONFIGS, new OpenAICompatibleChatClient(fakeFetch)).compare(CONTEXT);
    expect(result.results[0].status).toBe("guardrail_replaced");
    expect(result.results[0].answer).toBe(BASELINE.answer);
    expect(result.results[0].trace.guardrail_hits).toContain("SAFE_COMPANY_CERTAINTY");
    expect(result.results[1].status).toBe("success");
  });

  it("한쪽 API 장애를 격리하고 다른 모델 응답을 유지한다", async () => {
    const fakeFetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("upstage")) return new Response("upstream error", { status: 503 });
      return new Response(JSON.stringify(payload("SKT 정상 답변", "ax-live")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await new DualLlmChatProvider(CONFIGS, new OpenAICompatibleChatClient(fakeFetch)).compare(CONTEXT);
    expect(result.results[0].status).toBe("fallback");
    expect(result.results[0].error).toMatchObject({ code: "LLM_UPSTREAM_ERROR", retryable: true });
    expect(result.results[1].status).toBe("success");
    expect(result.results[1].answer).toBe("SKT 정상 답변");
  });

  it("브라우저 응답 계약에 API 키와 숨은 프롬프트를 포함하지 않는다", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify(payload("정책에 맞는 답변", "test-model")), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
    const result = await new DualLlmChatProvider(CONFIGS, new OpenAICompatibleChatClient(fakeFetch)).compare(CONTEXT);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("test-upstage-secret");
    expect(serialized).not.toContain("test-skt-secret");
    expect(serialized).not.toContain("system_prompt");
    expect(serialized).not.toContain("hidden_prompt");
  });
});
