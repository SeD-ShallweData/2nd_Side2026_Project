/**
 * 출력 가드레일 공용 엔진.
 *
 * 사용자 상담(`DualLlmChatProvider`)과 근로감독관 상담(`inspectorService`)이
 * 각자 같은 스캔 로직과 정규식을 복사해 두고 있었습니다. 복사본이 따로 자라면서
 * 실제로 어긋난 곳이 있었습니다.
 *
 *   - 법령 인용 패턴: 상담 쪽은 7개 법령·「」·제N조의M 까지 인식하도록 갱신됐지만
 *     감독관 쪽은 3개 법령만 보는 옛 패턴이 남아 있었습니다. 그래서 고용보험법·
 *     근로자퇴직급여 보장법·남녀고용평등법을 인용해도 `UNVERIFIED_LAW_CITATION`
 *     이 걸리지 않았습니다.
 *   - 부정문 패턴: 상담 쪽에만 `만들지` 가 있었습니다.
 *
 * 규칙은 데이터(표)로 두고 스캔 엔진 하나만 공유합니다. 규칙을 더할 때 코드가
 * 아니라 표를 고치면 되고, 두 화면의 판정 기준이 다시 갈라지지 않습니다.
 */

/** 문장 단위 분리. 문서 전체가 아니라 문장 안에서만 규칙을 본다. */
const SENTENCE_PATTERN = /[^.!?\n]+[.!?]?/g;

/**
 * 부정 표현. "안전한 회사라고 단정할 수 없습니다" 처럼 금지 표현을 부정하는
 * 문장까지 잡으면 정상 답변이 교체되므로, `allowNegated` 규칙은 건너뛴다.
 */
const NEGATION_PATTERN =
  /않습니다|않아요|않으며|않고|아닙니다|아니라|없습니다|못합니다|드리지|만들지|말씀드릴 수 없|판단할 수 없|확정할 수 없|보증하지|단정할 수 없/;

/**
 * 벡터DB에 적재된 법령. 새 법령을 적재하면 여기에도 추가해야 인용 검증이 동작한다.
 * 긴 이름을 먼저 두어 "근로기준법 시행령"이 "근로기준법"으로 잘리지 않게 한다.
 */
export const LAW_NAMES = [
  "남녀고용평등과 일ㆍ가정 양립 지원에 관한 법률",
  "근로자퇴직급여 보장법",
  "근로기준법 시행령",
  "임금채권보장법",
  "고용보험법",
  "최저임금법",
  "근로기준법",
] as const;

const LAW_CITATION_SOURCE = `(?:「\\s*)?(?:${LAW_NAMES.join("|")})(?:\\s*」)?\\s*제\\s*\\d+\\s*조(?:의\\s*\\d+)?`;

/**
 * 적재 목록에 **없는** 법령의 조문 인용.
 *
 * `LAW_CITATION_SOURCE` 는 적재된 7개 법령만 알기 때문에, 모델이 "노동조합 및
 * 노동관계조정법 제2조"처럼 DB에 없는 법을 인용하면 인용이 아예 발견되지 않아
 * 검증을 통과해 버렸습니다. 실제로 관측됐습니다 — 검색이 out_of_scope 로 막힌
 * 질문에 모델이 조문을 지어내 붙였는데 가드레일이 걸리지 않았습니다.
 *
 * 법령 이름에는 공백을 허용하지 않습니다. 허용하면 "임금을 못 받았다면
 * 근로기준법 제43조" 처럼 앞 문장까지 이름으로 삼켜 검증 키가 어긋납니다.
 * 공백이 있는 이름("노동조합 및 노동관계조정법")은 마지막 마디만 잡히는데,
 * 어차피 적재 목록에 없으므로 미검증으로 판정되어 결과는 같습니다.
 */
const UNKNOWN_LAW_CITATION_SOURCE =
  "(?:「\\s*)?([가-힣ㆍ]{2,20}법(?:률)?)(?:\\s*」)?\\s*제\\s*\\d+\\s*조(?:의\\s*\\d+)?";

/**
 * 공식 안내 문서 인용. 벡터DB의 조문과 달리 `official_guides.json` 에서 오며
 * 「기관 「문서 이름」」 형태입니다. 조문 정규식만 검사하면 모델이 지어낸
 * "고용노동부 노동포털 「노동조합 설립 절차」" 같은 문서명을 놓칩니다.
 */
const GUIDE_CITATION_SOURCE =
  "[가-힣]{2,12}(?:부|청|공단|포털|위원회|원|센터|상담)\\s*[^「\\n]{0,15}「[^」\\n]{2,40}」";

/** `g` 플래그가 있는 정규식은 lastIndex 상태를 가지므로 호출마다 새로 만든다. */
function lawCitationPattern(): RegExp {
  return new RegExp(LAW_CITATION_SOURCE, "g");
}

function unknownLawCitationPattern(): RegExp {
  return new RegExp(UNKNOWN_LAW_CITATION_SOURCE, "g");
}

function guideCitationPattern(): RegExp {
  return new RegExp(GUIDE_CITATION_SOURCE, "g");
}

/** 비교용 키. 공백·괄호를 지워 표기 차이를 흡수한다. */
function citationKey(citation: string): string {
  return citation.replace(/[「」\s]/g, "");
}

/** 답변에서 법령 인용을 뽑아 공백·괄호를 지운 비교용 키로 만든다. */
export function citationKeys(text: string): Set<string> {
  return new Set((text.match(lawCitationPattern()) ?? []).map(citationKey));
}

/**
 * 검증 대상이 되는 모든 근거 인용. 적재된 법령, 적재되지 않은 법령, 공식 안내
 * 문서를 함께 본다. `citationKeys` 는 이미 설명한 근거를 추리는 용도라 적재된
 * 법령만 보면 되지만, 검증은 답변이 내세운 근거 전부를 봐야 한다.
 */
function verifiableCitationKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const citation of text.match(lawCitationPattern()) ?? []) keys.add(citationKey(citation));
  for (const citation of text.match(unknownLawCitationPattern()) ?? []) keys.add(citationKey(citation));
  for (const citation of text.match(guideCitationPattern()) ?? []) keys.add(citationKey(citation));
  return keys;
}

/** 화면에 보여줄 형태로 인용을 뽑는다. 공백은 한 칸으로 정리하되 지우지 않는다. */
export function citationLabels(text: string): string[] {
  return [
    ...new Set(
      (text.match(lawCitationPattern()) ?? []).map((citation) =>
        citation.replace(/[「」]/g, "").replace(/\s+/g, " ").trim(),
      ),
    ),
  ];
}

export interface GuardrailRule {
  code: string;
  pattern: RegExp;
  /** 부정문에서는 넘어갈 규칙인지. 단정 표현 계열만 true. */
  allowNegated?: boolean;
}

/*
 * `PROMPT_DISCLOSURE` 의 머리말 검사는 원래 `#\s*(?:역할|가드레일|형식)\b` 였는데
 * `\b` 가 ASCII 단어 경계라 한글 뒤에서는 성립하지 않아 한 번도 발동하지 못했습니다.
 * `(?![가-힣])` 로 바꿔 "# 역할" 은 잡고 "# 역할극" 은 넘어가게 했습니다.
 * 역할극은 프롬프트를 유출시키려는 우회 수법 이름이라 머리말 유출과 구분해야 합니다.
 */

/** 사용자 상담 답변에 적용하는 규칙. */
export const CHAT_OUTPUT_GUARDRAILS: GuardrailRule[] = [
  { code: "SAFE_COMPANY_CERTAINTY", pattern: /안전한\s*(회사|사업장|기업|직장)(?:입니다|이다)|문제가\s*없는\s*(회사|사업장)(?:입니다|이다)/i, allowNegated: true },
  { code: "DANGEROUS_COMPANY_CERTAINTY", pattern: /위험한\s*(회사|사업장|기업|직장)(?:입니다|이다)|위험이\s*(있는|높은|큰)\s*(회사|사업장|기업)/i, allowNegated: true },
  { code: "LEGAL_CERTAINTY", pattern: /(?:위법|불법)(?:입니다|이다)|처벌(?:됩니다|받습니다)|반드시\s*승소/i, allowNegated: true },
  { code: "WAGE_FUTURE_CERTAINTY", pattern: /임금체불(?:이|은)?\s*발생할\s*것입니다|임금체불\s*가능성이\s*확실합니다|체불할\s*것입니다/i, allowNegated: true },
  { code: "SAFETY_FUTURE_CERTAINTY", pattern: /산재(?:가|는)?\s*발생할\s*것입니다|사고(?:가|는)?\s*(?:발생합니다|날\s*것입니다)/i, allowNegated: true },
  { code: "ADMISSION_DECISION", pattern: /입사하지\s*마세요|입사해도\s*됩니다/i, allowNegated: true },
  { code: "PUBLIC_RISK_VALUE", pattern: /(?:체불|산재|사고|위험)\s*(?:확률|점수|지수|등급|순위|랭킹)\s*(?:은|는|이|가|:|：)?\s*[A-Fa-f가-힣\d.]+|\d+(?:\.\d+)?\s*%[^.\n]{0,20}(?:위험|확률|체불)/i, allowNegated: true },
  { code: "PROMPT_DISCLOSURE", pattern: /시스템\s*프롬프트[는은]?\s*(?:다음|아래|이렇게)|숨은\s*프롬프트[는은]?\s*(?:다음|아래)|#\s*(?:역할|가드레일|형식)(?![가-힣])|\bAuthority\b.{0,40}\bScope\b|system prompt (?:is|as follows)/i },
  { code: "RAW_MODEL_FIELD", pattern: /raw_probability|shap[_ ]?value|\bSHAP\b|model_threshold|internal_score|feature[_ ]?importance/i },
];

/**
 * 근로감독관 상담 답변에 적용하는 규칙.
 *
 * 감독관 화면은 SHAP 사유와 모델 원점수를 정당하게 다루므로 `RAW_MODEL_FIELD`
 * 를 적용하지 않습니다. 대신 그 값을 확률로 바꿔 말하는 것을 막습니다.
 */
export const INSPECTOR_OUTPUT_GUARDRAILS: GuardrailRule[] = [
  { code: "PROBABILITY_CONVERSION", pattern: /(?:체불|위험).{0,12}\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*%.{0,12}(?:확률|가능성)/i },
  { code: "LEGAL_OR_ENFORCEMENT_CERTAINTY", pattern: /위법한\s*사업장(?:입니다|이다)|체불이\s*발생할\s*것입니다|즉시\s*처분해야\s*합니다/i, allowNegated: true },
  { code: "PROMPT_DISCLOSURE", pattern: /시스템\s*프롬프트[는은]?\s*(?:다음|아래|이렇게)|#\s*(?:역할|가드레일|형식)(?![가-힣])|system prompt (?:is|as follows)|\bAuthority\b.{0,40}\bScope\b/i },
  { code: "SECRET_DISCLOSURE", pattern: /API[_ ]?KEY\s*[:=]|(?:sk|up)_[A-Za-z0-9_-]{12,}/i },
];

/** 문장 단위로 규칙을 적용해 걸린 코드를 돌려준다. */
export function scanRules(answer: string, rules: GuardrailRule[]): Set<string> {
  const hits = new Set<string>();
  const sentences = answer.match(SENTENCE_PATTERN) ?? [answer];
  for (const sentence of sentences) {
    const negated = NEGATION_PATTERN.test(sentence);
    for (const rule of rules) {
      if (rule.pattern.test(sentence) && !(rule.allowNegated && negated)) {
        hits.add(rule.code);
      }
    }
  }
  return hits;
}

/**
 * 검색으로 확인되지 않은 근거 인용인지 판정한다.
 *
 * 검색이 성공했더라도 답변이 검색 결과에 없는 조문을 인용하면 걸린다.
 * `retrievedCitations` 를 주지 않으면 검색 성공 여부만 본다.
 *
 * 적재된 법령뿐 아니라 적재 목록 밖의 법령과 공식 안내 문서명까지 본다.
 * 조문만 검사하던 동안 "노동조합 및 노동관계조정법 제2조"나 지어낸
 * "고용노동부 노동포털 「노동조합 설립 절차」" 가 그대로 사용자에게 나갔다.
 */
export function hasUnverifiedCitation(
  answer: string,
  ragStatus: "matched" | "no_match" | "unavailable",
  retrievedCitations?: Iterable<string>,
): boolean {
  const cited = verifiableCitationKeys(answer);
  if (cited.size === 0) return false;
  if (ragStatus !== "matched") return true;
  if (!retrievedCitations) return false;

  const verified = new Set<string>();
  for (const citation of retrievedCitations) {
    for (const key of verifiableCitationKeys(citation)) verified.add(key);
  }
  return [...cited].some((citation) => !verified.has(citation));
}
