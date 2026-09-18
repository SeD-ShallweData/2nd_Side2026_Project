import "server-only";

import type {
  FavoriteRepository,
  FavoriteUpsertResult,
  StoredFavorite,
} from "@/domain/favorite";

/*
 * 테이블이 만들어지기 전에 API 계약과 화면을 함께 개발하기 위한 메모리 저장소다.
 * 개발 중 모듈이 다시 로드돼도 상태가 유지되도록 globalThis 에 둔다.
 */
const favoriteGlobal = globalThis as typeof globalThis & {
  __donworryMockFavorites?: Map<string, Map<string, StoredFavorite>>;
};

const favoritesByUser = favoriteGlobal.__donworryMockFavorites
  ?? new Map<string, Map<string, StoredFavorite>>();
favoriteGlobal.__donworryMockFavorites = favoritesByUser;

function copyFavorite(favorite: StoredFavorite): StoredFavorite {
  return { ...favorite };
}

export class MockFavoriteRepository implements FavoriteRepository {
  readonly source = "mock_memory" as const;

  assertAvailable(): void {
    // 메모리 저장소는 항상 사용할 수 있다.
  }

  async listByUser(userId: string): Promise<StoredFavorite[]> {
    return [...(favoritesByUser.get(userId)?.values() ?? [])]
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.company_id.localeCompare(b.company_id))
      .map(copyFavorite);
  }

  async upsert(userId: string, companyId: string): Promise<FavoriteUpsertResult> {
    const userFavorites = favoritesByUser.get(userId) ?? new Map<string, StoredFavorite>();
    favoritesByUser.set(userId, userFavorites);

    const existing = userFavorites.get(companyId);
    if (existing) {
      return { favorite: copyFavorite(existing), created: false };
    }

    const favorite: StoredFavorite = {
      user_id: userId,
      company_id: companyId,
      created_at: new Date().toISOString(),
    };
    userFavorites.set(companyId, favorite);
    return { favorite: copyFavorite(favorite), created: true };
  }

  async delete(userId: string, companyId: string): Promise<void> {
    const userFavorites = favoritesByUser.get(userId);
    userFavorites?.delete(companyId);
    if (userFavorites?.size === 0) favoritesByUser.delete(userId);
  }

  resetForTests(): void {
    favoritesByUser.clear();
  }
}
