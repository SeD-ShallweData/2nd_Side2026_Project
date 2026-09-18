import type { FavoriteApiSource } from "@/app/api/users/me/favorites/favoriteApiContract";

export interface StoredFavorite {
  user_id: string;
  company_id: string;
  created_at: string;
}

export interface FavoriteUpsertResult {
  favorite: StoredFavorite;
  created: boolean;
}

/*
 * 즐겨찾기 저장소 포트.
 *
 * 사용자 권한 판정과 사업장 존재 여부 확인은 서비스 계층이 담당한다. 저장소는
 * 사용자-사업장 연결만 보관하며, 사업장 이름·지역·업종을 중복 저장하지 않는다.
 */
export interface FavoriteRepository {
  readonly source: FavoriteApiSource;

  assertAvailable(): void;

  listByUser(userId: string): Promise<StoredFavorite[]>;

  upsert(userId: string, companyId: string): Promise<FavoriteUpsertResult>;

  delete(userId: string, companyId: string): Promise<void>;
}
