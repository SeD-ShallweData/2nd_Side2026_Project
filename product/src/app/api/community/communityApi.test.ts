import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { SessionUserDto } from "@/app/api/auth/authApiContract";
import { GET as listReports } from "@/app/api/community/moderation/reports/route";
import { PATCH as reviewReport } from "@/app/api/community/moderation/reports/[reportId]/route";
import { GET as getPost, PATCH as updatePost, DELETE as deletePost } from "@/app/api/community/posts/[postId]/route";
import { POST as createReport } from "@/app/api/community/posts/[postId]/reports/route";
import { GET as listPosts, POST as createPost } from "@/app/api/community/posts/route";
import { MockAuthRepository, resetMockSessions } from "@/adapters/mock/MockAuthRepository";
import { resetMockCommunityState } from "@/adapters/mock/MockCommunityRepository";

const USER: SessionUserDto = {
  user_id: "10000000-0000-4000-8000-000000000001",
  email: "user@mock.donworry.local",
  display_name: "일반 사용자",
  role: "user",
};

const ADMIN: SessionUserDto = {
  user_id: "10000000-0000-4000-8000-000000000002",
  email: "admin@mock.donworry.local",
  display_name: "커뮤니티 관리자",
  role: "admin",
};

const INSPECTOR: SessionUserDto = {
  user_id: "10000000-0000-4000-8000-000000000003",
  email: "inspector@mock.donworry.local",
  display_name: "근로감독관",
  role: "inspector",
};

const authRepository = new MockAuthRepository();

async function cookieFor(user: SessionUserDto): Promise<string> {
  return `donworry_session=${(await authRepository.issueSession(user)).token}`;
}

function jsonMutation(
  url: string,
  method: "POST" | "PATCH" | "DELETE",
  body: unknown,
  cookie?: string,
  extraHeaders: HeadersInit = {},
): Request {
  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      origin: new URL(url).origin,
      ...(cookie ? { cookie } : {}),
      ...extraHeaders,
    },
    body: method === "DELETE" ? undefined : JSON.stringify(body),
  });
}

function contextFor<Key extends "postId" | "reportId">(
  key: Key,
  value: string,
): { params: Promise<Record<Key, string>> } {
  return { params: Promise.resolve({ [key]: value } as Record<Key, string>) };
}

beforeEach(() => {
  vi.stubEnv("COMMUNITY_DATA_MODE", "mock");
  vi.stubEnv("APP_DATA_MODE", "mock");
  resetMockSessions();
  resetMockCommunityState();
});

afterEach(() => {
  resetMockSessions();
  resetMockCommunityState();
  vi.unstubAllEnvs();
});

describe("커뮤니티 공개 조회 계약", () => {
  it("현재 UI의 네 개 Mock 게시물과 기능 상태를 익명 조회에 제공한다", async () => {
    const response = await listPosts(new Request("http://localhost/api/community/posts"));
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      source: "mock_memory",
      total: 4,
      capabilities: {
        write: false,
        comments: false,
        reactions: false,
        reports: false,
        moderation: false,
      },
    });
    expect(JSON.stringify(body)).not.toContain("author_id");
    expect(JSON.stringify(body)).not.toContain("@mock.donworry.local");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("검색·분류·페이지 입력을 적용하고 잘못된 페이지를 400으로 거부한다", async () => {
    const filtered = await listPosts(new Request(
      "http://localhost/api/community/posts?q=%EC%9E%84%EA%B8%88&category=pre_employment&page=1&limit=2",
    ));
    expect(await filtered.json()).toMatchObject({ total: 1, page: 1, page_size: 2 });

    const invalid = await listPosts(new Request("http://localhost/api/community/posts?page=0"));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });

  it("Real 모드 저장소 장애를 Mock 성공으로 바꾸지 않는다", async () => {
    vi.stubEnv("COMMUNITY_DATA_MODE", "real");
    const response = await listPosts(new Request("http://localhost/api/community/posts"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "COMMUNITY_PROVIDER_UNAVAILABLE", retryable: true },
    });
  });
});

describe("게시글 작성자 권한", () => {
  it("미인증 작성 요청을 401로 거부한다", async () => {
    const response = await createPost(jsonMutation(
      "http://localhost/api/community/posts",
      "POST",
      { category: "wage", title: "임금 기록 질문", body: "임금 기록은 어떤 자료를 남겨야 하나요?" },
    ));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "AUTHENTICATION_REQUIRED" } });
  });

  it("로그인 사용자가 글을 만들고 본인 글만 수정·삭제한다", async () => {
    const userCookie = await cookieFor(USER);
    const createdResponse = await createPost(jsonMutation(
      "http://localhost/api/community/posts",
      "POST",
      {
        category: "wage",
        title: "급여 명세서 보관 방법",
        body: "급여 명세서와 입금 내역을 함께 보관하는 방법이 궁금합니다.",
        company_id: "COMPANY_DEMO_001",
        anonymous: false,
      },
      userCookie,
    ));
    const created = await createdResponse.json() as { post_id: string; author_label: string | null };
    expect(createdResponse.status).toBe(201);
    expect(created.author_label).toBe("일반 사용자");
    expect(JSON.stringify(created)).not.toContain(USER.user_id);
    expect(JSON.stringify(created)).not.toContain(USER.email);

    const inspectorCookie = await cookieFor(INSPECTOR);
    const forbidden = await updatePost(
      jsonMutation(
        `http://localhost/api/community/posts/${created.post_id}`,
        "PATCH",
        { title: "타인이 바꾼 제목" },
        inspectorCookie,
      ),
      contextFor("postId", created.post_id),
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ error: { code: "RESOURCE_OWNERSHIP_REQUIRED" } });

    const updated = await updatePost(
      jsonMutation(
        `http://localhost/api/community/posts/${created.post_id}`,
        "PATCH",
        { title: "수정한 급여 명세서 보관 방법" },
        userCookie,
      ),
      contextFor("postId", created.post_id),
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      title: "수정한 급여 명세서 보관 방법",
      viewer_permissions: { can_edit: true, can_delete: true, can_report: false },
    });

    const deleted = await deletePost(
      jsonMutation(
        `http://localhost/api/community/posts/${created.post_id}`,
        "DELETE",
        null,
        userCookie,
      ),
      contextFor("postId", created.post_id),
    );
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true, post_id: created.post_id });

    const missing = await getPost(
      new Request(`http://localhost/api/community/posts/${created.post_id}`),
      contextFor("postId", created.post_id),
    );
    expect(missing.status).toBe(404);
  });

  it("사업장 ID를 Mock 기준본으로 검증하고 표시용 지역·업종을 서버에서 보강한다", async () => {
    const userCookie = await cookieFor(USER);
    const created = await createPost(jsonMutation(
      "http://localhost/api/community/posts",
      "POST",
      {
        category: "workplace_safety",
        title: "사업장 연결 확인",
        body: "선택한 사업장의 지역과 업종이 서버 기준으로 표시되어야 합니다.",
        company_id: "COMPANY_DEMO_001",
      },
      userCookie,
    ));
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      company_context: {
        company_id: "COMPANY_DEMO_001",
        region: "인천광역시",
        industry: "건설업",
      },
    });

    const invalid = await createPost(jsonMutation(
      "http://localhost/api/community/posts",
      "POST",
      {
        category: "workplace_safety",
        title: "없는 사업장",
        body: "존재하지 않는 사업장 식별값은 연결할 수 없어야 합니다.",
        company_id: "NO_SUCH_COMPANY",
      },
      userCookie,
    ));
    expect(invalid.status).toBe(404);
    expect(await invalid.json()).toMatchObject({ error: { code: "COMPANY_NOT_FOUND" } });
  });

  it("다른 출처의 쓰기 요청을 게시글 저장 전에 차단한다", async () => {
    const response = await createPost(jsonMutation(
      "http://localhost/api/community/posts",
      "POST",
      { category: "wage", title: "차단 대상", body: "저장되면 안 되는 다른 출처의 요청입니다." },
      await cookieFor(USER),
      { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
    ));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "CROSS_SITE_REQUEST_REJECTED" } });
  });
});

describe("신고와 관리자 검토 권한", () => {
  it("본인 신고와 중복 신고를 409로 구분한다", async () => {
    const selfReport = await createReport(
      jsonMutation(
        "http://localhost/api/community/posts/post_mock_001/reports",
        "POST",
        { reason: "other", detail: "본인 신고는 허용되지 않아야 합니다." },
        await cookieFor(USER),
      ),
      contextFor("postId", "post_mock_001"),
    );
    expect(selfReport.status).toBe(409);
    expect(await selfReport.json()).toMatchObject({ error: { code: "SELF_REPORT_NOT_ALLOWED" } });

    const inspectorCookie = await cookieFor(INSPECTOR);
    const first = await createReport(
      jsonMutation(
        "http://localhost/api/community/posts/post_mock_001/reports",
        "POST",
        { reason: "privacy", detail: "개인정보 노출 여부를 확인해 주세요." },
        inspectorCookie,
      ),
      contextFor("postId", "post_mock_001"),
    );
    expect(first.status).toBe(201);

    const duplicate = await createReport(
      jsonMutation(
        "http://localhost/api/community/posts/post_mock_001/reports",
        "POST",
        { reason: "privacy", detail: "같은 사용자의 중복 신고입니다." },
        inspectorCookie,
      ),
      contextFor("postId", "post_mock_001"),
    );
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: { code: "DUPLICATE_REPORT" } });
  });

  it("관리자만 신고 목록을 보고 승인된 게시글을 숨긴다", async () => {
    const reportResponse = await createReport(
      jsonMutation(
        "http://localhost/api/community/posts/post_mock_001/reports",
        "POST",
        { reason: "misinformation", detail: "내용 검토가 필요합니다." },
        await cookieFor(INSPECTOR),
      ),
      contextFor("postId", "post_mock_001"),
    );
    const report = await reportResponse.json() as { report_id: string };

    const changedAfterReport = await updatePost(
      jsonMutation(
        "http://localhost/api/community/posts/post_mock_001",
        "PATCH",
        { title: "신고 뒤 수정된 현재 제목" },
        await cookieFor(USER),
      ),
      contextFor("postId", "post_mock_001"),
    );
    expect(changedAfterReport.status).toBe(200);

    const forbidden = await listReports(new Request(
      "http://localhost/api/community/moderation/reports",
      { headers: { cookie: await cookieFor(USER) } },
    ));
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ error: { code: "FORBIDDEN" } });

    const adminCookie = await cookieFor(ADMIN);
    const pending = await listReports(new Request(
      "http://localhost/api/community/moderation/reports?status=pending",
      { headers: { cookie: adminCookie } },
    ));
    expect(pending.status).toBe(200);
    expect(await pending.json()).toMatchObject({
      total: 1,
      items: [{
        report_id: report.report_id,
        post: { title: "신고 뒤 수정된 현재 제목" },
        post_snapshot: { title: "면접에서 임금 지급일은 어떻게 물어보면 좋을까요?" },
      }],
    });

    const unfiltered = await listReports(new Request(
      "http://localhost/api/community/moderation/reports?status=",
      { headers: { cookie: adminCookie } },
    ));
    expect(await unfiltered.json()).toMatchObject({ status: null, total: 1 });

    const reviewed = await reviewReport(
      jsonMutation(
        `http://localhost/api/community/moderation/reports/${report.report_id}`,
        "PATCH",
        { decision: "accept", resolution_note: "공개 목록에서 숨김 처리" },
        adminCookie,
      ),
      contextFor("reportId", report.report_id),
    );
    expect(reviewed.status).toBe(200);
    expect(await reviewed.json()).toMatchObject({
      status: "accepted",
      post: { status: "hidden" },
    });

    const anonymousView = await getPost(
      new Request("http://localhost/api/community/posts/post_mock_001"),
      contextFor("postId", "post_mock_001"),
    );
    expect(anonymousView.status).toBe(404);

    const ownerView = await getPost(
      new Request("http://localhost/api/community/posts/post_mock_001", {
        headers: { cookie: await cookieFor(USER) },
      }),
      contextFor("postId", "post_mock_001"),
    );
    expect(ownerView.status).toBe(200);
    expect(await ownerView.json()).toMatchObject({ status: "hidden" });

    const hiddenReport = await createReport(
      jsonMutation(
        "http://localhost/api/community/posts/post_mock_001/reports",
        "POST",
        { reason: "other", detail: "숨김 처리 뒤에는 새 신고를 받지 않아야 합니다." },
        adminCookie,
      ),
      contextFor("postId", "post_mock_001"),
    );
    expect(hiddenReport.status).toBe(409);
    expect(await hiddenReport.json()).toMatchObject({
      error: { code: "COMMUNITY_POST_NOT_REPORTABLE" },
    });
  });
});
