import "server-only";

import { randomUUID } from "node:crypto";

import type {
  CommunityApiSource,
  CommunityCompanyContextDto,
  CommunityPostStatus,
} from "@/app/api/community/communityApiContract";
import type {
  CommunityPage,
  CommunityPostPatch,
  CommunityRepository,
  NewCommunityPost,
  NewCommunityReport,
  PostListQuery,
  ReportListQuery,
  ReportReviewPatch,
  StoredCommunityPost,
  StoredCommunityReport,
} from "@/domain/community";
import { MOCK_COMPANIES } from "@/mocks/companies";
import { ServiceError } from "@/utils/errors";

/*
 * 메모리 커뮤니티 저장소. 프로세스가 죽으면 글과 신고도 사라진다.
 * 개발 중 모듈이 다시 불러와져도 작성한 글이 날아가지 않도록 globalThis 에 둔다.
 */

interface CommunityMemoryState {
  posts: Map<string, StoredCommunityPost>;
  reports: Map<string, StoredCommunityReport>;
}

function createSeedPosts(): Map<string, StoredCommunityPost> {
  const now = Date.now();
  const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const seeds: StoredCommunityPost[] = [
    {
      post_id: "post_mock_001",
      author_id: "10000000-0000-4000-8000-000000000001",
      author_display_name: "일반 사용자",
      category: "pre_employment",
      title: "면접에서 임금 지급일은 어떻게 물어보면 좋을까요?",
      body: "계약서 작성 전에 지급일과 지급 방법을 자연스럽게 확인했던 경험을 나눠주세요.",
      company_context: { company_id: "COMPANY_DEMO_008", region: "서울특별시", industry: "정보통신업" },
      anonymous: true,
      created_at: minutesAgo(12),
      updated_at: minutesAgo(12),
      comment_count: 4,
      like_count: 11,
      status: "published",
    },
    {
      post_id: "post_mock_002",
      author_id: "10000000-0000-4000-8000-000000000003",
      author_display_name: "근로감독관",
      category: "employment_contract",
      title: "포괄임금 조항을 받았을 때 먼저 확인할 항목",
      body: "기본급과 고정 연장수당이 분리되어 있는지부터 확인해보려고 합니다.",
      company_context: { company_id: "COMPANY_DEMO_002", region: "충청남도", industry: "제조업" },
      anonymous: true,
      created_at: minutesAgo(35),
      updated_at: minutesAgo(35),
      comment_count: 7,
      like_count: 8,
      status: "published",
    },
    {
      post_id: "post_mock_003",
      author_id: "10000000-0000-4000-8000-000000000002",
      author_display_name: "커뮤니티 관리자",
      category: "workplace_safety",
      title: "보호구와 안전교육 여부를 확인한 경험을 나눠요",
      body: "첫 출근 전에 안전교육 일정과 보호구 지급 시점을 문의해도 괜찮았습니다.",
      company_context: { company_id: "COMPANY_DEMO_001", region: "인천광역시", industry: "건설업" },
      anonymous: true,
      created_at: minutesAgo(60),
      updated_at: minutesAgo(60),
      comment_count: 3,
      like_count: 6,
      status: "published",
    },
    {
      post_id: "post_mock_004",
      author_id: "10000000-0000-4000-8000-000000000001",
      author_display_name: "일반 사용자",
      category: "wage",
      title: "급여일이 달라졌을 때 어떤 기록을 남기셨나요?",
      body: "문자와 입금내역 외에 함께 보관하면 좋은 자료가 궁금합니다.",
      company_context: { company_id: "EXPIRED_001", region: "부산광역시", industry: "운수 및 창고업" },
      anonymous: true,
      created_at: minutesAgo(120),
      updated_at: minutesAgo(120),
      comment_count: 5,
      like_count: 9,
      status: "published",
    },
  ];
  return new Map(seeds.map((post) => [post.post_id, post]));
}

const communityGlobal = globalThis as typeof globalThis & {
  __donworryMockCommunity?: CommunityMemoryState;
};

const memoryState: CommunityMemoryState = communityGlobal.__donworryMockCommunity ?? {
  posts: createSeedPosts(),
  reports: new Map<string, StoredCommunityReport>(),
};
communityGlobal.__donworryMockCommunity = memoryState;

function clonePost(post: StoredCommunityPost): StoredCommunityPost {
  return {
    ...post,
    company_context: post.company_context ? { ...post.company_context } : null,
  };
}

function cloneReport(report: StoredCommunityReport): StoredCommunityReport {
  return { ...report, post_snapshot: { ...report.post_snapshot } };
}

function paginate<T>(rows: T[], limit: number, page: number): CommunityPage<T> {
  return { items: rows.slice((page - 1) * limit, page * limit), total: rows.length };
}

function missingPost(postId: string): ServiceError {
  return new ServiceError(
    "COMMUNITY_POST_NOT_FOUND",
    "게시글을 찾을 수 없습니다.",
    404,
    false,
    [{ field: "post_id", reason: postId }],
  );
}

export class MockCommunityRepository implements CommunityRepository {
  readonly source: CommunityApiSource = "mock_memory";

  assertAvailable(): void {
    // 메모리 저장소는 항상 준비돼 있다. 모드 선택은 providers 가 한다.
  }

  async listPublishedPosts(query: PostListQuery): Promise<CommunityPage<StoredCommunityPost>> {
    const normalizedQuery = query.query.toLocaleLowerCase("ko-KR");
    const filtered = [...memoryState.posts.values()]
      .filter((post) => post.status === "published")
      .filter((post) => !query.category || post.category === query.category)
      .filter((post) => {
        if (!normalizedQuery) return true;
        const context = `${post.title} ${post.body} ${post.company_context?.region ?? ""} ${post.company_context?.industry ?? ""}`;
        return context.toLocaleLowerCase("ko-KR").includes(normalizedQuery);
      })
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
      .map(clonePost);
    return paginate(filtered, query.limit, query.page);
  }

  async findPostById(postId: string): Promise<StoredCommunityPost | null> {
    const post = memoryState.posts.get(postId);
    return post ? clonePost(post) : null;
  }

  async findPostsByIds(postIds: readonly string[]): Promise<Map<string, StoredCommunityPost>> {
    const found = new Map<string, StoredCommunityPost>();
    for (const postId of postIds) {
      const post = memoryState.posts.get(postId);
      if (post) found.set(postId, clonePost(post));
    }
    return found;
  }

  async insertPost(input: NewCommunityPost): Promise<StoredCommunityPost> {
    const now = new Date().toISOString();
    const post: StoredCommunityPost = {
      post_id: randomUUID(),
      author_id: input.author_id,
      author_display_name: input.author_display_name,
      category: input.category,
      title: input.title,
      body: input.body,
      company_context: input.company_context,
      anonymous: input.anonymous,
      created_at: now,
      updated_at: now,
      comment_count: 0,
      like_count: 0,
      status: "published",
    };
    memoryState.posts.set(post.post_id, post);
    return clonePost(post);
  }

  async updatePost(postId: string, patch: CommunityPostPatch): Promise<StoredCommunityPost> {
    const post = memoryState.posts.get(postId);
    if (!post) throw missingPost(postId);

    if (patch.category !== undefined) post.category = patch.category;
    if (patch.title !== undefined) post.title = patch.title;
    if (patch.body !== undefined) post.body = patch.body;
    if (patch.anonymous !== undefined) post.anonymous = patch.anonymous;
    if (patch.company_context !== undefined) post.company_context = patch.company_context;
    post.updated_at = new Date().toISOString();

    return clonePost(post);
  }

  async setPostStatus(postId: string, status: CommunityPostStatus): Promise<StoredCommunityPost> {
    const post = memoryState.posts.get(postId);
    if (!post) throw missingPost(postId);
    post.status = status;
    post.updated_at = new Date().toISOString();
    return clonePost(post);
  }

  async findExistingReport(
    postId: string,
    reporterId: string,
  ): Promise<StoredCommunityReport | null> {
    const found = [...memoryState.reports.values()].find(
      (report) => report.post_id === postId && report.reporter_id === reporterId,
    );
    return found ? cloneReport(found) : null;
  }

  async insertReport(input: NewCommunityReport): Promise<StoredCommunityReport> {
    const report: StoredCommunityReport = {
      report_id: randomUUID(),
      post_id: input.post_id,
      reporter_id: input.reporter_id,
      reason: input.reason,
      detail: input.detail,
      status: "pending",
      created_at: new Date().toISOString(),
      reviewed_at: null,
      reviewed_by: null,
      resolution_note: null,
      post_snapshot: { ...input.post_snapshot },
    };
    memoryState.reports.set(report.report_id, report);
    return cloneReport(report);
  }

  async listReports(query: ReportListQuery): Promise<CommunityPage<StoredCommunityReport>> {
    const filtered = [...memoryState.reports.values()]
      .filter((report) => !query.status || report.status === query.status)
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
      .map(cloneReport);
    return paginate(filtered, query.limit, query.page);
  }

  async findReportById(reportId: string): Promise<StoredCommunityReport | null> {
    const report = memoryState.reports.get(reportId);
    return report ? cloneReport(report) : null;
  }

  /*
   * 신고 상태 변경과 게시글 숨김을 한 번에 처리한다.
   * 메모리에서는 원자성이 자연히 지켜지지만, 실제 DB 어댑터는 이 경계를
   * 하나의 트랜잭션으로 구현해야 한다.
   */
  async reviewReport(reportId: string, patch: ReportReviewPatch): Promise<StoredCommunityReport> {
    const report = memoryState.reports.get(reportId);
    if (!report) {
      throw new ServiceError("COMMUNITY_REPORT_NOT_FOUND", "신고 내역을 찾을 수 없습니다.", 404, false);
    }

    const reviewedAt = new Date().toISOString();
    report.status = patch.status;
    report.reviewed_at = reviewedAt;
    report.reviewed_by = patch.reviewed_by;
    report.resolution_note = patch.resolution_note;

    if (patch.hide_post) {
      const post = memoryState.posts.get(report.post_id);
      if (post && post.status === "published") {
        post.status = "hidden";
        post.updated_at = reviewedAt;
      }
    }

    return cloneReport(report);
  }

  async findCompanyContext(companyId: string): Promise<CommunityCompanyContextDto | null> {
    const company = MOCK_COMPANIES.find((candidate) => candidate.company_id === companyId);
    if (!company) return null;
    return {
      company_id: company.company_id,
      region: company.region,
      industry: company.industry,
    };
  }
}

export function resetMockCommunityState(): void {
  memoryState.posts.clear();
  for (const [postId, post] of createSeedPosts()) memoryState.posts.set(postId, post);
  memoryState.reports.clear();
}
