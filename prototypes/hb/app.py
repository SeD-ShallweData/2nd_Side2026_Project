import json

from flask import Flask, request, jsonify, send_from_directory

import bot
import contract_review

app = Flask(__name__, static_folder="static", static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024  # 20MB


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


def normalize_history(raw):
    """프런트에서 온 대화 히스토리를 [{role, text}] 형태로 정리한다."""
    if not isinstance(raw, list):
        return []
    out = []
    for m in raw:
        if not isinstance(m, dict):
            continue
        text = (m.get("text") or "").strip()
        if not text:
            continue
        role = "bot" if str(m.get("role", "")).startswith("bot") else "user"
        out.append({"role": role, "text": text})
    return out


@app.post("/api/chat")
def chat():
    data = request.get_json(silent=True) or {}
    message = (data.get("message") or "").strip()
    persona = (data.get("persona") or "").strip()
    contract_context = data.get("contract_context")
    history = normalize_history(data.get("history"))

    if not message:
        return jsonify({"error": "질문 내용을 입력해주세요."}), 400

    try:
        if contract_context and contract_review.is_contract_followup(message):
            answer = contract_review.answer_contract_followup(
                message,
                contract_context.get("missing_items") or [],
                contract_context.get("extracted") or {},
                history=history,
            )
        elif persona in bot.SYSTEM_PROMPTS:
            answer = bot.ask_donworry(message, persona, history=history)
        else:
            answer = bot.ask_donworry_auto(message, history=history)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    return jsonify({"answer": answer})


@app.post("/check-contract")
def check_contract():
    f = request.files.get("file")
    if f is None or f.filename == "":
        return jsonify({"error": "file is required"}), 400

    # 첨부만으로는 응답하지 않는다. 질문 텍스트가 반드시 함께 와야 한다.
    message = (request.form.get("message") or "").strip()
    if not message:
        return jsonify({"error": "질문 내용을 입력해주세요."}), 400

    try:
        history = normalize_history(json.loads(request.form.get("history") or "[]"))
    except (ValueError, TypeError):
        history = []

    file_bytes = f.read()

    try:
        fields = contract_review.extract_contract_fields(file_bytes)
    except Exception as e:
        return jsonify({"error": f"문서 분석 중 오류가 발생했습니다: {e}"}), 500

    missing = contract_review.find_missing_items(fields)

    try:
        answer = contract_review.generate_review_message(
            missing, fields, question=message, history=history
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    return jsonify({"answer": answer, "missing_items": missing, "extracted": fields})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5050, debug=False, threaded=True)
