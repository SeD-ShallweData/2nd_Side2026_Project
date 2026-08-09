"""더미 계약서 3종의 기대 판정 고정.

    .venv/bin/python tests/test_contract_samples.py

`scripts/make_contract_samples.py`가 만드는 PDF 3종을 **사람이 손으로 읽어 채운**
추출 결과가 여기 있습니다. LLM도 Document Parse도 부르지 않습니다.

무엇을 지키는 테스트인가
- 시연에서 보여줄 세 갈래(빨강 / 초록 / 노랑)가 규칙 엔진에서 실제로 갈리는지
- 규칙을 고쳤을 때 **정상 계약서에 빨강이 생기지 않는지** — 오탐이 가장 무섭습니다
- 5인 미만(경계 샘플)에서 적용 제외가 제대로 동작하는지

여기 적힌 값이 PDF 본문과 어긋나면 안 됩니다. 계약서 문구를 고치면 이 파일도 함께 고칩니다.
실제 추출이 이 값과 얼마나 맞는지는 `scripts/check_contract_api.py`로 확인합니다.
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("API_KEY_ENV_FILE", "/nonexistent-for-tests.env")

from app.contract import rules, schema  # noqa: E402

YEAR = 2026


def build(**over) -> dict:
    """normalize()를 통과시켜 실제 파이프라인과 같은 모양으로 만듭니다."""
    return schema.normalize(over)


# ── ① 정상 — 샘플A건설 (상시 42명) ────────────────────────────────────
NORMAL = build(
    employer_name="샘플A건설 주식회사", worker_name="홍길동", headcount=42,
    job_title="건축 시공 관리 및 공정 관리 업무",
    work_place="인천광역시 서구 가정로 123",
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
    probation={"exists": True, "months": 3, "wage_rate": 0.9},
    severance={"provided": True, "included_in_wage": False},
    insurance={"employment": True, "health": True, "pension": True, "accident": True},
    required_items={k: True for k in schema.REQUIRED_ITEMS},
    clauses=[], copy_given=True, signed_date="2026-02-25",
)

# ── ② 부당 — 예시C물류 (상시 28명, 6개월 기간제) ──────────────────────
UNFAIR = build(
    employer_name="예시C물류", worker_name="김근로", headcount=28,
    job_title="상하차 및 분류", work_place="회사가 지정하는 물류센터",
    contract_type="fixed_term", term_start="2026-03-02", term_end="2026-09-01",
    wage={"type": "monthly", "amount": 2_000_000, "base_amount": 1_700_000,
          "fixed_ot_amount": 300_000, "fixed_ot_hours": None, "inclusive": True,
          "pay_day": "익월 10일", "pay_method": None, "components_itemized": False},
    hours={"daily_hours": 10, "weekly_hours": 40, "weekly_overtime_hours": 20,
           "break_minutes": 30, "start_time": "08:00", "end_time": "19:00",
           "workdays_per_week": None, "night_work": None},
    holiday={"weekly_holiday_paid": False, "public_holiday_paid": False,
             "annual_leave_granted": False},
    probation={"exists": True, "months": 6, "wage_rate": 0.7},
    severance={"provided": True, "included_in_wage": True},
    # "4대보험은 사원의 요청이 있는 경우에 한하여 가입한다" — 조건부라 가입/미가입이
    # 문면으로 갈리지 않습니다. null 로 두고 clauses 의 `other` 로 넘겨 🟡 로 안내합니다.
    # (미가입 명시일 때의 판정은 tests/test_contract_rules.py 의 산재보험 케이스가 지킵니다)
    insurance={"employment": None, "health": None, "pension": None, "accident": None},
    required_items={"wage_components": True, "wage_calculation": False,
                    "wage_payment": True, "scheduled_hours": True,
                    "weekly_holiday": False, "annual_leave": False,
                    "work_place_and_duty": True},
    clauses=[
        {"code": "penalty_predetermined",
         "quote": "사원이 계약기간을 채우지 못하고 중도 퇴사하는 경우 교육비 및 채용 비용 "
                  "명목으로 금 3,000,000원을 회사에 배상한다."},
        {"code": "wage_offset",
         "quote": "사원의 과실로 회사에 손해가 발생한 경우 그 손해액을 매월 급여에서 공제할 수 있다."},
        {"code": "at_will_dismissal",
         "quote": "회사는 경영상 필요하다고 인정하는 경우 사전 예고 없이 언제든지 "
                  "본 계약을 해지할 수 있다."},
        {"code": "severance_waived",
         "quote": "퇴직금은 매월 지급하는 임금에 포함하여 지급하는 것으로 하며, "
                  "퇴직 시 별도로 청구할 수 없다."},
        {"code": "other",
         "quote": "4대보험은 사원의 요청이 있는 경우에 한하여 가입한다."},
    ],
    copy_given=False, signed_date="2026-02-27",
)

# ── ③ 경계 — 데모B제조 (상시 4명) ─────────────────────────────────────
BORDERLINE = build(
    employer_name="데모B제조", worker_name="이성실", headcount=4,
    job_title="사출 성형기 조작 및 품질 검사",
    work_place="경기도 화성시 향남읍",
    contract_type="permanent", term_start="2026-04-01", term_end=None,
    wage={"type": "monthly", "amount": 2_500_000, "base_amount": 2_200_000,
          "fixed_ot_amount": 300_000, "fixed_ot_hours": None, "inclusive": True,
          "pay_day": "매월 25일", "pay_method": "근로자 명의 계좌",
          "components_itemized": True},
    hours={"daily_hours": 8, "weekly_hours": 40, "weekly_overtime_hours": None,
           "break_minutes": 60, "start_time": "08:00", "end_time": "17:00",
           "workdays_per_week": 5, "night_work": True},
    holiday={"weekly_holiday_paid": True, "public_holiday_paid": False,
             "annual_leave_granted": None},
    probation={"exists": True, "months": 3, "wage_rate": 0.9},
    severance={"provided": True, "included_in_wage": False},
    insurance={"employment": True, "health": True, "pension": True, "accident": True},
    required_items={"wage_components": True, "wage_calculation": True,
                    "wage_payment": True, "scheduled_hours": True,
                    "weekly_holiday": True, "annual_leave": None,
                    "work_place_and_duty": True},
    clauses=[
        {"code": "duty_change_broad",
         "quote": "사업주는 업무상 필요가 있는 경우 근로자의 업무 내용과 근무 장소를 변경할 수 있다."},
        {"code": "unpaid_training",
         "quote": "교대 인수인계를 위한 조회 시간(15분)은 근로시간에 포함하지 아니한다."},
        {"code": "noncompete",
         "quote": "근로자는 퇴직일로부터 1년간 동종 업계에 취업하거나 동종 영업을 하지 아니한다."},
        {"code": "damages_actual",
         "quote": "근로자가 고의 또는 중대한 과실로 회사에 손해를 입힌 경우 "
                  "실제 발생한 손해를 배상한다."},
    ],
    copy_given=True, signed_date="2026-03-20",
)


SCENARIOS = [
    {
        "name": "① 정상 — 샘플A건설",
        "contract": NORMAL,
        "violations": set(),                      # 정확히 이것만 (빈 집합 = 하나도 없어야 함)
        "expect_ok": {"min_wage", "weekly_holiday", "annual_leave", "severance",
                      "required_items", "break", "insurance", "probation"},
    },
    {
        "name": "② 부당 — 예시C물류",
        "contract": UNFAIR,
        "violations": {
            "min_wage_below",            # 산입 170만 ÷ 208.6h = 8,150원 < 10,320원
            "probation_over_3m",         # 수습 6개월 감액
            "probation_rate_low",        # 70%
            "probation_short_term",      # 계약 6개월(1년 미만)
            "daily_hours_over",          # 1일 10시간
            "overtime_over_12h",         # 주 연장 20시간
            "break_short",               # 8시간 초과에 휴게 30분
            "no_weekly_holiday",         # 주휴수당 별도 미지급
            "no_annual_leave",           # 연차 미부여
            "public_holiday_unpaid",     # 공휴일 무급 (28명이라 적용)
            "severance_in_wage",         # 퇴직금 월급 포함
            # severance_waived 는 같은 사실을 조항 인용으로 다시 잡은 것이라
            # rules._dedupe() 가 severance_in_wage 로 흡수합니다 (_SUPERSEDES).
            "missing_required",          # 임금 계산방법·주휴일·연차 미기재
            "copy_not_given",            # 1부만 작성해 회사 보관
            "penalty_predetermined",     # 위약금 300만원
            "wage_offset",               # 급여 공제
            "at_will_dismissal",         # 예고 없는 해지
        },
        "expect_check_at_least": {
            "fixed_ot_hours_unclear",
            "other",                     # 조건부 4대보험 — 문면으로 갈리지 않아 🟡
        },
    },
    {
        "name": "③ 경계 — 데모B제조 (상시 4명)",
        "contract": BORDERLINE,
        "violations": set(),
        "expect_check_at_least": {
            "fixed_ot_hours_unclear",    # 고정연장수당의 시간 수 미기재
            "annual_leave_missing",      # 연차 조항 없음 (미기재이지 배제가 아님)
            "noncompete", "damages_actual", "duty_change_broad", "unpaid_training",
        },
        "expect_excluded": {"public_holiday_unpaid"},   # 상시 4명 → 제55조② 적용 제외
    },
]


def codes(result: dict, level: str) -> set[str]:
    return {f["code"] for f in result["findings"] if f["level"] == level}


def main() -> None:
    failed = []
    for scenario in SCENARIOS:
        result = rules.evaluate(scenario["contract"], YEAR)
        got_violation = codes(result, rules.VIOLATION)
        got_check = codes(result, rules.CHECK)
        got_excluded = codes(result, rules.EXCLUDED)

        print(f"\n{scenario['name']}")
        print(f"  {result['headline']}")
        print(f"  🔴 {sorted(got_violation) or '없음'}")
        print(f"  🟡 {sorted(got_check) or '없음'}")
        print(f"  ⚪ {sorted(got_excluded) or '없음'}")

        want = scenario["violations"]
        if got_violation != want:
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
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
