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
  is_active: boolean;
}

export interface BatchStatusListResponse {
  selection_mode: "auto";
  current: BatchStatus | null;
  batches: BatchStatus[];
  generated_at: string;
}
