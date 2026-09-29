export interface BatchStatus {
  batch_id: number;
  data_as_of: string | null;
  target_month: string | null;
  model_version: string;
  model_sha: string | null;
  ingested_at: string;
  source: string | null;
  n_scored: number;
  n_queue: number;
  n_safe: number;
  /** 지금 서비스에 쓰이는 배치인가(고정이든 자동이든). */
  is_active: boolean;
  /** 운영자가 고정한 배치인가. */
  is_pinned: boolean;
}

export interface BatchStatusListResponse {
  /** pinned: 운영자가 고정한 배치를 서비스한다. auto: 기준월이 가장 최신인 배치를 서비스한다. */
  selection_mode: "auto" | "pinned";
  current: BatchStatus | null;
  batches: BatchStatus[];
  generated_at: string;
  /** admin 응답에만 붙는다. 운영 DB(wg_ops)가 연결돼 있어 전환·해제를 할 수 있는가. */
  manageable?: boolean;
}
