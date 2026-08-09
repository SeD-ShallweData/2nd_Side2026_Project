#!/usr/bin/env python
"""근로계약서 진단 실호출 점검.

    .venv/bin/python scripts/check_contract_api.py                 # 더미 3종 전부
    .venv/bin/python scripts/check_contract_api.py --sample unfair # 하나만
    .venv/bin/python scripts/check_contract_api.py --explain       # 해설까지 (모델 비교)
    .venv/bin/python scripts/check_contract_api.py --file 내계약서.pdf
    .venv/bin/python scripts/check_contract_api.py --no-cache      # 캐시 무시하고 재파싱

무엇을 확인하는가
  ① Document Parse 가 실제로 붙고 한글을 읽어내는가
  ② 조항 추출(LLM)이 tests/test_contract_samples.py 의 **손으로 채운 기대값**과 얼마나 맞는가
  ③ 규칙 엔진 판정이 기대한 세 갈래(빨강/초록/노랑)로 갈리는가
  ④ (--explain) 해설이 계약서 가드레일을 통과하는가

②가 이 스크립트의 핵심입니다. 규칙 엔진은 단위 테스트로 이미 고정돼 있으므로,
실제로 흔들리는 곳은 **모델이 계약서를 얼마나 정확히 읽어내는가** 하나뿐입니다.
어긋난 필드가 나오면 prompts/contract/extract.md 를 고칠 근거가 됩니다.
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tests"))

from app import config, llm  # noqa: E402
from app.contract import guard, parse, review, rules  # noqa: E402

OK, NG, WARN = "  OK ", "  실패", "  주의"

# 손으로 채운 기대 추출값. 테스트 파일과 한 벌로 씁니다 (두 곳에 적지 않습니다).
import test_contract_samples as expected  # noqa: E402

BY_ID = {"normal": expected.NORMAL, "unfair": expected.UNFAIR, "borderline": expected.BORDERLINE}
EXPECT_BY_ID = {
    "normal": expected.SCENARIOS[0],
    "unfair": expected.SCENARIOS[1],
    "borderline": expected.SCENARIOS[2],
}

# 추출 정확도를 볼 필드. 판정에 직접 쓰이는 것만 봅니다.
FIELDS = [
    ("headcount", lambda c: c["headcount"]),
    ("contract_type", lambda c: c["contract_type"]),
    ("wage.type", lambda c: c["wage"]["type"]),
    ("wage.amount", lambda c: c["wage"]["amount"]),
    ("wage.fixed_ot_amount", lambda c: c["wage"]["fixed_ot_amount"]),
    ("wage.fixed_ot_hours", lambda c: c["wage"]["fixed_ot_hours"]),
    ("hours.daily_hours", lambda c: c["hours"]["daily_hours"]),
    ("hours.weekly_hours", lambda c: c["hours"]["weekly_hours"]),
    ("hours.weekly_overtime_hours", lambda c: c["hours"]["weekly_overtime_hours"]),
    ("hours.break_minutes", lambda c: c["hours"]["break_minutes"]),
    ("holiday.weekly_holiday_paid", lambda c: c["holiday"]["weekly_holiday_paid"]),
    ("holiday.public_holiday_paid", lambda c: c["holiday"]["public_holiday_paid"]),
    ("holiday.annual_leave_granted", lambda c: c["holiday"]["annual_leave_granted"]),
    ("probation.months", lambda c: c["probation"]["months"]),
    ("probation.wage_rate", lambda c: c["probation"]["wage_rate"]),
    ("severance.provided", lambda c: c["severance"]["provided"]),
    ("severance.included_in_wage", lambda c: c["severance"]["included_in_wage"]),
    ("copy_given", lambda c: c["copy_given"]),
]


def samples(only: str | None) -> list[dict]:
    manifest = config.CONTRACT_SAMPLE_DIR / "manifest.json"
    if not manifest.exists():
        print(f"{NG} 더미 계약서가 없습니다. 먼저 실행하세요:\n"
              f"     .venv/bin/python scripts/make_contract_samples.py")
        sys.exit(1)
    items = json.loads(manifest.read_text(encoding="utf-8"))["samples"]
    return [s for s in items if only is None or s["id"] == only]


def compare_extraction(got: dict, want: dict) -> tuple[int, list[str]]:
    hits, misses = 0, []
    for label, pick in FIELDS:
        a, b = pick(got), pick(want)
        if a == b:
            hits += 1
        else:
            misses.append(f"{label}: 기대 {b!r} / 실제 {a!r}")
    return hits, misses


def compare_verdict(result: dict, spec: dict) -> tuple[list[str], list[str]]:
    """(실패, 경고) 로 나눕니다.

    심각도가 다릅니다. **🔴 오탐이 이 기능에서 가장 위험합니다** —
    멀쩡한 조항을 위반이라고 말하면 사용자가 회사와 다투게 됩니다.
    반면 🟡 은 "확인해 보세요" 안내라 한두 건 덜 잡히는 것은 모델 재현율 문제이고,
    실행마다 조금씩 달라집니다. 이것을 실패로 세면 신호가 묻힙니다.
    """
    def codes(level):
        return {f["code"] for f in result["findings"] if f["level"] == level}

    hard, soft = [], []
    got = codes(rules.VIOLATION)
    for code in sorted(got - spec["violations"]):
        hard.append(f"🔴 오탐 {code}  ← 정상 조항을 위반으로 판정")
    for code in sorted(spec["violations"] - got):
        hard.append(f"🔴 누락 {code}")
    for code in sorted(spec.get("expect_excluded", set()) - codes(rules.EXCLUDED)):
        hard.append(f"⚪ 누락 {code}")
    for code in sorted(spec.get("expect_check_at_least", set()) - codes(rules.CHECK)):
        soft.append(f"🟡 누락 {code}  (모델 재현율 — 실행마다 달라질 수 있음)")
    return hard, soft


def run_one(path: Path, spec: dict | None, want: dict | None,
            args) -> bool:
    print(f"\n{'=' * 64}\n{path.name}\n{'=' * 64}")
    data = path.read_bytes()

    # ① 문서 인식
    try:
        parsed = parse.parse_document(data, path.name, ocr=args.ocr,
                                      use_cache=not args.no_cache)
    except parse.ParseError as exc:
        print(f"{NG} Document Parse — {exc}")
        return False
    tag = "캐시" if parsed["cached"] else f"{parsed['elapsed_sec']}초"
    print(f"{OK} Document Parse  {parsed['pages']}쪽 · {len(parsed['markdown']):,}자 · {tag}")
    if args.verbose:
        print("\n--- 인식된 본문 (앞 600자) ---")
        print(parsed["markdown"][:600])
        print("--- ---\n")

    # ② 조항 추출
    try:
        extracted = review.extract_clauses(parsed)
    except (review.ReviewError, llm.LLMError) as exc:
        print(f"{NG} 조항 추출 — {exc}")
        return False
    contract = extracted["contract"]
    print(f"{OK} 조항 추출      {extracted['model']} · {extracted['elapsed_sec']}초 · "
          f"독소조항 후보 {len(contract['clauses'])}건")

    ok = True
    if want is not None:
        hits, misses = compare_extraction(contract, want)
        mark = OK if not misses else (WARN if hits >= len(FIELDS) - 3 else NG)
        print(f"{mark} 추출 정확도    {hits}/{len(FIELDS)} 필드 일치")
        for message in misses:
            print(f"       · {message}")
        # 추출은 모델 작업이라 몇 건 어긋날 수 있습니다. 실패로 세지 않고 경고만 냅니다.

    # ③ 판정
    verdict = rules.evaluate(contract)
    print(f"\n  {verdict['headline']}")
    for level, mark in ((rules.VIOLATION, "🔴"), (rules.CHECK, "🟡"),
                        (rules.OK, "🟢"), (rules.EXCLUDED, "⚪")):
        rows = [f for f in verdict["findings"] if f["level"] == level]
        if rows:
            print(f"  {mark} {len(rows)}건 — {', '.join(f['code'] for f in rows)}")

    if spec is not None:
        hard, soft = compare_verdict(verdict, spec)
        mark = NG if hard else (WARN if soft else OK)
        summary = ("기대와 일치" if not (hard or soft)
                   else " · ".join(filter(None, [f"불일치 {len(hard)}건" if hard else "",
                                                 f"경고 {len(soft)}건" if soft else ""])))
        print(f"{mark} 판정 대조      {summary}")
        for message in hard + soft:
            print(f"       · {message}")
        ok = ok and not hard

    # ④ 해설
    if args.explain:
        for provider in config.available_providers():
            try:
                got = review.explain(verdict, contract, provider)
            except llm.LLMError as exc:
                print(f"{NG} 해설 {provider:8s} {exc}")
                ok = False
                continue
            blocked = got["guardrail"]["blocked"]
            mark = NG if blocked else OK
            print(f"{mark} 해설 {provider:8s} {got['model']} · {got['elapsed_sec']}초 · "
                  f"{len(got['text']):,}자"
                  + (f" · 가드레일 {[h['rule'] for h in got['guardrail']['hits']]}"
                     if blocked else ""))
            if args.verbose or blocked:
                print("\n" + got["text"][:1200] + "\n")
            ok = ok and not blocked

    return ok


def main() -> None:
    ap = argparse.ArgumentParser(description="근로계약서 진단 실호출 점검")
    ap.add_argument("--sample", choices=["normal", "unfair", "borderline", "unfair-scan"],
                    help="더미 계약서 하나만 점검")
    ap.add_argument("--file", type=Path, help="임의의 파일로 점검 (기대값 대조는 생략)")
    ap.add_argument("--explain", action="store_true", help="해설까지 생성해 가드레일을 확인")
    ap.add_argument("--ocr", default="auto", choices=["auto", "force"])
    ap.add_argument("--no-cache", action="store_true", help="파싱 캐시를 쓰지 않습니다")
    ap.add_argument("-v", "--verbose", action="store_true", help="인식 본문·해설 전문을 출력")
    args = ap.parse_args()

    if not config.PROVIDERS["upstage"]["api_key"]:
        print(f"{NG} Upstage API 키가 없습니다. {config.TEAM_ENV_FILE} 확인 필요")
        sys.exit(1)

    print(f"Document Parse  {parse.PARSE_URL}  model={parse.PARSE_MODEL}")
    print(f"조항 추출        {config.CONTRACT_EXTRACT_PROVIDER}")
    print(f"파싱 캐시        {'끔' if args.no_cache else config.CONTRACT_CACHE_DIR}")
    print(f"가드레일 조문표  {sum(len(v) for v in guard.KNOWN_ARTICLES.values())}개 조문 허용")

    results = []
    if args.file:
        results.append(run_one(args.file, None, None, args))
    else:
        for item in samples(args.sample):
            path = config.CONTRACT_SAMPLE_DIR / item["file"]
            base = item["id"].replace("-scan", "")
            results.append(run_one(path, EXPECT_BY_ID.get(base), BY_ID.get(base), args))

    print("\n" + "=" * 64)
    if all(results):
        print("모두 기대대로 동작합니다.")
    else:
        print("기대와 다른 항목이 있습니다. 위 로그를 확인하세요.")
        print("  · 추출이 틀렸다면 → prompts/contract/extract.md")
        print("  · 판정이 틀렸다면 → app/contract/rules.py + tests/test_contract_rules.py")
        sys.exit(1)


if __name__ == "__main__":
    main()
