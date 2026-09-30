import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpRagRetriever } from "@/adapters/real/HttpRagRetriever";
import { RealContractReviewProvider } from "@/adapters/real/RealContractReviewProvider";
import { toWageRiskPublic } from "@/adapters/real/MlRiskProvider";
import { getCompanyDataMode, getContractDataMode } from "@/config/dataMode";
import { buildBotDatabaseUrl, getDatabaseConnectionString } from "@/server/databaseConfig";
import { queryReadOnly } from "@/server/postgres";
import { errorPayload, resetApiErrorLogForTests } from "@/utils/errors";

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
    ingested_date: "2026-08-11",
    n_months: 12,
    n_green: 4,
    excluded_wage: false,
  };

  it("긍정 개수와 항목을 같은 배치의 확인값으로 공개한다", () => {
    const result = toWageRiskPublic({ ...baseRow, verdict: "유보", n_green: 2,
      positive_flags: [true, false, false, false, true, false] });
    expect(result.positive_signals?.confirmed_count).toBe(2);
    expect(result.positive_signals?.items.filter(x => x.status === "confirmed").map(x => x.label))
      .toEqual(["고용 안정", "업력 약 3년 이상"]);
    expect(result.level).toBe("watch");
    expect(result.evidence_items[0].description).toContain("부정적인 기업으로 판단할 수 없습니다");
    expect(JSON.stringify(result)).not.toMatch(/positive_flags|g1_|g5_|n_green|risk_full/);
  });

  it.each([
    { verdict: "유보_정보부족", positive_flags: [true, true, true, true, false, false] },
    { positive_flags: [true, true, true, null, false, false] },
    { positive_flags: [true, true, true, true, false, false], n_green: 5 },
    { positive_flags: [true, true, true, true, false, false], score_batch_id: 3 },
    { positive_flags: undefined },
  ])("자료 부족·불일치에서 개수나 체크를 확정하지 않는다: %j", (override) => {
    const result = toWageRiskPublic({ ...baseRow, verdict: "유보", ...override });
    expect(result.positive_signals?.availability).toBe("unavailable");
    expect(result.positive_signals?.confirmed_count).toBeNull();
    expect(result.positive_signals?.items.some(x => x.status === "confirmed")).toBe(false);
  });

  it("확인된 0개는 자료 없음과 구분하고 명단 등재는 그대로 유지한다", () => {
    const result = toWageRiskPublic({ ...baseRow, verdict: "배제_임금체불공개", excluded_wage: true,
      n_green: 0, positive_flags: [false, false, false, false, false, false] });
    expect(result.positive_signals).toMatchObject({ availability: "ready", confirmed_count: 0 });
    expect(result.official_listing.status).toBe("listed");
    expect(result.level).toBe("review");
  });

  it.each([
    ["안정신호", "normal"],
    ["유보", "watch"],
    ["유보_정보부족", "unknown"],
    ["배제_4대보험체납(door1)", "review"],
    ["배제_공개체납", "review"],
    ["배제_임금체불공개", "review"],
  ] as const)("실제 판정 %s를 사용자 상태 %s로 변환한다", (verdict, level) => {
    const result = toWageRiskPublic({ ...baseRow, verdict });
    expect(result.level).toBe(level);
    expect(result.verdict).toBe(verdict);
  });

  it("원시 점수나 모델 배치일 없이 공식 명단 상태와 확인 근거만 반환한다", () => {
    const result = toWageRiskPublic({
      ...baseRow,
      verdict: "배제_임금체불공개",
      excluded_wage: true,
    });
    expect(result.official_listing.status).toBe("listed");
    expect(result.official_listing.as_of).toBeNull();
    expect(result.evidence_codes).toContain("OFFICIAL_WAGE_LISTING_MATCH");
    expect(result.evidence_items[0]?.description).not.toContain("기준일 현재");
    expect(JSON.stringify(result)).not.toMatch(/risk_full|probability|percentile|shap/i);
  });

  it("공유 DB 파일의 BOT_USER를 관리자와 기존 bot 이름보다 우선한다", () => {
    const url = buildBotDatabaseUrl({
      DB_NAME: "wageguard",
      DB_PORT: "5433",
      DB_USER: "admin",
      DB_PASSWORD: "admin-secret",
      BOT_USER: "wg_bot",
      BOT_NAME: "legacy_bot",
      BOT_PASSWORD: "bot:secret@value",
    });
    expect(url).toBe("postgresql://wg_bot:bot%3Asecret%40value@127.0.0.1:5433/wageguard");
    expect(url).not.toContain("admin");
    expect(url).not.toContain("legacy_bot");
  });

  it("기존 공유 DB 파일의 BOT_NAME도 호환한다", () => {
    expect(buildBotDatabaseUrl({
      DB_NAME: "wageguard",
      DB_PORT: "5433",
      BOT_NAME: "legacy_bot",
      BOT_PASSWORD: "legacy-secret",
    })).toBe("postgresql://legacy_bot:legacy-secret@127.0.0.1:5433/wageguard");
  });

  it("관리자 DATABASE_URL이 함께 있어도 BOT_DATABASE_URL을 우선한다", () => {
    vi.stubEnv("DATABASE_URL", "postgresql://admin:admin-secret@127.0.0.1:5433/wageguard");
    vi.stubEnv("BOT_DATABASE_URL", "postgresql://wg_bot:bot-secret@127.0.0.1:5433/wageguard");
    expect(getDatabaseConnectionString()).toBe(
      "postgresql://wg_bot:bot-secret@127.0.0.1:5433/wageguard",
    );
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
    let requestedAuthorization: string | undefined;
    const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestedAuthorization = new Headers(init?.headers).get("Authorization") ?? undefined;
      return new Response(JSON.stringify({
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
          as_of: "2026-09-21",
        },
      }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const result = await new HttpRagRetriever("http://rag.test", "rag-internal-token", 1_000, fakeFetch).retrieve("임금 지급일");
    expect(result.status).toBe("matched");
    expect(result).toMatchObject({
      retrieval_query: "임금 지급일 임금 지급 원칙",
      reason: null,
      top1_distance: 0.18,
    });
    expect(result.documents[0]).toMatchObject({
      citation: "근로기준법 제43조",
      source: { organization: "국가법령정보센터", as_of: "2026-09-21" },
    });
    expect(requestedAuthorization).toBe("Bearer rag-internal-token");
  });

  it("내부 토큰이 없으면 RAG 네트워크 호출 없이 unavailable로 닫힌다", async () => {
    const fakeFetch = vi.fn<typeof fetch>();
    const result = await new HttpRagRetriever("http://rag.test", "", 1_000, fakeFetch).retrieve("질문");
    expect(result).toMatchObject({ status: "unavailable", reason: "service_unavailable" });
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("범위 밖 이유와 주제를 보존한다", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({
      status: "no_match",
      query: "중대재해처벌법은 5인 미만에도 적용되나요?",
      reason: "out_of_scope",
      topic: "산업안전·중대재해",
      threshold: 0.42,
      top1_distance: 0.5,
      items: [],
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;

    const result = await new HttpRagRetriever("http://rag.test", "rag-internal-token", 1_000, fakeFetch).retrieve("중대재해처벌법은 5인 미만에도 적용되나요?");
    expect(result).toMatchObject({
      status: "no_match",
      reason: "out_of_scope",
      topic: "산업안전·중대재해",
    });
  });

  it("RAG 장애를 출처 없는 unavailable로 격리한다", async () => {
    const fakeFetch = (async () => {
      throw new TypeError("connection refused");
    }) as typeof fetch;
    const result = await new HttpRagRetriever("http://rag.test", "rag-internal-token", 1_000, fakeFetch).retrieve("질문");
    expect(result).toMatchObject({ status: "unavailable", documents: [] });
  });

  it("명시적인 no_match와 빈 목록만 근거 없음으로 신뢰한다", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({
      status: "no_match",
      query: "직접 근거 없는 질문",
      threshold: 0.42,
      items: [],
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    const result = await new HttpRagRetriever("http://rag.test", "rag-internal-token", 1_000, fakeFetch).retrieve("질문");
    expect(result).toMatchObject({
      query: "직접 근거 없는 질문",
      status: "no_match",
      threshold: 0.42,
      documents: [],
    });
  });

  it("matched인데 내용이나 인용이 없는 검색 항목은 malformed unavailable로 격리한다", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({
      status: "matched",
      items: [{ content: "", citation: "" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    const result = await new HttpRagRetriever("http://rag.test", "rag-internal-token", 1_000, fakeFetch).retrieve("질문");
    expect(result).toMatchObject({ query: "질문", status: "unavailable", threshold: null, documents: [] });
  });

  it.each([
    ["status 누락", { items: [] }],
    ["알 수 없는 status", { status: "partial", items: [] }],
    ["items 누락", { status: "no_match" }],
    ["상태와 문서 불일치", {
      status: "no_match",
      items: [{ content: "조문", citation: "근로기준법 제43조", source: { name: "근로기준법 제43조" } }],
    }],
    ["잘못된 threshold", { status: "no_match", threshold: "0.42", items: [] }],
  ])("HTTP 200이어도 %s payload는 unavailable로 처리한다", async (_label, payload) => {
    const fakeFetch = (async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
    const result = await new HttpRagRetriever("http://rag.test", "rag-internal-token", 1_000, fakeFetch).retrieve("질문");
    expect(result).toMatchObject({ query: "질문", status: "unavailable", threshold: null, documents: [] });
  });
});

describe("계약서 분석 내부 계약", () => {
  beforeEach(() => {
    vi.stubEnv("CONTRACT_INTERNAL_TOKEN", "contract-internal-token");
  });

  it("CSH 규칙 엔진 결과를 제품 DTO로 정규화한다", async () => {
    vi.stubEnv("CONTRACT_ANALYSIS_URL", "http://contract.test");
    let requestedUrl = "";
    let requestedBody: FormData | undefined;
    let requestedAuthorization: string | undefined;
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedBody = init?.body instanceof FormData ? init.body : undefined;
      requestedAuthorization = new Headers(init?.headers).get("Authorization") ?? undefined;
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
    expect(requestedAuthorization).toBe("Bearer contract-internal-token");
    expect(result.missing_items[0]).toMatchObject({
      code: "missing_required_wage",
      legal_basis: "근로기준법 제17조",
      extracted_text: "임금: 월 250만원",
    });
    expect(result.missing_items[0].description).toContain("임금 지급일을 서면으로 확인하세요.");
    expect(result.detected_items[0]).toMatchObject({ code: "working_hours" });
  });

  /*
   * 상류(contract-api) 문구에는 공급자 HTTP 오류 본문, requests 예외의 호스트·주소, 파일 경로,
   * 환경변수 이름이 섞여 온다. 사용자·상담 도구에는 허용목록의 고정 문구만 가고,
   * 원문은 정리해서 서버 로그에만 남는다.
   */
  describe("상류 오류 문구를 그대로 전달하지 않는다", () => {
    function upstream(status: number, body: unknown): typeof fetch {
      return (async () => new Response(
        typeof body === "string" ? body : JSON.stringify(body),
        { status, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    }

    async function reviewFailure(fakeFetch: typeof fetch): Promise<unknown> {
      vi.stubEnv("CONTRACT_ANALYSIS_URL", "http://contract.test");
      const file = new File(["pdf"], "contract.pdf", { type: "application/pdf" });
      try {
        await new RealContractReviewProvider(fakeFetch).review({ file });
      } catch (error) {
        return error;
      }
      throw new Error("계약서 분석이 실패해야 합니다.");
    }

    function loggedEvents(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
      return spy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    }

    let errorSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      resetApiErrorLogForTests();
      errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    });
    afterEach(() => {
      errorSpy.mockRestore();
    });

    it("공급자 HTTP 오류 본문과 키 조각은 응답에 싣지 않고 정리해서 로그에만 남긴다", async () => {
      const raw = 'upstage HTTP 401: {"error":{"message":"Incorrect API key provided: up_live_0123456789abcdef","type":"invalid_request_error"}}';
      const error = await reviewFailure(upstream(502, { error: raw }));

      expect(error).toMatchObject({ code: "CONTRACT_ANALYSIS_FAILED", status: 502, retryable: true });
      const body = JSON.stringify(errorPayload(error).body);
      expect(body).toContain("계약서를 분석하지 못했습니다. 잠시 후 다시 시도해 주세요.");
      expect(body).not.toContain("HTTP 401");
      expect(body).not.toContain("upstage");
      expect(body).not.toContain("up_live");

      const events = loggedEvents(errorSpy);
      // errorPayload 는 같은 실패를 다시 남기지 않는다(한 줄만).
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ event: "contract_upstream_failed", http_status: 502 });
      expect(String(events[0].upstream)).toContain("upstage HTTP 401");
      expect(String(events[0].upstream)).not.toContain("up_live_0123456789abcdef");
    });

    it("파일 경로가 든 OSError 문구도 응답에 싣지 않는다", async () => {
      const error = await reviewFailure(upstream(400, {
        error: "파일을 읽지 못했습니다: [Errno 2] No such file or directory: '/srv/moneyworry/contract/cache/abc.json'",
      }));

      expect(error).toMatchObject({ code: "CONTRACT_ANALYSIS_FAILED", status: 502 });
      expect(JSON.stringify(errorPayload(error).body)).not.toContain("/srv");
    });

    it("requests 예외의 상류 호스트·주소는 응답에 싣지 않는다", async () => {
      const error = await reviewFailure(upstream(400, {
        error: "Document Parse 연결 실패: HTTPSConnectionPool(host='api.upstage.ai', port=443): Read timed out. (read timeout=120)",
      }));

      expect(error).toMatchObject({ code: "CONTRACT_ANALYSIS_FAILED" });
      const body = JSON.stringify(errorPayload(error).body);
      expect(body).not.toContain("api.upstage.ai");
      expect(body).not.toContain("Document Parse");
    });

    it("설정 문제(503)는 환경변수·파일 이름 없이 일시 사용 불가로 안내한다", async () => {
      const error = await reviewFailure(upstream(503, {
        error: "문서 인식에 필요한 Upstage API 키가 없습니다. /etc/moneyworry/team.env를 확인하세요.",
      }));

      expect(error).toMatchObject({ code: "CONTRACT_PROVIDER_UNAVAILABLE", status: 503, retryable: true });
      const message = (error as Error).message;
      expect(message).toBe("계약서 분석 서비스를 지금 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.");
      expect(message).not.toContain("Upstage");
      expect(message).not.toContain("team.env");
    });

    it.each([
      ["문서에서 글자를 찾지 못했습니다. 빈 페이지이거나 해상도가 너무 낮을 수 있습니다.", "CONTRACT_TEXT_NOT_FOUND", 422, "문서에서 글자를 찾지 못했습니다. 빈 페이지이거나 해상도가 너무 낮을 수 있습니다."],
      ["지원하지 않는 형식입니다: .txt. .docx, .hwp, .jpeg 중 하나로 올려 주세요.", "UNSUPPORTED_MEDIA_TYPE", 415, "PDF, PNG, JPG 파일만 업로드할 수 있습니다. 파일 확장자를 확인해 주세요."],
      ["빈 파일입니다.", "CONTRACT_FILE_EMPTY", 400, "빈 파일은 분석할 수 없습니다. 계약서 파일을 다시 선택해 주세요."],
      ["계약서 파일이 없습니다.", "CONTRACT_FILE_REQUIRED", 400, "계약서 파일을 받지 못했습니다. 파일을 다시 선택해 주세요."],
      ["파일이 너무 큽니다 (21.3MB). 20MB 이하로 올려 주세요.", "FILE_TOO_LARGE", 413, "파일은 15MB 이하만 업로드할 수 있습니다."],
    ])("알려진 입력 오류 '%s'는 제품의 고정 안내로 바꾼다", async (raw, code, status, message) => {
      const error = await reviewFailure(upstream(400, { error: raw }));

      expect(error).toMatchObject({ code, status, retryable: false, message });
    });

    it("JSON 이 아닌 빈 응답도 일반 안내로 바꾸고 원문 없음으로 기록한다", async () => {
      const error = await reviewFailure(upstream(502, ""));

      expect(error).toMatchObject({ code: "CONTRACT_ANALYSIS_FAILED", status: 502 });
      expect(loggedEvents(errorSpy)[0]).toMatchObject({ event: "contract_upstream_failed", upstream: null });
    });

    it("로그에 남기는 상류 원문은 200자로 자른다", async () => {
      await reviewFailure(upstream(502, { error: `skt HTTP 500: ${"가".repeat(1_000)}` }));

      const logged = String(loggedEvents(errorSpy)[0].upstream);
      expect(logged.length).toBeLessThanOrEqual(200);
      expect(logged.startsWith("skt HTTP 500:")).toBe(true);
    });
  });

  it("근로계약서가 아닌 문서는 명시적인 사용자 오류로 구분하고 안내 문구를 유지한다", async () => {
    vi.stubEnv("CONTRACT_ANALYSIS_URL", "http://contract.test");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fakeFetch = (async () => new Response(JSON.stringify({
      ok: false,
      reason: "not_a_contract",
      message: "올려주신 문서에서 근로계약서로 볼 만한 내용을 찾지 못했습니다. 근로계약서 원본(사진·스캔본도 가능)을 올려 주세요.",
    }), { status: 422, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    const file = new File(["image"], "not-contract.png", { type: "image/png" });

    await expect(new RealContractReviewProvider(fakeFetch).review({ file })).rejects.toMatchObject({
      code: "NOT_A_CONTRACT",
      status: 422,
      retryable: true,
      message: "올려주신 문서에서 근로계약서로 볼 만한 내용을 찾지 못했습니다. 근로계약서 원본(사진·스캔본도 가능)을 올려 주세요.",
    });
    // 다른 문서를 올린 것은 장애가 아니라 로그를 남기지 않는다.
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it.each([
    ["verdict 누락", {
      ok: true,
      review_id: "review-1",
      filename: "contract.pdf",
    }],
    ["findings 누락", {
      ok: true,
      review_id: "review-1",
      filename: "contract.pdf",
      verdict: { headline: "확인 결과" },
    }],
    ["알 수 없는 finding level", {
      ok: true,
      review_id: "review-1",
      filename: "contract.pdf",
      verdict: {
        headline: "확인 결과",
        findings: [{ code: "wage", level: "critical", title: "임금", message: "확인" }],
      },
    }],
    ["finding 필수 필드 누락", {
      ok: true,
      review_id: "review-1",
      filename: "contract.pdf",
      verdict: {
        headline: "확인 결과",
        findings: [{ code: "wage", level: "check", title: "임금" }],
      },
    }],
  ])("HTTP 200 성공 응답의 %s을 공급자 schema 오류로 차단한다", async (_label, payload) => {
    vi.stubEnv("CONTRACT_ANALYSIS_URL", "http://contract.test");
    const fakeFetch = (async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
    const file = new File(["pdf"], "contract.pdf", { type: "application/pdf" });

    await expect(new RealContractReviewProvider(fakeFetch).review({ file })).rejects.toMatchObject({
      code: "CONTRACT_ANALYSIS_INVALID_RESPONSE",
      status: 502,
      retryable: true,
    });
  });

  it("판정 가능한 항목이 없는 정상 계약 분석은 빈 결과로 보존한다", async () => {
    vi.stubEnv("CONTRACT_ANALYSIS_URL", "http://contract.test");
    const fakeFetch = (async () => new Response(JSON.stringify({
      ok: true,
      review_id: "review-empty",
      filename: "contract.pdf",
      verdict: {
        headline: "계약서에서 판정할 수 있는 항목을 찾지 못했습니다.",
        findings: [],
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    const file = new File(["pdf"], "contract.pdf", { type: "application/pdf" });

    const result = await new RealContractReviewProvider(fakeFetch).review({ file });

    expect(result).toMatchObject({
      analysis_status: "completed",
      review_id: "review-empty",
      detected_items: [],
      missing_items: [],
      review_items: [],
      warnings: ["계약서에서 판정할 수 있는 항목을 찾지 못했습니다."],
    });
  });
});
