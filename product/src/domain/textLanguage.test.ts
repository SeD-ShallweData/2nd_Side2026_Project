import { describe, expect, it } from "vitest";

import { countScripts, detectPostLanguage, detectTextLanguage, isTextLanguage, languageFromCounts } from "@/domain/textLanguage";
import { TEXT_LANGUAGE_SAMPLES } from "@/domain/textLanguage.samples";

describe("작성 언어 추정", () => {
  it.each(TEXT_LANGUAGE_SAMPLES)("$expected: $title", ({ title, body, expected }) => {
    expect(detectPostLanguage(title, body)).toBe(expected);
  });

  it("한글이 30% 이상이면 영문이 섞여도 한국어다", () => {
    expect(languageFromCounts({ hangul: 3, thai: 0, han: 0, kana: 0, latin: 7, vietnamese: 0 })).toBe("ko");
    expect(languageFromCounts({ hangul: 2, thai: 0, han: 0, kana: 0, latin: 8, vietnamese: 0 })).toBe("en");
  });

  it("같은 개수면 태국 문자 → 한자 → 가나 → 라틴 순으로 정한다", () => {
    expect(languageFromCounts({ hangul: 0, thai: 4, han: 4, kana: 0, latin: 4, vietnamese: 0 })).toBe("th");
    expect(languageFromCounts({ hangul: 0, thai: 0, han: 4, kana: 4, latin: 4, vietnamese: 0 })).toBe("zh");
    expect(languageFromCounts({ hangul: 0, thai: 0, han: 0, kana: 4, latin: 4, vietnamese: 4 })).toBe("other");
  });

  it("베트남어 전용 글자가 라틴 글자의 5% 이상일 때만 베트남어다", () => {
    expect(languageFromCounts({ hangul: 0, thai: 0, han: 0, kana: 0, latin: 40, vietnamese: 2 })).toBe("vi");
    expect(languageFromCounts({ hangul: 0, thai: 0, han: 0, kana: 0, latin: 41, vietnamese: 2 })).toBe("en");
  });

  it("글자를 코드 포인트 단위로 센다", () => {
    expect(countScripts("가a ă ỹ ไ 中 か")).toEqual({ hangul: 1, thai: 1, han: 1, kana: 1, latin: 3, vietnamese: 2 });
    expect(detectTextLanguage("")).toBe("other");
  });

  it("허용 값만 언어로 받는다", () => {
    expect(isTextLanguage("vi")).toBe(true);
    expect(isTextLanguage("ja")).toBe(false);
    expect(isTextLanguage(undefined)).toBe(false);
  });
});
