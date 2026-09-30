import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  usersByToken: new Map<string, { user_id: string; email: string; display_name: string; role: "user" | "admin" | "inspector" }>(),
  getOptionalSessionUser: vi.fn(async (token: string | null) => (
    token ? state.usersByToken.get(token) ?? null : null
  )),
  listPromptHistory: vi.fn(async () => [{ id: "11", version: 4 }]),
  listOpsAudit: vi.fn(async () => [{ id: "21", action: "batch.activate" }]),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/services/authService", () => ({ getOptionalSessionUser: state.getOptionalSessionUser }));
vi.mock("@/server/ops/opsDatabase", () => ({
  listPromptHistory: state.listPromptHistory,
  listOpsAudit: state.listOpsAudit,
}));

import { GET as auditRoute } from "@/app/api/admin/ops/audit/route";
import { GET as historyRoute } from "@/app/api/admin/prompts/history/route";

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

/* 프롬프트 이력과 운영 감사 기록은 운영 관리자만 읽는다. */
describe("운영 기록 조회 API 권한", () => {
  it.each([
    ["비로그인", null],
    ["일반 사용자", "user-token"],
    ["근로감독관", "inspector-token"],
  ])("%s 요청은 403이고 DB를 부르지 않는다", async (_label, token) => {
    const responses = await Promise.all([
      historyRoute(get("/api/admin/prompts/history?name=rewrite/system", token)),
      auditRoute(get("/api/admin/ops/audit", token)),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    }
    expect(state.listPromptHistory).not.toHaveBeenCalled();
    expect(state.listOpsAudit).not.toHaveBeenCalled();
  });

  it("운영 관리자에게는 기록을 돌려준다", async () => {
    const history = await historyRoute(get("/api/admin/prompts/history?name=rewrite/system", "admin-token"));
    const audit = await auditRoute(get("/api/admin/ops/audit", "admin-token"));

    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({ name: "rewrite/system", items: [{ id: "11" }] });
    expect(audit.status).toBe(200);
    expect(await audit.json()).toMatchObject({ items: [{ id: "21" }] });
    expect(state.listPromptHistory).toHaveBeenCalledWith("rewrite/system", 20);
    expect(state.listOpsAudit).toHaveBeenCalledWith(30);
  });
});
