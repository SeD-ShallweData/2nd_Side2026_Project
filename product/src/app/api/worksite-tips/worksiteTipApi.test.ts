import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

vi.mock("server-only", () => ({}));

import type { SessionUserDto } from "@/app/api/auth/authApiContract";
import { WORKSITE_TIP_MAX_PHOTO_BYTES } from "@/app/api/worksite-tips/worksiteTipApiContract";
import { GET as getTip } from "@/app/api/worksite-tips/[tipId]/route";
import { GET as getAttachment } from "@/app/api/worksite-tips/[tipId]/attachments/[attachmentId]/route";
import { GET as listTips, POST as createTip } from "@/app/api/worksite-tips/route";
import { GET as listCommunityPosts } from "@/app/api/community/posts/route";
import { issueSession, resetMockSessionsForTests } from "@/server/auth/sessionStore";
import { resetMockCommunityStateForTests } from "@/services/communityService";
import {
  resetMockWorksiteTipsForTests,
  WORKSITE_TIP_MOCK_MAX_TIPS_PER_REPORTER,
} from "@/services/worksiteTipService";

const USER: SessionUserDto = {
  user_id: "10000000-0000-4000-8000-000000000001",
  email: "user@mock.donworry.local",
  display_name: "일반 사용자",
  role: "user",
};

const ADMIN: SessionUserDto = {
  user_id: "10000000-0000-4000-8000-000000000002",
  email: "admin@mock.donworry.local",
  display_name: "커뮤니티 관리자",
  role: "admin",
};

const INSPECTOR: SessionUserDto = {
  user_id: "10000000-0000-4000-8000-000000000003",
  email: "inspector@mock.donworry.local",
  display_name: "근로감독관",
  role: "inspector",
};

function cookieFor(user: SessionUserDto): string {
  return `donworry_session=${issueSession(user).token}`;
}

function validImageFile(name = "evidence.png"): File {
  const bytes = Uint8Array.from(Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ));
  return new File(
    [bytes],
    name,
    { type: "image/png" },
  );
}

async function generatedImageFile(format: "jpeg" | "webp"): Promise<File> {
  const image = sharp({
    create: {
      width: 1,
      height: 1,
      channels: 3,
      background: { r: 255, g: 0, b: 0 },
    },
  });
  const bytes = format === "jpeg"
    ? await image.jpeg().toBuffer()
    : await image.webp().toBuffer();
  return new File([Uint8Array.from(bytes)], `evidence.${format}`, { type: `image/${format}` });
}

function submissionRequest(options: {
  cookie?: string;
  title?: string;
  body?: string;
  companyId?: string;
  photos?: File[];
  origin?: string;
  extraHeaders?: HeadersInit;
} = {}): Request {
  const url = "http://localhost/api/worksite-tips";
  const form = new FormData();
  if (options.title !== undefined) form.set("title", options.title);
  if (options.body !== undefined) form.set("body", options.body);
  if (options.companyId !== undefined) form.set("company_id", options.companyId);
  for (const photo of options.photos ?? []) form.append("photos", photo);
  return new Request(url, {
    method: "POST",
    headers: {
      origin: options.origin ?? new URL(url).origin,
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...options.extraHeaders,
    },
    body: form,
  });
}

function tipContext(tipId: string): { params: Promise<{ tipId: string }> } {
  return { params: Promise.resolve({ tipId }) };
}

function attachmentContext(
  tipId: string,
  attachmentId: string,
): { params: Promise<{ tipId: string; attachmentId: string }> } {
  return { params: Promise.resolve({ tipId, attachmentId }) };
}

beforeEach(() => {
  vi.stubEnv("APP_DATA_MODE", "mock");
  vi.stubEnv("AUTH_DATA_MODE", "mock");
  vi.stubEnv("COMMUNITY_DATA_MODE", "mock");
  vi.stubEnv("WORKSITE_TIP_DATA_MODE", "mock");
  resetMockSessionsForTests();
  resetMockCommunityStateForTests();
  resetMockWorksiteTipsForTests();
});

afterEach(() => {
  resetMockSessionsForTests();
  resetMockCommunityStateForTests();
  resetMockWorksiteTipsForTests();
  vi.unstubAllEnvs();
});

describe("현장 제보 작성 계약", () => {
  it("일반 사용자가 글 제보를 접수하고 감독관만 목록과 상세를 본다", async () => {
    const createdResponse = await createTip(submissionRequest({
      cookie: cookieFor(USER),
      title: "안전난간이 없는 작업 구역",
      body: "작업 구역 가장자리에 안전난간이 설치되어 있지 않습니다.",
      companyId: "COMPANY_DEMO_001",
    }));
    const receipt = await createdResponse.json() as { tip_id: string };

    expect(createdResponse.status).toBe(201);
    expect(receipt).toMatchObject({
      category: "worksite_tip",
      title: "안전난간이 없는 작업 구역",
      attachment_count: 0,
    });
    expect(JSON.stringify(receipt)).not.toContain(USER.user_id);
    expect(JSON.stringify(receipt)).not.toContain(USER.email);

    const inspectorCookie = cookieFor(INSPECTOR);
    const listResponse = await listTips(new Request(
      "http://localhost/api/worksite-tips?page=1&limit=10",
      { headers: { cookie: inspectorCookie } },
    ));
    const list = await listResponse.json();
    expect(listResponse.status).toBe(200);
    expect(list).toMatchObject({
      source: "mock_memory",
      total: 1,
      items: [{
        tip_id: receipt.tip_id,
        category: "worksite_tip",
        company_context: {
          company_id: "COMPANY_DEMO_001",
          region: "인천광역시",
          industry: "건설업",
        },
      }],
    });
    expect(JSON.stringify(list)).not.toContain(USER.user_id);
    expect(JSON.stringify(list)).not.toContain(USER.email);

    const detailResponse = await getTip(
      new Request(`http://localhost/api/worksite-tips/${receipt.tip_id}`, {
        headers: { cookie: inspectorCookie },
      }),
      tipContext(receipt.tip_id),
    );
    expect(detailResponse.status).toBe(200);
    expect(await detailResponse.json()).toMatchObject({
      tip_id: receipt.tip_id,
      body: "작업 구역 가장자리에 안전난간이 설치되어 있지 않습니다.",
      attachments: [],
    });
  });

  it("본문 없이 사진만 첨부한 제보를 받고 감독관에게 인증된 사진을 제공한다", async () => {
    const photo = validImageFile("local-secret-name.png");
    const originalBytes = new Uint8Array(await photo.arrayBuffer());
    const createdResponse = await createTip(submissionRequest({
      cookie: cookieFor(USER),
      title: "현장 사진 제보",
      photos: [photo],
    }));
    const receipt = await createdResponse.json() as { tip_id: string; attachment_count: number };
    expect(createdResponse.status).toBe(201);
    expect(receipt.attachment_count).toBe(1);

    const inspectorCookie = cookieFor(INSPECTOR);
    const detailResponse = await getTip(
      new Request(`http://localhost/api/worksite-tips/${receipt.tip_id}`, {
        headers: { cookie: inspectorCookie },
      }),
      tipContext(receipt.tip_id),
    );
    const detail = await detailResponse.json() as {
      body: string | null;
      attachments: Array<{ attachment_id: string; media_type: string; content_url: string }>;
    };
    expect(detail.body).toBeNull();
    expect(detail.attachments).toHaveLength(1);
    expect(detail.attachments[0]).toMatchObject({ media_type: "image/png" });
    expect(JSON.stringify(detail)).not.toContain("local-secret-name.png");

    const attachmentId = detail.attachments[0].attachment_id;
    const attachmentResponse = await getAttachment(
      new Request(`http://localhost${detail.attachments[0].content_url}`, {
        headers: { cookie: inspectorCookie },
      }),
      attachmentContext(receipt.tip_id, attachmentId),
    );
    expect(attachmentResponse.status).toBe(200);
    expect(attachmentResponse.headers.get("content-type")).toBe("image/png");
    expect(attachmentResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(attachmentResponse.headers.get("x-content-type-options")).toBe("nosniff");
    expect(attachmentResponse.headers.get("content-disposition")).not.toContain("local-secret-name.png");
    expect(new Uint8Array(await attachmentResponse.arrayBuffer())).toEqual(originalBytes);
  });

  it("현장 제보를 일반 커뮤니티 게시글과 완전히 분리한다", async () => {
    const before = await listCommunityPosts(new Request("http://localhost/api/community/posts"));
    const beforeBody = await before.json() as { total: number };

    await createTip(submissionRequest({
      cookie: cookieFor(USER),
      title: "커뮤니티와 분리할 제보",
      body: "이 내용은 일반 게시글 목록에 표시되면 안 됩니다.",
    }));

    const after = await listCommunityPosts(new Request("http://localhost/api/community/posts"));
    const afterBody = await after.json() as { total: number; items: unknown[] };
    expect(afterBody.total).toBe(beforeBody.total);
    expect(JSON.stringify(afterBody.items)).not.toContain("커뮤니티와 분리할 제보");
  });

  it("비로그인·감독관의 작성과 일반 사용자·관리자의 조회를 차단한다", async () => {
    const anonymousCreate = await createTip(submissionRequest({
      title: "비로그인 제보",
      body: "로그인하지 않은 요청은 저장되면 안 됩니다.",
    }));
    expect(anonymousCreate.status).toBe(401);

    const inspectorCreate = await createTip(submissionRequest({
      cookie: cookieFor(INSPECTOR),
      title: "감독관 작성",
      body: "감독관 계정은 일반 사용자 제보를 작성하지 않습니다.",
    }));
    expect(inspectorCreate.status).toBe(403);

    const anonymousList = await listTips(new Request("http://localhost/api/worksite-tips"));
    expect(anonymousList.status).toBe(401);

    const userList = await listTips(new Request("http://localhost/api/worksite-tips", {
      headers: { cookie: cookieFor(USER) },
    }));
    expect(userList.status).toBe(403);

    const adminList = await listTips(new Request("http://localhost/api/worksite-tips", {
      headers: { cookie: cookieFor(ADMIN) },
    }));
    expect(adminList.status).toBe(403);
  });

  it("다른 출처의 작성 요청을 저장 전에 차단한다", async () => {
    const response = await createTip(submissionRequest({
      cookie: cookieFor(USER),
      title: "다른 출처 요청",
      body: "허용되지 않은 출처에서 보낸 요청입니다.",
      origin: "https://attacker.example",
      extraHeaders: { "sec-fetch-site": "cross-site" },
    }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "CROSS_SITE_REQUEST_REJECTED" },
    });

    const list = await listTips(new Request("http://localhost/api/worksite-tips", {
      headers: { cookie: cookieFor(INSPECTOR) },
    }));
    expect(await list.json()).toMatchObject({ total: 0 });
  });
});

describe("현장 제보 입력·조회 안전장치", () => {
  it("본문과 사진이 모두 없거나 multipart가 아닌 요청을 거부한다", async () => {
    const empty = await createTip(submissionRequest({
      cookie: cookieFor(USER),
      title: "내용 없는 제보",
    }));
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });

    const json = await createTip(new Request("http://localhost/api/worksite-tips", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: cookieFor(USER),
        origin: "http://localhost",
      },
      body: JSON.stringify({ title: "JSON 제보", body: "지원하지 않는 형식" }),
    }));
    expect(json.status).toBe(415);
    expect(await json.json()).toMatchObject({ error: { code: "UNSUPPORTED_MEDIA_TYPE" } });
  });

  it("허용되지 않은 파일과 위장 이미지 및 사진 개수 초과를 거부한다", async () => {
    const textFile = new File(["not an image"], "evidence.txt", { type: "text/plain" });
    const unsupported = await createTip(submissionRequest({
      cookie: cookieFor(USER),
      title: "텍스트 파일 첨부",
      photos: [textFile],
    }));
    expect(unsupported.status).toBe(415);

    const disguised = new File(["not a jpeg"], "fake.jpg", { type: "image/jpeg" });
    const invalid = await createTip(submissionRequest({
      cookie: cookieFor(USER),
      title: "위장 이미지 첨부",
      photos: [disguised],
    }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: "INVALID_IMAGE_FILE" } });

    const brokenHeaderOnly = new File(
      [new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])],
      "broken.jpg",
      { type: "image/jpeg" },
    );
    const broken = await createTip(submissionRequest({
      cookie: cookieFor(USER),
      title: "손상 이미지 첨부",
      photos: [brokenHeaderOnly],
    }));
    expect(broken.status).toBe(400);
    expect(await broken.json()).toMatchObject({ error: { code: "INVALID_IMAGE_FILE" } });

    const tooMany = await createTip(submissionRequest({
      cookie: cookieFor(USER),
      title: "사진 개수 초과",
      photos: [
        validImageFile("1.png"),
        validImageFile("2.png"),
        validImageFile("3.png"),
        validImageFile("4.png"),
      ],
    }));
    expect(tooMany.status).toBe(400);
  });

  it("정상 JPEG·WebP는 받고 선언한 MIME과 실제 형식이 다르면 거부한다", async () => {
    for (const format of ["jpeg", "webp"] as const) {
      const response = await createTip(submissionRequest({
        cookie: cookieFor(USER),
        title: `정상 ${format} 사진 제보`,
        photos: [await generatedImageFile(format)],
      }));
      expect(response.status).toBe(201);
    }

    const png = validImageFile();
    const mismatched = new File(
      [await png.arrayBuffer()],
      "mismatched.jpg",
      { type: "image/jpeg" },
    );
    const response = await createTip(submissionRequest({
      cookie: cookieFor(USER),
      title: "MIME 불일치 사진",
      photos: [mismatched],
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_IMAGE_FILE" } });
  });

  it("애니메이션 PNG와 종단이 없거나 뒤에 데이터가 붙은 이미지를 거부한다", async () => {
    const apngBytes = Uint8Array.from(Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAABAAAAAQAAAAAAAAAAAGQD6AAAs35jzQAAAA1JREFUeJxj+M/A8B8ABQAB/4mZPR0AAAAaZmNUTAAAAAEAAAABAAAAAQAAAAAAAAAAAGQD6AAAKA2JGQAAABFmZEFUAAAAAnicY2Bg+P8fAAMCAf/1e6XXAAAAAElFTkSuQmCC",
      "base64",
    ));
    const validPngBytes = new Uint8Array(await validImageFile().arrayBuffer());
    const invalidFiles = [
      new File([apngBytes], "animated.png", { type: "image/png" }),
      new File([validPngBytes.slice(0, -12)], "missing-iend.png", { type: "image/png" }),
      new File([validPngBytes, "<html>"], "trailing.png", { type: "image/png" }),
    ];
    for (const [index, photo] of invalidFiles.entries()) {
      const response = await createTip(submissionRequest({
        cookie: cookieFor(USER),
        title: `PNG 컨테이너 검증 ${index + 1}`,
        photos: [photo],
      }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "INVALID_IMAGE_FILE" } });
    }

    for (const format of ["jpeg", "webp"] as const) {
      const image = await generatedImageFile(format);
      const withTrailingData = new File(
        [await image.arrayBuffer(), "<html>"],
        `trailing.${format}`,
        { type: `image/${format}` },
      );
      const response = await createTip(submissionRequest({
        cookie: cookieFor(USER),
        title: `${format} 종단 검증`,
        photos: [withTrailingData],
      }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "INVALID_IMAGE_FILE" } });
    }
  });

  it("사진 한 장의 허용 크기를 초과하면 413으로 거부한다", async () => {
    const bytes = new Uint8Array(WORKSITE_TIP_MAX_PHOTO_BYTES + 1);
    bytes.set([0xff, 0xd8, 0xff], 0);
    const oversized = new File([bytes], "oversized.jpg", { type: "image/jpeg" });
    const response = await createTip(submissionRequest({
      cookie: cookieFor(USER),
      title: "크기 제한을 넘는 사진",
      photos: [oversized],
    }));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "REQUEST_BODY_TOO_LARGE" } });
  });

  it("Content-Length가 없는 12MiB 초과 스트림도 멈추지 않고 413으로 거부한다", async () => {
    let chunkCount = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunkCount >= 13) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(1024 * 1024));
        chunkCount += 1;
      },
    });
    const request = new Request("http://localhost/api/worksite-tips", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=oversized",
        cookie: cookieFor(USER),
        origin: "http://localhost",
      },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error("oversized request timed out")), 2_000);
    });
    let response: Response;
    try {
      response = await Promise.race([createTip(request), timeout]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "REQUEST_BODY_TOO_LARGE" } });
  });

  it("동시 제출에서도 Mock 제보자별 저장 건수를 넘지 않는다", async () => {
    const cookie = cookieFor(USER);
    const responses = await Promise.all(Array.from(
      { length: WORKSITE_TIP_MOCK_MAX_TIPS_PER_REPORTER + 10 },
      (_, index) => createTip(submissionRequest({
        cookie,
        title: `저장 한도 검증 제보 ${index + 1}`,
        body: "Mock 저장소의 사용자별 건수 제한을 검증합니다.",
      })),
    ));

    expect(responses.filter((response) => response.status === 201)).toHaveLength(
      WORKSITE_TIP_MOCK_MAX_TIPS_PER_REPORTER,
    );
    const rejected = responses.filter((response) => response.status === 507);
    expect(rejected).toHaveLength(10);
    expect(await rejected[0].json()).toMatchObject({ error: { code: "MOCK_STORAGE_LIMIT_REACHED" } });

    const list = await listTips(new Request("http://localhost/api/worksite-tips", {
      headers: { cookie: cookieFor(INSPECTOR) },
    }));
    expect(await list.json()).toMatchObject({ total: WORKSITE_TIP_MOCK_MAX_TIPS_PER_REPORTER });
  });

  it("동시 제출에서도 Mock 제보자별 사진 저장 용량을 넘지 않는다", async () => {
    const bytes = await sharp({
      create: {
        width: 1_536,
        height: 1_024,
        channels: 3,
        background: { r: 255, g: 0, b: 0 },
      },
    }).png({ compressionLevel: 0 }).toBuffer();
    expect(bytes.byteLength).toBeLessThanOrEqual(WORKSITE_TIP_MAX_PHOTO_BYTES);
    const photo = new File([Uint8Array.from(bytes)], "large-evidence.png", { type: "image/png" });
    const cookie = cookieFor(USER);

    const responses = await Promise.all(Array.from({ length: 6 }, (_, index) => (
      createTip(submissionRequest({
        cookie,
        title: `사진 저장 용량 검증 ${index + 1}`,
        photos: [photo],
      }))
    )));

    expect(responses.filter((response) => response.status === 201)).toHaveLength(4);
    const rejected = responses.filter((response) => response.status === 507);
    expect(rejected).toHaveLength(2);
    expect(await rejected[0].json()).toMatchObject({ error: { code: "MOCK_STORAGE_LIMIT_REACHED" } });

    const list = await listTips(new Request("http://localhost/api/worksite-tips", {
      headers: { cookie: cookieFor(INSPECTOR) },
    }));
    expect(await list.json()).toMatchObject({ total: 4 });
  });

  it("목록 페이지 입력과 존재하지 않는 제보를 구분한다", async () => {
    const invalidPage = await listTips(new Request(
      "http://localhost/api/worksite-tips?page=0&limit=21",
      { headers: { cookie: cookieFor(INSPECTOR) } },
    ));
    expect(invalidPage.status).toBe(400);
    expect(await invalidPage.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });

    const missing = await getTip(
      new Request("http://localhost/api/worksite-tips/missing", {
        headers: { cookie: cookieFor(INSPECTOR) },
      }),
      tipContext("missing"),
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "WORKSITE_TIP_NOT_FOUND" } });
  });

  it("다른 제보의 사진 ID를 조합한 조회를 404로 차단한다", async () => {
    const firstResponse = await createTip(submissionRequest({
      cookie: cookieFor(USER),
      title: "사진이 있는 첫 번째 제보",
      photos: [validImageFile()],
    }));
    const first = await firstResponse.json() as { tip_id: string };
    const firstDetailResponse = await getTip(
      new Request(`http://localhost/api/worksite-tips/${first.tip_id}`, {
        headers: { cookie: cookieFor(INSPECTOR) },
      }),
      tipContext(first.tip_id),
    );
    const firstDetail = await firstDetailResponse.json() as {
      attachments: Array<{ attachment_id: string }>;
    };

    const secondResponse = await createTip(submissionRequest({
      cookie: cookieFor(USER),
      title: "글만 있는 두 번째 제보",
      body: "첫 번째 제보의 사진을 이 제보 ID로 읽을 수 없어야 합니다.",
    }));
    const second = await secondResponse.json() as { tip_id: string };
    const mismatched = await getAttachment(
      new Request("http://localhost/api/worksite-tips/mismatched/attachments/mismatched", {
        headers: { cookie: cookieFor(INSPECTOR) },
      }),
      attachmentContext(second.tip_id, firstDetail.attachments[0].attachment_id),
    );
    expect(mismatched.status).toBe(404);
    expect(await mismatched.json()).toMatchObject({
      error: { code: "WORKSITE_TIP_ATTACHMENT_NOT_FOUND" },
    });
  });

  it("Real 모드에서 저장소 미연결을 Mock 성공으로 대체하지 않는다", async () => {
    vi.stubEnv("WORKSITE_TIP_DATA_MODE", "real");
    const response = await listTips(new Request("http://localhost/api/worksite-tips", {
      headers: { cookie: cookieFor(INSPECTOR) },
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "WORKSITE_TIP_PROVIDER_UNAVAILABLE", retryable: true },
    });
  });
});
