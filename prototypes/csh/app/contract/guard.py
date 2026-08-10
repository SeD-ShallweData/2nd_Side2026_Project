"""근로계약서 진단 전용 가드레일.

기존 `app/guardrails.py`를 그대로 쓸 수 없습니다. 그쪽은 **사업장**을 말할 때의
규칙이라 계약서 해설에서 오탐을 냅니다.

- `legal_verdict` — 조문을 인용해 설명하는 정상 문장까지 잡습니다
- `risk_grade` / `risk_score` — 계약서 해설에는 나올 일이 없어 무의미합니다
- `fabricated_workplace` — 계약서에 적힌 회사명은 조회 레코드에 없는 것이 당연합니다

대신 이 기능 고유의 위험을 봅니다.

- 판정 뒤집기 — 규칙 엔진이 "확인 필요"라고 한 것을 "위법"이라고 올리는 것
- 조문 창작 — standards.LAWS 에 없는 조문 번호를 만들어 붙이는 것
- 점수·등급화 — ADR-0001이 금지한 형태 (계약서에도 같은 원칙을 적용합니다)
- 회사 실명 + 부정 판정
"""

import re

from ..guardrails import NEGATION, SAFE_FALLBACK, Verdict, _SENT
from . import standards

# 문서에 인용해도 되는 조문 — standards.LAWS 의 키에서 뽑습니다.
# "근기법 제20조" 처럼 표에 있는 표기와, 답변에서 흔한 "근로기준법 제20조" 표기를 모두 허용합니다.
_ARTICLE = re.compile(r"제\s*(\d+)\s*조(?:\s*의\s*\d+)?")


def _known_articles() -> dict[str, set[str]]:
    """법 이름 → 허용 조문 번호 집합."""
    table: dict[str, set[str]] = {}
    alias = {
        "근기법": ("근기법", "근로기준법"),
        "최저임금법": ("최저임금법",),
        "최저임금법 시행령": ("최저임금법 시행령",),
        "퇴직급여법": ("퇴직급여법", "근로자퇴직급여 보장법", "근로자퇴직급여보장법"),
        "기간제법": ("기간제법", "기간제 및 단시간근로자 보호 등에 관한 법률"),
        "남녀고용평등법": ("남녀고용평등법", "남녀고용평등과 일·가정 양립 지원에 관한 법률"),
    }
    for key in standards.LAWS:
        head, _, tail = key.rpartition(" ")
        number = _ARTICLE.search(tail)
        if not (head and number):
            continue
        for name in alias.get(head, (head,)):
            table.setdefault(name, set()).add(number.group(1))
    # 벌칙 조문은 LAWS의 penalty 문구에 등장하므로 함께 허용합니다.
    table.setdefault("근로기준법", set()).update({"109", "110", "114"})
    table.setdefault("근기법", set()).update({"109", "110", "114"})
    table.setdefault("최저임금법", set()).add("28")
    table.setdefault("퇴직급여법", set()).add("10")
    table.setdefault("근로자퇴직급여 보장법", set()).add("10")
    return table


KNOWN_ARTICLES = _known_articles()

# "근로기준법 제20조" 형태를 통째로 잡습니다.
_CITATION = re.compile(
    r"(근로기준법|근기법|최저임금법 시행령|최저임금법|근로자퇴직급여\s*보장법|퇴직급여법"
    r"|기간제법|남녀고용평등법)\s*(?:제\s*)?(\d+)\s*조")

# 판정을 단정으로 올리는 표현. 20-가드레일.md 6번과 같은 기준입니다.
_VERDICT_WORD = re.compile(
    r"(명백한|명백히)\s*(위법|불법)|위법입니다|불법입니다|무효입니다만"
    r"|(위법|불법)\s*행위입니다|처벌\s*(받습니다|됩니다)|형사\s*처벌\s*대상입니다"
    r"|고소하면\s*이깁니다|승소(합니다|할\s*수\s*있습니다)")

# 계약서를 점수·등급으로 요약하는 표현 (ADR-0001과 같은 이유로 금지).
_SCORE = re.compile(
    r"(계약서|위험도|안전도|준수도)\s*(점수|등급|레벨|스코어)\s*[:은는이가]?\s*[\dA-Fa-f]"
    r"|\d{1,3}\s*점\s*(만점|입니다|/\s*100)"
    r"|[A-F]\s*등급")

# 서명 자체를 지시하는 표현. 이 서비스는 결정을 대신하지 않습니다.
_DIRECTIVE = re.compile(
    r"절대\s*서명하지\s*마|서명하지\s*마세요"
    r"|(이\s*회사|이\s*사업장|여기)[^.\n]{0,8}(가지|입사하지|지원하지)\s*마"
    r"|입사하지\s*마세요|지원하지\s*마세요|당장\s*그만두세요")


def _cited_articles(text: str) -> list[tuple[str, str]]:
    return [(m.group(1), m.group(2)) for m in _CITATION.finditer(text)]


def inspect(text: str, verdict_laws: set[str] | None = None) -> Verdict:
    """계약서 해설을 검사합니다. 텍스트를 바꾸지는 않습니다.

    verdict_laws: 규칙 엔진이 실제로 인용한 조문 키. 넘기면 그 범위를 벗어난
    인용을 잡습니다. 넘기지 않으면 standards.LAWS 전체를 허용합니다.
    """
    result = Verdict()
    if not text:
        return result

    allowed = KNOWN_ARTICLES
    for sentence in _SENT.findall(text):
        sentence = sentence.strip()
        if not sentence:
            continue

        match = _VERDICT_WORD.search(sentence)
        if match and not NEGATION.search(sentence):
            result.blocked = True
            result.hits.append({
                "rule": "legal_certainty",
                "reason": "법 위반을 단정 (3단계 표현 규칙 위반)",
                "matched": match.group(0)[:80],
                "sentence": sentence[:160],
            })

        match = _SCORE.search(sentence)
        if match:
            result.blocked = True
            result.hits.append({
                "rule": "contract_score",
                "reason": "계약서를 점수·등급으로 요약 (ADR-0001)",
                "matched": match.group(0)[:80],
                "sentence": sentence[:160],
            })

        match = _DIRECTIVE.search(sentence)
        if match:
            result.blocked = True
            result.hits.append({
                "rule": "decision_directive",
                "reason": "사용자의 결정을 대신함 (서명·입사 여부는 안내하지 않습니다)",
                "matched": match.group(0)[:80],
                "sentence": sentence[:160],
            })

        for law_name, number in _cited_articles(sentence):
            if number in allowed.get(law_name, set()):
                continue
            result.blocked = True
            result.hits.append({
                "rule": "fabricated_article",
                "reason": "조문 표(standards.LAWS)에 없는 조문을 인용",
                "matched": f"{law_name} 제{number}조",
                "sentence": sentence[:160],
            })

    # 규칙 엔진이 인용하지 않은 조문을 해설이 끌어온 경우
    if verdict_laws is not None:
        used = {f"{name} 제{num}조" for name, num in _cited_articles(text)}
        for citation in sorted(used):
            if not _matches_verdict(citation, verdict_laws):
                result.hits.append({
                    "rule": "law_out_of_verdict",
                    "reason": "판정 결과에 없는 조문을 해설이 끌어옴",
                    "matched": citation,
                    "sentence": "",
                })
    return result


_ALIAS_HEAD = {"근로기준법": "근기법", "근로자퇴직급여 보장법": "퇴직급여법",
               "근로자퇴직급여보장법": "퇴직급여법"}


def _matches_verdict(citation: str, verdict_laws: set[str]) -> bool:
    """'근로기준법 제20조'가 판정에 쓰인 '근기법 제20조'와 같은 것인지 봅니다."""
    name, _, tail = citation.rpartition(" 제")
    number = tail.rstrip("조")
    head = _ALIAS_HEAD.get(name, name)
    for key in verdict_laws:
        if key.startswith(head) and f"제{number}조" in key:
            return True
    # 벌칙 조문(제109·110·114조)은 law_text 안에 이미 들어 있으므로 허용합니다.
    return number in {"109", "110", "114", "28", "10"}


CONTRACT_FALLBACK = (
    "죄송합니다. 방금 준비한 해설이 이 서비스의 표현 기준에 맞지 않아 전달하지 못했습니다.\n\n"
    "아래 **조항별 판정 결과는 규칙 엔진이 직접 계산한 것이라 그대로 유효합니다.** "
    "해설 문장만 다시 만들지 못한 상태입니다.\n\n"
    "돈워리는 계약서에 점수·등급을 매기거나 법 위반을 단정하지 않습니다. "
    "각 항목의 조문과 근거를 직접 확인해 주시고, 판단이 필요하면 "
    "고용노동부 고객상담센터(☎1350)에 문의하세요."
)


def apply(text: str, verdict_laws: set[str] | None = None,
          mode: str = "block") -> tuple[str, Verdict]:
    """검사 후 대체 문구로 바꿉니다. (최종 텍스트, 판정) 반환.

    해설이 차단돼도 **조항별 판정 결과는 화면에 그대로 남습니다.**
    판정은 규칙 엔진이 낸 것이고 이 가드레일은 해설 문장만 봅니다.
    """
    verdict = inspect(text, verdict_laws)
    verdict.mode = mode
    if verdict.blocked and mode == "block":
        return CONTRACT_FALLBACK, verdict
    return text, verdict


__all__ = ["inspect", "apply", "CONTRACT_FALLBACK", "SAFE_FALLBACK", "KNOWN_ARTICLES"]
