import type { BatchStatus, BatchStatusListResponse } from "@/domain/batch";
import { LATEST_BATCH_ORDER_SQL } from "@/server/latestBatchSql";
import { queryReadOnly } from "@/server/postgres";

export async function listBatchStatuses(): Promise<BatchStatusListResponse> {
  const rows = await queryReadOnly<BatchStatus>(
    `WITH current_batch AS (
       SELECT id
         FROM public.batches
        ${LATEST_BATCH_ORDER_SQL}
     )
     SELECT b.id AS batch_id,
            b.as_of_date::text AS data_as_of,
            b.target_month::text,
            b.model_version,
            b.model_sha,
            b.ingested_at::text,
            b.source,
            b.n_scored,
            b.n_queue,
            b.n_safe,
            COALESCE(b.id = current_batch.id, false) AS is_active
       FROM public.batches b
       LEFT JOIN current_batch ON true
      ORDER BY b.as_of_date DESC NULLS LAST, b.ingested_at DESC, b.id DESC`,
  );

  return {
    selection_mode: "auto",
    current: rows.find((row) => row.is_active) ?? null,
    batches: rows,
    generated_at: new Date().toISOString(),
  };
}
