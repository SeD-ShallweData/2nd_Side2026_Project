/*
 * 외국어 긴급 상황 감지 (언어 지원 1단계).
 *
 * 기존 긴급 감지(PolicyChatProvider 의 ACUTE_INJURY·EMERGENCY_SIGNS 등)는 한국어 표현만 본다.
 * 외국인 근로자 산재 사망은 추락·깔림·매몰·끼임이 대부분이라(외국인 근로자 피해 통계 조사 2.3절),
 * 모국어로 "떨어졌다", "깔렸다", "기계에 끼었다"고 써도 곧바로 긴급 안내가 나가야 한다.
 * 농·어업은 트랙터 전복·농약 중독·익사, 건설·제조업은 질식·가스 사고도 많아 함께 본다.
 * 이 네 유형은 비유로도 쓰이므로("drowning in debt", "overturn the decision", "게임 중독")
 * 물질·장비·배 같은 사고 맥락이 있을 때만 잡는다.
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
    // 중독: 물질이 함께 있을 때만. "addicted", "workaholic"은 걸리지 않는다.
    /\b(?:pesticides?|insecticides?|herbicides?|weed ?killer|chemicals?|gas|fumes?|carbon monoxide|solvents?|bleach|ammonia|chlorine|hydrogen sulfide)\b.{0,30}\b(?:poison(?:ed|ing)?|inhal(?:ed|ing)|breath(?:ed|ing) in|swallow(?:ed)?|dr[au]nk|exposed|exposure|leak(?:s|ed|ing)?|collapsed|vomit(?:ed|ing)?|dizzy)\b|\b(?:poisoned|poisoning)\b|\b(?:swallowed|drank|inhaled|breathed in)\b.{0,20}\b(?:pesticide|chemical|gas|fumes|poison|bleach|solvent)/,
    // 질식
    /\bsuffocat|\basphyxi|\bchok(?:ed|ing)\b|\b(?:manhole|tank|silo|sewer|septic|pit|confined space|cargo hold)\b.{0,30}\b(?:collapsed|unconscious|fainted|passed out|not coming out|can'?t get out)\b|\b(?:no|not enough|lack of) (?:air|oxygen)\b(?!\s*-?\s*con)/,
    // 익사: "drowning in debt/work" 같은 비유는 뺀다.
    /\bdrown(?:ed|ing|s)?\b(?!\s+in\s+(?:debt|work|paperwork|bills|emails|stress|tasks))|\bfell (?:overboard|in(?:to)? the (?:water|sea|river|lake|pond|reservoir|canal))|\boverboard\b|\bswept away\b/,
    // 전복: 장비·배가 있을 때만. "overturn the decision", "the court overturned"는 걸리지 않는다.
    /\b(?:tractors?|forklifts?|trucks?|vehicles?|car|van|excavators?|loaders?|boats?|ships?|vessels?|tillers?|cultivators?|cranes?|lorry|harvesters?|quad bike)\b.{0,25}\b(?:overturn(?:ed|ing|s)?|roll(?:ed|s|ing)? over|tip(?:ped|s|ping)? over|flip(?:ped|s)?(?: over)?(?! out)|capsiz(?:e|ed|es|ing)|sank|sinking)\b|\b(?:overturned|flipped|capsized)\s+(?:tractor|forklift|truck|boat|vehicle)\b|\bcapsiz(?:e|ed|ing)\b/,
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
    // 中毒: 물질이 함께 있거나 사람이 중독된 경우. "上瘾", "游戏中毒"는 걸리지 않는다.
    /(?:农药|杀虫剂|除草剂|化学品|化学药品|化学物质|有毒|毒气|煤气|一氧化碳|硫化氢|有害物质|溶剂|甲醇|天然气|气体|油漆).{0,10}(?:中毒|喝了|喝下|误喝|误服|吸入|吸了|泄漏|泄露|熏倒|晕倒|昏倒)|(?:喝了|喝下|误喝|误服|吸入|吸了|闻了).{0,6}(?:农药|杀虫剂|除草剂|化学|毒气|煤气|有毒)|(?<!游戏|手机|网络|工作|购物|网)中毒/,
    // 窒息
    /窒息|憋死|闷死|缺氧|透不过气|(?:井|罐|池|窖|管道|下水道|化粪池|密闭|船舱|鱼舱).{0,8}(?:晕倒|昏迷|倒下|出不来)/,
    // 溺水
    /溺水|淹死|淹着了|落水|掉(?:进|到|入|下)(?:了)?(?:水|河|海|湖|池|水库|水塘|鱼塘|水沟)|掉下船|被水冲走|被浪卷走/,
    // 翻车·翻船: 차·배·장비가 있을 때만. "翻车"만 쓴 인터넷 말투는 걸리지 않는다.
    /侧翻|翻船|倾覆|(?:拖拉机|叉车|农机|铲车|挖掘机|卡车|货车|三轮车|车子|车辆|船|渔船|机器|收割机|吊车).{0,6}(?:翻了|翻倒|翻过来|翻车|沉了|沉没)|车翻了|翻车事故/,
  ],
  vi: [
    /nga tu (?:tren )?cao|roi tu (?:tren )?cao|te tu (?:tren )?cao|nga xuong|roi xuong|te xuong|nga giao|nga thang|(?:nga|roi|te) (?:tu )?(?:tren )?gian giao/,
    /bi de|de len nguoi|bi vui|vui lap|sap de/,
    /bi ket (?:vao )?may|ket tay|bi may (?:cuon|kep|nghien)|cuon vao may|kep vao may/,
    /chay mau (?:nhieu|khong ngung|khong cam)|mat nhieu mau|mau chay nhieu/,
    /bat tinh|ngat xiu|ngat di|khong tinh|hon me|khong phan ung/,
    /khong tho|khong the tho|ngung tho|kho tho/,
    /gay xuong|gay tay|gay chan/,
    /dien giat|bi giat dien/,
    /bong nang|bi bong/,
    /bi thuong nang/,
    // ngộ độc: "nghiện"(중독성)은 넣지 않았다. "trúng độc đắc"(복권 당첨)는 뺀다.
    // 성조를 지우면 khí độc(유독 가스)과 khi đọc(읽을 때)이 같아져, khi doc 은 들이마셨다는 말과만 본다.
    /ngo doc|\btrung doc\b(?! dac)|nhiem doc|\b(?:thuoc tru sau|thuoc sau|hoa chat|khi ga|thuoc diet co|thuoc diet chuot|khi than)\b.{0,20}\b(?:ngat|xiu|choang|non|oi mua|kho tho|bat tinh)\b|\b(?:hit|uong|nuot)(?: phai| nham)? (?:thuoc tru sau|thuoc sau|hoa chat|khi doc|khi ga|thuoc diet co)\b|\bro ri (?:khi|ga)\b/,
    // ngạt: 성조를 지우면 ngất(기절)과 같아진다. 둘 다 긴급이다.
    /ngat tho|ngat khi|bi ngat|thieu oxy|thieu duong khi|khong co khong khi/,
    // đuối nước: "bị đuổi (việc)"(해고)와 글자가 같아 "bi duoi"만으로는 보지 않는다.
    // "rồi họ"도 roi ho 가 되므로 xuong(xuống) 이 있어야 한다.
    /duoi nuoc|chet duoi|\b(?:roi|nga|te|rot) xuong (?:nuoc|song|bien|ho|ao|kenh|muong)\b|roi khoi (?:tau|thuyen|ghe)|nuoc cuon|song cuon|bi cuon troi/,
    // lật: 장비·배가 있을 때만
    /\blat (?:may cay|may keo|xe|thuyen|tau|ghe|may xuc)\b|\b(?:may cay|xe nang|xe cong nong|may keo|xe tai|xe|thuyen|tau ca|tau|ghe|may xuc|may gat)\b.{0,10}\b(?:bi lat|lat nhao|lat up|lat ngua|chim)\b|lat nhao|lat up/,
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
    // พิษ: สาร·ยาฆ่าแมลง이 있을 때만. "ติดเกม"(게임 중독)은 걸리지 않는다. "ที่ทำงานเป็นพิษ" 같은 비유도 뺀다.
    /(?:ได้รับ|โดน|ถูก|สูด|สูดดม|ดื่ม|กิน|กลืน|แพ้)(?:พิษ|สารเคมี|สารพิษ|ยาฆ่า|ยาปราบ|แก๊ส|ก๊าซ|ควัน)|พิษ(?:ยาฆ่า|สาร|แก๊ส|ก๊าซ)|(?:แก๊ส|ก๊าซ)รั่ว|(?:สารเคมี|ยาฆ่าแมลง|ยาฆ่าหญ้า|ยาปราบศัตรูพืช|แก๊ส|ก๊าซ|ควันพิษ).{0,15}(?:เป็นลม|หมดสติ|อาเจียน|วิงเวียน|หายใจ)|สารพิษ|ควันพิษ/,
    // ขาดอากาศ
    /ขาดอากาศ|ขาดออกซิเจน|สำลักควัน|หายใจไม่ได้/,
    // จมน้ำ
    /จมน้ำ|ตกน้ำ|ตกทะเล|ตกเรือ|ตกแม่น้ำ|ตกคลอง|ตกบ่อ|ตกลงไปในน้ำ|น้ำพัด/,
    // พลิกคว่ำ: รถ·เรือ가 있을 때만. "ระบบล่ม"(시스템 장애)은 걸리지 않는다.
    /(?:รถไถ|แทรกเตอร์|รถยก|โฟล์คลิฟ|รถ|เรือ|รถขุด|รถเกี่ยว|รถบรรทุก).{0,8}(?:พลิกคว่ำ|คว่ำ|พลิก|ล่ม|จม)|พลิกคว่ำ/,
  ],
  uz: [
    /yiqil|balanddan|bosib qol|ko['ʻ’`]?mil|qon ket|hushidan ket|nafas ol(?:ma|a ol)|tok ur|kuyd|yong['ʻ’`]?in/,
    // 중독·질식·익사·전복
    /zaharlan|bo['ʻ’`]?g['ʻ’`]?il|cho['ʻ’`]?k(?:ib|di|yapti)|suvga (?:tush|yiqil|cho)|ag['ʻ’`]?daril/,
  ],
  ru: [
    /упал|упала|сорвал|придавил|завалил|затянул|зажал|кровотечен|кровь не останавлив|без сознания|потерял[аи]? сознание|не дышит|перелом|ударил[оа]? током|ожог|пожар/,
    // 중독·질식·익사·전복
    /отравил|отравлен|задохн|удушь|угар|утон|тонет|за борт|упал[аи]? в (?:воду|реку|море)|(?:трактор|погрузчик|машина|лодка|судно|катер|грузовик|комбайн)\S*.{0,15}(?:перевернул|опрокинул|затонул)|перевернул(?:ся|ась) (?:трактор|погрузчик|машина|лодка)|затонул/,
  ],
  ne: [
    /खस्य|लड्य|अग्लो ठाउँ|थिचिय|पुरिय|रगत|बेहोस|सास फेर्न|करेन्ट|आगो|जल्य/,
    // 중독·질식·익사·전복
    /विष|कीटनाशक|निसासि|निस्सासि|डुब्य|डुबे|डुबेर|पानीमा खस|पल्टि|पल्टी/,
  ],
  id: [
    /jatuh dari|terjatuh|tertimpa|terjepit|tertimbun|pendarahan|berdarah banyak|pingsan|tidak sadar|tidak bernapas|sesak napas|patah tulang|kesetrum|tersengat listrik|terbakar|kebakaran/,
    // 중독·질식·익사·전복
    /keracunan|tercekik|kehabisan (?:napas|oksigen)|tenggelam(?! dalam (?:utang|hutang|pekerjaan|tugas))|terseret arus|jatuh ke (?:laut|sungai|air|kolam|danau)|(?:traktor|forklift|truk|mobil|kapal|perahu|mesin)\S*.{0,15}(?:terbalik|karam)|kapal karam/,
  ],
  km: [
    /ធ្លាក់|សង្កត់|កប់|ជាប់ម៉ាស៊ីន|ហូរឈាម|សន្លប់|មិនដកដង្ហើម|ឆក់ភ្លើង|រលាក|ភ្លើងឆេះ/,
    // 중독·질식·익사·전복
    /ពុល|ថប់ដង្ហើម|លង់ទឹក|ក្រឡាប់|លិច/,
  ],
};

/** 스크립트로 먼저 거른다. 한국어만 쓴 질문은 기존 한국어 감지가 맡는다. */
const SCRIPT_HINTS: Partial<Record<EmergencyDetectedLanguage, RegExp>> = {
  zh: /[一-鿿]/,
  th: /[฀-๿]/,
  ru: /[Ѐ-ӿ]/,
  ne: /[ऀ-ॿ]/,
  km: /[ក-៿]/,
};

/**
 * NFKC 는 태국어 สระอำ(ำ)을 ํ+า 두 글자로 나눈다. 그대로 두면 "น้ำ", "คว่ำ", "สำลัก"이
 * 들어간 표현이 전부 빠지므로 한 글자로 되돌린다.
 */
function recomposeThaiSaraAm(value: string): string {
  return value.replace(/\u0e4d\u0e32/g, "\u0e33");
}

export function detectMultilingualEmergency(message: string): MultilingualEmergencyHit | null {
  const text = recomposeThaiSaraAm(message.normalize("NFKC").toLocaleLowerCase("en-US"));
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
