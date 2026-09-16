export interface BatchStatus {
  batch_id: number;
  data_as_of: string | null;
  target_month: string | null;
  model_version: string;
  ingested_at: string;
  n_scored: number;
  n_queue: number;
  n_safe: number;
  is_active: boolean;
}

export interface BatchStatusListResponse {
  batches: BatchStatus[];
}
