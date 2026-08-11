"""돈워리 공식 노동법 검색 전용 서비스.

HB 프로토타입에서 검증한 BGE-M3 + Chroma 검색 정책을 제품용 경계로 분리했다.
이 모듈은 LLM을 호출하지 않고 검색 근거만 반환한다.
"""

import os
import threading
from pathlib import Path

import chromadb
from sentence_transformers import SentenceTransformer

ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.getenv("RAG_DB_PATH", ROOT / "data" / "labor_law_db"))
COLLECTION_NAME = os.getenv("RAG_COLLECTION", "labor_law")
MODEL_NAME = os.getenv("RAG_EMBEDDING_MODEL", "BAAI/bge-m3")
DEVICE = os.getenv("RAG_DEVICE", "cpu")
NO_MATCH_DISTANCE_THRESHOLD = float(os.getenv("RAG_DISTANCE_THRESHOLD", "0.42"))

NARROW_ARTICLE_KEYWORDS = ("도급", "하도급", "수급인", "건설업", "건설산업")
NARROW_TRIGGER_KEYWORDS = ("도급", "하도급", "수급", "건설", "하청", "원청")

_lock = threading.Lock()
_model = None
_collection = None


class RetrievalUnavailable(RuntimeError):
    pass


def _load():
    global _model, _collection
    if _model is not None and _collection is not None:
        return _model, _collection
    with _lock:
        if _model is not None and _collection is not None:
            return _model, _collection
        if not DB_PATH.is_dir():
            raise RetrievalUnavailable(f"RAG DB를 찾을 수 없습니다: {DB_PATH}")
        _model = SentenceTransformer(MODEL_NAME, device=DEVICE)
        client = chromadb.PersistentClient(path=str(DB_PATH))
        _collection = client.get_collection(COLLECTION_NAME)
        return _model, _collection


def _citation(meta):
    clause = meta.get("clause") or ""
    return f"{meta.get('law', '')} {meta.get('article_id', '')}{clause}".strip()


def _is_narrow(meta):
    title = str(meta.get("title") or "")
    return any(keyword in title for keyword in NARROW_ARTICLE_KEYWORDS)


def _pick(candidates, query, limit):
    allow_narrow = any(keyword in query for keyword in NARROW_TRIGGER_KEYWORDS)
    picked = []
    seen = set()

    for allow in (allow_narrow, True):
        for document, metadata, distance in candidates:
            article_id = metadata.get("article_id")
            if not article_id or article_id in seen:
                continue
            if not allow and _is_narrow(metadata):
                continue
            seen.add(article_id)
            picked.append((document, metadata, distance))
            if len(picked) >= limit:
                return picked
    return picked


def retrieve(query, limit=5):
    query = " ".join(str(query or "").split())
    if not query:
        raise ValueError("query is required")
    limit = max(1, min(int(limit), 8))
    model, collection = _load()
    embedding = model.encode([query], normalize_embeddings=True)
    candidate_pool = max(12, limit * 2)
    result = collection.query(query_embeddings=embedding.tolist(), n_results=candidate_pool)
    candidates = list(zip(
        result.get("documents", [[]])[0],
        result.get("metadatas", [[]])[0],
        result.get("distances", [[]])[0],
    ))
    top_distance = candidates[0][2] if candidates else None

    if top_distance is None or top_distance > NO_MATCH_DISTANCE_THRESHOLD:
        return {
            "query": query,
            "status": "no_match",
            "threshold": NO_MATCH_DISTANCE_THRESHOLD,
            "top1_distance": top_distance,
            "items": [],
        }

    items = []
    for document, metadata, distance in _pick(candidates, query, limit):
        citation = _citation(metadata)
        if not citation or not document:
            continue
        items.append({
            "content": document,
            "citation": citation,
            "distance": distance,
            "source": {
                "name": metadata.get("title") or citation,
                "organization": "국가법령정보센터",
                "document_id": citation,
            },
        })

    return {
        "query": query,
        "status": "matched" if items else "no_match",
        "threshold": NO_MATCH_DISTANCE_THRESHOLD,
        "top1_distance": top_distance,
        "items": items,
    }


def warmup():
    """서버가 요청을 받기 전에 모델과 컬렉션을 검증해 첫 질문 지연을 앞당긴다."""
    _load()


def status():
    return {
        "database_exists": DB_PATH.is_dir(),
        "collection": COLLECTION_NAME,
        "embedding_model": MODEL_NAME,
        "device": DEVICE,
        "loaded": _model is not None and _collection is not None,
        "threshold": NO_MATCH_DISTANCE_THRESHOLD,
    }
