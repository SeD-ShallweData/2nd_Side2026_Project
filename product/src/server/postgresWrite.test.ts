import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pg = vi.hoisted(() => ({
  query: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
  connect: vi.fn(),
  constructed: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/server/databaseConfig", () => ({
  getAuthDatabaseConnectionString: () => "postgresql://wg_auth:secret@db.test/wageguard",
  getCommunityDatabaseConnectionString: () =>
    "postgresql://wg_community:secret@db.test/wageguard",
}));

vi.mock("pg", () => ({
  Pool: class {
    query = pg.query;
    connect = pg.connect;
    constructor(config: Record<string, unknown>) {
      pg.constructed.push(config);
    }
  },
}));

import {
  assertWriteStatementAllowed,
  isDatabaseError,
  isWriteDatabaseConfigured,
  queryWrite,
  resetWritePoolsForTest,
  WriteStatementBlockedError,
  withWriteTransaction,
} from "@/server/postgresWrite";

function sqlstateError(code: string): Error & { code: string } {
  return Object.assign(new Error("constraint violation"), { code });
}

beforeEach(() => {
  pg.connect.mockResolvedValue({ query: pg.clientQuery, release: pg.release });
});

afterEach(() => {
  pg.query.mockReset();
  pg.clientQuery.mockReset();
  pg.release.mockReset();
  pg.connect.mockReset();
  pg.constructed.length = 0;
  resetWritePoolsForTest();
});

describe("쓰기 문장 경계", () => {
  it.each([
    "SELECT id FROM posts WHERE id = $1",
    "WITH target AS (SELECT id FROM posts) UPDATE posts SET title = $1 FROM target",
    "INSERT INTO posts (title) VALUES ($1) RETURNING id",
    "UPDATE posts SET status = $1 WHERE id = $2",
    "DELETE FROM sessions WHERE expires_at < now()",
  ])("허용한다: %s", (sql) => {
    expect(() => assertWriteStatementAllowed(sql)).not.toThrow();
  });

  it.each([
    "DROP TABLE posts",
    "ALTER TABLE users ADD COLUMN x text",
    "TRUNCATE reports",
    "GRANT SELECT ON users TO wg_community",
    "REVOKE ALL ON posts FROM wg_bot",
    "CREATE TABLE tmp (id int)",
    "COPY posts FROM '/tmp/x.csv'",
    "DO $$ BEGIN END $$",
  ])("차단한다: %s", (sql) => {
    expect(() => assertWriteStatementAllowed(sql)).toThrow();
  });

  it("한 번에 여러 문장을 실행하지 못한다", () => {
    expect(() =>
      assertWriteStatementAllowed("DELETE FROM sessions WHERE id = $1; DROP TABLE users"),
    ).toThrow(/한 문장/);
  });

  it("끝에 붙은 세미콜론 하나는 허용한다", () => {
    expect(() => assertWriteStatementAllowed("SELECT 1;")).not.toThrow();
  });

  /*
   * 값은 전부 파라미터로 넘기므로 SQL 문자열에는 사용자 입력이 없다.
   * 그래도 리터럴을 먼저 지우지 않으면, 나중에 상수 문자열을 넣는 순간
   * 'drop' 같은 단어 때문에 정상 문장이 막힌다.
   */
  it("문자열 리터럴과 주석 안의 단어는 금지어로 보지 않는다", () => {
    expect(() =>
      assertWriteStatementAllowed("INSERT INTO posts (category) VALUES ('drop_off')"),
    ).not.toThrow();
    expect(() =>
      assertWriteStatementAllowed("SELECT id FROM posts -- grant 관련 조회\nWHERE id = $1"),
    ).not.toThrow();
  });
});

describe("롤별 연결", () => {
  it("인증과 커뮤니티가 서로 다른 접속 문자열과 이름으로 붙는다", async () => {
    pg.query.mockResolvedValue({ rows: [] });

    await queryWrite("auth", "SELECT 1");
    await queryWrite("community", "SELECT 1");

    expect(pg.constructed).toHaveLength(2);
    expect(pg.constructed[0]?.connectionString).toContain("wg_auth");
    expect(pg.constructed[0]?.application_name).toBe("donworry-product-auth");
    expect(pg.constructed[1]?.connectionString).toContain("wg_community");
    expect(pg.constructed[1]?.application_name).toBe("donworry-product-community");
  });

  /*
   * 읽기 전용 경로(server/postgres.ts)는 연결을 read only 로 잠근다.
   * 쓰기 경로가 같은 잠금을 물려받으면 INSERT 가 통째로 실패하므로,
   * 두 계층이 섞이지 않았다는 것을 연결 설정으로 확인한다.
   */
  it("읽기 전용 잠금을 물려받지 않는다", async () => {
    pg.query.mockResolvedValue({ rows: [] });
    await queryWrite("auth", "SELECT 1");

    expect(String(pg.constructed[0]?.options)).not.toContain("default_transaction_read_only");
    expect(String(pg.constructed[0]?.options)).toContain("statement_timeout");
  });

  it("같은 롤은 연결 pool을 재사용한다", async () => {
    pg.query.mockResolvedValue({ rows: [] });

    await queryWrite("community", "SELECT 1");
    await queryWrite("community", "SELECT 2");

    expect(pg.constructed).toHaveLength(1);
  });

  it("설정 여부를 롤별로 알려준다", () => {
    expect(isWriteDatabaseConfigured("auth")).toBe(true);
    expect(isWriteDatabaseConfigured("community")).toBe(true);
  });
});

describe("오류 처리", () => {
  /*
   * 제약 위반을 503으로 뭉개면 "이미 신고한 글입니다" 같은 안내를 만들 수 없다.
   * SQLSTATE가 붙은 오류는 서비스 계층까지 그대로 올라가야 한다.
   */
  it("제약 위반은 그대로 올려보낸다", async () => {
    pg.query.mockRejectedValueOnce(sqlstateError("23505"));

    await expect(queryWrite("community", "INSERT INTO reports (id) VALUES ($1)")).rejects.toMatchObject({
      code: "23505",
    });
  });

  it("연결 실패는 503으로 바꾸고 접속 정보를 노출하지 않는다", async () => {
    pg.query.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:5433"));

    await expect(queryWrite("auth", "SELECT 1")).rejects.toMatchObject({
      code: "DATABASE_UNAVAILABLE",
      status: 503,
    });

    await expect(queryWrite("auth", "SELECT 1").catch((e: Error) => e.message)).resolves.not.toContain(
      "wg_auth",
    );
  });
});

describe("트랜잭션", () => {
  it("성공하면 커밋한다", async () => {
    pg.clientQuery.mockResolvedValue({ rows: [{ id: "p1" }] });

    const result = await withWriteTransaction("community", async (transaction) => {
      await transaction.query("INSERT INTO reports (post_id) VALUES ($1)", ["p1"]);
      return "done";
    });

    expect(result).toBe("done");
    const statements = pg.clientQuery.mock.calls.map((call) => String(call[0]));
    expect(statements[0]).toBe("BEGIN");
    expect(statements.at(-1)).toBe("COMMIT");
    expect(pg.release).toHaveBeenCalledTimes(1);
  });

  it("실패하면 롤백하고 연결을 반납한다", async () => {
    pg.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith("INSERT")) throw sqlstateError("23505");
      return { rows: [] };
    });

    await expect(
      withWriteTransaction("community", async (transaction) => {
        await transaction.query("INSERT INTO reports (post_id) VALUES ($1)", ["p1"]);
      }),
    ).rejects.toMatchObject({ code: "23505" });

    expect(pg.clientQuery.mock.calls.map((call) => String(call[0]))).toContain("ROLLBACK");
    expect(pg.release).toHaveBeenCalledTimes(1);
  });

  it("차단된 문장은 DB 장애로 둔갑하지 않고 그대로 드러난다", async () => {
    pg.clientQuery.mockResolvedValue({ rows: [] });

    await expect(
      withWriteTransaction("auth", async (transaction) => {
        await transaction.query("DROP TABLE sessions");
      }),
    ).rejects.toBeInstanceOf(WriteStatementBlockedError);

    expect(pg.clientQuery.mock.calls.map((call) => String(call[0]))).toContain("ROLLBACK");
    expect(pg.release).toHaveBeenCalledTimes(1);
  });
});

describe("SQLSTATE 판별", () => {
  it("다섯 자리 코드가 붙은 오류만 DB 오류로 본다", () => {
    expect(isDatabaseError(sqlstateError("23505"))).toBe(true);
    expect(isDatabaseError(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe(false);
    expect(isDatabaseError(new Error("plain"))).toBe(false);
  });
});
