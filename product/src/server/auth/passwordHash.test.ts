import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { hashPassword, verifyPassword } from "@/server/auth/passwordHash";

describe("비밀번호 저장 형식", () => {
  it("같은 비밀번호라도 저장값이 매번 다르다", async () => {
    const first = await hashPassword("correct horse battery staple");
    const second = await hashPassword("correct horse battery staple");

    expect(first).not.toBe(second);
    await expect(verifyPassword("correct horse battery staple", first)).resolves.toBe(true);
    await expect(verifyPassword("correct horse battery staple", second)).resolves.toBe(true);
  });

  it("저장값에 비밀번호 원문이 남지 않는다", async () => {
    const stored = await hashPassword("my-secret-password");
    expect(stored).not.toContain("my-secret-password");
  });

  it("알고리즘과 매개변수를 함께 적는다", async () => {
    const stored = await hashPassword("password");
    const [algorithm, cost, blockSize, parallelization, salt, hash] = stored.split("$");

    expect(algorithm).toBe("scrypt");
    expect(Number(cost)).toBeGreaterThanOrEqual(16_384);
    expect(Number(blockSize)).toBe(8);
    expect(Number(parallelization)).toBe(1);
    expect(Buffer.from(salt ?? "", "base64").length).toBe(16);
    expect(Buffer.from(hash ?? "", "base64").length).toBe(32);
  });

  it("틀린 비밀번호는 거부한다", async () => {
    const stored = await hashPassword("right-password");
    await expect(verifyPassword("wrong-password", stored)).resolves.toBe(false);
    await expect(verifyPassword("", stored)).resolves.toBe(false);
  });

  it("유니코드 표기가 달라도 같은 비밀번호로 본다", async () => {
    // 조합형과 완성형으로 각각 입력해도 같은 글자다.
    const composed = "비밀번호";
    const decomposed = composed.normalize("NFD");

    const stored = await hashPassword(composed);
    await expect(verifyPassword(decomposed, stored)).resolves.toBe(true);
  });

  /*
   * 형식이 깨진 값에서 예외를 던지면, "계정은 있는데 저장값이 이상한 경우"가
   * 일반 로그인 실패와 다른 응답으로 갈라져 계정 존재 여부가 드러난다.
   */
  it.each([
    "",
    "not-a-hash",
    "scrypt$16384$8$1$onlyfiveparts",
    "bcrypt$16384$8$1$c2FsdA==$aGFzaA==",
    "scrypt$0$8$1$c2FsdA==$aGFzaA==",
    "scrypt$16384$8$1$$aGFzaA==",
  ])("형식이 깨진 저장값은 예외 없이 false 로 처리한다: %s", async (stored) => {
    await expect(verifyPassword("password", stored)).resolves.toBe(false);
  });

  /* 조작된 값으로 서버 메모리를 고갈시키지 못하게 상한을 둔다. */
  it("터무니없는 매개변수가 든 저장값은 계산하지 않고 거부한다", async () => {
    const started = Date.now();
    await expect(verifyPassword("password", "scrypt$1073741824$32$16$c2FsdA==$aGFzaA==")).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
