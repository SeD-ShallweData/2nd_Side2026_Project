/*
 * 큰 테이블 집계(임금체불 553,598행 · 산업재해 515,608행)를 요청마다 다시 세지 않도록
 * 프로세스 메모리에 잠깐 들고 있는다. 키에 서비스 배치 ID를 넣으므로 배치를 전환하면
 * 새 키로 다시 센다. 같은 키를 동시에 요청하면 한 번만 조회한다.
 *
 * 실패한 조회는 캐시에 남기지 않는다 — 권한이 복구되면 다음 요청에서 바로 다시 읽는다.
 */
interface Entry {
  expiresAt: number;
  promise: Promise<unknown>;
}

const entries = new Map<string, Entry>();
const MAX_ENTRIES = 64;

export function cachedAggregate<T>(key: string, ttlMs: number, load: () => Promise<T>, now = Date.now()): Promise<T> {
  const hit = entries.get(key);
  if (hit && hit.expiresAt > now) return hit.promise as Promise<T>;

  const promise = load();
  entries.set(key, { expiresAt: now + ttlMs, promise });
  promise.catch(() => {
    if (entries.get(key)?.promise === promise) entries.delete(key);
  });
  if (entries.size > MAX_ENTRIES) {
    for (const [staleKey, entry] of entries) {
      if (entry.expiresAt <= now || entries.size > MAX_ENTRIES) entries.delete(staleKey);
      if (entries.size <= MAX_ENTRIES) break;
    }
  }
  return promise;
}

/** 테스트 전용. */
export function clearAggregateCache(): void {
  entries.clear();
}
