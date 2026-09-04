import type {
  CommunityApiSource,
  CommunityCategory,
  CommunityCompanyContextDto,
  CommunityPostStatus,
  CommunityReportReason,
  CommunityReportStatus,
} from "@/app/api/community/communityApiContract";

/*
 * 커뮤니티 저장소 포트.
 *
 * 인증과 마찬가지로 저장과 조회만 담당한다. 입력값 검증, 소유자·권한 판정,
 * 상태 전이 규칙(수정 가능 여부, 자기 글 신고 금지 등)은 서비스 계층에 남긴다.
 *
 * 저장소 책임인 것
 *   - 목록의 필터·정렬·페이지 계산
 *   - 여러 행이 함께 성공하거나 함께 실패해야 하는 처리의 원자성
 *     (신고 승인 시 "신고 상태 변경 + 게시글 숨김"이 대표적이다)
 */

export interface StoredCommunityPost {
  post_id: string;
  author_id: string;
  author_display_name: string;
  category: CommunityCategory;
  title: string;
  body: string;
  company_context: CommunityCompanyContextDto | null;
  anonymous: boolean;
  created_at: string;
  updated_at: string;
  comment_count: number;
  like_count: number | null;
  status: CommunityPostStatus;
}

export interface StoredCommunityReport {
  report_id: string;
  post_id: string;
  reporter_id: string;
  reason: CommunityReportReason;
  detail: string | null;
  status: CommunityReportStatus;
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  resolution_note: string | null;
  post_snapshot: {
    title: string;
    body: string;
    updated_at: string;
  };
}

export interface CommunityPage<T> {
  items: T[];
  total: number;
}

export interface PostListQuery {
  query: string;
  category: CommunityCategory | null;
  limit: number;
  page: number;
}

export interface ReportListQuery {
  status: CommunityReportStatus | null;
  limit: number;
  page: number;
}

export interface NewCommunityPost {
  author_id: string;
  author_display_name: string;
  category: CommunityCategory;
  title: string;
  body: string;
  company_context: CommunityCompanyContextDto | null;
  anonymous: boolean;
}

export interface CommunityPostPatch {
  category?: CommunityCategory;
  title?: string;
  body?: string;
  anonymous?: boolean;
  company_context?: CommunityCompanyContextDto | null;
}

export interface NewCommunityReport {
  post_id: string;
  reporter_id: string;
  reason: CommunityReportReason;
  detail: string | null;
  post_snapshot: {
    title: string;
    body: string;
    updated_at: string;
  };
}

export interface ReportReviewPatch {
  status: Exclude<CommunityReportStatus, "pending">;
  reviewed_by: string;
  resolution_note: string | null;
  /* 승인 시 게시글을 숨긴다. 신고 상태 변경과 함께 성공하거나 함께 실패해야 한다. */
  hide_post: boolean;
}

export interface CommunityRepository {
  /* 응답의 데이터 출처 표시값. 화면이 이 값으로 임시·실제를 구분한다. */
  readonly source: CommunityApiSource;

  /* 저장소를 쓸 수 없으면 ServiceError 를 던진다. */
  assertAvailable(): void;

  /* 목록은 공개 상태(published)만 반환한다. */
  listPublishedPosts(query: PostListQuery): Promise<CommunityPage<StoredCommunityPost>>;

  /* 상태와 무관하게 찾는다. 숨김·삭제 글을 누구에게 보일지는 서비스가 판단한다. */
  findPostById(postId: string): Promise<StoredCommunityPost | null>;

  findPostsByIds(postIds: readonly string[]): Promise<Map<string, StoredCommunityPost>>;

  insertPost(post: NewCommunityPost): Promise<StoredCommunityPost>;

  updatePost(postId: string, patch: CommunityPostPatch): Promise<StoredCommunityPost>;

  setPostStatus(postId: string, status: CommunityPostStatus): Promise<StoredCommunityPost>;

  /* 같은 사람이 같은 글을 이미 신고했는지 본다. */
  findExistingReport(postId: string, reporterId: string): Promise<StoredCommunityReport | null>;

  insertReport(report: NewCommunityReport): Promise<StoredCommunityReport>;

  listReports(query: ReportListQuery): Promise<CommunityPage<StoredCommunityReport>>;

  findReportById(reportId: string): Promise<StoredCommunityReport | null>;

  reviewReport(reportId: string, patch: ReportReviewPatch): Promise<StoredCommunityReport>;

  /* 사업장을 찾지 못하면 null 을 돌려준다. 오류로 바꾸는 것은 서비스 몫이다. */
  findCompanyContext(companyId: string): Promise<CommunityCompanyContextDto | null>;
}
