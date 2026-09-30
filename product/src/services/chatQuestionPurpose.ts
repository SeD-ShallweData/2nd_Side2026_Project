/** Shared input contract for routing and output completeness, independent of company names. */
export function asksNextAction(message: string): boolean {
  return /(?:오늘|지금|다음|앞으로|어떤|무엇을|뭘).{0,16}(?:할\s*일|행동|대응|준비)|(?:할\s*일|행동|대응|준비).{0,40}(?:알려|말해|정리)|(?:접수|신고|진정)\s*(?:창구|방법|절차)/.test(message);
}

/** A user's documents in a wage claim are not public company indicators. */
export function asksWageDocumentUse(message: string): boolean {
  return /문서|서류|계약서|명세서|통장|근무\s*기록/.test(message)
    && /임금|체불|급여|월급/.test(message)
    && /신고|진정|접수|자료|활용|사용|보유|갖고|갖춰|준비/.test(message);
}

export function asksUserDocumentStatus(message: string): boolean {
  if (/공제|계산\s*방법|뜻|의미|어느\s*항목|어떤\s*항목/.test(message) && !asksExplicitRecall(message)) return false;
  return /계약서|명세서|통장\s*사본|서류|문서/.test(message)
    && /보유|보관|갖고|받았|받은|못\s*받|있는|없는|없다|없나요|분실|상태|진술|말한|말했|정정|구분/.test(message);
}

export function workRecordRequestTemplate(message: string): string | null {
  if (!/근무표|출퇴근\s*기록|출근\s*기록|근무\s*기록/.test(message)
    || !/요청|달라고|보내\s*달/.test(message)
    || !/문장|문구|문자|메시지|메일/.test(message)
    || !/써|작성|만들|예시|공손|정중/.test(message)
    || /법적|법률|의무|기한|조항|신고|진정|추천|코드|주식|투자/.test(message)) return null;
  const record = /근무표/.test(message) ? "근무표" : /출퇴근|출근/.test(message) ? "출퇴근 기록" : "근무 기록";
  return `“안녕하세요. 제가 근무한 기간의 근로시간과 급여 내역을 확인하려고 합니다. 해당 기간의 ${record} 사본을 보내 주실 수 있을까요? 감사합니다.”`;
}

/** A polite instruction alone ("알려 주세요") does not make a question recall. */
export function asksExplicitRecall(message: string): boolean {
  return /기억|회상|제가\s*말|말했|말한|말씀드린|정정한|앞서|아까|지금까지|이\s*상담에서.{0,20}(?:정리|알려)|다시\s*(?:말|알려|정리)/.test(message);
}
