import type { BatchStatus, BatchStatusListResponse } from "@/domain/batch";
import { LATEST_BATCH_ORDER_SQL } from "@/server/latestBatchSql";
import { queryReadOnly } from "@/server/postgres";

type BatchRow = Omit<BatchStatus, "is_active">;

export async function listBatchStatuses(): Promise<BatchStatusListResponse> {
  const rows = await queryReadOnly<BatchRow>(
    `SELECT id AS batch_id,
            as_of_date::text AS data_as_of,
            target_month::text,
            model_version,
            ingested_at::text,
            n_scored,
            n_queue,
            n_safe
       FROM public.batches
      ${LATEST_BATCH_ORDER_SQL.replace("LIMIT 1", "")}`,
  );
  const activeBatchId = rows[0]?.batch_id ?? null;
  return {
    batches: rows.map((row) => ({
      ...row,
      is_active: row.batch_id === activeBatchId,
    })),
  };
}
