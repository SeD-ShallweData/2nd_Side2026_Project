import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  usersByToken: new Map<string, { user_id: string; email: string; display_name: string; role: "user" | "admin" | "inspector" }>(),
  getOptionalSessionUser: vi.fn(async (token: string | null) => (
    token ? state.usersByToken.get(token) ?? null : null
  )),
  listBatchStatuses: vi.fn(async () => ({ domains: [] })),
  getMlDashboard: vi.fn(async () => ({ tab: "wage", rows: [] })),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/services/authService", () => ({ getOptionalSessionUser: state.getOptionalSessionUser }));
vi.mock("@/services/batchService", () => ({ listBatchStatuses: state.listBatchStatuses }));
vi.mock("@/services/mlDashboardService", () => ({ getMlDashboard: state.getMlDashboard }));

import { GET as batchesRoute } from "@/app/api/inspector/batches/route";
import { GET as mlDashboardRoute } from "@/app/api/inspector/ml-dashboard/route";

function get(path: string, token: string | null): Request {
  const headers = new Headers();
  if (token) headers.set("cookie", `donworry_session=${token}`);
  return new Request(`http://localhost${path}`, { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.usersByToken.clear();
  state.usersByToken.set("user-token", { user_id: "u1", email: "u@example.com", display_name: "사용자", role: "user" });
  state.usersByToken.set("inspector-token", { user_id: "u3", email: "i@example.com", display_name: "감독관", role: "inspector" });
  state.usersByToken.set("admin-token", { user_id: "u2", email: "a@example.com", display_name: "관리자", role: "admin" });
});

/* 배치 현황은 플랫폼 운영이라 운영 관리자만 본다. */
describe("GET /api/inspector/batches 권한", () => {
  it("비로그인은 401이고 배치를 조회하지 않는다", async () => {
    const response = await batchesRoute(get("/api/inspector/batches", null));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(state.listBatchStatuses).not.toHaveBeenCalled();
  });

  it.each([
    ["일반 사용자", "user-token"],
    ["근로감독관", "inspector-token"],
  ])("%s 는 403이고 배치를 조회하지 않는다", async (_label, token) => {
    const response = await batchesRoute(get("/api/inspector/batches", token));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(state.listBatchStatuses).not.toHaveBeenCalled();
  });

  it("운영 관리자에게는 배치 현황을 돌려준다", async () => {
    const response = await batchesRoute(get("/api/inspector/batches", "admin-token"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ domains: [], manageable: false });
    expect(state.listBatchStatuses).toHaveBeenCalledOnce();
  });
});

/* ML 대시보드 집계는 읽기 전용이라 근로감독관도 본다. */
describe("GET /api/inspector/ml-dashboard 권한", () => {
  it("비로그인은 401이고 집계를 조회하지 않는다", async () => {
    const response = await mlDashboardRoute(get("/api/inspector/ml-dashboard?tab=wage", null));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(state.getMlDashboard).not.toHaveBeenCalled();
  });

  it("일반 사용자는 403이고 집계를 조회하지 않는다", async () => {
    const response = await mlDashboardRoute(get("/api/inspector/ml-dashboard?tab=wage", "user-token"));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(state.getMlDashboard).not.toHaveBeenCalled();
  });

  it.each([
    ["근로감독관", "inspector-token"],
    ["운영 관리자", "admin-token"],
  ])("%s 에게는 집계를 돌려준다", async (_label, token) => {
    const response = await mlDashboardRoute(get("/api/inspector/ml-dashboard?tab=safety&region=서울", token));

    expect(response.status).toBe(200);
    expect(state.getMlDashboard).toHaveBeenCalledWith("safety", "서울", null);
  });
});
