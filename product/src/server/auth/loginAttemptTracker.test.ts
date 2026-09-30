import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  assertLoginAttemptAllowed,
  LoginTemporarilyLockedError,
  MAX_TRACKED_LOGIN_IDENTIFIERS,
  recordLoginFailure,
  resetLoginAttemptsForTests,
  setLoginAttemptCapacityForTests,
  trackedLoginIdentifierCountForTests,
  withLoginAttemptLock,
} from "@/server/auth/loginAttemptTracker";

/* 포화 동작은 작은 표로 확인한다. 실제 상한(10만 개)을 채우려면 키 계산만 1초가 넘게 걸린다. */
const MAX_TRACKED = 200;
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
   * 운영 상한에서는 피해자 이메일로 4번 틀린 뒤 실패 1번짜리 이메일 1만 개를 넣어도 표가 차지 않는다.
   * 로그인 실패는 비밀번호 해시(동시 2개)를 거쳐야 기록되므로 15분 안에 10만 개를 채우기도 어렵다.
   */
  it("실제 상한에서는 실패 1번짜리 이메일 1만 개를 넣어도 피해자의 실패 횟수가 이어져 잠긴다", () => {
    expect(MAX_TRACKED_LOGIN_IDENTIFIERS).toBe(100_000);
    for (let attempt = 1; attempt <= 4; attempt += 1) recordLoginFailure("victim@example.com", 0);
    for (let index = 0; index < 10_000; index += 1) recordLoginFailure(`junk-${index}@example.com`, 1);

    expect(trackedLoginIdentifierCountForTests()).toBe(10_001);
    expect(() => recordLoginFailure("victim@example.com", 2)).toThrow(LoginTemporarilyLockedError);
  });
});

describe("로그인 추적표가 가득 찼을 때", () => {
  beforeEach(() => {
    setLoginAttemptCapacityForTests(MAX_TRACKED);
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
      recordLoginFailure(`user-${MAX_TRACKED - 1}@example.com`, 0);
    }
    expect(() => recordLoginFailure(`user-${MAX_TRACKED - 1}@example.com`, 0))
      .toThrow(LoginTemporarilyLockedError);
  });

  /*
   * 가장 오래된 기록부터 비우면, 피해자 이메일로 4번 틀린 뒤 실패 1번짜리 이메일로 표를 넘쳐
   * 피해자 기록을 밀어낼 수 있었다. 그러면 5회 잠금 없이 계속 대입할 수 있다.
   */
  it("실패 1번짜리 이메일로 표를 넘쳐도 피해자의 실패 기록은 밀려나지 않는다", () => {
    for (let attempt = 1; attempt <= 4; attempt += 1) recordLoginFailure("victim@example.com", 0);
    for (let index = 0; index < MAX_TRACKED * 3; index += 1) {
      recordLoginFailure(`junk-${index}@example.com`, 1);
    }
    expect(trackedLoginIdentifierCountForTests()).toBe(MAX_TRACKED);

    expect(() => recordLoginFailure("victim@example.com", 2)).toThrow(LoginTemporarilyLockedError);
  });

  it("실패 1번짜리가 없으면 실패가 가장 적은 기록 가운데 가장 오래된 것을 비운다", () => {
    for (let attempt = 1; attempt <= 3; attempt += 1) recordLoginFailure("three@example.com", 0);
    for (let index = 1; index < MAX_TRACKED; index += 1) {
      recordLoginFailure(`two-${index}@example.com`, 1);
      recordLoginFailure(`two-${index}@example.com`, 1);
    }
    expect(trackedLoginIdentifierCountForTests()).toBe(MAX_TRACKED);

    recordLoginFailure("newcomer@example.com", 2);
    expect(trackedLoginIdentifierCountForTests()).toBe(MAX_TRACKED);

    // 가장 오래됐어도 실패가 더 많은 three 는 남아 두 번 더 틀리면 잠긴다.
    recordLoginFailure("three@example.com", 3);
    expect(() => recordLoginFailure("three@example.com", 3)).toThrow(LoginTemporarilyLockedError);
    // 실패 2번짜리 가운데 두 번째로 오래된 two-2 도 남아 세 번 더 틀리면 잠긴다.
    recordLoginFailure("two-2@example.com", 3);
    recordLoginFailure("two-2@example.com", 3);
    expect(() => recordLoginFailure("two-2@example.com", 3)).toThrow(LoginTemporarilyLockedError);
    // 가장 오래된 실패 2번짜리 two-1 이 비워졌으므로 처음부터 다시 센다.
    for (let attempt = 1; attempt <= 4; attempt += 1) recordLoginFailure("two-1@example.com", 4);
    expect(() => recordLoginFailure("two-1@example.com", 4)).toThrow(LoginTemporarilyLockedError);
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
