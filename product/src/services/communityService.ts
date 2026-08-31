import "server-only";

import { randomUUID } from "node:crypto";

import type { SessionUserDto } from "@/app/api/auth/authApiContract";
import {
  COMMUNITY_CATEGORIES,
  COMMUNITY_CATEGORY_LABELS,
  type CommunityCategory,
  type CommunityCompanyContextDto,
  type CommunityModerationReportDto,
  type CommunityModerationReportListResponse,
  type CommunityPostDto,
  type CommunityPostListResponse,
  type CommunityPostStatus,
  type CommunityReportReason,
  type CommunityReportReceiptDto,
  type CommunityReportStatus,
  type CreateCommunityPostRequest,
  type CreateCommunityReportRequest,
  type DeleteCommunityPostResponse,
  type ReviewCommunityReportRequest,
  type UpdateCommunityPostRequest,
} from "@/app/api/community/communityApiContract";
import { MOCK_COMPANIES } from "@/mocks/companies";
import { requireResourceOwner, requireUserRole } from "@/server/auth/permissions";
import { ServiceError } from "@/utils/errors";

interface StoredCommunityPost {
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
  like_count: number;
  status: CommunityPostStatus;
}

interface StoredCommunityReport {
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

interface CommunityMemoryState {
  posts: Map<string, StoredCommunityPost>;
  reports: Map<string, StoredCommunityReport>;
}

interface ListOptions {
  query?: string;
  category?: string | null;
  page?: number;
  limit?: number;
}

interface ModerationListOptions {
  status?: string | null;
  page?: number;
  limit?: number;
}

const REPORT_REASONS = ["spam", "abuse", "privacy", "misinformation", "other"] as const;
const REPORT_STATUSES = ["pending", "accepted", "dismissed"] as const;
const communityGlobal = globalThis as typeof globalThis & {
  __donworryMockCommunity?: CommunityMemoryState;
};

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

const memoryState = communityGlobal.__donworryMockCommunity ?? {
  posts: createSeedPosts(),
  reports: new Map<string, StoredCommunityReport>(),
};
communityGlobal.__donworryMockCommunity = memoryState;

function ensureMockMode(): void {
  const mode = process.env.COMMUNITY_DATA_MODE ?? process.env.APP_DATA_MODE ?? "real";
  if (mode !== "mock") {
    throw new ServiceError(
      "COMMUNITY_PROVIDER_UNAVAILABLE",
      "커뮤니티 저장소가 아직 연결되지 않았습니다.",
      503,
      true,
    );
  }
}

function assertRecord(input: unknown, message: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ServiceError("VALIDATION_ERROR", message, 400, false);
  }
  return input as Record<string, unknown>;
}

function parseRequiredText(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new ServiceError(
      "VALIDATION_ERROR",
      "게시글 입력값을 확인해 주세요.",
      400,
      false,
      [{ field, reason: `${field}은 ${minimum}자 이상 ${maximum}자 이하여야 합니다.` }],
    );
  }
  return normalized;
}

function parseCategory(value: unknown): CommunityCategory {
  if (typeof value !== "string" || !COMMUNITY_CATEGORIES.includes(value as CommunityCategory)) {
    throw new ServiceError(
      "VALIDATION_ERROR",
      "게시글 분류를 확인해 주세요.",
      400,
      false,
      [{ field: "category", reason: "지원하는 게시글 분류가 아닙니다." }],
    );
  }
  return value as CommunityCategory;
}

function parseOptionalCompanyId(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new ServiceError(
      "VALIDATION_ERROR",
      "사업장 식별값을 확인해 주세요.",
      400,
      false,
      [{ field: "company_id", reason: "company_id는 64자 이하 문자열이어야 합니다." }],
    );
  }
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > 64) {
    throw new ServiceError(
      "VALIDATION_ERROR",
      "사업장 식별값을 확인해 주세요.",
      400,
      false,
      [{ field: "company_id", reason: "company_id는 64자 이하 문자열이어야 합니다." }],
    );
  }
  return normalized;
}

function capabilitiesFor(viewer: SessionUserDto | null) {
  return {
    write: Boolean(viewer),
    comments: false,
    reactions: false,
    reports: Boolean(viewer),
    moderation: viewer?.role === "admin",
  } as const;
}

function resolveMockCompanyContext(companyId: string | null | undefined): CommunityCompanyContextDto | null {
  if (!companyId) return null;
  const company = MOCK_COMPANIES.find((candidate) => candidate.company_id === companyId);
  if (!company) {
    throw new ServiceError("COMPANY_NOT_FOUND", "선택한 사업장을 찾을 수 없습니다.", 404, false);
  }
  return {
    company_id: company.company_id,
    region: company.region,
    industry: company.industry,
  };
}

function parseAnonymous(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new ServiceError(
      "VALIDATION_ERROR",
      "익명 설정을 확인해 주세요.",
      400,
      false,
      [{ field: "anonymous", reason: "anonymous는 boolean이어야 합니다." }],
    );
  }
  return value;
}

function parsePage(limitValue = 10, pageValue = 1): { limit: number; page: number } {
  if (!Number.isInteger(limitValue) || limitValue < 1 || limitValue > 20) {
    throw new ServiceError("VALIDATION_ERROR", "조회 개수를 확인해 주세요.", 400, false);
  }
  if (!Number.isInteger(pageValue) || pageValue < 1 || pageValue > 100_000) {
    throw new ServiceError("VALIDATION_ERROR", "조회 페이지를 확인해 주세요.", 400, false);
  }
  return { limit: limitValue, page: pageValue };
}

function findVisiblePost(postId: string, viewer: SessionUserDto | null): StoredCommunityPost {
  const normalizedId = postId.trim();
  if (!normalizedId || normalizedId.length > 100) {
    throw new ServiceError("VALIDATION_ERROR", "게시글 식별값을 확인해 주세요.", 400, false);
  }
  const post = memoryState.posts.get(normalizedId);
  const canSeeHidden = post && viewer && (viewer.role === "admin" || viewer.user_id === post.author_id);
  if (!post || post.status === "deleted" || (post.status === "hidden" && !canSeeHidden)) {
    throw new ServiceError("COMMUNITY_POST_NOT_FOUND", "게시글을 찾을 수 없습니다.", 404, false);
  }
  return post;
}

function toPostDto(post: StoredCommunityPost, viewer: SessionUserDto | null): CommunityPostDto {
  const isOwner = viewer?.user_id === post.author_id;
  return {
    source: "mock_memory",
    capabilities: capabilitiesFor(viewer),
    post_id: post.post_id,
    category: post.category,
    category_label: COMMUNITY_CATEGORY_LABELS[post.category],
    title: post.title,
    body: post.body,
    company_context: post.company_context ? { ...post.company_context } : null,
    anonymous: post.anonymous,
    author_label: post.anonymous ? null : post.author_display_name,
    created_at: post.created_at,
    updated_at: post.updated_at,
    comment_count: post.comment_count,
    like_count: post.like_count,
    status: post.status,
    viewer_permissions: {
      can_edit: Boolean(isOwner && post.status === "published"),
      can_delete: Boolean(isOwner && post.status !== "deleted"),
      can_report: Boolean(viewer && !isOwner && post.status === "published"),
    },
  };
}

function parseCreateRequest(input: unknown): CreateCommunityPostRequest {
  const candidate = assertRecord(input, "게시글 입력값을 확인해 주세요.");
  return {
    category: parseCategory(candidate.category),
    title: parseRequiredText(candidate.title, "title", 2, 120),
    body: parseRequiredText(candidate.body, "body", 10, 5_000),
    company_id: parseOptionalCompanyId(candidate.company_id),
    anonymous: parseAnonymous(candidate.anonymous, true),
  };
}

function parseUpdateRequest(input: unknown): UpdateCommunityPostRequest {
  const candidate = assertRecord(input, "수정할 게시글 내용을 확인해 주세요.");
  const result: UpdateCommunityPostRequest = {};
  if ("category" in candidate) result.category = parseCategory(candidate.category);
  if ("title" in candidate) result.title = parseRequiredText(candidate.title, "title", 2, 120);
  if ("body" in candidate) result.body = parseRequiredText(candidate.body, "body", 10, 5_000);
  if ("company_id" in candidate) result.company_id = parseOptionalCompanyId(candidate.company_id);
  if ("anonymous" in candidate) result.anonymous = parseAnonymous(candidate.anonymous, true);
  if (Object.keys(result).length === 0) {
    throw new ServiceError("VALIDATION_ERROR", "수정할 항목이 없습니다.", 400, false);
  }
  return result;
}

function parseReportRequest(input: unknown): CreateCommunityReportRequest {
  const candidate = assertRecord(input, "신고 내용을 확인해 주세요.");
  if (typeof candidate.reason !== "string" || !REPORT_REASONS.includes(candidate.reason as CommunityReportReason)) {
    throw new ServiceError("VALIDATION_ERROR", "신고 사유를 확인해 주세요.", 400, false);
  }
  const detail = candidate.detail === undefined ? undefined : parseRequiredText(candidate.detail, "detail", 1, 500);
  return { reason: candidate.reason as CommunityReportReason, detail };
}

function parseReviewRequest(input: unknown): ReviewCommunityReportRequest {
  const candidate = assertRecord(input, "검토 결과를 확인해 주세요.");
  if (candidate.decision !== "accept" && candidate.decision !== "dismiss") {
    throw new ServiceError("VALIDATION_ERROR", "검토 결정을 확인해 주세요.", 400, false);
  }
  const resolutionNote = candidate.resolution_note === undefined
    ? undefined
    : parseRequiredText(candidate.resolution_note, "resolution_note", 1, 500);
  return { decision: candidate.decision, resolution_note: resolutionNote };
}

export function listCommunityPosts(
  options: ListOptions = {},
  viewer: SessionUserDto | null = null,
): CommunityPostListResponse {
  ensureMockMode();
  const query = (options.query ?? "").trim();
  if (query.length > 100) {
    throw new ServiceError("VALIDATION_ERROR", "검색어는 100자 이하여야 합니다.", 400, false);
  }
  const category = options.category ? parseCategory(options.category) : null;
  const { limit, page } = parsePage(options.limit, options.page);
  const normalizedQuery = query.toLocaleLowerCase("ko-KR");
  const filtered = [...memoryState.posts.values()]
    .filter((post) => post.status === "published")
    .filter((post) => !category || post.category === category)
    .filter((post) => {
      if (!normalizedQuery) return true;
      const context = `${post.title} ${post.body} ${post.company_context?.region ?? ""} ${post.company_context?.industry ?? ""}`;
      return context.toLocaleLowerCase("ko-KR").includes(normalizedQuery);
    })
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
  const total = filtered.length;
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  const items = filtered.slice((page - 1) * limit, page * limit).map((post) => toPostDto(post, viewer));
  return {
    source: "mock_memory",
    capabilities: capabilitiesFor(viewer),
    query,
    category,
    items,
    total,
    has_more: page < totalPages,
    page,
    page_size: limit,
    total_pages: totalPages,
  };
}

export function getCommunityPost(postId: string, viewer: SessionUserDto | null = null): CommunityPostDto {
  ensureMockMode();
  return toPostDto(findVisiblePost(postId, viewer), viewer);
}

export function createCommunityPost(input: unknown, user: SessionUserDto): CommunityPostDto {
  ensureMockMode();
  const request = parseCreateRequest(input);
  const now = new Date().toISOString();
  const post: StoredCommunityPost = {
    post_id: randomUUID(),
    author_id: user.user_id,
    author_display_name: user.display_name,
    category: request.category,
    title: request.title,
    body: request.body,
    company_context: resolveMockCompanyContext(request.company_id),
    anonymous: request.anonymous ?? true,
    created_at: now,
    updated_at: now,
    comment_count: 0,
    like_count: 0,
    status: "published",
  };
  memoryState.posts.set(post.post_id, post);
  return toPostDto(post, user);
}

export function updateCommunityPost(postId: string, input: unknown, user: SessionUserDto): CommunityPostDto {
  ensureMockMode();
  const post = findVisiblePost(postId, user);
  requireResourceOwner(user, post.author_id);
  if (post.status !== "published") {
    throw new ServiceError("COMMUNITY_POST_NOT_EDITABLE", "현재 상태에서는 게시글을 수정할 수 없습니다.", 409, false);
  }
  const request = parseUpdateRequest(input);
  if (request.category !== undefined) post.category = request.category;
  if (request.title !== undefined) post.title = request.title;
  if (request.body !== undefined) post.body = request.body;
  if (request.anonymous !== undefined) post.anonymous = request.anonymous;
  if (request.company_id !== undefined) {
    post.company_context = resolveMockCompanyContext(request.company_id);
  }
  post.updated_at = new Date().toISOString();
  return toPostDto(post, user);
}

export function deleteCommunityPost(postId: string, user: SessionUserDto): DeleteCommunityPostResponse {
  ensureMockMode();
  const post = findVisiblePost(postId, user);
  requireResourceOwner(user, post.author_id);
  post.status = "deleted";
  post.updated_at = new Date().toISOString();
  return { deleted: true, post_id: post.post_id };
}

export function reportCommunityPost(
  postId: string,
  input: unknown,
  user: SessionUserDto,
): CommunityReportReceiptDto {
  ensureMockMode();
  const post = findVisiblePost(postId, user);
  if (post.status !== "published") {
    throw new ServiceError(
      "COMMUNITY_POST_NOT_REPORTABLE",
      "현재 상태에서는 게시글을 신고할 수 없습니다.",
      409,
      false,
    );
  }
  if (post.author_id === user.user_id) {
    throw new ServiceError("SELF_REPORT_NOT_ALLOWED", "본인이 작성한 게시글은 신고할 수 없습니다.", 409, false);
  }
  const duplicate = [...memoryState.reports.values()].find(
    (report) => report.post_id === post.post_id && report.reporter_id === user.user_id,
  );
  if (duplicate) {
    throw new ServiceError("DUPLICATE_REPORT", "이미 신고한 게시글입니다.", 409, false);
  }
  const request = parseReportRequest(input);
  const report: StoredCommunityReport = {
    report_id: randomUUID(),
    post_id: post.post_id,
    reporter_id: user.user_id,
    reason: request.reason,
    detail: request.detail ?? null,
    status: "pending",
    created_at: new Date().toISOString(),
    reviewed_at: null,
    reviewed_by: null,
    resolution_note: null,
    post_snapshot: {
      title: post.title,
      body: post.body,
      updated_at: post.updated_at,
    },
  };
  memoryState.reports.set(report.report_id, report);
  return {
    report_id: report.report_id,
    post_id: report.post_id,
    status: report.status,
    created_at: report.created_at,
    reviewed_at: report.reviewed_at,
  };
}

function toModerationDto(report: StoredCommunityReport): CommunityModerationReportDto {
  const post = memoryState.posts.get(report.post_id);
  return {
    report_id: report.report_id,
    post_id: report.post_id,
    status: report.status,
    created_at: report.created_at,
    reviewed_at: report.reviewed_at,
    reason: report.reason,
    detail: report.detail,
    resolution_note: report.resolution_note,
    post: {
      title: post?.title ?? "삭제된 게시글",
      status: post?.status ?? "deleted",
    },
    post_snapshot: { ...report.post_snapshot },
  };
}

export function listCommunityReports(
  options: ModerationListOptions,
  user: SessionUserDto,
): CommunityModerationReportListResponse {
  ensureMockMode();
  requireUserRole(user, ["admin"]);
  const statusValue = options.status?.trim() || null;
  if (statusValue && !REPORT_STATUSES.includes(statusValue as CommunityReportStatus)) {
    throw new ServiceError("VALIDATION_ERROR", "신고 상태를 확인해 주세요.", 400, false);
  }
  const status = statusValue as CommunityReportStatus | null;
  const { limit, page } = parsePage(options.limit, options.page);
  const filtered = [...memoryState.reports.values()]
    .filter((report) => !status || report.status === status)
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
  const total = filtered.length;
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  return {
    source: "mock_memory",
    capabilities: capabilitiesFor(user),
    status,
    items: filtered.slice((page - 1) * limit, page * limit).map(toModerationDto),
    total,
    has_more: page < totalPages,
    page,
    page_size: limit,
    total_pages: totalPages,
  };
}

export function reviewCommunityReport(
  reportId: string,
  input: unknown,
  user: SessionUserDto,
): CommunityModerationReportDto {
  ensureMockMode();
  requireUserRole(user, ["admin"]);
  const report = memoryState.reports.get(reportId);
  if (!report) {
    throw new ServiceError("COMMUNITY_REPORT_NOT_FOUND", "신고 내역을 찾을 수 없습니다.", 404, false);
  }
  if (report.status !== "pending") {
    throw new ServiceError("COMMUNITY_REPORT_ALREADY_REVIEWED", "이미 검토가 끝난 신고입니다.", 409, false);
  }
  const request = parseReviewRequest(input);
  report.status = request.decision === "accept" ? "accepted" : "dismissed";
  report.reviewed_at = new Date().toISOString();
  report.reviewed_by = user.user_id;
  report.resolution_note = request.resolution_note ?? null;
  if (request.decision === "accept") {
    const post = memoryState.posts.get(report.post_id);
    if (post && post.status === "published") {
      post.status = "hidden";
      post.updated_at = report.reviewed_at;
    }
  }
  return toModerationDto(report);
}

export function resetMockCommunityStateForTests(): void {
  memoryState.posts.clear();
  for (const [postId, post] of createSeedPosts()) memoryState.posts.set(postId, post);
  memoryState.reports.clear();
}
