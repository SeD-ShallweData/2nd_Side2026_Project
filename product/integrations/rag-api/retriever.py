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
STRONG_MATCH_DISTANCE = float(os.getenv("RAG_STRONG_MATCH_DISTANCE", "0.30"))

QUERY_EXPANSION_RULES = (
    {
        "triggers": ("실업급여", "실업 급여"),
        "exclude": (),
        "expansion": "구직급여 수급 요건 소정급여일수",
    },
    {
        "triggers": (
            "나오지 마", "나오지마", "나오지 말", "나오지말", "나오래", "나오라고",
            "나오라는", "그만두라", "그만 나오", "그만나오", "관두라", "나가라",
            "나가래", "짤렸", "잘렸", "짤린", "잘린",
        ),
        "exclude": ("일찍", "늦게", "몇 시", "일찍이"),
        "expansion": "해고 통보 해고의 예고 서면통지",
    },
    {
        "triggers": ("연차",),
        "exclude": (),
        "expansion": "연차 유급휴가",
    },
)

NARROW_RULES = (
    {
        "article_keywords": ("도급", "하도급", "수급인", "건설업", "건설산업"),
        "trigger_keywords": ("도급", "하도급", "수급", "건설", "하청", "원청"),
    },
    {
        "article_keywords": ("자영업자",),
        "trigger_keywords": ("자영업", "사업자", "개인사업", "폐업", "가게", "장사"),
    },
    {
        "article_keywords": ("예술인",),
        "trigger_keywords": ("예술인", "예술", "공연", "creator"),
    },
    {
        "article_keywords": ("노무제공자", "노무제공플랫폼"),
        "trigger_keywords": ("노무제공", "플랫폼", "배달", "대리운전", "프리랜서", "특수고용"),
    },
)

OUT_OF_SCOPE_TOPICS = (
    {
        "name": "산업재해·산업안전",
        "keywords": (
            "산재보험", "산업재해보상", "근로복지공단", "산업안전보건", "중대재해",
            "산재 신청", "산재신청",
        ),
    },
    {
        "name": "4대보험",
        "keywords": ("4대보험", "사대보험", "국민연금", "건강보험", "장기요양보험"),
    },
    {
        "name": "노동조합",
        "keywords": ("노동조합", "노조 설립", "노조를", "단체교섭", "쟁의행위", "파업"),
    },
    {
        "name": "파견·기간제",
        "keywords": ("파견근로", "파견직", "파견업체", "기간제", "정규직 전환"),
    },
)

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


def _expand_query(query):
    """사용자 표현과 법령 용어가 다를 때 검색 질의에만 최소한의 동의어를 보탠다."""
    expansions = []
    for rule in QUERY_EXPANSION_RULES:
        if any(keyword in query for keyword in rule["exclude"]):
            continue
        if any(keyword in query for keyword in rule["triggers"]):
            expansions.append(rule["expansion"])
    return f"{query} {' '.join(expansions)}" if expansions else query


def _narrow_allowed(meta, query):
    """특수대상 전용 조문은 질문이 같은 대상을 직접 말한 경우에만 우선 노출한다."""
    article_context = f"{meta.get('title') or ''} {meta.get('chapter') or ''}"
    matched_rules = [
        rule for rule in NARROW_RULES
        if any(keyword in article_context for keyword in rule["article_keywords"])
    ]
    if not matched_rules:
        return True
    return any(
        any(keyword in query for keyword in rule["trigger_keywords"])
        for rule in matched_rules
    )


def _out_of_scope_topic(query, top_distance):
    if top_distance is not None and top_distance <= STRONG_MATCH_DISTANCE:
        return None
    for topic in OUT_OF_SCOPE_TOPICS:
        if any(keyword in query for keyword in topic["keywords"]):
            return topic["name"]
    return None


def _pick(candidates, query, limit):
    picked = []
    seen = set()

    # 먼저 질문 맥락과 맞는 일반 조문만 고르고, 수가 모자랄 때만 특수대상 조문으로 채운다.
    for include_disallowed_narrow in (False, True):
        for document, metadata, distance in candidates:
            article_id = metadata.get("article_id")
            article_key = (metadata.get("law"), article_id)
            if not article_id or article_key in seen:
                continue
            if not include_disallowed_narrow and not _narrow_allowed(metadata, query):
                continue
            seen.add(article_key)
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
    retrieval_query = _expand_query(query)
    embedding = model.encode([retrieval_query], normalize_embeddings=True)
    candidate_pool = max(20, limit * 4)
    result = collection.query(query_embeddings=embedding.tolist(), n_results=candidate_pool)
    candidates = list(zip(
        result.get("documents", [[]])[0],
        result.get("metadatas", [[]])[0],
        result.get("distances", [[]])[0],
    ))
    top_distance = candidates[0][2] if candidates else None

    topic = _out_of_scope_topic(query, top_distance)
    if topic:
        return {
            "query": query,
            "retrieval_query": retrieval_query,
            "status": "no_match",
            "reason": "out_of_scope",
            "topic": topic,
            "threshold": NO_MATCH_DISTANCE_THRESHOLD,
            "top1_distance": top_distance,
            "items": [],
        }

    if top_distance is None or top_distance > NO_MATCH_DISTANCE_THRESHOLD:
        return {
            "query": query,
            "retrieval_query": retrieval_query,
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
        "retrieval_query": retrieval_query,
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
        "strong_match_threshold": STRONG_MATCH_DISTANCE,
        "document_count": _collection.count() if _collection is not None else None,
    }
