import { describe, expect, it } from "vitest";
import {
  detectMultilingualEmergency,
  emergencyAnswerLocale,
  multilingualEmergencyAnswer,
} from "@/domain/multilingualEmergency";

// 외국인 산재 사망 유형(추락·깔림·매몰·끼임)과 출혈·의식 저하·호흡·골절·감전·화상·화재,
// 농·어업과 건설·제조업에서 많은 중독·질식·익사·전복을 언어별로 준비했다.
// 구현 언어는 30문장 이상, 지원 예정 언어는 5문장 이상이 목표다.
const MUST_DETECT: Record<string, string[]> = {
  en: [
    // 추락
    "My coworker fell from the scaffold and is not moving",
    "he fell off a ladder at work",
    "a worker fell from the roof of the greenhouse",
    // 깔림·매몰
    "a worker is trapped under steel pipes",
    "he got crushed by a falling beam",
    "two men are buried after the trench collapsed",
    // 끼임
    "his hand got caught in the machine",
    "her sleeve was pulled into the conveyor belt",
    // 출혈
    "there is heavy bleeding from his leg",
    "his arm is bleeding a lot and won't stop",
    // 의식 저하
    "she passed out in the factory",
    "he is unconscious on the floor",
    // 호흡
    "he is not breathing",
    "my friend can't breathe",
    // 골절
    "I think I have a broken arm",
    "the doctor might say it's a fracture, he can't stand",
    // 감전
    "someone got an electric shock",
    "a welder was electrocuted",
    // 화상·화재
    "he was badly burned by hot oil",
    "the warehouse is on fire",
    "my friend was seriously injured at the site",
    // 중독
    "my coworker drank pesticide by mistake",
    "we inhaled chemical fumes and feel dizzy",
    "there is a gas leak in the dormitory",
    "I think he was poisoned by the spray on the farm",
    // 질식
    "a worker suffocated inside the tank",
    "he went into the manhole and collapsed",
    // 익사
    "my friend fell overboard from the fishing boat",
    "someone is drowning in the fish farm",
    "he fell into the reservoir",
    // 전복
    "the tractor overturned on the slope",
    "the forklift tipped over on him",
    "our boat capsized near the port",
  ],
  zh: [
    // 추락
    "我同事从脚手架上掉下来了",
    "工友摔下来了,一动不动",
    "有人从高处坠落",
    // 깔림·매몰
    "他被钢管压住了",
    "有人被埋在土里",
    "墙倒了,工人压在下面",
    // 끼임
    "手被机器夹住了",
    "衣服卷进了传送带",
    // 출혈
    "流血不止怎么办",
    "他出了很多血",
    // 의식 저하
    "他昏迷了",
    "同事晕倒了叫不醒",
    // 호흡
    "工人没有呼吸了",
    "他呼吸困难",
    // 골절
    "好像骨折了",
    // 감전
    "有人触电了",
    "他被电击了",
    // 화상·화재
    "我被烫伤了",
    "工厂着火了",
    "他受了重伤",
    // 중독
    "同事喝了农药",
    "打农药的时候中毒了",
    "车间里煤气泄漏了",
    "吸入了化学气体",
    // 질식
    "工人在化粪池里窒息了",
    "下水道里的人晕倒了",
    // 익사
    "有人溺水了",
    "我朋友掉进水库里了",
    "船员落水了",
    // 전복
    "拖拉机翻了,人压在下面",
    "叉车侧翻了",
    "渔船翻船了",
  ],
  vi: [
    // 추락
    "Đồng nghiệp tôi ngã từ trên cao xuống",
    "anh ay roi tu tren cao xuong",
    "Anh ấy ngã giàn giáo",
    // 깔림·매몰
    "Tôi bị đè dưới thanh sắt",
    "cong nhan bi vui lap duoi dat",
    // 끼임
    "tay bi ket vao may",
    "Tay anh ấy bị máy cuốn vào",
    // 출혈
    "chảy máu nhiều quá",
    "anh ay mat nhieu mau",
    // 의식 저하
    "cô ấy bất tỉnh rồi",
    "anh ấy ngất xỉu ở xưởng",
    // 호흡
    "anh ấy không thở",
    "ban toi kho tho lam",
    // 골절
    "hình như bị gãy xương",
    "anh ấy bị gãy chân",
    // 감전
    "có người bị điện giật",
    // 화상·화재
    "Anh ấy bị bỏng nặng",
    "bi thuong nang o cong truong",
    // 중독
    "Bạn tôi bị ngộ độc thuốc trừ sâu",
    "anh ay uong nham thuoc tru sau",
    "Tôi hít phải hóa chất và thấy chóng mặt",
    "Có rò rỉ khí ga trong ký túc xá",
    // 질식
    "Công nhân bị ngạt khí trong bể",
    "cong nhan bi ngat tho trong ham",
    // 익사
    "Có người bị đuối nước ở ao cá",
    "ban toi chet duoi roi",
    "Anh ấy rơi xuống biển từ tàu cá",
    // 전복
    "Máy cày bị lật, anh ấy bị đè",
    "lat may cay tren doc",
    "Thuyền bị lật nhào ngoài biển",
    "xe nang bi lat",
  ],
  th: [
    // 추락
    "เพื่อนร่วมงานตกจากที่สูง",
    "คนงานพลัดตกนั่งร้าน",
    "เขาตกจากหลังคา",
    // 깔림·매몰
    "คนงานถูกทับ",
    "ดินถล่มทับคนงาน",
    // 끼임
    "มือติดเครื่องจักร",
    "แขนถูกหนีบในเครื่อง",
    // 출혈
    "เลือดออกไม่หยุด",
    "เขาเสียเลือดมาก",
    // 의식 저하
    "เขาหมดสติ",
    "เพื่อนเป็นลมในโรงงาน",
    // 호흡
    "เขาไม่หายใจ",
    "เขาหายใจไม่ออก",
    // 골절
    "กระดูกหัก",
    "ขาของเขากระดูกหัก",
    // 감전
    "โดนไฟดูด",
    "เพื่อนโดนไฟฟ้าช็อต",
    // 화상·화재
    "โรงงานไฟไหม้",
    "เขาโดนน้ำร้อนลวก",
    "เขาบาดเจ็บสาหัส",
    // 중독
    "เพื่อนดื่มยาฆ่าหญ้า",
    "คนงานได้รับพิษจากยาฆ่าแมลง",
    "แก๊สรั่วในหอพัก",
    "สูดสารเคมีแล้ววิงเวียน",
    // 질식
    "คนงานขาดอากาศหายใจในถัง",
    "เขาสำลักควัน",
    // 익사
    "เพื่อนจมน้ำ",
    "ลูกเรือตกทะเล",
    "คนงานตกบ่อปลา",
    // 전복
    "รถไถพลิกคว่ำ",
    "เรือประมงล่ม",
    "รถยกคว่ำทับคนงาน",
  ],
  uz: [
    "ishchi balanddan yiqildi",
    "u hushidan ketdi",
    "do'stim pestitsiddan zaharlandi",
    "u gazdan bo'g'ilib qoldi",
    "ishchi suvga cho'kib ketdi",
    "traktor ag'darildi",
  ],
  ru: [
    "рабочий упал с лесов",
    "его придавило плитой",
    "он без сознания",
    "он отравился пестицидом",
    "рабочий задохнулся в колодце",
    "мой друг утонул в пруду",
    "трактор перевернулся на склоне",
  ],
  ne: [
    "साथी अग्लो ठाउँबाट खस्यो",
    "उहाँ बेहोस हुनुभयो",
    "साथीले कीटनाशक पियो",
    "उहाँ ग्यासले निसासिनुभयो",
    "साथी पोखरीमा डुब्यो",
    "ट्र्याक्टर पल्टियो",
  ],
  id: [
    "teman saya jatuh dari atap",
    "tangannya terjepit mesin",
    "dia pingsan",
    "dia keracunan pestisida",
    "pekerja tercekik gas di dalam tangki",
    "teman saya tenggelam di laut",
    "traktornya terbalik",
    "kapal kami karam",
  ],
  km: [
    "កម្មករធ្លាក់ពីលើ",
    "គាត់សន្លប់",
    "គាត់ពុលថ្នាំកសិកម្ម",
    "គាត់ថប់ដង្ហើម",
    "មិត្តខ្ញុំលង់ទឹក",
    "ត្រាក់ទ័រក្រឡាប់",
  ],
};

// 긴급이 아닌 질문. 새 네 유형의 비유·동음이의 표현을 함께 둔다.
const MUST_NOT_DETECT = [
  "How do I get my unpaid overtime pay?",
  "I was fired last month without notice",
  "Is fall a busy season for construction?",
  "Can I change my workplace under the employment permit system?",
  "Can I appeal to overturn the decision to dismiss me?",
  "The court overturned my employer's appeal",
  "I'm drowning in debt because my wages are late",
  "I'm addicted to games and can't sleep",
  "My boss is a workaholic and makes us stay late",
  "Our dormitory has no air conditioning",
  "The truck driver flipped out at me",
  "My contract says the company pays for gas and electricity",
  "我的工资被拖欠了三个月",
  "我玩游戏上瘾了",
  "老板的决定被推翻了",
  "他是个工作狂",
  "Công ty chưa trả lương tháng này",
  "Tôi bị đuổi việc mà không được báo trước",
  "toi bi duoi viec roi ho khong tra luong",
  "Khi đọc hợp đồng tôi không hiểu điều khoản này",
  "Tôi nghiện game",
  "Anh ấy trúng độc đắc",
  "นายจ้างไม่จ่ายค่าล่วงเวลา",
  "ฉันติดเกม",
  "ระบบของบริษัทล่ม จ่ายเงินเดือนไม่ได้",
  "ฉันตกงานเมื่อเดือนที่แล้ว",
  "월급이 두 달째 밀렸어요",
];

describe("외국어 긴급 상황 감지", () => {
  for (const [language, messages] of Object.entries(MUST_DETECT)) {
    it(`${language}: 추락·깔림·끼임·출혈·의식 저하·중독·질식·익사·전복을 놓치지 않는다`, () => {
      for (const message of messages) {
        expect(detectMultilingualEmergency(message), message).not.toBeNull();
      }
    });
  }

  it("구현 언어는 30문장, 지원 예정 언어는 5문장 이상으로 평가한다", () => {
    for (const language of ["en", "zh", "vi", "th"]) {
      expect(MUST_DETECT[language].length, language).toBeGreaterThanOrEqual(30);
    }
    for (const language of ["uz", "ru", "ne", "id", "km"]) {
      expect(MUST_DETECT[language].length, language).toBeGreaterThanOrEqual(5);
    }
  });

  it("일반 임금·계약 질문과 비유 표현은 긴급으로 보지 않는다", () => {
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
