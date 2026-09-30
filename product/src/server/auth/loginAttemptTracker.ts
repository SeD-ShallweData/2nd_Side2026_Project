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
/*
 * 추적표 상한. 로그인 실패는 모두 비밀번호 해시(동시 2개, passwordHash.ts)를 거쳐야 기록되므로
 * 초당 수십 건이 한계다(이 Mac 실측 약 43건). 그 속도로는 10만 개를 채우는 데 약 39분이 걸려
 * 기록 유지 시간(15분) 안에 표를 가득 채울 수 없다. 키를 16바이트로 줄여 가득 차도 약 14MB 다.
 */
export const MAX_TRACKED_LOGIN_IDENTIFIERS = 100_000;

/* 테스트가 작은 표로 포화 동작을 확인할 때만 바꾼다. resetLoginAttemptsForTests 가 되돌린다. */
let trackedIdentifierCapacity = MAX_TRACKED_LOGIN_IDENTIFIERS;

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

/*
 * 원문 이메일을 메모리 키로 남기지 않는다. 입력은 서비스에서 이미 정규화된다.
 * 키는 HMAC 앞 16바이트(128비트)만 쓴다. 10만 개 사이에서 겹칠 확률은 무시할 만하고 메모리는 줄어든다.
 */
function identifierKey(email: string): string {
  return createHmac("sha256", memory.key_salt)
    .update(email.trim().toLocaleLowerCase("en-US"), "utf8")
    .digest()
    .subarray(0, 16)
    .toString("base64url");
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
 *   2. 잠기지 않은 기록 가운데 실패 횟수가 가장 적은 것, 같으면 가장 오래된 것.
 *      가장 오래된 것부터 비우면, 피해자 이메일로 4번 틀린 뒤 실패 1번짜리 이메일을 쏟아부어
 *      그 기록을 밀어내고 5회 잠금 없이 계속 대입할 수 있다. 실패가 적은 기록부터 비우면 쏟아부은
 *      기록끼리만 밀려난다. 실패 1번은 가장 적은 값이라 처음 만나는 즉시 비운다.
 *   3. 가장 오래된 잠긴 기록. 잠긴 기록을 먼저 밀어내면 새 이메일을 쏟아부어 잠금을 일찍 풀 수
 *      있으므로, 표 전체가 잠긴 기록일 때만 밀어낸다.
 * 표 끝까지 훑는 것은 실패 1번짜리가 없을 때뿐이다(10만 개에 약 4ms). 새 기록은 비밀번호 해시를
 * 거쳐야 생기므로 이 검사도 초당 수십 번을 넘지 않는다.
 */
function ensureRoomForNewIdentifier(nowMs: number): void {
  if (memory.attempts.size < trackedIdentifierCapacity) return;

  for (const [key, record] of memory.attempts) {
    if (recordExpiresAtMs(record) > nowMs) break;
    memory.attempts.delete(key);
  }
  if (memory.attempts.size < trackedIdentifierCapacity) return;

  let evictKey: string | undefined;
  let evictFailures = Number.POSITIVE_INFINITY;
  for (const [key, record] of memory.attempts) {
    if (record.locked_until_ms !== null || record.failures >= evictFailures) continue;
    evictKey = key;
    evictFailures = record.failures;
    if (evictFailures <= 1) break;
  }
  evictKey ??= memory.attempts.keys().next().value;
  if (evictKey !== undefined) memory.attempts.delete(evictKey);
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

export function setLoginAttemptCapacityForTests(capacity: number): void {
  trackedIdentifierCapacity = capacity;
}

export function resetLoginAttemptsForTests(): void {
  memory.attempts.clear();
  memory.queues.clear();
  trackedIdentifierCapacity = MAX_TRACKED_LOGIN_IDENTIFIERS;
}
