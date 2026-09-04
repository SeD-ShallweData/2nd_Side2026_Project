import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const db = vi.hoisted(() => ({
  queryWrite: vi.fn(),
  transactionQuery: vi.fn(),
  configured: vi.fn(() => true),
}));

vi.mock("@/server/postgresWrite", () => ({
  isDatabaseError: (error: unknown) => {
    if (!(error instanceof Error)) return false;
    const code = (error as Error & { code?: unknown }).code;
    return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code);
  },
  isWriteDatabaseConfigured: db.configured,
  queryWrite: db.queryWrite,
  withWriteTransaction: async (
    _role: string,
    run: (transaction: { query: typeof db.transactionQuery }) => Promise<unknown>,
  ) => run({ query: db.transactionQuery }),
}));

import { RealCommunityRepository } from "@/adapters/real/RealCommunityRepository";

const repository = new RealCommunityRepository();
const POST_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REPORT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function postRow(overrides: Record<string, unknown> = {}) {
  return {
    post_id: POST_ID,
    author_id: USER_ID,
    author_display_name: "김근로",
    category: "wage",
    title: "제목",
    body: "본문",
    firm_id: null,
    sido: null,
    industry: null,
    anonymous: false,
    created_at: new Date("2026-09-01T00:00:00.000Z"),
    updated_at: new Date("2026-09-01T00:00:00.000Z"),
    status: "published",
    comment_count: 3,
    ...overrides,
  };
}

function reportRow(overrides: Record<string, unknown> = {}) {
  return {
    report_id: REPORT_ID,
    post_id: POST_ID,
    reporter_id: USER_ID,
    reason: "spam",
    detail: null,
    status: "pending",
    created_at: new Date("2026-09-01T00:00:00.000Z"),
    reviewed_at: null,
    reviewed_by: null,
    resolution_note: null,
    snapshot_title: "신고 당시 제목",
    snapshot_body: "신고 당시 본문",
    snapshot_post_updated_at: new Date("2026-09-01T00:00:00.000Z"),
    ...overrides,
  };
}

afterEach(() => {
  db.queryWrite.mockReset();
  db.transactionQuery.mockReset();
  db.configured.mockReturnValue(true);
});

describe("설정 확인", () => {
  it("접속 정보가 없으면 503으로 알린다", () => {
    db.configured.mockReturnValue(false);
    expect(() => repository.assertAvailable()).toThrowError(
      expect.objectContaining({ code: "COMMUNITY_DATABASE_NOT_CONFIGURED", status: 503 }),
    );
  });

  it("데이터 출처를 database 로 알린다", () => {
    expect(repository.source).toBe("database");
  });
});

describe("사용자 입력으로 들어온 식별값", () => {
  /*
   * 게시글 주소는 사용자가 아무 값이나 넣을 수 있다. UUID 가 아닌 값을 그대로
   * 넘기면 PostgreSQL 이 형 변환 오류를 내고, 사용자는 "없음(404)" 대신
   * "서버 오류(503)"를 보게 된다.
   */
  it.each(["not-a-uuid", "", "1; DROP TABLE posts", "../../etc/passwd"])(
    "UUID 가 아닌 값(%s)은 DB 를 조회하지 않고 없음으로 처리한다",
    async (value) => {
      await expect(repository.findPostById(value)).resolves.toBeNull();
      await expect(repository.findReportById(value)).resolves.toBeNull();
      expect(db.queryWrite).not.toHaveBeenCalled();
    },
  );

  it("UUID 가 섞인 목록에서는 올바른 값만 조회한다", async () => {
    db.queryWrite.mockResolvedValueOnce([]);

    await repository.findPostsByIds([POST_ID, "garbage"]);

    expect(db.queryWrite.mock.calls[0]?.[2]).toEqual([[POST_ID]]);
  });

  it("UUID 가 하나도 없으면 조회하지 않는다", async () => {
    await expect(repository.findPostsByIds(["a", "b"])).resolves.toEqual(new Map());
    expect(db.queryWrite).not.toHaveBeenCalled();
  });
});

describe("게시글 읽기", () => {
  it("작성자 이름을 v_posts 에서 가져온다", async () => {
    db.queryWrite.mockResolvedValueOnce([postRow()]);

    const post = await repository.findPostById(POST_ID);

    expect(post?.author_display_name).toBe("김근로");
    const sql = String(db.queryWrite.mock.calls[0]?.[1]);
    expect(sql).toContain("v_posts");
    // wg_community 는 users 에 접근할 수 없다.
    expect(sql).not.toMatch(/\busers\b/);
  });

  it("사업장 정보를 firms 에서 붙인다", async () => {
    db.queryWrite.mockResolvedValueOnce([
      postRow({ firm_id: "f0000000000000a2", sido: "경기", industry: "건설업" }),
    ]);

    const post = await repository.findPostById(POST_ID);

    expect(post?.company_context).toEqual({
      company_id: "f0000000000000a2",
      region: "경기",
      industry: "건설업",
    });
  });

  /* 좋아요 테이블이 없다. 0 으로 지어내면 아무도 누르지 않은 것처럼 보인다. */
  it("좋아요는 값을 지어내지 않고 없음으로 표시한다", async () => {
    db.queryWrite.mockResolvedValueOnce([postRow()]);
    const post = await repository.findPostById(POST_ID);

    expect(post?.like_count).toBeNull();
    expect(post?.comment_count).toBe(3);
  });

  it("목록은 공개 상태 글만 가져온다", async () => {
    db.queryWrite.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total_count: "0" }]);

    await repository.listPublishedPosts({ query: "", category: null, limit: 10, page: 1 });

    expect(String(db.queryWrite.mock.calls[0]?.[1])).toContain("p.status = 'published'");
  });

  /*
   * 전체 건수를 목록 쿼리에서 함께 세면 마지막 페이지에서 값이 어긋난다.
   */
  it("전체 건수를 목록과 따로 센다", async () => {
    db.queryWrite
      .mockResolvedValueOnce([postRow()])
      .mockResolvedValueOnce([{ total_count: "42" }]);

    const page = await repository.listPublishedPosts({
      query: "", category: null, limit: 10, page: 3,
    });

    expect(page.total).toBe(42);
    expect(page.items).toHaveLength(1);
    expect(db.queryWrite.mock.calls[0]?.[2]).toEqual([null, "", 10, 20]);
  });

  /* %와 _는 ILIKE 의 와일드카드다. 검색어의 이 문자는 글자 그대로 찾아야 한다. */
  it("검색어의 와일드카드 문자를 글자 그대로 찾는다", async () => {
    db.queryWrite.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total_count: "0" }]);

    await repository.listPublishedPosts({
      query: "100%_확인", category: null, limit: 10, page: 1,
    });

    expect(db.queryWrite.mock.calls[0]?.[2]?.[1]).toBe("100\\%\\_확인");
    expect(String(db.queryWrite.mock.calls[0]?.[1])).toContain("ESCAPE");
  });
});

describe("게시글 쓰기", () => {
  it("공개 상태로 저장하고 사업장 식별값을 함께 넣는다", async () => {
    db.queryWrite.mockResolvedValueOnce([
      {
        id: POST_ID,
        created_at: new Date("2026-09-01T00:00:00.000Z"),
        updated_at: new Date("2026-09-01T00:00:00.000Z"),
        status: "published",
      },
    ]);

    const created = await repository.insertPost({
      author_id: USER_ID,
      author_display_name: "김근로",
      category: "wage",
      title: "제목",
      body: "본문",
      company_context: { company_id: "f1", region: "경기", industry: "건설업" },
      anonymous: true,
    });

    expect(created.status).toBe("published");
    expect(created.like_count).toBeNull();
    expect(db.queryWrite.mock.calls[0]?.[2]).toContain("f1");
  });

  /*
   * 사업장 연결을 없애는 것(null)과 건드리지 않는 것을 구분해야 한다.
   * 구분하지 않으면 제목만 고쳤는데 사업장 연결이 함께 지워진다.
   */
  it("넘어오지 않은 항목은 건드리지 않는다", async () => {
    db.queryWrite
      .mockResolvedValueOnce([{ id: POST_ID }])
      .mockResolvedValueOnce([postRow({ title: "새 제목" })]);

    await repository.updatePost(POST_ID, { title: "새 제목" });

    const values = db.queryWrite.mock.calls[0]?.[2] as unknown[];
    // [postId, category적용?, category, title적용?, title, ...]
    expect(values[1]).toBe(false);
    expect(values[3]).toBe(true);
    expect(values[4]).toBe("새 제목");
    expect(values[9]).toBe(false);
  });

  it("삭제는 삭제 시각을, 숨김은 숨김 시각을 남긴다", async () => {
    db.queryWrite
      .mockResolvedValueOnce([{ id: POST_ID }])
      .mockResolvedValueOnce([postRow({ status: "deleted" })]);

    await repository.setPostStatus(POST_ID, "deleted");

    const sql = String(db.queryWrite.mock.calls[0]?.[1]);
    expect(sql).toContain("deleted_at");
    expect(sql).toContain("hidden_at");
  });
});

describe("신고", () => {
  it("신고 시점의 글 내용을 함께 저장한다", async () => {
    db.queryWrite.mockResolvedValueOnce([reportRow()]);

    const created = await repository.insertReport({
      post_id: POST_ID,
      reporter_id: USER_ID,
      reason: "spam",
      detail: null,
      post_snapshot: {
        title: "신고 당시 제목",
        body: "신고 당시 본문",
        updated_at: "2026-09-01T00:00:00.000Z",
      },
    });

    expect(created.post_snapshot.title).toBe("신고 당시 제목");
    const values = db.queryWrite.mock.calls[0]?.[2] as unknown[];
    expect(values).toContain("신고 당시 제목");
  });

  /*
   * 두 요청이 동시에 들어오면 앞선 중복 확인을 둘 다 통과할 수 있다.
   * 그때 503 이 아니라 같은 안내가 나가야 한다.
   */
  it("동시 신고로 유니크 제약에 걸리면 중복 신고로 안내한다", async () => {
    db.queryWrite.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "23505" }));

    await expect(
      repository.insertReport({
        post_id: POST_ID,
        reporter_id: USER_ID,
        reason: "spam",
        detail: null,
        post_snapshot: { title: "t", body: "b", updated_at: "2026-09-01T00:00:00.000Z" },
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE_REPORT", status: 409 });
  });
});

describe("신고 검토", () => {
  /*
   * 신고만 승인되고 글이 그대로 남으면, 관리자는 처리했다고 보는데
   * 신고된 글은 계속 노출된다.
   */
  it("신고 상태 변경과 게시글 숨김을 한 트랜잭션으로 처리한다", async () => {
    db.transactionQuery
      .mockResolvedValueOnce([reportRow({ status: "accepted" })])
      .mockResolvedValueOnce([]);

    await repository.reviewReport(REPORT_ID, {
      status: "accepted",
      reviewed_by: USER_ID,
      resolution_note: null,
      hide_post: true,
    });

    const statements = db.transactionQuery.mock.calls.map((call) => String(call[0]));
    expect(statements[0]).toContain("UPDATE reports");
    expect(statements[1]).toContain("UPDATE posts");
    expect(statements[1]).toContain("hidden_by");
  });

  it("기각하면 게시글은 건드리지 않는다", async () => {
    db.transactionQuery.mockResolvedValueOnce([reportRow({ status: "dismissed" })]);

    await repository.reviewReport(REPORT_ID, {
      status: "dismissed",
      reviewed_by: USER_ID,
      resolution_note: "근거 부족",
      hide_post: false,
    });

    expect(db.transactionQuery).toHaveBeenCalledTimes(1);
  });

  /* 같은 신고를 두 번 승인하거나 이미 삭제된 글을 숨김으로 되살리지 않는다. */
  it("대기중 신고와 공개 상태 글에만 적용한다", async () => {
    db.transactionQuery
      .mockResolvedValueOnce([reportRow({ status: "accepted" })])
      .mockResolvedValueOnce([]);

    await repository.reviewReport(REPORT_ID, {
      status: "accepted",
      reviewed_by: USER_ID,
      resolution_note: null,
      hide_post: true,
    });

    expect(String(db.transactionQuery.mock.calls[0]?.[0])).toContain("status = 'pending'");
    expect(String(db.transactionQuery.mock.calls[1]?.[0])).toContain("status = 'published'");
  });

  it("검토 대상이 없으면 404 로 알린다", async () => {
    db.transactionQuery.mockResolvedValueOnce([]);

    await expect(
      repository.reviewReport(REPORT_ID, {
        status: "accepted",
        reviewed_by: USER_ID,
        resolution_note: null,
        hide_post: true,
      }),
    ).rejects.toMatchObject({ code: "COMMUNITY_REPORT_NOT_FOUND", status: 404 });
  });
});
