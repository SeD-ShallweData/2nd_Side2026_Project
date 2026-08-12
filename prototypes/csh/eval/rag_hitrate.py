"""HB 질문셋을 현재 rag-api(제품 경계)에 태워 top-k 적중률을 잰다. LLM 미사용.

    python3 eval/rag_hitrate.py

HB 원본 평가는 프로토타입의 bot.retrieve_context 를 직접 부르지만, 이 스크립트는
제품이 실제로 쓰는 경로(HTTP /api/retrieve)를 태운다. 그래서 제품 경계에서의
성능을 본다. rag-api 를 먼저 띄워야 한다(README 참고).
"""
import importlib.util
import json
import os
import re
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
QUESTIONS_FILE = REPO / "prototypes" / "hb" / "eval" / "questions.py"

spec = importlib.util.spec_from_file_location("q", QUESTIONS_FILE)
q = importlib.util.module_from_spec(spec)
spec.loader.exec_module(q)

URL = os.getenv("RAG_API_URL", "http://127.0.0.1:5051").rstrip("/") + "/api/retrieve"


def retrieve(query, limit=5):
    body = json.dumps({"query": query, "limit": limit}).encode()
    req = urllib.request.Request(URL, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as res:
        return json.loads(res.read())


def article_of(citation):
    m = re.search(r"(제\s*\d+\s*조(?:의\s*\d+)?)", citation)
    return m.group(1).replace(" ", "") if m else ""


ranks = {1: 0, 3: 0, 5: 0}
misses = []
total = 0

for item in q.POSITIVES:
    total += 1
    want = {a.replace(" ", "") for a in item["articles"]}
    law = item["law"]
    try:
        result = retrieve(item["q"])
    except Exception as exc:
        misses.append((item["q"], law, sorted(want), f"오류: {exc}"))
        continue
    got = [(c["citation"], article_of(c["citation"])) for c in result.get("items", [])]
    hit_rank = None
    for idx, (citation, article) in enumerate(got, 1):
        if article in want and law.replace(" ", "") in citation.replace(" ", ""):
            hit_rank = idx
            break
    if hit_rank:
        for k in (1, 3, 5):
            if hit_rank <= k:
                ranks[k] += 1
    else:
        misses.append((item["q"], law, sorted(want), [c for c, _ in got[:3]]))

print(f"POSITIVES {total}건")
for k in (1, 3, 5):
    print(f"  top-{k} 적중률: {ranks[k]}/{total} = {ranks[k]/total*100:.1f}%")

gated = 0
for text in q.NEGATIVES:
    try:
        if retrieve(text).get("status") != "matched":
            gated += 1
    except Exception:
        pass
print(f"NEGATIVES {len(q.NEGATIVES)}건 중 게이트 차단 {gated}건 = {gated/len(q.NEGATIVES)*100:.1f}%")

print(f"\n실패 {len(misses)}건 (앞 12건)")
for question, law, want, got in misses[:12]:
    print(f"  Q: {question}")
    print(f"     기대: {law} {want}")
    print(f"     실제: {got}")
