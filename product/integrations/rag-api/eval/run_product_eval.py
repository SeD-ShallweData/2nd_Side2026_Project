"""Product RAG 회귀 평가.

추적 중인 Chroma 파일이 단순 조회로 바뀌지 않도록 매 실행마다 임시 복제본을 쓴다.
HB의 90개 positive/16개 negative 기준과 Product 생활어 회귀셋을 함께 검사한다.
"""

import argparse
import os
import shutil
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
RAG_ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(RAG_ROOT))

from questions import (  # noqa: E402
    NARROW_ARTICLES,
    NARROW_CASES,
    NEGATIVES,
    POSITIVES,
    USER_LANGUAGE_REGRESSIONS,
)


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--min-top1", type=float, default=0.744)
    parser.add_argument("--min-top5", type=float, default=0.922)
    parser.add_argument("--require-negative", type=float, default=1.0)
    return parser.parse_args()


def citation_matches(citation, law, articles):
    return any(citation == f"{law} {article}" or citation.startswith(f"{law} {article} ") for article in articles)


def evaluate_positive(retriever, item):
    result = retriever.retrieve(item["q"], limit=5)
    citations = [entry["citation"] for entry in result["items"]]
    hits = [citation_matches(citation, item["law"], item["articles"]) for citation in citations]
    return {
        "question": item["q"],
        "rank": hits.index(True) + 1 if any(hits) else None,
        "citations": citations,
        "status": result["status"],
    }


def evaluate_narrow(retriever, case):
    result = retriever.retrieve(case["q"], limit=5)
    got_narrow = []
    for item in result["items"]:
        citation = item["citation"]
        for article in NARROW_ARTICLES:
            if citation == f"근로기준법 {article}" or citation.startswith(f"근로기준법 {article} "):
                got_narrow.append(article)
    return bool(got_narrow) == case["expect_narrow"]


def score(rows, rank):
    return sum(1 for row in rows if row["rank"] and row["rank"] <= rank) / len(rows)


def main():
    args = parse_args()
    if len(POSITIVES) != 90 or len(NEGATIVES) != 16:
        print(f"평가셋 크기 변경 감지: positive={len(POSITIVES)}, negative={len(NEGATIVES)}", file=sys.stderr)
        return 2

    source_db = RAG_ROOT / "data" / "labor_law_db"
    with tempfile.TemporaryDirectory(prefix="donworry-rag-eval-") as temp_root:
        temp_db = Path(temp_root) / "labor_law_db"
        shutil.copytree(source_db, temp_db)
        os.environ["RAG_DB_PATH"] = str(temp_db)

        import retriever  # noqa: E402

        core = [evaluate_positive(retriever, item) for item in POSITIVES]
        regressions = [evaluate_positive(retriever, item) for item in USER_LANGUAGE_REGRESSIONS]
        negatives = [retriever.retrieve(question, limit=5)["status"] == "no_match" for question in NEGATIVES]
        narrow = [evaluate_narrow(retriever, case) for case in NARROW_CASES]

    top1 = score(core, 1)
    top5 = score(core, 5)
    negative_rate = sum(negatives) / len(negatives)
    print(f"HB core top-1: {top1:.1%} ({sum(1 for row in core if row['rank'] == 1)}/{len(core)})")
    print(f"HB core top-5: {top5:.1%} ({sum(1 for row in core if row['rank'] and row['rank'] <= 5)}/{len(core)})")
    print(f"NEGATIVE 차단: {negative_rate:.1%} ({sum(negatives)}/{len(negatives)})")
    print(f"narrow 필터: {sum(narrow)}/{len(narrow)}")
    for row in regressions:
        print(f"생활어 회귀: {'PASS' if row['rank'] else 'FAIL'} · {row['question']} · {row['citations'][:2]}")

    failures = []
    if top1 < args.min_top1:
        failures.append(f"top-1 {top1:.3f} < {args.min_top1:.3f}")
    if top5 < args.min_top5:
        failures.append(f"top-5 {top5:.3f} < {args.min_top5:.3f}")
    if negative_rate < args.require_negative:
        failures.append(f"negative {negative_rate:.3f} < {args.require_negative:.3f}")
    if not all(narrow):
        failures.append("narrow 필터 회귀")
    if not all(row["rank"] for row in regressions):
        failures.append("생활어 회귀셋 실패")

    if failures:
        print("RAG 품질 게이트 실패: " + ", ".join(failures), file=sys.stderr)
        missed = [row for row in core if row["rank"] is None]
        for row in missed:
            print(f"MISS · {row['question']} · {row['citations'][:3]}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
