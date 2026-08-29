#!/usr/bin/env python3
"""Validate split, least-privilege env files without printing secret values."""

from __future__ import annotations

import argparse
import re
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit


IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_.-]*")
KEY = re.compile(r"[A-Z_][A-Z0-9_]*")


def fail(message: str) -> None:
    raise SystemExit(message)


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            fail(f"unsupported env syntax at {path}:{number}")
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not KEY.fullmatch(key):
            fail(f"unsupported env key at {path}:{number}")
        if key in values:
            fail(f"duplicate env key in {path}: {key}")
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key] = value
    return values


def require(values: dict[str, str], label: str, *keys: str) -> None:
    for key in keys:
        if not values.get(key):
            fail(f"{label} is missing required value: {key}")


def reject_unknown(values: dict[str, str], label: str, allowed: set[str]) -> None:
    unknown = sorted(set(values) - allowed)
    if unknown:
        fail(f"{label} contains unsupported keys: {', '.join(unknown)}")


def require_secret(value: str, label: str, minimum: int = 20) -> None:
    upper = value.upper()
    placeholder = (
        (value.startswith("<") and value.endswith(">"))
        or "CHANGE_ME" in upper
        or "DO_NOT_PRINT" in upper
        or "PLACEHOLDER" in upper
    )
    if len(value) < minimum or placeholder:
        fail(f"{label} must be a non-placeholder secret of at least {minimum} characters")


def require_printable_ascii(value: str, label: str, *, forbid_colon: bool = False) -> None:
    if not value or any(ord(character) < 0x21 or ord(character) > 0x7E for character in value):
        fail(f"{label} must use printable ASCII without spaces or control characters")
    if forbid_colon and ":" in value:
        fail(f"{label} must not contain ':' because Basic auth uses it as a separator")


def require_bounded_integer(
    values: dict[str, str],
    label: str,
    key: str,
    minimum: int,
    maximum: int,
) -> None:
    if key not in values:
        return
    try:
        parsed = int(values[key], 10)
    except ValueError:
        fail(f"{label} {key} must be an integer from {minimum} through {maximum}")
    if str(parsed) != values[key] or not minimum <= parsed <= maximum:
        fail(f"{label} {key} must be an integer from {minimum} through {maximum}")


def validate_database(db: dict[str, str]) -> None:
    reject_unknown(
        db,
        "db.env",
        {
            "COMPOSE_PROJECT_NAME",
            "DB_PORT",
            "DB_NAME",
            "DB_USER",
            "DB_PASSWORD",
            "BOT_USER",
            "POSTGRES_DATA_DIR",
        },
    )
    require(
        db,
        "db.env",
        "COMPOSE_PROJECT_NAME",
        "DB_PORT",
        "DB_NAME",
        "DB_USER",
        "DB_PASSWORD",
        "BOT_USER",
        "POSTGRES_DATA_DIR",
    )
    if db["DB_PORT"] != "5433":
        fail("db.env DB_PORT must be exactly 5433")
    if db["POSTGRES_DATA_DIR"] != "/srv/moneyworry/postgres":
        fail("db.env POSTGRES_DATA_DIR must be exactly /srv/moneyworry/postgres")
    for key in ("COMPOSE_PROJECT_NAME", "DB_NAME", "DB_USER", "BOT_USER"):
        if not IDENTIFIER.fullmatch(db[key]):
            fail(f"db.env contains an unsafe identifier: {key}")
    if db["DB_USER"] == db["BOT_USER"]:
        fail("DB administrator and read-only bot users must differ")
    require_secret(db["DB_PASSWORD"], "db.env DB_PASSWORD", 24)


def reject_admin_keys(*labeled_values: tuple[str, dict[str, str]]) -> None:
    admin_keys = {
        "COMPOSE_PROJECT_NAME",
        "POSTGRES_DATA_DIR",
        "DB_HOST",
        "DB_PORT",
        "DB_NAME",
        "DB_USER",
        "DB_PASSWORD",
        "BOT_USER",
        "BOT_PASSWORD",
    }
    for label, values in labeled_values:
        leaked = sorted(admin_keys.intersection(values))
        if leaked:
            fail(f"{label} contains DB/bootstrap credentials: {', '.join(leaked)}")


def validate_bot_url(candidate: str, db: dict[str, str]) -> None:
    try:
        parsed = urlsplit(candidate)
        query = parse_qs(parsed.query, strict_parsing=True) if parsed.query else {}
        valid = (
            parsed.scheme in {"postgres", "postgresql"}
            and parsed.hostname == "127.0.0.1"
            and parsed.port == 5433
            and unquote(parsed.username or "") == db["BOT_USER"]
            and bool(parsed.password)
            and unquote(parsed.path.removeprefix("/")) == db["DB_NAME"]
            and not parsed.fragment
            and (not query or query == {"sslmode": ["disable"]})
        )
    except (TypeError, ValueError):
        valid = False
    if not valid:
        fail("web.env BOT_DATABASE_URL is not the pinned loopback read-only bot URL")
    require_secret(unquote(parsed.password or ""), "web.env bot password", 24)


def validate_web(web: dict[str, str], db: dict[str, str]) -> None:
    require(
        web,
        "web.env",
        "BOT_DATABASE_URL",
        "RAG_API_URL",
        "CONTRACT_ANALYSIS_URL",
        "APP_DATA_MODE",
        "CHAT_EXECUTION_MODE",
        "DEMO_BASIC_AUTH_USER",
        "DEMO_BASIC_AUTH_PASSWORD",
        "SAVE_COMPARISON_FEEDBACK",
        "RAG_INTERNAL_TOKEN",
        "CONTRACT_INTERNAL_TOKEN",
    )
    for key in ("DATABASE_URL", "DATABASE_ENV_FILE", "SHARED_API_KEY_FILE"):
        if key in web:
            fail(f"web.env must not define ambiguous fallback: {key}")
    if web["RAG_API_URL"].rstrip("/") != "http://127.0.0.1:5051":
        fail("web.env RAG_API_URL must target http://127.0.0.1:5051")
    if web["CONTRACT_ANALYSIS_URL"].rstrip("/") != "http://127.0.0.1:8000":
        fail("web.env CONTRACT_ANALYSIS_URL must target http://127.0.0.1:8000")
    approved_provider_urls = {
        "UPSTAGE_API_URL": "https://api.upstage.ai/v1/chat/completions",
        "SKT_API_URL": "https://awf-gw.adot.ai/v1/chat/completions",
    }
    for key, expected in approved_provider_urls.items():
        if key in web and web[key] != expected:
            fail(f"web.env {key} must be the approved HTTPS provider endpoint")
    if web.get("DB_SSL", "false") != "false":
        fail("web.env DB_SSL must be absent or false for loopback PostgreSQL")
    if web["APP_DATA_MODE"] != "real":
        fail("web.env APP_DATA_MODE must be real")
    for key in ("COMPANY_DATA_MODE", "CONTRACT_DATA_MODE"):
        if key in web and web[key] != "real":
            fail(f"web.env {key} must be real when set")
    if web["SAVE_COMPARISON_FEEDBACK"] != "false":
        fail("web.env SAVE_COMPARISON_FEEDBACK must be false")
    require_printable_ascii(
        web["DEMO_BASIC_AUTH_USER"],
        "web.env DEMO_BASIC_AUTH_USER",
        forbid_colon=True,
    )
    require_printable_ascii(
        web["DEMO_BASIC_AUTH_PASSWORD"],
        "web.env DEMO_BASIC_AUTH_PASSWORD",
    )
    if len(web["DEMO_BASIC_AUTH_USER"]) < 4:
        fail("web.env DEMO_BASIC_AUTH_USER must contain at least 4 characters")
    require_secret(web["DEMO_BASIC_AUTH_PASSWORD"], "web.env DEMO_BASIC_AUTH_PASSWORD", 20)
    for key in ("RAG_INTERNAL_TOKEN", "CONTRACT_INTERNAL_TOKEN"):
        require_secret(web[key], f"web.env {key}", 32)
        require_printable_ascii(web[key], f"web.env {key}")
    mode = web["CHAT_EXECUTION_MODE"]
    if mode == "dual_api":
        require(web, "web.env dual_api mode", "UPSTAGE_API_KEY", "SKT_API_KEY")
        require_secret(web["UPSTAGE_API_KEY"], "web.env UPSTAGE_API_KEY")
        require_secret(web["SKT_API_KEY"], "web.env SKT_API_KEY")
    elif mode == "openai_responses":
        require(web, "web.env openai_responses mode", "OPENAI_API_KEY", "OPENAI_RESPONSES_MODEL")
        require_secret(web["OPENAI_API_KEY"], "web.env OPENAI_API_KEY")
    else:
        fail("web.env CHAT_EXECUTION_MODE must be dual_api or openai_responses")
    validate_bot_url(web["BOT_DATABASE_URL"], db)
    reject_unknown(
        web,
        "web.env",
        {
            "BOT_DATABASE_URL",
            "RAG_API_URL",
            "CONTRACT_ANALYSIS_URL",
            "APP_DATA_MODE",
            "COMPANY_DATA_MODE",
            "CONTRACT_DATA_MODE",
            "CHAT_EXECUTION_MODE",
            "UPSTAGE_API_KEY",
            "UPSTAGE_API_URL",
            "UPSTAGE_MODEL",
            "SKT_API_KEY",
            "SKT_API_URL",
            "SKT_MODEL",
            "OPENAI_API_KEY",
            "OPENAI_RESPONSES_MODEL",
            "DEMO_BASIC_AUTH_USER",
            "DEMO_BASIC_AUTH_PASSWORD",
            "SAVE_COMPARISON_FEEDBACK",
            "DB_SSL",
            "LLM_TIMEOUT_MS",
            "LLM_HEALTH_TIMEOUT_MS",
            "RAG_TIMEOUT_MS",
            "CONTRACT_TIMEOUT_MS",
            "RAG_INTERNAL_TOKEN",
            "CONTRACT_INTERNAL_TOKEN",
        },
    )
    for key, minimum, maximum in (
        ("LLM_TIMEOUT_MS", 1_000, 120_000),
        ("LLM_HEALTH_TIMEOUT_MS", 500, 30_000),
        ("RAG_TIMEOUT_MS", 1_000, 60_000),
        ("CONTRACT_TIMEOUT_MS", 1_000, 300_000),
    ):
        require_bounded_integer(web, "web.env", key, minimum, maximum)


def validate_rag(rag: dict[str, str]) -> None:
    for key in rag:
        if (key != "RAG_INTERNAL_TOKEN" and re.search(r"(?:PASSWORD|SECRET|TOKEN|API_KEY)$", key)) or key in {
            "DATABASE_URL",
            "BOT_DATABASE_URL",
            "API_KEY_ENV_FILE",
            "RAG_DB_PATH",
        }:
            fail(f"rag.env contains a forbidden secret-bearing key: {key}")
    require(rag, "rag.env", "RAG_INTERNAL_TOKEN")
    require_secret(rag["RAG_INTERNAL_TOKEN"], "rag.env RAG_INTERNAL_TOKEN", 32)
    require_printable_ascii(rag["RAG_INTERNAL_TOKEN"], "rag.env RAG_INTERNAL_TOKEN")
    reject_unknown(
        rag,
        "rag.env",
        {
            "RAG_DEVICE",
            "RAG_GUNICORN_THREADS",
            "RAG_GUNICORN_TIMEOUT",
            "RAG_DISTANCE_THRESHOLD",
            "RAG_STRONG_MATCH_DISTANCE",
            "RAG_INTERNAL_TOKEN",
        },
    )
    if rag.get("RAG_DEVICE", "cpu") != "cpu":
        fail("rag.env RAG_DEVICE must be cpu")
    fixed_values = {
        "RAG_DISTANCE_THRESHOLD": "0.42",
        "RAG_STRONG_MATCH_DISTANCE": "0.30",
    }
    for key, expected in fixed_values.items():
        if key in rag and rag[key] != expected:
            fail(f"rag.env {key} must remain pinned to {expected}")
    require_bounded_integer(rag, "rag.env", "RAG_GUNICORN_THREADS", 1, 16)
    require_bounded_integer(rag, "rag.env", "RAG_GUNICORN_TIMEOUT", 1, 900)


def validate_contract(contract: dict[str, str]) -> None:
    for key in ("DATABASE_URL", "BOT_DATABASE_URL", "API_KEY_ENV_FILE", "LOCAL_CONFIG_ENV_FILE"):
        if key in contract:
            fail(f"contract.env contains a forbidden DB/file fallback: {key}")
    require(contract, "contract.env", "UPSTAGE_API_KEY", "SKT_API_KEY", "CONTRACT_INTERNAL_TOKEN")
    require_secret(contract["UPSTAGE_API_KEY"], "contract.env UPSTAGE_API_KEY")
    require_secret(contract["SKT_API_KEY"], "contract.env SKT_API_KEY")
    require_secret(contract["CONTRACT_INTERNAL_TOKEN"], "contract.env CONTRACT_INTERNAL_TOKEN", 32)
    require_printable_ascii(
        contract["CONTRACT_INTERNAL_TOKEN"],
        "contract.env CONTRACT_INTERNAL_TOKEN",
    )
    if contract.get("DEFAULT_PROVIDER", "upstage") not in {"upstage", "skt"}:
        fail("contract.env DEFAULT_PROVIDER must be upstage or skt")
    safe_fixed_values = {
        "HOST": "127.0.0.1",
        "PORT": "8000",
        "DEBUG": "0",
        "SAVE_CHAT_LOG": "0",
        "SAVE_CONTRACT_LOG": "0",
        "CONTRACT_CACHE_ENABLED": "0",
    }
    for key, expected in safe_fixed_values.items():
        if key in contract and contract[key] != expected:
            fail(f"contract.env {key} conflicts with the production privacy boundary")
    reject_unknown(
        contract,
        "contract.env",
        {
            "UPSTAGE_API_KEY",
            "SKT_API_KEY",
            "DEFAULT_PROVIDER",
            "CONTRACT_GUNICORN_THREADS",
            "CONTRACT_GUNICORN_TIMEOUT",
            "CONTRACT_INTERNAL_TOKEN",
        },
    )
    require_bounded_integer(contract, "contract.env", "CONTRACT_GUNICORN_THREADS", 1, 16)
    require_bounded_integer(contract, "contract.env", "CONTRACT_GUNICORN_TIMEOUT", 1, 900)


def validate_internal_tokens(
    web: dict[str, str],
    rag: dict[str, str],
    contract: dict[str, str],
) -> None:
    if web["RAG_INTERNAL_TOKEN"] != rag["RAG_INTERNAL_TOKEN"]:
        fail("web.env and rag.env RAG_INTERNAL_TOKEN values must match")
    if web["CONTRACT_INTERNAL_TOKEN"] != contract["CONTRACT_INTERNAL_TOKEN"]:
        fail("web.env and contract.env CONTRACT_INTERNAL_TOKEN values must match")
    if web["RAG_INTERNAL_TOKEN"] == web["CONTRACT_INTERNAL_TOKEN"]:
        fail("RAG and contract internal tokens must be distinct")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db-env", required=True, type=Path)
    parser.add_argument("--web-env", required=True, type=Path)
    parser.add_argument("--rag-env", required=True, type=Path)
    parser.add_argument("--contract-env", required=True, type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    paths = [args.db_env, args.web_env, args.rag_env, args.contract_env]
    if len({path.resolve(strict=True) for path in paths}) != 4:
        fail("service environment files must be distinct")
    db, web, rag, contract = [read_env(path) for path in paths]
    validate_database(db)
    reject_admin_keys(("web.env", web), ("rag.env", rag), ("contract.env", contract))
    validate_web(web, db)
    validate_rag(rag)
    validate_contract(contract)
    validate_internal_tokens(web, rag, contract)
    print("validated split service environment contracts")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
