"""
1-2. 검색 성능 평가 - 질문셋을 실제 검색 파이프라인(bot.retrieve_context)에 통과시켜
     top-1/top-3/top-5 정답률을 내고, threshold 재튜닝(1-3)에 쓸 거리값을 저장한다.

채점 기준
  정답 = 검색된 조문의 (법령, 조문번호)가 questions.py에 라벨된 허용 집합에 들어감.
  거리 = bot.retrieve_context가 게이트 판정에 쓰는 raw top-1 distance
        (narrow 필터로 밀려나기 전 값). 1-3에서 이 분포로 임계값을 다시 잡는다.

실행:
    cd webapp && PYTHONPATH="$PWD/pylibs:$PWD/eval:$PYTHONPATH" python3 eval/run_eval.py
결과:
    eval/results/eval_raw.json  (1-3 tune_threshold.py 입력)
"""
import json
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import bot  # noqa: E402  (모델·DB 로딩이 있어 import 순서를 유지한다)
from questions import (  # noqa: E402
    POSITIVES, NEGATIVES, NARROW_CASES, NARROW_ARTICLES,
)

OUT_DIR = Path(__file__).resolve().parent / "results"
N_RESULTS = 5
TOP_K_REPORT = (1, 3, 5)


def validate_labels():
    """라벨에 적힌 조문이 DB에 실제로 있는지 먼저 확인한다(오탈자·존재하지 않는 조문 방지)."""
    have = defaultdict(set)
    for m in bot.collection.get(include=["metadatas"])["metadatas"]:
        have[m.get("law", "")].add(m.get("article_id", ""))

    bad = []
    for item in POSITIVES:
        for aid in item["articles"]:
            if aid not in have.get(item["law"], set()):
                bad.append((item["q"], item["law"], aid))
    if bad:
        print("[!] DB에 없는 조문을 라벨로 쓴 항목이 있습니다:")
        for q, law, aid in bad:
            print(f"    {law} {aid}  ← {q}")
        print()
    return not bad


def raw_top1(question):
    """narrow 필터를 거치기 전의 1순위 검색 결과(진단용)."""
    emb = bot.embed_model.encode([question], normalize_embeddings=True)
    r = bot.collection.query(query_embeddings=emb.tolist(), n_results=1)
    return r["metadatas"][0][0], r["distances"][0][0]


def evaluate_positive(item):
    picked, gate_dist = bot.retrieve_context(item["q"], n_results=N_RESULTS)
    hits = [
        (meta.get("law") == item["law"] and meta.get("article_id") in item["articles"])
        for _doc, meta, _d in picked
    ]
    rmeta, rdist = raw_top1(item["q"])
    return {
        "q": item["q"],
        "law": item["law"],
        "want": item["articles"],
        "gate_distance": gate_dist,
        "hit_rank": (hits.index(True) + 1) if any(hits) else None,
        "got": [f"{m.get('law')} {m.get('article_id')}({m.get('title')}) {d:.3f}"
                for _doc, m, d in picked],
        "raw_top1": f"{rmeta.get('law')} {rmeta.get('article_id')}({rmeta.get('title')})",
        "raw_top1_distance": rdist,
    }


def evaluate_negative(q):
    _picked, gate_dist = bot.retrieve_context(q, n_results=N_RESULTS)
    rmeta, rdist = raw_top1(q)
    return {
        "q": q,
        "gate_distance": gate_dist,
        "raw_top1": f"{rmeta.get('law')} {rmeta.get('article_id')}({rmeta.get('title')})",
        "raw_top1_distance": rdist,
    }


def evaluate_narrow(case):
    picked, gate_dist = bot.retrieve_context(case["q"], n_results=N_RESULTS)
    got_narrow = [m.get("article_id") for _d, m, _dist in picked
                  if m.get("law") == "근로기준법" and m.get("article_id") in NARROW_ARTICLES]
    return {
        "q": case["q"],
        "expect_narrow": case["expect_narrow"],
        "got_narrow": got_narrow,
        "ok": bool(got_narrow) == case["expect_narrow"],
        "gate_distance": gate_dist,
        "got": [f"{m.get('law')} {m.get('article_id')}({m.get('title')})"
                for _doc, m, _d in picked],
    }


def pct(n, d):
    return f"{n}/{d} ({n / d * 100:5.1f}%)" if d else "-"


def pad(text, width):
    """한글은 터미널에서 두 칸을 차지하므로 글자 수가 아니라 폭으로 맞춘다."""
    w = sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in str(text))
    return str(text) + " " * max(0, width - w)


def main():
    print(f"threshold(현재) = {bot.NO_MATCH_DISTANCE_THRESHOLD}\n")
    labels_ok = validate_labels()

    print(f"■ Positive {len(POSITIVES)}문항 평가 중…")
    pos = [evaluate_positive(it) for it in POSITIVES]
    print(f"■ Negative {len(NEGATIVES)}문항 평가 중…")
    neg = [evaluate_negative(q) for q in NEGATIVES]
    print(f"■ Narrow 필터 {len(NARROW_CASES)}문항 평가 중…\n")
    narrow = [evaluate_narrow(c) for c in NARROW_CASES]

    # ---------------------------------------------------------------- 정답률
    print("=" * 78)
    print("1-2. 검색 정답률 (법령별)")
    print("=" * 78)
    by_law = defaultdict(list)
    for r in pos:
        by_law[r["law"]].append(r)

    header = pad("법령", 24) + pad("문항", 6) + "".join(f"{'top-' + str(k):>16}"
                                                        for k in TOP_K_REPORT)
    print(header)
    print("-" * 78)

    def row(label, rows):
        line = pad(label, 24) + pad(len(rows), 6)
        for k in TOP_K_REPORT:
            n = sum(1 for r in rows if r["hit_rank"] and r["hit_rank"] <= k)
            line += f"{pct(n, len(rows)):>16}"
        print(line)

    for law in sorted(by_law):
        row(law, by_law[law])
    print("-" * 78)
    row("전체", pos)

    # ---------------------------------------------------------------- 오답 목록
    misses = [r for r in pos if r["hit_rank"] is None]
    print(f"\n■ top-{N_RESULTS} 안에도 정답이 없는 문항 {len(misses)}개")
    for r in misses:
        print(f"  Q. {r['q']}")
        print(f"     기대: {r['law']} {', '.join(r['want'])}   (게이트 거리 {r['gate_distance']:.3f})")
        for g in r["got"]:
            print(f"     검색: {g}")

    rank2plus = [r for r in pos if r["hit_rank"] and r["hit_rank"] > 1]
    print(f"\n■ 정답이 1순위가 아닌 문항 {len(rank2plus)}개")
    for r in rank2plus:
        print(f"  {r['hit_rank']}위  {r['q']}  → 1순위는 {r['got'][0]}")

    # ---------------------------------------------------------------- 게이트
    print("\n" + "=" * 78)
    print("게이트 동작 (현재 threshold 기준)")
    print("=" * 78)
    th = bot.NO_MATCH_DISTANCE_THRESHOLD
    pos_blocked = [r for r in pos if r["gate_distance"] is None or r["gate_distance"] > th]
    neg_passed = [r for r in neg if r["gate_distance"] is not None and r["gate_distance"] <= th]
    print(f"  Positive인데 게이트에 막힘(놓침) : {pct(len(pos_blocked), len(pos))}")
    for r in pos_blocked:
        print(f"      {r['gate_distance']:.3f}  {r['q']}")
    print(f"  Negative인데 게이트 통과(오답변 위험): {pct(len(neg_passed), len(neg))}")
    for r in neg_passed:
        print(f"      {r['gate_distance']:.3f}  {r['q']}  → {r['raw_top1']}")

    # ---------------------------------------------------------------- narrow
    print("\n" + "=" * 78)
    print("1-2b. 도급/건설업 narrow 필터")
    print("=" * 78)
    for r in narrow:
        mark = "OK " if r["ok"] else "[!]"
        want = "나와야 함" if r["expect_narrow"] else "걸러져야 함"
        print(f"  {mark} ({want}) {r['q']}")
        print(f"        도급계열 검색결과: {r['got_narrow'] or '없음'}")
        if not r["ok"]:
            for g in r["got"]:
                print(f"        · {g}")
    print(f"\n  통과 {sum(1 for r in narrow if r['ok'])}/{len(narrow)}")

    # ---------------------------------------------------------------- 저장
    OUT_DIR.mkdir(exist_ok=True)
    out = OUT_DIR / "eval_raw.json"
    out.write_text(json.dumps(
        {"threshold_at_run": th, "labels_ok": labels_ok,
         "positives": pos, "negatives": neg, "narrow": narrow},
        ensure_ascii=False, indent=2))
    print(f"\n결과 저장: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
