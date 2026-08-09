"""근로계약서 해설 가드레일 회귀 테스트.

    .venv/bin/python tests/test_contract_guard.py

계약서 해설은 기존 `app/guardrails.py` 규칙으로 검사할 수 없습니다.
조문을 인용해 설명하는 **정상 문장**이 `legal_verdict`에 걸리기 때문입니다.
그래서 `app/contract/guard.py`가 따로 있고, 이 테스트가 두 가지를 지킵니다.

- 잡아야 할 것 — 위법 단정 · 계약서 점수화 · 조문 창작 · 결정 대행
- **막으면 안 되는 것** — 조문을 인용한 정상 해설. 이쪽이 더 중요합니다
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("API_KEY_ENV_FILE", "/nonexistent-for-tests.env")

from app.contract import guard  # noqa: E402

# 반드시 차단되어야 하는 문장
BLOCK = [
    # 위법 단정 — 3단계 표현 규칙 위반
    ("이 조항은 명백한 위법입니다.", "legal_certainty"),
    ("제9조는 위법입니다.", "legal_certainty"),
    ("사업주는 처벌받습니다.", "legal_certainty"),
    ("소송하면 승소할 수 있습니다.", "legal_certainty"),
    # 점수·등급화 (ADR-0001)
    ("이 계약서 위험도 등급은 D입니다.", "contract_score"),
    ("계약서 점수: 37점입니다.", "contract_score"),
    ("종합하면 100점 만점에 42점입니다.", "contract_score"),
    ("이 계약서는 C 등급에 해당합니다.", "contract_score"),
    # 결정 대행
    ("절대 서명하지 마세요.", "decision_directive"),
    ("이 회사에는 가지 마세요.", "decision_directive"),
    # 조문 창작 — 표에 없는 조문
    ("근로기준법 제999조에 따라 무효입니다.", "fabricated_article"),
    ("최저임금법 제77조가 적용됩니다.", "fabricated_article"),
]

# 절대 차단되면 안 되는 문장 — 규칙 엔진이 실제로 내보내는 정상 해설
ALLOW = [
    "근로기준법 제20조는 근로계약 불이행에 대한 위약금을 미리 정하는 계약을 금지합니다.",
    "이 계약서 제8조 제1항이 여기에 해당합니다. 서명했더라도 그 부분은 효력이 없습니다.",
    "환산 시급이 2026년 최저임금 10,320원보다 시간당 약 2,170원 낮습니다.",
    "최저임금법 제6조 제3항에 따라 미달분은 무효이고 최저임금액이 적용됩니다.",
    "포괄임금 약정 자체가 위법은 아닙니다. 실제 연장근로가 고정분을 넘는지 확인해야 합니다.",
    "상시 근로자 4명 사업장이라 근로기준법 제60조가 적용되지 않습니다.",
    "법 위반 여부의 최종 판단은 근로감독관·노무사·법원이 합니다.",
    "위법이라고 단정할 수는 없습니다. 관할 고용노동청에서 확인해 보세요.",
    "근로자퇴직급여 보장법 제8조에 따라 퇴직금 분할약정은 무효입니다.",
    "근로기준법 제114조에 따라 500만원 이하의 벌금 대상입니다.",
    "위약금 조항은 3건, 확인이 필요한 항목은 2건입니다.",
    "1주 소정근로시간 40시간을 기준으로 월 208.6시간으로 환산했습니다.",
    "기간제법 제4조는 2년을 초과해 사용하면 무기계약 근로자로 본다고 정합니다.",
    "남녀고용평등법 제11조 제2항에 따라 그러한 약정은 무효입니다.",
]


def main() -> None:
    failed = []
    print("차단되어야 하는 문장")
    for text, want_rule in BLOCK:
        verdict = guard.inspect(text)
        rules = [h["rule"] for h in verdict.hits]
        ok = verdict.blocked and want_rule in rules
        print(f"  {'OK ' if ok else '실패'} {text[:44]:<46} {','.join(rules) or '-'}")
        if not ok:
            failed.append(f"차단 실패 [{want_rule}] {text} → {rules}")

    print("\n통과해야 하는 문장 (오탐 검사 — 이쪽이 더 중요합니다)")
    for text in ALLOW:
        verdict = guard.inspect(text)
        rules = [h["rule"] for h in verdict.hits]
        ok = not verdict.blocked
        print(f"  {'OK ' if ok else '실패'} {text[:44]:<46} {','.join(rules) or '-'}")
        if not ok:
            failed.append(f"오탐 {text} → {rules}")

    # 판정에 없는 조문을 끌어오면 경고만 남깁니다 (차단하지는 않습니다).
    warn = guard.inspect("근로기준법 제60조에 따라 연차가 발생합니다.", verdict_laws={"근기법 제20조"})
    out_of_verdict = [h["rule"] for h in warn.hits]
    ok = "law_out_of_verdict" in out_of_verdict
    print(f"\n판정 범위 밖 조문 경고 — {'OK' if ok else '실패'} {out_of_verdict}")
    if not ok:
        failed.append("law_out_of_verdict 경고가 나오지 않았습니다")

    total = len(BLOCK) + len(ALLOW) + 1
    print(f"\n총 {total}건 · 실패 {len(failed)}건")
    for message in failed:
        print(f"  - {message}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
