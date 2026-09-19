import type { SessionResponse } from "@/app/api/auth/authApiContract";

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
