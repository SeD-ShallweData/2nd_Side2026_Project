"""no_match 임계값 부근의 top-1 거리 분포를 본다. rag-api 만 호출 — LLM 비용 없음.

    python3 eval/threshold_band.py

평가셋(법령 용어에 가까운 문장)과 실사용 말투의 거리 분포가 다른지 보기 위한 것이다.
같은 시스템이라도 입력 말투에 따라 임계값을 넘고 못 넘는 비율이 달라진다.
"""
import importlib.util
import json
import os
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
QUESTIONS_FILE = REPO / "prototypes" / "hb" / "eval" / "questions.py"

spec = importlib.util.spec_from_file_location("q", QUESTIONS_FILE)
q = importlib.util.module_from_spec(spec)
spec.loader.exec_module(q)

RAG_URL = os.getenv("RAG_API_URL", "http://127.0.0.1:5051").rstrip("/") + "/api/retrieve"

REALISTIC = [
    "주휴수당은 어떤 조건에서 받나요?", "야근수당을 안 주는데 얼마를 받아야 하나요?",
    "연차를 안 쓰면 돈으로 받을 수 있나요?", "월급이 두 달째 밀렸어요. 뭘 먼저 해야 하나요?",
    "회사가 망했는데 밀린 월급을 받을 수 있나요?", "근로계약서를 아직 못 받았어요",
    "휴게시간을 안 주는데 괜찮은 건가요?", "4대보험에 가입을 안 시켜줘요",
    "직장 내 괴롭힘을 당했는데 어디에 신고하나요?", "주 52시간을 넘겨 일하고 있어요",
    "포괄임금제면 야근수당을 못 받나요?", "수습기간에도 최저임금을 다 받아야 하나요?",
]
THRESHOLD = float(os.getenv("RAG_DISTANCE_THRESHOLD", "0.42"))


def retrieve(query):
    body = json.dumps({"query": query, "limit": 5}).encode()
    req = urllib.request.Request(RAG_URL, data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as res:
        return json.loads(res.read())


def survey(label, questions):
    band = {"<0.35": 0, "0.35~0.42": 0, "0.42~0.46(아슬하게 탈락)": 0, ">0.46": 0}
    near = []
    for question in questions:
        result = retrieve(question)
        top1 = result.get("top1_distance")
        if top1 is None:
            continue
        if top1 < 0.35:
            band["<0.35"] += 1
        elif top1 < THRESHOLD:
            band["0.35~0.42"] += 1
        elif top1 < 0.46:
            band["0.42~0.46(아슬하게 탈락)"] += 1
            near.append((question, round(top1, 4)))
        else:
            band[">0.46"] += 1
    print(f"\n[{label}] {len(questions)}건")
    for key, count in band.items():
        print(f"  {key:26} {count:3}건")
    if near:
        print("  아슬하게 탈락한 질문:")
        for question, distance in near:
            print(f"    {distance}  {question}")


survey("HB POSITIVES (정답이 DB에 있는 질문)", [item["q"] for item in q.POSITIVES])
survey("실사용에 가까운 질문", REALISTIC)
survey("NEGATIVES (DB 밖 질문 — 걸러져야 정상)", list(q.NEGATIVES))
