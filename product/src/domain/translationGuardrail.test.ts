import { describe, expect, it } from "vitest";

import { checkTranslationPreservation } from "@/domain/translationGuardrail";

const KOREAN_ANSWER = [
  "급여일이 지났는데 임금을 받지 못했다면 「근로기준법」 제43조의 임금 지급 원칙을 확인해 보세요.",
  "지급일, 입금 내역, 근로계약서를 정리해 고용노동부 1350에 문의할 수 있습니다.",
  "미지급 금액이 150만 원이라면 그 금액과 3개월 치 근무 기록을 함께 남겨 두세요.",
  "위법 여부는 이 답변만으로 단정하지 않습니다.",
].join("\n");

const PASSING: Record<"en" | "zh" | "vi" | "th", string> = {
  en: [
    "If your payday has passed and you have not been paid, check the wage payment principle in 「근로기준법」 제43조 (Labor Standards Act, Article 43).",
    "Organize the payment date, deposit records and employment contract, and you can contact 고용노동부 (Ministry of Employment and Labor) at 1350.",
    "If the unpaid amount is 150만 원 (KRW 1,500,000), keep that amount together with 3 months of work records.",
    "This answer alone does not determine whether it is unlawful.",
  ].join("\n"),
  zh: [
    "如果发薪日已过仍未领到工资,请确认「근로기준법」 제43조(劳动基准法第43条)的工资支付原则。",
    "整理支付日期、入账记录和劳动合同后,可以拨打 고용노동부(雇佣劳动部)1350 咨询。",
    "如果未支付金额为 150万韩元(1,500,000 韩元),请同时保留该金额和 3 个月的工作记录。",
    "仅凭本回答不能断定是否违法。",
  ].join("\n"),
  vi: [
    "Nếu đã qua ngày trả lương mà bạn chưa nhận được lương, hãy xem nguyên tắc trả lương tại 근로기준법 제43조 (Luật Tiêu chuẩn Lao động, Điều 43).",
    "Hãy sắp xếp ngày trả lương, lịch sử chuyển khoản và hợp đồng lao động, rồi liên hệ 고용노동부 (Bộ Việc làm và Lao động) qua số 1350.",
    "Nếu số tiền chưa trả là 1.500.000 won, hãy lưu lại số tiền đó cùng hồ sơ làm việc 3 tháng.",
    "Chỉ dựa vào câu trả lời này thì không thể kết luận có vi phạm pháp luật hay không.",
  ].join("\n"),
  th: [
    "หากเลยวันจ่ายเงินเดือนแล้วแต่ยังไม่ได้รับค่าจ้าง ให้ตรวจสอบหลักการจ่ายค่าจ้างใน 「근로기준법」 제43조 (พระราชบัญญัติมาตรฐานแรงงาน มาตรา 43)",
    "จัดเตรียมวันจ่ายเงิน ประวัติการโอนเงิน และสัญญาจ้าง แล้วติดต่อ 고용노동부 (กระทรวงการจ้างงานและแรงงาน) ที่หมายเลข 1350",
    "หากค่าจ้างค้างจ่ายคือ 150만 원 (1,500,000 วอน) ให้เก็บจำนวนเงินนั้นพร้อมบันทึกการทำงาน 3 เดือน",
    "คำตอบนี้เพียงอย่างเดียวไม่ได้ตัดสินว่าผิดกฎหมายหรือไม่",
  ].join("\n"),
};

function check(translation: string, to: "en" | "zh" | "vi" | "th", source = KOREAN_ANSWER) {
  return checkTranslationPreservation({ source, translation, from: "ko", to });
}

describe("번역 보존 검사 — 통과", () => {
  it.each(Object.entries(PASSING) as Array<["en" | "zh" | "vi" | "th", string]>)(
    "%s: 숫자·금액·조문·기관명을 보존하고 새 판정이 없으면 통과한다",
    (locale, translation) => {
      const result = check(translation, locale);
      expect(result.failures, result.details.join(", ")).toEqual([]);
      expect(result.ok).toBe(true);
    },
  );

  it("영어 날짜의 달 이름은 숫자로 맞춰 본다", () => {
    const result = check("Your payday is March 10, 2026. Call 1350.", "en", "급여일은 2026년 3월 10일입니다. 1350에 문의하세요.");
    expect(result.ok).toBe(true);
  });

  it("태국어 달 이름과 태국 숫자도 맞춰 본다", () => {
    const result = check("วันจ่ายเงินเดือนคือ ๑๐ มีนาคม 2026 โทร 1350", "th", "급여일은 2026년 3월 10일입니다. 1350에 문의하세요.");
    expect(result.ok).toBe(true);
  });

  it("목록 번호가 바뀌는 것은 숫자 변경으로 보지 않는다", () => {
    const result = check("1. Keep the contract.\n2. Keep the pay slips.", "en", "- 계약서를 보관하세요.\n- 급여명세서를 보관하세요.");
    expect(result.ok).toBe(true);
  });

  it("원문에 글자로 적힌 수를 숫자로 적는 것은 허용한다", () => {
    const result = check("Keep records for two weeks.", "en", "두 주 동안 기록을 남겨 두세요.");
    expect(result.ok).toBe(true);
  });
});

describe("번역 보존 검사 — 실패", () => {
  it.each([
    ["en", "전화번호 1350을 1330으로 바꿈", PASSING.en.replace("1350", "1330"), "NUMBER_MISSING"],
    ["zh", "3개월을 한자 수로 풀어 씀", PASSING.zh.replace("3 个月", "三个月"), "NUMBER_MISSING"],
    ["vi", "3개월을 6개월로 바꿈", PASSING.vi.replace(" 3 tháng", " 6 tháng"), "NUMBER_ADDED"],
    ["th", "조문을 태국어로만 적음", PASSING.th.replace("「근로기준법」 제43조", "พระราชบัญญัติมาตรฐานแรงงาน"), "CITATION_MISSING"],
    ["en", "기관명을 영어로만 적음", PASSING.en.replace("고용노동부 (Ministry of Employment and Labor)", "the Ministry of Employment and Labor"), "ORGANIZATION_MISSING"],
    ["zh", "원화 표기를 뺌", PASSING.zh.replace("150万韩元(1,500,000 韩元)", "1,500,000"), "CURRENCY_MISSING"],
  ] as const)("%s: %s → %s", (locale, _label, translation, failure) => {
    const result = check(translation, locale);
    expect(result.ok).toBe(false);
    expect(result.failures).toContain(failure);
  });

  it.each([
    ["en", "The company did not pay your wages. This is illegal.", "legal"],
    ["en", "This workplace is safe for you.", "safety"],
    ["zh", "公司没有支付工资,这是违法的。", "legal"],
    ["vi", "Công ty không trả lương, đây là hành vi bất hợp pháp.", "legal"],
    ["th", "บริษัทไม่จ่ายค่าจ้าง ซึ่งผิดกฎหมาย", "legal"],
    ["en", "You will definitely get the money back.", "certainty"],
  ] as const)("%s: 한국어 답변에 없던 판정을 더하면 실패한다 (%s)", (locale, translation, category) => {
    const result = check(translation, locale, "회사가 임금을 지급하지 않았습니다.");
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("VERDICT_ADDED");
    expect(result.details).toContain(`verdict_added:${category}`);
  });

  it("전화번호 형식이 바뀌면 실패한다", () => {
    const result = check("Call 02 1234 5678.", "en", "02-1234-5678로 문의하세요.");
    expect(result.failures).toContain("PHONE_MISSING");
  });

  it("번역하지 않고 한국어를 그대로 돌려주면 실패한다", () => {
    const result = check(KOREAN_ANSWER, "en");
    expect(result.failures).toContain("UNTRANSLATED");
  });

  it("빈 번역과 지나치게 짧은 번역을 거른다", () => {
    expect(check("  ", "en").failures).toEqual(["EMPTY"]);
    expect(check("OK.", "en").failures).toContain("LENGTH_OUT_OF_RANGE");
  });
});

describe("번역 보존 검사 — 입구(외국어 → 한국어)", () => {
  it("질문의 숫자와 금액이 한국어로 보존되면 통과한다", () => {
    const result = checkTranslationPreservation({
      source: "I was not paid 1,500,000 won for March. Can I call 1350?",
      translation: "3월분 1,500,000원을 받지 못했습니다. 1350에 전화해도 되나요?",
      from: "en", to: "ko",
    });
    expect(result.failures, result.details.join(", ")).toEqual([]);
  });

  it("만 단위로 바꿔 쓴 금액도 같은 값으로 본다", () => {
    const result = checkTranslationPreservation({
      source: "Tôi chưa được trả 1.500.000 won.",
      translation: "150만 원을 받지 못했습니다.",
      from: "vi", to: "ko",
    });
    expect(result.ok).toBe(true);
  });

  it("질문에 없던 숫자를 더하거나 한국어가 아니면 실패한다", () => {
    expect(checkTranslationPreservation({
      source: "我的工资没有发。", translation: "월급 300만 원을 받지 못했습니다.", from: "zh", to: "ko",
    }).failures).toContain("NUMBER_ADDED");
    expect(checkTranslationPreservation({
      source: "ไม่ได้รับค่าจ้าง", translation: "I did not get paid", from: "th", to: "ko",
    }).failures).toContain("UNTRANSLATED");
  });

  it("질문에 없던 판정을 더하면 실패한다", () => {
    const result = checkTranslationPreservation({
      source: "My boss did not pay me.", translation: "사장이 임금을 주지 않았습니다. 이것은 불법입니다.", from: "en", to: "ko",
    });
    expect(result.failures).toContain("VERDICT_ADDED");
  });
});
