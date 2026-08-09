"""프롬프트 배치 평가.

질문 세트를 페르소나·프로바이더 조합으로 한 번에 돌려 결과를 비교합니다.
프롬프트를 고칠 때마다 돌려서 답변이 나아졌는지 눈으로 확인하는 용도입니다.

    .venv/bin/python scripts/eval_prompts.py
    .venv/bin/python scripts/eval_prompts.py --persona wage_arrears --provider skt
    .venv/bin/python scripts/eval_prompts.py --compare        # 두 모델 나란히 비교

결과는 outputs/eval/ (→ /data/shared-SeD/csh/outputs/eval/) 에 JSONL로 남습니다.
"""

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import chat, config, llm, store  # noqa: E402

QUESTION_FILE = config.ROOT / "tests" / "questions.jsonl"


def load_questions(persona_filter: str | None, prefix: str | None) -> list[dict]:
    if not QUESTION_FILE.exists():
        raise SystemExit(f"질문 세트가 없습니다: {QUESTION_FILE}")
    rows = []
    for line in QUESTION_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("//"):
            continue
        item = json.loads(line)
        if persona_filter and item.get("persona") != persona_filter:
            continue
        if prefix and not str(item.get("id", "")).startswith(prefix):
            continue
        rows.append(item)
    return rows


def run(question: dict, provider: str) -> dict:
    started = time.monotonic()
    guardrail = {}
    try:
        result = chat.answer(question["question"], question["persona"], provider)
        answer, error = result["text"], None
        usage = result.get("usage", {})
        guardrail = result.get("guardrail", {})
    except (llm.LLMError, KeyError) as exc:
        answer, error, usage = "", str(exc), {}
    return {
        "id": question.get("id"),
        "persona": question["persona"],
        "provider": provider,
        "question": question["question"],
        "check": question.get("check", ""),
        "answer": answer,
        "error": error,
        "usage": usage,
        "guardrail_blocked": guardrail.get("blocked", False),
        "guardrail_rules": [h["rule"] for h in guardrail.get("hits", [])],
        "elapsed_sec": round(time.monotonic() - started, 2),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--persona", help="특정 페르소나만 실행")
    parser.add_argument("--ids", help="id 접두어로 필터 (예: guard-)")
    parser.add_argument("--provider", help="특정 프로바이더만 실행")
    parser.add_argument("--compare", action="store_true", help="가용한 모든 프로바이더로 실행")
    parser.add_argument("--name", default="eval", help="결과 파일 이름 접미사")
    args = parser.parse_args()

    if args.compare:
        providers = config.available_providers()
    elif args.provider:
        providers = [args.provider]
    else:
        providers = [config.DEFAULT_PROVIDER]

    questions = load_questions(args.persona, args.ids)
    if not questions:
        raise SystemExit("실행할 질문이 없습니다.")

    print(f"질문 {len(questions)}개 × 프로바이더 {len(providers)}개 = {len(questions) * len(providers)}회 호출\n")

    rows = []
    for question in questions:
        print(f"── [{question.get('id', '?')}] {question['question']}")
        if question.get("check"):
            print(f"   확인할 점: {question['check']}")
        for provider in providers:
            row = run(question, provider)
            rows.append(row)
            if row["error"]:
                print(f"   [{provider}] 실패: {row['error']}")
            else:
                guard = f" [가드레일 차단: {','.join(row['guardrail_rules'])}]" if row["guardrail_blocked"] else ""
                preview = row["answer"].replace("\n", " ")[:150]
                print(f"   [{provider}] ({row['elapsed_sec']}초){guard} {preview}…")
        print()

    path = store.save_eval(args.name, rows)
    failed = sum(1 for r in rows if r["error"])
    blocked = sum(1 for r in rows if r["guardrail_blocked"])
    print(f"결과 저장: {path}")
    print(f"성공 {len(rows) - failed}/{len(rows)} · 가드레일 차단 {blocked}건")


if __name__ == "__main__":
    main()
