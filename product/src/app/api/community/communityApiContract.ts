export const COMMUNITY_CATEGORIES = [
  "pre_employment",
  "employment_contract",
  "workplace_safety",
  "wage",
] as const;

/** 글 작성 언어(글자 체계로 추정). 자동 번역은 하지 않는다. domain/textLanguage 와 같은 값이다. */
export const COMMUNITY_POST_LANGUAGES = ["ko", "en", "zh", "vi", "th", "other"] as const;
export type CommunityPostLanguage = (typeof COMMUNITY_POST_LANGUAGES)[number];

export const COMMUNITY_CATEGORY_LABELS = {
  pre_employment: "입사 전 확인",
  employment_contract: "근로계약서",
  workplace_safety: "현장 안전",
  wage: "임금",
} as const;

export type CommunityCategory = (typeof COMMUNITY_CATEGORIES)[number];
export type CommunityPostStatus = "published" | "hidden" | "deleted";
export type CommunityReportReason = "spam" | "abuse" | "privacy" | "misinformation" | "other";
export type CommunityReportStatus = "pending" | "accepted" | "dismissed";
export type CommunityApiSource = "mock_memory" | "database";

export interface CommunityApiCapabilities {
  write: boolean;
  comments: boolean;
  reactions: boolean;
  reports: boolean;
  moderation: boolean;
}

export interface CommunityCompanyContextDto {
  company_id: string;
  region: string | null;
  industry: string | null;
}

export interface CommunityPostDto {
  source: CommunityApiSource;
  capabilities: CommunityApiCapabilities;
  post_id: string;
  category: CommunityCategory;
  category_label: string;
  title: string;
  body: string;
  /** 제목·본문의 글자 체계로 추정한 작성 언어. 표시·필터용이며 번역하지 않는다. */
  language: CommunityPostLanguage;
  company_context: CommunityCompanyContextDto | null;
  anonymous: boolean;
  author_label: string | null;
  created_at: string;
  updated_at: string;
  comment_count: number;
  like_count: number | null;
  status: CommunityPostStatus;
  viewer_permissions: {
    can_edit: boolean;
    can_delete: boolean;
    can_report: boolean;
  };
}

export interface CommunityPostListResponse {
  source: CommunityApiSource;
  capabilities: CommunityApiCapabilities;
  query: string;
  category: CommunityCategory | null;
  /** 작성 언어 필터. null 이면 모든 언어. */
  language: CommunityPostLanguage | null;
  items: CommunityPostDto[];
  total: number;
  has_more: boolean;
  page: number;
  page_size: number;
  total_pages: number;
}

export interface CreateCommunityPostRequest {
  category: CommunityCategory;
  title: string;
  body: string;
  company_id?: string | null;
  anonymous?: boolean;
}

export interface UpdateCommunityPostRequest {
  category?: CommunityCategory;
  title?: string;
  body?: string;
  company_id?: string | null;
  anonymous?: boolean;
}

export interface DeleteCommunityPostResponse {
  deleted: true;
  post_id: string;
}

export interface CreateCommunityReportRequest {
  reason: CommunityReportReason;
  detail?: string;
}

export interface CommunityReportReceiptDto {
  report_id: string;
  post_id: string;
  status: CommunityReportStatus;
  created_at: string;
  reviewed_at: string | null;
}

export interface CommunityModerationReportDto extends CommunityReportReceiptDto {
  reason: CommunityReportReason;
  detail: string | null;
  resolution_note: string | null;
  post: {
    title: string;
    status: CommunityPostStatus;
  };
  post_snapshot: {
    title: string;
    body: string;
    updated_at: string;
  };
}

export interface CommunityModerationReportListResponse {
  source: CommunityApiSource;
  capabilities: CommunityApiCapabilities;
  status: CommunityReportStatus | null;
  items: CommunityModerationReportDto[];
  total: number;
  has_more: boolean;
  page: number;
  page_size: number;
  total_pages: number;
}

export interface ReviewCommunityReportRequest {
  decision: "accept" | "dismiss";
  resolution_note?: string;
}
