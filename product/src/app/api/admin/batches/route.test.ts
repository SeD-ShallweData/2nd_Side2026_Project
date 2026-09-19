import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  getOptionalSessionUser: vi.fn(),
  listBatchStatuses: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/services/authService", () => ({
  getOptionalSessionUser: state.getOptionalSessionUser,
}));
vi.mock("@/services/batchService", () => ({
  listBatchStatuses: state.listBatchStatuses,
}));

import { GET } from "@/app/api/admin/batches/route";

function request(token?: string): Request {
  const headers = new Headers();
  if (token) headers.set("cookie", `donworry_session=${token}`);
  return new Request("http://localhost/api/admin/batches", { headers });
}

describe("관리자 배치 현황 API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.getOptionalSessionUser.mockImplementation(async (token: string | null) => {
      if (!token) return null;
      return {
        user_id: `${token}-id`,
        email: `${token}@example.com`,
        display_name: token,
        role: token as "user" | "admin" | "inspector",
      };
    });
    state.listBatchStatuses.mockResolvedValue({
      selection_mode: "auto",
      current: null,
      batches: [],
      generated_at: "2026-09-17T00:00:00.000Z",
    });
  });

  it("로그인하지 않은 요청은 실제 테이블 조회 전에 차단한다", async () => {
    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(state.listBatchStatuses).not.toHaveBeenCalled();
  });

  it("일반 사용자 요청은 실제 테이블 조회 전에 차단한다", async () => {
    const response = await GET(request("user"));

    expect(response.status).toBe(403);
    expect(state.listBatchStatuses).not.toHaveBeenCalled();
  });

  it("근로감독관 요청은 새 운영 권한 정책에 따라 차단한다", async () => {
    const response = await GET(request("inspector"));

    expect(response.status).toBe(403);
    expect(state.listBatchStatuses).not.toHaveBeenCalled();
  });

  it("관리자 역할은 실제 배치 조회 결과를 받는다", async () => {
    const response = await GET(request("admin"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(state.listBatchStatuses).toHaveBeenCalledOnce();
    expect(await response.json()).toMatchObject({ selection_mode: "auto", batches: [] });
  });
});
