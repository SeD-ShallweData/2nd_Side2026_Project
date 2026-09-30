import { isValidElement, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pageState = vi.hoisted(() => ({
  token: null as string | null,
  // 설정하면 token 대신 이 Cookie 헤더를 그대로 보낸다.
  rawCookie: null as string | null,
  usersByToken: new Map<string, {
    user_id: string;
    email: string;
    display_name: string;
    role: "user" | "admin" | "inspector";
  }>(),
  getOptionalSessionUser: vi.fn(async (token: string | null) => (
    token ? pageState.usersByToken.get(token) ?? null : null
  )),
  forbidden: vi.fn((): never => {
    throw new Error("NEXT_FORBIDDEN");
  }),
}));

vi.mock("server-only", () => ({}));
// 화면 가드는 API 와 같은 규칙으로 Cookie 헤더를 직접 읽는다(sessionCookie.ts 의 parseSessionToken).
vi.mock("next/headers", () => ({
  headers: async () => {
    if (pageState.rawCookie !== null) return new Headers({ cookie: pageState.rawCookie });
    return new Headers(pageState.token ? { cookie: `theme=dark; donworry_session=${pageState.token}` } : {});
  },
}));
vi.mock("next/navigation", () => ({
  forbidden: pageState.forbidden,
}));
vi.mock("@/services/authService", () => ({
  getOptionalSessionUser: pageState.getOptionalSessionUser,
}));

import AdminPage from "@/app/admin/page";
import AdminBatchesPage from "@/app/admin/batches/page";
import { getSessionTokenFromRequest } from "@/server/auth/sessionCookie";

beforeEach(() => {
  vi.clearAllMocks();
  pageState.token = null;
  pageState.rawCookie = null;
  pageState.usersByToken.clear();
  pageState.usersByToken.set("user-token", {
    user_id: "10000000-0000-4000-8000-000000000001",
    email: "user@example.com",
    display_name: "일반 사용자",
    role: "user",
  });
  pageState.usersByToken.set("admin-token", {
    user_id: "10000000-0000-4000-8000-000000000002",
    email: "admin@example.com",
    display_name: "관리자",
    role: "admin",
  });
  pageState.usersByToken.set("inspector-token", {
    user_id: "10000000-0000-4000-8000-000000000003",
    email: "inspector@example.com",
    display_name: "근로감독관",
    role: "inspector",
  });
});

/*
 * /admin 은 전에는 클라이언트 AdminAccessGate 만 있어 누구에게나 200 과 화면 틀을 돌려줬다.
 * 이제 /inspector 처럼 서버에서 먼저 운영 관리자 세션을 확인한다.
 */
describe.each([
  ["/admin", () => AdminPage()],
  ["/admin/batches", () => AdminBatchesPage()],
] as const)("%s 서버 권한", (_path, render) => {
  it.each([
    ["비로그인", null],
    ["일반 사용자", "user-token"],
    ["근로감독관", "inspector-token"],
  ])("%s 접근은 화면을 그리기 전에 403 인터럽트를 발생시킨다", async (_label, token) => {
    pageState.token = token;

    await expect(render()).rejects.toThrow("NEXT_FORBIDDEN");
    expect(pageState.forbidden).toHaveBeenCalledOnce();
  });

  it("운영 관리자에게는 화면을 그린다", async () => {
    pageState.token = "admin-token";

    const element: ReactElement = await render();

    expect(isValidElement(element)).toBe(true);
    expect(pageState.forbidden).not.toHaveBeenCalled();
    expect(pageState.getOptionalSessionUser).toHaveBeenCalledWith("admin-token");
  });
});

/*
 * Path 가 다른 donworry_session 이 둘 오면 화면 가드와 API 가 같은 세션을 봐야 한다.
 * API(getSessionTokenFromRequest)는 첫 값을 쓰므로 화면 가드도 첫 값을 쓴다.
 */
describe("이름이 같은 세션 쿠키가 여럿일 때", () => {
  it.each([
    ["donworry_session=user-token; donworry_session=admin-token", "user-token", false],
    ["donworry_session=admin-token; donworry_session=user-token", "admin-token", true],
  ])("%s 는 API 와 같은 첫 값(%s)으로 판정한다", async (cookie, expectedToken, allowed) => {
    pageState.rawCookie = cookie;
    const apiToken = getSessionTokenFromRequest(new Request("http://localhost/api/admin/batches", { headers: { cookie } }));

    if (allowed) {
      expect(isValidElement(await AdminPage())).toBe(true);
    } else {
      await expect(AdminPage()).rejects.toThrow("NEXT_FORBIDDEN");
    }

    expect(apiToken).toBe(expectedToken);
    expect(pageState.getOptionalSessionUser).toHaveBeenCalledWith(expectedToken);
  });
});
