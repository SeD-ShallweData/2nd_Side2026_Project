/** Shared input contract for routing and output completeness, independent of company names. */
export function asksNextAction(message: string): boolean {
  return /(?:지금|다음|앞으로|어떤|무엇을|뭘).{0,12}(?:할\s*일|행동|대응|준비)|(?:할\s*일|행동|대응|준비).{0,14}(?:알려|말해|정리)/.test(message);
}

/** A user's documents in a wage claim are not public company indicators. */
export function asksWageDocumentUse(message: string): boolean {
  return /문서|서류|계약서|명세서|통장|근무\s*기록/.test(message)
    && /임금|체불|급여|월급/.test(message)
    && /진정|접수|자료|활용|사용|보유|갖고/.test(message);
}

export function asksUserDocumentStatus(message: string): boolean {
  return /계약서|명세서|통장\s*사본|서류|문서/.test(message)
    && /보유|갖고|있는|없는|없다|없나요|분실|상태|진술|말한|말했|정정|구분/.test(message);
}
