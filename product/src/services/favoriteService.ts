import "server-only";

import type { SessionUserDto } from "@/app/api/auth/authApiContract";
import type {
  FavoriteCompanyDto,
  FavoriteDeleteResponse,
  FavoriteListResponse,
  FavoriteUpsertResponse,
} from "@/app/api/users/me/favorites/favoriteApiContract";
import type { Company } from "@/domain/company";
import type { StoredFavorite } from "@/domain/favorite";
import { requireUserRole } from "@/server/auth/permissions";
import { getCompanyRepository } from "@/services/providers";
import { getFavoriteRepository } from "@/services/userDataProviders";
import { ServiceError } from "@/utils/errors";

function requireFavoriteUser(user: SessionUserDto): void {
  requireUserRole(user, ["user"]);
}

function normalizeCompanyId(value: string): string {
  const companyId = value.trim();
  if (!companyId || companyId.length > 64) {
    throw new ServiceError(
      "INVALID_COMPANY_ID",
      "사업장 식별값을 확인해 주세요.",
      400,
      false,
      [{ field: "company_id", reason: "company_id는 1자 이상 64자 이하 문자열이어야 합니다." }],
    );
  }
  return companyId;
}

function toDto(favorite: StoredFavorite, company: Company): FavoriteCompanyDto {
  return {
    company_id: company.company_id,
    company_name: company.company_name,
    region: company.region,
    industry: company.industry,
    created_at: favorite.created_at,
  };
}

async function resolveFavorite(favorite: StoredFavorite): Promise<FavoriteCompanyDto> {
  const company = await getCompanyRepository().getById(favorite.company_id);
  if (!company) {
    throw new ServiceError(
      "FAVORITE_COMPANY_INTEGRITY_ERROR",
      "즐겨찾기 사업장 정보를 불러오지 못했습니다.",
      500,
      true,
    );
  }
  return toDto(favorite, company);
}

export async function listFavoriteCompanies(user: SessionUserDto): Promise<FavoriteListResponse> {
  requireFavoriteUser(user);
  const repository = getFavoriteRepository();
  repository.assertAvailable();
  const stored = await repository.listByUser(user.user_id);
  const items = await Promise.all(stored.map(resolveFavorite));
  return { source: repository.source, items, total: items.length };
}

export async function addFavoriteCompany(
  companyIdInput: string,
  user: SessionUserDto,
): Promise<FavoriteUpsertResponse> {
  requireFavoriteUser(user);
  const companyId = normalizeCompanyId(companyIdInput);
  const company = await getCompanyRepository().getById(companyId);
  if (!company) {
    throw new ServiceError(
      "COMPANY_NOT_FOUND",
      "선택한 사업장을 찾을 수 없습니다.",
      404,
      false,
    );
  }

  const repository = getFavoriteRepository();
  repository.assertAvailable();
  const result = await repository.upsert(user.user_id, companyId);
  return {
    source: repository.source,
    favorite: toDto(result.favorite, company),
    created: result.created,
  };
}

export async function deleteFavoriteCompany(
  companyIdInput: string,
  user: SessionUserDto,
): Promise<FavoriteDeleteResponse> {
  requireFavoriteUser(user);
  const companyId = normalizeCompanyId(companyIdInput);
  const repository = getFavoriteRepository();
  repository.assertAvailable();
  await repository.delete(user.user_id, companyId);
  return { deleted: true, company_id: companyId };
}
