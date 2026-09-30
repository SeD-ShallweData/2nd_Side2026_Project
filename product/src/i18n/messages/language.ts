import { defineMessages } from "@/i18n/defineMessages";

/*
 * 언어 선택기와 "지원 예정" 표시.
 * 지원 예정 언어의 근거 문구는 docs/i18n/LANGUAGE_SUPPORT.md 의 공식 통계에서 가져왔다.
 * 근거가 없는 언어(러시아어·인도네시아어)는 빈 문자열로 두고 공통 안내만 보여 준다.
 */
export const languageMessages = defineMessages({
  ko: {
    selectorLabel: "언어",
    selectorAria: "화면 언어 선택",
    current: "현재 언어",
    pendingBadge: "지원 예정(개발 중)",
    pendingCommon: "지금은 영어로 이용할 수 있습니다.",
    pendingReason: {
      uz: "우즈베키스탄 국적 근로자는 최근 외국인 산재 사망자 중 세 번째로 많습니다(2025년~2026년 2분기 6명).",
      ru: "",
      ne: "네팔 국적 근로자는 최근 외국인 산재 사망자 중 다섯 번째로 많습니다(2025년~2026년 2분기 4명).",
      id: "",
      km: "캄보디아 국적 근로자는 임금체불이 몰린 30인 미만 제조업에서 일하는 주요 국적입니다.",
    },
    easyKoreanTitle: "쉬운 한국어",
    easyKoreanDescription:
      "고령 동포 근로자를 위한 화면입니다. 고령 동포 근로자는 재외동포(F-4)·방문취업(H-2) 등의 체류자격으로 한국에서 일하는 만 60세 이상 한국계 외국 국적 근로자를 말합니다. 글자를 크게, 문장을 짧게 보여 줍니다. 누구나 고를 수 있고 나이나 체류자격은 묻지 않습니다.",
    voiceInput: "음성 입력",
    voiceRead: "읽어 주기",
    voicePending: "지원 예정(추후 도입 기능)",
    voicePendingReason: "글을 읽고 쓰기 어려운 분도 쓸 수 있도록 음성으로 묻고 듣는 기능을 준비하고 있습니다.",
    // 처음 온 사용자에게 브라우저 언어로 화면 언어를 제안한다(강요하지 않음). 문구는 제안하는 언어로 보인다.
    suggestTitle: "처음 오셨나요? 이 서비스를 {language}(으)로 볼 수 있습니다.",
    suggestAccept: "{language}(으)로 보기",
    suggestDismiss: "한국어로 계속 보기",
    suggestAria: "화면 언어 제안",
  },
  "ko-easy": {
    pendingCommon: "지금은 영어로 쓸 수 있어요.",
    easyKoreanDescription:
      "나이가 많은 동포 근로자를 위한 화면이에요. 동포 근로자는 F-4, H-2 비자 등으로 한국에서 일하는 만 60세 이상 한국계 외국 사람이에요. 글자가 크고 문장이 짧아요. 누구나 고를 수 있어요. 나이나 비자는 묻지 않아요.",
    voicePendingReason: "말로 묻고 귀로 듣는 기능을 준비하고 있어요.",
  },
  en: {
    selectorLabel: "Language",
    selectorAria: "Choose display language",
    current: "Current language",
    pendingBadge: "Coming soon (in development)",
    pendingCommon: "For now, you can use the service in English.",
    pendingReason: {
      uz: "Uzbek nationals had the third-highest number of fatal workplace accidents among foreign workers recently (6 deaths, 2025 to Q2 2026).",
      ru: "",
      ne: "Nepali nationals had the fifth-highest number of fatal workplace accidents among foreign workers recently (4 deaths, 2025 to Q2 2026).",
      id: "",
      km: "Cambodian nationals are a major group working in small manufacturers (under 30 workers), where most unpaid wages are concentrated.",
    },
    easyKoreanTitle: "Easy Korean",
    easyKoreanDescription:
      "A view for older ethnic Korean workers: workers of Korean descent with foreign nationality, aged 60 or over, working in Korea on an Overseas Korean (F-4) or Working Visit (H-2) visa or a similar status. It uses larger text and shorter sentences. Anyone can choose it; we never ask your age or visa status.",
    voiceInput: "Voice input",
    voiceRead: "Read aloud",
    voicePending: "Coming soon",
    voicePendingReason: "We are preparing voice questions and spoken answers for people who find reading or writing difficult.",
    // 처음 온 사용자에게 브라우저 언어로 화면 언어를 제안한다(강요하지 않음). 문구는 제안하는 언어로 보인다.
    suggestTitle: "First time here? You can use this service in English.",
    suggestAccept: "Switch to English",
    suggestDismiss: "Keep Korean",
    suggestAria: "Display language suggestion",
  },
  zh: {
    selectorLabel: "语言",
    selectorAria: "选择页面语言",
    current: "当前语言",
    pendingBadge: "即将支持(开发中)",
    pendingCommon: "目前可以使用英文版。",
    pendingReason: {
      uz: "在最近的外国劳动者工伤死亡人数中,乌兹别克斯坦籍位居第三(2025年至2026年第二季度共6人)。",
      ru: "",
      ne: "在最近的外国劳动者工伤死亡人数中,尼泊尔籍位居第五(2025年至2026年第二季度共4人)。",
      id: "",
      km: "柬埔寨籍劳动者是欠薪集中的30人以下制造业企业中的主要群体。",
    },
    easyKoreanTitle: "简单韩语",
    easyKoreanDescription:
      "为高龄同胞劳动者准备的页面。高龄同胞劳动者是指持在外同胞(F-4)、访问就业(H-2)等签证在韩国工作的60周岁以上韩裔外国籍劳动者。字体更大,句子更短。任何人都可以选择,我们不会询问年龄或签证。",
    voiceInput: "语音输入",
    voiceRead: "朗读",
    voicePending: "即将支持(后续上线)",
    voicePendingReason: "我们正在准备语音提问和语音回答功能,方便读写有困难的人使用。",
    // 처음 온 사용자에게 브라우저 언어로 화면 언어를 제안한다(강요하지 않음). 문구는 제안하는 언어로 보인다.
    suggestTitle: "第一次来吗？本服务可以用中文（简体）浏览。",
    suggestAccept: "切换为中文",
    suggestDismiss: "继续使用韩语",
    suggestAria: "页面语言建议",
  },
  vi: {
    selectorLabel: "Ngôn ngữ",
    selectorAria: "Chọn ngôn ngữ hiển thị",
    current: "Ngôn ngữ hiện tại",
    pendingBadge: "Sắp hỗ trợ (đang phát triển)",
    pendingCommon: "Hiện tại bạn có thể dùng bản tiếng Anh.",
    pendingReason: {
      uz: "Lao động quốc tịch Uzbekistan đứng thứ ba về số người tử vong do tai nạn lao động trong số lao động nước ngoài gần đây (6 người, từ năm 2025 đến quý 2/2026).",
      ru: "",
      ne: "Lao động quốc tịch Nepal đứng thứ năm về số người tử vong do tai nạn lao động trong số lao động nước ngoài gần đây (4 người, từ năm 2025 đến quý 2/2026).",
      id: "",
      km: "Lao động quốc tịch Campuchia là nhóm chính làm việc tại các cơ sở sản xuất dưới 30 người, nơi tập trung nhiều vụ nợ lương.",
    },
    easyKoreanTitle: "Tiếng Hàn dễ hiểu",
    easyKoreanDescription:
      "Giao diện dành cho lao động đồng bào cao tuổi: người gốc Hàn mang quốc tịch nước ngoài, từ 60 tuổi trở lên, làm việc tại Hàn Quốc với thị thực Kiều bào (F-4), Thăm thân làm việc (H-2) hoặc tư cách tương tự. Chữ to hơn, câu ngắn hơn. Ai cũng có thể chọn; chúng tôi không hỏi tuổi hay thị thực.",
    voiceInput: "Nhập bằng giọng nói",
    voiceRead: "Đọc to",
    voicePending: "Sắp ra mắt",
    voicePendingReason: "Chúng tôi đang chuẩn bị chức năng hỏi và nghe trả lời bằng giọng nói cho người gặp khó khăn khi đọc, viết.",
    // 처음 온 사용자에게 브라우저 언어로 화면 언어를 제안한다(강요하지 않음). 문구는 제안하는 언어로 보인다.
    suggestTitle: "Lần đầu đến đây? Bạn có thể dùng dịch vụ này bằng tiếng Việt.",
    suggestAccept: "Chuyển sang tiếng Việt",
    suggestDismiss: "Tiếp tục dùng tiếng Hàn",
    suggestAria: "Gợi ý ngôn ngữ hiển thị",
  },
  th: {
    selectorLabel: "ภาษา",
    selectorAria: "เลือกภาษาที่แสดง",
    current: "ภาษาปัจจุบัน",
    pendingBadge: "เร็ว ๆ นี้ (กำลังพัฒนา)",
    pendingCommon: "ขณะนี้ใช้งานเป็นภาษาอังกฤษได้",
    pendingReason: {
      uz: "แรงงานสัญชาติอุซเบกิสถานมีผู้เสียชีวิตจากอุบัติเหตุในการทำงานมากเป็นอันดับสามในบรรดาแรงงานต่างชาติช่วงหลังนี้ (6 คน ปี 2025 ถึงไตรมาส 2 ปี 2026)",
      ru: "",
      ne: "แรงงานสัญชาติเนปาลมีผู้เสียชีวิตจากอุบัติเหตุในการทำงานมากเป็นอันดับห้าในบรรดาแรงงานต่างชาติช่วงหลังนี้ (4 คน ปี 2025 ถึงไตรมาส 2 ปี 2026)",
      id: "",
      km: "แรงงานสัญชาติกัมพูชาเป็นกลุ่มหลักที่ทำงานในโรงงานขนาดต่ำกว่า 30 คน ซึ่งเป็นที่ที่มีการค้างจ่ายค่าจ้างมากที่สุด",
    },
    easyKoreanTitle: "ภาษาเกาหลีอย่างง่าย",
    easyKoreanDescription:
      "หน้าจอสำหรับแรงงานเชื้อสายเกาหลีสูงอายุ คือผู้มีเชื้อสายเกาหลีที่ถือสัญชาติต่างประเทศ อายุ 60 ปีขึ้นไป ซึ่งทำงานในเกาหลีด้วยวีซ่าชาวเกาหลีโพ้นทะเล (F-4) หรือวีซ่าเยือนเพื่อทำงาน (H-2) เป็นต้น ตัวอักษรใหญ่ขึ้นและประโยคสั้นลง ทุกคนเลือกได้ และเราไม่ถามอายุหรือวีซ่า",
    voiceInput: "พูดเพื่อถาม",
    voiceRead: "อ่านออกเสียง",
    voicePending: "เร็ว ๆ นี้",
    voicePendingReason: "เรากำลังเตรียมฟังก์ชันถามด้วยเสียงและฟังคำตอบ สำหรับผู้ที่อ่านเขียนได้ยาก",
    // 처음 온 사용자에게 브라우저 언어로 화면 언어를 제안한다(강요하지 않음). 문구는 제안하는 언어로 보인다.
    suggestTitle: "มาครั้งแรกใช่ไหม ใช้บริการนี้เป็นภาษาไทยได้",
    suggestAccept: "เปลี่ยนเป็นภาษาไทย",
    suggestDismiss: "ใช้ภาษาเกาหลีต่อ",
    suggestAria: "คำแนะนำภาษาที่แสดง",
  },
});
