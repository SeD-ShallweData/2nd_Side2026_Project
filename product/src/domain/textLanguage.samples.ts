/*
 * 작성 언어 추정 시험 문장. detectTextLanguage 단위 시험과, JS 규칙과 PostgreSQL 규칙이
 * 같은 답을 내는지 보는 선택 시험(RealCommunityRepository.language.pg.test.ts)이 함께 쓴다.
 */
import type { TextLanguage } from "@/domain/textLanguage";

export const TEXT_LANGUAGE_SAMPLES: ReadonlyArray<{ title: string; body: string; expected: TextLanguage }> = [
  { title: "월급이 두 달째 밀렸어요", body: "사장님이 다음 달에 준다고만 합니다.", expected: "ko" },
  { title: "Samsung 협력업체 야간 근무", body: "OT 수당을 못 받았어요. HR에 물어봐도 답이 없습니다.", expected: "ko" },
  { title: "CCTV 설치", body: "현장 CCTV 확인 부탁드립니다", expected: "ko" },
  { title: "My boss has not paid me", body: "It has been two months since I got my salary.", expected: "en" },
  { title: "Is 1350 open on weekends?", body: "I want to call about unpaid overtime at 삼성.", expected: "en" },
  { title: "Công ty chưa trả lương", body: "Tôi đã làm việc ba tháng nhưng chưa nhận được tiền.", expected: "vi" },
  { title: "Luong thang 9", body: "Toi chua nhan duoc luong thang 9, phai lam sao?", expected: "en" },
  { title: "老板两个月没有发工资", body: "我该去哪里咨询?", expected: "zh" },
  { title: "工伤申请", body: "在工地摔倒了,公司不让我申请工伤。", expected: "zh" },
  { title: "นายจ้างไม่จ่ายค่าจ้าง", body: "ผมทำงานมาสามเดือนแล้วยังไม่ได้เงินเลย", expected: "th" },
  { title: "Работодатель не платит", body: "Что мне делать?", expected: "other" },
  { title: "給料が払われません", body: "どこに相談すればいいですか", expected: "other" },
  { title: "12345", body: "!!! 🙏🙏", expected: "other" },
  { title: "Nguyễn Văn A", body: "Please help me with my contract, the company changed my job without telling me.", expected: "en" },
];
