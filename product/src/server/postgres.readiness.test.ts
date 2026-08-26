import { afterEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock("@/server/databaseConfig", () => ({
  getDatabaseConnectionString: () => "postgresql://bot:secret@db.test/wageguard",
}));

vi.mock("pg", () => ({
  Pool: class {
    query = database.query;
  },
}));

import { isDatabaseReady } from "@/server/postgres";

afterEach(() => {
  database.query.mockReset();
});

describe("PostgreSQL readiness", () => {
  it("최신 배치의 물리 행수와 산업재해 공개 뷰의 canonical 행수를 확인한다", async () => {
    database.query.mockResolvedValue({ rows: [{ ready: true }] });

    await expect(isDatabaseReady()).resolves.toBe(true);

    const sql = String(database.query.mock.calls[0]?.[0]);
    expect(sql.match(/\bcount\s*\(/gi)).toHaveLength(4);
    expect(sql).toContain("= 553598");
    expect(sql).toContain("= 515608");
    expect(sql).toContain("industrial_safety.v_llm_firm_safety_context");
  });

  it("검증 결과가 false이거나 DB 조회가 실패하면 준비되지 않은 것으로 처리한다", async () => {
    database.query.mockResolvedValueOnce({ rows: [{ ready: false }] });
    await expect(isDatabaseReady()).resolves.toBe(false);

    database.query.mockRejectedValueOnce(new Error("connection refused"));
    await expect(isDatabaseReady()).resolves.toBe(false);
  });
});
