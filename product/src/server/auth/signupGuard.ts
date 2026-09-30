import "server-only";

import { SIGNUP_HONEYPOT_FIELD } from "@/app/api/auth/authApiContract";
import { publicClientMarker, UNMARKED_CLIENT } from "@/server/publicClientMarker";
import {
  FixedWindowCounter,
  rateLimitError,
  testLimitScale,
  type CounterWindow,
} from "@/server/rateLimitCounter";
import { ServiceError } from "@/utils/errors";

/*
 * 가입 보호. 외부 서비스(CAPTCHA·메일 인증) 없이 할 수 있는 두 가지를 건다.
 *
 * 1. 숨은 칸(허니팟). 가입 화면의 보이지 않는 칸에 값이 들어오면 이유를 밝히지 않고 거절한다.
 *    칸을 아예 보내지 않은 요청은 빈 값과 같게 본다 — 기존 HTTP 검증 스크립트가 JSON 으로
 *    바로 가입하기 때문이다.
 * 2. 가입 시도 횟수 상한. 사이트 전체 시간당·하루 상한과 브라우저 탭 표시값별 상한을 함께 센다.
 *    가입하면 곧바로 로그인 세션이 나와 로그인이 필요한 쓰기를 모두 쓸 수 있으므로, 계정을
 *    찍어 내는 속도를 여기서 묶는다. 탭 표시값은 사용자가 바꿀 수 있어 마지막 방어선은 사이트
 *    전체 상한이다. 공격자가 전체 상한을 다 쓰면 정상 가입도 잠시 막히는데, 방문자 IP 를 모르는
 *    지금 구조에서는 피할 수 없는 절충이다.
 *
 * 시도는 비밀번호 해시와 DB 쓰기 전에 센다. 입력이 틀렸거나 이미 가입된 이메일이어도 세므로
 * 409 로 가입 여부를 대량으로 떠보는 것도 같은 상한에 걸린다. 한도는 시연 중 여러 사람이 한꺼번에
 * 가입해도 닿지 않게 넉넉히 잡은 코드 상수다.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export const SIGNUP_RATE_LIMITS = {
  siteWide: [
    { name: "hour", limit: 200, ms: HOUR_MS },
    { name: "day", limit: 1_000, ms: DAY_MS },
  ],
  perClient: [
    { name: "hour", limit: 20, ms: HOUR_MS },
    { name: "day", limit: 50, ms: DAY_MS },
  ],
  /*
   * 탭 표시값이 없는 요청은 모두 한 묶음으로 센다. 저장소를 막은 브라우저, 배포 직후 예전 화면,
   * 표시값을 보내지 않는 봇이 함께 쓰므로, 봇 하나가 금방 나머지까지 막지 못하게 탭 한도의 5배를 준다.
   */
  unmarkedClientMultiplier: 5,
} as const;

const counter = new FixedWindowCounter();

function hasHoneypotValue(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const value = (body as Record<string, unknown>)[SIGNUP_HONEYPOT_FIELD];
  return value !== undefined && value !== null && value !== "";
}

/*
 * 거절 이유(숨은 칸)를 드러내지 않는다. 화면은 이 코드를 따로 다루지 않고 일반 실패 문구를 보인다.
 */
function rejectedSignup(): ServiceError {
  return new ServiceError("SIGNUP_REJECTED", "가입 요청을 처리하지 못했습니다.", 400, false);
}

/**
 * 가입 요청 본문을 읽은 직후, 가입 처리 전에 부른다. 숨은 칸이 채워졌으면 400 SIGNUP_REJECTED,
 * 시도 상한을 넘으면 429 SIGNUP_RATE_LIMITED 를 던진다. 통과하면 이번 시도를 센다.
 */
export function assertSignupAllowed(request: Request, body: unknown, now = Date.now()): void {
  // 숨은 칸에 걸린 요청은 상한을 쓰지 않는다. 봇이 정상 가입자 몫의 상한을 태우지 못하게 한다.
  if (hasHoneypotValue(body)) throw rejectedSignup();

  const scale = testLimitScale();
  const marker = publicClientMarker(request);
  const clientScale = marker === UNMARKED_CLIENT ? SIGNUP_RATE_LIMITS.unmarkedClientMultiplier : 1;
  const siteWindows: CounterWindow[] = SIGNUP_RATE_LIMITS.siteWide.map((window) => ({
    key: `signup:site-${window.name}`, limit: window.limit * scale, ms: window.ms,
  }));
  const clientWindows: CounterWindow[] = SIGNUP_RATE_LIMITS.perClient.map((window) => ({
    key: `signup:client-${window.name}:${marker}`, limit: window.limit * clientScale * scale, ms: window.ms,
  }));
  const rejection = counter.consume([...clientWindows, ...siteWindows], now);
  if (!rejection) return;

  const clientBlocked = clientWindows.some((window) => rejection.blockedKeys.includes(window.key));
  throw rateLimitError(
    "SIGNUP_RATE_LIMITED",
    clientBlocked ? "가입 시도가 너무 많습니다." : "지금은 가입 요청이 많아 잠시 받을 수 없습니다.",
    rejection.retryMs,
  );
}

export function resetSignupGuardForTests(): void {
  counter.clear();
}
