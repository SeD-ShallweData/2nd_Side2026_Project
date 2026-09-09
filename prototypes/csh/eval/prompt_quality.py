"""상담 프롬프트 종합 평가.

`citation_attach.py` 가 인용 부착 하나만 깊게 본다면, 이 스크립트는 프롬프트가
답변에 요구하는 것 전체를 검색 경로별로 나눠서 본다. 프롬프트를 크게 고칠 때
한쪽을 고치다 다른 쪽을 무너뜨리는 것을 잡으려는 것이다. 실제로 인용 지시를
늘렸을 때 "지금 할 행동"이 답변에서 밀려난 적이 있다.

    python3 eval/prompt_quality.py before
    # product/prompts/chat/system.md 수정
    python3 eval/prompt_quality.py after
    python3 eval/prompt_quality.py compare

## 검색 경로를 나눠서 보는 이유

RAG 가 돌려주는 상태가 하나가 아니다. 경로마다 옳은 답이 다르므로 같은 잣대로
재면 안 된다.

    law        법령 조문이 matched          조문 근거를 붙여야 한다
    guide      공식 안내만 matched          고용노동부 안내를 근거로 붙이고 법령을 지어내면 안 된다
    scope_gap  out_of_scope (topic 있음)    수록 범위 밖임을 밝혀야 한다. 조문을 만들면 안 된다
    off_topic  distance_threshold           서비스 범위 밖. 설명을 시작하면 안 된다

`guide` 는 `official_guides.json` 이 트리거될 때다. 이때 인용은 조문이 아니라
「고용노동부 노동포털 「체불임금 해결 방법」」 같은 형태다. 조문 정규식만 쓰면
근거가 없다고 잘못 센다.

## 무엇을 세나

판정은 규칙으로만 한다(심판 LLM 없음). 프롬프트를 고쳐도 채점 기준이 흔들리지
않게 하려는 것이다. 저장된 답변 원문에서 매번 다시 계산하므로 채점 규칙을 고치면
before 도 같이 다시 채점된다.

    근거      cited      유효 인용이 있는가 (법령 또는 공식 안내)
              perclaim   그 근거가 서술 문장에 붙었는가 (끝에 몰아 적지 않았는가)
    안전      fabricated 검색되지 않은 조문을 지어냈는가 (가드레일 교체 포함)
    유용      action     지금 할 행동이나 공식 확인 경로가 있는가
    형식      label      금지된 설계 라벨·소제목·번호 목록을 썼는가
    범위      gap_stated 수록 범위 밖임을 밝혔는가 (scope_gap 전용)
              declined   서비스 범위 밖이라고 밝혔는가 (off_topic 전용)

경로마다 기대치가 달라서, 합격 조건도 경로별로 다르게 둔다(`EXPECTATIONS`).
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

CASES = [
    # ── law: 법령 조문이 안정적으로 걸리는 질문 (거리 0.35 미만)
    {"id": "shutdown-pay", "q": "휴업수당은 어떤 기준으로 산출하나요?", "mode": "wage", "path": "law"},
    {"id": "annual-leave", "q": "연차휴가는 며칠이나 생기나요?", "mode": "general", "path": "law"},
    {"id": "layoff-notice", "q": "해고하려면 며칠 전에 미리 알려줘야 하나요?", "mode": "general", "path": "law"},
    {"id": "overtime-rate", "q": "야근하면 수당을 얼마나 더 받아야 하나요?", "mode": "wage", "path": "law"},
    {"id": "dismissal-reason", "q": "잘렸는데 이유를 안 알려줍니다", "mode": "general", "path": "law"},
    {"id": "break-time", "q": "짧게 일하는데 휴게시간을 줘야 하나요?", "mode": "general", "path": "law"},
    {"id": "payslip-items", "q": "임금명세서에는 어떤 항목을 적어야 하나요?", "mode": "wage", "path": "law"},
    {"id": "harassment", "q": "직장 내 괴롭힘을 당했는데 어디에 신고하나요?", "mode": "general", "path": "law"},

    # ── guide: 공식 안내만 걸리는 질문. 조문을 지어내면 안 된다
    {"id": "wage-evidence", "q": "임금이 밀렸는데 무슨 자료를 준비해야 하나요?", "mode": "wage", "path": "guide"},
    {"id": "wage-complaint", "q": "체불 진정을 넣으려면 증빙자료를 어떻게 준비하나요?", "mode": "wage", "path": "guide"},

    # ── scope_gap: DB에 법령이 없는 주제. 수록 범위 밖임을 밝혀야 한다
    {"id": "gap-injury", "q": "일하다 다쳤는데 산재 신청은 어떻게 하나요?", "mode": "general", "path": "scope_gap"},
    {"id": "gap-insurance", "q": "4대보험에 가입을 안 시켜줘요", "mode": "general", "path": "scope_gap"},
    {"id": "gap-union", "q": "노동조합을 만들려면 어떻게 하나요?", "mode": "general", "path": "scope_gap"},
    {"id": "gap-dispatch", "q": "파견직인데 정규직 전환이 되나요?", "mode": "general", "path": "scope_gap"},

    # ── off_topic: 서비스 범위 밖. 아는 내용이어도 설명을 시작하면 안 된다
    {"id": "off-tax", "q": "종합소득세 신고는 어떻게 하나요?", "mode": "general", "path": "off_topic"},
    {"id": "off-invest", "q": "주식 투자 어떻게 시작하나요?", "mode": "general", "path": "off_topic"},
]

# 경로별 합격 조건. 이 경로에서 이 항목이 True 여야 한다는 뜻이다.
EXPECTATIONS = {
    "law": ("cited", "perclaim", "action", "no_leak", "no_label"),
    "guide": ("cited", "action", "no_leak", "no_label"),
    "scope_gap": ("gap_stated", "action", "no_leak"),
    "off_topic": ("declined", "no_leak"),
}

# guardrails.ts 의 LAW_NAMES 와 같아야 한다. 긴 이름을 먼저 둔다.
LAW_NAMES = [
    "남녀고용평등과 일ㆍ가정 양립 지원에 관한 법률", "근로자퇴직급여 보장법", "근로기준법 시행령",
    "임금채권보장법", "고용보험법", "최저임금법", "근로기준법",
]
LAW_CITATION = re.compile(
    rf"(?:「\s*)?(?:{'|'.join(LAW_NAMES)})(?:\s*」)?\s*제\s*\d+\s*조(?:의\s*\d+)?")
# 공식 안내 인용: 고용노동부 노동포털 「체불임금 해결 방법」
# 기관 이름을 특정 목록으로 묶지 않는다. 지어낸 "국세청 「종합소득세 신고 안내」" 도
# 잡아야 하기 때문이다. 「」만 있고 기관명이 없는 「근로기준법 제46조」는 조문 쪽에서 센다.
GUIDE_CITATION = re.compile(
    r"[가-힣]{2,12}(?:부|청|공단|포털|위원회|원|센터|상담)\s*[^「\n]{0,15}「[^」\n]{2,40}」")
PAREN = re.compile(r"[(（][^)）]*[)）]")
SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")
ATTRIBUTION_WORD = re.compile(r"근거|출처|관련\s*법령|참고|citations?", re.IGNORECASE)

ACTION_PATH = re.compile(r"1350|노동위원회|노동청|노동관서|근로감독관|노동포털|진정|신고|고용노동부|확인하|문의하|준비하|접수")
# 주입되는 JSON의 필드 이름이 답변에 그대로 새는 경우. 프롬프트가 지시문에서
# 필드 이름을 영어 낱말로 쓰면 모델이 그것을 출력해 버린다. 반복해서 관측됐다 —
# "발생합니다 citation.", "(citation: retrieved_labor_law)"
FIELD_NAME_LEAK = re.compile(r"citations?|retrieved_labor_law|retrieval_(?:status|topic|reason)", re.IGNORECASE)
# 프롬프트가 금지한 형식: 소제목, 번호 목록, 설계 라벨
DESIGN_LABEL = re.compile(
    r"^\s{0,3}#{1,6}\s|^\s{0,3}\d+[.)]\s|^\s{0,3}[-*·]\s|"
    r"\d\s*단계|공감|대처법|관련\s*법령\s*[:：]|요약\s*[:：]|결론\s*[:：]|한계\s*[:：]|지금\s*할\s*행동\s*[:：]",
    re.MULTILINE)
# 수록 범위 밖임을 밝히는 표현.
# "공식 자료 범위에 없습니다" 를 놓쳐 실제로 밝힌 답변을 미달로 세던 적이 있다.
# 범위·자료 계열 낱말 뒤에 부정이 오는 형태를 함께 본다.
GAP_STATED = re.compile(
    r"수록|검색\s*범위|포함되어\s*있지\s*않|다루지\s*않|확인된\s*(?:법령|공식)?\s*근거가\s*없|"
    r"근거를\s*찾지\s*못|제공\s*범위|(?:범위|자료)[^.\n]{0,12}(?:없|밖|아닙)")
# 서비스 범위 밖이라고 밝히는 표현. 노동 낱말이 스쳐 지나가는 것만으로는 인정하지 않는다.
DECLINED = re.compile(
    r"범위\s*밖|범위를\s*벗어|다루지\s*않|안내(?:해\s*)?(?:드릴|드리지)|답변(?:해\s*)?(?:드릴|드리지)\s*(?:수\s*없|못)|"
    r"제공하지\s*않|상담\s*범위|도와드리기\s*어렵")


def post(url, payload, timeout):
    body = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read())


def _is_citation_only(segment):
    rest = LAW_CITATION.sub("", segment)
    rest = GUIDE_CITATION.sub("", rest)
    rest = ATTRIBUTION_WORD.sub("", rest)
    rest = re.sub(r"[^가-힣]", "", rest)
    return len(rest) < 8


def classify(answer):
    """근거가 있는가, 그 근거가 서술 문장에 붙었는가."""
    spans = [m.span() for m in LAW_CITATION.finditer(answer)]
    spans += [m.span() for m in GUIDE_CITATION.finditer(answer)]
    paren_spans = [m.span() for m in PAREN.finditer(answer)]

    perclaim = grouped = 0
    for line in answer.splitlines():
        found = len(LAW_CITATION.findall(line)) + len(GUIDE_CITATION.findall(line))
        if not found:
            continue
        segments = SENTENCE_SPLIT.split(line.strip())
        has_content = any(
            not _is_citation_only(s) and re.search(r"[가-힣]", s) for s in segments)
        if has_content:
            perclaim += found
        else:
            grouped += found

    return {
        "law_citations": sorted({c.replace(" ", "").replace("「", "").replace("」", "")
                                 for c in LAW_CITATION.findall(answer)}),
        "guide_citations": sorted(set(GUIDE_CITATION.findall(answer))),
        "perclaim_count": perclaim,
        "grouped_count": grouped,
        "paren_count": sum(
            1 for start, end in spans
            if any(ps <= start and end <= pe for ps, pe in paren_spans)),
    }


def evaluate(row):
    """저장된 답변에서 항목별 참/거짓을 계산한다."""
    answer = row["answer"]
    # 사용자가 실제로 보는 것은 답변 + 제한사항이다. 범위·거절 판정은 둘을 합쳐 본다.
    shown = "\n".join([answer, *row.get("limitations", [])])
    parsed = classify(answer)
    cited = bool(parsed["law_citations"] or parsed["guide_citations"])
    # 검색이 성공하지 않았는데 근거를 적었으면 지어낸 것이다. 가드레일 교체도 같은 신호다.
    # 기관 문서명(「」)도 함께 본다 — 조문만 검사하면 "국세청 「종합소득세 신고 안내」"
    # 처럼 지어낸 안내 문서를 놓친다. 실제로 관측됐다.
    fabricated = (
        "UNVERIFIED_LAW_CITATION" in row["guardrail_hits"]
        or (row["rag_status"] != "matched" and cited)
    )
    return {
        **parsed,
        "cited": cited,
        "perclaim": parsed["perclaim_count"] > 0,
        "no_fabrication": not fabricated,
        # 가드레일이 잡아 답변을 교체했으면 지어낸 근거가 사용자에게 닿지는 않는다.
        # 배포 기준은 이쪽이다 — 모델이 지어냈는가와 사용자가 봤는가는 다른 문제다.
        "no_leak": not (fabricated and row["status"] == "success"),
        "action": bool(ACTION_PATH.search(shown)),
        "no_label": not bool(DESIGN_LABEL.search(answer)),
        "gap_stated": bool(GAP_STATED.search(shown)),
        "declined": bool(DECLINED.search(shown)) and len(answer) < 700,
        "no_field_leak": not bool(FIELD_NAME_LEAK.search(answer)),
    }


def score(case, result):
    return {
        "case": case["id"], "path": case["path"], "question": case["q"],
        "provider": result["provider"], "status": result["status"],
        "rag_status": result["trace"]["rag_status"],
        "rag_reason": result["trace"].get("rag_reason"),
        "rag_topic": result["trace"].get("rag_topic"),
        "guardrail_hits": result["trace"]["guardrail_hits"],
        "answer_chars": len(result["answer"]),
        "answer": result["answer"],
        # 화면은 제한사항을 답변 아래에 함께 보여준다(ChatPanel). 정책 단락 응답은
        # "왜 답을 못 하는지"가 답변 본문이 아니라 여기에 담기므로 같이 채점한다.
        "limitations": result.get("limitations", []),
    }


def check_paths():
    """케이스가 의도한 검색 경로에 있는지 확인한다. rag-api 만 호출 — LLM 비용 없음."""
    expected = {"law": "matched", "guide": "matched", "scope_gap": "no_match", "off_topic": "no_match"}
    drifted = []
    for case in CASES:
        data = post(RAG_URL, {"query": case["q"], "limit": 5}, 120)
        status, reason = data.get("status"), data.get("reason")
        citations = [i["citation"] for i in data.get("items", [])]
        guides = [c for c in citations if "「" in c]
        ok = status == expected[case["path"]]
        if case["path"] == "guide":
            ok = ok and bool(guides)
        if case["path"] == "law":
            ok = ok and bool([c for c in citations if "「" not in c])
        if case["path"] == "scope_gap":
            ok = ok and reason == "out_of_scope"
        if case["path"] == "off_topic":
            ok = ok and reason == "distance_threshold"
        if not ok:
            drifted.append((case["id"], case["path"], status, reason, citations[:2]))
    if drifted:
        print(f"⚠ 의도한 검색 경로를 벗어난 케이스 {len(drifted)}건 — 결과 해석 주의")
        for row in drifted:
            print(f"    {row[0]:18} path={row[1]:10} status={row[2]} reason={row[3]} {row[4]}")
    else:
        print(f"✓ {len(CASES)}건 모두 의도한 검색 경로 유지")
    return not drifted


def summarize(label, rows):
    print(f"\n[{label}] 경로별 합격률 (해당 경로의 기대 항목만 본다)")
    stats = {}
    for provider in sorted({r["provider"] for r in rows}):
        print(f"\n  ── {provider}")
        for path in ("law", "guide", "scope_gap", "off_topic"):
            subset = [r for r in rows if r["provider"] == provider and r["path"] == path]
            if not subset:
                continue
            keys = EXPECTATIONS[path]
            counts = {}
            for key in keys:
                counts[key] = sum(1 for r in subset if evaluate(r)[key])
            replaced = sum(1 for r in subset if r["status"] != "success")
            detail = "  ".join(f"{k} {v}/{len(subset)}" for k, v in counts.items())
            passed = sum(1 for r in subset if all(evaluate(r)[k] for k in keys))
            stats[(provider, path)] = {
                "n": len(subset), "passed": passed, "replaced": replaced, **counts}
            flag = "  ⚠교체 %d" % replaced if replaced else ""
            print(f"     {path:10} 전항목통과 {passed}/{len(subset)}   {detail}{flag}")
    return stats


def run(label):
    if label not in ("before", "after"):
        print(f"라벨은 before 또는 after 여야 합니다: {label}")
        return
    print(f"검색 경로 확인 중 ({len(CASES)}건)")
    check_paths()
    print(f"\n{len(CASES)}케이스 × 2모델 = {len(CASES) * 2}회 LLM 호출")
    rows = []
    for case in CASES:
        try:
            payload = post(CHAT_URL, {
                "message": case["q"], "chat_mode": case["mode"], "recent_messages": [],
            }, 300)
        except Exception as exc:
            print(f"  {case['id']:18} 호출 실패 {exc}")
            continue
        for result in payload.get("results", []):
            row = score(case, result)
            rows.append(row)
            marks = evaluate(row)
            keys = EXPECTATIONS[case["path"]]
            bad = [k for k in keys if not marks[k]]
            mark = "✓" if not bad else "✗"
            note = f" 미달={','.join(bad)}" if bad else ""
            if row["status"] != "success":
                note += f" [{row['status']}]"
            print(f"  {mark} {case['id']:18} {case['path']:10} {row['provider']:8}{note}")
    (OUT / f"quality-{label}.json").write_text(
        json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    summarize(label, rows)
    print(f"\n저장: {OUT / f'quality-{label}.json'}")


def compare():
    before = json.loads((OUT / "quality-before.json").read_text(encoding="utf-8"))
    after = json.loads((OUT / "quality-after.json").read_text(encoding="utf-8"))
    index = {(r["case"], r["provider"]): r for r in before}

    for provider in sorted({r["provider"] for r in after}):
        print(f"\n── {provider} ──")
        print(f"{'케이스':18} {'경로':10} {'개선전':>10} {'개선후':>10}")
        for row in after:
            if row["provider"] != provider:
                continue
            prev = index.get((row["case"], row["provider"]))
            if not prev:
                continue
            keys = EXPECTATIONS[row["path"]]
            b_bad = [k for k in keys if not evaluate(prev)[k]]
            a_bad = [k for k in keys if not evaluate(row)[k]]
            mark = ""
            if len(a_bad) < len(b_bad):
                mark = "  ↑ 개선"
            elif len(a_bad) > len(b_bad):
                mark = "  ↓ 악화"
            fmt = lambda bad: "통과" if not bad else ",".join(bad)
            print(f"{row['case']:18} {row['path']:10} {fmt(b_bad):>10} {fmt(a_bad):>10}{mark}")

    b_stats = summarize("before", before)
    a_stats = summarize("after", after)
    print("\n[변화] 경로별 전항목 통과")
    for key in sorted(a_stats):
        b, a = b_stats.get(key, {}), a_stats[key]
        arrow = "→"
        print(f"  {key[0]:10} {key[1]:10} {b.get('passed', 0)}/{b.get('n', 0)} {arrow} "
              f"{a['passed']}/{a['n']}"
              + (f"   가드레일교체 {b.get('replaced', 0)} {arrow} {a['replaced']}"
                 if b.get("replaced") or a["replaced"] else ""))


if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else "before"
    if action == "compare":
        compare()
    elif action == "paths":
        check_paths()
    else:
        run(action)
