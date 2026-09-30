import "server-only";

import { ServiceError } from "@/utils/errors";

export interface CounterWindow {
  /** 버킷 이름. 부르는 쪽이 동작·창·식별자를 붙여 서로 겹치지 않게 만든다. */
  key: string;
  limit: number;
  ms: number;
}

export interface CounterRejection {
  /** 한도에 닿은 창의 key. */
  blockedKeys: string[];
  /** 막힌 창이 모두 풀릴 때까지 남은 시간(ms). */
  retryMs: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const PRUNE_INTERVAL_MS = 60_000;

/*
 * 프로세스 메모리의 고정 창(fixed window) 카운터.
 *
 * 창마다 첫 요청 시각부터 창 길이만큼 센다. 모든 창을 먼저 확인하고, 하나라도 한도에 닿았으면
 * 어느 창도 올리지 않는다. 확인과 증가 사이에 await 가 없어 단일 프로세스에서는 동시 요청이
 * 몰려도 한도를 넘겨 통과시키지 않는다.
 *
 * 끝난 창은 1분에 한 번 훑어서 지운다. 식별자(계정·탭 표시값)가 늘어나는 만큼 버킷도 늘기 때문에,
 * 지우지 않으면 메모리가 계속 는다.
 */
export class FixedWindowCounter {
  private readonly buckets = new Map<string, Bucket>();
  private nextPruneAt = 0;

  /** 통과하면 모든 창을 1 올리고 null, 막히면 막힌 창과 남은 시간을 돌려준다. */
  consume(windows: readonly CounterWindow[], now: number): CounterRejection | null {
    this.prune(now);
    const blockedKeys: string[] = [];
    let retryMs = 0;
    for (const window of windows) {
      const bucket = this.buckets.get(window.key);
      if (bucket && bucket.resetAt > now && bucket.count >= window.limit) {
        blockedKeys.push(window.key);
        retryMs = Math.max(retryMs, bucket.resetAt - now);
      }
    }
    if (blockedKeys.length > 0) return { blockedKeys, retryMs };

    for (const window of windows) {
      const bucket = this.buckets.get(window.key);
      if (!bucket || bucket.resetAt <= now) this.buckets.set(window.key, { count: 1, resetAt: now + window.ms });
      else bucket.count += 1;
    }
    return null;
  }

  get size(): number {
    return this.buckets.size;
  }

  clear(): void {
    this.buckets.clear();
    this.nextPruneAt = 0;
  }

  private prune(now: number): void {
    if (now < this.nextPruneAt) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
    this.nextPruneAt = now + PRUNE_INTERVAL_MS;
  }
}

/** 한도 안내의 대기 시간. 1분 미만은 초, 1시간 미만은 분, 그 이상은 시간과 분으로 올려 적는다. */
export function formatRetryWait(seconds: number): string {
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${hours}시간` : `${hours}시간 ${restMinutes}분`;
}

/**
 * 한도 초과 429. 남은 시간은 안내 문장과 details.retry_after_seconds 에 함께 싣는다.
 * 라우트는 이 값을 Retry-After 헤더로도 내보낸다(utils/errors 의 retryAfterHeaders).
 */
export function rateLimitError(code: string, lead: string, retryMs: number): ServiceError {
  const seconds = Math.max(1, Math.ceil(retryMs / 1_000));
  return new ServiceError(
    code,
    `${lead} ${formatRetryWait(seconds)} 뒤에 다시 시도해 주세요.`,
    429,
    true,
    [{ field: "retry_after_seconds", reason: String(seconds) }],
  );
}

/**
 * 테스트 실행 중에는 한도를 크게 늘린다. 기존 테스트가 같은 계정으로 여러 번 호출해도 걸리지 않게
 * 하려는 것으로, publicRateLimit 과 같은 규칙이다. 한도 자체를 확인하는 테스트는 NODE_ENV 를
 * production 으로 바꿔서 실제 값을 쓴다.
 */
export function testLimitScale(): number {
  return process.env.NODE_ENV === "test" ? 10_000 : 1;
}
