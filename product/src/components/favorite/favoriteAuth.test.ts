import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/authClient", () => ({
  getSession: vi.fn(),
}));
vi.mock("@/services/favoriteClient", () => ({
  addFavorite: vi.fn(),
  removeFavorite: vi.fn(),
}));

import type { SessionResponse } from "@/app/api/auth/authApiContract";
import { getFavoriteEligibility, performFavoriteToggle } from "@/components/favorite/favoriteAuth";
import { getSession } from "@/services/authClient";
import { addFavorite, removeFavorite } from "@/services/favoriteClient";

const getSessionMock = vi.mocked(getSession);
const addFavoriteMock = vi.mocked(addFavorite);
const removeFavoriteMock = vi.mocked(removeFavorite);

const UNAUTHENTICATED: SessionResponse = { authenticated: false, user: null, expires_at: null };
const USER_SESSION: SessionResponse = {
  authenticated: true,
  user: { user_id: "u1", email: "worker@example.com", display_name: "일반 사용자", role: "user" },
  expires_at: "2026-01-01T00:00:00.000Z",
};
const ADMIN_SESSION: SessionResponse = {
  authenticated: true,
  user: { user_id: "a1", email: "admin@example.com", display_name: "관리자", role: "admin" },
  expires_at: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getFavoriteEligibility", () => {
  it("loading이면 재시도 안내와 함께 eligible:false를 반환한다", () => {
    expect(getFavoriteEligibility("loading")).toMatchObject({ eligible: false });
  });

  it("role이 user면 eligible:true를 반환한다", () => {
    expect(getFavoriteEligibility(USER_SESSION)).toEqual({ eligible: true });
  });
});

describe("performFavoriteToggle — 이미 eligible인 경우", () => {
  it("세션을 재조회하지 않고 바로 addFavorite를 호출한다", async () => {
    addFavoriteMock.mockResolvedValue({
      source: "mock_memory",
      favorite: { company_id: "C1", company_name: "회사", region: null, industry: null, created_at: "now" },
      created: true,
    });

    const result = await performFavoriteToggle("C1", false, { eligible: true });

    expect(result).toEqual({ status: "toggled", isFavorite: true });
    expect(addFavoriteMock).toHaveBeenCalledWith("C1");
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it("isFavorite가 true면 removeFavorite를 호출한다", async () => {
    removeFavoriteMock.mockResolvedValue({ deleted: true, company_id: "C1" });

    const result = await performFavoriteToggle("C1", true, { eligible: true });

    expect(result).toEqual({ status: "toggled", isFavorite: false });
    expect(removeFavoriteMock).toHaveBeenCalledWith("C1");
  });
});

describe("performFavoriteToggle — stale eligibility 재확인", () => {
  const staleUnauthenticated = {
    eligible: false,
    reason: { message: "로그인이 필요한 기능입니다.", requiresLogin: true },
  } as const;

  it("재조회 결과 user면 addFavorite가 호출된다 (오래된 부모 state 때문에 실제 로그인 user를 막지 않는다)", async () => {
    getSessionMock.mockResolvedValue(USER_SESSION);
    addFavoriteMock.mockResolvedValue({
      source: "mock_memory",
      favorite: { company_id: "C1", company_name: "회사", region: null, industry: null, created_at: "now" },
      created: true,
    });

    const result = await performFavoriteToggle("C1", false, staleUnauthenticated);

    expect(getSessionMock).toHaveBeenCalledTimes(1);
    expect(addFavoriteMock).toHaveBeenCalledWith("C1");
    expect(result).toEqual({ status: "toggled", isFavorite: true });
  });

  it("재조회 결과도 비로그인이면 API 호출 없이 로그인 안내를 반환한다", async () => {
    getSessionMock.mockResolvedValue(UNAUTHENTICATED);

    const result = await performFavoriteToggle("C1", false, staleUnauthenticated);

    expect(addFavoriteMock).not.toHaveBeenCalled();
    expect(removeFavoriteMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "blocked",
      reason: { message: "로그인이 필요한 기능입니다.", requiresLogin: true },
    });
  });

  it("재조회 결과 admin이면 API 호출 없이 일반 사용자 전용 안내를 반환한다", async () => {
    getSessionMock.mockResolvedValue(ADMIN_SESSION);

    const result = await performFavoriteToggle("C1", false, staleUnauthenticated);

    expect(addFavoriteMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "blocked",
      reason: { message: "일반 사용자 전용 기능입니다.", requiresLogin: false },
    });
  });

  it("세션 재조회 자체가 실패하면 API 호출 없이 일반 안내를 반환한다", async () => {
    getSessionMock.mockRejectedValue(new TypeError("network down"));

    const result = await performFavoriteToggle("C1", false, staleUnauthenticated);

    expect(addFavoriteMock).not.toHaveBeenCalled();
    expect(result.status).toBe("blocked");
  });
});
