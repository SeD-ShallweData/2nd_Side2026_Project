export const WORKSITE_TIP_CATEGORIES = ["wage", "safety"] as const;
export const WORKSITE_TIP_STATUSES = ["received", "in_progress", "completed"] as const;
export const WORKSITE_TIP_INITIAL_STATUS = "received" as const;
export const WORKSITE_TIP_PRIVACY_NOTICE =
  "본 제보함은 신고자의 익명성과 프라이버시를 철저히 보호하며, 입력된 정보는 공공 노동 정보 서비스의 확인 및 점검 참고용으로만 안전하게 활용됩니다.";

export const WORKSITE_TIP_CATEGORY_LABELS = {
  wage: "임금",
  safety: "산재",
} as const;

export const WORKSITE_TIP_STATUS_LABELS = {
  received: "접수완료",
  in_progress: "처리중",
  completed: "처리완료",
} as const;
export const WORKSITE_TIP_PHOTO_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export const WORKSITE_TIP_MAX_PHOTO_COUNT = 3;
export const WORKSITE_TIP_MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export const WORKSITE_TIP_MAX_TOTAL_PHOTO_BYTES = 10 * 1024 * 1024;

export type WorksiteTipCategory = (typeof WORKSITE_TIP_CATEGORIES)[number];
export type WorksiteTipStatus = (typeof WORKSITE_TIP_STATUSES)[number];
export type WorksiteTipPhotoMediaType = (typeof WORKSITE_TIP_PHOTO_MEDIA_TYPES)[number];
export type WorksiteTipApiSource = "mock_memory" | "database";

export interface WorksiteTipCompanyContextDto {
  company_id: string;
  region: string | null;
  industry: string | null;
}

export interface WorksiteTipAttachmentDto {
  attachment_id: string;
  media_type: WorksiteTipPhotoMediaType;
  size_bytes: number;
  content_url: string;
}

export interface WorksiteTipDto {
  source: WorksiteTipApiSource;
  tip_id: string;
  category: WorksiteTipCategory;
  status: WorksiteTipStatus;
  title: string;
  body: string | null;
  company_context: WorksiteTipCompanyContextDto | null;
  submitted_at: string;
  attachments: WorksiteTipAttachmentDto[];
}

export interface WorksiteTipListItemDto {
  source: WorksiteTipApiSource;
  tip_id: string;
  category: WorksiteTipCategory;
  status: WorksiteTipStatus;
  title: string;
  body_preview: string | null;
  company_context: WorksiteTipCompanyContextDto | null;
  submitted_at: string;
  attachment_count: number;
}

export interface WorksiteTipReceiptDto {
  source: WorksiteTipApiSource;
  tip_id: string;
  category: WorksiteTipCategory;
  status: WorksiteTipStatus;
  title: string;
  body: string | null;
  submitted_at: string;
  attachment_count: number;
}

export interface WorksiteTipListResponse {
  source: WorksiteTipApiSource;
  items: WorksiteTipListItemDto[];
  total: number;
  has_more: boolean;
  page: number;
  page_size: number;
  total_pages: number;
}
