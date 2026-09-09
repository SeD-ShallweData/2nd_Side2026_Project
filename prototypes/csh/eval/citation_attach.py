"""법령 인용 부착 평가.

문제: Upstage 가 법령 내용을 서술하면서 근거 조문을 안 붙인다. SKT 는 대체로 붙인다.
프롬프트에 지시가 이미 있는데도 지켜지지 않아, 프롬프트를 고치기 전후로 같은 방식으로 잰다.

    python3 eval/citation_attach.py before
    # product/prompts/chat/system.md 수정
    python3 eval/citation_attach.py after
    python3 eval/citation_attach.py compare

## 왜 거리 0.35 미만만 쓰나

검색이 아슬아슬한 케이스를 섞으면 "인용을 안 붙인 것"과 "붙일 근거가 없었던 것"이
구분되지 않는다. rag-api 의 no_match 임계값은 0.42 이고 strong match 는 0.30 이다.
0.35 미만은 그 사이에서도 여유가 있는 구간이라, HB 가 임계값을 재조정해도 계속
matched 로 남는다. 즉 이 측정은 임계값 튜닝에 무효화되지 않는다.

케이스는 `band_check` 로 고른 뒤 아래에 고정했다. 매 실행마다 거리를 다시 재서
구간을 벗어난 케이스가 있으면 경고한다 — 조용히 다른 것을 재고 있지 않게.

## 무엇을 세나

판정은 규칙으로만 한다(심판 LLM 없음). 프롬프트를 고쳐도 채점 기준이 흔들리지
않게 하려는 것이다. **추적 가능성**과 **형식**을 나눠서 본다. 형식만 고쳐서
숫자가 좋아지는 것을 개선이라고 부르지 않으려는 것이다.

추적 가능성 — 답변 하나를 셋 중 하나로 분류한다.

    perclaim  법령을 서술한 문장 자체에 근거가 붙어 있다   ← 어느 주장이 어느 조문인지 보인다
    grouped   근거는 있으나 끝에 목록으로 몰려 있다        ("근거: 근로기준법 제46조")
    none      유효 인용이 전혀 없다                        ← 보고된 문제

같은 줄에서 문장 뒤에 붙은 근거는 `perclaim` 으로 본다. "…지급해야 합니다.
citation: 근로기준법 제46조" 는 형식이 틀렸을 뿐 그 문장의 근거이기 때문이다.
줄을 바꿔 맨 끝에 몰아 적은 것만 `grouped` 다.

형식 — `paren_citations` 는 괄호 안에 든 인용 수다. 프롬프트가 요구하는 형태다.

결함 — `literal_token` 은 `citation` 이라는 낱말 자체가 답변에 나온 횟수다.
프롬프트에 "citation을 그대로 괄호로 붙이세요"라고 적혀 있어서 모델이 필드 이름을
출력해 버린다. 실제로 관측됐다 — "연차 유급휴가는 다음과 같이 발생합니다 citation."

분류는 저장된 답변 원문에서 매번 다시 계산한다. 채점 규칙을 고치면 before 도 같이
다시 채점되므로, before 와 after 가 서로 다른 잣대로 비교되는 일이 없다.

유효 인용은 `product/src/server/guardrails.ts` 의 `LAW_NAMES` · 인용 정규식과
같은 기준을 쓴다. 벡터DB에 없는 법령을 인용하면 가드레일이 답변을 정책 baseline
으로 교체하므로, 교체된 답변(`guardrail_replaced`)은 모델의 말이 아니다.
분류 집계에서 빼고 따로 센다 — 인용을 늘리라고 압박해서 미검증 인용이 늘어나면
그것도 악화이기 때문이다.
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
RAG_URL = os.getenv("RAG_API_URL", "http://127.0.0.1:5051").rstrip("/") + "/api/retrieve"
BAND_MAX = float(os.getenv("STABLE_BAND_MAX", "0.35"))

# 안정 구간(top1 < 0.35) 케이스. distance 는 고정 시점의 실측값이고, 실행할 때마다
# 다시 재서 구간 이탈을 경고한다. top-1 조문이 질문 주제와 맞는 것만 골랐다 —
# 검색이 엉뚱하면 인용을 안 붙이는 게 오히려 맞는 동작이라 측정이 오염된다.
CASES = [
    {"id": "childcare-hours", "q": "육아기 근로시간 단축은 어떤 조건에서 쓸 수 있나요?", "mode": "general", "distance": 0.2175},
    {"id": "annual-leave-days", "q": "연차휴가는 며칠이나 생기나요?", "mode": "general", "distance": 0.2270},
    {"id": "avg-wage-exclude", "q": "평균임금을 계산할 때 빼는 기간이 따로 있나요?", "mode": "wage", "distance": 0.2277},
    {"id": "payslip-items", "q": "임금명세서에는 어떤 항목을 적어야 하나요?", "mode": "wage", "distance": 0.2310},
    {"id": "unemployment-req", "q": "실업급여를 받으려면 어떤 조건을 갖춰야 하나요?", "mode": "general", "distance": 0.2433},
    {"id": "daily-worker-wage", "q": "일용직 근로자의 평균임금은 어떻게 정하나요?", "mode": "wage", "distance": 0.2474},
    {"id": "harassment-report", "q": "직장 내 괴롭힘을 당했는데 어디에 신고하나요?", "mode": "general", "distance": 0.2774},
    {"id": "layoff-notice", "q": "해고하려면 며칠 전에 미리 알려줘야 하나요?", "mode": "general", "distance": 0.2898},
    {"id": "shutdown-pay", "q": "휴업수당은 어떤 기준으로 산출하나요?", "mode": "wage", "distance": 0.2879},
    {"id": "severance-limit", "q": "퇴직금은 몇 년 안에 청구해야 하나요?", "mode": "wage", "distance": 0.2941},
    {"id": "minwage-exempt", "q": "최저임금이 적용되지 않는 사람도 있나요?", "mode": "wage", "distance": 0.2963},
    {"id": "parttime-leave", "q": "알바도 연차가 생기나요?", "mode": "general", "distance": 0.3016},
    {"id": "shutdown-allowance", "q": "회사 사정으로 쉬었는데 그 기간 수당을 받을 수 있나요?", "mode": "wage", "distance": 0.3071},
    {"id": "under-five", "q": "5인 미만 사업장에도 근로기준법이 적용되나요?", "mode": "general", "distance": 0.3075},
    {"id": "break-time", "q": "짧게 일하는데 휴게시간을 줘야 하나요?", "mode": "general", "distance": 0.3133},
    {"id": "dismissal-reason", "q": "잘렸는데 이유를 안 알려줍니다", "mode": "general", "distance": 0.3169},
    {"id": "weekly-holiday", "q": "주휴일은 반드시 줘야 하는 건가요?", "mode": "wage", "distance": 0.3170},
    {"id": "unfair-dismissal", "q": "부당해고를 당한 것 같은데 어디에 물어보나요?", "mode": "general", "distance": 0.3276},
    {"id": "wage-subsidy-req", "q": "대지급금을 받으려면 어떤 요건을 갖춰야 하나요?", "mode": "wage", "distance": 0.3274},
    {"id": "overtime-rate", "q": "야근하면 수당을 얼마나 더 받아야 하나요?", "mode": "wage", "distance": 0.3305},
]

# guardrails.ts 의 LAW_NAMES 와 같아야 한다. 긴 이름을 먼저 둔다.
LAW_NAMES = [
    "남녀고용평등과 일ㆍ가정 양립 지원에 관한 법률", "근로자퇴직급여 보장법", "근로기준법 시행령",
    "임금채권보장법", "고용보험법", "최저임금법", "근로기준법",
]
CITATION = re.compile(
    rf"(?:「\s*)?(?:{'|'.join(LAW_NAMES)})(?:\s*」)?\s*제\s*\d+\s*조(?:의\s*\d+)?")
PAREN = re.compile(r"[(（][^)）]*[)）]")
# 한글 사이에 붙어 나오는 경우가 있어 단어 경계를 두지 않는다.
LITERAL_TOKEN = re.compile(r"citations?", re.IGNORECASE)


def post(url, payload, timeout):
    body = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read())


def check_band():
    """케이스가 아직 안정 구간에 있는지 확인한다. rag-api 만 호출 — LLM 비용 없음."""
    drifted = []
    for case in CASES:
        data = post(RAG_URL, {"query": case["q"], "limit": 5}, 120)
        top1 = data.get("top1_distance")
        status = data.get("status")
        if top1 is None or top1 >= BAND_MAX or status != "matched":
            drifted.append((case["id"], top1, status))
        case["measured_distance"] = round(top1, 4) if top1 is not None else None
        case["measured_status"] = status
    if drifted:
        print(f"⚠ 안정 구간(<{BAND_MAX})을 벗어난 케이스 {len(drifted)}건 — 결과 해석 주의")
        for case_id, top1, status in drifted:
            print(f"    {case_id:20} top1={top1} status={status}")
    else:
        print(f"✓ {len(CASES)}건 모두 안정 구간(<{BAND_MAX}) · matched 유지")
    return not drifted


SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")
ATTRIBUTION_WORD = re.compile(r"근거|출처|관련\s*법령|참고|citations?", re.IGNORECASE)
# 인용을 늘리라고 압박하다 답변이 조문 나열로 변해 버리지 않는지 함께 본다.
ACTION_PATH = re.compile(r"1350|노동위원회|노동청|근로감독관|진정|신고|고용노동부|확인하|문의하|준비하")


def _is_citation_only(segment):
    """조문 나열뿐인 조각인가. 본문 없이 근거만 적힌 줄을 가려낸다."""
    rest = CITATION.sub("", segment)
    rest = ATTRIBUTION_WORD.sub("", rest)
    rest = re.sub(r"[^가-힣]", "", rest)
    # 나열에 남는 "제116조, 제76조의2" 같은 꼬리는 '제/조' 몇 글자뿐이다.
    return len(rest) < 8


def classify(answer):
    """답변 하나를 perclaim / grouped / none 으로 나눈다."""
    paren_spans = [m.span() for m in PAREN.finditer(answer)]
    citations = list(CITATION.finditer(answer))
    paren_citations = [
        m.group() for m in citations
        if any(start <= m.start() and m.end() <= end for start, end in paren_spans)
    ]

    perclaim, grouped = [], []
    for line in answer.splitlines():
        if not CITATION.search(line):
            continue
        segments = SENTENCE_SPLIT.split(line.strip())
        # 같은 줄에 본문이 함께 있으면 그 줄의 근거는 그 주장에 붙은 것으로 본다.
        line_has_content = any(
            not _is_citation_only(segment) and re.search(r"[가-힣]", segment)
            for segment in segments
        )
        found = [m.group() for m in CITATION.finditer(line)]
        (perclaim if line_has_content else grouped).extend(found)

    if perclaim:
        kind = "perclaim"
    elif grouped:
        kind = "grouped"
    else:
        kind = "none"

    def normalize(items):
        return sorted({c.replace(" ", "").replace("「", "").replace("」", "") for c in items})

    return {
        "kind": kind,
        "perclaim_citations": normalize(perclaim),
        "grouped_citations": normalize(grouped),
        "paren_citations": len(paren_citations),
        "literal_token": len(LITERAL_TOKEN.findall(answer)),
        "has_action_path": bool(ACTION_PATH.search(answer)),
    }


def score(case, result):
    answer = result["answer"]
    row = {
        "case": case["id"],
        "provider": result["provider"],
        "status": result["status"],
        "rag_status": result["trace"]["rag_status"],
        "guardrail_hits": result["trace"]["guardrail_hits"],
        "distance": case.get("measured_distance", case["distance"]),
        "answer_chars": len(answer),
        "answer": answer,
    }
    row.update(classify(answer))
    return row


KINDS = ("perclaim", "grouped", "none")


def rescore(rows):
    """저장된 답변 원문에서 분류를 다시 계산한다. before/after 를 같은 잣대로 본다."""
    return [{**row, **classify(row["answer"])} for row in rows]


def summarize(label, rows):
    """모델별 집계. 가드레일이 교체한 답변은 모델의 말이 아니므로 분류에서 뺀다."""
    rows = rescore(rows)
    print(f"\n[{label}] 모델별 집계")
    print(f"{'모델':10} {'평가':>5} {'perclaim':>9} {'grouped':>8} {'none':>5} "
          f"{'괄호형식':>7} {'literal':>8} {'행동경로':>7} {'평균길이':>7} {'교체':>5} {'실패':>5}")
    stats = {}
    for provider in sorted({r["provider"] for r in rows}):
        subset = [r for r in rows if r["provider"] == provider]
        replaced = sum(1 for r in subset if r["status"] == "guardrail_replaced")
        failed = sum(1 for r in subset if r["status"] == "fallback")
        scored = [r for r in subset if r["status"] == "success"]
        counts = {k: sum(1 for r in scored if r["kind"] == k) for k in KINDS}
        literal = sum(1 for r in scored if r["literal_token"])
        paren = sum(1 for r in scored if r["paren_citations"])
        action = sum(1 for r in scored if r["has_action_path"])
        length = round(sum(r["answer_chars"] for r in scored) / len(scored)) if scored else 0
        stats[provider] = {
            "scored": len(scored), **counts, "paren": paren, "literal": literal,
            "action": action, "length": length, "replaced": replaced, "failed": failed,
        }
        print(f"{provider:10} {len(scored):>5} {counts['perclaim']:>9} {counts['grouped']:>8} "
              f"{counts['none']:>5} {paren:>7} {literal:>8} {action:>7} {length:>7} "
              f"{replaced:>5} {failed:>5}")
    return stats


def run(label):
    if label not in ("before", "after"):
        print(f"라벨은 before 또는 after 여야 합니다: {label}")
        return
    print(f"안정 구간 확인 중 ({len(CASES)}건)")
    check_band()
    print(f"\n{len(CASES)}케이스 × 2모델 = {len(CASES) * 2}회 LLM 호출")
    rows = []
    for case in CASES:
        try:
            payload = post(CHAT_URL, {
                "message": case["q"], "chat_mode": case["mode"], "recent_messages": [],
            }, 300)
        except Exception as exc:
            print(f"  {case['id']:20} 호출 실패 {exc}")
            continue
        for result in payload.get("results", []):
            row = score(case, result)
            rows.append(row)
            mark = {"perclaim": "✓", "grouped": "△", "none": "✗"}[row["kind"]]
            note = f" literal×{row['literal_token']}" if row["literal_token"] else ""
            if row["status"] != "success":
                note += f" [{row['status']}]"
            print(f"  {mark} {case['id']:20} {row['provider']:8} "
                  f"근거={len(row['perclaim_citations'])}+{len(row['grouped_citations'])} "
                  f"괄호={row['paren_citations']}{note}")
    (OUT / f"citation-{label}.json").write_text(
        json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    summarize(label, rows)
    print(f"\n저장: {OUT / f'citation-{label}.json'}")


def compare():
    before = rescore(json.loads((OUT / "citation-before.json").read_text(encoding="utf-8")))
    after = rescore(json.loads((OUT / "citation-after.json").read_text(encoding="utf-8")))
    index = {(r["case"], r["provider"]): r for r in before}
    rank = {"none": 0, "grouped": 1, "perclaim": 2}
    symbol = {"perclaim": "✓ perclaim", "grouped": "△ grouped", "none": "✗ none"}

    for provider in sorted({r["provider"] for r in after}):
        print(f"\n── {provider} ──")
        print(f"{'케이스':24} {'개선전':>12} {'개선후':>12}   {'괄호':>7} {'literal':>8}")
        for row in after:
            if row["provider"] != provider:
                continue
            prev = index.get((row["case"], row["provider"]))
            if not prev:
                continue
            mark = ""
            if rank[row["kind"]] > rank[prev["kind"]]:
                mark = "  ↑ 개선"
            elif rank[row["kind"]] < rank[prev["kind"]]:
                mark = "  ↓ 악화"
            print(f"{row['case']:24} {symbol[prev['kind']]:>12} {symbol[row['kind']]:>12}{mark:9}"
                  f" {prev['paren_citations']}→{row['paren_citations']:<5}"
                  f" {prev['literal_token']}→{row['literal_token']}")

    b_stats = summarize("before", before)
    a_stats = summarize("after", after)
    print("\n[변화]")
    for provider in sorted(a_stats):
        b, a = b_stats.get(provider, {}), a_stats[provider]
        print(f"  {provider:10} none {b.get('none', 0)} → {a['none']}"
              f" · perclaim {b.get('perclaim', 0)} → {a['perclaim']}"
              f" · 괄호형식 {b.get('paren', 0)} → {a['paren']}"
              f" · literal {b.get('literal', 0)} → {a['literal']}"
              f" · 행동경로 {b.get('action', 0)} → {a['action']}"
              f" · 평균길이 {b.get('length', 0)} → {a['length']}"
              f" · 가드레일교체 {b.get('replaced', 0)} → {a['replaced']}")


if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else "before"
    if action == "compare":
        compare()
    elif action == "band":
        check_band()
    else:
        run(action)
