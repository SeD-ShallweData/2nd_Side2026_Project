import "server-only";

import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  rm,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";

import type {
  NewWorksiteTip,
  StoredWorksiteTip,
  StoredWorksiteTipAttachment,
  StoredWorksiteTipAttachmentContent,
  WorksiteTipPage,
  WorksiteTipRepository,
} from "@/domain/worksiteTip";
import type {
  WorksiteTipApiSource,
  WorksiteTipCompanyContextDto,
  WorksiteTipPhotoMediaType,
} from "@/app/api/worksite-tips/worksiteTipApiContract";
import {
  isWriteDatabaseConfigured,
  queryWrite,
  withWriteTransaction,
} from "@/server/postgresWrite";
import { ServiceError } from "@/utils/errors";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STORAGE_KEY_PATTERN = /^\d{4}\/\d{2}\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/i;

interface TipRow {
  tip_id: string;
  title: string;
  body: string | null;
  firm_id: string | null;
  sido: string | null;
  industry: string | null;
  submitted_at: Date;
  attachment_count?: number;
}

interface AttachmentRow {
  attachment_id: string;
  tip_id?: string;
  storage_key: string;
  media_type: WorksiteTipPhotoMediaType;
  size_bytes: number;
  sha256: string;
}

function unavailable(code: string, message: string): ServiceError {
  return new ServiceError(code, message, 503, true);
}

function storageRoot(): string | undefined {
  const configured = process.env.WORKSITE_TIP_STORAGE_ROOT?.trim();
  if (!configured || !path.isAbsolute(configured)) return undefined;
  const resolved = path.resolve(configured);
  return resolved === path.parse(resolved).root ? undefined : resolved;
}

function extensionFor(mediaType: WorksiteTipPhotoMediaType): string {
  if (mediaType === "image/jpeg") return ".jpg";
  if (mediaType === "image/png") return ".png";
  return ".webp";
}

function attachmentPath(
  root: string,
  kind: "original" | "inspector",
  storageKey: string,
  mediaType: WorksiteTipPhotoMediaType,
): string {
  if (!STORAGE_KEY_PATTERN.test(storageKey)) {
    throw unavailable("WORKSITE_TIP_STORAGE_INVALID", "현장 제보 파일 저장 경로가 올바르지 않습니다.");
  }
  const base = path.resolve(root, kind);
  const resolved = path.resolve(base, `${storageKey}${extensionFor(mediaType)}`);
  if (!resolved.startsWith(`${base}${path.sep}`)) {
    throw unavailable("WORKSITE_TIP_STORAGE_INVALID", "현장 제보 파일 저장 경로가 올바르지 않습니다.");
  }
  return resolved;
}

async function assertPrivateStorageRoot(root: string): Promise<void> {
  try {
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("not a private directory");
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      throw new Error("storage root is accessible by another account");
    }
  } catch {
    throw unavailable(
      "WORKSITE_TIP_STORAGE_UNAVAILABLE",
      "현장 제보 파일 저장소를 사용할 수 없습니다.",
    );
  }
}

async function writeExclusive(filePath: string, bytes: Uint8Array): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  let handle: FileHandle | undefined;
  let created = false;
  try {
    handle = await open(filePath, "wx", 0o600);
    created = true;
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (created) await rm(filePath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function removeFiles(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map((filePath) => rm(filePath, { force: true }).catch(() => undefined)));
}

function toAttachment(row: AttachmentRow): StoredWorksiteTipAttachment {
  return {
    attachment_id: row.attachment_id,
    storage_key: row.storage_key,
    media_type: row.media_type,
    size_bytes: Number(row.size_bytes),
    sha256: row.sha256,
  };
}

function toTip(row: TipRow, attachments: StoredWorksiteTipAttachment[]): StoredWorksiteTip {
  return {
    tip_id: row.tip_id,
    title: row.title,
    body: row.body,
    company_context: row.firm_id
      ? { company_id: row.firm_id, region: row.sido, industry: row.industry }
      : null,
    submitted_at: new Date(row.submitted_at).toISOString(),
    attachments,
  };
}

const TIP_SELECT = `
  SELECT
    t.id::text AS tip_id,
    t.title,
    t.body,
    t.firm_id,
    f.sido,
    f.industry,
    t.submitted_at
  FROM worksite_tips t
  LEFT JOIN firms f ON f.firm_id = t.firm_id
`;

export class RealWorksiteTipRepository implements WorksiteTipRepository {
  readonly source: WorksiteTipApiSource = "database";

  assertAvailable(): void {
    if (!isWriteDatabaseConfigured("tip")) {
      throw unavailable(
        "WORKSITE_TIP_DATABASE_NOT_CONFIGURED",
        "현장 제보 데이터베이스 연결 정보가 설정되지 않았습니다.",
      );
    }
    if (!storageRoot()) {
      throw unavailable(
        "WORKSITE_TIP_STORAGE_NOT_CONFIGURED",
        "현장 제보 파일 저장 경로가 설정되지 않았습니다.",
      );
    }
  }

  async isReady(): Promise<boolean> {
    try {
      this.assertAvailable();
      const root = storageRoot()!;
      await assertPrivateStorageRoot(root);
      await access(root, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
      const rows = await queryWrite<{ ready: boolean }>(
        "tip",
        `SELECT
           current_user = 'wg_tip'
           AND to_regclass('public.worksite_tips') IS NOT NULL
           AND to_regclass('public.worksite_tip_attachments') IS NOT NULL
           AND has_table_privilege(current_user, 'public.worksite_tips', 'SELECT')
           AND has_table_privilege(current_user, 'public.worksite_tips', 'INSERT')
           AND NOT has_table_privilege(current_user, 'public.worksite_tips', 'UPDATE')
           AND NOT has_table_privilege(current_user, 'public.worksite_tips', 'DELETE')
           AND has_table_privilege(current_user, 'public.worksite_tip_attachments', 'SELECT')
           AND has_table_privilege(current_user, 'public.worksite_tip_attachments', 'INSERT')
           AND NOT has_table_privilege(current_user, 'public.worksite_tip_attachments', 'UPDATE')
           AND NOT has_table_privilege(current_user, 'public.worksite_tip_attachments', 'DELETE')
           AND has_table_privilege(current_user, 'public.firms', 'SELECT')
           AND NOT has_table_privilege(current_user, 'public.firms', 'INSERT')
           AND NOT has_table_privilege(current_user, 'public.firms', 'UPDATE')
           AND NOT has_table_privilege(current_user, 'public.firms', 'DELETE')
           AND NOT has_table_privilege(current_user, 'public.users', 'SELECT')
           AND NOT has_table_privilege(current_user, 'public.sessions', 'SELECT')
           AND NOT has_table_privilege(current_user, 'public.posts', 'SELECT')
           AND NOT has_table_privilege(current_user, 'public.reports', 'SELECT')
           AND NOT EXISTS (
             SELECT 1
               FROM pg_catalog.pg_class c
               JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public'
                AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
                AND c.relname NOT IN (
                  'firms', 'worksite_tips', 'worksite_tip_attachments'
                )
                AND (
                  has_table_privilege(current_user, c.oid, 'SELECT')
                  OR has_table_privilege(current_user, c.oid, 'INSERT')
                  OR has_table_privilege(current_user, c.oid, 'UPDATE')
                  OR has_table_privilege(current_user, c.oid, 'DELETE')
                  OR has_table_privilege(current_user, c.oid, 'TRUNCATE')
                  OR has_table_privilege(current_user, c.oid, 'REFERENCES')
                  OR has_table_privilege(current_user, c.oid, 'TRIGGER')
                )
           )
           AND NOT has_table_privilege(current_user, 'public.worksite_tips', 'TRUNCATE')
           AND NOT has_table_privilege(current_user, 'public.worksite_tips', 'REFERENCES')
           AND NOT has_table_privilege(current_user, 'public.worksite_tips', 'TRIGGER')
           AND NOT has_table_privilege(
             current_user,
             'public.worksite_tip_attachments',
             'TRUNCATE'
           )
           AND NOT has_table_privilege(
             current_user,
             'public.worksite_tip_attachments',
             'REFERENCES'
           )
           AND NOT has_table_privilege(
             current_user,
             'public.worksite_tip_attachments',
             'TRIGGER'
           )
           AND NOT has_table_privilege(current_user, 'public.firms', 'TRUNCATE')
           AND NOT has_table_privilege(current_user, 'public.firms', 'REFERENCES')
           AND NOT has_table_privilege(current_user, 'public.firms', 'TRIGGER')
           AS ready`,
      );
      return rows.length === 1 && rows[0]?.ready === true;
    } catch {
      return false;
    }
  }

  async findCompanyContext(companyId: string): Promise<WorksiteTipCompanyContextDto | null> {
    const rows = await queryWrite<{ firm_id: string; sido: string | null; industry: string | null }>(
      "tip",
      "SELECT firm_id, sido, industry FROM firms WHERE firm_id = $1 LIMIT 1",
      [companyId],
    );
    const row = rows[0];
    return row
      ? { company_id: row.firm_id, region: row.sido, industry: row.industry }
      : null;
  }

  async insertTip(input: NewWorksiteTip): Promise<StoredWorksiteTip> {
    this.assertAvailable();
    const root = storageRoot()!;
    await assertPrivateStorageRoot(root);

    const createdFiles: string[] = [];
    try {
      for (const attachment of input.attachments) {
        const originalPath = attachmentPath(root, "original", attachment.storage_key, attachment.media_type);
        const inspectorPath = attachmentPath(root, "inspector", attachment.storage_key, attachment.media_type);
        await writeExclusive(originalPath, attachment.original_bytes);
        createdFiles.push(originalPath);
        await writeExclusive(inspectorPath, attachment.inspector_bytes);
        createdFiles.push(inspectorPath);
      }

      const created = await withWriteTransaction("tip", async (transaction) => {
        const tips = await transaction.query<TipRow>(
          `INSERT INTO worksite_tips (
             id, reporter_id, category, title, body, firm_id, submitted_at
           )
           VALUES ($1::uuid, $2::uuid, 'worksite_tip', $3, $4, $5, $6::timestamptz)
           RETURNING id::text AS tip_id, title, body, firm_id,
                     NULL::text AS sido, NULL::text AS industry, submitted_at`,
          [
            input.tip_id,
            input.reporter_id,
            input.title,
            input.body,
            input.company_context?.company_id ?? null,
            input.submitted_at,
          ],
        );
        const tip = tips[0];
        if (!tip) {
          throw new ServiceError(
            "WORKSITE_TIP_CREATE_FAILED",
            "현장 제보를 저장하지 못했습니다.",
            500,
            true,
          );
        }

        for (const attachment of input.attachments) {
          await transaction.query(
            `INSERT INTO worksite_tip_attachments (
               id, tip_id, storage_key, media_type, size_bytes, sha256
             )
             VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)`,
            [
              attachment.attachment_id,
              input.tip_id,
              attachment.storage_key,
              attachment.media_type,
              attachment.size_bytes,
              attachment.sha256,
            ],
          );
        }
        return tip;
      });

      return {
        ...toTip(created, input.attachments.map(toAttachment)),
        company_context: input.company_context ? { ...input.company_context } : null,
      };
    } catch (error) {
      // COMMIT 응답 유실 때만 실제 반영 여부가 불명확하다. 연결·BEGIN·쿼리 실패는
      // 커밋되지 않았으므로 파일을 지워 장애 중 고아 원본이 누적되지 않게 한다.
      if (!(
        error instanceof ServiceError
        && error.code === "DATABASE_COMMIT_OUTCOME_UNKNOWN"
      )) {
        await removeFiles(createdFiles);
      }
      throw error;
    }
  }

  async listTips(limit: number, page: number): Promise<WorksiteTipPage> {
    const rows = await queryWrite<TipRow>(
      "tip",
      `${TIP_SELECT}
       ORDER BY t.submitted_at DESC, t.id DESC
       LIMIT $1 OFFSET $2`,
      [limit, (page - 1) * limit],
    );
    const counts = await queryWrite<{ total: string }>(
      "tip",
      "SELECT count(*)::text AS total FROM worksite_tips",
    );
    const ids = rows.map((row) => row.tip_id);
    const attachments = ids.length === 0
      ? []
      : await queryWrite<AttachmentRow>(
        "tip",
        `SELECT id::text AS attachment_id, tip_id::text AS tip_id,
                storage_key, media_type, size_bytes, sha256
           FROM worksite_tip_attachments
          WHERE tip_id = ANY($1::uuid[])
          ORDER BY created_at, id`,
        [ids],
      );
    const byTip = new Map<string, StoredWorksiteTipAttachment[]>();
    for (const attachment of attachments) {
      if (!attachment.tip_id) continue;
      const values = byTip.get(attachment.tip_id) ?? [];
      values.push(toAttachment(attachment));
      byTip.set(attachment.tip_id, values);
    }
    return {
      items: rows.map((row) => toTip(row, byTip.get(row.tip_id) ?? [])),
      total: Number(counts[0]?.total ?? rows.length),
    };
  }

  async findTipById(tipId: string): Promise<StoredWorksiteTip | null> {
    if (!UUID_PATTERN.test(tipId)) return null;
    const rows = await queryWrite<TipRow>(
      "tip",
      `${TIP_SELECT} WHERE t.id = $1::uuid LIMIT 1`,
      [tipId],
    );
    const row = rows[0];
    if (!row) return null;
    const attachments = await queryWrite<AttachmentRow>(
      "tip",
      `SELECT id::text AS attachment_id, storage_key, media_type, size_bytes, sha256
         FROM worksite_tip_attachments
        WHERE tip_id = $1::uuid
        ORDER BY created_at, id`,
      [tipId],
    );
    return toTip(row, attachments.map(toAttachment));
  }

  async readAttachment(
    tipId: string,
    attachmentId: string,
  ): Promise<StoredWorksiteTipAttachmentContent | null> {
    if (!UUID_PATTERN.test(tipId) || !UUID_PATTERN.test(attachmentId)) return null;
    const rows = await queryWrite<AttachmentRow>(
      "tip",
      `SELECT a.id::text AS attachment_id, a.storage_key,
              a.media_type, a.size_bytes, a.sha256
         FROM worksite_tip_attachments a
         JOIN worksite_tips t ON t.id = a.tip_id
        WHERE t.id = $1::uuid AND a.id = $2::uuid
        LIMIT 1`,
      [tipId, attachmentId],
    );
    const attachment = rows[0];
    if (!attachment) return null;

    const root = storageRoot();
    if (!root) {
      throw unavailable(
        "WORKSITE_TIP_STORAGE_NOT_CONFIGURED",
        "현장 제보 파일 저장 경로가 설정되지 않았습니다.",
      );
    }
    await assertPrivateStorageRoot(root);
    try {
      const bytes = await readFile(attachmentPath(
        root,
        "inspector",
        attachment.storage_key,
        attachment.media_type,
      ));
      return { bytes: Uint8Array.from(bytes), media_type: attachment.media_type };
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw unavailable(
        "WORKSITE_TIP_FILE_UNAVAILABLE",
        "현장 제보 사진을 불러오지 못했습니다.",
      );
    }
  }
}
