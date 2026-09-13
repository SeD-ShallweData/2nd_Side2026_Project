import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  assertLoginAttemptAllowed,
  LoginTemporarilyLockedError,
  recordLoginFailure,
  resetLoginAttemptsForTests,
  withLoginAttemptLock,
} from "@/server/auth/loginAttemptTracker";

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

  it("메모리 상한에서 활성 실패 기록을 밀어내지 않고 신규 식별자를 닫는다", () => {
    for (let index = 0; index < 10_000; index += 1) {
      recordLoginFailure(`user-${index}@example.com`, 0);
    }

    expect(() => recordLoginFailure("overflow@example.com", 0))
      .toThrow(LoginTemporarilyLockedError);
    expect(() => assertLoginAttemptAllowed("another-overflow@example.com", 0))
      .toThrow(LoginTemporarilyLockedError);

    for (let attempt = 2; attempt <= 4; attempt += 1) {
      recordLoginFailure("user-0@example.com", 0);
    }
    expect(() => recordLoginFailure("user-0@example.com", 0))
      .toThrow(LoginTemporarilyLockedError);
  });
});
