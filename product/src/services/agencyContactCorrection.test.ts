import { describe, expect, it } from "vitest";

import { COMWEL_CONTACT_NUMBER, correctAgencyContacts } from "@/services/agencyContactCorrection";

describe("기관 연락처 교정", () => {
  it("근로복지공단을 1350·노동포털과 묶은 문장을 고친다 (09-30 운영 사례)", () => {
    const answer = "확인 채널\n\n근로복지공단 콜센터(1350) 또는 근로복지공단 홈페이지(노동포털)에서 구체적인 지급액과 신청 절차를 확인할 수 있습니다.";
    const corrected = correctAgencyContacts(answer);
    expect(corrected).toContain(`근로복지공단 콜센터(${COMWEL_CONTACT_NUMBER})`);
    expect(corrected).not.toContain("1350");
    expect(corrected).not.toContain("노동포털");
    expect(corrected.startsWith("확인 채널\n\n")).toBe(true);
  });

  it("고용노동부 1350 과 근로복지공단을 올바르게 나눠 쓴 문장은 그대로 둔다", () => {
    const answer = "절차 상담은 고용노동부 1350에서 받고, 산재 신청은 근로복지공단에 합니다.";
    expect(correctAgencyContacts(answer)).toBe(answer);
  });

  it("다른 문장의 1350 은 건드리지 않는다", () => {
    const answer = "임금 문제는 1350에 문의하세요. 산재 급여는 근로복지공단에 신청합니다.";
    expect(correctAgencyContacts(answer)).toBe(answer);
  });

  it("근로복지공단이 없는 답변은 같은 문자열을 돌려준다", () => {
    const answer = "1350에 문의하세요.";
    expect(correctAgencyContacts(answer)).toBe(answer);
  });

  it("13500 같은 다른 숫자는 바꾸지 않는다", () => {
    const answer = "근로복지공단 기준 금액 13500원을 확인하세요.";
    expect(correctAgencyContacts(answer)).toBe(answer);
  });
});
