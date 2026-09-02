import { describe, expect, it, vi } from "vitest";
import type {
  CommunityPostDto,
  CommunityPostListResponse,
  CommunityReportReceiptDto,
  CreateCommunityPostRequest,
  UpdateCommunityPostRequest,
} from "@/app/api/community/communityApiContract";
import samples from "@/app/api/community/sample-responses.json";
import {
  CommunityApiError,
  createCommunityPost,
  deleteCommunityPost,
  getCommunityPost,
  listCommunityPosts,
  reportCommunityPost,
  updateCommunityPost,
} from "@/services/communityClient";

const POST_LIST = samples.post_list as unknown as CommunityPostListResponse;
const REPORT_RECEIPT = samples.report_receipt as unknown as CommunityReportReceiptDto;
const POST_DETAIL = POST_LIST.items[0] as CommunityPostDto;

const EMPTY_LIST: CommunityPostListResponse = {
  ...POST_LIST,
  query: "",
  category: null,
  items: [],
  total: 0,
  has_more: false,
  page: 1,
  page_size: 10,
  total_pages: 0,
};

const VALID_CREATE_INPUT: CreateCommunityPostRequest = {
  category: "wage",
  title: "급여일 변경 기록",
  body: "급여일이 바뀌었을 때 어떤 자료를 남기면 좋을지 궁금합니다.",
};

function createFetchMock(response: Response) {
  const fetchImpl = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
  fetchImpl.mockResolvedValue(response);
  return fetchImpl;
}

type FetchMock = ReturnType<typeof createFetchMock>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return jsonResponse(
    { error: { code, message, retryable: status >= 500, request_id: "req_test_0001", ...extra } },
    status,
  );
}

function readCall(fetchImpl: FetchMock, index = 0): { path: string; init: RequestInit } {
  const call = fetchImpl.mock.calls[index];
  if (!call) throw new Error("fetch가 호출되지 않았습니다.");
  return { path: String(call[0]), init: call[1] ?? {} };
}

function readSearchParams(path: string): URLSearchParams {
  return new URL(path, "http://localhost").searchParams;
}

function readJsonBody(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("오류가 발생하지 않았습니다.");
    },
    (caught: unknown) => caught,
  );
}

describe("커뮤니티 목록 조회", () => {
  it("샘플 응답의 envelope를 그대로 반환한다", async () => {
    const fetchImpl = createFetchMock(jsonResponse(POST_LIST));

    const result = await listCommunityPosts({}, { fetchImpl });

    expect(result).toEqual(POST_LIST);
    expect(result.source).toBe("mock_memory");
    expect(result.capabilities).toEqual(POST_LIST.capabilities);
    expect(result.items[0]?.post_id).toBe("post_mock_001");
    expect(result.items[0]?.viewer_permissions).toEqual(POST_LIST.items[0]?.viewer_permissions);

    const { path, init } = readCall(fetchImpl);
    expect(path).toBe("/api/community/posts");
    expect(init.method).toBe("GET");
    expect(init.headers).toBeUndefined();
  });

  it("빈 목록을 오류가 아니라 정상 결과로 처리한다", async () => {
    const fetchImpl = createFetchMock(jsonResponse(EMPTY_LIST));

    const result = await listCommunityPosts({ q: "존재하지않는검색어" }, { fetchImpl });

    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.total_pages).toBe(0);
    expect(result.has_more).toBe(false);
  });

  it("q·category·page·limit를 query로 조립하고 검색어를 trim한다", async () => {
    const fetchImpl = createFetchMock(jsonResponse(POST_LIST));

    await listCommunityPosts(
      { q: "  임금  ", category: "pre_employment", page: 2, limit: 5 },
      { fetchImpl },
    );

    const params = readSearchParams(readCall(fetchImpl).path);
    expect(params.get("q")).toBe("임금");
    expect(params.get("category")).toBe("pre_employment");
    expect(params.get("page")).toBe("2");
    expect(params.get("limit")).toBe("5");
  });

  it("값이 없는 파라미터는 query에서 생략해 서버 기본값을 사용한다", async () => {
    const fetchImpl = createFetchMock(jsonResponse(POST_LIST));

    await listCommunityPosts({ q: "   ", category: null }, { fetchImpl });

    expect(readCall(fetchImpl).path).toBe("/api/community/posts");
  });
});

describe("커뮤니티 상세 조회", () => {
  it("게시글 DTO를 그대로 반환한다", async () => {
    const fetchImpl = createFetchMock(jsonResponse(POST_DETAIL));

    const result = await getCommunityPost("post_mock_001", { fetchImpl });

    expect(result).toEqual(POST_DETAIL);
    expect(result.category_label).toBe("입사 전 확인");
    expect(result.author_label).toBeNull();
    expect(result.company_context?.region).toBe("서울특별시");

    const { path, init } = readCall(fetchImpl);
    expect(path).toBe("/api/community/posts/post_mock_001");
    expect(init.method).toBe("GET");
  });

  it("postId를 encodeURIComponent로 감싼다", async () => {
    const fetchImpl = createFetchMock(jsonResponse(POST_DETAIL));

    await getCommunityPost("post/mock 001?x=1", { fetchImpl });

    expect(readCall(fetchImpl).path).toBe("/api/community/posts/post%2Fmock%20001%3Fx%3D1");
  });
});

describe("커뮤니티 게시글 작성", () => {
  it("201 응답을 성공으로 처리하고 생성된 게시글을 반환한다", async () => {
    const fetchImpl = createFetchMock(jsonResponse(POST_DETAIL, 201));

    const result = await createCommunityPost(VALID_CREATE_INPUT, { fetchImpl });

    expect(result).toEqual(POST_DETAIL);
    expect(readCall(fetchImpl).path).toBe("/api/community/posts");
  });

  it("POST 요청을 application/json으로 보낸다", async () => {
    const fetchImpl = createFetchMock(jsonResponse(POST_DETAIL, 201));

    await createCommunityPost(VALID_CREATE_INPUT, { fetchImpl });

    const { init } = readCall(fetchImpl);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("명세에 없는 필드는 전송하지 않는다", async () => {
    const fetchImpl = createFetchMock(jsonResponse(POST_DETAIL, 201));
    const input = {
      ...VALID_CREATE_INPUT,
      post_id: "덮어쓰기 시도",
      status: "published",
      viewer_permissions: { can_edit: true },
    } as unknown as CreateCommunityPostRequest;

    await createCommunityPost(input, { fetchImpl });

    const body = readJsonBody(readCall(fetchImpl).init);
    expect(Object.keys(body).sort()).toEqual(["body", "category", "title"]);
  });

  it("company_id와 anonymous를 지정하면 그대로 전송한다", async () => {
    const fetchImpl = createFetchMock(jsonResponse(POST_DETAIL, 201));

    await createCommunityPost(
      { ...VALID_CREATE_INPUT, company_id: "COMPANY_DEMO_001", anonymous: false },
      { fetchImpl },
    );

    expect(readJsonBody(readCall(fetchImpl).init)).toEqual({
      category: "wage",
      title: VALID_CREATE_INPUT.title,
      body: VALID_CREATE_INPUT.body,
      company_id: "COMPANY_DEMO_001",
      anonymous: false,
    });
  });

  it("company_id를 null로 지정하면 null을 전송한다", async () => {
    const fetchImpl = createFetchMock(jsonResponse(POST_DETAIL, 201));

    await createCommunityPost({ ...VALID_CREATE_INPUT, company_id: null }, { fetchImpl });

    const body = readJsonBody(readCall(fetchImpl).init);
    expect(body.company_id).toBeNull();
    expect("anonymous" in body).toBe(false);
  });
});

describe("커뮤니티 게시글 신고", () => {
  it("201 응답의 신고 접수 정보를 반환한다", async () => {
    const fetchImpl = createFetchMock(jsonResponse(REPORT_RECEIPT, 201));

    const result = await reportCommunityPost("post_mock_002", { reason: "spam" }, { fetchImpl });

    expect(result).toEqual(REPORT_RECEIPT);
    expect(result.status).toBe("pending");
    expect(result.reviewed_at).toBeNull();

    const { path, init } = readCall(fetchImpl);
    expect(path).toBe("/api/community/posts/post_mock_002/reports");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("detail이 undefined이면 키 자체를 보내지 않는다", async () => {
    const fetchImpl = createFetchMock(jsonResponse(REPORT_RECEIPT, 201));

    await reportCommunityPost("post_mock_002", { reason: "abuse", detail: undefined }, { fetchImpl });

    const body = readJsonBody(readCall(fetchImpl).init);
    expect(body).toEqual({ reason: "abuse" });
    expect("detail" in body).toBe(false);
  });

  it("detail을 지정하면 함께 전송한다", async () => {
    const fetchImpl = createFetchMock(jsonResponse(REPORT_RECEIPT, 201));

    await reportCommunityPost(
      "post_mock_002",
      { reason: "privacy", detail: "개인정보가 포함되어 있습니다." },
      { fetchImpl },
    );

    expect(readJsonBody(readCall(fetchImpl).init)).toEqual({
      reason: "privacy",
      detail: "개인정보가 포함되어 있습니다.",
    });
  });
});

describe("커뮤니티 게시글 수정", () => {
  it("PATCH로 수정된 게시글 DTO를 반환한다", async () => {
    const fetchImpl = createFetchMock(jsonResponse(POST_DETAIL));

    const result = await updateCommunityPost("post_mock_001", { title: "수정한 제목" }, { fetchImpl });

    expect(result).toEqual(POST_DETAIL);

    const { path, init } = readCall(fetchImpl);
    expect(path).toBe("/api/community/posts/post_mock_001");
    expect(init.method).toBe("PATCH");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("지정한 필드만 부분 수정 본문에 담는다", async () => {
    const fetchImpl = createFetchMock(jsonResponse(POST_DETAIL));

    await updateCommunityPost("post_mock_001", { title: "제목만 수정" }, { fetchImpl });

    expect(readJsonBody(readCall(fetchImpl).init)).toEqual({ title: "제목만 수정" });
  });

  it("명세에 없는 필드는 전송하지 않는다", async () => {
    const fetchImpl = createFetchMock(jsonResponse(POST_DETAIL));
    const input = {
      title: "수정한 제목",
      post_id: "덮어쓰기 시도",
      status: "published",
    } as unknown as UpdateCommunityPostRequest;

    await updateCommunityPost("post_mock_001", input, { fetchImpl });

    expect(Object.keys(readJsonBody(readCall(fetchImpl).init))).toEqual(["title"]);
  });

  it("company_id를 null로 지정하면 null을 전송한다", async () => {
    const fetchImpl = createFetchMock(jsonResponse(POST_DETAIL));

    await updateCommunityPost("post_mock_001", { company_id: null }, { fetchImpl });

    expect(readJsonBody(readCall(fetchImpl).init)).toEqual({ company_id: null });
  });

  it("바뀐 값이 없으면 빈 본문을 그대로 보내고 서버 판단에 맡긴다", async () => {
    const fetchImpl = createFetchMock(
      errorResponse(400, "VALIDATION_ERROR", "수정할 항목이 없습니다."),
    );

    const caught = await captureError(updateCommunityPost("post_mock_001", {}, { fetchImpl }));

    expect(readJsonBody(readCall(fetchImpl).init)).toEqual({});
    expect(caught).toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
  });

  it("postId를 encodeURIComponent로 감싼다", async () => {
    const fetchImpl = createFetchMock(jsonResponse(POST_DETAIL));

    await updateCommunityPost("post/mock 001", { title: "수정한 제목" }, { fetchImpl });

    expect(readCall(fetchImpl).path).toBe("/api/community/posts/post%2Fmock%20001");
  });
});

describe("커뮤니티 게시글 삭제", () => {
  it("DELETE로 삭제 결과를 반환한다", async () => {
    const fetchImpl = createFetchMock(jsonResponse({ deleted: true, post_id: "post_mock_001" }));

    const result = await deleteCommunityPost("post_mock_001", { fetchImpl });

    expect(result).toEqual({ deleted: true, post_id: "post_mock_001" });

    const { path, init } = readCall(fetchImpl);
    expect(path).toBe("/api/community/posts/post_mock_001");
    expect(init.method).toBe("DELETE");
  });

  it("본문과 Content-Type 없이 요청한다", async () => {
    const fetchImpl = createFetchMock(jsonResponse({ deleted: true, post_id: "post_mock_001" }));

    await deleteCommunityPost("post_mock_001", { fetchImpl });

    const { init } = readCall(fetchImpl);
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
  });

  it("postId를 encodeURIComponent로 감싼다", async () => {
    const fetchImpl = createFetchMock(jsonResponse({ deleted: true, post_id: "x" }));

    await deleteCommunityPost("post/mock 001", { fetchImpl });

    expect(readCall(fetchImpl).path).toBe("/api/community/posts/post%2Fmock%20001");
  });
});

describe("수정·삭제 오류 분기", () => {
  interface MutationErrorCase {
    label: string;
    status: number;
    code: string;
    invoke: (fetchImpl: FetchMock) => Promise<unknown>;
  }

  const MUTATION_ERROR_CASES: MutationErrorCase[] = [
    { label: "수정 로그인 필요", status: 401, code: "AUTHENTICATION_REQUIRED", invoke: (fetchImpl) => updateCommunityPost("post_mock_001", { title: "수정" }, { fetchImpl }) },
    { label: "수정 소유자 아님", status: 403, code: "RESOURCE_OWNERSHIP_REQUIRED", invoke: (fetchImpl) => updateCommunityPost("post_mock_001", { title: "수정" }, { fetchImpl }) },
    { label: "수정 교차 출처 차단", status: 403, code: "CROSS_SITE_REQUEST_REJECTED", invoke: (fetchImpl) => updateCommunityPost("post_mock_001", { title: "수정" }, { fetchImpl }) },
    { label: "수정 게시글 없음", status: 404, code: "COMMUNITY_POST_NOT_FOUND", invoke: (fetchImpl) => updateCommunityPost("post_missing", { title: "수정" }, { fetchImpl }) },
    { label: "수정 사업장 없음", status: 404, code: "COMPANY_NOT_FOUND", invoke: (fetchImpl) => updateCommunityPost("post_mock_001", { company_id: "NO_SUCH" }, { fetchImpl }) },
    { label: "수정 불가 상태", status: 409, code: "COMMUNITY_POST_NOT_EDITABLE", invoke: (fetchImpl) => updateCommunityPost("post_mock_001", { title: "수정" }, { fetchImpl }) },
    { label: "수정 본문 크기 초과", status: 413, code: "REQUEST_BODY_TOO_LARGE", invoke: (fetchImpl) => updateCommunityPost("post_mock_001", { title: "수정" }, { fetchImpl }) },
    { label: "수정 지원하지 않는 형식", status: 415, code: "UNSUPPORTED_MEDIA_TYPE", invoke: (fetchImpl) => updateCommunityPost("post_mock_001", { title: "수정" }, { fetchImpl }) },
    { label: "수정 저장소 미연결", status: 503, code: "COMMUNITY_PROVIDER_UNAVAILABLE", invoke: (fetchImpl) => updateCommunityPost("post_mock_001", { title: "수정" }, { fetchImpl }) },
    { label: "삭제 로그인 필요", status: 401, code: "AUTHENTICATION_REQUIRED", invoke: (fetchImpl) => deleteCommunityPost("post_mock_001", { fetchImpl }) },
    { label: "삭제 소유자 아님", status: 403, code: "RESOURCE_OWNERSHIP_REQUIRED", invoke: (fetchImpl) => deleteCommunityPost("post_mock_001", { fetchImpl }) },
    { label: "삭제 교차 출처 차단", status: 403, code: "CROSS_SITE_REQUEST_REJECTED", invoke: (fetchImpl) => deleteCommunityPost("post_mock_001", { fetchImpl }) },
    { label: "삭제 게시글 없음", status: 404, code: "COMMUNITY_POST_NOT_FOUND", invoke: (fetchImpl) => deleteCommunityPost("post_missing", { fetchImpl }) },
    { label: "삭제 식별값 오류", status: 400, code: "VALIDATION_ERROR", invoke: (fetchImpl) => deleteCommunityPost("   ", { fetchImpl }) },
    { label: "삭제 저장소 미연결", status: 503, code: "COMMUNITY_PROVIDER_UNAVAILABLE", invoke: (fetchImpl) => deleteCommunityPost("post_mock_001", { fetchImpl }) },
    { label: "삭제 내부 오류", status: 500, code: "INTERNAL_ERROR", invoke: (fetchImpl) => deleteCommunityPost("post_mock_001", { fetchImpl }) },
  ];

  it.each(MUTATION_ERROR_CASES)("$label — status $status와 code $code를 그대로 전달한다", async ({ status, code, invoke }) => {
    const fetchImpl = createFetchMock(errorResponse(status, code, "서버가 보낸 메시지"));

    const caught = await captureError(invoke(fetchImpl));

    expect(caught).toBeInstanceOf(CommunityApiError);
    expect(caught).toMatchObject({ status, code, requestId: "req_test_0001" });
  });

  it("수정 검증 오류의 details를 보존한다", async () => {
    const fetchImpl = createFetchMock(
      jsonResponse(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "게시글 입력값을 확인해 주세요.",
            details: [{ field: "title", reason: "title은 2자 이상 120자 이하여야 합니다." }],
            retryable: false,
            request_id: "req_edit",
          },
        },
        400,
      ),
    );

    const caught = (await captureError(
      updateCommunityPost("post_mock_001", { title: "가" }, { fetchImpl }),
    )) as CommunityApiError;

    expect(caught.details).toEqual([
      { field: "title", reason: "title은 2자 이상 120자 이하여야 합니다." },
    ]);
    expect(caught.requestId).toBe("req_edit");
  });

  it("수정 응답이 JSON이 아니면 기본 오류로 처리한다", async () => {
    const fetchImpl = createFetchMock(
      new Response("<html>500</html>", { status: 500, headers: { "content-type": "text/html" } }),
    );

    const caught = await captureError(updateCommunityPost("post_mock_001", { title: "수정" }, { fetchImpl }));

    expect(caught).toMatchObject({ status: 500, code: "UNEXPECTED_ERROR_RESPONSE", retryable: true });
  });

  it("삭제의 네트워크 오류를 CommunityApiError로 바꾸지 않는다", async () => {
    const fetchImpl = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
    const networkError = new TypeError("fetch failed");
    fetchImpl.mockRejectedValue(networkError);

    const caught = await captureError(deleteCommunityPost("post_mock_001", { fetchImpl }));

    expect(caught).toBe(networkError);
    expect(caught).not.toBeInstanceOf(CommunityApiError);
  });

  it("수정 요청의 AbortError를 그대로 전달한다", async () => {
    const fetchImpl = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    fetchImpl.mockRejectedValue(abortError);

    const caught = await captureError(updateCommunityPost("post_mock_001", { title: "수정" }, { fetchImpl }));

    expect(caught).toBe(abortError);
    expect((caught as DOMException).name).toBe("AbortError");
    expect(caught).not.toBeInstanceOf(CommunityApiError);
  });
});

describe("HTTP 오류 분기", () => {
  interface ErrorCase {
    label: string;
    status: number;
    code: string;
    invoke: (fetchImpl: FetchMock) => Promise<unknown>;
  }

  const ERROR_CASES: ErrorCase[] = [
    { label: "목록 검증 실패", status: 400, code: "VALIDATION_ERROR", invoke: (fetchImpl) => listCommunityPosts({ page: 0 }, { fetchImpl }) },
    { label: "목록 커뮤니티 저장소 미연결", status: 503, code: "COMMUNITY_PROVIDER_UNAVAILABLE", invoke: (fetchImpl) => listCommunityPosts({}, { fetchImpl }) },
    { label: "목록 인증 저장소 미연결", status: 503, code: "AUTH_PROVIDER_UNAVAILABLE", invoke: (fetchImpl) => listCommunityPosts({}, { fetchImpl }) },
    { label: "목록 내부 오류", status: 500, code: "INTERNAL_ERROR", invoke: (fetchImpl) => listCommunityPosts({}, { fetchImpl }) },
    { label: "상세 게시글 없음", status: 404, code: "COMMUNITY_POST_NOT_FOUND", invoke: (fetchImpl) => getCommunityPost("post_missing", { fetchImpl }) },
    { label: "작성 로그인 필요", status: 401, code: "AUTHENTICATION_REQUIRED", invoke: (fetchImpl) => createCommunityPost(VALID_CREATE_INPUT, { fetchImpl }) },
    { label: "작성 교차 출처 차단", status: 403, code: "CROSS_SITE_REQUEST_REJECTED", invoke: (fetchImpl) => createCommunityPost(VALID_CREATE_INPUT, { fetchImpl }) },
    { label: "작성 사업장 없음", status: 404, code: "COMPANY_NOT_FOUND", invoke: (fetchImpl) => createCommunityPost({ ...VALID_CREATE_INPUT, company_id: "NO_SUCH_COMPANY" }, { fetchImpl }) },
    { label: "작성 본문 크기 초과", status: 413, code: "REQUEST_BODY_TOO_LARGE", invoke: (fetchImpl) => createCommunityPost(VALID_CREATE_INPUT, { fetchImpl }) },
    { label: "작성 지원하지 않는 형식", status: 415, code: "UNSUPPORTED_MEDIA_TYPE", invoke: (fetchImpl) => createCommunityPost(VALID_CREATE_INPUT, { fetchImpl }) },
    { label: "신고 본인 글", status: 409, code: "SELF_REPORT_NOT_ALLOWED", invoke: (fetchImpl) => reportCommunityPost("post_mock_001", { reason: "spam" }, { fetchImpl }) },
    { label: "신고 중복", status: 409, code: "DUPLICATE_REPORT", invoke: (fetchImpl) => reportCommunityPost("post_mock_002", { reason: "spam" }, { fetchImpl }) },
    { label: "신고 불가 상태", status: 409, code: "COMMUNITY_POST_NOT_REPORTABLE", invoke: (fetchImpl) => reportCommunityPost("post_mock_003", { reason: "spam" }, { fetchImpl }) },
  ];

  it.each(ERROR_CASES)("$label — status $status와 code $code를 그대로 전달한다", async ({ status, code, invoke }) => {
    const fetchImpl = createFetchMock(errorResponse(status, code, "서버가 보낸 메시지"));

    const caught = await captureError(invoke(fetchImpl));

    expect(caught).toBeInstanceOf(CommunityApiError);
    expect(caught).toMatchObject({ status, code, requestId: "req_test_0001" });
  });

  it("검증 오류의 status·code·message·retryable·requestId·details를 모두 보존한다", async () => {
    const fetchImpl = createFetchMock(
      jsonResponse(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "게시글 입력값을 확인해 주세요.",
            details: [{ field: "title", reason: "title은 2자 이상 120자 이하여야 합니다." }],
            retryable: false,
            request_id: "req_9f2c",
          },
        },
        400,
      ),
    );

    const caught = await captureError(createCommunityPost(VALID_CREATE_INPUT, { fetchImpl }));

    expect(caught).toBeInstanceOf(CommunityApiError);
    const error = caught as CommunityApiError;
    expect(error.status).toBe(400);
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.message).toBe("게시글 입력값을 확인해 주세요.");
    expect(error.retryable).toBe(false);
    expect(error.requestId).toBe("req_9f2c");
    expect(error.details).toEqual([
      { field: "title", reason: "title은 2자 이상 120자 이하여야 합니다." },
    ]);
    expect(error.name).toBe("CommunityApiError");
  });

  it("재시도 가능한 503의 retryable을 true로 보존한다", async () => {
    const fetchImpl = createFetchMock(
      jsonResponse(
        {
          error: {
            code: "COMMUNITY_PROVIDER_UNAVAILABLE",
            message: "커뮤니티 저장소가 아직 연결되지 않았습니다.",
            retryable: true,
            request_id: "req_503",
          },
        },
        503,
      ),
    );

    const caught = await captureError(listCommunityPosts({}, { fetchImpl }));

    expect(caught).toMatchObject({ status: 503, code: "COMMUNITY_PROVIDER_UNAVAILABLE", retryable: true });
  });

  it("메시지가 달라도 같은 code로 분기할 수 있다", async () => {
    const first = createFetchMock(errorResponse(409, "DUPLICATE_REPORT", "이미 신고한 게시글입니다."));
    const second = createFetchMock(errorResponse(409, "DUPLICATE_REPORT", "다른 문구로 바뀐 메시지"));

    const firstError = (await captureError(
      reportCommunityPost("post_mock_002", { reason: "spam" }, { fetchImpl: first }),
    )) as CommunityApiError;
    const secondError = (await captureError(
      reportCommunityPost("post_mock_002", { reason: "spam" }, { fetchImpl: second }),
    )) as CommunityApiError;

    expect(firstError.code).toBe(secondError.code);
    expect(firstError.message).not.toBe(secondError.message);
  });
});

describe("비정상 응답 처리", () => {
  it("JSON이 아닌 오류 응답을 기본 오류로 처리한다", async () => {
    const fetchImpl = createFetchMock(
      new Response("<html><body>500 Internal Server Error</body></html>", {
        status: 500,
        headers: { "content-type": "text/html" },
      }),
    );

    const caught = await captureError(listCommunityPosts({}, { fetchImpl }));

    expect(caught).toBeInstanceOf(CommunityApiError);
    const error = caught as CommunityApiError;
    expect(error.status).toBe(500);
    expect(error.code).toBe("UNEXPECTED_ERROR_RESPONSE");
    expect(error.message).toBe("요청을 처리하지 못했습니다.");
    expect(error.retryable).toBe(true);
    expect(error.requestId).toBeNull();
    expect(error.details).toBeUndefined();
  });

  it("error envelope가 없는 오류 응답에서 status로 retryable을 유도한다", async () => {
    const fetchImpl = createFetchMock(jsonResponse({ message: "봉투 없는 응답" }, 403));

    const caught = await captureError(createCommunityPost(VALID_CREATE_INPUT, { fetchImpl }));

    expect(caught).toMatchObject({
      status: 403,
      code: "UNEXPECTED_ERROR_RESPONSE",
      retryable: false,
      requestId: null,
    });
  });

  it.each([
    ["빈 본문", ""],
    ["HTML 본문", "<html></html>"],
    ["잘린 JSON", '{"items":'],
  ])("성공 status인데 %s이면 INVALID_RESPONSE_BODY로 처리한다", async (_label, rawBody) => {
    const fetchImpl = createFetchMock(new Response(rawBody, { status: 200 }));

    const caught = await captureError(listCommunityPosts({}, { fetchImpl }));

    expect(caught).toBeInstanceOf(CommunityApiError);
    expect(caught).toMatchObject({ status: 200, code: "INVALID_RESPONSE_BODY", retryable: true });
  });

  it("details가 배열이 아니거나 형식이 어긋나면 유효한 항목만 남긴다", async () => {
    const fetchImpl = createFetchMock(
      jsonResponse(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "확인해 주세요.",
            details: [{ reason: "정상 항목" }, { field: "title" }, "문자열", null],
            retryable: false,
            request_id: "req_detail",
          },
        },
        400,
      ),
    );

    const caught = (await captureError(listCommunityPosts({}, { fetchImpl }))) as CommunityApiError;

    expect(caught.details).toEqual([{ field: undefined, reason: "정상 항목" }]);
  });

  it("details가 배열이 아니면 undefined로 둔다", async () => {
    const fetchImpl = createFetchMock(
      jsonResponse(
        { error: { code: "VALIDATION_ERROR", message: "확인해 주세요.", details: "배열 아님", retryable: false } },
        400,
      ),
    );

    const caught = (await captureError(listCommunityPosts({}, { fetchImpl }))) as CommunityApiError;

    expect(caught.details).toBeUndefined();
    expect(caught.requestId).toBeNull();
  });
});

describe("네트워크 오류와 요청 취소", () => {
  it("fetch 네트워크 오류를 CommunityApiError로 바꾸지 않는다", async () => {
    const fetchImpl = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
    const networkError = new TypeError("fetch failed");
    fetchImpl.mockRejectedValue(networkError);

    const caught = await captureError(listCommunityPosts({}, { fetchImpl }));

    expect(caught).toBe(networkError);
    expect(caught).toBeInstanceOf(TypeError);
    expect(caught).not.toBeInstanceOf(CommunityApiError);
  });

  it("AbortError를 그대로 전달한다", async () => {
    const fetchImpl = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    fetchImpl.mockRejectedValue(abortError);

    const caught = await captureError(getCommunityPost("post_mock_001", { fetchImpl }));

    expect(caught).toBe(abortError);
    expect(caught).toBeInstanceOf(DOMException);
    expect((caught as DOMException).name).toBe("AbortError");
    expect(caught).not.toBeInstanceOf(CommunityApiError);
  });

  it("전달한 AbortSignal을 fetch에 넘긴다", async () => {
    const fetchImpl = createFetchMock(jsonResponse(POST_LIST));
    const controller = new AbortController();

    await listCommunityPosts({}, { fetchImpl, signal: controller.signal });

    expect(readCall(fetchImpl).init.signal).toBe(controller.signal);
  });
});
