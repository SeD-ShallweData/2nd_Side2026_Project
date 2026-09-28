/** Shared input contract for routing and output completeness, independent of company names. */
export function asksNextAction(message: string): boolean {
  return /(?:지금|다음|앞으로|어떤|무엇을|뭘).{0,12}(?:할\s*일|행동|대응|준비)|(?:할\s*일|행동|대응|준비).{0,14}(?:알려|말해|정리)/.test(message);
}
