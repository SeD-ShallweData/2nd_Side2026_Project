/**
 * 과거 월을 나중에 백필할 수 있으므로 적재 시각이나 id만으로 최신 배치를 고르면 안 된다.
 * 같은 기준월에 여러 배치가 있을 때만 적재 시각과 id를 결정적 보조 정렬로 사용한다.
 * 운영자가 배치를 고정(is_active)했으면 그 배치를, 아니면 위 규칙의 최신 배치를 쓴다.
 * migration 0021 의 v_current_batch 와 같은 조건이다.
 */
export const LATEST_BATCH_ORDER_SQL = `WHERE as_of_date IS NOT NULL
  AND (is_active OR NOT EXISTS (SELECT 1 FROM public.batches pinned WHERE pinned.is_active))
ORDER BY as_of_date DESC, ingested_at DESC, id DESC
LIMIT 1`;
