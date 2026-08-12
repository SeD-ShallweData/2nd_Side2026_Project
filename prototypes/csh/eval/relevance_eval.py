"""검색 관련성 필터링 평가.

검색 결과에 무관한 조문이 섞이는 질문만 골라, 답변이 그것을 끌어다 쓰는지 잰다.
판정은 규칙으로만 한다(심판 LLM 없음) — 프롬프트를 고쳐도 채점 기준이 흔들리지 않게.

    python3 relevance_eval.py before
    python3 relevance_eval.py after
    python3 relevance_eval.py compare
"""
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

OUT = Path(__file__).parent / "results"
OUT.mkdir(exist_ok=True)
CHAT_URL = os.getenv("PRODUCT_URL", "http://127.0.0.1:3001").rstrip("/") + "/api/chat"

# forbidden: 이 질문에 답할 때 나올 이유가 없는 제도. 검색 결과에 섞여 들어온 것들이다.
CASES = [
    {
        "id": "wage-final",
        "q": "퇴사했는데 마지막 달 월급을 안 줘요. 어떻게 해야 하나요?",
        "mode": "wage",
        "forbidden": ["구직급여", "실업급여", "출산전후휴가", "육아휴직", "취업촉진"],
        "note": "검색에 고용보험법 제57조(지급되지 아니한 구직급여)가 섞임",
    },
    {
        "id": "overtime",
        "q": "야근수당을 안 주는데 얼마를 받아야 하나요?",
        "mode": "wage",
        "forbidden": ["휴업수당", "연차", "유급휴가"],
        "note": "검색에 제46조(휴업수당)·제60조(연차)가 섞임",
    },
    {
        "id": "weekly-holiday",
        "q": "주휴수당은 어떤 조건에서 받나요?",
        "mode": "wage",
        "forbidden": ["출산전후휴가", "휴업수당", "구직급여", "연차"],
        "note": "정답(제55조)이 검색되지 않고 무관 조문만 올라옴",
    },
    {
        "id": "severance",
        "q": "퇴직금을 못 받았어요",
        "mode": "wage",
        "forbidden": ["구직급여", "실업급여", "출산전후휴가", "취업촉진"],
        "note": "검색에 고용보험법 제57조가 섞임",
    },
    {
        "id": "payslip",
        "q": "임금명세서를 안 주는데 받을 수 있나요?",
        "mode": "wage",
        "forbidden": ["구직급여", "실업급여", "취업촉진"],
        "note": "검색에 고용보험법 제68조(취업촉진 수당)가 섞임",
    },
    {
        "id": "minimum-wage",
        "q": "최저임금보다 적게 받고 있어요",
        "mode": "wage",
        "forbidden": ["구직급여", "실업급여", "출산전후휴가"],
        "note": "대조군에 가까움 — 검색이 비교적 깨끗",
    },
    {
        "id": "annual-leave",
        "q": "연차를 안 쓰면 돈으로 받을 수 있나요?",
        "mode": "general",
        "forbidden": ["구직급여", "실업급여", "출산전후휴가", "휴업수당"],
        "note": "대조군 — 검색이 깨끗하다. 정상 답변이 망가지지 않는지 본다",
    },
    {
        "id": "no-match",
        "q": "회사가 망했는데 밀린 월급을 받을 수 있나요?",
        "mode": "wage",
        "forbidden": ["구직급여", "실업급여", "출산전후휴가"],
        "expect_no_match": True,
        "note": "검색 실패 경로 — 조항을 지어내지 않는지 본다",
    },
]

LAW_NAMES = [
    "남녀고용평등과 일ㆍ가정 양립 지원에 관한 법률", "근로자퇴직급여 보장법", "근로기준법 시행령",
    "임금채권보장법", "고용보험법", "최저임금법", "근로기준법",
]
CITATION = re.compile(
    rf"(?:「\s*)?(?:{'|'.join(LAW_NAMES)})(?:\s*」)?\s*제\s*\d+\s*조(?:의\s*\d+)?")


def ask(case):
    body = json.dumps({
        "message": case["q"], "chat_mode": case["mode"], "recent_messages": [],
    }).encode()
    req = urllib.request.Request(CHAT_URL, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as res:
        return json.loads(res.read())


def score(case, result):
    answer = result["answer"]
    hits = sorted({w for w in case["forbidden"] if w in answer})
    citations = sorted({c.replace(" ", "").replace("「", "").replace("」", "")
                        for c in CITATION.findall(answer)})
    return {
        "provider": result["provider"],
        "status": result["status"],
        "rag_status": result["trace"]["rag_status"],
        "guardrail_hits": result["trace"]["guardrail_hits"],
        "forbidden_hits": hits,
        "citations": citations,
        "answer_chars": len(answer),
        "answer": answer,
    }


def run(label):
    rows = []
    for case in CASES:
        try:
            payload = ask(case)
        except Exception as exc:
            print(f"  {case['id']}: 호출 실패 {exc}")
            continue
        for result in payload.get("results", []):
            row = score(case, result)
            row["case"] = case["id"]
            rows.append(row)
            flag = "⚠" if row["forbidden_hits"] else " "
            print(f" {flag} {case['id']:15} {row['provider']:8} "
                  f"rag={row['rag_status']:10} 무관={row['forbidden_hits'] or '없음'} "
                  f"인용={len(row['citations'])}개")
    (OUT / f"{label}.json").write_text(
        json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    total = len(rows)
    bad = sum(1 for r in rows if r["forbidden_hits"])
    print(f"\n[{label}] 응답 {total}건 중 무관 주제 언급 {bad}건 "
          f"({bad / total * 100:.0f}%)" if total else "결과 없음")
    return rows


def compare():
    before = json.loads((OUT / "before.json").read_text(encoding="utf-8"))
    after = json.loads((OUT / "after.json").read_text(encoding="utf-8"))
    index = {(r["case"], r["provider"]): r for r in before}
    print(f"{'케이스':16} {'모델':8} {'개선전':>10} {'개선후':>10}")
    b_bad = a_bad = 0
    for row in after:
        prev = index.get((row["case"], row["provider"]))
        if not prev:
            continue
        b_bad += bool(prev["forbidden_hits"])
        a_bad += bool(row["forbidden_hits"])
        mark = ""
        if prev["forbidden_hits"] and not row["forbidden_hits"]:
            mark = "  ✅ 해소"
        elif not prev["forbidden_hits"] and row["forbidden_hits"]:
            mark = "  ❌ 악화"
        print(f"{row['case']:16} {row['provider']:8} "
              f"{str(prev['forbidden_hits'] or '없음'):>10} "
              f"{str(row['forbidden_hits'] or '없음'):>10}{mark}")
    print(f"\n무관 주제 언급: {b_bad}건 → {a_bad}건 (전체 {len(after)}건)")


if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else "before"
    if action == "compare":
        compare()
    else:
        run(action)
