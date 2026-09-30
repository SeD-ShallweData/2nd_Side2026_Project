export const CONTRACT_LAW_ALIASES = {
  근기법: "근로기준법",
  퇴직급여법: "근로자퇴직급여 보장법",
  근로자퇴직급여보장법: "근로자퇴직급여 보장법",
  기간제법: "기간제 및 단시간근로자 보호 등에 관한 법률",
  남녀고용평등법: "남녀고용평등과 일ㆍ가정 양립 지원에 관한 법률",
  "남녀고용평등과 일·가정 양립 지원에 관한 법률":
    "남녀고용평등과 일ㆍ가정 양립 지원에 관한 법률",
  // RAG 수록 법령의 법제처 공식 약칭. 시행령 약칭을 먼저 두어 본법 약칭으로 잘리지 않게 한다.
  "산재보험법 시행령": "산업재해보상보험법 시행령",
  산재보험법: "산업재해보상보험법",
  "외국인고용법 시행령": "외국인근로자의 고용 등에 관한 법률 시행령",
  외국인고용법: "외국인근로자의 고용 등에 관한 법률",
} as const;

/** 계약 규칙 엔진의 짧은 법률명을 사용자·모델·가드레일이 공유하는 정식명으로 바꾼다. */
export function normalizeContractLegalBasis(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  for (const [alias, canonical] of Object.entries(CONTRACT_LAW_ALIASES)) {
    if (!trimmed.startsWith(alias)) continue;
    const suffix = trimmed.slice(alias.length);
    if (/^\s*제/.test(suffix)) return `${canonical} ${suffix.trimStart()}`;
  }
  return trimmed;
}
