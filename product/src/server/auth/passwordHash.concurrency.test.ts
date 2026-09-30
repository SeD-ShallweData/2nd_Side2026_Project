import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/*
 * scrypt 를 손으로 끝내는 가짜로 바꿔, 동시에 몇 개가 계산 중인지 정확히 본다.
 * 실제 해시 형식과 대조는 passwordHash.test.ts 가 확인한다.
 */
const pendingHashes = vi.hoisted(() => [] as Array<() => void>);

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    scrypt: (
      _password: string,
      _salt: Buffer,
      keyLength: number,
      _options: unknown,
      callback: (error: Error | null, derived: Buffer) => void,
    ) => {
      pendingHashes.push(() => callback(null, Buffer.alloc(keyLength, 7)));
    },
  };
});

import { hashPassword, verifyPassword } from "@/server/auth/passwordHash";

const MAX_CONCURRENT = 2;
const MAX_QUEUED = 50;

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function finishAll(): Promise<void> {
  while (pendingHashes.length > 0) {
    pendingHashes.shift()!();
    await flush();
  }
}

afterEach(async () => {
  await finishAll();
  vi.useRealTimers();
});

describe("비밀번호 해시 동시 실행 상한", () => {
  it("한 번에 두 개만 계산하고 세 번째는 자리가 날 때까지 기다린다", async () => {
    const first = hashPassword("first-password");
    const second = hashPassword("second-password");
    const third = hashPassword("third-password");
    await flush();
    expect(pendingHashes).toHaveLength(MAX_CONCURRENT);

    pendingHashes.shift()!();
    await expect(first).resolves.toMatch(/^scrypt\$/);
    await flush();
    expect(pendingHashes).toHaveLength(MAX_CONCURRENT);

    await finishAll();
    await expect(Promise.all([second, third])).resolves.toHaveLength(2);
  });

  it("대기 줄이 가득 차면 계산하지 않고 곧바로 503 AUTH_BUSY 로 돌려보낸다", async () => {
    const stored = hashPassword("stored-password");
    await flush();
    pendingHashes.shift()!();
    const storedHash = await stored;

    const accepted = Array.from({ length: MAX_CONCURRENT + MAX_QUEUED }, (_, index) => hashPassword(`queued-${index}`));
    await flush();
    expect(pendingHashes).toHaveLength(MAX_CONCURRENT);

    // 계정이 있을 때의 대조도 같은 줄을 선다.
    await expect(verifyPassword("stored-password", storedHash)).rejects.toMatchObject({
      code: "AUTH_BUSY",
      status: 503,
      retryable: true,
    });
    expect(pendingHashes).toHaveLength(MAX_CONCURRENT);

    await finishAll();
    await expect(Promise.all(accepted)).resolves.toHaveLength(MAX_CONCURRENT + MAX_QUEUED);
  });

  it("5초 넘게 기다린 요청은 AUTH_BUSY 로 끝내고, 계산 자리 수는 어긋나지 않는다", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const running = [hashPassword("running-1"), hashPassword("running-2")];
    const waiting = hashPassword("waiting").catch((error: unknown) => error);
    await flush();
    expect(pendingHashes).toHaveLength(MAX_CONCURRENT);

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(waiting).resolves.toMatchObject({ code: "AUTH_BUSY", status: 503 });

    await finishAll();
    await Promise.all(running);

    // 포기한 요청이 자리를 차지하지 않았으므로 새 요청 두 개가 곧바로 계산을 시작한다.
    const next = [hashPassword("next-1"), hashPassword("next-2")];
    await flush();
    expect(pendingHashes).toHaveLength(MAX_CONCURRENT);
    await finishAll();
    await expect(Promise.all(next)).resolves.toHaveLength(2);
  });
});
