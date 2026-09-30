import "server-only";

import {
  FixedWindowCounter,
  rateLimitError,
  testLimitScale,
  type CounterWindow,
} from "@/server/rateLimitCounter";

/*
 * 로그인 사용자의 쓰기·AI 호출 한도.
 *
 * 익명 한도(publicRateLimit)는 방문자 주소나 탭 표시값으로 세기 때문에, 가입만 하면 벗어난다.
 * 그래서 로그인이 필요한 쓰기와 로그인 사용자의 AI 호출은 계정(user_id)으로 센다. 계정은 세션이
 * 보증하므로 IP 나 proxy 설정 없이 지금 운영 구조 그대로 동작한다.
 *
 * 계정을 여러 개 만들어 나눠 쓰는 경우를 위해 게시글과 현장 제보에는 사이트 전체 하루 상한도 둔다.
 *
 * 저장은 프로세스 메모리다. 운영은 Next.js 프로세스 하나라 정확하고, 재시작하면 초기화된다.
 * 한도 값은 코드 상수다. 운영 web.env 검증기가 모르는 키를 거부하므로 환경변수로 받지 않는다.
 * 시연과 평가 스크립트(상담 최대 약 70회)의 정상 사용량보다 넉넉하게 잡았다. 목적은 봇 계정 하나가
 * 밤새 쓸 수 있는 양을 묶는 것이다.
 *
 * 요청은 본문을 읽거나 저장·AI 호출을 하기 전에 센다. 입력 검증에 실패한 요청도 세므로 한도는
 * 정상 사용보다 크게 둔다.
 */

export type AccountRateAction =
  | "chat"
  | "contract_review"
  | "worksite_tip"
  | "community_post"
  | "community_report"
  | "conversation_import";

export interface AccountRateWindow {
  name: "hour" | "day";
  limit: number;
  ms: number;
}

export interface AccountRatePolicy {
  /** 계정 한도를 넘었을 때 안내 첫 문장. 뒤에 남은 시간 안내가 붙는다. */
  accountMessage: string;
  perAccount: readonly AccountRateWindow[];
  /** 사이트 전체 상한. 계정을 바꿔 가며 쓰는 경우를 막는다. */
  siteWide?: { message: string; windows: readonly AccountRateWindow[] };
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function perHour(limit: number): AccountRateWindow {
  return { name: "hour", limit, ms: HOUR_MS };
}

function perDay(limit: number): AccountRateWindow {
  return { name: "day", limit, ms: DAY_MS };
}

export const ACCOUNT_RATE_LIMITS: Readonly<Record<AccountRateAction, AccountRatePolicy>> = {
  chat: {
    accountMessage: "상담 요청이 너무 많습니다.",
    perAccount: [perHour(100), perDay(500)],
  },
  contract_review: {
    accountMessage: "계약서 분석 요청이 너무 많습니다.",
    perAccount: [perHour(30), perDay(150)],
  },
  worksite_tip: {
    accountMessage: "현장 제보가 너무 많습니다.",
    perAccount: [perHour(10), perDay(30)],
    siteWide: { message: "사이트 전체의 현장 제보 접수 한도에 도달했습니다.", windows: [perDay(300)] },
  },
  community_post: {
    accountMessage: "게시글 작성이 너무 많습니다.",
    perAccount: [perHour(20), perDay(60)],
    siteWide: { message: "사이트 전체의 게시글 작성 한도에 도달했습니다.", windows: [perDay(1_000)] },
  },
  community_report: {
    accountMessage: "게시글 신고가 너무 많습니다.",
    perAccount: [perHour(30), perDay(100)],
  },
  conversation_import: {
    accountMessage: "대화 가져오기 요청이 너무 많습니다.",
    perAccount: [perHour(20), perDay(60)],
  },
};

/*
 * 같은 request_id 로 다시 보낸 요청(상담의 '다시 보내기')은 새 요청으로 세지 않는다.
 * 다만 대화 저장소가 장애일 때는 재전송도 새 답변을 만들 수 있으므로, 한 요청당 세지 않는
 * 재전송 횟수를 묶는다. 이 횟수를 다 쓰면 다음 재전송은 새 요청처럼 센다.
 */
export const FREE_RETRIES_PER_REQUEST = 3;
const RETRY_MEMORY_MS = HOUR_MS;
/* 가득 차면 새 요청은 기억하지 않는다. 그 요청의 재전송은 새 요청처럼 세므로 한도가 느슨해지지 않는다. */
const MAX_REMEMBERED_REQUESTS = 20_000;
const PRUNE_INTERVAL_MS = 60_000;

interface RememberedRequest {
  freeRetries: number;
  expiresAt: number;
}

const counter = new FixedWindowCounter();
const rememberedRequests = new Map<string, RememberedRequest>();
let nextRememberedPruneAt = 0;

function pruneRememberedRequests(now: number): void {
  if (now < nextRememberedPruneAt) return;
  for (const [key, remembered] of rememberedRequests) {
    if (remembered.expiresAt <= now) rememberedRequests.delete(key);
  }
  nextRememberedPruneAt = now + PRUNE_INTERVAL_MS;
}

function toCounterWindows(
  windows: readonly AccountRateWindow[],
  keyFor: (window: AccountRateWindow) => string,
): CounterWindow[] {
  const scale = testLimitScale();
  return windows.map((window) => ({ key: keyFor(window), limit: window.limit * scale, ms: window.ms }));
}

export interface AccountRateLimitOptions {
  /** 상담처럼 클라이언트가 재전송에 같은 값을 쓰는 요청 식별자. 있으면 재전송을 세지 않는다. */
  requestId?: string;
  now?: number;
}

/**
 * 계정 한도를 확인하고 이번 요청을 센다. 넘으면 429 ACCOUNT_RATE_LIMITED,
 * 사이트 전체 상한에 닿으면 429 SITE_RATE_LIMITED 를 던진다.
 */
export function assertAccountRateLimit(
  action: AccountRateAction,
  userId: string,
  options: AccountRateLimitOptions = {},
): void {
  const now = options.now ?? Date.now();
  const policy = ACCOUNT_RATE_LIMITS[action];
  pruneRememberedRequests(now);

  const retryKey = options.requestId ? `${action}:${userId}:${options.requestId}` : null;
  if (retryKey) {
    const remembered = rememberedRequests.get(retryKey);
    if (remembered && remembered.expiresAt > now && remembered.freeRetries > 0) {
      remembered.freeRetries -= 1;
      return;
    }
  }

  const accountWindows = toCounterWindows(policy.perAccount, (window) => `${action}:${window.name}:${userId}`);
  const siteWindows = toCounterWindows(policy.siteWide?.windows ?? [], (window) => `${action}:site-${window.name}`);
  const rejection = counter.consume([...accountWindows, ...siteWindows], now);
  if (rejection) {
    // 계정 한도와 사이트 전체 상한에 함께 걸리면 계정 한도로 안내한다. 남은 시간은 둘 중 늦게 풀리는 쪽이다.
    const accountBlocked = accountWindows.some((window) => rejection.blockedKeys.includes(window.key));
    if (accountBlocked || !policy.siteWide) {
      throw rateLimitError("ACCOUNT_RATE_LIMITED", policy.accountMessage, rejection.retryMs);
    }
    throw rateLimitError("SITE_RATE_LIMITED", policy.siteWide.message, rejection.retryMs);
  }

  if (retryKey && (rememberedRequests.size < MAX_REMEMBERED_REQUESTS || rememberedRequests.has(retryKey))) {
    rememberedRequests.set(retryKey, { freeRetries: FREE_RETRIES_PER_REQUEST, expiresAt: now + RETRY_MEMORY_MS });
  }
}

export function accountRateLimitBucketCountForTests(): number {
  return counter.size;
}

export function resetAccountRateLimitsForTests(): void {
  counter.clear();
  rememberedRequests.clear();
  nextRememberedPruneAt = 0;
}
