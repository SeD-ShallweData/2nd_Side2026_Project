import { describe, expect, it } from "vitest";

import { detectWorksiteTipLanguage, detectWorksiteTipSubmissionLanguage } from "@/domain/worksiteTipLanguage";

describe("현장 제보 언어 추정", () => {
  it("한글이 절반 이상이면 화면 언어와 관계없이 한국어다", () => {
    expect(detectWorksiteTipLanguage("안전모 미지급", "en")).toEqual({ kind: "korean" });
    expect(detectWorksiteTipLanguage("CCTV 설치 안 됨", "ko")).toEqual({ kind: "korean" });
    expect(detectWorksiteTipLanguage("PPE 미지급", "vi")).toEqual({ kind: "korean" });
  });

  it("한국어 화면에서는 짧은 영문·섞인 글을 외국어로 단정하지 않는다", () => {
    expect(detectWorksiteTipLanguage("OK", "ko")).toEqual({ kind: "korean" });
    expect(detectWorksiteTipLanguage("Samsung 협력업체 야간 근무 강요", "ko")).toEqual({ kind: "korean" });
    expect(detectWorksiteTipLanguage("12345", "ko")).toEqual({ kind: "korean" });
  });

  it("글자 체계와 화면 언어로 번역 출발 언어를 정한다", () => {
    expect(detectWorksiteTipLanguage("My boss has not paid me", "ko")).toEqual({ kind: "translate", language: "en" });
    expect(detectWorksiteTipLanguage("Công ty chưa trả lương", "ko")).toEqual({ kind: "translate", language: "vi" });
    expect(detectWorksiteTipLanguage("Cong ty chua tra luong", "vi")).toEqual({ kind: "translate", language: "vi" });
    expect(detectWorksiteTipLanguage("老板两个月没有发工资", "ko")).toEqual({ kind: "translate", language: "zh" });
    expect(detectWorksiteTipLanguage("นายจ้างไม่จ่ายค่าจ้าง", "en")).toEqual({ kind: "translate", language: "th" });
    // 외국어 화면이면 짧은 글도 번역한다.
    expect(detectWorksiteTipLanguage("No pay", "en")).toEqual({ kind: "translate", language: "en" });
  });

  it("번역 경로가 없는 글자 체계는 지원하지 않는 언어로 둔다", () => {
    expect(detectWorksiteTipLanguage("Работодатель не платит", "ko")).toEqual({ kind: "unsupported", language: "ru" });
    expect(detectWorksiteTipLanguage("मालिकले तलब दिएन", "ko")).toEqual({ kind: "unsupported", language: "ne" });
  });

  it("제목과 본문을 함께 본다", () => {
    expect(detectWorksiteTipSubmissionLanguage("임금", "My boss has not paid my salary since September.", "ko"))
      .toEqual({ kind: "translate", language: "en" });
    expect(detectWorksiteTipSubmissionLanguage("임금 체불", null, "en")).toEqual({ kind: "korean" });
  });
});
