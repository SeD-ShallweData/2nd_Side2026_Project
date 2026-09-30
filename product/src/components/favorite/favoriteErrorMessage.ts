import type { MessageShape } from "@/i18n/defineMessages";
import { favoriteMessages } from "@/i18n/messages/favorite";
import { FavoriteApiError } from "@/services/favoriteClient";

export type FavoriteErrorMessages = MessageShape<typeof favoriteMessages.ko>["errors"];

/*
 * 서버 메시지를 그대로 보여주지 않는다. 예를 들어 503 메시지는 "데이터베이스가
 * 연결되지 않았다"는 내부 사정을 담고 있어, 사용자에게는 일반적인 재시도 안내로
 * 바꿔서 보여준다. code 는 화면에 노출하지 않는다.
 * 문구는 화면이 넘겨준 현재 언어 사전에서 고른다. 넘기지 않으면 한국어다.
 */
export function describeFavoriteError(error: unknown, t: FavoriteErrorMessages = favoriteMessages.ko.errors): string {
  if (error instanceof FavoriteApiError) {
    switch (error.code) {
      case "AUTHENTICATION_REQUIRED":
        return t.loginRequired;
      case "FORBIDDEN":
        return t.userOnly;
      case "COMPANY_NOT_FOUND":
        return t.notFound;
      case "CROSS_SITE_REQUEST_REJECTED":
        return t.requestFailed;
      default:
        return error.retryable ? t.unavailable : t.requestFailed;
    }
  }
  return t.network;
}

/*
 * favoriteAuth 가 돌려주는 안내 문구는 한국어 원문이다. 같은 한국어를 가진 키를 찾아
 * 현재 언어 문구로 바꾼다. 모르는 문구면 그대로 둔다.
 */
export function localizeFavoriteReason(message: string, t: FavoriteErrorMessages): string {
  const source = favoriteMessages.ko.errors;
  const key = (Object.keys(source) as (keyof typeof source)[]).find((candidate) => source[candidate] === message);
  return key ? t[key] : message;
}

export function favoriteErrorRequiresLogin(error: unknown): boolean {
  return error instanceof FavoriteApiError && error.code === "AUTHENTICATION_REQUIRED";
}
