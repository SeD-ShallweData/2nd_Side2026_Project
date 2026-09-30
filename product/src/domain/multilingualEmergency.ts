/*
 * 외국어 긴급 상황 감지 (언어 지원 1단계).
 *
 * 기존 긴급 감지(PolicyChatProvider 의 ACUTE_INJURY·EMERGENCY_SIGNS 등)는 한국어 표현만 본다.
 * 외국인 근로자 산재 사망은 추락·깔림·매몰·끼임이 대부분이라(외국인 근로자 피해 통계 조사 2.3절),
 * 모국어로 "떨어졌다", "깔렸다", "기계에 끼었다"고 써도 곧바로 긴급 안내가 나가야 한다.
 *
 * - 모델을 부르지 않는다. 고정 사전과 고정 문구만 쓴다(번역 실패·지연과 무관하게 응답).
 * - 놓치지 않는 쪽으로 넓게 잡는다. 일반 상담이 긴급 안내로 바뀌는 비용보다 놓치는 비용이 크다.
 * - 구현 언어(영어·중국어·베트남어·태국어)는 그 언어로 답한다. 지원 예정 언어(우즈베크어·러시아어·
 *   네팔어·인도네시아어·크메르어)는 감지만 하고 영어로 답한다. 모든 답에 한국어 한 줄을 붙여
 *   옆의 동료나 현장 책임자가 읽을 수 있게 한다.
 */

export type EmergencyAnswerLocale = "en" | "zh" | "vi" | "th";
export type EmergencyDetectedLanguage = EmergencyAnswerLocale | "uz" | "ru" | "ne" | "id" | "km";

export interface MultilingualEmergencyHit {
  language: EmergencyDetectedLanguage;
  pattern: string;
}

/** 베트남어는 성조 표시 없이 쓰는 경우가 많아, 표시를 지운 글자로도 한 번 더 본다. */
function stripVietnameseMarks(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D");
}

const PATTERNS: Record<EmergencyDetectedLanguage, RegExp[]> = {
  en: [
    /\b(?:fell|fall(?:en|ing)?|slipped)\b.{0,30}\b(?:from|off|down)\b/,
    /\bfell\b.{0,20}\b(?:scaffold|ladder|roof|height|floor|stairs)\b/,
    /\b(?:crush(?:ed|ing)?|trapped|pinned|buried)\b/,
    /\b(?:caught|stuck|pulled)\b.{0,15}\b(?:in|into|by)\b.{0,20}\b(?:machine|roller|belt|press|conveyor|gear)\b/,
    /\b(?:heavy|severe|lots? of)\s+bleeding\b|\bbleed(?:ing)?\b.{0,20}\b(?:a lot|heavily|badly|won'?t stop|not stop)/,
    /\b(?:unconscious|passed out|fainted|unresponsive|not responding)\b/,
    /\b(?:not|isn'?t|stopped|can'?t|cannot)\s+breath(?:e|ing)\b/,
    /\b(?:broken|fractured)\s+(?:bone|arm|leg|hand|wrist|ankle|back)\b|\bfracture\b/,
    /\belectr(?:ic|ical)\s+shock\b|\belectrocut/,
    /\b(?:on fire|caught fire|fire broke out|badly burn(?:ed|t)|scald(?:ed)?)\b/,
    /\b(?:seriously|severely|badly)\s+(?:injured|hurt)\b/,
  ],
  zh: [
    /掉下来|摔下来|坠落|跌落|摔倒在地|从.{0,6}(?:上|高处|架子|梯子).{0,4}(?:掉|摔|跌)/,
    /被.{0,6}(?:压|砸)(?:住|伤|倒|在)?|压在.{0,4}下面|被埋|埋住/,
    /卷进|卷入|夹住|夹断|夹伤|被机器/,
    /流血不止|血流不止|大量出血|出了很多血|出很多血/,
    /昏迷|失去意识|没有意识|晕倒|叫不醒|不省人事/,
    /没有呼吸|不能呼吸|喘不过气|呼吸困难/,
    /骨折/,
    /触电|被电(?:到|击)/,
    /烧伤|烫伤|着火|火灾/,
    /受了重伤|重伤|伤得很重/,
  ],
  vi: [
    /nga tu (?:tren )?cao|roi tu (?:tren )?cao|te tu (?:tren )?cao|nga xuong|roi xuong|te xuong|nga giao|nga thang/,
    /bi de|de len nguoi|bi vui|vui lap|sap de/,
    /bi ket (?:vao )?may|ket tay|bi may (?:cuon|kep|nghien)|cuon vao may|kep vao may/,
    /chay mau (?:nhieu|khong ngung|khong cam)|mat nhieu mau|mau chay nhieu/,
    /bat tinh|ngat xiu|ngat di|khong tinh|hon me|khong phan ung/,
    /khong tho|khong the tho|ngung tho|kho tho/,
    /gay xuong|gay tay|gay chan/,
    /dien giat|bi giat dien/,
    /bong nang|bi bong/,
    /bi thuong nang/,
  ],
  th: [
    /ตกจากที่สูง|ตกลงมา|พลัดตก|ตกนั่งร้าน|ตกบันได|ตกจากหลังคา/,
    /ถูกทับ|โดนทับ|ทับตัว|ถูกฝัง|ดินถล่ม/,
    /ติดเครื่อง|ถูกหนีบ|โดนหนีบ|เครื่อง.{0,8}(?:หนีบ|ดูด|บด)|มือติด/,
    /เลือดออกมาก|เลือดไม่หยุด|เลือดออกไม่หยุด|เสียเลือดมาก/,
    /หมดสติ|ไม่รู้สึกตัว|เป็นลม|ไม่ตอบสนอง/,
    /ไม่หายใจ|หายใจไม่ออก/,
    /กระดูกหัก/,
    /ไฟดูด|ไฟช็อต|ไฟฟ้าช็อต|ไฟฟ้าดูด/,
    /ไฟไหม้|ไฟลวก|น้ำร้อนลวก|ถูกไฟ/,
    /บาดเจ็บสาหัส|เจ็บหนัก/,
  ],
  uz: [/yiqil|balanddan|bosib qol|ko'?mil|qon ket|hushidan ket|nafas ol(?:ma|a ol)|tok ur|kuyd|yong'?in/],
  ru: [/упал|упала|сорвал|придавил|завалил|затянул|зажал|кровотечен|кровь не останавлив|без сознания|потерял[аи]? сознание|не дышит|перелом|ударил[оа]? током|ожог|пожар/],
  ne: [/खस्य|लड्य|अग्लो ठाउँ|थिचिय|पुरिय|रगत|बेहोस|सास फेर्न|करेन्ट|आगो|जल्य/],
  id: [/jatuh dari|terjatuh|tertimpa|terjepit|tertimbun|pendarahan|berdarah banyak|pingsan|tidak sadar|tidak bernapas|sesak napas|patah tulang|kesetrum|tersengat listrik|terbakar|kebakaran/],
  km: [/ធ្លាក់|សង្កត់|កប់|ជាប់ម៉ាស៊ីន|ហូរឈាម|សន្លប់|មិនដកដង្ហើម|ឆក់ភ្លើង|រលាក|ភ្លើងឆេះ/],
};

/** 스크립트로 먼저 거른다. 한국어만 쓴 질문은 기존 한국어 감지가 맡는다. */
const SCRIPT_HINTS: Partial<Record<EmergencyDetectedLanguage, RegExp>> = {
  zh: /[一-鿿]/,
  th: /[฀-๿]/,
  ru: /[Ѐ-ӿ]/,
  ne: /[ऀ-ॿ]/,
  km: /[ក-៿]/,
};

export function detectMultilingualEmergency(message: string): MultilingualEmergencyHit | null {
  const text = message.normalize("NFKC").toLocaleLowerCase("en-US");
  const vietnamese = stripVietnameseMarks(text);
  for (const language of Object.keys(PATTERNS) as EmergencyDetectedLanguage[]) {
    const hint = SCRIPT_HINTS[language];
    if (hint && !hint.test(text)) continue;
    const target = language === "vi" ? vietnamese : text;
    for (const pattern of PATTERNS[language]) {
      if (pattern.test(target)) return { language, pattern: pattern.source };
    }
  }
  return null;
}

const KOREAN_LINE = "(한국어) 즉시 위험한 곳에서 벗어나고 119에 신고하세요. 현장 책임자에게 바로 알리세요.";

/** 고정 긴급 문구. 한국어 CHAT_COPY.emergency 와 같은 뜻이며 모델을 거치지 않는다. */
export const MULTILINGUAL_EMERGENCY_ANSWERS: Record<EmergencyAnswerLocale, string> = {
  en: "If someone is hurt or in immediate danger, stop reading and act first. Move yourself and others away from the danger. Call 119 for emergency help and say your location first. Tell the site manager right away. Do not move a person who may have a serious injury unless they are in danger where they are.\n\nAfter everyone is safe, write down when and where it happened and what the injury was, and take photos if you can. You can check the next steps for an industrial accident claim later.",
  zh: "如果有人受伤或正处于危险中,请先停止阅读并立即行动。马上带自己和周围的人离开危险区域。拨打119请求紧急救援,先说出所在位置。立即告诉现场负责人。可能受了重伤的人,除非原地有危险,否则不要随意移动。\n\n确保大家安全后,记下发生的时间、地点和受伤情况,能拍照就拍照。工伤申请等后续步骤可以之后再确认。",
  vi: "Nếu có người bị thương hoặc đang gặp nguy hiểm, hãy dừng đọc và hành động ngay. Đưa bản thân và những người xung quanh ra khỏi khu vực nguy hiểm. Gọi 119 để được cấp cứu và nói vị trí của bạn trước. Báo ngay cho người phụ trách hiện trường. Không di chuyển người có thể bị thương nặng, trừ khi chỗ đó đang nguy hiểm.\n\nSau khi mọi người đã an toàn, hãy ghi lại thời gian, địa điểm và tình trạng bị thương, chụp ảnh nếu có thể. Các bước yêu cầu bồi thường tai nạn lao động có thể kiểm tra sau.",
  th: "หากมีคนบาดเจ็บหรืออยู่ในอันตราย ให้หยุดอ่านแล้วลงมือทันที พาตัวเองและคนรอบข้างออกจากจุดอันตราย โทร 119 เพื่อขอความช่วยเหลือฉุกเฉิน และบอกสถานที่ก่อน แจ้งหัวหน้างานทันที อย่าเคลื่อนย้ายผู้ที่อาจบาดเจ็บสาหัส เว้นแต่จุดนั้นยังอันตรายอยู่\n\nเมื่อทุกคนปลอดภัยแล้ว ให้จดเวลา สถานที่ และอาการบาดเจ็บไว้ และถ่ายรูปถ้าทำได้ ขั้นตอนการขอรับค่าทดแทนอุบัติเหตุจากการทำงานตรวจสอบภายหลังได้",
};

export const MULTILINGUAL_EMERGENCY_ACTION_LABELS: Record<EmergencyAnswerLocale, { safety: string; call1350: string; limitation: string }> = {
  en: { safety: "Get to safety now", call1350: "Check with the Ministry of Employment and Labor (1350)", limitation: "Online counseling cannot replace emergency rescue or on-site response." },
  zh: { safety: "立即确保安全", call1350: "向雇佣劳动部1350咨询", limitation: "在线咨询不能代替紧急救援或现场处置。" },
  vi: { safety: "Đến nơi an toàn ngay", call1350: "Hỏi Bộ Việc làm và Lao động (1350)", limitation: "Tư vấn trực tuyến không thể thay thế cứu hộ khẩn cấp hoặc xử lý tại hiện trường." },
  th: { safety: "ไปยังที่ปลอดภัยทันที", call1350: "สอบถามกระทรวงการจ้างงานและแรงงาน (1350)", limitation: "การปรึกษาออนไลน์ไม่สามารถแทนการกู้ภัยฉุกเฉินหรือการจัดการในที่เกิดเหตุได้" },
};

/**
 * 답할 언어. 화면 언어가 구현 언어면 그 언어, 아니면 감지한 언어가 구현 언어일 때 그 언어,
 * 둘 다 아니면(지원 예정 언어) 영어로 답한다.
 */
export function emergencyAnswerLocale(hit: MultilingualEmergencyHit, uiLocale?: string): EmergencyAnswerLocale {
  const implemented = (value: string | undefined): value is EmergencyAnswerLocale =>
    value === "en" || value === "zh" || value === "vi" || value === "th";
  if (implemented(uiLocale)) return uiLocale;
  if (implemented(hit.language)) return hit.language;
  return "en";
}

export function multilingualEmergencyAnswer(locale: EmergencyAnswerLocale): string {
  return `${MULTILINGUAL_EMERGENCY_ANSWERS[locale]}\n\n${KOREAN_LINE}`;
}
