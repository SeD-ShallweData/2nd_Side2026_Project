"""돈워리 공식 노동법 검색 전용 서비스.

HB 프로토타입에서 검증한 BGE-M3 + Chroma 검색 정책을 제품용 경계로 분리했다.
이 모듈은 LLM을 호출하지 않고 검색 근거만 반환한다.
"""

import json
import math
import os
import threading
from numbers import Real
from pathlib import Path

# Runtime model resolution is offline by default.  Production also pins these
# values in run-gunicorn.sh before Python starts.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

from asset_manifest import (  # noqa: E402
    AssetContractError,
    load_manifest,
    manifest_sha256,
    verify_runtime_assets,
)

ROOT = Path(__file__).resolve().parent
PINNED_MODEL_NAME = "BAAI/bge-m3"
PINNED_MODEL_REVISION = "5617a9f61b028005a4858fdac845db406aefb181"
PINNED_DOCUMENT_COUNT = 583
PINNED_EMBEDDING_DIMENSION = 1024
PINNED_DISTANCE_THRESHOLD = 0.42
PINNED_STRONG_MATCH_DISTANCE = 0.30
PINNED_ASSET_MANIFEST_SHA256 = "f67ceeb88695eb9f681839bee857ea00e6b8f59853981180a13df547323b30d0"
ASSET_MANIFEST_PATH = Path(
    os.getenv("RAG_ASSET_MANIFEST", ROOT / "config" / "rag_assets.v1.json")
)
ASSET_MANIFEST = load_manifest(ASSET_MANIFEST_PATH)
if (
    ASSET_MANIFEST.model.repo_id != PINNED_MODEL_NAME
    or ASSET_MANIFEST.model.revision != PINNED_MODEL_REVISION
    or ASSET_MANIFEST.model.embedding_dimension != PINNED_EMBEDDING_DIMENSION
    or ASSET_MANIFEST.collection.document_count != PINNED_DOCUMENT_COUNT
    or manifest_sha256(ASSET_MANIFEST) != PINNED_ASSET_MANIFEST_SHA256
):
    raise AssetContractError("committed RAG manifest does not match the application pins")

DB_PATH = Path(os.getenv("RAG_DB_PATH", ROOT / "data" / "labor_law_db"))
COLLECTION_NAME = os.getenv("RAG_COLLECTION", ASSET_MANIFEST.collection.name)
MODEL_NAME = os.getenv("RAG_EMBEDDING_MODEL", ASSET_MANIFEST.model.repo_id)
MODEL_REVISION = os.getenv("RAG_MODEL_REVISION", ASSET_MANIFEST.model.revision)
HF_HOME = Path(os.getenv("HF_HOME", ROOT / ".cache" / "huggingface"))
HF_HUB_CACHE = Path(os.getenv("HF_HUB_CACHE", HF_HOME / "hub"))
MODEL_LOCAL_ONLY = os.getenv("RAG_MODEL_LOCAL_ONLY", "1")
EXPECTED_DOCUMENT_COUNT = int(
    os.getenv("RAG_EXPECTED_DOCUMENT_COUNT", str(ASSET_MANIFEST.collection.document_count))
)
EXPECTED_EMBEDDING_DIMENSION = int(
    os.getenv(
        "RAG_EXPECTED_EMBEDDING_DIMENSION",
        str(ASSET_MANIFEST.collection.embedding_dimension),
    )
)
REQUIRE_ASSET_SEAL = os.getenv("RAG_REQUIRE_ASSET_SEAL", "1")
DEVICE = os.getenv("RAG_DEVICE", "cpu")
NO_MATCH_DISTANCE_THRESHOLD = float(os.getenv("RAG_DISTANCE_THRESHOLD", "0.42"))
STRONG_MATCH_DISTANCE = float(os.getenv("RAG_STRONG_MATCH_DISTANCE", "0.30"))
GUIDE_PATH = Path(os.getenv("RAG_GUIDE_PATH", ROOT / "knowledge" / "official_guides.json"))

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
    {
        "triggers": (
            "근로계약서를 아직 못", "근로계약서 못 받", "근로계약서를 안 받",
            "근로계약서를 안 줘", "계약서 미교부",
        ),
        "exclude": (),
        "expansion": "근로조건 서면 명시 교부 근로기준법 제17조",
    },
    {
        "triggers": ("포괄임금", "야근수당", "야간수당", "휴일수당"),
        "exclude": (),
        "expansion": "연장 야간 휴일근로 가산임금 지급 근로기준법 제56조",
    },
    {
        "triggers": ("월급을 두 달째 안", "월급을 안 주", "임금을 안 주", "임금이 밀렸"),
        "exclude": ("퇴사", "퇴직", "언제까지", "신고", "포상"),
        "expansion": "임금 매월 1회 이상 일정한 날짜 전액 지급 근로기준법 제43조",
    },
    {
        "triggers": ("퇴사했는데", "퇴직했는데", "마지막 달 월급"),
        "exclude": (),
        "expansion": "퇴직 금품 청산 임금 지급 근로기준법 제36조",
    },
    {
        "triggers": ("못 받은 임금은 언제까지", "임금 청구 시효", "임금 소멸시효"),
        "exclude": (),
        "expansion": "임금채권 소멸시효 근로기준법 제49조",
    },
    {
        "triggers": ("회사가 망했", "회사가 파산", "나라에서 대신", "대지급금"),
        "exclude": ("거짓", "부정", "청구권", "재직", "다니고"),
        "expansion": "체불 임금 대지급금 지급 임금채권보장법 제7조",
    },
    {
        "triggers": ("임금체불을 신고하면 포상", "체불 신고 포상"),
        "exclude": (),
        "expansion": "부정수급 신고 포상금 임금채권보장법 제15조",
    },
    {
        "triggers": ("임금채권보장기금",),
        "exclude": (),
        "expansion": "기금의 용도 임금채권보장법 제19조",
    },
    {
        "triggers": ("자발적으로 퇴사", "자진 퇴사", "자발적 퇴사"),
        "exclude": (),
        "expansion": "수급자격이 제한되지 아니하는 정당한 이직 사유 고용보험법 제58조",
    },
    {
        "triggers": ("고용보험은 모든 사업장", "고용보험 적용 사업장"),
        "exclude": (),
        "expansion": "고용보험 적용 범위 적용 제외 근로자 고용보험법 제8조 제10조",
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
_guides = None
_last_error = None
_readiness = {
    "asset_integrity": False,
    "asset_manifest_sha256": None,
    "document_count": None,
    "embedding_dimension": None,
    "query_compatible": False,
    "probe_document_id": None,
    "probe_distance": None,
}


class RetrievalUnavailable(RuntimeError):
    pass


def _true_only(value, label):
    if str(value).strip() != "1":
        raise RetrievalUnavailable(f"{label} must remain enabled in production")


def _validate_runtime_contract():
    if MODEL_NAME != ASSET_MANIFEST.model.repo_id:
        raise RetrievalUnavailable("RAG_EMBEDDING_MODEL differs from the pinned manifest")
    if MODEL_REVISION != ASSET_MANIFEST.model.revision:
        raise RetrievalUnavailable("RAG_MODEL_REVISION differs from the pinned manifest")
    if COLLECTION_NAME != ASSET_MANIFEST.collection.name:
        raise RetrievalUnavailable("RAG_COLLECTION differs from the pinned manifest")
    if EXPECTED_DOCUMENT_COUNT != ASSET_MANIFEST.collection.document_count:
        raise RetrievalUnavailable("RAG_EXPECTED_DOCUMENT_COUNT differs from the pinned manifest")
    if EXPECTED_EMBEDDING_DIMENSION != ASSET_MANIFEST.collection.embedding_dimension:
        raise RetrievalUnavailable(
            "RAG_EXPECTED_EMBEDDING_DIMENSION differs from the pinned manifest"
        )
    if (
        not math.isfinite(NO_MATCH_DISTANCE_THRESHOLD)
        or NO_MATCH_DISTANCE_THRESHOLD != PINNED_DISTANCE_THRESHOLD
    ):
        raise RetrievalUnavailable("RAG_DISTANCE_THRESHOLD must remain pinned to 0.42")
    if (
        not math.isfinite(STRONG_MATCH_DISTANCE)
        or STRONG_MATCH_DISTANCE != PINNED_STRONG_MATCH_DISTANCE
    ):
        raise RetrievalUnavailable("RAG_STRONG_MATCH_DISTANCE must remain pinned to 0.30")
    _true_only(MODEL_LOCAL_ONLY, "RAG_MODEL_LOCAL_ONLY")
    _true_only(REQUIRE_ASSET_SEAL, "RAG_REQUIRE_ASSET_SEAL")
    _true_only(os.getenv("HF_HUB_OFFLINE", ""), "HF_HUB_OFFLINE")
    _true_only(os.getenv("TRANSFORMERS_OFFLINE", ""), "TRANSFORMERS_OFFLINE")


def _embedding_payload(model):
    model_dimension = model.get_sentence_embedding_dimension()
    if model_dimension != EXPECTED_EMBEDDING_DIMENSION:
        raise RetrievalUnavailable(
            "embedding model dimension mismatch: "
            f"expected {EXPECTED_EMBEDDING_DIMENSION}, got {model_dimension}"
        )
    embedding = model.encode(
        [ASSET_MANIFEST.collection.probe.query],
        normalize_embeddings=True,
    )
    payload = embedding.tolist() if hasattr(embedding, "tolist") else embedding
    if not isinstance(payload, (list, tuple)) or len(payload) != 1:
        raise RetrievalUnavailable("embedding probe did not return exactly one vector")
    vector = payload[0]
    if not isinstance(vector, (list, tuple)) or len(vector) != EXPECTED_EMBEDDING_DIMENSION:
        actual_dimension = len(vector) if isinstance(vector, (list, tuple)) else None
        raise RetrievalUnavailable(
            "embedding probe dimension mismatch: "
            f"expected {EXPECTED_EMBEDDING_DIMENSION}, got {actual_dimension}"
        )
    if any(
        isinstance(value, bool)
        or not isinstance(value, Real)
        or not math.isfinite(float(value))
        for value in vector
    ):
        raise RetrievalUnavailable("embedding probe returned a non-finite vector")
    return [list(vector)]


def _first_probe_value(result, key):
    groups = result.get(key)
    if not isinstance(groups, (list, tuple)) or len(groups) != 1:
        raise RetrievalUnavailable(f"Chroma probe returned invalid {key}")
    values = groups[0]
    if not isinstance(values, (list, tuple)) or not values:
        raise RetrievalUnavailable(f"Chroma probe returned no {key}")
    return values[0]


def _probe_collection(model, collection):
    embedding = _embedding_payload(model)
    result = collection.query(
        query_embeddings=embedding,
        n_results=ASSET_MANIFEST.collection.probe.n_results,
        include=["documents", "metadatas", "distances"],
    )
    if not isinstance(result, dict):
        raise RetrievalUnavailable("Chroma probe returned an invalid response")
    document = _first_probe_value(result, "documents")
    metadata = _first_probe_value(result, "metadatas")
    distance = _first_probe_value(result, "distances")
    identifier = _first_probe_value(result, "ids")
    if not isinstance(document, str) or not document.strip():
        raise RetrievalUnavailable("Chroma probe returned an empty document")
    if not isinstance(identifier, str) or not identifier.strip():
        raise RetrievalUnavailable("Chroma probe returned an empty document id")
    if not isinstance(metadata, dict):
        raise RetrievalUnavailable("Chroma probe returned invalid metadata")
    if (
        isinstance(distance, bool)
        or not isinstance(distance, Real)
        or not math.isfinite(float(distance))
    ):
        raise RetrievalUnavailable("Chroma probe returned an invalid distance")
    probe = ASSET_MANIFEST.collection.probe
    if identifier != probe.expected_id:
        raise RetrievalUnavailable(
            f"Chroma semantic probe id mismatch: expected {probe.expected_id}, got {identifier}"
        )
    expected_metadata = {
        "law": probe.expected_law,
        "article_id": probe.expected_article_id,
    }
    for key, expected in expected_metadata.items():
        if metadata.get(key) != expected:
            raise RetrievalUnavailable(
                f"Chroma semantic probe metadata mismatch for {key}: "
                f"expected {expected}, got {metadata.get(key)}"
            )
    if float(distance) > probe.max_distance:
        raise RetrievalUnavailable(
            "Chroma semantic probe distance exceeded: "
            f"maximum {probe.max_distance}, got {float(distance)}"
        )
    return {
        "embedding_dimension": len(embedding[0]),
        "probe_document_id": identifier,
        "probe_distance": float(distance),
    }


def _create_model():
    # Import only after the offline environment contract has been validated.
    from sentence_transformers import SentenceTransformer

    return SentenceTransformer(
        MODEL_NAME,
        device=DEVICE,
        revision=MODEL_REVISION,
        cache_folder=str(HF_HUB_CACHE),
        local_files_only=True,
        trust_remote_code=False,
        model_kwargs={"use_safetensors": False},
    )


def _open_collection():
    import chromadb

    client = chromadb.PersistentClient(path=str(DB_PATH))
    return client.get_collection(COLLECTION_NAME)


def _load():
    global _model, _collection, _last_error, _readiness
    if _model is not None and _collection is not None:
        return _model, _collection
    with _lock:
        if _model is not None and _collection is not None:
            return _model, _collection
        try:
            _validate_runtime_contract()
            if not DB_PATH.is_dir():
                raise RetrievalUnavailable(f"RAG DB를 찾을 수 없습니다: {DB_PATH}")
            asset_report = verify_runtime_assets(
                ASSET_MANIFEST,
                hf_home=HF_HOME,
                hub_cache=HF_HUB_CACHE,
                rag_db=DB_PATH,
                require_seal=True,
            )
            model = _create_model()
            collection = _open_collection()
            document_count = collection.count()
            if document_count != EXPECTED_DOCUMENT_COUNT:
                raise RetrievalUnavailable(
                    "Chroma document count mismatch: "
                    f"expected {EXPECTED_DOCUMENT_COUNT}, got {document_count}"
                )
            probe_report = _probe_collection(model, collection)
            _model = model
            _collection = collection
            _last_error = None
            _readiness = {
                "asset_integrity": True,
                "asset_manifest_sha256": asset_report["manifest_sha256"],
                "document_count": document_count,
                "embedding_dimension": probe_report["embedding_dimension"],
                "query_compatible": True,
                "probe_document_id": probe_report["probe_document_id"],
                "probe_distance": probe_report["probe_distance"],
            }
            return _model, _collection
        except RetrievalUnavailable as error:
            _last_error = str(error)
            raise
        except AssetContractError as error:
            unavailable = RetrievalUnavailable(f"RAG asset integrity failed: {error}")
            _last_error = str(unavailable)
            raise unavailable from error
        except Exception as error:
            unavailable = RetrievalUnavailable(
                f"RAG model/collection compatibility probe failed: {error}"
            )
            _last_error = str(unavailable)
            raise unavailable from error


def _citation(meta):
    if meta.get("citation"):
        return meta["citation"]
    clause = meta.get("clause") or ""
    return f"{meta.get('law', '')} {meta.get('article_id', '')}{clause}".strip()


def _load_guides():
    global _guides
    if _guides is not None:
        return _guides
    if not GUIDE_PATH.is_file():
        _guides = []
        return _guides
    with GUIDE_PATH.open(encoding="utf-8") as file:
        payload = json.load(file)
    _guides = payload if isinstance(payload, list) else []
    return _guides


def _guide_candidates(query):
    """공식 실무 안내는 검수된 생활어 트리거가 직접 맞을 때만 후보에 넣는다."""
    candidates = []
    for guide in _load_guides():
        triggers = guide.get("triggers") or []
        required_any = guide.get("required_any") or []
        if required_any and not any(keyword in query for keyword in required_any):
            continue
        if not any(trigger in query for trigger in triggers):
            continue
        metadata = {
            "kind": "official_guide",
            "document_id": guide.get("document_id"),
            "title": guide.get("title"),
            "citation": guide.get("citation"),
            "organization": guide.get("organization"),
            "url": guide.get("url"),
            "suppress_vector_when_matched": bool(guide.get("suppress_vector_when_matched")),
        }
        candidates.append((guide.get("content") or "", metadata, None))
    return sorted(candidates, key=lambda item: not item[1]["suppress_vector_when_matched"])


def _within_distance_threshold(candidates):
    return [
        candidate for candidate in candidates
        if candidate[2] is not None and candidate[2] <= NO_MATCH_DISTANCE_THRESHOLD
    ]


def _expand_query(query):
    """사용자 표현과 법령 용어가 다를 때 검색 질의에만 최소한의 동의어를 보탠다."""
    expansions = []
    for rule in QUERY_EXPANSION_RULES:
        if any(keyword in query for keyword in rule["exclude"]):
            continue
        if any(keyword in query for keyword in rule["triggers"]):
            expansions.append(rule["expansion"])
    if any(keyword in query for keyword in ("임금", "월급", "급여", "수당", "체불")):
        if any(keyword in query for keyword in ("자료", "증거", "증빙", "준비", "신고", "진정")):
            expansions.append("임금체불 진정 입증자료 근로계약서 급여자료 근로시간 자료")
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
            document_id = metadata.get("document_id")
            article_key = document_id or (metadata.get("law"), article_id)
            if (not article_id and not document_id) or article_key in seen:
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
    guide_candidates = _guide_candidates(query)

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

    if not guide_candidates and (top_distance is None or top_distance > NO_MATCH_DISTANCE_THRESHOLD):
        return {
            "query": query,
            "retrieval_query": retrieval_query,
            "status": "no_match",
            "reason": "distance_threshold",
            "threshold": NO_MATCH_DISTANCE_THRESHOLD,
            "top1_distance": top_distance,
            "items": [],
        }

    # 1등만 통과한 뒤 후순위 원문을 무조건 보내지 않는다. 모든 벡터 문서가
    # 동일한 거리 기준을 개별 통과해야 LLM 컨텍스트에 들어갈 수 있다.
    eligible_vectors = _within_distance_threshold(candidates)
    eligible_candidates = (
        guide_candidates
        if any(item[1].get("suppress_vector_when_matched") for item in guide_candidates)
        else eligible_vectors + guide_candidates
    )

    items = []
    for document, metadata, distance in _pick(eligible_candidates, query, limit):
        citation = _citation(metadata)
        if not citation or not document:
            continue
        items.append({
            "content": document,
            "citation": citation,
            "distance": distance,
            "source": {
                "name": metadata.get("title") or citation,
                "organization": metadata.get("organization") or "국가법령정보센터",
                "document_id": metadata.get("document_id") or citation,
                "url": metadata.get("url"),
            },
        })

    return {
        "query": query,
        "retrieval_query": retrieval_query,
        "status": "matched" if items else "no_match",
        "reason": None if items else "no_eligible_documents",
        "threshold": NO_MATCH_DISTANCE_THRESHOLD,
        "top1_distance": top_distance,
        "items": items,
    }


def warmup():
    """Hash assets and execute one real embedding/Chroma query before serving."""
    _load()
    return status()


def _reset_for_tests():
    global _model, _collection, _last_error, _readiness
    _model = None
    _collection = None
    _last_error = None
    _readiness = {
        "asset_integrity": False,
        "asset_manifest_sha256": None,
        "document_count": None,
        "embedding_dimension": None,
        "query_compatible": False,
        "probe_document_id": None,
        "probe_distance": None,
    }


def status():
    loaded = _model is not None and _collection is not None
    ready = (
        loaded
        and _readiness["asset_integrity"]
        and _readiness["asset_manifest_sha256"] == PINNED_ASSET_MANIFEST_SHA256
        and _readiness["document_count"] == EXPECTED_DOCUMENT_COUNT
        and _readiness["embedding_dimension"] == EXPECTED_EMBEDDING_DIMENSION
        and _readiness["query_compatible"]
    )
    return {
        "ready": ready,
        "database_exists": DB_PATH.is_dir(),
        "collection": COLLECTION_NAME,
        "embedding_model": MODEL_NAME,
        "model_revision": MODEL_REVISION,
        "local_files_only": True,
        "offline": (
            str(os.getenv("HF_HUB_OFFLINE", "")).lower() == "1"
            and str(os.getenv("TRANSFORMERS_OFFLINE", "")).lower() == "1"
        ),
        "device": DEVICE,
        "loaded": loaded,
        "asset_integrity": _readiness["asset_integrity"],
        "asset_manifest_sha256": _readiness["asset_manifest_sha256"],
        "threshold": NO_MATCH_DISTANCE_THRESHOLD,
        "strong_match_threshold": STRONG_MATCH_DISTANCE,
        "document_count": _readiness["document_count"],
        "expected_document_count": EXPECTED_DOCUMENT_COUNT,
        "embedding_dimension": _readiness["embedding_dimension"],
        "expected_embedding_dimension": EXPECTED_EMBEDDING_DIMENSION,
        "query_compatible": _readiness["query_compatible"],
        "probe_document_id": _readiness["probe_document_id"],
        "probe_distance": _readiness["probe_distance"],
        "probe_max_distance": ASSET_MANIFEST.collection.probe.max_distance,
        "readiness_error": _last_error,
        "official_guide_count": len(_load_guides()),
    }
