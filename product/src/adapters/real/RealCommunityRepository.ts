import "server-only";

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
import {
  isDatabaseError,
  isWriteDatabaseConfigured,
  queryWrite,
  withWriteTransaction,
} from "@/server/postgresWrite";
import { ServiceError } from "@/utils/errors";

/*
 * PostgreSQL 커뮤니티 저장소. wg_community 롤로 붙는다.
 *
 * 이 롤이 볼 수 있는 것은 posts·reports(전체), comments·firms·v_posts(조회),
 * feedback(조회·작성), 그리고 users 의 id·name 두 컬럼(조회)뿐이다.
 *
 * 작성자 이름은 users 를 직접 조인해서 가져온다. 예전에는 v_posts 뷰에서
 * 가져왔는데, 그 뷰가 공개(published) 글만 담아서 신고 승인으로 숨겨진 글의
 * 작성자를 관리자도 볼 수 없었다. users 에 컬럼 단위 조회 권한이 생기면서
 * 상태와 무관하게 이름을 가져올 수 있다.
 *
 * ⚠️ 그 대신 익명 처리가 앱 책임이 됐다. 뷰가 대신 지워주던 것을 이제 이
 * 파일의 SQL 이 직접 해야 한다. 익명 글은 상태·조회자와 무관하게 이름을
 * 내보내지 않는다 — 관리자에게도 마찬가지다. 익명으로 쓴 사람과의 약속이고,
 * 반복 신고자 추적이 필요하면 이름 대신 author_id 를 쓰면 된다.
 *
 * users 는 id·name 만 읽을 수 있다. SELECT * 나 다른 컬럼을 넣으면
 * 42501(권한 없음)이 난다.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/*
 * 게시글·신고 식별값은 사용자 입력에서 온다. UUID 가 아닌 값을 그대로 넘기면
 * PostgreSQL 이 형 변환 오류(22P02)를 내고, 서비스는 "없음(404)" 대신
 * "DB 오류(503)"를 돌려주게 된다.
 */
function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/* ILIKE 패턴에서 %와 _는 와일드카드다. 검색어의 이 문자들은 글자 그대로 찾아야 한다. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (matched) => `\\${matched}`);
}

interface PostRow {
  post_id: string;
  author_id: string;
  author_display_name: string;
  category: string;
  title: string;
  body: string;
  firm_id: string | null;
  sido: string | null;
  industry: string | null;
  anonymous: boolean;
  created_at: Date;
  updated_at: Date;
  status: string;
  comment_count: number;
  total_count?: string;
}

interface ReportRow {
  report_id: string;
  post_id: string;
  reporter_id: string;
  reason: string;
  detail: string | null;
  status: string;
  created_at: Date;
  reviewed_at: Date | null;
  reviewed_by: string | null;
  resolution_note: string | null;
  snapshot_title: string;
  snapshot_body: string;
  snapshot_post_updated_at: Date;
  total_count?: string;
}

/*
 * 작성자 이름은 users 를 조인해서 가져온다. 숨겨진 글도 이름이 나와야 해서
 * v_posts(공개 글만) 대신 원본 테이블을 본다.
 *
 * 익명 글은 여기서 이름을 지운다. 이 CASE 가 익명 보장의 유일한 지점이므로
 * 지우거나 조건을 바꾸면 익명 글의 실명이 그대로 나간다.
 *
 * LEFT JOIN 인 이유는 작성자 행이 없어도 글은 보여야 하기 때문이다.
 * INNER JOIN 이면 글이 목록에서 통째로 사라져 원인을 찾기 어렵다.
 *
 * 댓글 수는 comments 를 세어 만든다 — 좋아요는 테이블 자체가 없어 null 이다.
 */
const POST_SELECT = `
  SELECT
    p.id::text                                          AS post_id,
    p.author_id::text                                   AS author_id,
    CASE WHEN p.anonymous THEN '' ELSE COALESCE(u.name, '') END AS author_display_name,
    p.category,
    p.title,
    p.body,
    p.firm_id,
    f.sido,
    f.industry,
    p.anonymous,
    p.created_at,
    p.updated_at,
    p.status,
    (SELECT count(*)::int FROM comments c WHERE c.post_id = p.id) AS comment_count
  FROM posts p
  LEFT JOIN users u ON u.id = p.author_id
  LEFT JOIN firms f ON f.firm_id = p.firm_id
`;

const REPORT_SELECT = `
  SELECT
    r.id::text          AS report_id,
    r.post_id::text     AS post_id,
    r.reporter_id::text AS reporter_id,
    r.reason,
    r.detail,
    r.status,
    r.created_at,
    r.reviewed_at,
    r.reviewed_by::text AS reviewed_by,
    r.resolution_note,
    r.snapshot_title,
    r.snapshot_body,
    r.snapshot_post_updated_at
  FROM reports r
`;

function toPost(row: PostRow): StoredCommunityPost {
  return {
    post_id: row.post_id,
    author_id: row.author_id,
    author_display_name: row.author_display_name,
    category: row.category as StoredCommunityPost["category"],
    title: row.title,
    body: row.body,
    company_context: row.firm_id
      ? { company_id: row.firm_id, region: row.sido, industry: row.industry }
      : null,
    anonymous: row.anonymous,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
    comment_count: row.comment_count,
    // 좋아요 테이블이 없다. 값을 지어내지 않고 없음으로 표시한다.
    like_count: null,
    status: row.status as CommunityPostStatus,
  };
}

function toReport(row: ReportRow): StoredCommunityReport {
  return {
    report_id: row.report_id,
    post_id: row.post_id,
    reporter_id: row.reporter_id,
    reason: row.reason as StoredCommunityReport["reason"],
    detail: row.detail,
    status: row.status as StoredCommunityReport["status"],
    created_at: new Date(row.created_at).toISOString(),
    reviewed_at: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
    reviewed_by: row.reviewed_by,
    resolution_note: row.resolution_note,
    post_snapshot: {
      title: row.snapshot_title,
      body: row.snapshot_body,
      updated_at: new Date(row.snapshot_post_updated_at).toISOString(),
    },
  };
}

function totalFrom(rows: Array<{ total_count?: string }>, fallback: number): number {
  const raw = rows[0]?.total_count;
  return raw === undefined ? fallback : Number(raw);
}

function missingPost(): ServiceError {
  return new ServiceError("COMMUNITY_POST_NOT_FOUND", "게시글을 찾을 수 없습니다.", 404, false);
}

export class RealCommunityRepository implements CommunityRepository {
  readonly source: CommunityApiSource = "database";

  assertAvailable(): void {
    if (!isWriteDatabaseConfigured("community")) {
      throw new ServiceError(
        "COMMUNITY_DATABASE_NOT_CONFIGURED",
        "커뮤니티 데이터베이스 연결 정보가 설정되지 않았습니다.",
        503,
        true,
      );
    }
  }

  async listPublishedPosts(query: PostListQuery): Promise<CommunityPage<StoredCommunityPost>> {
    const search = query.query.trim();
    const rows = await queryWrite<PostRow>(
      "community",
      `${POST_SELECT}
        WHERE p.status = 'published'
          AND ($1::text IS NULL OR p.category = $1)
          AND (
            $2::text = ''
            OR (
              p.title || ' ' || p.body || ' '
              || COALESCE(f.sido, '') || ' ' || COALESCE(f.industry, '')
            ) ILIKE '%' || $2 || '%' ESCAPE '\\'
          )
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT $3 OFFSET $4`,
      [query.category, escapeLikePattern(search), query.limit, (query.page - 1) * query.limit],
    );

    /*
     * 전체 건수는 같은 조건으로 따로 센다. 목록 쿼리에 count(*) OVER() 를 붙이면
     * 페이지에 실린 행에만 붙어 나와 마지막 페이지에서 값이 어긋난다.
     */
    const countRows = await queryWrite<{ total_count: string }>(
      "community",
      `SELECT count(*)::text AS total_count
         FROM posts p
         LEFT JOIN firms f ON f.firm_id = p.firm_id
        WHERE p.status = 'published'
          AND ($1::text IS NULL OR p.category = $1)
          AND (
            $2::text = ''
            OR (
              p.title || ' ' || p.body || ' '
              || COALESCE(f.sido, '') || ' ' || COALESCE(f.industry, '')
            ) ILIKE '%' || $2 || '%' ESCAPE '\\'
          )`,
      [query.category, escapeLikePattern(search)],
    );

    return { items: rows.map(toPost), total: totalFrom(countRows, rows.length) };
  }

  async findPostById(postId: string): Promise<StoredCommunityPost | null> {
    if (!isUuid(postId)) return null;
    const rows = await queryWrite<PostRow>(
      "community",
      `${POST_SELECT} WHERE p.id = $1::uuid LIMIT 1`,
      [postId],
    );
    const row = rows[0];
    return row ? toPost(row) : null;
  }

  async findPostsByIds(postIds: readonly string[]): Promise<Map<string, StoredCommunityPost>> {
    const valid = postIds.filter(isUuid);
    if (valid.length === 0) return new Map();

    const rows = await queryWrite<PostRow>(
      "community",
      `${POST_SELECT} WHERE p.id = ANY($1::uuid[])`,
      [valid],
    );
    return new Map(rows.map((row) => [row.post_id, toPost(row)]));
  }

  /*
   * 새 글은 조회로 되읽지 않고 입력값으로 조립한다. 작성자 이름이 이미 인자로
   * 들어와 있어 다시 조회할 이유가 없다.
   */
  async insertPost(input: NewCommunityPost): Promise<StoredCommunityPost> {
    const rows = await queryWrite<{
      id: string;
      created_at: Date;
      updated_at: Date;
      status: string;
    }>(
      "community",
      `INSERT INTO posts (author_id, anonymous, category, title, body, firm_id, status)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, 'published')
       RETURNING id::text AS id, created_at, updated_at, status`,
      [
        input.author_id,
        input.anonymous,
        input.category,
        input.title,
        input.body,
        input.company_context?.company_id ?? null,
      ],
    );

    const created = rows[0];
    if (!created) {
      throw new ServiceError("COMMUNITY_POST_CREATE_FAILED", "게시글을 저장하지 못했습니다.", 500, true);
    }

    return {
      post_id: created.id,
      author_id: input.author_id,
      author_display_name: input.author_display_name,
      category: input.category,
      title: input.title,
      body: input.body,
      company_context: input.company_context,
      anonymous: input.anonymous,
      created_at: new Date(created.created_at).toISOString(),
      updated_at: new Date(created.updated_at).toISOString(),
      comment_count: 0,
      like_count: null,
      status: created.status as CommunityPostStatus,
    };
  }

  /*
   * 바꿀 항목만 갱신한다. COALESCE 를 쓰지 않고 "값이 넘어왔는지"를 별도 인자로
   * 받는 이유는, 사업장 연결을 없애는 것(null 로 바꾸기)과 건드리지 않는 것을
   * 구분해야 하기 때문이다.
   */
  async updatePost(postId: string, patch: CommunityPostPatch): Promise<StoredCommunityPost> {
    if (!isUuid(postId)) throw missingPost();

    const rows = await queryWrite<{ id: string }>(
      "community",
      `UPDATE posts
          SET category   = CASE WHEN $2::boolean THEN $3::text ELSE category END,
              title      = CASE WHEN $4::boolean THEN $5::text ELSE title END,
              body       = CASE WHEN $6::boolean THEN $7::text ELSE body END,
              anonymous  = CASE WHEN $8::boolean THEN $9::boolean ELSE anonymous END,
              firm_id    = CASE WHEN $10::boolean THEN $11::text ELSE firm_id END,
              updated_at = now()
        WHERE id = $1::uuid
        RETURNING id::text AS id`,
      [
        postId,
        patch.category !== undefined, patch.category ?? null,
        patch.title !== undefined, patch.title ?? null,
        patch.body !== undefined, patch.body ?? null,
        patch.anonymous !== undefined, patch.anonymous ?? null,
        patch.company_context !== undefined, patch.company_context?.company_id ?? null,
      ],
    );

    if (!rows[0]) throw missingPost();
    const updated = await this.findPostById(postId);
    if (!updated) throw missingPost();
    return updated;
  }

  /*
   * 상태별로 함께 남겨야 하는 시각이 다르다.
   * 삭제는 deleted_at, 숨김은 hidden_at 이며, 되돌릴 때는 둘 다 비운다.
   */
  async setPostStatus(postId: string, status: CommunityPostStatus): Promise<StoredCommunityPost> {
    if (!isUuid(postId)) throw missingPost();

    const rows = await queryWrite<{ id: string }>(
      "community",
      `UPDATE posts
          SET status     = $2,
              deleted_at = CASE WHEN $2 = 'deleted' THEN now() ELSE NULL END,
              hidden_at  = CASE WHEN $2 = 'hidden'  THEN now() ELSE NULL END,
              updated_at = now()
        WHERE id = $1::uuid
        RETURNING id::text AS id`,
      [postId, status],
    );

    if (!rows[0]) throw missingPost();
    const updated = await this.findPostById(postId);
    if (!updated) throw missingPost();
    return updated;
  }

  /*
   * 같은 사람이 같은 글을 신고해 두고 아직 처리되지 않은 건이 있는지 본다.
   *
   * 대기중(pending)만 본다. DB 의 유니크 인덱스가
   * `UNIQUE (reporter_id, post_id) WHERE status = 'pending'` 이라 조건을 똑같이
   * 맞춘 것이다. 예전에는 상태를 가리지 않고 막아서 앱이 DB 보다 엄격했고,
   * 기각된 신고를 다시 올릴 수 없었다.
   *
   * 처리가 끝난 신고(기각·승인)는 막지 않는다. 기각은 "이번엔 문제없다"는
   * 판단이지 다시는 신고하지 말라는 뜻이 아니고, 승인된 글은 이미 숨겨져서
   * 다시 신고할 경로가 없다.
   */
  async findPendingReport(
    postId: string,
    reporterId: string,
  ): Promise<StoredCommunityReport | null> {
    if (!isUuid(postId) || !isUuid(reporterId)) return null;

    const rows = await queryWrite<ReportRow>(
      "community",
      `${REPORT_SELECT}
        WHERE r.post_id = $1::uuid
          AND r.reporter_id = $2::uuid
          AND r.status = 'pending'
        ORDER BY r.created_at DESC
        LIMIT 1`,
      [postId, reporterId],
    );
    const row = rows[0];
    return row ? toReport(row) : null;
  }

  async insertReport(input: NewCommunityReport): Promise<StoredCommunityReport> {
    try {
      const rows = await queryWrite<ReportRow>(
        "community",
        `WITH inserted AS (
           INSERT INTO reports (
             post_id, reporter_id, reason, detail,
             snapshot_title, snapshot_body, snapshot_post_updated_at
           )
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::timestamptz)
           RETURNING *
         )
         SELECT
           r.id::text          AS report_id,
           r.post_id::text     AS post_id,
           r.reporter_id::text AS reporter_id,
           r.reason,
           r.detail,
           r.status,
           r.created_at,
           r.reviewed_at,
           r.reviewed_by::text AS reviewed_by,
           r.resolution_note,
           r.snapshot_title,
           r.snapshot_body,
           r.snapshot_post_updated_at
         FROM inserted r`,
        [
          input.post_id,
          input.reporter_id,
          input.reason,
          input.detail,
          input.post_snapshot.title,
          input.post_snapshot.body,
          input.post_snapshot.updated_at,
        ],
      );

      const created = rows[0];
      if (!created) {
        throw new ServiceError("COMMUNITY_REPORT_CREATE_FAILED", "신고를 접수하지 못했습니다.", 500, true);
      }
      return toReport(created);
    } catch (error) {
      /*
       * 두 요청이 동시에 들어오면 앞선 중복 확인을 둘 다 통과할 수 있다.
       * 그때는 DB 의 유니크 인덱스만이 확실하다 — 503 대신 같은 안내를 돌려준다.
       */
      if (isDatabaseError(error) && error.code === "23505") {
        throw new ServiceError("DUPLICATE_REPORT", "이미 신고한 게시글입니다.", 409, false);
      }
      throw error;
    }
  }

  async listReports(query: ReportListQuery): Promise<CommunityPage<StoredCommunityReport>> {
    const rows = await queryWrite<ReportRow>(
      "community",
      `${REPORT_SELECT}
        WHERE ($1::text IS NULL OR r.status = $1)
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT $2 OFFSET $3`,
      [query.status, query.limit, (query.page - 1) * query.limit],
    );

    const countRows = await queryWrite<{ total_count: string }>(
      "community",
      `SELECT count(*)::text AS total_count
         FROM reports r
        WHERE ($1::text IS NULL OR r.status = $1)`,
      [query.status],
    );

    return { items: rows.map(toReport), total: totalFrom(countRows, rows.length) };
  }

  async findReportById(reportId: string): Promise<StoredCommunityReport | null> {
    if (!isUuid(reportId)) return null;
    const rows = await queryWrite<ReportRow>(
      "community",
      `${REPORT_SELECT} WHERE r.id = $1::uuid LIMIT 1`,
      [reportId],
    );
    const row = rows[0];
    return row ? toReport(row) : null;
  }

  /*
   * 신고 검토와 게시글 숨김은 한 트랜잭션이어야 한다.
   * 신고만 승인되고 글이 그대로 남으면, 관리자는 처리했다고 보는데 신고된 글은
   * 계속 노출된다.
   *
   * 두 UPDATE 모두 조건을 붙인다. 신고는 대기중일 때만, 글은 공개 상태일 때만
   * 바꾼다 — 같은 신고를 두 번 승인하거나 이미 삭제된 글을 숨김으로 되살리지 않는다.
   */
  async reviewReport(reportId: string, patch: ReportReviewPatch): Promise<StoredCommunityReport> {
    if (!isUuid(reportId)) {
      throw new ServiceError("COMMUNITY_REPORT_NOT_FOUND", "신고 내역을 찾을 수 없습니다.", 404, false);
    }

    return withWriteTransaction("community", async (transaction) => {
      const rows = await transaction.query<ReportRow>(
        `WITH reviewed AS (
           UPDATE reports
              SET status          = $2,
                  reviewed_at     = now(),
                  reviewed_by     = $3::uuid,
                  resolution_note = $4
            WHERE id = $1::uuid
              AND status = 'pending'
            RETURNING *
         )
         SELECT
           r.id::text          AS report_id,
           r.post_id::text     AS post_id,
           r.reporter_id::text AS reporter_id,
           r.reason,
           r.detail,
           r.status,
           r.created_at,
           r.reviewed_at,
           r.reviewed_by::text AS reviewed_by,
           r.resolution_note,
           r.snapshot_title,
           r.snapshot_body,
           r.snapshot_post_updated_at
         FROM reviewed r`,
        [reportId, patch.status, patch.reviewed_by, patch.resolution_note],
      );

      const reviewed = rows[0];
      if (!reviewed) {
        throw new ServiceError(
          "COMMUNITY_REPORT_NOT_FOUND",
          "신고 내역을 찾을 수 없습니다.",
          404,
          false,
        );
      }

      if (patch.hide_post) {
        await transaction.query(
          `UPDATE posts
              SET status     = 'hidden',
                  hidden_at  = now(),
                  hidden_by  = $2::uuid,
                  updated_at = now()
            WHERE id = $1::uuid
              AND status = 'published'`,
          [reviewed.post_id, patch.reviewed_by],
        );
      }

      return toReport(reviewed);
    });
  }

  async findCompanyContext(companyId: string): Promise<CommunityCompanyContextDto | null> {
    const rows = await queryWrite<{ firm_id: string; sido: string | null; industry: string | null }>(
      "community",
      `SELECT firm_id, sido, industry FROM firms WHERE firm_id = $1 LIMIT 1`,
      [companyId],
    );
    const row = rows[0];
    if (!row) return null;
    return { company_id: row.firm_id, region: row.sido, industry: row.industry };
  }
}
