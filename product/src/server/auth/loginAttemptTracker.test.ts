import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  assertLoginAttemptAllowed,
  LoginTemporarilyLockedError,
  recordLoginFailure,
  resetLoginAttemptsForTests,
  trackedLoginIdentifierCountForTests,
  withLoginAttemptLock,
} from "@/server/auth/loginAttemptTracker";

const MAX_TRACKED = 10_000;
const FIFTEEN_MINUTES = 15 * 60 * 1_000;

function lockOut(email: string, nowMs: number): void {
  for (let attempt = 1; attempt <= 4; attempt += 1) recordLoginFailure(email, nowMs);
  try {
    recordLoginFailure(email, nowMs);
  } catch (error) {
    if (error instanceof LoginTemporarilyLockedError) return;
    throw error;
  }
  throw new Error(`${email} 이 다섯 번째 실패에서 잠기지 않았습니다.`);
}

afterEach(() => {
  resetLoginAttemptsForTests();
});

describe("로그인 실패 메모리 저장소", () => {
  it("같은 이메일의 비동기 로그인을 순서대로 한 번씩 실행한다", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withLoginAttemptLock("worker@example.com", async () => {
      events.push("first:start");
      markFirstStarted();
      await firstGate;
      events.push("first:end");
    });
    await firstStarted;

    const second = withLoginAttemptLock("WORKER@example.com", async () => {
      events.push("second");
    });
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second"]);
  });

  it("마지막 실패 후 15분이 지나면 잠기지 않은 누적 횟수를 초기화한다", () => {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      recordLoginFailure("worker@example.com", 0);
    }

    assertLoginAttemptAllowed("worker@example.com", 15 * 60 * 1_000);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      recordLoginFailure("worker@example.com", 15 * 60 * 1_000);
    }
    expect(() => recordLoginFailure("worker@example.com", 15 * 60 * 1_000))
      .toThrow(LoginTemporarilyLockedError);
  });

  /*
   * 전에는 표가 가득 차면 처음 보는 이메일을 모두 막았다. 그러면 약 1만 건의 요청으로
   * 실패 기록이 없는 정상 사용자 전원의 로그인을 15분씩 막을 수 있었다.
   */
  it("표가 가득 차도 처음 보는 이메일의 로그인을 막지 않고 가장 오래된 기록을 비운다", () => {
    for (let index = 0; index < MAX_TRACKED; index += 1) {
      recordLoginFailure(`user-${index}@example.com`, 0);
    }
    expect(trackedLoginIdentifierCountForTests()).toBe(MAX_TRACKED);

    expect(() => assertLoginAttemptAllowed("overflow@example.com", 0)).not.toThrow();
    expect(() => recordLoginFailure("overflow@example.com", 0)).not.toThrow();
    expect(trackedLoginIdentifierCountForTests()).toBe(MAX_TRACKED);

    // 가장 오래된 user-0 기록이 비워졌으므로 다섯 번을 새로 채워야 잠긴다.
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      recordLoginFailure("user-0@example.com", 0);
    }
    expect(() => recordLoginFailure("user-0@example.com", 0))
      .toThrow(LoginTemporarilyLockedError);

    // 비워지지 않은 기록의 실패 횟수는 그대로 이어진다.
    for (let attempt = 2; attempt <= 4; attempt += 1) {
      recordLoginFailure("user-9999@example.com", 0);
    }
    expect(() => recordLoginFailure("user-9999@example.com", 0))
      .toThrow(LoginTemporarilyLockedError);
  });

  it("표가 가득 차면 만료된 기록부터 비운다", () => {
    for (let index = 0; index < MAX_TRACKED; index += 1) {
      recordLoginFailure(`user-${index}@example.com`, 0);
    }

    recordLoginFailure("fresh@example.com", FIFTEEN_MINUTES);

    expect(trackedLoginIdentifierCountForTests()).toBe(1);
  });

  /*
   * 새 이메일을 쏟아부어 다른 계정의 잠금을 일찍 풀지 못하게 한다.
   * 잠기지 않은 기록이 하나라도 있으면 그것부터 비운다.
   */
  it("잠긴 기록은 잠기지 않은 기록을 모두 비운 뒤에야 밀려난다", () => {
    lockOut("victim@example.com", 0);
    for (let index = 1; index < MAX_TRACKED; index += 1) {
      recordLoginFailure(`filler-${index}@example.com`, 1);
    }
    expect(trackedLoginIdentifierCountForTests()).toBe(MAX_TRACKED);

    for (let index = 0; index < MAX_TRACKED; index += 1) {
      recordLoginFailure(`flood-${index}@example.com`, 2);
    }

    expect(trackedLoginIdentifierCountForTests()).toBe(MAX_TRACKED);
    expect(() => assertLoginAttemptAllowed("victim@example.com", 3))
      .toThrow(LoginTemporarilyLockedError);
  });

  it("표 전체가 잠긴 기록이면 가장 오래된 잠긴 기록을 비운다", () => {
    for (let index = 0; index < MAX_TRACKED; index += 1) {
      lockOut(`locked-${index}@example.com`, index);
    }

    expect(() => recordLoginFailure("newcomer@example.com", MAX_TRACKED)).not.toThrow();

    expect(() => assertLoginAttemptAllowed("locked-0@example.com", MAX_TRACKED)).not.toThrow();
    expect(() => assertLoginAttemptAllowed("locked-1@example.com", MAX_TRACKED))
      .toThrow(LoginTemporarilyLockedError);
  });
});
