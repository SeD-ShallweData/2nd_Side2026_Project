import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";

vi.mock("server-only", () => ({}));

import { POST_LANGUAGE_CASE, POST_LANGUAGE_JOIN } from "@/adapters/real/RealCommunityRepository";
import { detectPostLanguage } from "@/domain/textLanguage";
import { TEXT_LANGUAGE_SAMPLES } from "@/domain/textLanguage.samples";

/*
 * 선택 시험: 작성 언어 필터 SQL 이 화면 표시 규칙(domain/textLanguage)과 같은 답을 내는지
 * 실제 PostgreSQL 에서 확인한다. 버리는 로컬 DB 주소를 COMMUNITY_LANGUAGE_PG_URL 로 줄 때만 돈다.
 * 운영 DB 에 연결하지 않는다(임시 테이블만 쓴다).
 */
const url = process.env.COMMUNITY_LANGUAGE_PG_URL;
const run = url ? describe : describe.skip;

run("작성 언어 SQL 과 JS 규칙의 일치", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: url });
    await client.connect();
    await client.query("CREATE TEMP TABLE posts (title text NOT NULL, body text NOT NULL)");
  });

  afterAll(async () => {
    await client?.end();
  });

  it("시험 문장 전부에서 SQL 과 JS 가 같은 언어를 낸다", async () => {
    const samples = [
      ...TEXT_LANGUAGE_SAMPLES,
      { title: "Ạ ỹ", body: "ÀÖØöøɏḀỿ", expected: "vi" as const },
      { title: "ᄀ ᇿ ㄱ ㆎ", body: "가힣", expected: "ko" as const },
    ];
    for (const sample of samples) {
      await client.query("INSERT INTO posts (title, body) VALUES ($1, $2)", [sample.title, sample.body]);
    }
    const { rows } = await client.query<{ title: string; body: string; language: string }>(
      `SELECT p.title, p.body, ${POST_LANGUAGE_CASE} AS language FROM posts p ${POST_LANGUAGE_JOIN}`,
    );
    expect(rows).toHaveLength(samples.length);
    for (const row of rows) {
      expect(row.language, row.title).toBe(detectPostLanguage(row.title, row.body));
    }
  });
});
