export const WORKSITE_TIP_CATEGORY = "worksite_tip" as const;
export const WORKSITE_TIP_PHOTO_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export const WORKSITE_TIP_MAX_PHOTO_COUNT = 3;
export const WORKSITE_TIP_MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export const WORKSITE_TIP_MAX_TOTAL_PHOTO_BYTES = 10 * 1024 * 1024;

export type WorksiteTipCategory = typeof WORKSITE_TIP_CATEGORY;
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
  title: string;
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
