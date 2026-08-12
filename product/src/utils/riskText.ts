/**
 * 사업장 판정 결과 문구에서 사용자에게 나가면 안 되는 표기를 지운다.
 *
 * 위험 모델의 요약문에는 공표 우선순위 구간이 "상위1%" 처럼 순위로 적혀 있습니다.
 * 그대로 내보내면 특정 사업장에 순위를 붙이는 셈이 되어 서비스 표시정책에 어긋납니다
 * (`prototypes/csh/docs/ADR/0001-위험카드-표시정책.md`).
 *
 * 두 경로가 같은 요약문을 씁니다. 정책 baseline 답변(`MockChatProvider`)과 LLM에
 * 넘기는 컨텍스트(`DualLlmChatProvider`)입니다. 실제로 두 경로 모두에서 "상위1%"가
 * 사용자 답변에 그대로 나온 것을 확인했습니다.
 */
export function stripBandLabel(text: string): string {
  return text
    .replace(/[‘'"“]?상위\s*\d+(?:\.\d+)?\s*(?:%|퍼센트)[’'"”]?/g, "상위 구간")
    .replace(/\s{2,}/g, " ")
    .trim();
}
