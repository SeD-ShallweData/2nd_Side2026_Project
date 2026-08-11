"""프로젝트 전역 설정.

API 키는 팀 공용 원본(`/data/shared-SeD/api_key.env`)을 절대경로로 참조합니다.
사본을 만들지 않습니다. 키 값은 절대 로그·응답에 노출하지 않습니다.
"""

import os
from pathlib import Path

from dotenv import load_dotenv

# ── 경로 ──────────────────────────────────────────────────────────────
ROOT = Path(__file__).resolve().parent.parent

WEB_DIR = ROOT / "web"
PROMPT_DIR = ROOT / "prompts"
KNOWLEDGE_DIR = ROOT / "knowledge"
LOG_DIR = ROOT / "logs"

# 제품 서비스에서는 캐시·로그를 기본 비활성화하며, 필요한 경우에만 이 로컬 경로를 사용합니다.
DATA_DIR = ROOT / "data"
OUTPUT_DIR = ROOT / "outputs"
DESIGN_DIR = ROOT / "design"

CHAT_LOG_DIR = OUTPUT_DIR / "chat_logs"
EVAL_DIR = OUTPUT_DIR / "eval"
FEEDBACK_DIR = OUTPUT_DIR / "feedback"
EXPORT_DIR = OUTPUT_DIR / "exports"   # 공유용 산출물 (/download 로 노출)

CONTRACT_DIR = DATA_DIR / "contracts"                  # 더미 계약서 원본
CONTRACT_SAMPLE_DIR = CONTRACT_DIR / "samples"
CONTRACT_CACHE_DIR = OUTPUT_DIR / "contract" / "parsed"   # Document Parse 결과 캐시
CONTRACT_LOG_DIR = OUTPUT_DIR / "contract" / "reviews"    # 진단 로그
FONT_DIR = DATA_DIR / "fonts"                          # 더미 PDF 생성용 한글 TTF

# ── 키 로드 ───────────────────────────────────────────────────────────
TEAM_ENV_FILE = os.getenv("API_KEY_ENV_FILE", "/data/shared-SeD/api_key.env")
LOCAL_ENV_FILE = ROOT / "config.env"  # 선택. 모델명·포트 등 개인 오버라이드용


def _load_env(path, *, override: bool = False) -> str | None:
    """키 파일을 읽습니다. 실패해도 **서버를 죽이지 않습니다.**

    2026-08-08 — 팀 공용 `/data/shared-SeD/api_key.env`의 권한이 777에서
    600(root 전용)으로 바뀌면서 `load_dotenv()`가 PermissionError를 던졌고,
    그것이 import 시점이라 **서버가 통째로 부팅되지 않았습니다.**
    랜딩·위험카드·계약서 화면은 키가 없어도 볼 수 있는데 함께 막혔습니다.

    키가 없으면 LLM 호출만 실패하면 됩니다 (llm._resolve 가 이미 처리합니다).
    실패 사유는 돌려주고 check_env.py / api/health 가 그대로 보여줍니다.
    """
    try:
        load_dotenv(path, override=override)
    except PermissionError:
        return f"읽기 권한이 없습니다 ({path}). 관리자에게 권한 복구를 요청하세요."
    except OSError as exc:
        return f"읽지 못했습니다 ({path}): {exc}"
    return None


# 실패 사유. None 이면 정상입니다. 키 값 자체는 여기 담지 않습니다.
TEAM_ENV_ERROR = _load_env(TEAM_ENV_FILE)
if LOCAL_ENV_FILE.exists():
    _load_env(LOCAL_ENV_FILE, override=True)


# ── LLM 프로바이더 ────────────────────────────────────────────────────
PROVIDERS = {
    "upstage": {
        "label": "Upstage Solar",
        "api_key": os.getenv("Upstage_API_KEY"),  # CamelCase 주의
        "url": os.getenv("UPSTAGE_API_URL", "https://api.upstage.ai/v1/chat/completions"),
        "model": os.getenv("UPSTAGE_MODEL", "solar-pro3"),
    },
    "skt": {
        "label": "SKT A.X",
        "api_key": os.getenv("SKT_API_KEY"),
        "url": os.getenv("SKT_API_URL", "https://awf-gw.adot.ai/v1/chat/completions"),
        "model": os.getenv("SKT_MODEL", "A.X-K1"),
    },
}

DEFAULT_PROVIDER = os.getenv("DEFAULT_PROVIDER", "upstage")

# ── 생성 파라미터 기본값 ──────────────────────────────────────────────
# 0.0 — 상담 서비스라 같은 질문에 같은 답이 나와야 합니다.
# 다만 두 API 모두 seed를 무시하므로 0에서도 완전한 재현은 되지 않습니다.
# 표현의 흔들림은 프롬프트의 출력 골격으로 잡습니다. docs/60-답변-일관성.md 참조.
DEFAULT_TEMPERATURE = float(os.getenv("TEMPERATURE", "0.0"))
DEFAULT_MAX_TOKENS = int(os.getenv("MAX_TOKENS", "2048"))
REQUEST_TIMEOUT = int(os.getenv("REQUEST_TIMEOUT", "120"))

# 답변 생성에 넘길 최근 대화 턴 수. 학습노트 권고는 3~5턴입니다.
MAX_HISTORY_TURNS = int(os.getenv("MAX_HISTORY_TURNS", "5"))

# ── 지식 주입 (RAG 전 단계) ───────────────────────────────────────────
# knowledge/ 문서를 통째로 시스템 프롬프트에 붙일 때의 문자 상한.
# 이 값에 자주 닿으면 RAG로 넘어갈 시점입니다.
KNOWLEDGE_BUDGET = int(os.getenv("KNOWLEDGE_BUDGET", "16000"))

# ── 멀티턴 질의 재작성 (호출 ①) ───────────────────────────────────────
# 후속 질문("그거 더 설명해줘")을 이력 없이도 이해되는 독립 질문으로 바꿉니다.
# RAG를 붙이면 이 결과가 검색 질의가 됩니다.
REWRITE_ENABLED = os.getenv("REWRITE_ENABLED", "1") == "1"
REWRITE_PROVIDER = os.getenv("REWRITE_PROVIDER", "upstage")
REWRITE_HISTORY_TURNS = int(os.getenv("REWRITE_HISTORY_TURNS", "3"))
REWRITE_MAX_TOKENS = int(os.getenv("REWRITE_MAX_TOKENS", "200"))

# ── 출력 가드레일 ─────────────────────────────────────────────────────
GUARDRAILS_ENABLED = os.getenv("GUARDRAILS_ENABLED", "1") == "1"

# block — 위반 시 답변을 대체 문구로 교체 (실서비스 동작)
# warn  — 원문을 그대로 두고 무엇에 걸렸는지만 표시 (프롬프트 다듬는 개발 단계용)
GUARDRAIL_MODE = os.getenv("GUARDRAIL_MODE", "block").strip().lower()
if GUARDRAIL_MODE not in ("block", "warn"):
    GUARDRAIL_MODE = "block"

# ── 근로계약서 진단 ───────────────────────────────────────────────────
# PDF 인식은 Upstage Document Parse(/v1/document-digitization)를 씁니다.
# solar-pro3의 chat/completions는 파일 입력을 받지 않습니다. app/contract/parse.py 참조.
CONTRACT_ENABLED = os.getenv("CONTRACT_ENABLED", "1") == "1"
CONTRACT_PARSE_TIMEOUT = int(os.getenv("CONTRACT_PARSE_TIMEOUT", "180"))

# 파싱 결과를 파일 해시로 캐시합니다. Parse 호출은 건당 과금이라 기본 ON입니다.
CONTRACT_CACHE_ENABLED = os.getenv("CONTRACT_CACHE_ENABLED", "1") == "1"

# 프롬프트에 넣을 계약서 본문 문자 상한. 근로계약서는 보통 3천~8천자입니다.
CONTRACT_TEXT_BUDGET = int(os.getenv("CONTRACT_TEXT_BUDGET", "20000"))

# 조항 구조화 추출에 쓰는 프로바이더. 판정의 입력이라 정확도가 우선이고,
# Document Parse와 같은 계열이라 기본은 upstage로 고정합니다.
CONTRACT_EXTRACT_PROVIDER = os.getenv("CONTRACT_EXTRACT_PROVIDER", "upstage")
CONTRACT_EXTRACT_MAX_TOKENS = int(os.getenv("CONTRACT_EXTRACT_MAX_TOKENS", "4096"))

# 판정 결과를 사람 말로 푸는 해설. 여기만 모델을 바꿔 비교할 수 있습니다.
CONTRACT_EXPLAIN_MAX_TOKENS = int(os.getenv("CONTRACT_EXPLAIN_MAX_TOKENS", "2048"))

# 진단 로그 저장 — 계약서에는 이름·사업장이 들어 있어 기본은 OFF입니다.
# 켤 때는 app/contract/review.py의 마스킹을 함께 확인하세요.
SAVE_CONTRACT_LOG = os.getenv("SAVE_CONTRACT_LOG", "0") == "1"

# ── 서버 ──────────────────────────────────────────────────────────────
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))
DEBUG = os.getenv("DEBUG", "1") == "1"

# 대화 로그 저장 여부. 개인정보가 섞이는 실사용 단계에서는 재검토가 필요합니다.
SAVE_CHAT_LOG = os.getenv("SAVE_CHAT_LOG", "1") == "1"


def masked(value: str | None) -> str:
    """키 존재 확인용. 앞 4글자만 남기고 가립니다."""
    if not value:
        return "(없음)"
    return f"{value[:4]}{'*' * 8} (len={len(value)})"


def available_providers() -> list[str]:
    return [name for name, cfg in PROVIDERS.items() if cfg["api_key"]]
