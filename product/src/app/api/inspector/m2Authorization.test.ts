import { beforeEach, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({
  usersByToken: new Map<string, {
    user_id: string;
    email: string;
    display_name: string;
    role: "user" | "admin" | "inspector";
  }>(),
  getOptionalSessionUser: vi.fn(async (token: string | null) => (
    token ? authState.usersByToken.get(token) ?? null : null
  )),
}));

const inspectorServices = vi.hoisted(() => ({
  getInspectorOverview: vi.fn(async () => ({ items: [], total: 0, page: 1, limit: 10 })),
  sendInspectorChatMessage: vi.fn(async () => ({ message: "ok" })),
  searchInspectorCompanies: vi.fn(async () => ({ items: [], total: 0 })),
  getInspectorCompanyDetail: vi.fn(async () => ({ company_id: "COMPANY_DEMO_001" })),
}));

const worksiteTipServices = vi.hoisted(() => ({
  createWorksiteTip: vi.fn(),
  listWorksiteTips: vi.fn(async () => ({
    source: "mock_memory",
    items: [],
    total: 0,
    page: 1,
    limit: 10,
  })),
  getWorksiteTip: vi.fn(async () => ({
    tip_id: "10000000-0000-4000-8000-000000000010",
    attachments: [],
  })),
  getWorksiteTipAttachment: vi.fn(async () => ({
    bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
    media_type: "image/png",
    size_bytes: 4,
  })),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/services/authService", () => ({
  getOptionalSessionUser: authState.getOptionalSessionUser,
}));
vi.mock("@/services/inspectorService", () => inspectorServices);
vi.mock("@/services/worksiteTipService", () => worksiteTipServices);

import { GET as getInspectorOverview } from "@/app/api/inspector/overview/route";
import { POST as postInspectorChat } from "@/app/api/inspector/chat/route";
import { GET as searchInspectorCompanies } from "@/app/api/inspector/companies/search/route";
import { GET as getInspectorCompany } from "@/app/api/inspector/companies/[companyId]/route";
import { GET as listWorksiteTips } from "@/app/api/worksite-tips/route";
import { GET as getWorksiteTip } from "@/app/api/worksite-tips/[tipId]/route";
import { GET as getWorksiteTipAttachment } from "@/app/api/worksite-tips/[tipId]/attachments/[attachmentId]/route";

const TIP_ID = "10000000-0000-4000-8000-000000000010";
const ATTACHMENT_ID = "10000000-0000-4000-8000-000000000011";

function request(
  path: string,
  token: string | null,
  init: RequestInit = {},
): Request {
  const headers = new Headers(init.headers);
  if (token) headers.set("cookie", `donworry_session=${token}`);
  return new Request(`http://localhost${path}`, { ...init, headers });
}

function companyContext(companyId = "COMPANY_DEMO_001") {
  return { params: Promise.resolve({ companyId }) };
}

function tipContext(tipId = TIP_ID) {
  return { params: Promise.resolve({ tipId }) };
}

function attachmentContext(tipId = TIP_ID, attachmentId = ATTACHMENT_ID) {
  return { params: Promise.resolve({ tipId, attachmentId }) };
}

const protectedEndpoints = [
  {
    name: "GET /api/inspector/overview",
    invoke: (token: string | null) => getInspectorOverview(
      request("/api/inspector/overview?page=1&limit=10", token),
    ),
    service: inspectorServices.getInspectorOverview,
  },
  {
    name: "POST /api/inspector/chat",
    invoke: (token: string | null) => postInspectorChat(request(
      "/api/inspector/chat",
      token,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "점검" }),
      },
    )),
    service: inspectorServices.sendInspectorChatMessage,
  },
  {
    name: "GET /api/inspector/companies/search",
    invoke: (token: string | null) => searchInspectorCompanies(
      request("/api/inspector/companies/search?q=회사&limit=10", token),
    ),
    service: inspectorServices.searchInspectorCompanies,
  },
  {
    name: "GET /api/inspector/companies/:companyId",
    invoke: (token: string | null) => getInspectorCompany(
      request("/api/inspector/companies/COMPANY_DEMO_001", token),
      companyContext(),
    ),
    service: inspectorServices.getInspectorCompanyDetail,
  },
  {
    name: "GET /api/worksite-tips",
    invoke: (token: string | null) => listWorksiteTips(
      request("/api/worksite-tips?page=1&limit=10", token),
    ),
    service: worksiteTipServices.listWorksiteTips,
  },
  {
    name: "GET /api/worksite-tips/:tipId",
    invoke: (token: string | null) => getWorksiteTip(
      request(`/api/worksite-tips/${TIP_ID}`, token),
      tipContext(),
    ),
    service: worksiteTipServices.getWorksiteTip,
  },
  {
    name: "GET /api/worksite-tips/:tipId/attachments/:attachmentId",
    invoke: (token: string | null) => getWorksiteTipAttachment(
      request(`/api/worksite-tips/${TIP_ID}/attachments/${ATTACHMENT_ID}`, token),
      attachmentContext(),
    ),
    service: worksiteTipServices.getWorksiteTipAttachment,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  authState.usersByToken.clear();
  authState.usersByToken.set("user-token", {
    user_id: "10000000-0000-4000-8000-000000000001",
    email: "user@example.com",
    display_name: "일반 사용자",
    role: "user",
  });
  authState.usersByToken.set("admin-token", {
    user_id: "10000000-0000-4000-8000-000000000002",
    email: "admin@example.com",
    display_name: "관리자",
    role: "admin",
  });
  authState.usersByToken.set("inspector-token", {
    user_id: "10000000-0000-4000-8000-000000000003",
    email: "inspector@example.com",
    display_name: "근로감독관",
    role: "inspector",
  });
});

describe.each(protectedEndpoints)("M2 $name 권한", ({ invoke, service }) => {
  it.each([
    ["비로그인", null],
    ["일반 사용자", "user-token"],
    ["관리자", "admin-token"],
  ])("%s 요청을 서비스 실행 전에 403으로 차단한다", async (_label, token) => {
    const response = await invoke(token);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "FORBIDDEN", retryable: false },
    });
    expect(service).not.toHaveBeenCalled();
  });

  it("근로감독관 요청만 서비스로 전달한다", async () => {
    const response = await invoke("inspector-token");

    expect(response.status).toBe(200);
    expect(service).toHaveBeenCalledOnce();
  });
});
