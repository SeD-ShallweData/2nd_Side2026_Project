import "server-only";

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
  type CommunityReportReason,
  type CommunityReportReceiptDto,
  type CommunityReportStatus,
  type CreateCommunityPostRequest,
  type CreateCommunityReportRequest,
  type DeleteCommunityPostResponse,
  type ReviewCommunityReportRequest,
  type UpdateCommunityPostRequest,
} from "@/app/api/community/communityApiContract";
import type {
  CommunityRepository,
  StoredCommunityPost,
  StoredCommunityReport,
} from "@/domain/community";
import { requireResourceOwner, requireUserRole } from "@/server/auth/permissions";
import { getCommunityRepository } from "@/services/userDataProviders";
import { ServiceError } from "@/utils/errors";

/*
 * 커뮤니티 업무 규칙.
 *
 * 저장과 조회는 CommunityRepository 가 맡고, 여기에는 규칙만 둔다.
 *   - 입력값 검증
 *   - 누가 무엇을 볼 수 있고 바꿀 수 있는지
 *   - 상태 전이(수정 가능 여부, 자기 글 신고 금지, 재검토 금지)
 *   - 응답 DTO 조립
 *
 * 규칙을 저장소 쪽에 두면 Mock 과 실제 DB 의 동작이 조용히 갈라진다.
 */

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

async function resolveCompanyContext(
  repository: CommunityRepository,
  companyId: string | null | undefined,
): Promise<CommunityCompanyContextDto | null> {
  if (!companyId) return null;
  const context = await repository.findCompanyContext(companyId);
  if (!context) {
    throw new ServiceError("COMPANY_NOT_FOUND", "선택한 사업장을 찾을 수 없습니다.", 404, false);
  }
  return context;
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

function parsePostId(postId: string): string {
  const normalized = postId.trim();
  if (!normalized || normalized.length > 100) {
    throw new ServiceError("VALIDATION_ERROR", "게시글 식별값을 확인해 주세요.", 400, false);
  }
  return normalized;
}

/*
 * 숨김 글은 관리자와 작성자에게만, 삭제 글은 누구에게도 보이지 않는다.
 * 없는 글과 볼 수 없는 글을 같은 404 로 돌려준다 — 존재 여부가 새지 않게 한다.
 */
async function findVisiblePost(
  repository: CommunityRepository,
  postId: string,
  viewer: SessionUserDto | null,
): Promise<StoredCommunityPost> {
  const post = await repository.findPostById(parsePostId(postId));
  const canSeeHidden = post && viewer && (viewer.role === "admin" || viewer.user_id === post.author_id);
  if (!post || post.status === "deleted" || (post.status === "hidden" && !canSeeHidden)) {
    throw new ServiceError("COMMUNITY_POST_NOT_FOUND", "게시글을 찾을 수 없습니다.", 404, false);
  }
  return post;
}

function toPostDto(
  repository: CommunityRepository,
  post: StoredCommunityPost,
  viewer: SessionUserDto | null,
): CommunityPostDto {
  const isOwner = viewer?.user_id === post.author_id;
  return {
    source: repository.source,
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

export async function listCommunityPosts(
  options: ListOptions = {},
  viewer: SessionUserDto | null = null,
): Promise<CommunityPostListResponse> {
  const repository = getCommunityRepository();
  repository.assertAvailable();

  const query = (options.query ?? "").trim();
  if (query.length > 100) {
    throw new ServiceError("VALIDATION_ERROR", "검색어는 100자 이하여야 합니다.", 400, false);
  }
  const category = options.category ? parseCategory(options.category) : null;
  const { limit, page } = parsePage(options.limit, options.page);

  const { items, total } = await repository.listPublishedPosts({ query, category, limit, page });
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

  return {
    source: repository.source,
    capabilities: capabilitiesFor(viewer),
    query,
    category,
    items: items.map((post) => toPostDto(repository, post, viewer)),
    total,
    has_more: page < totalPages,
    page,
    page_size: limit,
    total_pages: totalPages,
  };
}

export async function getCommunityPost(
  postId: string,
  viewer: SessionUserDto | null = null,
): Promise<CommunityPostDto> {
  const repository = getCommunityRepository();
  repository.assertAvailable();
  return toPostDto(repository, await findVisiblePost(repository, postId, viewer), viewer);
}

export async function createCommunityPost(
  input: unknown,
  user: SessionUserDto,
): Promise<CommunityPostDto> {
  const repository = getCommunityRepository();
  repository.assertAvailable();

  const request = parseCreateRequest(input);
  const post = await repository.insertPost({
    author_id: user.user_id,
    author_display_name: user.display_name,
    category: request.category,
    title: request.title,
    body: request.body,
    company_context: await resolveCompanyContext(repository, request.company_id),
    anonymous: request.anonymous ?? true,
  });
  return toPostDto(repository, post, user);
}

export async function updateCommunityPost(
  postId: string,
  input: unknown,
  user: SessionUserDto,
): Promise<CommunityPostDto> {
  const repository = getCommunityRepository();
  repository.assertAvailable();

  const post = await findVisiblePost(repository, postId, user);
  requireResourceOwner(user, post.author_id);
  if (post.status !== "published") {
    throw new ServiceError("COMMUNITY_POST_NOT_EDITABLE", "현재 상태에서는 게시글을 수정할 수 없습니다.", 409, false);
  }

  const request = parseUpdateRequest(input);
  const updated = await repository.updatePost(post.post_id, {
    category: request.category,
    title: request.title,
    body: request.body,
    anonymous: request.anonymous,
    ...(request.company_id !== undefined
      ? { company_context: await resolveCompanyContext(repository, request.company_id) }
      : {}),
  });
  return toPostDto(repository, updated, user);
}

export async function deleteCommunityPost(
  postId: string,
  user: SessionUserDto,
): Promise<DeleteCommunityPostResponse> {
  const repository = getCommunityRepository();
  repository.assertAvailable();

  const post = await findVisiblePost(repository, postId, user);
  requireResourceOwner(user, post.author_id);
  await repository.setPostStatus(post.post_id, "deleted");
  return { deleted: true, post_id: post.post_id };
}

export async function reportCommunityPost(
  postId: string,
  input: unknown,
  user: SessionUserDto,
): Promise<CommunityReportReceiptDto> {
  const repository = getCommunityRepository();
  repository.assertAvailable();

  const post = await findVisiblePost(repository, postId, user);
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

  const duplicate = await repository.findExistingReport(post.post_id, user.user_id);
  if (duplicate) {
    throw new ServiceError("DUPLICATE_REPORT", "이미 신고한 게시글입니다.", 409, false);
  }

  const request = parseReportRequest(input);
  /*
   * 신고 시점의 글 내용을 함께 남긴다. 글이 나중에 수정·삭제돼도
   * 관리자가 무엇을 보고 신고했는지 확인할 수 있어야 한다.
   */
  const report = await repository.insertReport({
    post_id: post.post_id,
    reporter_id: user.user_id,
    reason: request.reason,
    detail: request.detail ?? null,
    post_snapshot: {
      title: post.title,
      body: post.body,
      updated_at: post.updated_at,
    },
  });

  return {
    report_id: report.report_id,
    post_id: report.post_id,
    status: report.status,
    created_at: report.created_at,
    reviewed_at: report.reviewed_at,
  };
}

function toModerationDto(
  report: StoredCommunityReport,
  post: StoredCommunityPost | undefined,
): CommunityModerationReportDto {
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

export async function listCommunityReports(
  options: ModerationListOptions,
  user: SessionUserDto,
): Promise<CommunityModerationReportListResponse> {
  const repository = getCommunityRepository();
  repository.assertAvailable();
  requireUserRole(user, ["admin"]);

  const statusValue = options.status?.trim() || null;
  if (statusValue && !REPORT_STATUSES.includes(statusValue as CommunityReportStatus)) {
    throw new ServiceError("VALIDATION_ERROR", "신고 상태를 확인해 주세요.", 400, false);
  }
  const status = statusValue as CommunityReportStatus | null;
  const { limit, page } = parsePage(options.limit, options.page);

  const { items, total } = await repository.listReports({ status, limit, page });
  // 목록에 실린 신고의 글만 한 번에 가져온다 — 신고 건마다 조회하지 않는다.
  const posts = await repository.findPostsByIds(items.map((report) => report.post_id));
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

  return {
    source: repository.source,
    capabilities: capabilitiesFor(user),
    status,
    items: items.map((report) => toModerationDto(report, posts.get(report.post_id))),
    total,
    has_more: page < totalPages,
    page,
    page_size: limit,
    total_pages: totalPages,
  };
}

export async function reviewCommunityReport(
  reportId: string,
  input: unknown,
  user: SessionUserDto,
): Promise<CommunityModerationReportDto> {
  const repository = getCommunityRepository();
  repository.assertAvailable();
  requireUserRole(user, ["admin"]);

  const report = await repository.findReportById(reportId);
  if (!report) {
    throw new ServiceError("COMMUNITY_REPORT_NOT_FOUND", "신고 내역을 찾을 수 없습니다.", 404, false);
  }
  if (report.status !== "pending") {
    throw new ServiceError("COMMUNITY_REPORT_ALREADY_REVIEWED", "이미 검토가 끝난 신고입니다.", 409, false);
  }

  const request = parseReviewRequest(input);
  const decisionIsAccept = request.decision === "accept";
  const reviewed = await repository.reviewReport(report.report_id, {
    status: decisionIsAccept ? "accepted" : "dismissed",
    reviewed_by: user.user_id,
    resolution_note: request.resolution_note ?? null,
    hide_post: decisionIsAccept,
  });

  const post = await repository.findPostById(reviewed.post_id);
  return toModerationDto(reviewed, post ?? undefined);
}
