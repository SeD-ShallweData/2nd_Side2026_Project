import type { SessionResponse } from "@/app/api/auth/authApiContract";
import { getSession } from "@/services/authClient";
import { addFavorite, removeFavorite } from "@/services/favoriteClient";

export interface FavoriteIneligibleReason {
  message: string;
  requiresLogin: boolean;
}

export interface FavoriteEligibility {
  eligible: boolean;
  reason?: FavoriteIneligibleReason;
}

/*
 * 즐겨찾기는 role="user" 전용이다. 최종 판정은 항상 backend가 내리지만, 세션을
 * 이미 알고 있는 경우 굳이 401/403을 받아 온 뒤에야 안내하지 않도록 화면에서
 * 먼저 안내 문구를 보여준다. 이 판정 결과로 API 호출 자체를 막지는 않는다.
 */
export function getFavoriteEligibility(session: SessionResponse | "loading"): FavoriteEligibility {
  if (session === "loading") {
    return {
      eligible: false,
      reason: { message: "세션을 확인하는 중입니다. 잠시 후 다시 시도해 주세요.", requiresLogin: false },
    };
  }
  if (!session.authenticated) {
    return {
      eligible: false,
      reason: { message: "로그인이 필요한 기능입니다.", requiresLogin: true },
    };
  }
  if (session.user.role !== "user") {
    return {
      eligible: false,
      reason: { message: "일반 사용자 전용 기능입니다.", requiresLogin: false },
    };
  }
  return { eligible: true };
}

const SESSION_RECHECK_FAILED_REASON: FavoriteIneligibleReason = {
  message: "세션을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.",
  requiresLogin: false,
};

/*
 * 검색 결과·상세 화면은 진입 시 세션을 한 번만 조회해 eligibility를 prop으로
 * 내려준다. 그 사이 로그인 상태가 바뀌었는데(예: 로그인 후 원래 화면으로 돌아온
 * 경우) 화면이 재조회하지 않으면, 실제로는 로그인된 사용자를 오래된 eligibility가
 * 계속 막게 된다. 그래서 이미 eligible이 아닌 경우에 한해 세션을 한 번 더 확인한다.
 */
async function recheckFavoriteEligibility(): Promise<FavoriteEligibility> {
  try {
    const session = await getSession();
    return getFavoriteEligibility(session);
  } catch {
    return { eligible: false, reason: SESSION_RECHECK_FAILED_REASON };
  }
}

export type FavoriteToggleResult =
  | { status: "blocked"; reason: FavoriteIneligibleReason }
  | { status: "toggled"; isFavorite: boolean };

/*
 * FavoriteButton의 유일한 진입점. eligibility가 이미 eligible이면 바로
 * PUT/DELETE로 넘어가고, 아니면 세션을 재확인한 뒤 그 결과로 다시 판단한다.
 * 최종 권한 검사는 여전히 backend API가 한다 — 여기서는 오래된 프론트 상태
 * 때문에 실제로 로그인된 사용자를 잘못 막지 않도록 보정할 뿐이다.
 */
export async function performFavoriteToggle(
  companyId: string,
  isFavorite: boolean,
  eligibility: FavoriteEligibility,
): Promise<FavoriteToggleResult> {
  const resolved = eligibility.eligible ? eligibility : await recheckFavoriteEligibility();
  if (!resolved.eligible) {
    return { status: "blocked", reason: resolved.reason ?? SESSION_RECHECK_FAILED_REASON };
  }
  if (isFavorite) {
    await removeFavorite(companyId);
    return { status: "toggled", isFavorite: false };
  }
  await addFavorite(companyId);
  return { status: "toggled", isFavorite: true };
}
