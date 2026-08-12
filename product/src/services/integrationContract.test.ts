import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpRagRetriever } from "@/adapters/real/HttpRagRetriever";
import { RealContractReviewProvider } from "@/adapters/real/RealContractReviewProvider";
import { toWageRiskPublic } from "@/adapters/real/MlRiskProvider";
import { getCompanyDataMode, getContractDataMode } from "@/config/dataMode";
import { buildBotDatabaseUrl } from "@/server/databaseConfig";
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

describe("실제 ML DB 공개 경계", () => {
  const baseRow = {
    firm_id: "firm-1",
    name: "테스트사업장",
    sido: "서울특별시",
    industry: "정보통신업",
    batch_id: 4,
    score_batch_id: 4,
    model_version: "model-v1",
    as_of_date: "2026-06-01",
    target_month: "2026-12-01",
    ingested_at: "2026-08-11T00:00:00Z",
    n_months: 12,
    n_green: 4,
    excluded_wage: false,
  };

  it.each([
    ["안정신호", "normal"],
    ["유보", "watch"],
    ["유보_정보부족", "unknown"],
    ["배제_4대보험체납(door1)", "review"],
  ] as const)("실제 판정 %s를 사용자 상태 %s로 변환한다", (verdict, level) => {
    expect(toWageRiskPublic({ ...baseRow, verdict }).level).toBe(level);
  });

  it("원시 점수 없이 공식 명단 상태와 확인 근거만 반환한다", () => {
    const result = toWageRiskPublic({
      ...baseRow,
      verdict: "배제_임금체불공개",
      excluded_wage: true,
    });
    expect(result.official_listing.status).toBe("listed");
    expect(result.evidence_codes).toContain("OFFICIAL_WAGE_LISTING_MATCH");
    expect(JSON.stringify(result)).not.toMatch(/risk_full|probability|percentile|shap/i);
  });

  it("공유 DB 파일에서는 관리자 계정이 아니라 bot 계정 URL만 만든다", () => {
    const url = buildBotDatabaseUrl({
      DB_NAME: "wageguard",
      DB_PORT: "5433",
      DB_USER: "admin",
      DB_PASSWORD: "admin-secret",
      BOT_NAME: "wg_bot",
      BOT_PASSWORD: "bot:secret@value",
    });
    expect(url).toBe("postgresql://wg_bot:bot%3Asecret%40value@127.0.0.1:5433/wageguard");
    expect(url).not.toContain("admin");
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
      retrieval_query: "임금 지급일 임금 지급 원칙",
      reason: null,
      topic: null,
      threshold: 0.42,
      top1_distance: 0.18,
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
    expect(result).toMatchObject({
      retrieval_query: "임금 지급일 임금 지급 원칙",
      reason: null,
      top1_distance: 0.18,
    });
    expect(result.documents[0]).toMatchObject({
      citation: "근로기준법 제43조",
      source: { organization: "국가법령정보센터" },
    });
  });

  it("범위 밖 이유와 주제를 보존한다", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({
      status: "no_match",
      query: "산재 신청은 어떻게 하나요?",
      reason: "out_of_scope",
      topic: "산업재해·산업안전",
      threshold: 0.42,
      top1_distance: 0.5,
      items: [],
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;

    const result = await new HttpRagRetriever("http://rag.test", 1_000, fakeFetch).retrieve("산재 신청은 어떻게 하나요?");
    expect(result).toMatchObject({
      status: "no_match",
      reason: "out_of_scope",
      topic: "산업재해·산업안전",
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
    let requestedUrl = "";
    let requestedBody: FormData | undefined;
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedBody = init?.body instanceof FormData ? init.body : undefined;
      return new Response(JSON.stringify({
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
              detail: "지급일을 특정할 수 없습니다.",
              law: "근기법 제17조",
              evidence: "임금: 월 250만원",
              fix: "임금 지급일을 서면으로 확인하세요.",
            },
            {
              code: "working_hours",
              level: "ok",
              title: "소정근로시간",
              message: "근로시간이 확인됩니다.",
            },
          ],
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const file = new File(["pdf"], "contract.pdf", { type: "application/pdf" });
    const result = await new RealContractReviewProvider(fakeFetch).review({ file });
    expect(result).toMatchObject({
      analysis_status: "completed",
      review_id: "review-1",
      file_name: "contract.pdf",
    });
    expect(requestedUrl).toBe("http://contract.test/api/contract/review");
    expect(requestedBody?.get("ocr")).toBe("auto");
    expect(requestedBody?.get("file")).toBeInstanceOf(File);
    expect(result.missing_items[0]).toMatchObject({
      code: "missing_required_wage",
      legal_basis: "근기법 제17조",
      extracted_text: "임금: 월 250만원",
    });
    expect(result.missing_items[0].description).toContain("임금 지급일을 서면으로 확인하세요.");
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

  it("근로계약서가 아닌 문서는 명시적인 사용자 오류로 구분한다", async () => {
    vi.stubEnv("CONTRACT_ANALYSIS_URL", "http://contract.test");
    const fakeFetch = (async () => new Response(JSON.stringify({
      ok: false,
      reason: "not_a_contract",
      message: "근로계약서로 볼 만한 내용을 찾지 못했습니다.",
    }), { status: 422, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    const file = new File(["image"], "not-contract.png", { type: "image/png" });

    await expect(new RealContractReviewProvider(fakeFetch).review({ file })).rejects.toMatchObject({
      code: "NOT_A_CONTRACT",
      status: 422,
      retryable: true,
    });
  });
});
