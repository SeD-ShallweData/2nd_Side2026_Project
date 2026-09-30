import { redactErrorText } from "@/utils/redactErrorText";

export interface ErrorDetail {
  field?: string;
  reason: string;
}

export class ServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly retryable: boolean,
    public readonly details?: ErrorDetail[],
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

/*
 * 발생한 자리에서 이미 원인을 서버 로그에 남긴 오류라는 표시.
 *
 * postgres.ts 는 읽기 실패를 relation·pg_code 와 함께(readonly_query_failed), 계약서 분석은 상류
 * 원문을 정리해서(contract_upstream_failed) 남긴 뒤 ServiceError 로 바꿔 던진다. 원인 줄에는
 * request_id 가 없으므로 errorPayload 는 이 오류도 건너뛰지 않는다. 다만 원인 문구를 되풀이하지
 * 않고 request_id·상태·코드만 짧게 남긴다(cause_logged: true). 사용자가 알려 준 req_… 로 줄을
 * 찾은 뒤, 같은 시각의 원인 줄을 보면 된다.
 * 모듈이 번들마다 따로 로드돼도 같은 키가 되도록 Symbol.for 를 쓴다.
 */
const LOGGED_AT_SOURCE = Symbol.for("donworry.error.loggedAtSource");

export function markErrorLogged<T>(error: T): T {
  if (error && typeof error === "object") {
    try {
      Object.defineProperty(error, LOGGED_AT_SOURCE, { value: true, enumerable: false });
    } catch {
      // 얼린 객체라 표시를 못 붙이면 원인 문구가 한 번 더 남을 뿐이다.
    }
  }
  return error;
}

function isErrorLoggedAtSource(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && (error as Record<symbol, unknown>)[LOGGED_AT_SOURCE] === true,
  );
}

/*
 * 서버 오류 기록의 속도 상한. 장애가 나면 요청마다 같은 오류가 나므로, 1분에 30줄까지만 남기고
 * 나머지는 개수만 센다. 평소에는 5xx 가 거의 없어 이 상한에 닿지 않는다.
 *
 * 5xx 기록(api_error)뿐 아니라 발생한 자리에서 원인을 남기는 줄(readonly_query_failed,
 * contract_upstream_failed)도 이 상한을 함께 쓴다. 줄이 폭주해 journald 속도 제한(30초당 500줄)에
 * 걸리면 정작 필요한 기록이 버려지기 때문이다.
 */
const API_ERROR_LOG_WINDOW_MS = 60_000;
const API_ERROR_LOG_LIMIT_PER_WINDOW = 30;

const apiErrorLogWindow = { startedAt: 0, logged: 0, suppressed: 0 };
let suppressedReportTimer: ReturnType<typeof setTimeout> | null = null;

/* 건너뛴 줄 수를 한 줄로 알리고 센 값을 비운다. */
function reportSuppressedLogs(): void {
  if (suppressedReportTimer !== null) {
    clearTimeout(suppressedReportTimer);
    suppressedReportTimer = null;
  }
  if (apiErrorLogWindow.suppressed === 0) return;
  const suppressed = apiErrorLogWindow.suppressed;
  apiErrorLogWindow.suppressed = 0;
  console.error(JSON.stringify({
    event: "api_error_log_suppressed",
    suppressed,
    window_ms: API_ERROR_LOG_WINDOW_MS,
  }));
}

/*
 * 처음 건너뛸 때 창이 끝나는 시각에 한 번 알리도록 걸어 둔다. 다음 기록이 올 때만 알리면
 * 폭주 뒤에 조용해진 경우 건너뛴 개수가 끝내 남지 않는다. unref 로 걸어 프로세스 종료를 붙잡지 않는다.
 */
function scheduleSuppressedReport(now: number): void {
  if (suppressedReportTimer !== null) return;
  const delay = Math.max(0, apiErrorLogWindow.startedAt + API_ERROR_LOG_WINDOW_MS - now);
  const timer = setTimeout(() => {
    suppressedReportTimer = null;
    try {
      reportSuppressedLogs();
    } catch {
      // 기록에 실패해도 요청 처리와는 상관없다.
    }
  }, delay);
  (timer as unknown as { unref?: () => void }).unref?.();
  suppressedReportTimer = timer;
}

/*
 * 서버 오류 한 줄을 남겨도 되는지 묻는다. false 면 이번 줄은 남기지 않는다(개수만 센다).
 * 원인을 발생한 자리에서 남기는 곳(postgres.ts, 계약서 분석 상류 기록)도 이 함수를 거친다.
 * 요청 처리 중에 불리므로 스스로는 예외를 던지지 않는다.
 */
export function takeApiErrorLogSlot(now: number = Date.now()): boolean {
  if (now - apiErrorLogWindow.startedAt >= API_ERROR_LOG_WINDOW_MS) {
    apiErrorLogWindow.startedAt = now;
    apiErrorLogWindow.logged = 0;
    try {
      reportSuppressedLogs();
    } catch {
      // 알림을 못 남겨도 새 창은 연다.
    }
  }
  if (apiErrorLogWindow.logged >= API_ERROR_LOG_LIMIT_PER_WINDOW) {
    apiErrorLogWindow.suppressed += 1;
    scheduleSuppressedReport(now);
    return false;
  }
  apiErrorLogWindow.logged += 1;
  return true;
}

/* 테스트마다 속도 상한 창과 예약해 둔 알림을 비운다. */
export function resetApiErrorLogForTests(): void {
  if (suppressedReportTimer !== null) clearTimeout(suppressedReportTimer);
  suppressedReportTimer = null;
  apiErrorLogWindow.startedAt = 0;
  apiErrorLogWindow.logged = 0;
  apiErrorLogWindow.suppressed = 0;
}

/*
 * 5xx 응답을 만들 때 서버 로그에 한 줄을 남긴다. 사용자가 알려 준 request_id 로 원인을
 * 찾을 수 있게 하려는 것이다. 응답 본문에는 여전히 고정 문구만 나간다.
 *
 * pg 오류의 detail·hint 는 남기지 않는다. 사용자 이메일 같은 값이 섞여 온다.
 * SQLSTATE(pg_code)와 정리한 message 만 남긴다.
 */
function logServerError(error: unknown, requestId: string, status: number, code: string): void {
  if (!takeApiErrorLogSlot()) return;

  if (isErrorLoggedAtSource(error)) {
    // 원인은 발생한 자리에서 이미 남겼다. 원인 문구는 되풀이하지 않고, request_id 로 찾을 수 있게
    // 상태·코드만 남긴다.
    console.error(JSON.stringify({
      event: "api_error",
      request_id: requestId,
      status,
      code,
      cause_logged: true,
    }));
    return;
  }

  const candidate = error as { name?: unknown; message?: unknown; code?: unknown } | null;
  const isObject = candidate !== null && typeof candidate === "object";
  const errorName = isObject && typeof candidate.name === "string" && candidate.name
    ? candidate.name
    : typeof error;
  const rawMessage = isObject
    ? (typeof candidate.message === "string" ? candidate.message : "")
    : String(error);
  const pgCode = isObject && typeof candidate.code === "string" && /^[0-9A-Z]{5}$/.test(candidate.code)
    ? candidate.code
    : null;

  console.error(JSON.stringify({
    event: "api_error",
    request_id: requestId,
    status,
    code,
    error_name: errorName,
    pg_code: pgCode,
    message: redactErrorText(rawMessage),
  }));
}

export interface ErrorPayload {
  body: {
    error: {
      code: string;
      message: string;
      details?: ErrorDetail[];
      retryable: boolean;
      request_id: string;
    };
  };
  status: number;
}

function buildErrorPayload(error: unknown, requestId: string): ErrorPayload {
  if (error instanceof ServiceError) {
    return {
      body: {
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
          retryable: error.retryable,
          request_id: requestId,
        },
      },
      status: error.status,
    };
  }

  return {
    body: {
      error: {
        code: "INTERNAL_ERROR",
        message: "요청을 처리하는 중 오류가 발생했습니다.",
        retryable: true,
        request_id: requestId,
      },
    },
    status: 500,
  };
}

export function errorPayload(error: unknown): ErrorPayload {
  const requestId = `req_${crypto.randomUUID()}`;
  const payload = buildErrorPayload(error, requestId);
  if (payload.status >= 500) {
    try {
      logServerError(error, requestId, payload.status, payload.body.error.code);
    } catch {
      // 기록에 실패해도 오류 응답은 그대로 나가야 한다.
    }
  }
  return payload;
}
