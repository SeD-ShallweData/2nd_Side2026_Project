import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import {
  OpenAIResponsesClient,
  ResponsesClientError,
} from "@/server/responses/responsesClient";
import type { OpenAIResponsesConfig } from "@/server/responses/responsesConfig";

function config(overrides: Partial<OpenAIResponsesConfig> = {}): OpenAIResponsesConfig {
  return {
    apiKey: "test-secret",
    apiUrl: "https://openai.test/v1/responses",
    model: "gpt-test",
    timeoutMs: 5_000,
    runTimeoutMs: 60_000,
    maxOutputTokens: 900,
    maxToolRounds: 4,
    maxToolCalls: 8,
    store: false,
    ...overrides,
  };
}

const request = {
  instructions: "안전하게 답하세요.",
  input: [{ role: "user" as const, content: "안녕하세요" }],
  tools: [],
};

describe("OpenAI Responses fetch client", () => {
  it("공식 Responses 요청 형식으로 호출하고 raw output message를 파싱한다", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "resp_1",
          model: "gpt-test-2026",
          status: "completed",
          output: [
            {
              id: "msg_1",
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: " 확인된 답변입니다. " }],
            },
          ],
          usage: {
            input_tokens: 10,
            output_tokens: 4,
            total_tokens: 14,
            input_tokens_details: { cached_tokens: 2 },
            output_tokens_details: { reasoning_tokens: 1 },
          },
        }),
        { status: 200, headers: { "x-request-id": "req_1" } },
      ),
    );
    const client = new OpenAIResponsesClient(config(), fetchFn);

    const result = await client.create(request);

    expect(result).toMatchObject({
      responseId: "resp_1",
      upstreamRequestId: "req_1",
      model: "gpt-test-2026",
      status: "completed",
      answer: "확인된 답변입니다.",
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 14,
        cached_tokens: 2,
        reasoning_tokens: 1,
      },
    });
    const init = fetchFn.mock.calls[0][1];
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: "gpt-test",
      tool_choice: "auto",
      parallel_tool_calls: false,
      max_output_tokens: 900,
      store: false,
      stream: false,
      include: ["reasoning.encrypted_content"],
    });
    expect(init?.headers).toMatchObject({ Authorization: "Bearer test-secret" });
  });

  it("호출별 강제 function tool_choice를 공식 Responses 형식으로 직렬화한다", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "resp_contract",
          model: "gpt-test",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "완료" }],
            },
          ],
        }),
        { status: 200 },
      ),
    );

    await new OpenAIResponsesClient(config(), fetchFn).create({
      ...request,
      tools: [
        {
          type: "function",
          name: "review_contract",
          description: "현재 업로드된 계약서를 검토한다.",
          parameters: {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false,
          },
          strict: true,
        },
      ],
      toolChoice: { type: "function", name: "review_contract" },
    });

    const body = JSON.parse(String(fetchFn.mock.calls[0][1]?.body));
    expect(body.tool_choice).toEqual({
      type: "function",
      name: "review_contract",
    });
  });

  it("reasoning 뒤 여러 message와 여러 output_text 조각을 순서대로 합친다", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "resp_fragments",
          model: "gpt-test",
          status: "completed",
          output: [
            { type: "reasoning", id: "rs_1", encrypted_content: "opaque" },
            {
              type: "message",
              role: "assistant",
              content: [
                { type: "output_text", text: " 첫 " },
                { type: "output_text", text: "문장 " },
              ],
            },
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "둘째 문장" }],
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await new OpenAIResponsesClient(config(), fetchFn).create(request);

    expect(result.answer).toBe("첫 문장 \n둘째 문장");
    expect(result.output[0]).toMatchObject({ type: "reasoning", encrypted_content: "opaque" });
  });

  it("API 키와 명시적 모델이 없으면 네트워크를 호출하지 않는다", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    await expect(
      new OpenAIResponsesClient(config({ apiKey: undefined }), fetchFn).create(request),
    ).rejects.toMatchObject({ code: "OPENAI_API_KEY_MISSING" });
    await expect(
      new OpenAIResponsesClient(config({ model: undefined }), fetchFn).create(request),
    ).rejects.toMatchObject({ code: "OPENAI_MODEL_MISSING" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("HTTP 오류와 내부 응답 본문을 노출하지 않는다", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{"error":{"message":"secret upstream details"}}', { status: 429 }),
    );
    const client = new OpenAIResponsesClient(config(), fetchFn);

    await expect(client.create(request)).rejects.toMatchObject({
      code: "OPENAI_RESPONSES_UPSTREAM_ERROR",
      retryable: true,
      message: "OpenAI Responses API가 HTTP 429 오류를 반환했습니다.",
    });
  });

  it.each([
    [401, false],
    [403, false],
    [408, true],
    [503, true],
  ])("HTTP %i의 retryable 값을 구분한다", async (status, retryable) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status }));

    await expect(
      new OpenAIResponsesClient(config(), fetchFn).create(request),
    ).rejects.toMatchObject({ code: "OPENAI_RESPONSES_UPSTREAM_ERROR", retryable });
  });

  it("외부 요청 취소는 timeout과 구분한다", async () => {
    const controller = new AbortController();
    controller.abort();
    const abortedFetch = vi.fn<typeof fetch>().mockRejectedValue(
      new DOMException("aborted", "AbortError"),
    );

    await expect(
      new OpenAIResponsesClient(config(), abortedFetch).create({
        ...request,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "OPENAI_RESPONSES_ABORTED", retryable: false });
  });

  it.each(["failed", "incomplete"])("%s 상태를 완료 응답으로 취급하지 않는다", async (status) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "resp_bad_status",
          model: "gpt-test",
          status,
          output: [],
        }),
        { status: 200 },
      ),
    );

    await expect(
      new OpenAIResponsesClient(config(), fetchFn).create(request),
    ).rejects.toMatchObject({
      code: status === "failed" ? "OPENAI_RESPONSES_FAILED" : "OPENAI_RESPONSES_INCOMPLETE",
    });
  });

  it("timeout과 잘못된 output을 구분한다", async () => {
    const timeoutFetch = vi.fn<typeof fetch>().mockRejectedValue(
      new DOMException("timed out", "TimeoutError"),
    );
    await expect(
      new OpenAIResponsesClient(config(), timeoutFetch).create(request),
    ).rejects.toMatchObject({ code: "OPENAI_RESPONSES_TIMEOUT", retryable: true });

    const invalidFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{"id":"resp_1","output":[null]}', { status: 200 }),
    );
    await expect(
      new OpenAIResponsesClient(config(), invalidFetch).create(request),
    ).rejects.toBeInstanceOf(ResponsesClientError);
    await expect(
      new OpenAIResponsesClient(config(), invalidFetch).create(request),
    ).rejects.toMatchObject({ code: "OPENAI_RESPONSES_INVALID_RESPONSE" });
  });
});
