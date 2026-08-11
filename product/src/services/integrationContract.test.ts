import { describe, expect, it } from "vitest";
import { HttpRagRetriever } from "@/adapters/real/HttpRagRetriever";
import { queryReadOnly } from "@/server/postgres";

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
