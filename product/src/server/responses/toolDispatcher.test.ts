import { describe, expect, it, vi } from "vitest";
import { createToolDispatcher, serializeToolResult } from "@/server/responses/toolDispatcher";
import { createToolHandlers } from "@/server/responses/toolHandlers";
import { ServiceError } from "@/utils/errors";

function dependencies() {
  return {
    searchCompanies: vi.fn(),
    getCompanyRisk: vi.fn(),
    retrieveLaborLawContext: vi.fn(),
    reviewContract: vi.fn(),
  };
}

describe("allowlist tool dispatcher", () => {
  it("등록된 도구만 실행한다", async () => {
    const deps = dependencies();
    const dispatcher = createToolDispatcher(createToolHandlers(deps));

    const result = await dispatcher.dispatch("constructor", "{}");

    expect(result).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_TOOL" } });
    expect(deps.searchCompanies).not.toHaveBeenCalled();
    expect(deps.getCompanyRisk).not.toHaveBeenCalled();
    expect(deps.retrieveLaborLawContext).not.toHaveBeenCalled();
    expect(deps.reviewContract).not.toHaveBeenCalled();
  });

  it("검증한 인자만 해당 handler에 전달한다", async () => {
    const deps = dependencies();
    deps.searchCompanies.mockResolvedValue({
      query: "한빛",
      items: [],
      total: 0,
      has_more: false,
    });
    const dispatcher = createToolDispatcher(createToolHandlers(deps));

    const result = await dispatcher.dispatch(
      "search_company",
      '{"query":"  한빛  ","limit":5}',
    );

    expect(result).toMatchObject({ ok: true, data: { query: "한빛" } });
    expect(deps.searchCompanies).toHaveBeenCalledWith("한빛", 5);
  });

  it("잘못된 JSON과 추가 필드를 구조화된 오류로 돌려준다", async () => {
    const deps = dependencies();
    const dispatcher = createToolDispatcher(createToolHandlers(deps));

    const malformed = await dispatcher.dispatch("search_company", "{");
    const extra = await dispatcher.dispatch(
      "search_company",
      '{"query":"한빛","limit":5,"command":"drop"}',
    );

    expect(malformed).toMatchObject({
      ok: false,
      error: { code: "INVALID_TOOL_ARGUMENTS", retryable: false },
    });
    expect(extra).toMatchObject({
      ok: false,
      error: { code: "INVALID_TOOL_ARGUMENTS", details: [{ field: "command" }] },
    });
    expect(deps.searchCompanies).not.toHaveBeenCalled();
  });

  it("service의 공개 오류 계약은 보존한다", async () => {
    const deps = dependencies();
    deps.getCompanyRisk.mockRejectedValue(
      new ServiceError("COMPANY_NOT_FOUND", "사업장을 찾을 수 없습니다.", 404, false),
    );
    const dispatcher = createToolDispatcher(createToolHandlers(deps));

    const result = await dispatcher.dispatch(
      "get_company_risk",
      '{"company_id":"missing"}',
      { selectedCompanyId: "missing" },
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: "COMPANY_NOT_FOUND",
        message: "사업장을 찾을 수 없습니다.",
        retryable: false,
        details: undefined,
      },
    });
  });

  it("예상하지 못한 내부 오류 메시지는 모델에 노출하지 않는다", async () => {
    const deps = dependencies();
    deps.retrieveLaborLawContext.mockRejectedValue(
      new Error("postgres password=do-not-expose"),
    );
    const dispatcher = createToolDispatcher(createToolHandlers(deps));

    const result = await dispatcher.dispatch(
      "retrieve_labor_law",
      '{"query":"임금 지급일"}',
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "TOOL_EXECUTION_FAILED",
        message: "도구를 실행하는 중 오류가 발생했습니다.",
        retryable: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain("password");
  });

  it("계약 업로드 문맥 누락도 실행 오류가 아닌 공개 service 오류로 반환한다", async () => {
    const deps = dependencies();
    const dispatcher = createToolDispatcher(createToolHandlers(deps));

    const result = await dispatcher.dispatch(
      "review_contract",
      '{"document_ref":"current_upload"}',
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "CONTRACT_FILE_REQUIRED", retryable: false },
    });
    expect(deps.reviewContract).not.toHaveBeenCalled();
  });

  it("모든 실행 결과를 function_call_output용 JSON 문자열로 직렬화한다", async () => {
    const deps = dependencies();
    deps.retrieveLaborLawContext.mockResolvedValue({
      query: "휴게시간",
      status: "no_match",
      threshold: null,
      documents: [],
    });
    const dispatcher = createToolDispatcher(createToolHandlers(deps));
    const result = await dispatcher.dispatch(
      "retrieve_labor_law",
      '{"query":"휴게시간"}',
    );

    expect(JSON.parse(serializeToolResult(result))).toEqual(result);
  });

  it("과도하게 큰 도구 결과를 다음 Responses 요청에 전달하지 않는다", async () => {
    const deps = dependencies();
    deps.reviewContract.mockResolvedValue({
      analysis_status: "completed",
      detected_items: [
        {
          code: "HUGE",
          label: "큰 결과",
          status: "detected",
          description: "x".repeat(140 * 1024),
        },
      ],
      missing_items: [],
      review_items: [],
      warnings: [],
      suggested_questions: [],
      limitations: [],
    });
    const dispatcher = createToolDispatcher(createToolHandlers(deps));
    const file = new File(["contract"], "contract.pdf", { type: "application/pdf" });

    const result = await dispatcher.dispatch(
      "review_contract",
      '{"document_ref":"current_upload"}',
      {
        contractRequest: {
          file,
          file_metadata: {
            file_name: file.name,
            content_type: file.type,
            size_bytes: file.size,
          },
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "TOOL_RESULT_TOO_LARGE", retryable: false },
    });
    expect(serializeToolResult(result).length).toBeLessThan(1_000);
  });
});
