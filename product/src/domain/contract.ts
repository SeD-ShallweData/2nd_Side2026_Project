export type ContractItemStatus = "detected" | "missing" | "review";

export interface ContractFileMetadata {
  file_name: string;
  content_type: string;
  size_bytes: number;
}

export interface ContractReviewRequest {
  text?: string;
  file_metadata?: ContractFileMetadata;
  scenario_id?: string;
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
}

export interface ContractReviewProvider {
  review(request: ContractReviewRequest): Promise<ContractReviewResult>;
}
