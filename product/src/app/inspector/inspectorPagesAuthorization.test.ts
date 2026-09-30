import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pageState = vi.hoisted(() => ({
  token: null as string | null,
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
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (
      name === "donworry_session" && pageState.token
        ? { name, value: pageState.token }
        : undefined
    ),
  }),
}));
vi.mock("next/navigation", () => ({
  forbidden: pageState.forbidden,
}));
vi.mock("@/services/authService", () => ({
  getOptionalSessionUser: pageState.getOptionalSessionUser,
}));

import InspectorPage from "@/app/inspector/page";
import InspectorBatchesPage from "@/app/inspector/batches/page";
import InspectorChatPage from "@/app/inspector/chat/page";
import MlDashboardRoute from "@/app/inspector/ml-dashboard/page";
import InspectorPromptsPage from "@/app/inspector/prompts/page";
import { InspectorDashboard } from "@/components/inspector/InspectorDashboard";
import { MlDashboardPage } from "@/components/inspector/MlDashboardPage";

beforeEach(() => {
  vi.clearAllMocks();
  pageState.token = null;
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

/* 화면 트리에서 특정 부품을 찾는다. 렌더링 없이 페이지가 넘긴 값을 확인하려는 것이다. */
function findElement(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return null;
  if (node.type === type) return node;
  return findElement(node.props.children as ReactNode, type);
}

/*
 * 레이아웃은 클라이언트 이동 때 다시 실행되지 않는다(부분 렌더링). 그래서 레이아웃의
 * 검사만 믿지 않고 페이지마다 다시 권한을 확인한다.
 */
describe.each([
  ["/inspector", () => InspectorPage()],
  ["/inspector/chat", () => InspectorChatPage({ searchParams: Promise.resolve({ company_id: "COMPANY_DEMO_001" }) })],
  ["/inspector/ml-dashboard", () => MlDashboardRoute()],
] as const)("%s 페이지 권한 (감독 업무)", (_path, render) => {
  it.each([
    ["비로그인", null],
    ["일반 사용자", "user-token"],
  ])("%s 접근은 레이아웃과 별개로 페이지에서도 403 인터럽트를 발생시킨다", async (_label, token) => {
    pageState.token = token;

    await expect(render()).rejects.toThrow("NEXT_FORBIDDEN");
    expect(pageState.forbidden).toHaveBeenCalledOnce();
  });

  it.each([
    ["근로감독관", "inspector-token"],
    ["운영 관리자", "admin-token"],
  ])("%s 에게는 화면을 그린다", async (_label, token) => {
    pageState.token = token;

    expect(isValidElement(await render())).toBe(true);
    expect(pageState.forbidden).not.toHaveBeenCalled();
  });
});

describe.each([
  ["/inspector/batches", () => InspectorBatchesPage()],
  ["/inspector/prompts", () => InspectorPromptsPage()],
] as const)("%s 페이지 권한 (플랫폼 운영)", (_path, render) => {
  it.each([
    ["비로그인", null],
    ["일반 사용자", "user-token"],
    ["근로감독관", "inspector-token"],
  ])("%s 접근은 403 인터럽트를 발생시킨다", async (_label, token) => {
    pageState.token = token;

    await expect(render()).rejects.toThrow("NEXT_FORBIDDEN");
    expect(pageState.forbidden).toHaveBeenCalledOnce();
  });

  it("운영 관리자에게는 화면을 그린다", async () => {
    pageState.token = "admin-token";

    expect(isValidElement(await render())).toBe(true);
    expect(pageState.forbidden).not.toHaveBeenCalled();
  });
});

describe("운영 패널 표시는 페이지가 확인한 역할을 따른다", () => {
  it("대시보드는 운영 관리자에게만 운영 표시를 켠다", async () => {
    pageState.token = "admin-token";
    expect(findElement(await InspectorPage(), InspectorDashboard)?.props.isOperator).toBe(true);

    pageState.token = "inspector-token";
    expect(findElement(await InspectorPage(), InspectorDashboard)?.props.isOperator).toBe(false);
  });

  it("ML 대시보드는 운영 관리자에게만 운영 패널을 켠다", async () => {
    pageState.token = "admin-token";
    expect(findElement(await MlDashboardRoute(), MlDashboardPage)?.props.canOperate).toBe(true);

    pageState.token = "inspector-token";
    expect(findElement(await MlDashboardRoute(), MlDashboardPage)?.props.canOperate).toBe(false);
  });
});
