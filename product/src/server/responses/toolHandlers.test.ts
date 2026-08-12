import { describe, expect, it, vi } from "vitest";
import { createToolHandlers } from "@/server/responses/toolHandlers";

function dependencies() {
  return {
    searchCompanies: vi.fn(),
    getCompanyRisk: vi.fn(),
    retrieveLaborLawContext: vi.fn(),
    reviewContract: vi.fn(),
  };
}

describe("Responses tool handler 경계", () => {
  it("기존 사업장 검색 service에 정규화된 인자를 그대로 전달한다", async () => {
    const deps = dependencies();
    deps.searchCompanies.mockResolvedValue({ query: "한빛", items: [], total: 0, has_more: false });
    const handlers = createToolHandlers(deps);

    await handlers.search_company({ query: "한빛", limit: 5 }, {});

    expect(deps.searchCompanies).toHaveBeenCalledOnce();
    expect(deps.searchCompanies).toHaveBeenCalledWith("한빛", 5);
  });

  it("limit이 null이면 기존 service 기본값인 10을 사용한다", async () => {
    const deps = dependencies();
    deps.searchCompanies.mockResolvedValue({ query: "한빛", items: [], total: 0, has_more: false });
    const handlers = createToolHandlers(deps);

    await handlers.search_company({ query: "한빛", limit: null }, {});

    expect(deps.searchCompanies).toHaveBeenCalledWith("한빛", 10);
  });

  it("위험·노동법 tool이 기존 service를 재사용한다", async () => {
    const deps = dependencies();
    deps.getCompanyRisk.mockResolvedValue({ company_id: "firm-1" });
    deps.retrieveLaborLawContext.mockResolvedValue({
      query: "임금 지급일",
      status: "no_match",
      threshold: null,
      documents: [],
    });
    const handlers = createToolHandlers(deps);

    await handlers.get_company_risk(
      { company_id: "firm-1" },
      { selectedCompanyId: "firm-1" },
    );
    await handlers.retrieve_labor_law({ query: "임금 지급일" }, {});

    expect(deps.getCompanyRisk).toHaveBeenCalledWith("firm-1");
    expect(deps.retrieveLaborLawContext).toHaveBeenCalledWith("임금 지급일");
  });

  it("검색 첫 후보를 자동 선택하지 않고 사용자 선택 company_id만 허용한다", async () => {
    const deps = dependencies();
    const handlers = createToolHandlers(deps);

    await expect(
      handlers.get_company_risk({ company_id: "firm-1" }, {}),
    ).rejects.toMatchObject({ code: "COMPANY_SELECTION_REQUIRED" });
    await expect(
      handlers.get_company_risk(
        { company_id: "firm-2" },
        { selectedCompanyId: "firm-1" },
      ),
    ).rejects.toMatchObject({ code: "COMPANY_CONTEXT_MISMATCH" });
    expect(deps.getCompanyRisk).not.toHaveBeenCalled();
  });

  it("계약서 원문은 모델 인자가 아니라 요청 실행 문맥에서만 주입한다", async () => {
    const deps = dependencies();
    deps.reviewContract.mockResolvedValue({ analysis_status: "completed" });
    const handlers = createToolHandlers(deps);
    const file = new File(["contract"], "contract.pdf", { type: "application/pdf" });
    const contractRequest = {
      file,
      file_metadata: {
        file_name: file.name,
        content_type: file.type,
        size_bytes: file.size,
      },
    };

    await handlers.review_contract(
      { document_ref: "current_upload" },
      { contractRequest },
    );

    expect(deps.reviewContract).toHaveBeenCalledOnce();
    expect(deps.reviewContract).toHaveBeenCalledWith(contractRequest);
  });

  it("업로드 문맥이 없으면 기존 계약 service를 호출하지 않는다", async () => {
    const deps = dependencies();
    const handlers = createToolHandlers(deps);

    await expect(
      handlers.review_contract({ document_ref: "current_upload" }, {}),
    ).rejects.toMatchObject({ code: "CONTRACT_FILE_REQUIRED" });
    expect(deps.reviewContract).not.toHaveBeenCalled();
  });

  it("요청 취소 signal을 RAG와 계약 provider까지 전달한다", async () => {
    const deps = dependencies();
    deps.retrieveLaborLawContext.mockResolvedValue({
      query: "휴게시간",
      status: "no_match",
      threshold: null,
      documents: [],
    });
    deps.reviewContract.mockResolvedValue({ analysis_status: "completed" });
    const handlers = createToolHandlers(deps);
    const controller = new AbortController();
    const file = new File(["contract"], "contract.pdf", { type: "application/pdf" });

    await handlers.retrieve_labor_law(
      { query: "휴게시간" },
      { signal: controller.signal },
    );
    await handlers.review_contract(
      { document_ref: "current_upload" },
      {
        signal: controller.signal,
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

    expect(deps.retrieveLaborLawContext).toHaveBeenCalledWith(
      "휴게시간",
      controller.signal,
    );
    expect(deps.reviewContract).toHaveBeenCalledWith(
      expect.objectContaining({ file, signal: controller.signal }),
    );
  });
});
