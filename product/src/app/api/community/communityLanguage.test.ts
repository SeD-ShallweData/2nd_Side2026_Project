import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { SessionUserDto } from "@/app/api/auth/authApiContract";
import { COMMUNITY_POST_LANGUAGES, type CommunityPostListResponse } from "@/app/api/community/communityApiContract";
import { GET as getPost } from "@/app/api/community/posts/[postId]/route";
import { GET as listPosts, POST as createPost } from "@/app/api/community/posts/route";
import { MockAuthRepository, resetMockSessions } from "@/adapters/mock/MockAuthRepository";
import { resetMockCommunityState } from "@/adapters/mock/MockCommunityRepository";
import { postLanguageLabel } from "@/components/community/communityFormat";
import { TEXT_LANGUAGES } from "@/domain/textLanguage";
import { communityMessages } from "@/i18n/messages/community";

const USER: SessionUserDto = {
  user_id: "10000000-0000-4000-8000-000000000001",
  email: "user@mock.donworry.local",
  display_name: "일반 사용자",
  role: "user",
};

const authRepository = new MockAuthRepository();

async function writePost(title: string, body: string): Promise<string> {
  const cookie = `donworry_session=${(await authRepository.issueSession(USER)).token}`;
  const response = await createPost(new Request("http://localhost/api/community/posts", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost", cookie },
    body: JSON.stringify({ category: "wage", title, body }),
  }));
  expect(response.status).toBe(201);
  return ((await response.json()) as { post_id: string }).post_id;
}

async function list(query: string): Promise<Response> {
  return listPosts(new Request(`http://localhost/api/community/posts${query}`));
}

beforeEach(() => {
  vi.stubEnv("COMMUNITY_DATA_MODE", "mock");
  vi.stubEnv("APP_DATA_MODE", "mock");
  resetMockSessions();
  resetMockCommunityState();
});

afterEach(() => {
  resetMockSessions();
  resetMockCommunityState();
  vi.unstubAllEnvs();
});

describe("커뮤니티 작성 언어(언어 지원 3단계)", () => {
  it("공개 계약의 언어 목록이 추정 규칙의 언어 목록과 같다", () => {
    expect([...COMMUNITY_POST_LANGUAGES]).toEqual([...TEXT_LANGUAGES]);
  });

  it("글마다 작성 언어를 싣고, 글 내용은 번역하지 않는다", async () => {
    const postId = await writePost("Công ty chưa trả lương", "Tôi đã làm việc ba tháng nhưng chưa nhận được tiền lương.");
    const detail = await (await getPost(new Request(`http://localhost/api/community/posts/${postId}`), {
      params: Promise.resolve({ postId }),
    })).json();
    expect(detail).toMatchObject({ language: "vi", title: "Công ty chưa trả lương" });

    const all = await (await list("")).json() as CommunityPostListResponse;
    expect(all.language).toBeNull();
    expect(all.items.find((item) => item.post_id === postId)?.language).toBe("vi");
    // 시드 글은 한국어다.
    expect(all.items.filter((item) => item.post_id !== postId).every((item) => item.language === "ko")).toBe(true);
  });

  it("작성 언어로 거르고 건수·페이지도 거른 결과로 센다", async () => {
    await writePost("Công ty chưa trả lương", "Tôi đã làm việc ba tháng nhưng chưa nhận được tiền lương.");
    await writePost("Unpaid overtime", "My employer did not pay overtime for two months.");
    await writePost("老板两个月没有发工资", "老板两个月没有发工资，我该去哪里咨询比较好？");

    const vi = await (await list("?language=vi")).json() as CommunityPostListResponse;
    expect(vi).toMatchObject({ language: "vi", total: 1 });
    expect(vi.items.map((item) => item.language)).toEqual(["vi"]);

    const ko = await (await list("?language=ko&limit=2")).json() as CommunityPostListResponse;
    expect(ko).toMatchObject({ total: 4, total_pages: 2 });
    expect(ko.items.every((item) => item.language === "ko")).toBe(true);

    const th = await (await list("?language=th")).json() as CommunityPostListResponse;
    expect(th).toMatchObject({ total: 0, items: [] });
  });

  it("지원하지 않는 언어 값은 400으로 막는다", async () => {
    const response = await list("?language=ja");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });

  it("작성 언어 표시는 화면 언어로, 언어 이름은 그 언어의 이름으로 쓴다", () => {
    expect(postLanguageLabel("vi")).toBe("작성 언어: Tiếng Việt");
    expect(postLanguageLabel("other", communityMessages.en.postLanguage)).toBe("Written in: Other languages");
    expect(postLanguageLabel("zh", communityMessages.th.postLanguage)).toBe("เขียนเป็นภาษา: 中文");
    expect(postLanguageLabel(undefined)).toBeNull();
  });
});
