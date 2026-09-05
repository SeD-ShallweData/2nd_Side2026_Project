import hashlib
import hmac
import os

from flask import Flask, jsonify, request

import retriever

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 32 * 1024


def _authorized_internal_request() -> bool:
    expected = os.getenv("RAG_INTERNAL_TOKEN", "")
    authorization = request.headers.get("Authorization", "")
    candidate = authorization[len("Bearer "):] if authorization.startswith("Bearer ") else ""
    expected_digest = hashlib.sha256(expected.encode("utf-8")).digest()
    candidate_digest = hashlib.sha256(candidate.encode("utf-8")).digest()
    return bool(expected) and hmac.compare_digest(expected_digest, candidate_digest)


@app.before_request
def require_internal_authentication():
    if _authorized_internal_request():
        return None
    return (
        jsonify({"error": {"code": "UNAUTHORIZED", "message": "internal authentication required"}}),
        401,
        {"WWW-Authenticate": "Bearer"},
    )


@app.get("/api/health")
def health():
    status = retriever.status()
    return (
        jsonify({"ok": status["ready"], "service": "donworry-rag", **status}),
        200 if status["ready"] else 503,
    )


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
        retriever.warmup()
        print("RAG 모델·컬렉션 무결성과 고정 질의 호환성을 검증했습니다.")
    app.run(
        host=os.getenv("RAG_HOST", "127.0.0.1"),
        port=int(os.getenv("RAG_PORT", "5051")),
        debug=False,
        threaded=True,
    )
