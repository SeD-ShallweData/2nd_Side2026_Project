import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { SessionUserDto } from "@/app/api/auth/authApiContract";
import type { TranslationRequest, Translator } from "@/domain/translation";
import {
  createWorksiteTip,
  getWorksiteTip,
  listWorksiteTips,
  resetMockWorksiteTipsForTests,
} from "@/services/worksiteTipService";

/*
 * 현장 제보 번역(언어 지원 3단계).
 * 한국어가 아닌 제보는 저장 전에 한국어로 옮기고, 번역이 어떻게 실패해도 접수는 끝나야 한다.
 */

const USER: SessionUserDto = {
  user_id: "10000000-0000-4000-8000-000000000001",
  email: "user@mock.donworry.local",
  display_name: "일반 사용자",
  role: "user",
};

const INSPECTOR: SessionUserDto = {
  user_id: "10000000-0000-4000-8000-000000000003",
  email: "inspector@mock.donworry.local",
  display_name: "근로감독관",
  role: "inspector",
};

function request(title: string, body: string | null, locale?: string): Request {
  const form = new FormData();
  form.set("category", "wage");
  form.set("title", title);
  if (body !== null) form.set("body", body);
  return new Request("http://localhost/api/worksite-tips", {
    method: "POST",
    headers: locale ? { cookie: `donworry_session=x; donworry_locale=${locale}` } : {},
    body: form,
  });
}

function recordingTranslator(respond: (request: TranslationRequest) => ReturnType<Translator>) {
  const calls: TranslationRequest[] = [];
  const translator: Translator = (translationRequest) => {
    calls.push(translationRequest);
    return respond(translationRequest);
  };
  return { calls, translator };
}

async function storedTip(tipId: string) {
  return getWorksiteTip(tipId, INSPECTOR);
}

beforeEach(() => {
  vi.stubEnv("APP_DATA_MODE", "mock");
  vi.stubEnv("WORKSITE_TIP_DATA_MODE", "mock");
  resetMockWorksiteTipsForTests();
});

afterEach(() => {
  resetMockWorksiteTipsForTests();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("현장 제보 번역", () => {
  it("외국어 화면의 제보를 한국어로 옮겨 원문과 함께 저장한다", async () => {
    const { calls, translator } = recordingTranslator(async ({ text }) => ({
      ok: true,
      text: text.startsWith("Unpaid") ? "3개월 임금 미지급" : "사장이 9월부터 월급을 주지 않았습니다.",
    }));
    const receipt = await createWorksiteTip(
      request("Unpaid wages for 3 months", "My boss has not paid my salary since September.", "en"),
      USER,
      { translator },
    );

    expect(calls).toEqual([
      { text: "Unpaid wages for 3 months", from: "en", to: "ko", purpose: "worksite_tip" },
      { text: "My boss has not paid my salary since September.", from: "en", to: "ko", purpose: "worksite_tip" },
    ]);
    // 제보자 영수증에는 번역본을 싣지 않는다.
    expect(JSON.stringify(receipt)).not.toContain("미지급");
    expect(receipt.title).toBe("Unpaid wages for 3 months");

    const tip = await storedTip(receipt.tip_id);
    expect(tip).toMatchObject({
      title: "Unpaid wages for 3 months",
      body: "My boss has not paid my salary since September.",
      source_language: "en",
      translation_status: "translated",
      title_ko: "3개월 임금 미지급",
      body_ko: "사장이 9월부터 월급을 주지 않았습니다.",
    });
    const list = await listWorksiteTips({}, INSPECTOR);
    expect(list.items[0]).toMatchObject({
      translation_status: "translated",
      title_ko: "3개월 임금 미지급",
      body_preview_ko: "사장이 9월부터 월급을 주지 않았습니다.",
    });
  });

  it("글자 체계로 언어를 정한다 — 한국어 화면이어도 분명한 외국어 글은 번역한다", async () => {
    const { calls, translator } = recordingTranslator(async () => ({ ok: true, text: "번역문" }));
    const receipt = await createWorksiteTip(
      request("ไม่ได้รับค่าจ้าง", "นายจ้างไม่จ่ายค่าจ้างมาสองเดือนแล้ว"),
      USER,
      { translator },
    );

    expect(calls.map((call) => call.from)).toEqual(["th", "th"]);
    expect(await storedTip(receipt.tip_id)).toMatchObject({ source_language: "th", translation_status: "translated" });
  });

  it("번역이 실패하면 원문만 저장하고 접수는 성공한다", async () => {
    const { translator } = recordingTranslator(async () => ({ ok: false, reason: "provider_error" }));
    const receipt = await createWorksiteTip(
      request("Lương bị nợ", "Công ty chưa trả lương cho tôi hai tháng.", "vi"),
      USER,
      { translator },
    );

    expect(receipt.status).toBe("received");
    expect(await storedTip(receipt.tip_id)).toMatchObject({
      title: "Lương bị nợ",
      body: "Công ty chưa trả lương cho tôi hai tháng.",
      source_language: "vi",
      translation_status: "failed",
      title_ko: null,
      body_ko: null,
    });
  });

  it("제목만 번역되고 본문이 실패하면 반쪽 번역을 남기지 않는다", async () => {
    const { translator } = recordingTranslator(async ({ text }) => (
      text === "工资被拖欠" ? { ok: true, text: "임금 체불" } : { ok: false, reason: "preservation_failed" }
    ));
    const receipt = await createWorksiteTip(request("工资被拖欠", "老板两个月没有发工资。", "zh"), USER, { translator });

    expect(await storedTip(receipt.tip_id)).toMatchObject({
      source_language: "zh",
      translation_status: "failed",
      title_ko: null,
      body_ko: null,
    });
  });

  it("번역기가 예외를 던지거나 시간 안에 답하지 않아도 접수를 막지 않는다", async () => {
    const throwing: Translator = async () => {
      throw new Error("network down");
    };
    const thrown = await createWorksiteTip(request("Unpaid overtime", "No overtime pay at all.", "en"), USER, {
      translator: throwing,
    });
    expect((await storedTip(thrown.tip_id)).translation_status).toBe("failed");

    const hanging: Translator = () => new Promise(() => undefined);
    const started = Date.now();
    const slow = await createWorksiteTip(request("Unpaid overtime", "No overtime pay at all.", "en"), USER, {
      translator: hanging,
      translationTimeoutMs: 20,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await storedTip(slow.tip_id)).toMatchObject({ translation_status: "failed", source_language: "en" });
  });

  it("한국어 제보는 번역기를 부르지 않고 그대로 둔다", async () => {
    const { calls, translator } = recordingTranslator(async () => ({ ok: true, text: "쓰면 안 됨" }));
    // 외국어 화면이어도 한국어로 쓴 제보는 번역하지 않는다.
    const receipt = await createWorksiteTip(
      request("안전모 미지급", "현장에서 안전모를 주지 않습니다.", "vi"),
      USER,
      { translator },
    );

    expect(calls).toEqual([]);
    expect(await storedTip(receipt.tip_id)).toMatchObject({
      title: "안전모 미지급",
      source_language: null,
      translation_status: "not_needed",
      title_ko: null,
      body_ko: null,
    });
  });

  it("번역 경로가 없는 언어는 모델에 보내지 않고 실패로 남긴다", async () => {
    const { calls, translator } = recordingTranslator(async () => ({ ok: true, text: "번역문" }));
    const receipt = await createWorksiteTip(
      request("Невыплата зарплаты", "Работодатель не платит зарплату два месяца."),
      USER,
      { translator },
    );

    expect(calls).toEqual([]);
    expect(await storedTip(receipt.tip_id)).toMatchObject({ source_language: "ru", translation_status: "failed" });
  });
});
