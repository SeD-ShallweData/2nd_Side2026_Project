#!/usr/bin/env python3
"""계약서 조항 추출 정확도 측정 — 새 계약서 유형.

    export API_KEY_ENV_FILE=~/.secrets/api_key.env
    python3 eval/contract_extract.py --case free_form     # 한 건만
    python3 eval/contract_extract.py                      # 전부
    python3 eval/contract_extract.py --score              # 저장된 결과 재채점 (호출 없음)

**LLM을 호출합니다.** 공용 API 키를 쓰므로 팀 시연 시간대를 피하고 돌리기 전에
공유하세요. 계약서 한 건당 **호출 1회**입니다.

## 무엇을 재는가

진단은 4층입니다.

    ① PDF·사진  → Document Parse → 마크다운
    ② 마크다운  → LLM            → 조항 JSON     ← 여기를 잽니다
    ③ 조항 JSON → 규칙 엔진       → 판정
    ④ 판정      → LLM            → 해설

③은 [tests/test_contract_boundary.py](../tests/test_contract_boundary.py) 가 호출 0회로
고정합니다. ①은 스캔 화질 문제라 별도 과제입니다. **실제로 흔들리는 곳은 ②** 이고,
②가 값을 잘못 읽으면 ③은 그 값으로 완벽하게 판정합니다. 규칙 엔진 테스트로는
절대 안 잡힙니다.

여기서는 계약서 본문을 마크다운으로 직접 넣어 ②만 분리해 잽니다. Document Parse 를
건너뛰므로 호출이 절반이고, 파싱 품질이 결과를 흐리지 않습니다.

## 판정은 규칙으로만 합니다

기대값은 아래 CASES 에 사람이 손으로 적었습니다. 심판 LLM 을 쓰지 않습니다.
응답 원문을 results/ 에 저장하므로 `--score` 로 호출 없이 다시 채점할 수 있고,
채점 규칙을 고쳐도 before/after 가 다른 잣대로 비교되지 않습니다.
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CONTRACT_API = ROOT / "product" / "integrations" / "contract-api"
sys.path.insert(0, str(CONTRACT_API))

RESULTS = Path(__file__).resolve().parent / "results"

# ── 계약서 본문과 기대 추출값 ─────────────────────────────────────────
# 본문은 Document Parse 가 뱉는 마크다운을 흉내 냅니다.
# 이름은 docs/50-더미데이터.md 3절을 따릅니다 — 샘플/데모/예시 접두어, 실존 기업 연상 금지.

FREE_FORM = """\
근로계약서

예시E디자인(이하 "회사")과 박근로(이하 "직원")는 아래와 같이 근로계약을 맺는다.

1. 직원은 2026년 3월 2일부터 회사에서 그래픽 디자인 업무를 담당하며,
   근무 장소는 인천광역시 연수구 예시대로 55번지 회사 사무실로 한다.
   계약기간은 따로 정하지 않는다.

2. 근무시간은 오전 9시 30분부터 오후 6시 30분까지이며 점심시간 1시간을 제외하면
   하루 8시간, 주 5일 근무로 한 주 40시간이다.

3. 급여는 월 260만원으로 하고 매월 25일에 직원 명의 계좌로 이체한다.
   급여에는 고정연장수당 30만원이 포함되어 있으며 이는 월 12시간분에 해당한다.

4. 입사 후 3개월은 수습으로 하고 이 기간 급여는 위 금액의 90%를 지급한다.

5. 주휴일은 일요일로 하며 유급으로 한다. 관공서 공휴일도 유급으로 쉰다.
   연차유급휴가는 근로기준법에 따라 부여한다.

6. 퇴직급여는 관련 법령에 따라 지급한다.

7. 4대보험(고용·건강·국민연금·산재)에 모두 가입한다.

8. 현재 회사에서 상시적으로 일하는 사람은 12명이다.

위 내용을 확인하고 각자 서명하여 1부씩 나누어 갖는다.

2026년 2월 26일

회사: 예시E디자인    직원: 박근로
"""

FREE_FORM_EXPECT = {
    "headcount": 12,
    "contract_type": "permanent",
    "wage.type": "monthly",
    "wage.amount": 2_600_000,
    "wage.fixed_ot_amount": 300_000,
    "wage.fixed_ot_hours": 12,
    "hours.weekly_hours": 40,
    "hours.daily_hours": 8,
    "hours.break_minutes": 60,
    "probation.months": 3,
    "probation.wage_rate": 0.9,
    "holiday.weekly_holiday_paid": True,
    "holiday.public_holiday_paid": True,
    "holiday.annual_leave_granted": True,
    "severance.provided": True,
    # 이 계약서는 임금 총액과 고정연장수당만 적고 기본급 구성·계산방법이 없다.
    # 근기법 제17조 서면 명시 의무 미충족이며, 모델이 이를 정확히 읽어내는지 본다.
    "required_items.wage_components": False,
    "required_items.wage_calculation": False,
    "required_items.wage_payment": True,
    "required_items.scheduled_hours": True,
}

BOUNDARY = """\
표 준 근 로 계 약 서

데모F식품(이하 "사업주")과 최근로(이하 "근로자")는 다음과 같이 근로계약을 체결한다.

제1조 (근로계약기간) 2026년 3월 2일부터 2027년 3월 1일까지로 한다.

제2조 (근무장소) 인천광역시 부평구 예시로 200

제3조 (업무의 내용) 식품 포장 및 검수

제4조 (소정근로시간) 09:00부터 18:00까지 (휴게시간 12:00~13:00, 60분)
                     1주 소정근로시간 40시간, 주 5일 근무

제5조 (임금)
  1. 월 급여: 2,152,400원
  2. 지급일: 매월 말일
  3. 지급방법: 근로자 명의 예금통장에 입금
  4. 임금은 기본급으로만 구성하며 고정연장수당은 없다.

제6조 (수습) 입사일부터 3개월간을 수습기간으로 하며, 수습기간 중 임금은
             제5조 금액의 100%를 지급한다.

제7조 (휴일) 주휴일은 매주 일요일로 하며 유급으로 한다.
             관공서 공휴일은 유급휴일로 한다.

제8조 (연차유급휴가) 근로기준법이 정하는 바에 따라 부여한다.

제9조 (퇴직급여) 근로자퇴직급여 보장법에 따라 지급한다.

제10조 (사회보험) 고용보험, 건강보험, 국민연금, 산재보험에 모두 가입한다.

제11조 (상시 근로자 수) 이 사업장의 상시 근로자는 8명이다.

2026년 2월 25일   사업주 데모F식품   근로자 최근로
"""

BOUNDARY_EXPECT = {
    "headcount": 8,
    "contract_type": "fixed_term",
    "wage.type": "monthly",
    "wage.amount": 2_152_400,
    "wage.fixed_ot_amount": None,
    "hours.weekly_hours": 40,
    "hours.break_minutes": 60,
    "probation.months": 3,
    "probation.wage_rate": 1.0,
    "holiday.weekly_holiday_paid": True,
    "holiday.annual_leave_granted": True,
    "severance.provided": True,
    # "임금은 기본급으로만 구성" 이라고 적었지만 모델은 wage_components 를 False 로 읽는다.
    # 계산방법(어떻게 산출되는지)은 실제로 없다. 아래 관찰 참고.
    "required_items.wage_calculation": False,
    "required_items.wage_payment": True,
}

SHORT_TERM = """\
기간제 근로계약서

샘플G카페(이하 "사업주")와 정근로(이하 "근로자")는 다음과 같이 계약한다.

제1조 (계약기간) 2026년 3월 2일부터 2027년 2월 1일까지 (11개월)

제2조 (근무장소 및 업무) 인천광역시 미추홀구 예시길 7, 매장 응대 및 음료 제조

제3조 (근로시간) 1주 3일, 1일 5시간 근무로 1주 소정근로시간은 15시간이다.
                 휴게시간은 1일 30분으로 한다.

제4조 (임금) 시급 10,400원, 매월 10일 지급, 근로자 명의 계좌 이체

제5조 (수습) 최초 2개월을 수습기간으로 하고, 이 기간의 시급은 위 금액의 90%로 한다.

제6조 (휴일) 주휴일은 유급으로 부여한다.

제7조 (연차) 근로기준법에 따라 부여한다.

제8조 (퇴직금) 계약기간이 1년 미만이므로 퇴직금은 지급하지 아니한다.

제9조 (사회보험) 고용보험 및 산재보험에 가입한다.

제10조 (상시 근로자) 이 사업장의 상시 근로자는 4명이다.

2026년 2월 20일   사업주 샘플G카페   근로자 정근로
"""

SHORT_TERM_EXPECT = {
    "headcount": 4,
    "contract_type": "fixed_term",
    "wage.type": "hourly",
    "wage.amount": 10_400,
    "hours.weekly_hours": 15,
    "hours.daily_hours": 5,
    "hours.workdays_per_week": 3,
    "hours.break_minutes": 30,
    "probation.months": 2,
    "probation.wage_rate": 0.9,
    "severance.provided": False,
}

CASES = {
    "free_form": {
        "label": "A 자유 양식 — 조항 번호·항목명이 표준서식과 다름",
        "text": FREE_FORM,
        "expect": FREE_FORM_EXPECT,
        # 상시 12명. 본문에 임금 구성항목·계산방법이 없어 제17조 미충족이 나온다.
        # 서식이 자유롭다고 없는 위반이 생기지는 않는지가 이 케이스의 핵심이다.
        "expect_violation": {"missing_required"},
        "expect_check_at_least": {"inclusive_wage"},
    },
    "boundary": {
        "label": "B 값의 경계 — 최저임금 미달 경계 아래(2,152,400원)",
        "text": BOUNDARY,
        "expect": BOUNDARY_EXPECT,
        "expect_violation": {"min_wage_below", "missing_required"},
    },
    "short_term": {
        "label": "C 근무기간 — 11개월 · 주 15시간 · 수습 감액 · 퇴직금 미지급 명시",
        "text": SHORT_TERM,
        "expect": SHORT_TERM_EXPECT,
        # 1년 미만 계약의 수습 감액 + 퇴직금 미지급 약정
        "expect_violation": {"probation_short_term", "severance_waived"},
    },
}


def dig(data: dict, path: str):
    """'wage.amount' 처럼 점으로 이어진 경로를 따라갑니다."""
    node = data
    for key in path.split("."):
        if not isinstance(node, dict):
            return None
        node = node.get(key)
    return node


def run_case(name: str, case: dict) -> dict:
    from app.contract import review

    parsed = {"markdown": case["text"], "pages": 1}
    started = time.monotonic()
    extracted = review.extract_clauses(parsed)
    return {
        "case": name,
        "label": case["label"],
        "elapsed_sec": round(time.monotonic() - started, 2),
        "provider": extracted["provider"],
        "model": extracted["model"],
        "usage": extracted.get("usage", {}),
        "not_a_contract": extracted["not_a_contract"],
        "contract": extracted["contract"],
        "dropped_clauses": extracted.get("dropped_clauses"),
    }


def score(record: dict, case: dict) -> dict:
    from app.contract import rules

    contract = record["contract"]
    field_rows = []
    for path, want in case["expect"].items():
        got = dig(contract, path)
        ok = got == want
        # 0.9 와 90 처럼 표기만 다른 경우를 구분해 적습니다.
        field_rows.append({"field": path, "want": want, "got": got, "ok": ok})

    verdict = rules.evaluate(contract, 2026)
    levels = {level: {f["code"] for f in verdict["findings"] if f["level"] == level}
              for level in (rules.VIOLATION, rules.CHECK, rules.OK, rules.EXCLUDED)}

    want_violation = case["expect_violation"]
    got_violation = levels[rules.VIOLATION]
    verdict_problems = (
        [f"🔴 누락 {c}" for c in sorted(want_violation - got_violation)]
        + [f"🔴 오탐 {c}" for c in sorted(got_violation - want_violation)]
        + [f"🟡 누락 {c}" for c in sorted(
            case.get("expect_check_at_least", set()) - levels[rules.CHECK])]
    )

    matched = sum(1 for row in field_rows if row["ok"])
    return {
        "fields": field_rows,
        "field_matched": matched,
        "field_total": len(field_rows),
        "violation": sorted(got_violation),
        "check": sorted(levels[rules.CHECK]),
        "excluded": sorted(levels[rules.EXCLUDED]),
        "verdict_problems": verdict_problems,
    }


def report(record: dict, case: dict) -> bool:
    result = score(record, case)
    print(f"\n{'=' * 66}")
    print(f"{record['label']}")
    print(f"  {record['provider']} · {record['model']} · {record['elapsed_sec']}초")
    if record["not_a_contract"]:
        print("  ✗ 계약서로 인식하지 못했습니다.")
        return False

    print(f"\n  추출 정확도 {result['field_matched']}/{result['field_total']}")
    for row in result["fields"]:
        if not row["ok"]:
            print(f"    ✗ {row['field']:32} 기대 {row['want']!r} · 실제 {row['got']!r}")

    print(f"\n  🔴 {result['violation'] or '없음'}")
    print(f"  🟡 {result['check'] or '없음'}")
    print(f"  ⚪ {result['excluded'] or '없음'}")
    if result["verdict_problems"]:
        print("\n  판정 불일치")
        for problem in result["verdict_problems"]:
            print(f"    ✗ {problem}")

    return (result["field_matched"] == result["field_total"]
            and not result["verdict_problems"])


def main() -> None:
    ap = argparse.ArgumentParser(description="계약서 조항 추출 정확도 측정")
    ap.add_argument("--case", choices=sorted(CASES), help="한 건만 실행")
    ap.add_argument("--score", action="store_true",
                    help="저장된 결과를 다시 채점만 합니다 (LLM 호출 없음)")
    args = ap.parse_args()

    names = [args.case] if args.case else list(CASES)
    RESULTS.mkdir(exist_ok=True)

    if not args.score and not os.getenv("API_KEY_ENV_FILE"):
        print("API_KEY_ENV_FILE 이 없습니다. 키 파일 경로를 지정하세요.", file=sys.stderr)
        print("  export API_KEY_ENV_FILE=~/.secrets/api_key.env", file=sys.stderr)
        sys.exit(2)

    passed, failed = [], []
    for name in names:
        path = RESULTS / f"extract-{name}.json"
        if args.score:
            if not path.exists():
                print(f"{name}: 저장된 결과가 없습니다 ({path})", file=sys.stderr)
                failed.append(name)
                continue
            record = json.loads(path.read_text(encoding="utf-8"))
        else:
            record = run_case(name, CASES[name])
            path.write_text(json.dumps(record, ensure_ascii=False, indent=2),
                            encoding="utf-8")

        (passed if report(record, CASES[name]) else failed).append(name)

    print(f"\n{'=' * 66}")
    print(f"총 {len(names)}건 · 전항목 통과 {len(passed)}건 · 불일치 {len(failed)}건")
    if failed:
        print(f"  불일치: {', '.join(failed)}")
    print(f"\n응답 원문은 {RESULTS} 에 있습니다. --score 로 호출 없이 다시 채점합니다.")


if __name__ == "__main__":
    main()
