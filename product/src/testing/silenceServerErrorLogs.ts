import { afterEach, beforeEach, type MockInstance, vi } from "vitest";

/*
 * 5xx 경로를 일부러 부르는 테스트(저장 한도 507, DB 미설정 503 등)에서 서버 오류 기록 줄만 삼킨다.
 *
 * 운영에서는 journald 로 가는 JSON 한 줄(utils/errors.ts, postgres.ts, 계약서 분석 상류 기록)이라
 * 테스트에서는 CI 출력만 어지럽힌다. 그 밖의 console.error 는 그대로 내보내 실제 문제를 가리지 않는다.
 * 테스트 파일 맨 위(또는 describe 안)에서 한 번 부르면 테스트마다 걸고 푼다.
 */
const SERVER_ERROR_LOG_EVENTS = new Set([
  "api_error",
  "api_error_log_suppressed",
  "readonly_query_failed",
  "contract_upstream_failed",
]);

function isServerErrorLogLine(args: unknown[]): boolean {
  const [line] = args;
  if (args.length !== 1 || typeof line !== "string" || !line.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(line) as { event?: unknown };
    return typeof parsed.event === "string" && SERVER_ERROR_LOG_EVENTS.has(parsed.event);
  } catch {
    return false;
  }
}

export function silenceServerErrorLogs(): void {
  let spy: MockInstance<typeof console.error> | undefined;

  beforeEach(() => {
    const original = console.error.bind(console);
    spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      if (isServerErrorLogLine(args)) return;
      original(...args);
    });
  });

  afterEach(() => {
    spy?.mockRestore();
    spy = undefined;
  });
}
