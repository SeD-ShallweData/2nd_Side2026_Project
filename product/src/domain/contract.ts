export type ContractItemStatus = "detected" | "missing" | "review";

export interface ContractFileMetadata {
  file_name: string;
  content_type: string;
  size_bytes: number;
}

export interface ContractReviewRequest {
  text?: string;
  file_metadata?: ContractFileMetadata;
  file?: File;
  scenario_id?: string;
  /** 서버 내부 요청 취소/전체 실행 deadline. 공개 JSON 입력으로 신뢰하지 않는다. */
  signal?: AbortSignal;
}

export interface ContractItem {
  code: string;
  label: string;
  status: ContractItemStatus;
  description: string;
  legal_basis?: string;
  extracted_text?: string;
}

export interface ContractReviewResult {
  analysis_status: "completed" | "partial" | "mocked";
  detected_items: ContractItem[];
  missing_items: ContractItem[];
  review_items: ContractItem[];
  warnings: string[];
  suggested_questions: string[];
  limitations: string[];
  review_id?: string;
  file_name?: string;
}

export interface ContractReviewProvider {
  review(request: ContractReviewRequest): Promise<ContractReviewResult>;
}
