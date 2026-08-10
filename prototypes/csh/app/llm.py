"""Upstage / SKT 공통 LLM 클라이언트.

두 API 모두 OpenAI 호환 `/chat/completions` 스펙이라 한 벌로 감쌉니다.
프로바이더를 바꿔도 호출부는 그대로입니다.
"""

import json
from typing import Iterator

import requests

from . import config


class LLMError(RuntimeError):
    pass


def _resolve(provider: str | None) -> tuple[str, dict]:
    name = (provider or config.DEFAULT_PROVIDER).lower()
    cfg = config.PROVIDERS.get(name)
    if cfg is None:
        raise LLMError(f"알 수 없는 프로바이더: {provider}")
    if not cfg["api_key"]:
        # 파일 자체를 못 읽은 경우와 파일에 그 키만 없는 경우를 구분해 줍니다.
        if config.TEAM_ENV_ERROR:
            raise LLMError(f"{name} API 키를 불러오지 못했습니다 — {config.TEAM_ENV_ERROR}")
        raise LLMError(f"{name} API 키가 없습니다. {config.TEAM_ENV_FILE} 확인 필요")
    return name, cfg


def _payload(cfg: dict, messages: list[dict], stream: bool, **opts) -> dict:
    return {
        "model": opts.get("model") or cfg["model"],
        "messages": messages,
        "temperature": opts.get("temperature", config.DEFAULT_TEMPERATURE),
        "max_tokens": opts.get("max_tokens", config.DEFAULT_MAX_TOKENS),
        "stream": stream,
    }


def _headers(cfg: dict) -> dict:
    return {
        "Authorization": f"Bearer {cfg['api_key']}",
        "Content-Type": "application/json",
    }


def _utf8(raw: bytes) -> str:
    """응답 바이트를 항상 UTF-8로 읽습니다.

    SKT는 SSE 응답에 `Content-Type: text/event-stream` 만 보내고 charset을 붙이지 않습니다.
    그러면 requests가 RFC 2616 규정대로 ISO-8859-1로 추정해 한글이 전부 깨집니다
    (`지금` → `ì§ê¸`). Upstage는 charset=utf-8을 명시해서 문제가 없었고,
    그래서 SKT 스트리밍에서만 증상이 나타났습니다. 2026-08-01.

    서버 헤더를 믿지 않고 직접 디코딩합니다.
    """
    return raw.decode("utf-8", errors="replace")


def complete(messages: list[dict], provider: str | None = None, **opts) -> dict:
    """한 번에 받는 호출. {'text', 'model', 'provider', 'usage'} 반환."""
    name, cfg = _resolve(provider)
    try:
        res = requests.post(
            cfg["url"],
            headers=_headers(cfg),
            json=_payload(cfg, messages, stream=False, **opts),
            timeout=config.REQUEST_TIMEOUT,
        )
    except requests.RequestException as exc:
        raise LLMError(f"{name} 연결 실패: {exc}") from exc

    if res.status_code != 200:
        # 응답 본문에 키가 실려 오지는 않지만, 길이를 잘라 남깁니다.
        raise LLMError(f"{name} HTTP {res.status_code}: {_utf8(res.content)[:500]}")

    # res.json() 대신 직접 디코딩합니다. 이유는 _utf8() 주석 참조.
    try:
        data = json.loads(_utf8(res.content))
    except json.JSONDecodeError as exc:
        raise LLMError(f"{name} 응답을 JSON으로 읽지 못했습니다: {exc}") from exc

    try:
        text = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise LLMError(f"{name} 응답 형식이 예상과 다릅니다: {exc}") from exc

    return {
        "text": text,
        "model": data.get("model", cfg["model"]),
        "provider": name,
        "usage": data.get("usage", {}),
    }


def stream(messages: list[dict], provider: str | None = None, **opts) -> Iterator[str]:
    """SSE 스트리밍 호출. 토큰 조각을 순서대로 yield 합니다."""
    name, cfg = _resolve(provider)
    try:
        res = requests.post(
            cfg["url"],
            headers=_headers(cfg),
            json=_payload(cfg, messages, stream=True, **opts),
            timeout=config.REQUEST_TIMEOUT,
            stream=True,
        )
    except requests.RequestException as exc:
        raise LLMError(f"{name} 연결 실패: {exc}") from exc

    if res.status_code != 200:
        raise LLMError(f"{name} HTTP {res.status_code}: {_utf8(res.content)[:500]}")

    # decode_unicode=True 를 쓰지 않습니다. requests가 서버 헤더로 인코딩을 추정하는데,
    # SKT는 charset을 안 붙여 ISO-8859-1로 떨어집니다. 바이트로 받아 직접 UTF-8로 읽습니다.
    # iter_lines는 개행 단위로 잘라 주므로 한 줄은 항상 완결된 바이트열입니다.
    for line in res.iter_lines(decode_unicode=False):
        if not line:
            continue
        raw = _utf8(line)
        if not raw.startswith("data:"):
            continue
        chunk = raw[len("data:"):].strip()
        if chunk == "[DONE]":
            break
        try:
            delta = json.loads(chunk)["choices"][0].get("delta", {})
        except (json.JSONDecodeError, KeyError, IndexError):
            continue
        piece = delta.get("content")
        if piece:
            yield piece
