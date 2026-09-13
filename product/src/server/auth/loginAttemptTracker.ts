import "server-only";

import { createHmac, randomBytes } from "node:crypto";

import { ServiceError } from "@/utils/errors";

interface LoginAttemptRecord {
  failures: number;
  locked_until_ms: number | null;
  last_failure_ms: number;
}

interface LoginAttemptMemory {
  key_salt: Buffer;
  attempts: Map<string, LoginAttemptRecord>;
  queues: Map<string, Promise<void>>;
  next_capacity_check_ms: number;
}

const MAX_FAILURES = 5;
const LOCK_DURATION_MS = 15 * 60 * 1_000;
const FAILURE_RECORD_IDLE_MS = 15 * 60 * 1_000;
const MAX_TRACKED_IDENTIFIERS = 10_000;

/*
 * 현재 운영은 단일 Next.js 프로세스다. 로그인 잠금도 같은 프로세스 메모리에
 * 두며, 개발 중 모듈 재로딩에는 유지되도록 globalThis 를 사용한다.
 * 프로세스·VM 재시작과 다중 인스턴스에는 공유되지 않는 의도적인 임시 설계다.
 */
const loginAttemptGlobal = globalThis as typeof globalThis & {
  __donworryLoginAttemptMemory?: LoginAttemptMemory;
};

const memory = loginAttemptGlobal.__donworryLoginAttemptMemory ?? {
  key_salt: randomBytes(32),
  attempts: new Map<string, LoginAttemptRecord>(),
  queues: new Map<string, Promise<void>>(),
  next_capacity_check_ms: 0,
};
/* 개발 HMR 중 이전 형태의 객체가 남아 있어도 안전하게 보강한다. */
memory.queues ??= new Map<string, Promise<void>>();
memory.next_capacity_check_ms ??= 0;
loginAttemptGlobal.__donworryLoginAttemptMemory = memory;

/* 원문 이메일을 메모리 키로 남기지 않는다. 입력은 서비스에서 이미 정규화된다. */
function identifierKey(email: string): string {
  return createHmac("sha256", memory.key_salt)
    .update(email.trim().toLocaleLowerCase("en-US"), "utf8")
    .digest("hex");
}

function retryAfterSeconds(lockedUntilMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((lockedUntilMs - nowMs) / 1_000));
}

function activeRecord(key: string, nowMs: number): LoginAttemptRecord | null {
  const record = memory.attempts.get(key);
  if (!record) return null;
  const expiresAtMs = record.locked_until_ms ?? record.last_failure_ms + FAILURE_RECORD_IDLE_MS;
  if (expiresAtMs <= nowMs) {
    memory.attempts.delete(key);
    return null;
  }
  return record;
}

/*
 * 임의 이메일로 Map 을 무한히 키우는 공격을 막는다. 상한에 닿으면 만료된 기록만
 * 지운다. 활성 실패 기록을 밀어내면 공격자가 5회 잠금을 우회할 수 있으므로,
 * 여전히 가득 찼다면 가장 먼저 비는 시각까지 신규 식별자의 로그인을 닫는다.
 */
function ensureRoomForNewIdentifier(nowMs: number): void {
  if (memory.attempts.size < MAX_TRACKED_IDENTIFIERS) {
    memory.next_capacity_check_ms = 0;
    return;
  }
  if (memory.next_capacity_check_ms > nowMs) {
    throw new LoginTemporarilyLockedError(
      retryAfterSeconds(memory.next_capacity_check_ms, nowMs),
    );
  }

  let earliestExpiryMs = Number.POSITIVE_INFINITY;
  for (const [key, record] of memory.attempts) {
    const expiresAtMs = record.locked_until_ms ?? record.last_failure_ms + FAILURE_RECORD_IDLE_MS;
    if (expiresAtMs <= nowMs) {
      memory.attempts.delete(key);
    } else {
      earliestExpiryMs = Math.min(earliestExpiryMs, expiresAtMs);
    }
  }
  if (memory.attempts.size < MAX_TRACKED_IDENTIFIERS) {
    memory.next_capacity_check_ms = 0;
    return;
  }

  memory.next_capacity_check_ms = earliestExpiryMs;
  throw new LoginTemporarilyLockedError(retryAfterSeconds(earliestExpiryMs, nowMs));
}

export class LoginTemporarilyLockedError extends ServiceError {
  constructor(public readonly retryAfterSeconds: number) {
    super(
      "LOGIN_TEMPORARILY_LOCKED",
      "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.",
      429,
      true,
    );
    this.name = "LoginTemporarilyLockedError";
  }
}

export function assertLoginAttemptAllowed(email: string, nowMs = Date.now()): void {
  const key = identifierKey(email);
  const record = activeRecord(key, nowMs);
  if (record && record.locked_until_ms !== null) {
    throw new LoginTemporarilyLockedError(retryAfterSeconds(record.locked_until_ms, nowMs));
  }
  if (!record) ensureRoomForNewIdentifier(nowMs);
}

export function recordLoginFailure(email: string, nowMs = Date.now()): void {
  const key = identifierKey(email);
  const record = activeRecord(key, nowMs);

  /* 잠금 중 요청은 종료 시각을 연장하지 않는다. */
  if (record && record.locked_until_ms !== null) {
    throw new LoginTemporarilyLockedError(retryAfterSeconds(record.locked_until_ms, nowMs));
  }

  if (!record) ensureRoomForNewIdentifier(nowMs);

  const failures = (record?.failures ?? 0) + 1;
  if (failures >= MAX_FAILURES) {
    const lockedUntilMs = nowMs + LOCK_DURATION_MS;
    memory.attempts.set(key, {
      failures: MAX_FAILURES,
      locked_until_ms: lockedUntilMs,
      last_failure_ms: nowMs,
    });
    throw new LoginTemporarilyLockedError(retryAfterSeconds(lockedUntilMs, nowMs));
  }

  memory.attempts.set(key, { failures, locked_until_ms: null, last_failure_ms: nowMs });
}

export function clearLoginFailures(email: string): void {
  memory.attempts.delete(identifierKey(email));
  if (memory.attempts.size < MAX_TRACKED_IDENTIFIERS) memory.next_capacity_check_ms = 0;
}

/*
 * 같은 이메일의 로그인은 자격 증명 확인부터 세션 발급까지 한 번에 하나만
 * 실행한다. 그래야 동시 요청이 5회 제한을 건너뛰거나 잠금 뒤 세션을 만들지 못한다.
 */
export async function withLoginAttemptLock<T>(email: string, action: () => Promise<T>): Promise<T> {
  const key = identifierKey(email);
  const waitForTurn = memory.queues.get(key) ?? Promise.resolve();
  let releaseTurn!: () => void;
  const myTurn = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  const queueTail = waitForTurn.then(() => myTurn);
  memory.queues.set(key, queueTail);

  await waitForTurn;
  try {
    return await action();
  } finally {
    releaseTurn();
    if (memory.queues.get(key) === queueTail) memory.queues.delete(key);
  }
}

export function resetLoginAttemptsForTests(): void {
  memory.attempts.clear();
  memory.queues.clear();
  memory.next_capacity_check_ms = 0;
}
