"""추가 계약서 유형의 기대 판정 고정 — 값의 경계 · 근무기간 · 적용 제외.

    .venv/bin/python tests/test_contract_boundary.py

[eval/CONTRACT_E2E.md](../eval/CONTRACT_E2E.md) 의 유형 B·C·D 를 규칙 엔진에 직접
넣습니다. LLM 도 Document Parse 도 부르지 않습니다. 유형 A(자유 양식)는 추출 계층을
보는 것이라 여기서 다루지 않습니다.

기존 [test_contract_samples.py](test_contract_samples.py) 는 시연용 3종이 서로 갈리는지
봅니다. 이 파일은 **판정이 뒤집히는 경계**를 1원·1%·1명 단위로 고정합니다. 경계는
규칙을 고칠 때 가장 조용히 어긋나는 곳입니다.

관측된 차이는 GAPS 에 따로 적고 실패로 세지 않습니다. 법 해석이 필요하거나 담당이
다른 것이라 코드로 단정하지 않습니다.
"""

import os
import sys
from pathlib import Path

CONTRACT_API = (Path(__file__).resolve().parents[3]
                / "product" / "integrations" / "contract-api")
sys.path.insert(0, str(CONTRACT_API))
os.environ.setdefault("API_KEY_ENV_FILE", "/nonexistent-for-tests.env")

from app.contract import rules, schema, standards  # noqa: E402

YEAR = 2026
MIN_HOURLY = standards.MIN_WAGE[YEAR]["hourly"]            # 10,320원
MONTHLY_209 = standards.MIN_WAGE[YEAR]["monthly_209"]      # 2,156,880원
ENGINE_MONTHLY_HOURS = standards.monthly_scheduled_hours(40)   # 208.6시간


def build(**over) -> dict:
    return schema.normalize(over)


# 위반이 하나도 없는 기준 계약서. 여기서 한 항목씩만 바꿔 경계를 만듭니다.
BASE = dict(
    employer_name="샘플D상사 주식회사", worker_name="이근로", headcount=42,
    job_title="사무 관리 업무", work_place="인천광역시 남동구 예시로 10",
    contract_type="permanent", term_start="2026-03-02", term_end=None,
    wage={"type": "monthly", "amount": 2_400_000, "base_amount": 2_400_000,
          "fixed_ot_amount": None, "fixed_ot_hours": None, "inclusive": False,
          "pay_day": "매월 25일", "pay_method": "근로자 명의 예금계좌",
          "components_itemized": True},
    hours={"daily_hours": 8, "weekly_hours": 40, "weekly_overtime_hours": None,
           "break_minutes": 60, "start_time": "09:00", "end_time": "18:00",
           "workdays_per_week": 5, "night_work": False},
    holiday={"weekly_holiday_paid": True, "public_holiday_paid": True,
             "annual_leave_granted": True},
    probation={"exists": False, "months": None, "wage_rate": None},
    severance={"provided": True, "included_in_wage": False},
    insurance={"employment": True, "health": True, "pension": True, "accident": True},
    required_items={k: True for k in schema.REQUIRED_ITEMS},
    clauses=[], copy_given=True, signed_date="2026-02-25",
)


def variant(**over) -> dict:
    """BASE 에서 지정한 항목만 바꿉니다. dict 항목은 병합합니다."""
    merged = {k: (dict(v) if isinstance(v, dict) else v) for k, v in BASE.items()}
    for key, value in over.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key].update(value)
        else:
            merged[key] = value
    return build(**merged)


def fixed_term(months: int) -> dict:
    """계약기간 개월 수를 term_start/term_end 로 표현합니다.

    종료일을 시작일과 **같은 날짜**로 둡니다. schema.term_months 가
    (종료일 - 시작일) / 30 을 더하는 방식이라, 실무에서 흔한 "전날 종료" 표기
    (3/2 ~ 이듬해 3/1)를 쓰면 11.97개월이 되어 의도한 경계를 못 잽니다.
    그 차이 자체는 observed_gaps() 에서 따로 봅니다.
    """
    year, month = 2026, 3 + months
    end_year, end_month = year + (month - 1) // 12, (month - 1) % 12 + 1
    return {"contract_type": "fixed_term", "term_start": "2026-03-02",
            "term_end": f"{end_year}-{end_month:02d}-02"}


# ── 유형 B — 값의 경계 ────────────────────────────────────────────────
# 엔진은 월급을 monthly_scheduled_hours(=208.6h) 로 나눕니다. 209h 가 아닙니다.
# 미달 판정 경계는 (최저시급 - 1원) × 208.6 = 2,152,543원 입니다.
ENGINE_FLOOR_MONTHLY = round((MIN_HOURLY - 1) * ENGINE_MONTHLY_HOURS)

B = [
    {
        "name": "B1 고시 월환산액 정확히 (2,156,880원)",
        "contract": variant(wage={"amount": MONTHLY_209, "base_amount": MONTHLY_209}),
        "violations": set(),
        "expect_ok": {"min_wage"},
    },
    {
        "name": f"B2 엔진 경계 바로 위 ({ENGINE_FLOOR_MONTHLY + 100:,}원)",
        "contract": variant(wage={"amount": ENGINE_FLOOR_MONTHLY + 100,
                                  "base_amount": ENGINE_FLOOR_MONTHLY + 100}),
        "violations": set(),
        "expect_ok": {"min_wage"},
    },
    {
        "name": f"B3 엔진 경계 바로 아래 ({ENGINE_FLOOR_MONTHLY - 200:,}원)",
        "contract": variant(wage={"amount": ENGINE_FLOOR_MONTHLY - 200,
                                  "base_amount": ENGINE_FLOOR_MONTHLY - 200}),
        "violations": {"min_wage_below"},
    },
    {
        "name": "B4 수습 3개월 90% · 계약 12개월",
        "contract": variant(probation={"exists": True, "months": 3, "wage_rate": 0.9},
                            **fixed_term(12)),
        "violations": set(),
        "expect_ok": {"probation"},
    },
    {
        "name": "B5 수습 3개월 89% · 계약 12개월",
        "contract": variant(probation={"exists": True, "months": 3, "wage_rate": 0.89},
                            **fixed_term(12)),
        "violations": {"probation_rate_low"},
    },
    {
        "name": "B6 수습 4개월 90% · 계약 12개월",
        "contract": variant(probation={"exists": True, "months": 4, "wage_rate": 0.9},
                            **fixed_term(12)),
        "violations": {"probation_over_3m"},
    },
    {
        "name": "B7 수습 4개월 · 감액 없음",
        "contract": variant(probation={"exists": True, "months": 4, "wage_rate": None}),
        "violations": set(),
        "expect_check_at_least": {"probation_over_3m"},
    },
    {
        "name": "B8 상시 5명 · 연차 미부여",
        "contract": variant(headcount=5, holiday={"annual_leave_granted": False}),
        "violations": {"no_annual_leave"},
    },
    {
        "name": "B9 상시 4명 · 연차 미부여",
        "contract": variant(headcount=4, holiday={"annual_leave_granted": False}),
        "violations": set(),
        "expect_excluded": {"no_annual_leave"},
    },
]

# ── 유형 C — 근무기간에 따라 달라지는 것 ──────────────────────────────
C = [
    {
        "name": "C1 계약 11개월 · 수습 3개월 90%",
        "contract": variant(probation={"exists": True, "months": 3, "wage_rate": 0.9},
                            **fixed_term(11)),
        "violations": {"probation_short_term"},
    },
    {
        "name": "C2 계약 12개월 · 수습 3개월 90%",
        "contract": variant(probation={"exists": True, "months": 3, "wage_rate": 0.9},
                            **fixed_term(12)),
        "violations": set(),
        "expect_ok": {"probation"},
    },
    {
        "name": "C3 주 14시간 (퇴직금 조항 있음)",
        "contract": variant(hours={"weekly_hours": 14, "daily_hours": 5,
                                   "workdays_per_week": 3, "break_minutes": 60}),
        "violations": set(),
        "expect_check_at_least": {"severance_hours_threshold"},
    },
    {
        "name": "C4 계약 30개월",
        "contract": variant(**fixed_term(30)),
        "violations": set(),
        "expect_check_at_least": {"fixed_term_over_2y"},
    },
    {
        "name": "C5 계약 11개월 · 퇴직금 미지급 명시",
        "contract": variant(severance={"provided": False, "included_in_wage": False},
                            **fixed_term(11)),
        "violations": {"severance_waived"},
    },
]

# ── 유형 D — 적용 제외를 명시한 계약서 ────────────────────────────────
D = [
    {
        "name": "D1 상시 4명 · 연차 미부여 명시",
        "contract": variant(headcount=4, holiday={"annual_leave_granted": False}),
        "violations": set(),
        "expect_excluded": {"no_annual_leave"},
    },
    {
        # 주휴일(제55조①)은 EXCLUDED_UNDER_5 에 없다. 5인 미만도 적용된다.
        # 여기서 ⚪ 가 나오면 거짓 음성이고, 받아야 할 돈을 못 받게 된다.
        "name": "D2 상시 4명 · 주휴수당 미지급 명시",
        "contract": variant(headcount=4, holiday={"weekly_holiday_paid": False}),
        "violations": {"no_weekly_holiday"},
    },
    {
        # 인원을 안 적었다고 5인 이상으로 가정하면 안 된다.
        "name": "D3 인원 미기재 · 연차 미부여 명시",
        "contract": variant(headcount=None, holiday={"annual_leave_granted": False}),
        "violations": set(),
        "expect_check_at_least": {"no_annual_leave", "headcount_unknown"},
    },
    {
        "name": "D4 상시 4명 · 해고 자유 조항",
        "contract": variant(headcount=4, clauses=[
            {"code": "at_will_dismissal",
             "quote": "회사는 필요하다고 인정하는 경우 사전 예고 없이 본 계약을 해지할 수 있다."}]),
        "violations": set(),
        "expect_excluded": {"at_will_dismissal"},
    },
]

SCENARIOS = B + C + D


# ── 관측된 차이 — 실패로 세지 않고 보고만 합니다 ──────────────────────
def observed_gaps() -> list[str]:
    gaps: list[str] = []

    # ① 최저임금 월 환산 시간: 엔진 208.6h vs 고용노동부 고시 209h
    lower, upper = ENGINE_FLOOR_MONTHLY, MONTHLY_209
    probe = (lower + upper) // 2
    result = rules.evaluate(variant(wage={"amount": probe, "base_amount": probe}), YEAR)
    engine_says = {f["code"] for f in result["findings"] if f["level"] == rules.VIOLATION}
    if "min_wage_below" not in engine_says:
        gaps.append(
            f"최저임금 환산 시간 — 엔진은 {ENGINE_MONTHLY_HOURS}시간으로 나누고 고시 월환산액은 "
            f"209시간 기준입니다. 월급 {lower:,}~{upper:,}원 구간(약 {upper - lower:,}원)에서 "
            f"고시 기준으로는 미달인데 엔진은 통과시킵니다. "
            f"예: 월급 {probe:,}원 → 고시 209h 환산 시급 {probe / 209:,.0f}원 "
            f"(최저 {MIN_HOURLY:,}원 미달)인데 판정은 통과입니다.")

    # ② standards.SEVERANCE_MIN_MONTHS 미사용 — C5 참고
    short = rules.evaluate(
        variant(severance={"provided": False, "included_in_wage": False}, **fixed_term(11)), YEAR)
    long = rules.evaluate(
        variant(severance={"provided": False, "included_in_wage": False}, **fixed_term(24)), YEAR)
    short_codes = {f["code"] for f in short["findings"] if f["level"] == rules.VIOLATION}
    long_codes = {f["code"] for f in long["findings"] if f["level"] == rules.VIOLATION}
    if short_codes == long_codes and "severance_waived" in short_codes:
        gaps.append(
            "퇴직금 미지급 약정 — 계약기간 11개월과 24개월의 판정이 같습니다. "
            "standards.SEVERANCE_MIN_MONTHS(계속근로 1년 이상)가 정의만 되어 있고 "
            "rule_severance 에서 쓰이지 않습니다. 1년 미만 계약에도 🔴 가 붙는 것이 "
            "의도인지 확인이 필요합니다(법 해석 문제).")

    # ③ 1년 계약의 표기 방식에 따라 수습 감액 판정이 갈림
    one_year = {
        "전날 종료 (2026-03-02 ~ 2027-03-01)":
            {"contract_type": "fixed_term", "term_start": "2026-03-02", "term_end": "2027-03-01"},
        "연 단위 (2026-01-01 ~ 2026-12-31)":
            {"contract_type": "fixed_term", "term_start": "2026-01-01", "term_end": "2026-12-31"},
    }
    blocked = []
    for label, term in one_year.items():
        result = rules.evaluate(
            variant(probation={"exists": True, "months": 3, "wage_rate": 0.9}, **term), YEAR)
        if "probation_short_term" in codes(result, rules.VIOLATION):
            blocked.append(label)
    if blocked and len(blocked) != len(one_year):
        months = {label: schema.term_months(term) for label, term in one_year.items()}
        gaps.append(
            "계약기간 계산 — 같은 1년 계약인데 표기 방식에 따라 수습 감액 판정이 갈립니다. "
            + " / ".join(f"{label} → {value}개월" for label, value in months.items())
            + f". {', '.join(blocked)} 쪽만 🔴 probation_short_term 이 붙습니다. "
            "schema.term_months 가 (종료일 - 시작일) / 30 을 더해서, 실무에서 가장 흔한 "
            "'전날 종료' 표기가 11.97개월이 됩니다. 종료일을 포함해 세지 않는 것이 원인입니다.")

    # ④ 가산수당(제56조) 조항 코드 없음
    if not any(spec.get("law") == "근기법 제56조"
               for spec in rules.CLAUSE_RULES.values()):
        gaps.append(
            "가산수당(근기법 제56조) 조항 코드가 schema.CLAUSE_CODES 에 없습니다. "
            "'가산수당을 지급하지 않는다' 조항은 other 로 떨어지고 other 는 법령 없는 🟡 이라, "
            "5인 이상 사업장에서도 🔴 가 되지 않습니다.")

    return gaps


def codes(result: dict, level: str) -> set[str]:
    return {f["code"] for f in result["findings"] if f["level"] == level}


def main() -> None:
    failed: list[str] = []

    for scenario in SCENARIOS:
        result = rules.evaluate(scenario["contract"], YEAR)
        got_violation = codes(result, rules.VIOLATION)
        got_check = codes(result, rules.CHECK)
        got_excluded = codes(result, rules.EXCLUDED)

        print(f"\n{scenario['name']}")
        print(f"  🔴 {sorted(got_violation) or '없음'}")
        print(f"  🟡 {sorted(got_check) or '없음'}")
        print(f"  ⚪ {sorted(got_excluded) or '없음'}")

        want = scenario["violations"]
        for code in sorted(want - got_violation):
            failed.append(f"{scenario['name']}: 🔴 누락 {code}")
        for code in sorted(got_violation - want):
            failed.append(f"{scenario['name']}: 🔴 오탐 {code}")
        for code in sorted(scenario.get("expect_ok", set()) - codes(result, rules.OK)):
            failed.append(f"{scenario['name']}: 🟢 누락 {code}")
        for code in sorted(scenario.get("expect_check_at_least", set()) - got_check):
            failed.append(f"{scenario['name']}: 🟡 누락 {code}")
        for code in sorted(scenario.get("expect_excluded", set()) - got_excluded):
            failed.append(f"{scenario['name']}: ⚪ 누락 {code}")

    print(f"\n총 {len(SCENARIOS)}개 시나리오 · 실패 {len(failed)}건")
    for message in failed:
        print(f"  - {message}")

    gaps = observed_gaps()
    if gaps:
        print(f"\n관측된 차이 {len(gaps)}건 — 실패로 세지 않습니다")
        for index, gap in enumerate(gaps, 1):
            print(f"  {index}. {gap}")

    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
