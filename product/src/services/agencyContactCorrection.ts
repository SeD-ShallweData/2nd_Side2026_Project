/*
 * 기관 연락처 교정.
 *
 * 1350 은 고용노동부 고객상담센터 번호다. 산재보험법 수록 뒤 모델이 "근로복지공단 콜센터(1350)",
 * "근로복지공단 홈페이지(노동포털)"처럼 두 기관을 섞어 쓰는 사례가 운영에서 나왔다(2026-09-30).
 * 프롬프트로도 막지만, 전화번호는 틀리면 사용자가 그대로 전화하므로 출력에서 한 번 더 고친다.
 *
 * 한 문장 안에 근로복지공단과 1350 이 함께 있고 고용노동부가 없을 때만 고친다.
 * "고용노동부 1350 에 상담하고 산재 신청은 근로복지공단에" 같은 올바른 문장은 건드리지 않는다.
 */

export const COMWEL_CONTACT_NUMBER = "1588-0075";

function correctSentence(sentence: string): string {
  if (!sentence.includes("근로복지공단")) return sentence;
  let corrected = sentence.replace(/근로복지공단\s*홈페이지\s*\(\s*노동포털\s*\)/g, "근로복지공단 홈페이지");
  if (/1350/.test(corrected) && !/고용노동부/.test(corrected)) {
    corrected = corrected.replace(/(?<!\d)1350(?!\d)/g, COMWEL_CONTACT_NUMBER);
  }
  return corrected;
}

export function correctAgencyContacts(answer: string): string {
  if (!answer.includes("근로복지공단")) return answer;
  // 문장 경계(마침표 뒤 공백·줄바꿈)를 구분자로 남겨 원래 줄바꿈과 목록 형태를 그대로 둔다.
  return answer.split(/((?<=[.!?。])\s+|\n)/).map(correctSentence).join("");
}
