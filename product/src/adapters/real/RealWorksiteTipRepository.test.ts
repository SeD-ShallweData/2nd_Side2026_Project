import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const db = vi.hoisted(() => ({
  configured: vi.fn(() => true),
  queryWrite: vi.fn(),
  transactionQuery: vi.fn(),
  withWriteTransaction: vi.fn(),
}));

vi.mock("@/server/postgresWrite", () => ({
  isWriteDatabaseConfigured: db.configured,
  queryWrite: db.queryWrite,
  withWriteTransaction: db.withWriteTransaction,
}));

import { RealWorksiteTipRepository } from "@/adapters/real/RealWorksiteTipRepository";
import type { NewWorksiteTip } from "@/domain/worksiteTip";
import { ServiceError } from "@/utils/errors";

const TIP_ID = "11111111-1111-4111-8111-111111111111";
const ATTACHMENT_ID = "22222222-2222-4222-8222-222222222222";
const REPORTER_ID = "33333333-3333-4333-8333-333333333333";
const STORAGE_KEY = `2026/09/${TIP_ID}/${ATTACHMENT_ID}`;
const SUBMITTED_AT = "2026-09-12T03:04:05.000Z";

const originalBytes = Uint8Array.from([0xff, 0xd8, 0x45, 0x58, 0x49, 0x46, 0xff, 0xd9]);
const inspectorBytes = Uint8Array.from([0xff, 0xd8, 0x53, 0x41, 0x46, 0x45, 0xff, 0xd9]);
const sha256 = createHash("sha256").update(originalBytes).digest("hex");

let storageRoot = "";
const previousStorageRoot = process.env.WORKSITE_TIP_STORAGE_ROOT;

function input(): NewWorksiteTip {
  return {
    tip_id: TIP_ID,
    reporter_id: REPORTER_ID,
    title: "안전모 미지급",
    body: "현장에 안전모가 부족합니다.",
    company_context: {
      company_id: "f0000000000000a2",
      region: "경기",
      industry: "건설업",
    },
    submitted_at: SUBMITTED_AT,
    attachments: [
      {
        attachment_id: ATTACHMENT_ID,
        storage_key: STORAGE_KEY,
        media_type: "image/jpeg",
        size_bytes: originalBytes.byteLength,
        sha256,
        original_bytes: originalBytes,
        inspector_bytes: inspectorBytes,
      },
    ],
  };
}

function tipRow() {
  return {
    tip_id: TIP_ID,
    title: "안전모 미지급",
    body: "현장에 안전모가 부족합니다.",
    firm_id: "f0000000000000a2",
    sido: null,
    industry: null,
    submitted_at: new Date(SUBMITTED_AT),
  };
}

function originalPath(): string {
  return path.join(storageRoot, "original", "2026", "09", TIP_ID, `${ATTACHMENT_ID}.jpg`);
}

function inspectorPath(): string {
  return path.join(storageRoot, "inspector", "2026", "09", TIP_ID, `${ATTACHMENT_ID}.jpg`);
}

beforeEach(async () => {
  storageRoot = await mkdtemp(path.join(tmpdir(), "moneyworry-worksite-tip-"));
  await chmod(storageRoot, 0o700);
  process.env.WORKSITE_TIP_STORAGE_ROOT = storageRoot;

  db.configured.mockReturnValue(true);
  db.queryWrite.mockReset();
  db.transactionQuery.mockReset();
  db.withWriteTransaction.mockReset();
  db.withWriteTransaction.mockImplementation(
    async (
      _role: string,
      run: (transaction: { query: typeof db.transactionQuery }) => Promise<unknown>,
    ) => run({ query: db.transactionQuery }),
  );
});

afterEach(async () => {
  if (previousStorageRoot === undefined) {
    delete process.env.WORKSITE_TIP_STORAGE_ROOT;
  } else {
    process.env.WORKSITE_TIP_STORAGE_ROOT = previousStorageRoot;
  }
  await rm(storageRoot, { recursive: true, force: true });
});

describe("현장 제보 실저장", () => {
  it("전용 DB 최소권한과 비공개 쓰기 경로가 모두 준비된 경우만 ready다", async () => {
    db.queryWrite.mockResolvedValueOnce([{ ready: true }]);

    await expect(new RealWorksiteTipRepository().isReady()).resolves.toBe(true);
    expect(db.queryWrite).toHaveBeenCalledWith(
      "tip",
      expect.stringContaining("current_user = 'wg_tip'"),
    );
    expect(String(db.queryWrite.mock.calls[0]?.[1])).toContain("pg_catalog.pg_class");
    expect(String(db.queryWrite.mock.calls[0]?.[1])).toContain("'TRIGGER'");

    db.queryWrite.mockRejectedValueOnce(new Error("connection unavailable"));
    await expect(new RealWorksiteTipRepository().isReady()).resolves.toBe(false);
  });

  it("DB에 파일 메타데이터를 저장하고 원본과 조사관 사본을 분리한다", async () => {
    db.transactionQuery.mockResolvedValueOnce([tipRow()]).mockResolvedValueOnce([]);

    const created = await new RealWorksiteTipRepository().insertTip(input());

    expect(db.withWriteTransaction).toHaveBeenCalledWith("tip", expect.any(Function));
    expect(db.transactionQuery).toHaveBeenCalledTimes(2);
    expect(String(db.transactionQuery.mock.calls[0]?.[0])).toContain("INSERT INTO worksite_tips");
    expect(String(db.transactionQuery.mock.calls[1]?.[0])).toContain(
      "INSERT INTO worksite_tip_attachments",
    );
    expect(db.transactionQuery.mock.calls[1]?.[1]).toEqual([
      ATTACHMENT_ID,
      TIP_ID,
      STORAGE_KEY,
      "image/jpeg",
      originalBytes.byteLength,
      sha256,
    ]);
    expect(created.attachments[0]).toMatchObject({
      attachment_id: ATTACHMENT_ID,
      storage_key: STORAGE_KEY,
      size_bytes: originalBytes.byteLength,
      sha256,
    });

    expect(Uint8Array.from(await readFile(originalPath()))).toEqual(originalBytes);
    expect(Uint8Array.from(await readFile(inspectorPath()))).toEqual(inspectorBytes);
    expect(await readFile(originalPath())).not.toEqual(await readFile(inspectorPath()));

    if (process.platform !== "win32") {
      expect((await stat(originalPath())).mode & 0o777).toBe(0o600);
      expect((await stat(inspectorPath())).mode & 0o777).toBe(0o600);
    }
  });

  it("새 repository 인스턴스도 디스크에 남은 조사관 사본을 읽는다", async () => {
    db.transactionQuery.mockResolvedValueOnce([tipRow()]).mockResolvedValueOnce([]);
    await new RealWorksiteTipRepository().insertTip(input());

    db.queryWrite.mockResolvedValueOnce([
      {
        attachment_id: ATTACHMENT_ID,
        storage_key: STORAGE_KEY,
        media_type: "image/jpeg",
        size_bytes: originalBytes.byteLength,
        sha256,
      },
    ]);

    const afterRestart = new RealWorksiteTipRepository();
    const attachment = await afterRestart.readAttachment(TIP_ID, ATTACHMENT_ID);

    expect(db.queryWrite).toHaveBeenCalledWith(
      "tip",
      expect.stringContaining("FROM worksite_tip_attachments"),
      [TIP_ID, ATTACHMENT_ID],
    );
    expect(attachment).toEqual({ bytes: inspectorBytes, media_type: "image/jpeg" });
    expect(attachment?.bytes).not.toEqual(originalBytes);
  });

  it("확정된 DB 저장 실패 시 먼저 쓴 원본과 조사관 사본을 정리한다", async () => {
    db.transactionQuery.mockRejectedValueOnce(
      Object.assign(new Error("check constraint violation"), { code: "23514" }),
    );

    await expect(new RealWorksiteTipRepository().insertTip(input())).rejects.toMatchObject({
      code: "23514",
    });

    await expect(readFile(originalPath())).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(inspectorPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("DB 연결 실패도 먼저 쓴 원본과 조사관 사본을 정리한다", async () => {
    db.withWriteTransaction.mockRejectedValueOnce(
      new ServiceError("DATABASE_UNAVAILABLE", "연결 실패", 503, true),
    );

    await expect(new RealWorksiteTipRepository().insertTip(input())).rejects.toMatchObject({
      code: "DATABASE_UNAVAILABLE",
    });

    await expect(readFile(originalPath())).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(inspectorPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("COMMIT 결과만 불명확할 때는 재조사용 파일을 보존한다", async () => {
    db.withWriteTransaction.mockRejectedValueOnce(
      new ServiceError(
        "DATABASE_COMMIT_OUTCOME_UNKNOWN",
        "저장 결과 불명확",
        503,
        true,
      ),
    );

    await expect(new RealWorksiteTipRepository().insertTip(input())).rejects.toMatchObject({
      code: "DATABASE_COMMIT_OUTCOME_UNKNOWN",
    });

    expect(Uint8Array.from(await readFile(originalPath()))).toEqual(originalBytes);
    expect(Uint8Array.from(await readFile(inspectorPath()))).toEqual(inspectorBytes);
  });
});
