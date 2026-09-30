import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { LocaleSuggestion, LocaleSuggestionBanner } from "@/components/common/LocaleSuggestion";
import { browserLanguages, hasLocaleCookie, suggestLocale } from "@/i18n/localeSuggestion";

describe("처음 온 사용자에게 화면 언어 제안", () => {
  it("구현한 외국어는 그 언어를 제안한다(지역 표기는 무시)", () => {
    expect(suggestLocale(["vi-VN", "en-US"])).toBe("vi");
    expect(suggestLocale(["th"])).toBe("th");
    expect(suggestLocale(["zh-CN", "zh"])).toBe("zh");
    expect(suggestLocale(["zh_TW"])).toBe("zh");
    expect(suggestLocale(["EN-gb"])).toBe("en");
  });

  it("한국어가 먼저 나오면 제안하지 않는다", () => {
    expect(suggestLocale(["ko-KR", "en-US"])).toBeNull();
    expect(suggestLocale(["ko"])).toBeNull();
    expect(suggestLocale(["ja", "ko", "en"])).toBeNull();
  });

  it("앞선 언어를 먼저 본다", () => {
    expect(suggestLocale(["en-US", "ko-KR"])).toBe("en");
    expect(suggestLocale(["fr", "vi"])).toBe("vi");
  });

  it("지원 예정 언어와 그 밖의 언어에는 영어를 제안한다", () => {
    expect(suggestLocale(["uz-UZ"])).toBe("en");
    expect(suggestLocale(["ne", "vi"])).toBe("en");
    expect(suggestLocale(["km"])).toBe("en");
    expect(suggestLocale(["ja-JP"])).toBe("en");
  });

  it("언어 정보가 없으면 제안하지 않는다", () => {
    expect(suggestLocale([])).toBeNull();
    expect(suggestLocale(["", " "])).toBeNull();
  });

  it("언어 쿠키가 있으면 이미 고른 것으로 본다", () => {
    expect(hasLocaleCookie("donworry_session=abc; donworry_locale=ko")).toBe(true);
    expect(hasLocaleCookie("donworry_locale=")).toBe(true);
    expect(hasLocaleCookie("donworry_session=abc; x_donworry_locale=en")).toBe(false);
    expect(hasLocaleCookie("")).toBe(false);
  });

  it("navigator.languages 가 없으면 navigator.language 를 쓴다", () => {
    expect(browserLanguages({ language: "th-TH", languages: [] })).toEqual(["th-TH"]);
    expect(browserLanguages({ language: "en", languages: ["vi", "en"] })).toEqual(["vi", "en"]);
    expect(browserLanguages({ language: "" })).toEqual([]);
  });

  it("제안 띠는 제안하는 언어로 쓰고, 서버 렌더링에서는 아무것도 그리지 않는다", () => {
    const html = renderToStaticMarkup(<LocaleSuggestionBanner suggested="vi" onAccept={() => undefined} onDismiss={() => undefined} />);
    expect(html).toContain('lang="vi"');
    expect(html).toContain("Chuyển sang tiếng Việt");
    expect(html).toContain("Tiếp tục dùng tiếng Hàn");
    expect(renderToStaticMarkup(<LocaleSuggestionBanner suggested="zh" onAccept={() => undefined} onDismiss={() => undefined} />))
      .toContain('lang="zh-Hans"');
    expect(renderToStaticMarkup(<LocaleSuggestion />)).toBe("");
  });
});
