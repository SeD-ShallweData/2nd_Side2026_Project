import { describe, expect, it, vi } from "vitest";
import type { CommunityModerationReportDto, CommunityModerationReportListResponse } from "@/app/api/community/communityApiContract";
import {
  ModerationApiError,
  listModerationReports,
  reviewModerationReport,
} from "@/services/communityModerationClient";

const REPORT: CommunityModerationReportDto = {
  report_id: "report_mock_001",
  post_id: "post_mock_001",
  status: "pending",
  created_at: "2026-01-01T00:00:00.000Z",
  reviewed_at: null,
  reason: "misinformation",
  detail: "내용 검토가 필요합니다.",
  resolution_note: null,
  post: { title: "신고 뒤 수정된 현재 제목", status: "published" },
  post_snapshot: {
    title: "면접에서 임금 지급일은 어떻게 물어보면 좋을까요?",
    body: "신고 당시 본문 스냅샷입니다.",
    updated_at: "2025-12-31T00:00:00.000Z",
  },
};

const REPORT_LIST: CommunityModerationReportListResponse = {
  source: "mock_memory",
  capabilities: { write: true, comments: false, reactions: false, reports: true, moderation: true },
  status: "pending",
  items: [REPORT],
  total: 1,
  has_more: false,
  page: 1,
  page_size: 10,
  total_pages: 1,
};

function createFetchMock(response: Response) {
  const fetchImpl = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
  fetchImpl.mockResolvedValue(response);
  return fetchImpl;
}

type FetchMock = ReturnType<typeof createFetchMock>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return jsonResponse(
    { error: { code, message, retryable: status >= 500, request_id: "req_test_0001", ...extra } },
    status,
  );
}

function readCall(fetchImpl: FetchMock, index = 0): { path: string; init: RequestInit } {
  const call = fetchImpl.mock.calls[index];
  if (!call) throw new Error("fetch가 호출되지 않았습니다.");
  return { path: String(call[0]), init: call[1] ?? {} };
}

function readSearchParams(path: string): URLSearchParams {
  return new URL(path, "http://localhost").searchParams;
}

function readJsonBody(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("오류가 발생하지 않았습니다.");
    },
    (caught: unknown) => caught,
  );
}

describe("신고 목록 조회", () => {
  it("목록 응답 envelope를 그대로 반환한다", async () => {
    const fetchImpl = createFetchMock(jsonResponse(REPORT_LIST));

    const result = await listModerationReports({ status: "pending" }, { fetchImpl });

    expect(result).toEqual(REPORT_LIST);
    expect(result.items[0]?.post_snapshot).toEqual(REPORT.post_snapshot);

    const { path, init } = readCall(fetchImpl);
    expect(path.startsWith("/api/community/moderation/reports")).toBe(true);
    expect(init.method).toBe("GET");
  });

  it("status/page/limit이 query로 전달된다", async () => {
    const fetchImpl = createFetchMock(jsonResponse(REPORT_LIST));

    await listModerationReports({ status: "accepted", page: 2, limit: 5 }, { fetchImpl });

    const { path } = readCall(fetchImpl);
    const params = readSearchParams(path);
    expect(params.get("status")).toBe("accepted");
    expect(params.get("page")).toBe("2");
    expect(params.get("limit")).toBe("5");
  });

  it("status를 지정하지 않으면 query에 status를 담지 않는다", async () => {
    const fetchImpl = createFetchMock(jsonResponse(REPORT_LIST));

    await listModerationReports({}, { fetchImpl });

    const { path } = readCall(fetchImpl);
    expect(readSearchParams(path).has("status")).toBe(false);
  });

  it("403 FORBIDDEN은 ModerationApiError로 던진다", async () => {
    const fetchImpl = createFetchMock(errorResponse(403, "FORBIDDEN", "이 기능을 사용할 권한이 없습니다."));

    const caught = await captureError(listModerationReports({}, { fetchImpl }));

    expect(caught).toBeInstanceOf(ModerationApiError);
    expect(caught).toMatchObject({ status: 403, code: "FORBIDDEN", retryable: false });
  });

  it("5xx는 retryable로 던진다", async () => {
    const fetchImpl = createFetchMock(
      errorResponse(503, "COMMUNITY_PROVIDER_UNAVAILABLE", "커뮤니티 저장소가 아직 연결되지 않았습니다."),
    );

    const caught = await captureError(listModerationReports({}, { fetchImpl }));

    expect(caught).toBeInstanceOf(ModerationApiError);
    expect(caught).toMatchObject({ status: 503, retryable: true });
  });

  it("네트워크 실패는 그대로 던져 호출부가 구분할 수 있게 한다", async () => {
    const fetchImpl = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
    fetchImpl.mockRejectedValue(new TypeError("network error"));

    const caught = await captureError(listModerationReports({}, { fetchImpl }));

    expect(caught).toBeInstanceOf(TypeError);
  });
});

describe("신고 승인/기각", () => {
  it("승인 요청은 decision=accept로 보낸다", async () => {
    const accepted: CommunityModerationReportDto = {
      ...REPORT,
      status: "accepted",
      reviewed_at: "2026-01-02T00:00:00.000Z",
      post: { title: REPORT.post.title, status: "hidden" },
    };
    const fetchImpl = createFetchMock(jsonResponse(accepted));

    const result = await reviewModerationReport(REPORT.report_id, { decision: "accept" }, { fetchImpl });

    expect(result.status).toBe("accepted");
    expect(result.post.status).toBe("hidden");

    const { path, init } = readCall(fetchImpl);
    expect(path).toBe(`/api/community/moderation/reports/${REPORT.report_id}`);
    expect(init.method).toBe("PATCH");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(readJsonBody(init)).toEqual({ decision: "accept" });
  });

  it("기각 요청은 decision=dismiss로 보낸다", async () => {
    const dismissed: CommunityModerationReportDto = { ...REPORT, status: "dismissed" };
    const fetchImpl = createFetchMock(jsonResponse(dismissed));

    await reviewModerationReport(REPORT.report_id, { decision: "dismiss" }, { fetchImpl });

    expect(readJsonBody(readCall(fetchImpl).init)).toEqual({ decision: "dismiss" });
  });

  it("resolution_note를 함께 보낼 수 있다", async () => {
    const fetchImpl = createFetchMock(jsonResponse({ ...REPORT, status: "accepted" }));

    await reviewModerationReport(
      REPORT.report_id,
      { decision: "accept", resolution_note: "공개 목록에서 숨김 처리" },
      { fetchImpl },
    );

    expect(readJsonBody(readCall(fetchImpl).init)).toEqual({
      decision: "accept",
      resolution_note: "공개 목록에서 숨김 처리",
    });
  });

  it("404 COMMUNITY_REPORT_NOT_FOUND를 던진다", async () => {
    const fetchImpl = createFetchMock(
      errorResponse(404, "COMMUNITY_REPORT_NOT_FOUND", "신고 내역을 찾을 수 없습니다."),
    );

    const caught = await captureError(
      reviewModerationReport("missing", { decision: "accept" }, { fetchImpl }),
    );

    expect(caught).toBeInstanceOf(ModerationApiError);
    expect(caught).toMatchObject({ status: 404, code: "COMMUNITY_REPORT_NOT_FOUND" });
  });

  it("409 COMMUNITY_REPORT_ALREADY_REVIEWED를 던진다", async () => {
    const fetchImpl = createFetchMock(
      errorResponse(409, "COMMUNITY_REPORT_ALREADY_REVIEWED", "이미 검토가 끝난 신고입니다."),
    );

    const caught = await captureError(
      reviewModerationReport(REPORT.report_id, { decision: "dismiss" }, { fetchImpl }),
    );

    expect(caught).toBeInstanceOf(ModerationApiError);
    expect(caught).toMatchObject({ status: 409, code: "COMMUNITY_REPORT_ALREADY_REVIEWED" });
  });
});
