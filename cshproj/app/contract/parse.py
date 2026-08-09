"""Upstage Document Parse 클라이언트.

    POST https://api.upstage.ai/v1/document-digitization
    multipart/form-data — model=document-parse, document=<file>

**왜 chat/completions 가 아닌가** — solar-pro3의 `/v1/chat/completions`는 PDF·이미지를
직접 받지 않습니다. messages의 텍스트만 처리합니다. Upstage에서 문서를 읽는 것은
이 별도 엔드포인트이고, 여기서 나온 마크다운을 다시 solar-pro3에 넘기는 2단 구조입니다.

근로계약서는 사진으로 찍어 올리는 경우가 많아 텍스트 레이어가 없는 파일이 흔합니다.
그래서 로컬 텍스트 추출(pypdf) 대신 OCR을 포함하는 이 API를 씁니다.

호출당 과금되므로 **파일 내용 해시로 캐시**합니다. 같은 계약서를 여러 번 진단해도
파싱은 한 번입니다. 캐시는 outputs/contract/parsed/ (→ /data).
"""

import hashlib
import json
import time
from pathlib import Path

import requests

from .. import config

PARSE_URL = "https://api.upstage.ai/v1/document-digitization"
PARSE_MODEL = "document-parse"

# 계약서는 보통 1~4장입니다. 이보다 크면 잘못 올린 파일로 보고 막습니다.
MAX_BYTES = 20 * 1024 * 1024
ALLOWED_SUFFIXES = {".pdf", ".png", ".jpg", ".jpeg", ".tiff", ".tif", ".heic",
                    ".docx", ".pptx", ".xlsx", ".hwp", ".hwpx"}

# 파싱 결과에서 본문으로 쓰지 않는 요소. 머리말·쪽번호가 조항 사이에 끼면
# 모델이 그것까지 조항으로 읽습니다.
SKIP_CATEGORIES = {"header", "footer", "page_number"}


class ParseError(RuntimeError):
    pass


def file_digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:32]


def _cache_path(digest: str) -> Path:
    return config.CONTRACT_CACHE_DIR / f"{digest}.json"


def _read_cache(digest: str) -> dict | None:
    if not config.CONTRACT_CACHE_ENABLED:
        return None
    path = _cache_path(digest)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def _write_cache(digest: str, payload: dict) -> None:
    if not config.CONTRACT_CACHE_ENABLED:
        return
    try:
        config.CONTRACT_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        _cache_path(digest).write_text(
            json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass          # 캐시는 보조 기능입니다. 못 써도 진단은 진행합니다.


def check_upload(filename: str, data: bytes) -> None:
    """받기 전에 막을 것은 여기서 막습니다."""
    if not data:
        raise ParseError("빈 파일입니다.")
    if len(data) > MAX_BYTES:
        raise ParseError(f"파일이 너무 큽니다 ({len(data) / 1024 / 1024:.1f}MB). "
                         f"{MAX_BYTES // 1024 // 1024}MB 이하로 올려 주세요.")
    suffix = Path(filename or "").suffix.lower()
    if suffix not in ALLOWED_SUFFIXES:
        raise ParseError(f"지원하지 않는 형식입니다: {suffix or '(확장자 없음)'}. "
                         f"{', '.join(sorted(ALLOWED_SUFFIXES))} 중 하나로 올려 주세요.")


def parse_document(data: bytes, filename: str = "contract.pdf",
                   ocr: str = "auto", use_cache: bool = True) -> dict:
    """문서를 파싱해 마크다운·요소 목록을 돌려줍니다.

    반환: {"markdown", "html", "text", "elements", "pages", "digest", "cached", "elapsed_sec"}

    ocr="force" 는 텍스트 레이어를 무시하고 전부 OCR합니다. 스캔본을 그대로 PDF에
    끼워 넣어 텍스트 레이어가 깨진 파일에 씁니다.
    """
    cfg = config.PROVIDERS["upstage"]
    if not cfg["api_key"]:
        raise ParseError(f"Upstage API 키가 없습니다. {config.TEAM_ENV_FILE}를 확인하세요.")

    digest = file_digest(data)
    if use_cache:
        hit = _read_cache(digest)
        if hit:
            return {**hit, "cached": True, "elapsed_sec": 0.0}

    started = time.monotonic()
    try:
        res = requests.post(
            PARSE_URL,
            headers={"Authorization": f"Bearer {cfg['api_key']}"},
            files={"document": (filename, data)},
            data={
                "model": PARSE_MODEL,
                "output_formats": '["markdown", "html"]',
                "ocr": ocr,
                "coordinates": "false",       # 좌표는 쓰지 않습니다. 응답만 커집니다.
                "base64_encoding": "[]",      # 이미지 원본도 받지 않습니다.
            },
            timeout=config.CONTRACT_PARSE_TIMEOUT,
        )
    except requests.RequestException as exc:
        raise ParseError(f"Document Parse 연결 실패: {exc}") from exc

    if res.status_code != 200:
        # 응답 본문에 키가 실려 오지는 않지만 길이를 잘라 남깁니다.
        body = res.content.decode("utf-8", errors="replace")[:400]
        raise ParseError(f"Document Parse HTTP {res.status_code}: {body}")

    try:
        raw = json.loads(res.content.decode("utf-8", errors="replace"))
    except json.JSONDecodeError as exc:
        raise ParseError(f"Document Parse 응답을 JSON으로 읽지 못했습니다: {exc}") from exc

    payload = _shape(raw, digest)
    if not payload["markdown"].strip():
        raise ParseError("문서에서 글자를 찾지 못했습니다. "
                         "빈 페이지이거나 해상도가 너무 낮을 수 있습니다.")

    _write_cache(digest, payload)
    return {**payload, "cached": False, "elapsed_sec": round(time.monotonic() - started, 2)}


def _shape(raw: dict, digest: str) -> dict:
    """API 응답을 이후 단계가 쓰는 모양으로 줄입니다."""
    content = raw.get("content") or {}
    elements = []
    pages = set()

    for item in raw.get("elements") or []:
        if not isinstance(item, dict):
            continue
        category = str(item.get("category", ""))
        body = item.get("content") or {}
        text = (body.get("markdown") or body.get("text") or "").strip()
        page = item.get("page")
        if isinstance(page, int):
            pages.add(page)
        if not text or category in SKIP_CATEGORIES:
            continue
        elements.append({"category": category, "page": page, "text": text})

    markdown = (content.get("markdown") or "").strip()
    if not markdown and elements:
        # content가 비어 오는 경우가 있어 요소를 이어붙여 대신 씁니다.
        markdown = "\n\n".join(e["text"] for e in elements)

    return {
        "digest": digest,
        "markdown": markdown,
        "html": (content.get("html") or "").strip(),
        "text": (content.get("text") or "").strip(),
        "elements": elements,
        "pages": max(pages) + 1 if pages else 1,
        "api_version": raw.get("apiVersion"),
        "model": raw.get("model") or PARSE_MODEL,
    }


def as_prompt_block(parsed: dict, limit: int | None = None) -> str:
    """파싱 결과를 프롬프트에 넣을 <contract_text> 블록으로 만듭니다.

    학습노트의 "문서 삽입 포맷(XML형)" 권고를 따릅니다.
    knowledge/ 를 <doc>로 감싸는 것과 같은 방식이라 프롬프트 구조가 일관됩니다.
    """
    limit = limit or config.CONTRACT_TEXT_BUDGET
    body = parsed["markdown"]
    attrs = f'pages="{parsed["pages"]}"'
    if len(body) > limit:
        body = body[:limit] + "\n…(분량 초과로 잘림)"
        attrs += ' truncated="true"'
    return f"<contract_text {attrs}>\n{body}\n</contract_text>"
