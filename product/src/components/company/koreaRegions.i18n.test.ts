import { describe, expect, it } from "vitest";

import { KOREA_REGIONS } from "@/components/company/koreaRegions";
import { companyMessages } from "@/i18n/messages/company";

describe("지역 이름 번역 사전", () => {
  it("지도의 모든 현행 지역명이 모든 화면 언어 사전에 있다", () => {
    let checked = 0;
    for (const [locale, messages] of Object.entries(companyMessages)) {
      const regions = (messages as { regions?: Record<string, { name: string; short: string }> }).regions;
      if (!regions) continue; // 쉬운 한국어처럼 덮어쓰지 않는 언어
      checked += 1;
      for (const region of KOREA_REGIONS) {
        expect(regions[region.name], `${locale}: ${region.name}`).toBeDefined();
      }
    }
    expect(checked).toBeGreaterThanOrEqual(5);
  });
});
