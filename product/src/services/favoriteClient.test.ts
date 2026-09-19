import { describe, expect, it, vi } from "vitest";
import type {
  FavoriteDeleteResponse,
  FavoriteListResponse,
  FavoriteUpsertResponse,
} from "@/app/api/users/me/favorites/favoriteApiContract";
import { FavoriteApiError, addFavorite, getFavorites, removeFavorite } from "@/services/favoriteClient";

const FAVORITE_ITEM = {
  company_id: "COMPANY_DEMO_001",
  company_name: "OO건설",
  region: "인천광역시",
  industry: "건설업",
  created_at: "2026-09-01T00:00:00.000Z",
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

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("오류가 발생하지 않았습니다.");
    },
    (caught: unknown) => caught,
  );
}

describe("즐겨찾기 목록 조회", () => {
  it("GET으로 목록을 조회한다", async () => {
    const listResponse: FavoriteListResponse = {
      source: "mock_memory",
      items: [FAVORITE_ITEM],
      total: 1,
    };
    const fetchImpl = createFetchMock(jsonResponse(listResponse));

    const result = await getFavorites({ fetchImpl });

    expect(result).toEqual(listResponse);
    const { path, init } = readCall(fetchImpl);
    expect(path).toBe("/api/users/me/favorites");
    expect(init.method).toBe("GET");
  });

  it("401은 FavoriteApiError로 던진다", async () => {
    const fetchImpl = createFetchMock(
      errorResponse(401, "AUTHENTICATION_REQUIRED", "로그인이 필요한 기능입니다."),
    );

    const caught = await captureError(getFavorites({ fetchImpl }));

    expect(caught).toBeInstanceOf(FavoriteApiError);
    expect(caught).toMatchObject({ status: 401, code: "AUTHENTICATION_REQUIRED", retryable: false });
  });

  it("403은 FavoriteApiError로 던진다", async () => {
    const fetchImpl = createFetchMock(errorResponse(403, "FORBIDDEN", "이 기능을 사용할 권한이 없습니다."));

    const caught = await captureError(getFavorites({ fetchImpl }));

    expect(caught).toBeInstanceOf(FavoriteApiError);
    expect(caught).toMatchObject({ status: 403, code: "FORBIDDEN" });
  });

  it("503은 retryable로 표시된다", async () => {
    const fetchImpl = createFetchMock(
      errorResponse(503, "FAVORITE_DATABASE_NOT_CONFIGURED", "즐겨찾기 데이터베이스가 아직 연결되지 않았습니다."),
    );

    const caught = await captureError(getFavorites({ fetchImpl }));

    expect(caught).toBeInstanceOf(FavoriteApiError);
    expect(caught).toMatchObject({
      status: 503,
      code: "FAVORITE_DATABASE_NOT_CONFIGURED",
      retryable: true,
    });
  });

  it("네트워크 실패는 그대로 던진다", async () => {
    const fetchImpl = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
    fetchImpl.mockRejectedValue(new TypeError("Failed to fetch"));

    const caught = await captureError(getFavorites({ fetchImpl }));

    expect(caught).toBeInstanceOf(TypeError);
  });
});

describe("즐겨찾기 추가", () => {
  it("최초 추가는 201과 created:true를 반환한다", async () => {
    const upsertResponse: FavoriteUpsertResponse = {
      source: "mock_memory",
      favorite: FAVORITE_ITEM,
      created: true,
    };
    const fetchImpl = createFetchMock(jsonResponse(upsertResponse, 201));

    const result = await addFavorite("COMPANY_DEMO_001", { fetchImpl });

    expect(result).toEqual(upsertResponse);
    const { path, init } = readCall(fetchImpl);
    expect(path).toBe("/api/users/me/favorites/COMPANY_DEMO_001");
    expect(init.method).toBe("PUT");
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
  });

  it("이미 추가된 경우 200과 created:false를 반환한다", async () => {
    const upsertResponse: FavoriteUpsertResponse = {
      source: "mock_memory",
      favorite: FAVORITE_ITEM,
      created: false,
    };
    const fetchImpl = createFetchMock(jsonResponse(upsertResponse, 200));

    const result = await addFavorite("COMPANY_DEMO_001", { fetchImpl });

    expect(result).toEqual(upsertResponse);
  });

  it("company_id는 URL 경로에 인코딩되어 들어간다", async () => {
    const upsertResponse: FavoriteUpsertResponse = {
      source: "mock_memory",
      favorite: FAVORITE_ITEM,
      created: true,
    };
    const fetchImpl = createFetchMock(jsonResponse(upsertResponse, 201));

    await addFavorite("company/with space", { fetchImpl });

    const { path } = readCall(fetchImpl);
    expect(path).toBe("/api/users/me/favorites/company%2Fwith%20space");
  });

  it("404는 FavoriteApiError로 던진다", async () => {
    const fetchImpl = createFetchMock(
      errorResponse(404, "COMPANY_NOT_FOUND", "선택한 사업장을 찾을 수 없습니다."),
    );

    const caught = await captureError(addFavorite("NO_SUCH_COMPANY", { fetchImpl }));

    expect(caught).toBeInstanceOf(FavoriteApiError);
    expect(caught).toMatchObject({ status: 404, code: "COMPANY_NOT_FOUND" });
  });
});

describe("즐겨찾기 해제", () => {
  it("본문 없이 DELETE로 요청한다", async () => {
    const deleteResponse: FavoriteDeleteResponse = { deleted: true, company_id: "COMPANY_DEMO_001" };
    const fetchImpl = createFetchMock(jsonResponse(deleteResponse));

    const result = await removeFavorite("COMPANY_DEMO_001", { fetchImpl });

    expect(result).toEqual(deleteResponse);
    const { path, init } = readCall(fetchImpl);
    expect(path).toBe("/api/users/me/favorites/COMPANY_DEMO_001");
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
  });
});
