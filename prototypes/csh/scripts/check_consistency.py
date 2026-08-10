"""답변 일관성 측정.

    .venv/bin/python scripts/check_consistency.py
    .venv/bin/python scripts/check_consistency.py --runs 5 --provider skt
    .venv/bin/python scripts/check_consistency.py --ids wage-02,wage-03

같은 질문을 여러 번 던져 답변이 얼마나 흔들리는지 봅니다.
상담 서비스는 어제와 오늘의 답이 다르면 신뢰를 잃으므로,
프롬프트를 고칠 때마다 이 값이 나아졌는지 확인합니다.

**비트 단위로 같은 답변은 이 두 API로 불가능합니다.** 둘 다 seed를 받기만 하고 무시합니다.
그래서 글자 일치가 아니라 아래 세 가지를 봅니다.

  사실 일치  — 답변에 등장한 수치 집합이 매번 같은가 (가장 중요)
  구조 일치  — 정해진 골격의 각 항목이 매번 나오는가
  길이 편차  — 분량이 들쭉날쭉하지 않은가
"""

import argparse
import json
import re
import statistics
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import chat, config, llm, store  # noqa: E402

QUESTION_FILE = config.ROOT / "tests" / "questions.jsonl"

# 답변에 나온 **사실 수치**. 단위가 붙은 값과 연도만 셉니다.
# 목록 번호("1.", "2.")를 사실로 세면 지표가 거짓말을 합니다 — 2026-08-01에 그렇게 잡혔습니다.
_NUM = re.compile(
    r"\d[\d,]*(?:\.\d+)?\s*(?:%|명|개월|개월치|개|원|만원|억원|건|배|회|년|월|일)"
    r"|(?<!\d)(?:19|20)\d{2}(?!\d)")

# 골격이 지켜졌는지 보는 표지. questions.jsonl의 `shape` 필드로 지정합니다.
STRUCTURE = {
    "workplace": {
        "명단 등재 여부": r"명단",
        "관측 지표": r"가입자|고지금액|결측",
        "해석의 한계": r"뜻하지\s*[는도]?\s*않|의미하지\s*[는도]?\s*않|단정|예측한 결과가 아",
        "확인 체크리스트": r"확인해\s*[보두]|확인하세요|확인하시|물어보세요|권합니다",
        "기준 시점": r"기준[:：]|갱신",
    },
    "alert": {
        "등급과 수치": r"단계|건",
        "주요 신호": r"민원|신호",
        "범위 한정": r"전체를 묶|개별 사업장|특정 현장",
        "확인 항목": r"확인",
        "기준 표기": r"분위수|갱신|기준",
    },
}


def load_questions(ids: str | None) -> list[dict]:
    wanted = {i.strip() for i in ids.split(",")} if ids else None
    rows = []
    for line in QUESTION_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("//"):
            continue
        item = json.loads(line)
        if wanted and item.get("id") not in wanted:
            continue
        rows.append(item)
    return rows


def measure(answers: list[str], shape: str | None) -> dict:
    """한 질문에 대한 여러 답변의 흔들림을 잽니다.

    shape — 이 질문에 적용할 출력 골격 이름 (questions.jsonl의 `shape` 필드).
    비워 두면 골격 검사를 건너뜁니다. 골격이 적용되지 않는 질문
    (데이터 부족·모호한 질문)에까지 항목을 요구하면 지표가 거짓말을 합니다.
    """
    facts = [frozenset(_NUM.findall(a)) for a in answers]
    fact_agree = sum(1 for f in facts if f == facts[0]) / len(facts)

    markers = STRUCTURE.get(shape, {}) if shape else {}
    present = {
        name: sum(1 for a in answers if re.search(pat, a)) / len(answers)
        for name, pat in markers.items()
    }
    lengths = [len(a) for a in answers]

    return {
        "fact_agree": fact_agree,                     # 1.0이면 수치가 매번 동일
        "structure": present,                          # 항목별 등장률
        "structure_min": min(present.values()) if present else 1.0,
        "len_mean": statistics.mean(lengths),
        "len_cv": (statistics.pstdev(lengths) / statistics.mean(lengths)) if lengths else 0,
        "distinct": len({a.strip() for a in answers}),
        "blocked": 0,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=4, help="질문당 반복 횟수")
    parser.add_argument("--provider", help="특정 프로바이더만")
    parser.add_argument("--ids", help="질문 id 목록 (쉼표 구분)")
    parser.add_argument("--name", default="consistency", help="결과 파일 이름 접미어")
    args = parser.parse_args()

    providers = [args.provider] if args.provider else config.available_providers()
    questions = load_questions(args.ids)
    if not questions:
        raise SystemExit("실행할 질문이 없습니다.")

    total = len(questions) * len(providers) * args.runs
    print(f"질문 {len(questions)}개 × 모델 {len(providers)}개 × {args.runs}회 = {total}회 호출")
    print(f"temperature={config.DEFAULT_TEMPERATURE}\n")

    rows, summary = [], []
    for q in questions:
        print(f"── [{q.get('id')}] {q['question']}")
        for provider in providers:
            answers, blocked = [], 0
            for _ in range(args.runs):
                try:
                    r = chat.answer(q["question"], q["persona"], provider)
                    answers.append(r["text"])
                    blocked += bool(r.get("guardrail", {}).get("replaced"))
                except (llm.LLMError, KeyError) as exc:
                    print(f"   [{provider}] 실패: {exc}")
            if not answers:
                continue

            m = measure(answers, q.get("shape"))
            m["blocked"] = blocked
            summary.append((q.get("id"), provider, m))
            rows.append({"id": q.get("id"), "persona": q["persona"], "provider": provider,
                         "question": q["question"], "answers": answers, **m})

            miss = [n for n, v in m["structure"].items() if v < 1.0]
            print(f"   [{provider:8s}] 사실일치 {m['fact_agree']*100:3.0f}% · "
                  f"골격 {m['structure_min']*100:3.0f}% · 길이 {m['len_mean']:.0f}자(±{m['len_cv']*100:.0f}%)"
                  + (f" · 빠진 항목 {miss}" if miss else "")
                  + (f" · 차단 {blocked}회" if blocked else ""))
        print()

    path = store.save_eval(args.name, rows)
    fa = statistics.mean(s["fact_agree"] for _, _, s in summary)
    st = statistics.mean(s["structure_min"] for _, _, s in summary)
    cv = statistics.mean(s["len_cv"] for _, _, s in summary)
    blocked = sum(s["blocked"] for _, _, s in summary)

    print("=" * 62)
    print(f"사실 일치   {fa*100:5.1f}%   (1회차 답변의 수치 집합과 같은 비율)")
    print(f"골격 유지   {st*100:5.1f}%   (정해진 항목이 매번 나온 비율)")
    print(f"길이 편차   {cv*100:5.1f}%   (낮을수록 분량이 안정적)")
    print(f"가드레일 차단 {blocked}회")
    print(f"\n결과 저장: {path}")


if __name__ == "__main__":
    main()
