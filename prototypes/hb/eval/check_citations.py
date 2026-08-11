"""
생성 단계 검증 ① - 조항 인용 환각(citation hallucination) 규칙 기반 검사.

bot.py 시스템 프롬프트는 "조항에 없는 조항 번호·법률·예외 사유를 지어내지 마세요"라고
못박고 있지만, 실제로 지켜지는지는 지금까지 측정된 적이 없다. 이 스크립트는 답변에
등장한 조항 인용을 전부 뽑아 아래 세 가지로 분류한다.

  OK        검색되어 프롬프트에 실제로 들어간 조항을 인용 → 정상
  근거없음   DB에는 있지만 이번 질문에서 검색되지 않은 조항을 인용 → 모델이 기억으로 지어냄
  존재안함   DB에 아예 없는 조문/법령을 인용 → 명백한 환각

심판 LLM을 쓰지 않으므로 판정에 흔들림이 없고 비용도 들지 않는다.
다만 '답변을 만드는' 단계에서는 solar-pro3 호출이 발생한다(질문당 분류 1 + 생성 1).

실행:
    cd webapp
    export PYTHONPATH="$PWD/pylibs:$PWD/eval:$PYTHONPATH"
    python3 eval/check_citations.py --limit 15          # 우선 15문항만
    python3 eval/check_citations.py --limit 0           # 전체(비용 주의)
    python3 eval/check_citations.py --persona 근로자     # 페르소나 분류 호출 생략
"""
import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import bot  # noqa: E402
from questions import POSITIVES, NEGATIVES  # noqa: E402

OUT_DIR = Path(__file__).resolve().parent / "results"

# '근로기준법 제43조의2제1항제3호' / '시행령 제30조제1항' / '제36조' 형태를 잡는다.
# 모델은 '근로기준법 시행령'을 두 번째 언급부터 그냥 '시행령'으로 줄여 쓰는 일이 잦다.
#
# 주의: 법령명에 공백이 들어가는 것들이 있다('근로자퇴직급여 보장법',
# '남녀고용평등과 일ㆍ가정 양립 지원에 관한 법률'). 단순히 [가-힣]{2,10}법 으로 잡으면
# 뒷토막('보장법')만 잡혀 'DB에 없는 법령'으로 오판한다. DB에 실재하는 법령명을
# 먼저 통째로 시도하고, 그다음에 일반 패턴을 쓴다.
GENERIC_LAW = r"[가-힣]{2,12}법(?:\s*시행령)?|시행령"


def build_citation_re(known_laws):
    names = sorted(known_laws, key=len, reverse=True)
    alts = "|".join(re.escape(n) for n in names if n)
    law_pat = (alts + "|" + GENERIC_LAW) if alts else GENERIC_LAW
    return re.compile(
        r"(?:「?(?P<law>" + law_pat + r")」?\s*)?"
        r"(?P<article>제\d+조(?:의\d+)?)"
        r"(?P<clause>(?:제\d+항)?(?:제\d+호)?(?:제\d+목)?)"
    )


# DB를 읽기 전에도 쓸 수 있도록 기본형을 두고, main()에서 실제 법령명으로 교체한다.
CITATION_RE = build_citation_re([])

# 프롬프트가 안내를 허용한 공식 창구. 이 외의 번호가 나오면 지어냈을 가능성이 있다.
KNOWN_NUMBERS = {"1350", "132", "1588-0075", "1644-0083"}
PHONE_RE = re.compile(r"\b(\d{3,4}-\d{4}|\b1[0-9]{3}\b)")

# 기간·금액·비율 등 '조항에 없으면 지어낸 것'인 수치. 프롬프트가 특히 금지한 항목이다.
#   "상한액, 소요 기간, 지급 비율처럼 참고 조항에 명시되지 않은 구체적인 숫자는 지어내지 마세요"
NUMBER_RE = re.compile(
    r"(?P<full>"
    r"100분의\s*\d+"                                              # 법령 문체의 비율
    r"|\d+(?:,\d{3})*(?:\.\d+)?\s*"
    r"(?:일분|일|개월|달|년|주|시간|분|퍼센트|%|배|억원|만원|원|회|명|세)"
    r")"
)


def canonical_numbers(text):
    """수치 표현을 비교 가능한 형태로 바꾼다.

    같은 값이라도 법령 원문과 답변의 표기가 달라서(100분의 50 ↔ 50%, 2주 ↔ 14일)
    글자만 비교하면 멀쩡한 인용도 불일치로 잡힌다. 알려진 환산은 미리 펼쳐둔다.
    """
    t = text.replace(" ", "").replace(",", "")
    forms = {t}
    m = re.fullmatch(r"100분의(\d+)", t)
    if m:
        forms |= {f"{m.group(1)}%", f"{m.group(1)}퍼센트"}
    m = re.fullmatch(r"(\d+)(?:%|퍼센트)", t)
    if m:
        forms.add(f"100분의{m.group(1)}")
    m = re.fullmatch(r"(\d+)주", t)
    if m:
        forms.add(f"{int(m.group(1)) * 7}일")
    m = re.fullmatch(r"(\d+)일", t)
    if m and int(m.group(1)) % 7 == 0:
        forms.add(f"{int(m.group(1)) // 7}주")
    m = re.fullmatch(r"(\d+)(?:개월|달)", t)
    if m:
        forms |= {f"{m.group(1)}개월", f"{m.group(1)}달"}
    return forms


def extract_numbers(answer):
    """답변에서 수치 표현을 뽑는다. 조항 인용(제36조·제1항)과 창구 번호는 제외한다."""
    masked = CITATION_RE.sub(" ", answer)
    for n in KNOWN_NUMBERS:
        masked = masked.replace(n, " ")
    seen, out = set(), []
    for m in NUMBER_RE.finditer(masked):
        raw = m.group("full").strip()
        key = raw.replace(" ", "")
        if key in seen:
            continue
        seen.add(key)
        out.append(raw)
    return out


def check_numbers(answer, context_text):
    """각 수치가 검색된 조항 원문에 실제로 있는지 대조한다.

    이건 '판정'이 아니라 '선별'이다. 조문을 요약·환산해서 쓴 경우에도 확인필요로
    잡히므로, 걸린 항목은 사람이 한 번 봐야 한다.
    """
    ctx = context_text.replace(" ", "").replace(",", "")
    rows = []
    for raw in extract_numbers(answer):
        forms = canonical_numbers(raw)
        hit = next((f for f in forms if f in ctx), None)
        rows.append({
            "raw": raw,
            "verdict": "근거있음" if hit == raw.replace(" ", "").replace(",", "")
            else ("환산일치" if hit else "확인필요"),
            "matched_as": hit,
        })
    return rows


def db_index():
    """DB에 실재하는 (법령, 조문번호) 집합."""
    have = defaultdict(set)
    for m in bot.collection.get(include=["metadatas"])["metadatas"]:
        have[m.get("law", "")].add(m.get("article_id", ""))
    return have


def doc_index():
    """(법령, 조문번호) → 조문 원문. 수치 대조에 쓴다."""
    data = bot.collection.get(include=["documents", "metadatas"])
    docs = defaultdict(str)
    for doc, m in zip(data["documents"], data["metadatas"]):
        docs[(m.get("law", ""), m.get("article_id", ""))] += "\n" + (doc or "")
    return docs


def context_text(retrieved, docs):
    """이번 질문에서 프롬프트에 실제로 들어간 조항들의 원문을 이어붙인다."""
    return "\n".join(docs.get(key, "") for key in retrieved)


def extract_citations(answer):
    """답변에서 조항 인용을 추출한다.

    법령명이 생략되면 직전에 언급된 법령을 잇는다. '시행령'만 단독으로 쓴 경우는
    직전에 나온 본법 이름을 붙여 '근로기준법 시행령'으로 복원한다.
    """
    out, last_law, last_base = [], None, None
    for m in CITATION_RE.finditer(answer):
        law = (m.group("law") or "").replace(" ", "") or None
        if law == "시행령":
            law = f"{last_base}시행령" if last_base else None
        elif law:
            last_base = law.replace("시행령", "")
        if law:
            last_law = law
        out.append({
            "raw": m.group(0).strip(),
            "law": law or last_law,      # 생략되면 직전 법령으로 간주
            "law_explicit": bool(m.group("law")),
            "article": m.group("article"),
            "clause": m.group("clause") or "",
        })
    return out


def normalize_law(name, known_laws):
    """'근로기준법시행령' 같은 공백 제거형을 DB 표기로 되돌린다."""
    if not name:
        return None
    for k in known_laws:
        if k.replace(" ", "") == name:
            return k
    return name


def classify(cit, retrieved, have, ctx=""):
    """ctx: 이번 질문에서 프롬프트에 들어간 조항 원문. 조문이 본문에서 다른 법률을
    인용하는 경우(예: 남녀고용평등법 제19조가 「한부모가족지원법」을 언급)를
    환각으로 오판하지 않기 위해 함께 본다."""
    known = set(have)
    law = normalize_law(cit["law"], known)
    art = cit["article"]

    if law is None:
        # 법령명이 한 번도 안 나온 채 '제N조'만 쓴 경우 - 검색된 조항 중에 있으면 인정
        if any(a == art for _l, a in retrieved):
            return "OK", None
        if any(art in have[l] for l in known):
            return "근거없음", "법령명 없이 인용, 검색 결과에도 없음"
        return "존재안함", "법령명 없이 인용, DB에 없는 조문"

    if law not in known:
        if law and law.replace(" ", "") in ctx.replace(" ", ""):
            return "OK", None  # 검색된 조문이 본문에서 인용하고 있는 법률
        return "존재안함", f"DB에 없는 법령: {law}"
    if art not in have[law]:
        return "존재안함", f"{law}에 없는 조문: {art}"
    if (law, art) not in retrieved:
        return "근거없음", "DB에는 있으나 이번 검색 결과에 없던 조항"
    return "OK", None


def run_one(item, persona_mode, have, docs):
    q = item["q"] if isinstance(item, dict) else item
    picked, gate = bot.retrieve_context(q, n_results=5)
    retrieved = {(m.get("law"), m.get("article_id")) for _d, m, _dist in picked}

    persona = persona_mode
    if persona_mode == "auto":
        persona = bot.classify_persona(q)
    answer = bot.ask_donworry(q, persona, n_results=5)

    gated = (gate is None or gate > bot.NO_MATCH_DISTANCE_THRESHOLD)
    ctx = context_text(retrieved, docs)
    cits = [] if gated else extract_citations(answer)
    results = []
    for c in cits:
        verdict, reason = classify(c, retrieved, have, ctx)
        results.append({**c, "verdict": verdict, "reason": reason})

    phones = {p for p in PHONE_RE.findall(answer)} - KNOWN_NUMBERS
    numbers = [] if gated else check_numbers(answer, context_text(retrieved, docs))
    return {
        "q": q, "persona": persona, "gated": gated, "gate_distance": gate,
        "retrieved": sorted(f"{l} {a}" for l, a in retrieved),
        "answer": answer,
        "citations": results,
        "numbers": numbers,
        "unknown_numbers": sorted(phones),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=15,
                    help="검사할 positive 문항 수 (0이면 전체). 기본 15")
    ap.add_argument("--per-law", type=int, default=0,
                    help="법령별로 N문항씩 고르게 뽑는다(--limit 대신 사용). 새 법이 "
                         "표본에서 빠지지 않게 하려면 이쪽을 쓴다")
    ap.add_argument("--negatives", type=int, default=3,
                    help="같이 돌릴 negative 문항 수. 기본 3")
    ap.add_argument("--persona", default="auto",
                    help="auto면 분류 호출을 하고, 페르소나명을 주면 그 값으로 고정")
    ap.add_argument("--reanalyze", action="store_true",
                    help="이미 저장된 답변을 다시 채점만 한다(LLM 호출 없음)")
    args = ap.parse_args()

    have = db_index()
    docs = doc_index()
    global CITATION_RE
    CITATION_RE = build_citation_re(have.keys())

    if args.reanalyze:
        src = OUT_DIR / "citation_check.json"
        if not src.is_file():
            print(f"[!] {src} 가 없습니다. 먼저 답변을 생성하세요.")
            return 1
        rows = json.loads(src.read_text())
        for r in rows:
            retrieved = {tuple(x.rsplit(" ", 1)) for x in r["retrieved"]}
            r["citations"] = []
            r["numbers"] = []
            if not r["gated"]:
                ctx = context_text(retrieved, docs)
                for c in extract_citations(r["answer"]):
                    verdict, reason = classify(c, retrieved, have, ctx)
                    r["citations"].append({**c, "verdict": verdict, "reason": reason})
                r["numbers"] = check_numbers(r["answer"], context_text(retrieved, docs))
        print(f"저장된 답변 {len(rows)}건 재채점 (LLM 호출 0회)\n")
        report(rows)
        src.write_text(json.dumps(rows, ensure_ascii=False, indent=2))
        return 0

    if args.per_law:
        seen, items = {}, []
        for it in POSITIVES:
            n = seen.get(it["law"], 0)
            if n < args.per_law:
                items.append(it)
                seen[it["law"]] = n + 1
    else:
        items = POSITIVES if args.limit == 0 else POSITIVES[:args.limit]
    negs = NEGATIVES[:args.negatives]
    calls = len(items) + len(negs)
    print(f"검사 문항 {len(items)} (+negative {len(negs)}) / "
          f"예상 LLM 호출 {calls * (2 if args.persona == 'auto' else 1)}회\n")

    rows = []
    for i, it in enumerate(items + negs, 1):
        try:
            r = run_one(it, args.persona, have, docs)
        except Exception as e:                      # API 오류로 전체가 멈추지 않게
            print(f"  [{i}/{calls}] 실패: {e}")
            continue
        rows.append(r)
        bad = [c for c in r["citations"] if c["verdict"] != "OK"]
        nbad = [n for n in r["numbers"] if n["verdict"] == "확인필요"]
        mark = "gated" if r["gated"] else (
            f"조항{len(bad)}/수치{len(nbad)}" if (bad or nbad) else "OK")
        print(f"  [{i}/{calls}] {mark:<8} {r['q'][:44]}")

    report(rows)

    OUT_DIR.mkdir(exist_ok=True)
    out = OUT_DIR / "citation_check.json"
    out.write_text(json.dumps(rows, ensure_ascii=False, indent=2))
    print(f"\n결과 저장: {out}")
    return 0


def report(rows):
    print("\n" + "=" * 78)
    print("조항 인용 환각 검사")
    print("=" * 78)

    counts = Counter(c["verdict"] for r in rows for c in r["citations"])
    total = sum(counts.values())
    answered = [r for r in rows if not r["gated"]]
    print(f"  답변 생성된 문항: {len(answered)}/{len(rows)} (나머지는 게이트에서 차단)")
    print(f"  인용된 조항 총계: {total}건")
    for v in ("OK", "근거없음", "존재안함"):
        n = counts.get(v, 0)
        print(f"    {v:<8} {n:>3}건 ({n / total * 100:5.1f}%)" if total else f"    {v}: 0")

    clean = [r for r in answered if all(c["verdict"] == "OK" for c in r["citations"])]
    print(f"  인용이 전부 정상인 답변: {len(clean)}/{len(answered)}")

    print("\n■ 문제 인용 상세")
    any_bad = False
    for r in rows:
        bad = [c for c in r["citations"] if c["verdict"] != "OK"]
        if not bad:
            continue
        any_bad = True
        print(f"\n  Q. {r['q']}")
        print(f"     검색된 조항: {', '.join(r['retrieved'])}")
        for c in bad:
            print(f"     [{c['verdict']}] '{c['raw']}' - {c['reason']}")
    if not any_bad:
        print("  없음")

    ncnt = Counter(n["verdict"] for r in rows for n in r.get("numbers", []))
    ntotal = sum(ncnt.values())
    print("\n" + "=" * 78)
    print("수치(기간·금액·비율) 근거 검사")
    print("=" * 78)
    print(f"  답변에 등장한 수치 총계: {ntotal}건")
    for v in ("근거있음", "환산일치", "확인필요"):
        n = ncnt.get(v, 0)
        print(f"    {v:<6} {n:>3}건 ({n / ntotal * 100:5.1f}%)" if ntotal else f"    {v}: 0")
    print("  ※ '확인필요'는 환각 판정이 아니라 선별 결과다. 조문을 요약·환산해 쓴 경우도 걸린다.")

    print("\n■ 조항 원문에서 찾지 못한 수치")
    found = False
    for r in rows:
        nb = [n for n in r.get("numbers", []) if n["verdict"] == "확인필요"]
        if not nb:
            continue
        found = True
        print(f"\n  Q. {r['q']}")
        print(f"     {', '.join(n['raw'] for n in nb)}")
    if not found:
        print("  없음")

    odd = [r for r in rows if r["unknown_numbers"]]
    print(f"\n■ 안내 목록에 없는 번호가 등장한 답변 {len(odd)}건")
    for r in odd:
        print(f"    {r['unknown_numbers']}  ← {r['q'][:40]}")


if __name__ == "__main__":
    sys.exit(main())
