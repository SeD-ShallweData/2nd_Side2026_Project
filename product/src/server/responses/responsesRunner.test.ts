import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type {
  ResponsesClient,
  ResponsesClientResult,
  ResponsesOutputItem,
} from "@/server/responses/responsesClient";
import type { TokenUsage } from "@/domain/chatComparison";
import { OpenAIResponsesRunner } from "@/server/responses/responsesRunner";
import type { ToolDispatcher } from "@/server/responses/toolDispatcher";

const USAGE: TokenUsage = {
  prompt_tokens: 10,
  completion_tokens: 2,
  total_tokens: 12,
  cached_tokens: 1,
  reasoning_tokens: 1,
};

function response(
  output: ResponsesOutputItem[],
  overrides: Partial<ResponsesClientResult> = {},
): ResponsesClientResult {
  return {
    responseId: "resp_1",
    upstreamRequestId: "req_1",
    model: "gpt-test",
    status: "completed",
    finishReason: null,
    output,
    answer: "",
    refusal: null,
    usage: USAGE,
    latencyMs: 1,
    ...overrides,
  };
}

function finalResponse(answer = "최종 답변입니다.", usage = USAGE): ResponsesClientResult {
  return response(
    [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: answer }],
      },
    ],
    { responseId: "resp_final", answer, usage },
  );
}

function runner(
  responses: ResponsesClientResult[],
  dispatchResult: Awaited<ReturnType<ToolDispatcher["dispatch"]>> = {
    ok: true,
    data: {
      query: "한빛",
      items: [],
      total: 0,
      has_more: false,
      page: 1,
      page_size: 10,
      total_pages: 0,
    },
  },
  limits = { maxToolRounds: 4, maxToolCalls: 8, runTimeoutMs: 60_000 },
) {
  const create = vi.fn<ResponsesClient["create"]>();
  for (const item of responses) create.mockResolvedValueOnce(item);
  const dispatch = vi.fn<ToolDispatcher["dispatch"]>().mockResolvedValue(dispatchResult);
  return {
    subject: new OpenAIResponsesRunner({ create }, limits, { dispatch }),
    create,
    dispatch,
  };
}

const initialRequest = {
  instructions: "도구를 사용하고 근거만 답하세요.",
  input: [{ role: "user" as const, content: "한빛 산업을 찾아줘" }],
};

describe("OpenAI Responses function-call runner", () => {
  it("도구 호출이 없으면 첫 응답을 최종 답변으로 반환한다", async () => {
    const { subject, create, dispatch } = runner([finalResponse()]);

    const result = await subject.run(initialRequest);

    expect(result.answer).toBe("최종 답변입니다.");
    expect(result.toolRounds).toBe(0);
    expect(create).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
    expect(create.mock.calls[0][0].tools.map((tool) => tool.name)).not.toContain(
      "review_contract",
    );
  });

  it("reasoning 원본과 같은 call_id의 function_call_output을 다음 요청에 전달한다", async () => {
    const reasoning = {
      type: "reasoning",
      id: "rs_1",
      encrypted_content: "opaque-value",
      summary: [],
    };
    const call = {
      type: "function_call",
      call_id: "call_1",
      name: "retrieve_labor_law",
      arguments: '{"query":"임금 지급일"}',
    };
    const ragResult = {
      ok: true as const,
      data: {
        query: "임금 지급일",
        status: "matched" as const,
        threshold: 0.4,
        documents: [
          {
            content: "임금은 정해진 날 지급한다.",
            citation: "근로기준법 제43조",
            distance: 0.1,
            source: { name: "국가법령정보센터", document_id: "law-43" },
          },
        ],
      },
    };
    const { subject, create, dispatch } = runner(
      [response([reasoning, call], { answer: "잠정 답변" }), finalResponse()],
      ragResult,
    );

    const result = await subject.run(initialRequest);

    expect(dispatch).toHaveBeenCalledWith(
      "retrieve_labor_law",
      '{"query":"임금 지급일"}',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const secondInput = create.mock.calls[1][0].input;
    expect(secondInput).toContain(reasoning);
    expect(secondInput).toContain(call);
    expect(secondInput.at(-1)).toMatchObject({
      type: "function_call_output",
      call_id: "call_1",
    });
    expect(JSON.parse(String((secondInput.at(-1) as { output: string }).output))).toEqual(
      ragResult,
    );
    expect(result.answer).toBe("최종 답변입니다.");
    expect(result.toolRounds).toBe(1);
    expect(result.usage).toEqual({
      prompt_tokens: 20,
      completion_tokens: 4,
      total_tokens: 24,
      cached_tokens: 2,
      reasoning_tokens: 2,
    });
    expect(result.ledger).toEqual({
      ragStatus: "matched",
      ragReason: null,
      ragTopic: null,
      citations: ["근로기준법 제43조"],
      sources: [{ name: "국가법령정보센터", document_id: "law-43" }],
      retrievedDocumentCount: 1,
    });
  });

  it("한 라운드라도 누락된 usage 항목은 합계도 null로 유지한다", async () => {
    const call = {
      type: "function_call",
      call_id: "call_1",
      name: "search_company",
      arguments: '{"query":"한빛","limit":5}',
    };
    const { subject } = runner([
      response([call]),
      finalResponse("완료", { ...USAGE, cached_tokens: null }),
    ]);

    const result = await subject.run(initialRequest);

    expect(result.usage.cached_tokens).toBeNull();
    expect(result.usage.total_tokens).toBe(24);
  });

  it("동일 call_id와 동일 호출은 실행 결과를 재사용한다", async () => {
    const call = {
      type: "function_call",
      call_id: "call_repeat",
      name: "search_company",
      arguments: '{"query":"한빛","limit":5}',
    };
    const { subject, dispatch } = runner([
      response([call]),
      response([{ ...call }]),
      finalResponse(),
    ]);

    const result = await subject.run(initialRequest);

    expect(dispatch).toHaveBeenCalledOnce();
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[1]).toMatchObject({ cached: true, call_id: "call_repeat" });
  });

  it("동일 call_id가 다른 호출로 재사용되면 protocol 오류로 중단한다", async () => {
    const { subject, dispatch } = runner([
      response([
        {
          type: "function_call",
          call_id: "call_conflict",
          name: "search_company",
          arguments: '{"query":"한빛","limit":5}',
        },
      ]),
      response([
        {
          type: "function_call",
          call_id: "call_conflict",
          name: "search_company",
          arguments: '{"query":"다른 회사","limit":5}',
        },
      ]),
    ]);

    await expect(subject.run(initialRequest)).rejects.toMatchObject({
      code: "OPENAI_RESPONSES_DUPLICATE_CALL_ID",
      retryable: false,
    });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("tool round와 전체 call 수 한도를 강제한다", async () => {
    const call = {
      type: "function_call",
      call_id: "call_1",
      name: "search_company",
      arguments: '{"query":"한빛","limit":5}',
    };
    const { subject, dispatch } = runner(
      [response([call]), response([{ ...call, call_id: "call_2" }])],
      undefined,
      { maxToolRounds: 1, maxToolCalls: 8, runTimeoutMs: 60_000 },
    );

    await expect(subject.run(initialRequest)).rejects.toMatchObject({
      code: "OPENAI_RESPONSES_TOOL_ROUND_LIMIT",
    });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("review_contract는 업로드가 있어도 한 run에서 한 번만 실행한다", async () => {
    const calls = ["call_contract_1", "call_contract_2"].map((callId) => ({
      type: "function_call",
      call_id: callId,
      name: "review_contract",
      arguments: '{"document_ref":"current_upload"}',
    }));
    const result = {
      ok: true as const,
      data: {
        analysis_status: "completed" as const,
        detected_items: [],
        missing_items: [],
        review_items: [
          {
            code: "written_terms",
            label: "서면 명시",
            status: "review" as const,
            description: "확인이 필요합니다.",
            legal_basis: "근기법 제17조",
          },
        ],
        warnings: [],
        suggested_questions: [],
        limitations: [],
      },
    };
    const { subject, create, dispatch } = runner([response(calls), finalResponse()], result);
    const file = new File(["contract"], "contract.pdf", { type: "application/pdf" });

    const run = await subject.run({
      ...initialRequest,
      context: {
        contractRequest: {
          file,
          file_metadata: {
            file_name: file.name,
            content_type: file.type,
            size_bytes: file.size,
          },
        },
      },
    });

    expect(create.mock.calls[0][0].tools.map((tool) => tool.name)).toContain(
      "review_contract",
    );
    expect(create.mock.calls[0][0].toolChoice).toEqual({
      type: "function",
      name: "review_contract",
    });
    expect(create.mock.calls[1][0].toolChoice).toBe("auto");
    expect(dispatch).toHaveBeenCalledOnce();
    expect(run.toolCalls[1]).toMatchObject({ ok: false, error_code: "TOOL_CALL_LIMIT" });
    expect(run.ledger.citations).toContain("근로기준법 제17조");
  });

  it("업로드가 있는데 강제 계약 도구 없이 최종 답변이 오면 성공으로 반환하지 않는다", async () => {
    const { subject, create, dispatch } = runner([
      finalResponse("계약서를 검토했다고 주장하는 답변"),
    ]);
    const file = new File(["contract"], "contract.pdf", { type: "application/pdf" });

    await expect(
      subject.run({
        ...initialRequest,
        context: {
          contractRequest: {
            file,
            file_metadata: {
              file_name: file.name,
              content_type: file.type,
              size_bytes: file.size,
            },
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "OPENAI_RESPONSES_CONTRACT_TOOL_REQUIRED",
      retryable: true,
    });
    expect(create.mock.calls[0][0].toolChoice).toEqual({
      type: "function",
      name: "review_contract",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("refusal·빈 답변·깨진 function call을 명시적 오류로 구분한다", async () => {
    const refused = runner([
      response(
        [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "no" }] }],
        { refusal: "no" },
      ),
    ]).subject;
    await expect(refused.run(initialRequest)).rejects.toMatchObject({
      code: "OPENAI_RESPONSES_REFUSAL",
    });

    const empty = runner([response([])]).subject;
    await expect(empty.run(initialRequest)).rejects.toMatchObject({
      code: "OPENAI_RESPONSES_EMPTY_ANSWER",
    });

    const malformed = runner([
      response([{ type: "function_call", call_id: "call_bad", name: "search_company" }]),
    ]).subject;
    await expect(malformed.run(initialRequest)).rejects.toMatchObject({
      code: "OPENAI_RESPONSES_INVALID_FUNCTION_CALL",
    });
  });
});
