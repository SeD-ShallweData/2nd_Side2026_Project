import { describe, expect, it } from "vitest";
import {
  detectMultilingualEmergency,
  emergencyAnswerLocale,
  multilingualEmergencyAnswer,
} from "@/domain/multilingualEmergency";

// 외국인 산재 사망 유형(추락·깔림·매몰·끼임)과 출혈·의식 저하·호흡·감전·화상을 언어별로 준비했다.
const MUST_DETECT: Record<string, string[]> = {
  en: [
    "My coworker fell from the scaffold and is not moving",
    "he fell off a ladder at work",
    "a worker is trapped under steel pipes",
    "his hand got caught in the machine",
    "there is heavy bleeding from his leg",
    "she passed out in the factory",
    "he is not breathing",
    "I think I have a broken arm",
    "someone got an electric shock",
    "the warehouse is on fire",
    "my friend was seriously injured at the site",
  ],
  zh: [
    "我同事从脚手架上掉下来了",
    "工友摔下来了,一动不动",
    "他被钢管压住了",
    "有人被埋在土里",
    "手被机器夹住了",
    "流血不止怎么办",
    "他昏迷了",
    "工人没有呼吸了",
    "好像骨折了",
    "有人触电了",
    "我被烫伤了",
  ],
  vi: [
    "Đồng nghiệp tôi ngã từ trên cao xuống",
    "anh ay roi tu tren cao xuong",
    "Tôi bị đè dưới thanh sắt",
    "tay bi ket vao may",
    "chảy máu nhiều quá",
    "cô ấy bất tỉnh rồi",
    "anh ấy không thở",
    "hình như bị gãy xương",
    "có người bị điện giật",
    "bi thuong nang o cong truong",
  ],
  th: [
    "เพื่อนร่วมงานตกจากที่สูง",
    "คนงานถูกทับ",
    "มือติดเครื่องจักร",
    "เลือดออกไม่หยุด",
    "เขาหมดสติ",
    "เขาไม่หายใจ",
    "กระดูกหัก",
    "โดนไฟดูด",
    "โรงงานไฟไหม้",
  ],
  uz: ["ishchi balanddan yiqildi", "u hushidan ketdi"],
  ru: ["рабочий упал с лесов", "его придавило плитой", "он без сознания"],
  ne: ["साथी अग्लो ठाउँबाट खस्यो", "उहाँ बेहोस हुनुभयो"],
  id: ["teman saya jatuh dari atap", "tangannya terjepit mesin", "dia pingsan"],
  km: ["កម្មករធ្លាក់ពីលើ", "គាត់សន្លប់"],
};

const MUST_NOT_DETECT = [
  "How do I get my unpaid overtime pay?",
  "I was fired last month without notice",
  "Is fall a busy season for construction?",
  "我的工资被拖欠了三个月",
  "Công ty chưa trả lương tháng này",
  "นายจ้างไม่จ่ายค่าล่วงเวลา",
  "월급이 두 달째 밀렸어요",
  "Can I change my workplace under the employment permit system?",
];

describe("외국어 긴급 상황 감지", () => {
  for (const [language, messages] of Object.entries(MUST_DETECT)) {
    it(`${language}: 추락·깔림·끼임·출혈·의식 저하를 놓치지 않는다`, () => {
      for (const message of messages) {
        expect(detectMultilingualEmergency(message), message).not.toBeNull();
      }
    });
  }

  it("일반 임금·계약 질문은 긴급으로 보지 않는다", () => {
    for (const message of MUST_NOT_DETECT) {
      expect(detectMultilingualEmergency(message), message).toBeNull();
    }
  });

  it("화면 언어 → 감지 언어 → 영어 순서로 답 언어를 고른다", () => {
    const thai = detectMultilingualEmergency("เขาหมดสติ")!;
    expect(emergencyAnswerLocale(thai)).toBe("th");
    expect(emergencyAnswerLocale(thai, "vi")).toBe("vi");
    expect(emergencyAnswerLocale(thai, "ko")).toBe("th");
    const russian = detectMultilingualEmergency("он без сознания")!;
    expect(emergencyAnswerLocale(russian)).toBe("en");
  });

  it("모든 답에 119와 한국어 한 줄이 들어간다", () => {
    for (const locale of ["en", "zh", "vi", "th"] as const) {
      const answer = multilingualEmergencyAnswer(locale);
      expect(answer).toContain("119");
      expect(answer).toContain("(한국어)");
    }
  });
});
