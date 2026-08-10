"""Flask 엔트리포인트.

    ./run.sh          → http://localhost:8000   랜딩
                      → http://localhost:8000/chat  AI 상담 (모델 비교)
"""

import json
import uuid

from flask import Flask, Response, jsonify, request, send_from_directory

from . import chat, config, demo, guardrails, llm, prompts, store
from .contract import parse as contract_parse
from .contract import review as contract_review

app = Flask(__name__, static_folder=str(config.WEB_DIR), static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024


# ── 페이지 ────────────────────────────────────────────────────────────
@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/chat")
def chat_page():
    return send_from_directory(app.static_folder, "chat.html")


@app.get("/contract")
def contract_page():
    return send_from_directory(app.static_folder, "contract.html")


@app.get("/download")
def download_index():
    """공유용 산출물 목록. 브라우저로 받아 가라고 두는 경로입니다."""
    items = sorted(p.name for p in config.EXPORT_DIR.glob("*.html")) if config.EXPORT_DIR.exists() else []
    links = "".join(f'<li><a href="/download/{n}" download>{n}</a></li>' for n in items)
    return (f'<meta charset="utf-8"><h2>공유용 산출물</h2><ul>{links or "<li>없음</li>"}</ul>'
            '<p>링크를 눌러 PC로 내려받은 뒤 노션에 업로드하세요.</p>')


@app.get("/download/<path:name>")
def download_file(name):
    return send_from_directory(config.EXPORT_DIR, name, as_attachment=True)


# ── 상태 ──────────────────────────────────────────────────────────────
@app.get("/api/health")
def health():
    """키·프롬프트·지식 로딩 상태. 키 값 자체는 내려주지 않습니다."""
    return jsonify({
        "providers": {
            name: {"label": cfg["label"], "model": cfg["model"], "key": bool(cfg["api_key"])}
            for name, cfg in config.PROVIDERS.items()
        },
        "default_provider": config.DEFAULT_PROVIDER,
        "key_file_error": config.TEAM_ENV_ERROR,
        "personas": [p["id"] for p in prompts.personas()],
        "knowledge": prompts.knowledge_stats(),
        "knowledge_budget": config.KNOWLEDGE_BUDGET,
        "rewrite_enabled": config.REWRITE_ENABLED,
        "guardrails_enabled": config.GUARDRAILS_ENABLED,
        "guardrail_mode": config.GUARDRAIL_MODE,
        "guardrail_rules": [r.id for r in guardrails.RULES],
        "contract": {
            "enabled": config.CONTRACT_ENABLED,
            "parse_url": contract_parse.PARSE_URL,
            "parse_model": contract_parse.PARSE_MODEL,
            "cache": config.CONTRACT_CACHE_ENABLED,
            "samples": [s["id"] for s in _contract_samples()],
            **contract_review.standards_summary(),
        },
    })


@app.get("/api/personas")
def persona_list():
    return jsonify({
        "personas": prompts.personas(),
        "providers": [
            {"id": name, "label": cfg["label"], "model": cfg["model"]}
            for name, cfg in config.PROVIDERS.items()
            if cfg["api_key"]
        ],
        "default_provider": config.DEFAULT_PROVIDER,
        "key_file_error": config.TEAM_ENV_ERROR,
        "rewrite_enabled": config.REWRITE_ENABLED,
        "guardrails_enabled": config.GUARDRAILS_ENABLED,
        "guardrail_mode": config.GUARDRAIL_MODE,
    })


# ── 더미 데이터 (모델·실데이터 연결 전) ───────────────────────────────
@app.get("/api/demo/workplaces")
def demo_workplaces():
    return jsonify({"items": demo.list_cards(), "note": "전부 가상 데이터입니다."})


@app.get("/api/demo/workplace/<name>")
def demo_workplace(name):
    found = demo.find(name)
    if not found:
        return jsonify({"error": "공개 데이터에서 찾지 못했습니다."}), 404
    return jsonify(found)


@app.get("/api/demo/community")
def demo_community():
    return jsonify({"items": demo.COMMUNITY, "stats": demo.STATS})


# ── 근로계약서 진단 ───────────────────────────────────────────────────
# 파이프라인은 app/contract/review.py 에 있습니다.
#   업로드 → Document Parse → 조항 추출(LLM) → **규칙 엔진(코드)** → 해설(LLM)
# 판정과 해설을 두 요청으로 나눕니다. 판정은 결정적이라 한 번만 계산하고,
# 해설만 모델을 바꿔가며 여러 번 받을 수 있습니다.
def _contract_samples() -> list[dict]:
    """더미 근로계약서 목록. scripts/make_contract_samples.py 가 만든 manifest를 읽습니다."""
    manifest = config.CONTRACT_SAMPLE_DIR / "manifest.json"
    try:
        items = json.loads(manifest.read_text(encoding="utf-8"))["samples"]
    except (OSError, json.JSONDecodeError, KeyError, TypeError):
        return []
    return [s for s in items if (config.CONTRACT_SAMPLE_DIR / s["file"]).exists()]


@app.get("/api/contract/samples")
def contract_samples():
    items = _contract_samples()
    return jsonify({
        "items": items,
        "note": "전부 가상의 근로계약서입니다. 실존 사업장과 무관합니다."
                if items else "샘플이 없습니다. scripts/make_contract_samples.py 를 실행하세요.",
    })


@app.get("/api/contract/samples/<name>")
def contract_sample_file(name):
    """샘플 PDF 원본. 화면에서 '계약서 원본 보기'로 띄웁니다."""
    match = next((s for s in _contract_samples() if s["id"] == name), None)
    if not match:
        return jsonify({"error": "그런 샘플이 없습니다."}), 404
    return send_from_directory(config.CONTRACT_SAMPLE_DIR, match["file"])


def _read_upload() -> tuple[bytes, str]:
    """업로드 파일 또는 샘플 id 를 바이트로 돌려줍니다."""
    sample_id = (request.form.get("sample") or "").strip()
    if sample_id:
        match = next((s for s in _contract_samples() if s["id"] == sample_id), None)
        if not match:
            raise contract_parse.ParseError(f"그런 샘플이 없습니다: {sample_id}")
        path = config.CONTRACT_SAMPLE_DIR / match["file"]
        return path.read_bytes(), match["file"]

    file = request.files.get("file")
    if file is None or not file.filename:
        raise contract_parse.ParseError("계약서 파일이 없습니다.")
    return file.read(), file.filename


@app.post("/api/contract/review")
def contract_review_route():
    """파일 하나를 파싱·추출·판정까지 합니다. 해설은 별도 요청입니다."""
    if not config.CONTRACT_ENABLED:
        return jsonify({"error": "근로계약서 진단이 꺼져 있습니다 (CONTRACT_ENABLED=0)."}), 503
    if not config.PROVIDERS["upstage"]["api_key"]:
        # 키가 없는 것은 사용자 잘못이 아니므로 400(잘못된 요청)으로 내리지 않습니다.
        return jsonify({"error": "문서 인식에 필요한 Upstage API 키가 없습니다. "
                                 f"{config.TEAM_ENV_FILE}를 확인하세요."}), 503

    try:
        data, filename = _read_upload()
        result = contract_review.review(
            data, filename,
            ocr=(request.form.get("ocr") or "auto"),
            extract_provider=(request.form.get("extract_provider") or "").strip() or None,
            with_explanation=False,
        )
    except contract_parse.ParseError as exc:
        return jsonify({"error": str(exc)}), 400
    except contract_review.ReviewError as exc:
        return jsonify({"error": str(exc)}), 502
    except llm.LLMError as exc:
        return jsonify({"error": str(exc)}), 502
    except OSError as exc:
        return jsonify({"error": f"파일을 읽지 못했습니다: {exc}"}), 400

    if not result["ok"]:
        return jsonify(result), 422

    review_id = uuid.uuid4().hex[:16]
    contract_review.remember(review_id, {"contract": result["contract"],
                                         "verdict": result["verdict"]})
    return jsonify({**result, "review_id": review_id, "filename": filename})


@app.post("/api/contract/explain/stream")
def contract_explain_stream():
    """판정 결과를 사람 말로 푸는 해설. SSE. 모델 비교는 이걸 2번 병렬 호출합니다."""
    data = request.get_json(silent=True) or {}
    saved = contract_review.recall((data.get("review_id") or "").strip())
    if saved is None:
        return jsonify({"error": "진단 결과를 찾지 못했습니다. 파일을 다시 올려 주세요."}), 404

    provider = (data.get("provider") or "").strip() or None
    question = (data.get("question") or "").strip() or None

    def events():
        try:
            for event in contract_review.explain_stream(
                    saved["verdict"], saved["contract"], provider, question):
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        except (llm.LLMError, KeyError) as exc:
            yield f"data: {json.dumps({'error': str(exc)}, ensure_ascii=False)}\n\n"
        yield "data: [DONE]\n\n"

    return Response(events(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── 대화 ──────────────────────────────────────────────────────────────
def _parse():
    data = request.get_json(silent=True) or {}
    return {
        "message": (data.get("message") or "").strip(),
        "persona": (data.get("persona") or "general").strip(),
        "provider": (data.get("provider") or "").strip() or None,
        "history": data.get("history"),
        "resolved_query": (data.get("resolved_query") or "").strip() or None,
    }


@app.post("/api/rewrite")
def rewrite():
    """호출 ① — 후속 질문을 독립 질문으로 재작성합니다.

    두 모델을 비교할 때 같은 질의로 출발해야 공정하므로,
    프런트가 이 엔드포인트를 한 번 호출한 뒤 결과를 양쪽 스트림에 넘깁니다.
    """
    req = _parse()
    if not req["message"]:
        return jsonify({"error": "질문이 비어 있습니다."}), 400
    return jsonify(chat.rewrite_query(req["message"], req["history"]))


@app.post("/api/chat")
def chat_once():
    req = _parse()
    if not req["message"]:
        return jsonify({"error": "질문이 비어 있습니다."}), 400
    try:
        result = chat.answer(req["message"], req["persona"], req["provider"],
                             req["history"], req["resolved_query"])
    except KeyError as exc:
        return jsonify({"error": str(exc)}), 400
    except llm.LLMError as exc:
        return jsonify({"error": str(exc)}), 502
    return jsonify(result)


@app.post("/api/chat/stream")
def chat_stream():
    req = _parse()
    if not req["message"]:
        return jsonify({"error": "질문이 비어 있습니다."}), 400

    def events():
        try:
            for event in chat.answer_stream(req["message"], req["persona"], req["provider"],
                                            req["history"], req["resolved_query"]):
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        except (llm.LLMError, KeyError) as exc:
            yield f"data: {json.dumps({'error': str(exc)}, ensure_ascii=False)}\n\n"
        yield "data: [DONE]\n\n"

    return Response(events(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/feedback")
def feedback():
    """모델 비교 화면의 '이쪽이 낫다' 투표."""
    data = request.get_json(silent=True) or {}
    if not data.get("winner"):
        return jsonify({"error": "winner가 필요합니다."}), 400
    store.log_feedback({
        "winner": data.get("winner"),
        "persona": data.get("persona"),
        "question": data.get("question"),
        "answers": data.get("answers"),
        "note": data.get("note"),
    })
    return jsonify({"ok": True})


def main():
    if config.TEAM_ENV_ERROR:
        # 키를 못 읽어도 서버는 뜹니다. 화면과 더미 데이터는 그대로 볼 수 있고
        # LLM을 부르는 기능(상담·계약서 진단)만 막힙니다.
        print(f"[주의] 팀 공용 키 파일을 {config.TEAM_ENV_ERROR}")
        if config.available_providers():
            print(f"       {config.LOCAL_ENV_FILE.name} 의 값으로 동작합니다.")
        else:
            print("       LLM 기능은 비활성 상태로 뜹니다. 화면·더미 데이터는 정상입니다.")
            print(f"       권한 복구: sudo chmod 644 {config.TEAM_ENV_FILE}")
            print("       임시 우회: .venv/bin/python scripts/set_local_keys.py")
    print(f"프로바이더: {', '.join(config.available_providers()) or '(키 없음)'}")
    print(f"재작성 체이닝: {'ON' if config.REWRITE_ENABLED else 'OFF'} · "
          f"가드레일: {'ON' if config.GUARDRAILS_ENABLED else 'OFF'}")
    print(f"http://localhost:{config.PORT}")
    app.run(host=config.HOST, port=config.PORT, debug=config.DEBUG, threaded=True)


if __name__ == "__main__":
    main()
