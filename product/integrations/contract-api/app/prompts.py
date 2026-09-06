"""프롬프트·지식 로더.

프롬프트를 코드에서 분리해 파일로 둡니다. 파일 캐시는 mtime으로 관리하지만,
모든 읽기 전에 고정 manifest를 검증합니다. 따라서 검토되지 않은 hot edit는
자동 반영되지 않고 서비스가 fail-closed 됩니다.

RAG 도입 전 단계라 `knowledge/` 아래 문서를 통째로 프롬프트에 붙입니다.
그래서 문자 예산(KNOWLEDGE_BUDGET)으로 상한을 둡니다.
"""

import json
from pathlib import Path

from . import config
from .asset_integrity import AssetIntegrityError, verify_committed_assets

REGISTRY_FILE = config.PROMPT_DIR / "registry.json"
REWRITE_FILE = config.PROMPT_DIR / "rewrite" / "query_rewrite.md"
CONTRACT_EXTRACT_FILE = config.PROMPT_DIR / "contract" / "extract.md"

_cache: dict[str, tuple[float, object]] = {}


def _read_cached(path: Path, loader):
    """mtime이 바뀌었을 때만 다시 읽습니다."""
    try:
        mtime = path.stat().st_mtime
    except FileNotFoundError:
        _cache.pop(str(path), None)
        return None
    hit = _cache.get(str(path))
    if hit and hit[0] == mtime:
        return hit[1]
    value = loader(path)
    _cache[str(path)] = (mtime, value)
    return value


def load_registry() -> dict:
    verify_committed_assets()
    data = _read_cached(REGISTRY_FILE, lambda p: json.loads(p.read_text(encoding="utf-8")))
    if data is None:
        raise FileNotFoundError(f"페르소나 정의가 없습니다: {REGISTRY_FILE}")
    return data


def personas(chat_only: bool = True) -> list[dict]:
    """프런트에 내려줄 페르소나 목록(프롬프트 본문은 제외).

    chat_only=True 는 상담 화면에 띄울 것만 남깁니다. 근로계약서 진단처럼
    전용 화면에서만 쓰는 페르소나는 `"chat_visible": false` 로 빼 둡니다.
    """
    return [
        {
            "id": key,
            "label": spec.get("label", key),
            "description": spec.get("description", ""),
            "suggestions": spec.get("suggestions", []),
        }
        for key, spec in load_registry().items()
        if not (chat_only and spec.get("chat_visible") is False)
    ]


KNOWLEDGE_HEADER = (
    "# 참고 자료\n"
    "아래 <doc> 블록이 네 학습 지식보다 우선한다. 이 범위 안에서 답하고, "
    "여기 없는 수치·조문·통계는 지어내지 말고 모른다고 밝힌다.\n\n"
)


def system_prompt(persona_id: str) -> str:
    """시스템 프롬프트를 조립합니다.

    배치 순서는 Lost in the Middle을 고려한 샌드위치 구조입니다.
    맨 앞에 계약(권위·범위·제약·폴백), 중간에 참고 자료와 페르소나,
    맨 뒤에 가드레일 — 가장 중요한 두 블록이 양 끝에 옵니다.
    registry.json의 system 배열 순서가 그대로 반영되므로,
    가드레일 파일은 배열의 마지막에 둡니다.
    """
    spec = load_registry().get(persona_id)
    if spec is None:
        raise KeyError(f"등록되지 않은 페르소나: {persona_id}")

    parts = []
    for rel in spec.get("system", []):
        path = config.PROMPT_DIR / rel
        text = _read_cached(path, lambda p: p.read_text(encoding="utf-8").strip())
        if not text:
            raise AssetIntegrityError(f"필수 시스템 프롬프트가 비어 있습니다: {rel}")
        parts.append(text)

    knowledge = _load_knowledge(spec.get("knowledge", []))
    if knowledge:
        # 첫 블록(계약) 바로 뒤에 끼웁니다. 가드레일은 맨 뒤에 남습니다.
        parts.insert(1 if parts else 0, KNOWLEDGE_HEADER + knowledge)

    return "\n\n---\n\n".join(parts)


def rewrite_prompt() -> str:
    """멀티턴 질의 재작성용 시스템 프롬프트 (호출 ①)."""
    verify_committed_assets()
    text = _read_cached(REWRITE_FILE, lambda p: p.read_text(encoding="utf-8").strip())
    if not text:
        raise FileNotFoundError(f"재작성 프롬프트가 없습니다: {REWRITE_FILE}")
    return text


def contract_extract_prompt() -> str:
    """근로계약서 조항 구조화 추출용 시스템 프롬프트.

    `{SCHEMA}` 자리에 app/contract/schema.py 의 EXTRACTION_SCHEMA 를 끼워 넣습니다.
    스키마를 코드와 프롬프트 두 곳에 적어 두면 반드시 어긋나므로 한 곳에서만 정의합니다.
    """
    verify_committed_assets()
    from .contract import schema as contract_schema   # 순환 임포트를 피해 지연 로드합니다

    text = _read_cached(CONTRACT_EXTRACT_FILE, lambda p: p.read_text(encoding="utf-8").strip())
    if not text:
        raise FileNotFoundError(f"추출 프롬프트가 없습니다: {CONTRACT_EXTRACT_FILE}")
    return text.replace(
        "{SCHEMA}",
        json.dumps(contract_schema.EXTRACTION_SCHEMA, ensure_ascii=False, indent=2),
    )


def _load_knowledge(topics: list[str]) -> str:
    """knowledge/<topic>/ 아래 .md·.txt를 파일명 순으로 이어붙입니다.

    문서를 <doc> 태그로 감싸는 이유 — 학습노트의 "문서 삽입 포맷(XML형)" 권고.
    RAG를 붙이면 같은 태그 안에 검색된 청크가 들어가므로 프롬프트를 다시 짜지 않아도 됩니다.
    """
    budget = config.KNOWLEDGE_BUDGET
    chunks, used = [], 0
    for topic in topics:
        topic_dir = config.KNOWLEDGE_DIR / topic
        if not topic_dir.is_dir():
            raise AssetIntegrityError(f"필수 지식 주제 폴더가 없습니다: {topic}")
        found = False
        for path in sorted(topic_dir.iterdir()):
            if path.suffix.lower() not in (".md", ".txt") or path.name.startswith("_"):
                continue
            text = _read_cached(path, lambda p: p.read_text(encoding="utf-8").strip())
            if not text:
                raise AssetIntegrityError(
                    f"필수 지식 블록이 비어 있습니다: {topic}/{path.name}"
                )
            found = True
            remain = budget - used
            if len(text) > remain:
                if remain > 500:
                    chunks.append(
                        f'<doc id="{topic}/{path.stem}">\n{text[:remain]}\n…(분량 초과로 잘림)\n</doc>'
                    )
                return "\n\n".join(chunks)
            chunks.append(f'<doc id="{topic}/{path.stem}">\n{text}\n</doc>')
            used += len(text)
        if not found:
            raise AssetIntegrityError(f"필수 지식 블록이 없습니다: {topic}")
    return "\n\n".join(chunks)


def uses_workplace_db(persona_id: str) -> bool:
    """이 페르소나가 사업장 레코드를 조회하는가 (registry.json의 workplace_db)."""
    return bool((load_registry().get(persona_id) or {}).get("workplace_db"))


def uses_safety_db(persona_id: str) -> bool:
    """이 페르소나가 산재 경보를 조회하는가 (registry.json의 safety_db)."""
    return bool((load_registry().get(persona_id) or {}).get("safety_db"))


def few_shot(persona_id: str) -> list[dict]:
    """few_shot/*.jsonl 을 messages 형태로 펼칩니다.

    각 줄: {"user": "...", "assistant": "..."}
    """
    spec = load_registry().get(persona_id) or {}
    rel = spec.get("few_shot")
    if not rel:
        return []

    def _load(path: Path) -> list[dict]:
        out = []
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            line = line.strip()
            if not line or line.startswith("//"):
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError as error:
                raise AssetIntegrityError(
                    f"few-shot JSONL이 올바르지 않습니다: {path.name}:{line_number}"
                ) from error
            if not isinstance(item, dict) or set(item) != {"user", "assistant"}:
                raise AssetIntegrityError(
                    f"few-shot 블록 형식이 올바르지 않습니다: {path.name}:{line_number}"
                )
            if not all(isinstance(item[key], str) and item[key].strip()
                       for key in ("user", "assistant")):
                raise AssetIntegrityError(
                    f"few-shot 필수 블록이 비어 있습니다: {path.name}:{line_number}"
                )
            out.append({"role": "user", "content": item["user"]})
            out.append({"role": "assistant", "content": item["assistant"]})
        if not out:
            raise AssetIntegrityError(f"few-shot 예시가 없습니다: {path.name}")
        return out

    return _read_cached(config.PROMPT_DIR / rel, _load) or []


def knowledge_stats() -> dict:
    """어떤 지식 문서가 실제로 로드되는지 점검용."""
    verify_committed_assets()
    stats = {}
    for topic_dir in sorted(config.KNOWLEDGE_DIR.glob("*")):
        # _source/ 처럼 언더스코어로 시작하는 폴더는 원본 보관용이라 주입되지 않습니다.
        if not topic_dir.is_dir() or topic_dir.name.startswith("_"):
            continue
        files = [
            p for p in sorted(topic_dir.iterdir())
            if p.suffix.lower() in (".md", ".txt") and not p.name.startswith("_")
        ]
        stats[topic_dir.name] = {
            "files": [p.name for p in files],
            "chars": sum(len(p.read_text(encoding="utf-8")) for p in files),
        }
    return stats
