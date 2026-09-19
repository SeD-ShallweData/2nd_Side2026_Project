import { FavoriteApiError } from "@/services/favoriteClient";

/*
 * 서버 메시지를 그대로 보여주지 않는다. 예를 들어 503 메시지는 "데이터베이스가
 * 연결되지 않았다"는 내부 사정을 담고 있어, 사용자에게는 일반적인 재시도 안내로
 * 바꿔서 보여준다. code 는 화면에 노출하지 않는다.
 */
export function describeFavoriteError(error: unknown): string {
  if (error instanceof FavoriteApiError) {
    switch (error.code) {
      case "AUTHENTICATION_REQUIRED":
        return "로그인이 필요한 기능입니다.";
      case "FORBIDDEN":
        return "일반 사용자 전용 기능입니다.";
      case "COMPANY_NOT_FOUND":
        return "해당 사업장을 찾을 수 없습니다.";
      case "CROSS_SITE_REQUEST_REJECTED":
        return "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.";
      default:
        return error.retryable
          ? "현재 즐겨찾기 기능을 사용할 수 없습니다. 잠시 후 다시 시도해 주세요."
          : "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.";
    }
  }
  return "네트워크 문제로 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.";
}

export function favoriteErrorRequiresLogin(error: unknown): boolean {
  return error instanceof FavoriteApiError && error.code === "AUTHENTICATION_REQUIRED";
}
