import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpRagRetriever } from "@/adapters/real/HttpRagRetriever";
import { RealContractReviewProvider } from "@/adapters/real/RealContractReviewProvider";
import { getCompanyDataMode, getContractDataMode } from "@/config/dataMode";
import { queryReadOnly } from "@/server/postgres";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("기능별 데이터 모드", () => {
  it("계약서 real 전환이 사업장 mock 모드를 바꾸지 않는다", () => {
    vi.stubEnv("APP_DATA_MODE", "mock");
    vi.stubEnv("COMPANY_DATA_MODE", "mock");
    vi.stubEnv("CONTRACT_DATA_MODE", "real");
    expect(getCompanyDataMode()).toBe("mock");
    expect(getContractDataMode()).toBe("real");
  });
});

describe("PostgreSQL 읽기 전용 경계", () => {
  it.each([
    "DELETE FROM firms",
    "UPDATE firms SET name = 'x'",
    "DROP TABLE firms",
    "WITH changed AS (DELETE FROM firms RETURNING *) SELECT * FROM changed",
  ])("변경 SQL을 DB 연결 전에 차단한다: %s", async (sql) => {
    await expect(queryReadOnly(sql)).rejects.toThrow(/SELECT\/CTE|변경 SQL이 차단/);
  });
});

describe("RAG 내부 계약", () => {
  it("검색 문서와 출처를 공개 DTO로 정규화한다", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({
      status: "matched",
      query: "임금 지급일",
      threshold: 0.42,
      items: [{
        content: "임금 지급 관련 공식 조문",
        citation: "근로기준법 제43조",
        distance: 0.18,
        source: {
          name: "근로기준법 제43조",
          organization: "국가법령정보센터",
          document_id: "LABOR_STANDARDS_ACT_43",
        },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;

    const result = await new HttpRagRetriever("http://rag.test", 1_000, fakeFetch).retrieve("임금 지급일");
    expect(result.status).toBe("matched");
    expect(result.documents[0]).toMatchObject({
      citation: "근로기준법 제43조",
      source: { organization: "국가법령정보센터" },
    });
  });

  it("RAG 장애를 출처 없는 unavailable로 격리한다", async () => {
    const fakeFetch = (async () => {
      throw new TypeError("connection refused");
    }) as typeof fetch;
    const result = await new HttpRagRetriever("http://rag.test", 1_000, fakeFetch).retrieve("질문");
    expect(result).toMatchObject({ status: "unavailable", documents: [] });
  });

  it("내용이나 인용이 없는 검색 항목은 버린다", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({
      status: "matched",
      items: [{ content: "", citation: "" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    const result = await new HttpRagRetriever("http://rag.test", 1_000, fakeFetch).retrieve("질문");
    expect(result).toMatchObject({ status: "no_match", documents: [] });
  });
});

describe("계약서 분석 내부 계약", () => {
  it("CSH 규칙 엔진 결과를 제품 DTO로 정규화한다", async () => {
    vi.stubEnv("CONTRACT_ANALYSIS_URL", "http://contract.test");
    const fakeFetch = (async () => new Response(JSON.stringify({
      ok: true,
      review_id: "review-1",
      filename: "contract.pdf",
      verdict: {
        headline: "누락 가능 항목을 확인하세요.",
        findings: [
          {
            code: "missing_required_wage",
            level: "violation",
            title: "임금 지급일",
            message: "서면 명시를 찾지 못했습니다.",
            law: "근기법 제17조",
            evidence: "임금: 월 250만원",
          },
          {
            code: "working_hours",
            level: "ok",
            title: "소정근로시간",
            message: "근로시간이 확인됩니다.",
          },
        ],
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;

    const file = new File(["pdf"], "contract.pdf", { type: "application/pdf" });
    const result = await new RealContractReviewProvider(fakeFetch).review({ file });
    expect(result).toMatchObject({
      analysis_status: "completed",
      review_id: "review-1",
      file_name: "contract.pdf",
    });
    expect(result.missing_items[0]).toMatchObject({ code: "missing_required_wage", legal_basis: "근기법 제17조" });
    expect(result.detected_items[0]).toMatchObject({ code: "working_hours" });
  });

  it("CSH 문자열 오류를 사용자용 공급자 오류로 전달한다", async () => {
    vi.stubEnv("CONTRACT_ANALYSIS_URL", "http://contract.test");
    const fakeFetch = (async () => new Response(JSON.stringify({
      error: "Upstage API 키가 없습니다.",
    }), { status: 503, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    const file = new File(["pdf"], "contract.pdf", { type: "application/pdf" });

    await expect(new RealContractReviewProvider(fakeFetch).review({ file })).rejects.toThrow("Upstage API 키가 없습니다.");
  });
});
