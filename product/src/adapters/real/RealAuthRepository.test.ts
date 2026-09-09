import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const db = vi.hoisted(() => ({
  queryWrite: vi.fn(),
  transactionQuery: vi.fn(),
  configured: vi.fn(() => true),
}));

vi.mock("@/server/postgresWrite", () => ({
  // 실제 모듈과 같은 판별 규칙 — SQLSTATE 다섯 자리가 붙은 오류만 DB 오류로 본다.
  isDatabaseError: (error: unknown) => {
    if (!(error instanceof Error)) return false;
    const code = (error as Error & { code?: unknown }).code;
    return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code);
  },
  isWriteDatabaseConfigured: db.configured,
  queryWrite: db.queryWrite,
  withWriteTransaction: async (
    _role: string,
    run: (transaction: { query: typeof db.transactionQuery }) => Promise<unknown>,
  ) => run({ query: db.transactionQuery }),
}));

import { RealAuthRepository } from "@/adapters/real/RealAuthRepository";
import { hashPassword } from "@/server/auth/passwordHash";

const repository = new RealAuthRepository();

function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    email: "Worker@Example.com",
    name: "김근로",
    auth_role: "user",
    password_hash: "",
    ...overrides,
  };
}

afterEach(() => {
  db.queryWrite.mockReset();
  db.transactionQuery.mockReset();
  db.configured.mockReturnValue(true);
});

describe("설정 확인", () => {
  it("접속 정보가 없으면 503으로 알린다", () => {
    db.configured.mockReturnValue(false);
    expect(() => repository.assertAvailable()).toThrowError(
      expect.objectContaining({ code: "AUTH_DATABASE_NOT_CONFIGURED", status: 503 }),
    );
  });
});

describe("가입", () => {
  const newUser = {
    email: "new@example.com",
    password: "long-enough-password",
    name: "새 사용자",
  };

  /*
   * 권한 등급을 요청에서 받으면 가입 요청 하나로 감독관 계정이 만들어진다.
   */
  it("권한 등급을 SQL 안에서 user 로 고정한다", async () => {
    db.queryWrite.mockResolvedValueOnce([{ id: "u1", email: newUser.email, name: newUser.name }]);

    const created = await repository.register(newUser);

    const sql = String(db.queryWrite.mock.calls[0]?.[1]);
    expect(sql).toContain("'user'");
    const values = db.queryWrite.mock.calls[0]?.[2] as unknown[];
    expect(values).not.toContain("admin");
    expect(values).not.toContain("inspector");
    expect(created.role).toBe("user");
  });

  it("비밀번호 원문을 저장하지 않는다", async () => {
    db.queryWrite.mockResolvedValueOnce([{ id: "u1", email: newUser.email, name: newUser.name }]);

    await repository.register(newUser);

    const values = db.queryWrite.mock.calls[0]?.[2] as unknown[];
    expect(values).not.toContain(newUser.password);
    expect(String(values[2])).toMatch(/^scrypt\$/);
  });

  /*
   * 0011 로 users.role·users.firm_id 가 사라졌다. 남은 컬럼만 쓰는지 확인한다.
   * 없는 컬럼에 넣으려 하면 가입이 통째로 실패한다.
   */
  it("사라진 컬럼(role·firm_id)을 쓰지 않는다", async () => {
    db.queryWrite.mockResolvedValueOnce([{ id: "u1", email: newUser.email, name: newUser.name }]);

    await repository.register(newUser);

    const sql = String(db.queryWrite.mock.calls[0]?.[1]);
    expect(sql).not.toMatch(/\bfirm_id\b/);
    // auth_role 은 남아 있어야 하므로 단독 role 컬럼만 골라서 본다.
    expect(sql).not.toMatch(/[(,]\s*role\s*[,)]/);
  });

  /*
   * 중복 이메일을 503 "DB 접근 실패"로 내보내면 사용자는 무엇을 고쳐야
   * 하는지 알 수 없다.
   */
  it("중복 이메일은 409 로 안내한다", async () => {
    db.queryWrite.mockRejectedValueOnce(Object.assign(new Error("duplicate"), { code: "23505" }));

    await expect(repository.register(newUser)).rejects.toMatchObject({
      code: "EMAIL_ALREADY_REGISTERED",
      status: 409,
    });
  });

  /*
   * 모르는 SQLSTATE 를 그럴듯한 안내로 바꾸면 원인이 가려진다.
   * 예전에는 외래키·CHECK 위반을 사업장 오류로 옮겼지만, 0011 로 그 경로가
   * 사라졌으므로 이제는 손대지 않고 그대로 올려보낸다.
   */
  it("모르는 DB 오류는 가입 안내로 바꾸지 않는다", async () => {
    db.queryWrite.mockRejectedValueOnce(Object.assign(new Error("fk"), { code: "23503" }));

    await expect(repository.register(newUser)).rejects.toMatchObject({ code: "23503" });
  });
});

describe("로그인", () => {
  it("이메일을 대소문자 무시하고 찾는다", async () => {
    const stored = await hashPassword("correct-password");
    db.queryWrite.mockResolvedValueOnce([userRow({ password_hash: stored })]);

    await repository.authenticate("WORKER@example.COM", "correct-password");

    const sql = String(db.queryWrite.mock.calls[0]?.[1]);
    expect(sql).toContain("lower(email) = lower($1)");
  });

  /*
   * 권한 등급은 auth_role 하나뿐이다. 예전에는 직업 구분을 담는 role 컬럼이
   * 따로 있어서 둘을 헷갈리면 일반 사용자에게 감독관 화면이 열렸다.
   * 0011 로 role 은 사라졌지만, 같은 이름의 컬럼이 다시 생겼을 때 실수로
   * 권한에 연결되지 않도록 확인은 남겨 둔다.
   */
  it("권한 등급은 auth_role 에서 가져오고 직업 구분은 쓰지 않는다", async () => {
    const stored = await hashPassword("correct-password");
    db.queryWrite.mockResolvedValueOnce([
      userRow({ auth_role: "inspector", password_hash: stored }),
    ]);

    const user = await repository.authenticate("worker@example.com", "correct-password");

    expect(user.role).toBe("inspector");
    expect(String(db.queryWrite.mock.calls[0]?.[1])).toContain("auth_role");
    // 직업 구분 컬럼(role)만 단독으로 선택하지 않는다.
    expect(String(db.queryWrite.mock.calls[0]?.[1])).not.toMatch(/,\s*role\s*,/);
  });

  it("화면 이름은 users.name 에서 가져온다", async () => {
    const stored = await hashPassword("correct-password");
    db.queryWrite.mockResolvedValueOnce([userRow({ name: "김근로", password_hash: stored })]);

    const user = await repository.authenticate("worker@example.com", "correct-password");
    expect(user.display_name).toBe("김근로");
    expect(user.user_id).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("비밀번호가 틀리면 거부한다", async () => {
    const stored = await hashPassword("correct-password");
    db.queryWrite.mockResolvedValueOnce([userRow({ password_hash: stored })]);

    await expect(repository.authenticate("worker@example.com", "wrong")).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
      status: 401,
    });
  });

  /*
   * 없는 계정과 틀린 비밀번호가 같은 응답이어야 한다.
   * 다르면 어떤 이메일이 가입돼 있는지 하나씩 알아낼 수 있다.
   */
  it("없는 계정도 틀린 비밀번호와 같은 오류를 돌려준다", async () => {
    db.queryWrite.mockResolvedValueOnce([]);

    await expect(repository.authenticate("nobody@example.com", "any")).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
      status: 401,
    });
  });

  it("모르는 권한 등급은 로그인시키지 않는다", async () => {
    const stored = await hashPassword("correct-password");
    db.queryWrite.mockResolvedValueOnce([
      userRow({ auth_role: "superadmin", password_hash: stored }),
    ]);

    await expect(
      repository.authenticate("worker@example.com", "correct-password"),
    ).rejects.toMatchObject({ code: "AUTH_ROLE_UNSUPPORTED" });
  });

  it("비밀번호 저장값이 비어 있어도 예외 없이 로그인 실패로 처리한다", async () => {
    db.queryWrite.mockResolvedValueOnce([userRow({ password_hash: "" })]);

    await expect(repository.authenticate("worker@example.com", "any")).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });
  });
});

describe("세션 발급", () => {
  it("기존 세션 무효화와 새 세션 저장을 한 트랜잭션으로 처리한다", async () => {
    db.transactionQuery.mockResolvedValue([]);

    await repository.issueSession({
      user_id: "user-1",
      email: "worker@example.com",
      display_name: "김근로",
      role: "user",
    });

    const statements = db.transactionQuery.mock.calls.map((call) => String(call[0]));
    expect(statements[0]).toContain("UPDATE sessions");
    expect(statements[0]).toContain("revoked_at = now()");
    expect(statements[1]).toContain("INSERT INTO sessions");
  });

  /* 원문 토큰이 DB 로 넘어가면 유출 시 그대로 남의 세션이 된다. */
  it("원문 토큰을 저장하지 않고 해시만 저장한다", async () => {
    db.transactionQuery.mockResolvedValue([]);

    const session = await repository.issueSession({
      user_id: "user-1",
      email: "worker@example.com",
      display_name: "김근로",
      role: "user",
    });

    const insertValues = db.transactionQuery.mock.calls[1]?.[1] as unknown[];
    expect(insertValues).not.toContain(session.token);
    expect(String(insertValues[0])).toMatch(/^[0-9a-f]{64}$/);
    expect(session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("세션 확인", () => {
  it("만료·무효 세션을 조회에서 걸러낸다", async () => {
    db.queryWrite.mockResolvedValueOnce([]);

    await repository.resolveSession("A".repeat(43));

    const sql = String(db.queryWrite.mock.calls[0]?.[1]);
    expect(sql).toContain("revoked_at IS NULL");
    expect(sql).toContain("expires_at > now()");
  });

  it("형식이 맞지 않는 토큰은 DB 를 조회하지 않는다", async () => {
    await expect(repository.resolveSession("too-short")).resolves.toBeNull();
    await expect(repository.resolveSession("")).resolves.toBeNull();
    expect(db.queryWrite).not.toHaveBeenCalled();
  });

  it("세션이 살아 있으면 사용자 정보를 돌려준다", async () => {
    db.queryWrite.mockResolvedValueOnce([
      {
        user_id: "user-1",
        email: "worker@example.com",
        name: "김근로",
        auth_role: "admin",
        expires_at: new Date("2026-09-05T00:00:00.000Z"),
        last_seen_at: new Date(),
      },
    ]);

    const resolved = await repository.resolveSession("A".repeat(43));

    expect(resolved?.user.role).toBe("admin");
    expect(resolved?.user.display_name).toBe("김근로");
    expect(resolved?.expires_at).toBe("2026-09-05T00:00:00.000Z");
  });

  /*
   * 인증된 요청마다 DB 쓰기가 일어나면 조회 위주 화면에서도 쓰기가 계속 발생한다.
   */
  it("마지막 접속 시각이 최근이면 다시 쓰지 않는다", async () => {
    db.queryWrite.mockResolvedValueOnce([
      {
        user_id: "user-1",
        email: "worker@example.com",
        name: "김근로",
        auth_role: "user",
        expires_at: new Date(Date.now() + 3_600_000),
        last_seen_at: new Date(),
      },
    ]);

    await repository.resolveSession("A".repeat(43));
    expect(db.queryWrite).toHaveBeenCalledTimes(1);
  });

  it("마지막 접속 시각이 오래됐으면 갱신한다", async () => {
    db.queryWrite
      .mockResolvedValueOnce([
        {
          user_id: "user-1",
          email: "worker@example.com",
          name: "김근로",
          auth_role: "user",
          expires_at: new Date(Date.now() + 3_600_000),
          last_seen_at: new Date(Date.now() - 30 * 60_000),
        },
      ])
      .mockResolvedValueOnce([]);

    await repository.resolveSession("A".repeat(43));

    expect(db.queryWrite).toHaveBeenCalledTimes(2);
    expect(String(db.queryWrite.mock.calls[1]?.[1])).toContain("last_seen_at = now()");
  });
});

describe("로그아웃", () => {
  /* 행을 지우면 언제 로그아웃했는지가 남지 않아 나중에 추적할 수 없다. */
  it("세션 행을 지우지 않고 무효 표시만 남긴다", async () => {
    db.queryWrite.mockResolvedValueOnce([]);

    await repository.revokeSession("A".repeat(43));

    const sql = String(db.queryWrite.mock.calls[0]?.[1]);
    expect(sql).toContain("revoked_at = now()");
    expect(sql).not.toContain("DELETE");
  });

  it("형식이 맞지 않는 토큰은 DB 를 조회하지 않는다", async () => {
    await repository.revokeSession("bad-token");
    expect(db.queryWrite).not.toHaveBeenCalled();
  });
});
