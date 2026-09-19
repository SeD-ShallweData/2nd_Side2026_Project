import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const db = vi.hoisted(() => ({
  queryWrite: vi.fn(),
  configured: vi.fn(() => true),
}));

vi.mock("@/server/postgresWrite", () => ({
  queryWrite: db.queryWrite,
  isWriteDatabaseConfigured: db.configured,
}));

import { RealFavoriteRepository } from "@/adapters/real/RealFavoriteRepository";

const repository = new RealFavoriteRepository();
const CREATED_AT = new Date("2026-09-20T12:00:00.000Z");

function favoriteRow(firmId = "firm-1") {
  return {
    user_id: "10000000-0000-4000-8000-000000000001",
    firm_id: firmId,
    created_at: CREATED_AT,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  db.configured.mockReturnValue(true);
});

describe("실제 즐겨찾기 저장소", () => {
  it("wg_auth 연결이 없으면 즐겨찾기 설정 오류로 안내한다", () => {
    db.configured.mockReturnValue(false);

    expect(() => repository.assertAvailable()).toThrowError(
      expect.objectContaining({
        code: "FAVORITE_DATABASE_NOT_CONFIGURED",
        status: 503,
        retryable: true,
      }),
    );
    expect(db.configured).toHaveBeenCalledWith("auth");
  });

  it("사용자별 즐겨찾기를 최신순으로 읽고 API 식별자 이름으로 변환한다", async () => {
    db.queryWrite.mockResolvedValueOnce([favoriteRow("firm-2"), favoriteRow("firm-1")]);

    await expect(repository.listByUser("user-1")).resolves.toEqual([
      {
        user_id: favoriteRow().user_id,
        company_id: "firm-2",
        created_at: CREATED_AT.toISOString(),
      },
      {
        user_id: favoriteRow().user_id,
        company_id: "firm-1",
        created_at: CREATED_AT.toISOString(),
      },
    ]);

    expect(db.queryWrite).toHaveBeenCalledWith(
      "auth",
      expect.stringContaining("FROM user_favorite_firms"),
      ["user-1"],
    );
    expect(String(db.queryWrite.mock.calls[0]?.[1])).toContain("ORDER BY created_at DESC");
  });

  it("처음 추가한 즐겨찾기는 생성됨으로 반환한다", async () => {
    db.queryWrite.mockResolvedValueOnce([favoriteRow()]);

    await expect(repository.upsert("user-1", "firm-1")).resolves.toMatchObject({
      created: true,
      favorite: { company_id: "firm-1" },
    });
    expect(String(db.queryWrite.mock.calls[0]?.[1])).toContain("ON CONFLICT");
    expect(String(db.queryWrite.mock.calls[0]?.[1])).toContain("DO NOTHING");
    expect(db.queryWrite).toHaveBeenCalledTimes(1);
  });

  it("이미 존재하는 즐겨찾기는 기존 생성 시각을 유지한다", async () => {
    db.queryWrite.mockResolvedValueOnce([]).mockResolvedValueOnce([favoriteRow()]);

    await expect(repository.upsert("user-1", "firm-1")).resolves.toEqual({
      created: false,
      favorite: {
        user_id: favoriteRow().user_id,
        company_id: "firm-1",
        created_at: CREATED_AT.toISOString(),
      },
    });
    expect(String(db.queryWrite.mock.calls[1]?.[1])).toContain("SELECT user_id::text");
  });

  it("충돌 후 기존 행도 확인할 수 없으면 성공으로 처리하지 않는다", async () => {
    db.queryWrite.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await expect(repository.upsert("user-1", "firm-1")).rejects.toMatchObject({
      code: "FAVORITE_SAVE_FAILED",
      status: 503,
    });
  });

  it("삭제는 존재 여부와 무관하게 멱등 처리한다", async () => {
    db.queryWrite.mockResolvedValueOnce([]);

    await repository.delete("user-1", "firm-1");

    expect(db.queryWrite).toHaveBeenCalledWith(
      "auth",
      expect.stringContaining("DELETE FROM user_favorite_firms"),
      ["user-1", "firm-1"],
    );
  });
});
