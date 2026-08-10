"""근로계약서 규칙 엔진 회귀 테스트.

    .venv/bin/python tests/test_contract_rules.py

pytest 없이 그냥 실행됩니다. LLM도 네트워크도 쓰지 않습니다 —
규칙 엔진은 순수 함수라 같은 입력이면 항상 같은 판정이 나와야 하고,
그 성질을 확인하는 것이 이 테스트의 목적입니다.

**새 규칙을 넣을 때는 OK 케이스도 반드시 추가하세요.**
정상 계약서를 위반이라고 말하는 규칙은 없느니만 못합니다.
특히 5인 미만 사업장과 `null`(미기재) 처리를 빠뜨리기 쉽습니다.
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
# 규칙 엔진은 키가 필요 없습니다. 키 파일이 없는 환경에서도 돌게 합니다.
os.environ.setdefault("API_KEY_ENV_FILE", "/nonexistent-for-tests.env")

from app.contract import rules, schema, standards  # noqa: E402

YEAR = 2026
MIN_HOURLY = standards.MIN_WAGE[YEAR]["hourly"]      # 10,320원


def contract(**over) -> dict:
    """최소한으로 정상인 계약서. 케이스마다 필요한 필드만 덮어씁니다."""
    base = {
        "employer_name": "샘플A건설", "worker_name": "홍길동", "headcount": 42,
        "job_title": "건축 시공 관리", "work_place": "인천 서구 현장",
        "contract_type": "permanent", "term_start": "2026-03-02", "term_end": None,
        "wage": {"type": "monthly", "amount": 2_400_000, "base_amount": 2_400_000,
                 "fixed_ot_amount": None, "fixed_ot_hours": None,
                 "bonus_monthly": None, "welfare_monthly": None, "inclusive": None,
                 "pay_day": "매월 25일", "pay_method": "근로자 명의 계좌 이체",
                 "components_itemized": True},
        "hours": {"daily_hours": 8, "weekly_hours": 40, "weekly_overtime_hours": None,
                  "break_minutes": 60, "start_time": "08:00", "end_time": "17:00",
                  "workdays_per_week": 5, "night_work": False},
        "holiday": {"weekly_holiday_paid": True, "public_holiday_paid": True,
                    "annual_leave_granted": True},
        "probation": {"exists": False, "months": None, "wage_rate": None},
        "severance": {"provided": True, "included_in_wage": False},
        "insurance": {"employment": True, "health": True, "pension": True, "accident": True},
        "required_items": {k: True for k in schema.REQUIRED_ITEMS},
        "clauses": [], "copy_given": True, "signed_date": "2026-02-25",
    }
    for key, value in over.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            base[key] = {**base[key], **value}
        else:
            base[key] = value
    return base


def codes(result: dict, level: str | None = None) -> set[str]:
    return {f["code"] for f in result["findings"]
            if level is None or f["level"] == level}


def run(name: str, contract_dict: dict, *, expect: set[str] = frozenset(),
        forbid: set[str] = frozenset(), level: str = rules.VIOLATION) -> tuple[bool, str]:
    """expect 는 반드시 나와야 할 code, forbid 는 나오면 안 될 code."""
    result = rules.evaluate(contract_dict, YEAR)
    got = codes(result, level)
    missing, extra = expect - got, forbid & got
    if missing or extra:
        parts = []
        if missing:
            parts.append(f"누락 {sorted(missing)}")
        if extra:
            parts.append(f"오탐 {sorted(extra)}")
        return False, f"{name}: {' · '.join(parts)} (실제 {level}: {sorted(got)})"
    return True, name


CASES: list[tuple] = []


def case(name, contract_dict, **kw):
    CASES.append((name, contract_dict, kw))


# ── 정상 계약서 — 위반이 하나도 나오면 안 됩니다 ──────────────────────
case("정상 계약서에는 위반이 없다", contract(),
     forbid={"min_wage_below", "no_annual_leave", "severance_waived", "break_short",
             "missing_required", "copy_not_given", "weekly_hours_over"})

case("정상 계약서는 최저임금 OK", contract(),
     expect={"min_wage"}, level=rules.OK)

# ── 최저임금 ──────────────────────────────────────────────────────────
# 월 2,000,000 ÷ 208.6h = 9,588원 < 10,320원
case("월급이 최저임금 미달", contract(wage={"amount": 2_000_000, "base_amount": 2_000_000}),
     expect={"min_wage_below"})

# 월 2,156,880 ÷ 208.6h = 10,340원 ≥ 10,320원
case("고시 월 환산액이면 통과", contract(wage={"amount": 2_156_880, "base_amount": 2_156_880}),
     forbid={"min_wage_below"})

# 240만원 중 고정연장 40만원은 산입 제외 → 200만원 ÷ 208.6 = 9,588원
case("고정연장수당은 최저임금에 산입되지 않는다",
     contract(wage={"amount": 2_400_000, "base_amount": 2_000_000,
                    "fixed_ot_amount": 400_000, "fixed_ot_hours": 20, "inclusive": True}),
     expect={"min_wage_below"})

case("시급이 최저임금 미달", contract(wage={"type": "hourly", "amount": 9_800}),
     expect={"min_wage_below"})

case("시급이 최저임금 이상", contract(wage={"type": "hourly", "amount": 11_000}),
     forbid={"min_wage_below"})

case("임금액을 못 읽으면 위반이 아니라 확인 필요",
     contract(wage={"amount": None, "base_amount": None}),
     expect={"min_wage"}, level=rules.CHECK)

case("소정근로시간이 없으면 최저임금은 확인 필요",
     contract(hours={"weekly_hours": None, "daily_hours": None, "workdays_per_week": None}),
     expect={"min_wage"}, level=rules.CHECK)

# ── 수습 ──────────────────────────────────────────────────────────────
case("수습 3개월 90%는 적법",
     contract(probation={"exists": True, "months": 3, "wage_rate": 0.9}),
     forbid={"probation_over_3m", "probation_rate_low", "probation_short_term"})

case("수습 6개월 감액은 기간 초과",
     contract(probation={"exists": True, "months": 6, "wage_rate": 0.9}),
     expect={"probation_over_3m"})

case("수습 70%는 감액률 미달",
     contract(probation={"exists": True, "months": 3, "wage_rate": 0.7}),
     expect={"probation_rate_low"})

case("1년 미만 계약은 수습 감액 불가",
     contract(contract_type="fixed_term", term_start="2026-03-02", term_end="2026-08-31",
              probation={"exists": True, "months": 3, "wage_rate": 0.9}),
     expect={"probation_short_term"})

case("단순노무업무는 수습 감액 불가",
     contract(job_title="매장 서빙 및 주방보조",
              probation={"exists": True, "months": 3, "wage_rate": 0.9}),
     expect={"probation_simple_labor"})

case("감액 없는 수습 6개월은 확인 필요",
     contract(probation={"exists": True, "months": 6, "wage_rate": None}),
     expect={"probation_over_3m"}, level=rules.CHECK)

# ── 근로시간·휴게 ─────────────────────────────────────────────────────
case("주 52시간 소정근로는 초과",
     contract(hours={"weekly_hours": 52, "daily_hours": 10}),
     expect={"weekly_hours_over", "daily_hours_over"})

case("연장 20시간 약정은 한도 초과",
     contract(hours={"weekly_overtime_hours": 20}),
     expect={"overtime_over_12h"})

case("연장 12시간 약정은 적법",
     contract(hours={"weekly_overtime_hours": 12}),
     forbid={"overtime_over_12h", "weekly_total_over"})

case("8시간 근무에 휴게 30분은 부족",
     contract(hours={"break_minutes": 30}),
     expect={"break_short"})

case("휴게 미기재는 확인 필요",
     contract(hours={"break_minutes": None}),
     expect={"break_missing"}, level=rules.CHECK)

# ── 휴일·연차·퇴직금 ──────────────────────────────────────────────────
case("연차 미부여 명시는 위반",
     contract(holiday={"annual_leave_granted": False}), expect={"no_annual_leave"})

case("연차 미기재는 확인 필요",
     contract(holiday={"annual_leave_granted": None}),
     expect={"annual_leave_missing"}, level=rules.CHECK)

case("주휴 무급 명시는 위반",
     contract(holiday={"weekly_holiday_paid": False}), expect={"no_weekly_holiday"})

case("퇴직금 미지급 명시는 위반",
     contract(severance={"provided": False}), expect={"severance_waived"})

case("퇴직금 월급 포함은 위반",
     contract(severance={"provided": True, "included_in_wage": True}),
     expect={"severance_in_wage"})

# ── 5인 미만 사업장 — 오탐 방지의 핵심 ────────────────────────────────
case("5인 미만이면 연차 미부여는 적용 제외",
     contract(headcount=4, holiday={"annual_leave_granted": False}),
     forbid={"no_annual_leave"})

case("5인 미만이어도 주휴수당은 적용된다",
     contract(headcount=4, holiday={"weekly_holiday_paid": False}),
     expect={"no_weekly_holiday"})

case("5인 미만이어도 퇴직금은 적용된다",
     contract(headcount=4, severance={"provided": False}),
     expect={"severance_waived"})

case("5인 미만이어도 최저임금은 적용된다",
     contract(headcount=4, wage={"amount": 1_800_000, "base_amount": 1_800_000}),
     expect={"min_wage_below"})

case("상시 근로자 수 미기재면 연차 미부여는 확인 필요로 낮춘다",
     contract(headcount=None, holiday={"annual_leave_granted": False}),
     forbid={"no_annual_leave"})

case("상시 근로자 수 미기재는 확인 필요로 표시된다",
     contract(headcount=None), expect={"headcount_unknown"}, level=rules.CHECK)

# ── 4대보험 ───────────────────────────────────────────────────────────
case("산재보험 미가입 명시는 위반",
     contract(insurance={"accident": False}), expect={"no_accident_insurance"})

case("고용보험만 빠지면 확인 필요",
     contract(insurance={"employment": False}),
     expect={"insurance_excluded"}, level=rules.CHECK)

case("보험 항목을 모르면 판정하지 않는다",
     contract(insurance={k: None for k in
                         ("employment", "health", "pension", "accident")}),
     forbid={"no_accident_insurance", "insurance_excluded"})

# ── 제17조 서면 명시 ──────────────────────────────────────────────────
case("필수 항목 누락은 위반",
     contract(required_items={"annual_leave": False, "weekly_holiday": False}),
     expect={"missing_required"})

case("항목을 모른다고 해서 누락은 아니다",
     contract(required_items={k: None for k in schema.REQUIRED_ITEMS}),
     forbid={"missing_required"})

case("교부 안 함 명시는 위반",
     contract(copy_given=False), expect={"copy_not_given"})

# ── 조항 기반 ─────────────────────────────────────────────────────────
case("위약금 예정 조항은 위반",
     contract(clauses=[{"code": "penalty_predetermined",
                        "quote": "중도 퇴사 시 교육비 300만원을 배상한다.", "note": None}]),
     expect={"penalty_predetermined"})

case("실손해 배상 조항은 확인 필요에 그친다",
     contract(clauses=[{"code": "damages_actual",
                        "quote": "고의 또는 중과실로 발생한 실제 손해를 배상한다.", "note": None}]),
     forbid={"damages_actual"})

case("경업금지는 확인 필요",
     contract(clauses=[{"code": "noncompete",
                        "quote": "퇴직 후 1년간 동종업계에 취업하지 않는다.", "note": None}]),
     expect={"noncompete"}, level=rules.CHECK)

case("임금 상계 조항은 위반",
     contract(clauses=[{"code": "wage_offset",
                        "quote": "손해 발생 시 급여에서 공제한다.", "note": None}]),
     expect={"wage_offset"})

case("혼인 퇴직 예정은 위반",
     contract(clauses=[{"code": "marriage_retirement",
                        "quote": "혼인 시 퇴직하는 것으로 한다.", "note": None}]),
     expect={"marriage_retirement"})

case("5인 미만이면 임의해고 조항은 적용 제외",
     contract(headcount=3, clauses=[{"code": "at_will_dismissal",
                                     "quote": "회사가 필요하다고 인정하면 해고할 수 있다.",
                                     "note": None}]),
     forbid={"at_will_dismissal"})

# ── 포괄임금 ──────────────────────────────────────────────────────────
case("시간 수 없는 고정연장수당은 확인 필요",
     contract(wage={"amount": 2_600_000, "base_amount": 2_200_000,
                    "fixed_ot_amount": 400_000, "fixed_ot_hours": None, "inclusive": True}),
     expect={"fixed_ot_hours_unclear"}, level=rules.CHECK)

case("시간 수 있는 고정연장수당은 확인 필요(내용만 다름)",
     contract(wage={"amount": 2_600_000, "base_amount": 2_200_000,
                    "fixed_ot_amount": 400_000, "fixed_ot_hours": 20, "inclusive": True}),
     expect={"inclusive_wage"}, level=rules.CHECK)

# ── 결정성 ────────────────────────────────────────────────────────────
def test_deterministic() -> tuple[bool, str]:
    """같은 입력이면 같은 출력. 이 성질이 깨지면 상담 서비스로 쓸 수 없습니다."""
    sample = contract(wage={"amount": 1_900_000}, holiday={"annual_leave_granted": False},
                      clauses=[{"code": "penalty_predetermined", "quote": "위약금 200만원",
                                "note": None}])
    first = rules.evaluate(sample, YEAR)
    for _ in range(5):
        if rules.evaluate(sample, YEAR) != first:
            return False, "결정성: 같은 입력에서 다른 판정이 나왔습니다"
    return True, "결정성"


def test_normalize_keeps_null() -> tuple[bool, str]:
    """None(모름)이 False(없다고 적힘)로 바뀌면 오탐이 생깁니다."""
    got = schema.normalize({"holiday": {"annual_leave_granted": None},
                            "headcount": None, "wage": {}})
    if got["holiday"]["annual_leave_granted"] is not None:
        return False, "정규화: null 이 False 로 바뀌었습니다"
    if got["headcount"] is not None:
        return False, "정규화: headcount null 이 0 으로 바뀌었습니다"
    return True, "정규화 — null 보존"


def test_normalize_parses_korean() -> tuple[bool, str]:
    got = schema.normalize({
        "wage": {"amount": "2,400,000원", "type": "monthly"},
        "probation": {"exists": "있음", "months": "3개월", "wage_rate": "80%"},
        "term_start": "2026년 3월 2일",
    })
    checks = [
        (got["wage"]["amount"] == 2_400_000, "금액 파싱"),
        (got["probation"]["exists"] is True, "불리언 파싱"),
        (got["probation"]["wage_rate"] == 0.8, "비율 파싱"),
        (got["term_start"] == "2026-03-02", "날짜 파싱"),
    ]
    failed = [label for ok, label in checks if not ok]
    return (not failed), "정규화 — 한국어 표기" + (f" 실패: {failed}" if failed else "")


def test_no_law_invented() -> tuple[bool, str]:
    """규칙이 인용하는 조문이 전부 standards.LAWS 에 있는가."""
    sample = contract(headcount=None, wage={"amount": 1_500_000},
                      holiday={"annual_leave_granted": False, "weekly_holiday_paid": False,
                               "public_holiday_paid": False},
                      severance={"provided": False},
                      probation={"exists": True, "months": 6, "wage_rate": 0.7},
                      hours={"weekly_hours": 52, "daily_hours": 10, "break_minutes": 20,
                             "weekly_overtime_hours": 20},
                      required_items={"annual_leave": False},
                      copy_given=False, contract_type="fixed_term",
                      term_start="2026-01-01", term_end="2029-01-01",
                      clauses=[{"code": code, "quote": f"테스트 인용 {code}", "note": None}
                               for code in rules.CLAUSE_RULES])
    result = rules.evaluate(sample, YEAR)     # to_dict() 안에서 조문을 조회합니다
    used = {f["law"] for f in result["findings"] if f.get("law")}
    unknown = used - set(standards.LAWS)
    return (not unknown), "조문 인용" + (f" — 표에 없는 조문 {sorted(unknown)}" if unknown else "")


def test_verify_quotes() -> tuple[bool, str]:
    """원문에 없는 인용은 버려야 합니다.

    2026-08-08 실호출에서 모델이 조항 코드 표를 체크리스트로 훑어
    해당 없는 코드까지 전부 나열하고, quote 에 프롬프트의 표 설명문을 복사했습니다.
    정상 계약서가 위반 투성이가 되는 최악의 오탐이라 코드로 막습니다.
    """
    source = ("제8조 (손해배상) ① 사원이 계약기간을 채우지 못하고 중도 퇴사하는 경우 "
              "교육비 및 채용 비용 명목으로 금 3,000,000원을 회사에 배상한다.\n"
              "제11조 (계약서의 보관) 본 계약서는 1부를 작성하여 회사가 보관한다.")
    got, dropped = schema.verify_quotes({"clauses": [
        # ① 원문 그대로 — 남아야 합니다
        {"code": "penalty_predetermined",
         "quote": "교육비 및 채용 비용 명목으로 금 3,000,000원을 회사에 배상한다.", "note": None},
        # ② 공백·기호만 다름 — 남아야 합니다
        {"code": "other", "quote": "본 계약서는 1부를 작성하여  회사가 보관한다", "note": None},
        # ③ 프롬프트 표 설명문 복사 — 버려야 합니다
        {"code": "wage_offset",
         "quote": "손해액·대여금을 임금에서 공제·상계한다는 조항", "note": "해당 없음"},
        # ④ note 만 '해당 없음' — 버려야 합니다
        {"code": "forced_saving",
         "quote": "급여 일부를 회사가 적립·관리한다는 조항", "note": "해당 없음"},
        # ⑤ 원문에 없는 창작 — 버려야 합니다
        {"code": "marriage_retirement", "quote": "혼인 시 퇴직하는 것으로 한다.", "note": None},
    ]}, source)

    kept = {c["code"] for c in got["clauses"]}
    lost = {c["code"] for c in dropped}
    problems = []
    if kept != {"penalty_predetermined", "other"}:
        problems.append(f"남은 것 {sorted(kept)}")
    if lost != {"wage_offset", "forced_saving", "marriage_retirement"}:
        problems.append(f"버린 것 {sorted(lost)}")
    return (not problems), "인용 대조" + (f" — {' · '.join(problems)}" if problems else "")


def test_fabricated_clause_makes_no_violation() -> tuple[bool, str]:
    """창작된 조항이 통과하면 정상 계약서가 위반으로 판정됩니다. 끝까지 확인합니다."""
    source = "제5조 (휴일) 주휴일은 일요일로 하며 유급으로 한다."
    fabricated = contract(clauses=[
        {"code": "penalty_predetermined", "quote": "위약금·손해배상액을 미리 정한 조항",
         "note": "해당 없음"},
        {"code": "wage_offset", "quote": "손해액을 임금에서 공제하는 조항", "note": "해당 없음"},
    ])
    cleaned, _ = schema.verify_quotes(fabricated, source)
    got = codes(rules.evaluate(cleaned, YEAR), rules.VIOLATION)
    bad = got & {"penalty_predetermined", "wage_offset"}
    return (not bad), "창작 조항 차단" + (f" — 통과해 버린 것 {sorted(bad)}" if bad else "")


def test_no_duplicate_findings() -> tuple[bool, str]:
    """같은 코드가 인용 있는 것과 없는 것으로 두 번 뜨면 위반 건수가 부풀려집니다."""
    sample = contract(
        holiday={"annual_leave_granted": False},
        clauses=[{"code": "no_annual_leave",
                  "quote": "연차유급휴가는 부여하지 아니한다.", "note": None}])
    rows = rules.evaluate(sample, YEAR)["findings"]
    dupes = [c for c in {f["code"] for f in rows}
             if sum(1 for f in rows if f["code"] == c) > 1]
    if dupes:
        return False, f"중복 판정 {sorted(dupes)}"
    # 남은 쪽은 원문 인용이 붙어 있어야 합니다.
    row = next(f for f in rows if f["code"] == "no_annual_leave")
    if not row.get("evidence"):
        return False, "중복 정리 후 원문 인용이 사라졌습니다"
    return True, "중복 판정 정리"


def test_headline_has_no_score() -> tuple[bool, str]:
    """한 줄 요약에 점수·등급이 섞이면 ADR-0001 위반입니다."""
    import re
    for sample in (contract(), contract(wage={"amount": 1_500_000}),
                   contract(holiday={"annual_leave_granted": None})):
        headline = rules.evaluate(sample, YEAR)["headline"]
        if re.search(r"\d+\s*점|[A-F]\s*등급|등급\s*[A-F]", headline):
            return False, f"요약에 점수·등급: {headline}"
    return True, "요약 — 점수·등급 없음"


EXTRA_TESTS = (test_deterministic, test_normalize_keeps_null, test_normalize_parses_korean,
               test_no_law_invented, test_verify_quotes,
               test_fabricated_clause_makes_no_violation, test_no_duplicate_findings,
               test_headline_has_no_score)


def main() -> None:
    print(f"근로계약서 규칙 엔진 — {YEAR}년 최저임금 시급 {MIN_HOURLY:,}원 기준\n")
    failed = []

    for name, contract_dict, kw in CASES:
        ok, message = run(name, contract_dict, **kw)
        print(f"  {'OK ' if ok else '실패'} {message}")
        if not ok:
            failed.append(message)

    print()
    for test in EXTRA_TESTS:
        ok, message = test()
        print(f"  {'OK ' if ok else '실패'} {message}")
        if not ok:
            failed.append(message)

    total = len(CASES) + len(EXTRA_TESTS)
    print(f"\n총 {total}건 · 실패 {len(failed)}건")
    for message in failed:
        print(f"  - {message}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
