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
  /* 마지막 실패 순서를 유지한다. 기록을 고칠 때마다 지웠다가 다시 넣어 맨 뒤로 보낸다. */
  attempts: Map<string, LoginAttemptRecord>;
  queues: Map<string, Promise<void>>;
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
};
/* 개발 HMR 중 이전 형태의 객체가 남아 있어도 안전하게 보강한다. */
memory.queues ??= new Map<string, Promise<void>>();
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

function recordExpiresAtMs(record: LoginAttemptRecord): number {
  return record.locked_until_ms ?? record.last_failure_ms + FAILURE_RECORD_IDLE_MS;
}

function activeRecord(key: string, nowMs: number): LoginAttemptRecord | null {
  const record = memory.attempts.get(key);
  if (!record) return null;
  if (recordExpiresAtMs(record) <= nowMs) {
    memory.attempts.delete(key);
    return null;
  }
  return record;
}

/*
 * 임의 이메일로 Map 을 무한히 키우는 공격을 막는다. 상한에 닿으면 새 기록 하나가 들어갈
 * 자리를 만든다. 처음 보는 이메일의 로그인은 막지 않는다 — 전에는 표가 가득 차면 새 이메일을
 * 모두 막았는데, 그러면 약 1만 건의 요청만으로 실패 기록이 없는 정상 사용자(관리자·감독관 포함)
 * 전원의 로그인을 15분씩 되풀이해 막을 수 있었다.
 *
 * 비우는 순서는 이렇다.
 *   1. 만료된 기록. 기록은 마지막 실패 순서로 놓여 있고 잠금 시간과 실패 기록 유지 시간이 같아
 *      만료된 기록은 앞쪽에 모여 있다. 앞에서부터 만료되지 않은 기록을 만날 때까지만 본다.
 *   2. 잠기지 않은 기록 중 가장 오래된 것. 잠긴 기록을 먼저 밀어내면 새 이메일을 쏟아부어
 *      잠금을 일찍 풀 수 있으므로, 잠긴 기록은 표 전체가 잠긴 기록일 때만 밀어낸다.
 *   3. 가장 오래된 잠긴 기록.
 */
function ensureRoomForNewIdentifier(nowMs: number): void {
  if (memory.attempts.size < MAX_TRACKED_IDENTIFIERS) return;

  for (const [key, record] of memory.attempts) {
    if (recordExpiresAtMs(record) > nowMs) break;
    memory.attempts.delete(key);
  }
  if (memory.attempts.size < MAX_TRACKED_IDENTIFIERS) return;

  for (const [key, record] of memory.attempts) {
    if (record.locked_until_ms === null) {
      memory.attempts.delete(key);
      return;
    }
  }
  const oldestKey = memory.attempts.keys().next().value;
  if (oldestKey !== undefined) memory.attempts.delete(oldestKey);
}

/* 고친 기록을 맨 뒤로 보내 Map 순서가 마지막 실패 순서가 되게 한다. */
function saveRecord(key: string, record: LoginAttemptRecord): void {
  memory.attempts.delete(key);
  memory.attempts.set(key, record);
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
    saveRecord(key, {
      failures: MAX_FAILURES,
      locked_until_ms: lockedUntilMs,
      last_failure_ms: nowMs,
    });
    throw new LoginTemporarilyLockedError(retryAfterSeconds(lockedUntilMs, nowMs));
  }

  saveRecord(key, { failures, locked_until_ms: null, last_failure_ms: nowMs });
}

export function clearLoginFailures(email: string): void {
  memory.attempts.delete(identifierKey(email));
}

export function trackedLoginIdentifierCountForTests(): number {
  return memory.attempts.size;
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
}
