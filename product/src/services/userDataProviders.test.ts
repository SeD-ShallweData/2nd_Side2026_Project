import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { MockAuthRepository } from "@/adapters/mock/MockAuthRepository";
import { MockCommunityRepository } from "@/adapters/mock/MockCommunityRepository";
import { RealAuthRepository } from "@/adapters/real/RealAuthRepository";
import { getAuthRepository, getCommunityRepository } from "@/services/userDataProviders";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("사용자 데이터 저장소 선택", () => {
  it("mock 모드에서는 메모리 저장소를 쓴다", () => {
    vi.stubEnv("AUTH_DATA_MODE", "mock");
    vi.stubEnv("COMMUNITY_DATA_MODE", "mock");

    expect(getAuthRepository()).toBeInstanceOf(MockAuthRepository);
    expect(getCommunityRepository()).toBeInstanceOf(MockCommunityRepository);
  });

  it("기능별 설정이 없으면 전체 모드를 따라간다", () => {
    vi.stubEnv("APP_DATA_MODE", "mock");

    expect(getAuthRepository()).toBeInstanceOf(MockAuthRepository);
    expect(getCommunityRepository()).toBeInstanceOf(MockCommunityRepository);
  });

  it("인증은 실제 모드에서 실제 DB 저장소를 쓴다", () => {
    vi.stubEnv("AUTH_DATA_MODE", "real");
    expect(getAuthRepository()).toBeInstanceOf(RealAuthRepository);
  });

  /*
   * 커뮤니티는 아직 실제 DB 어댑터가 없다. Mock 으로 조용히 대체하면 사용자는
   * 글이 저장된 줄 알지만 서버가 재시작되는 순간 사라진다. 없는 것을 있는 척
   * 하지 않는다는 제품 원칙이 여기에도 적용된다.
   */
  it("커뮤니티는 어댑터가 없으므로 실제 모드에서 대체하지 않고 거부한다", () => {
    vi.stubEnv("COMMUNITY_DATA_MODE", "real");
    expect(() => getCommunityRepository()).toThrowError(
      expect.objectContaining({ code: "COMMUNITY_PROVIDER_UNAVAILABLE", status: 503 }),
    );
  });

  it("한쪽만 실제 모드여도 다른 쪽은 그대로 동작한다", () => {
    vi.stubEnv("AUTH_DATA_MODE", "mock");
    vi.stubEnv("COMMUNITY_DATA_MODE", "real");

    expect(getAuthRepository()).toBeInstanceOf(MockAuthRepository);
    expect(() => getCommunityRepository()).toThrow();
  });
});

describe("저장소 교체 가능성", () => {
  /*
   * 서비스 계층이 포트만 보고 동작하는지 확인한다.
   * 규칙(권한·상태 전이·검증)은 서비스에 있고 저장소에는 없어야 하므로,
   * 저장소를 통째로 바꿔 끼워도 서비스는 같은 방식으로 동작해야 한다.
   */
  it("커뮤니티 저장소는 포트가 요구하는 동작을 모두 제공한다", () => {
    const repository = new MockCommunityRepository();
    const required = [
      "listPublishedPosts",
      "findPostById",
      "findPostsByIds",
      "insertPost",
      "updatePost",
      "setPostStatus",
      "findExistingReport",
      "insertReport",
      "listReports",
      "findReportById",
      "reviewReport",
      "findCompanyContext",
      "assertAvailable",
    ] as const;

    for (const method of required) {
      expect(typeof repository[method]).toBe("function");
    }
    expect(repository.source).toBe("mock_memory");
  });

  it("인증 저장소는 포트가 요구하는 동작을 모두 제공한다", () => {
    const repository = new MockAuthRepository();
    for (const method of ["assertAvailable", "authenticate", "issueSession", "resolveSession", "revokeSession"] as const) {
      expect(typeof repository[method]).toBe("function");
    }
  });

  /*
   * 신고 승인은 "신고 상태 변경"과 "게시글 숨김"이 함께 일어나야 한다.
   * 이 둘을 서비스에서 두 번 호출하면 실제 DB 에서 한쪽만 반영될 수 있으므로,
   * 포트에 하나의 동작으로 묶여 있어야 한다.
   */
  it("신고 승인은 게시글 숨김까지 한 동작으로 처리한다", async () => {
    const repository = new MockCommunityRepository();
    const post = await repository.insertPost({
      author_id: "author-1",
      author_display_name: "작성자",
      category: "wage",
      title: "제목",
      body: "본문",
      company_context: null,
      anonymous: true,
    });
    const report = await repository.insertReport({
      post_id: post.post_id,
      reporter_id: "reporter-1",
      reason: "spam",
      detail: null,
      post_snapshot: { title: post.title, body: post.body, updated_at: post.updated_at },
    });

    const reviewed = await repository.reviewReport(report.report_id, {
      status: "accepted",
      reviewed_by: "admin-1",
      resolution_note: null,
      hide_post: true,
    });

    expect(reviewed.status).toBe("accepted");
    expect((await repository.findPostById(post.post_id))?.status).toBe("hidden");
  });

  /* 저장소가 내부 객체를 그대로 내주면 호출자가 저장된 값을 직접 바꿀 수 있다. */
  it("저장소가 돌려준 값을 바꿔도 저장된 내용은 그대로다", async () => {
    const repository = new MockCommunityRepository();
    const post = await repository.insertPost({
      author_id: "author-1",
      author_display_name: "작성자",
      category: "wage",
      title: "원래 제목",
      body: "본문",
      company_context: { company_id: "c1", region: "서울특별시", industry: "제조업" },
      anonymous: true,
    });

    post.title = "바뀐 제목";
    post.company_context!.region = "부산광역시";

    const stored = await repository.findPostById(post.post_id);
    expect(stored?.title).toBe("원래 제목");
    expect(stored?.company_context?.region).toBe("서울특별시");
  });
});
