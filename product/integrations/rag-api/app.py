import os

from flask import Flask, jsonify, request

import retriever

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 32 * 1024


@app.get("/api/health")
def health():
    return jsonify({"ok": True, "service": "donworry-rag", **retriever.status()})


@app.post("/api/retrieve")
def retrieve():
    data = request.get_json(silent=True) or {}
    query = str(data.get("query") or "").strip()
    if not query:
        return jsonify({"error": {"code": "VALIDATION_ERROR", "message": "query is required"}}), 400
    try:
        limit = int(data.get("limit") or 5)
        return jsonify(retriever.retrieve(query, limit))
    except ValueError as error:
        return jsonify({"error": {"code": "VALIDATION_ERROR", "message": str(error)}}), 400
    except retriever.RetrievalUnavailable as error:
        return jsonify({"error": {"code": "RAG_UNAVAILABLE", "message": str(error)}}), 503
    except Exception:
        return jsonify({"error": {"code": "RAG_INTERNAL_ERROR", "message": "검색 중 오류가 발생했습니다."}}), 500


if __name__ == "__main__":
    if os.getenv("RAG_PRELOAD", "1") == "1":
        try:
            retriever.warmup()
            print("RAG 모델과 노동법 컬렉션을 불러왔습니다.")
        except Exception as error:
            print(f"[주의] RAG 사전 로딩 실패: {error}")
    app.run(
        host=os.getenv("RAG_HOST", "127.0.0.1"),
        port=int(os.getenv("RAG_PORT", "5051")),
        debug=False,
        threaded=True,
    )
