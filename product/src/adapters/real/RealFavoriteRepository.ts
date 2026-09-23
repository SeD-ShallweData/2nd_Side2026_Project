import "server-only";

import type {
  FavoriteRepository,
  FavoriteUpsertResult,
  StoredFavorite,
} from "@/domain/favorite";
import { isWriteDatabaseConfigured, queryWrite } from "@/server/postgresWrite";
import { ServiceError } from "@/utils/errors";

interface FavoriteRow {
  user_id: string;
  firm_id: string;
  created_at: Date;
}

function toStoredFavorite(row: FavoriteRow): StoredFavorite {
  return {
    user_id: row.user_id,
    company_id: row.firm_id,
    created_at: new Date(row.created_at).toISOString(),
  };
}

/*
 * 즐겨찾기는 인증 사용자에게 귀속되므로 wg_auth 연결을 공유한다.
 * wg_auth에는 user_favorite_firms의 SELECT·INSERT·DELETE만 있고 UPDATE는 없다.
 */
export class RealFavoriteRepository implements FavoriteRepository {
  readonly source = "database" as const;

  assertAvailable(): void {
    if (!isWriteDatabaseConfigured("auth")) {
      throw new ServiceError(
        "FAVORITE_DATABASE_NOT_CONFIGURED",
        "즐겨찾기 데이터베이스 연결 정보가 설정되지 않았습니다.",
        503,
        true,
      );
    }
  }

  async listByUser(userId: string): Promise<StoredFavorite[]> {
    const rows = await queryWrite<FavoriteRow>(
      "auth",
      `SELECT user_id::text, firm_id, created_at
         FROM user_favorite_firms
        WHERE user_id = $1::uuid
        ORDER BY created_at DESC, firm_id ASC`,
      [userId],
    );
    return rows.map(toStoredFavorite);
  }

  async upsert(userId: string, companyId: string): Promise<FavoriteUpsertResult> {
    const inserted = await queryWrite<FavoriteRow>(
      "auth",
      `INSERT INTO user_favorite_firms (user_id, firm_id)
       VALUES ($1::uuid, $2)
       ON CONFLICT (user_id, firm_id) DO NOTHING
       RETURNING user_id::text, firm_id, created_at`,
      [userId, companyId],
    );

    if (inserted[0]) {
      return { favorite: toStoredFavorite(inserted[0]), created: true };
    }

    const existing = await queryWrite<FavoriteRow>(
      "auth",
      `SELECT user_id::text, firm_id, created_at
         FROM user_favorite_firms
        WHERE user_id = $1::uuid
          AND firm_id = $2
        LIMIT 1`,
      [userId, companyId],
    );
    if (!existing[0]) {
      throw new ServiceError(
        "FAVORITE_SAVE_FAILED",
        "즐겨찾기 저장을 완료하지 못했습니다.",
        503,
        true,
      );
    }
    return { favorite: toStoredFavorite(existing[0]), created: false };
  }

  async delete(userId: string, companyId: string): Promise<void> {
    await queryWrite(
      "auth",
      `DELETE FROM user_favorite_firms
        WHERE user_id = $1::uuid
          AND firm_id = $2`,
      [userId, companyId],
    );
  }
}
