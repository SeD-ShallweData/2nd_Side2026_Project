"""Follow-up retrieval diagnostics without modifying the sealed Chroma source."""

import argparse
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
RAG_ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(RAG_ROOT))

from questions import (  # noqa: E402
    FOLLOWUP04_DEVELOPMENT,
    FOLLOWUP04_NEGATIVES,
    FOLLOWUP04_VALIDATION,
)


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--group", choices=("development", "validation", "negative", "all", "followup08"), default="all")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--candidate-limit", type=int, default=5)
    return parser.parse_args()


def selected(group):
    if group == "followup08":
        return [{"id": f"F08-D{index + 1}", "q": query, "group": "development"} for index, query in enumerate([
            "월급을 받지 못했다", "월급이 안 들어왔다", "급여 미입금", "월급을 두 달째 안 줬다",
            "퇴직 후 월급을 못 받았다", "사망 후 미지급 임금", "임금 지연이자는?", "퇴직금을 못 받았어요",
            "건설 현장에서 일했는데 하청업체가 임금을 안 줬어요", "산업안전 신호 미확인은 무슨 뜻인가요?",
            "정정한 급여일은 언제였나요?", "코인 매수 추천",
        ])]
    groups = {
        "development": FOLLOWUP04_DEVELOPMENT,
        "validation": FOLLOWUP04_VALIDATION,
        "negative": FOLLOWUP04_NEGATIVES,
    }
    return groups[group] if group != "all" else [
        *(dict(item, group="development") for item in FOLLOWUP04_DEVELOPMENT),
        *(dict(item, group="validation") for item in FOLLOWUP04_VALIDATION),
        *(dict(item, group="negative") for item in FOLLOWUP04_NEGATIVES),
    ]


def candidate_rows(retriever, query, limit):
    model, collection = retriever._load()
    retrieval_query = retriever._expand_query(query)
    embedding = model.encode([retrieval_query], normalize_embeddings=True)
    raw = collection.query(query_embeddings=embedding.tolist(), n_results=max(20, limit * 4))
    return [
        {"rank": index + 1, "citation": retriever._citation(metadata), "distance": round(float(distance), 6)}
        for index, (metadata, distance) in enumerate(zip(raw["metadatas"][0], raw["distances"][0]))
    ][:limit]


def main():
    args = parse_args()
    source_db = RAG_ROOT / "data" / "labor_law_db"
    with tempfile.TemporaryDirectory(prefix="donworry-rag-diagnostics-") as temp_root:
        temp_db = Path(temp_root) / "labor_law_db"
        shutil.copytree(source_db, temp_db)
        os.environ["RAG_DB_PATH"] = str(temp_db)
        import retriever  # noqa: E402

        rows = []
        try:
            for item in selected(args.group):
                result = retriever.retrieve(item["q"], limit=5)
                rows.append({
                    "id": item["id"],
                    "group": item.get("group", args.group),
                    "query": item["q"],
                    "retrieval_query": result["retrieval_query"],
                    "status": result["status"],
                    "reason": result["reason"],
                    "threshold": result["threshold"],
                    "top1_distance": result["top1_distance"],
                    "selected": [
                        {"citation": selected["citation"], "distance": selected["distance"], "document_id": selected["source"]["document_id"]}
                        for selected in result["items"]
                    ],
                    "candidates": candidate_rows(retriever, item["q"], args.candidate_limit),
                })
        finally:
            retriever._reset_for_tests()
    serialized = json.dumps(rows, ensure_ascii=False, indent=2)
    if args.output:
        args.output.write_text(serialized + "\n", encoding="utf-8")
        print(json.dumps({"rows": len(rows), "output": str(args.output)}))
    else:
        print(serialized)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
