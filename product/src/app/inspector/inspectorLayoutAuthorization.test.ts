import { beforeEach, describe, expect, it, vi } from "vitest";

const layoutState = vi.hoisted(() => ({
  token: null as string | null,
  usersByToken: new Map<string, {
    user_id: string;
    email: string;
    display_name: string;
    role: "user" | "admin" | "inspector";
  }>(),
  getOptionalSessionUser: vi.fn(async (token: string | null) => (
    token ? layoutState.usersByToken.get(token) ?? null : null
  )),
  forbidden: vi.fn((): never => {
    throw new Error("NEXT_FORBIDDEN");
  }),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (
      name === "donworry_session" && layoutState.token
        ? { name, value: layoutState.token }
        : undefined
    ),
  }),
}));
vi.mock("next/navigation", () => ({
  forbidden: layoutState.forbidden,
}));
vi.mock("@/services/authService", () => ({
  getOptionalSessionUser: layoutState.getOptionalSessionUser,
}));

import InspectorLayout from "@/app/inspector/layout";

beforeEach(() => {
  vi.clearAllMocks();
  layoutState.token = null;
  layoutState.usersByToken.clear();
  layoutState.usersByToken.set("user-token", {
    user_id: "10000000-0000-4000-8000-000000000001",
    email: "user@example.com",
    display_name: "일반 사용자",
    role: "user",
  });
  layoutState.usersByToken.set("admin-token", {
    user_id: "10000000-0000-4000-8000-000000000002",
    email: "admin@example.com",
    display_name: "관리자",
    role: "admin",
  });
  layoutState.usersByToken.set("inspector-token", {
    user_id: "10000000-0000-4000-8000-000000000003",
    email: "inspector@example.com",
    display_name: "근로감독관",
    role: "inspector",
  });
});

describe("M2 /inspector 레이아웃 권한", () => {
  it.each([
    ["비로그인", null],
    ["일반 사용자", "user-token"],
    ["관리자", "admin-token"],
  ])("%s 접근은 403 인터럽트를 발생시킨다", async (_label, token) => {
    layoutState.token = token;

    await expect(InspectorLayout({ children: "protected-content" })).rejects.toThrow(
      "NEXT_FORBIDDEN",
    );
    expect(layoutState.forbidden).toHaveBeenCalledOnce();
  });

  it("근로감독관에게만 하위 화면을 반환한다", async () => {
    layoutState.token = "inspector-token";

    await expect(InspectorLayout({ children: "protected-content" })).resolves.toBe(
      "protected-content",
    );
    expect(layoutState.forbidden).not.toHaveBeenCalled();
  });
});
