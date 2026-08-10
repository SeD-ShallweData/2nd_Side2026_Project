"""대화 로그 저장.

JSONL 한 줄 = 한 턴. 나중에 프롬프트 평가·RAG 학습 데이터로 재활용합니다.
저장 위치는 outputs/chat_logs/ (→ /data/shared-SeD/csh/outputs/chat_logs/).
"""

import json
import threading
from datetime import datetime, timezone

from . import config

_lock = threading.Lock()


def log_turn(record: dict) -> None:
    if not config.SAVE_CHAT_LOG:
        return
    now = datetime.now(timezone.utc).astimezone()
    config.CHAT_LOG_DIR.mkdir(parents=True, exist_ok=True)
    path = config.CHAT_LOG_DIR / f"{now:%Y-%m-%d}.jsonl"
    line = json.dumps({"ts": now.isoformat(), **record}, ensure_ascii=False)
    with _lock:
        with path.open("a", encoding="utf-8") as fp:
            fp.write(line + "\n")


def log_feedback(record: dict) -> None:
    """모델 비교 화면의 '이쪽이 낫다' 투표를 남깁니다.

    프롬프트를 고칠 때 어느 쪽이 실제로 나아졌는지 판단하는 근거가 됩니다.
    """
    now = datetime.now(timezone.utc).astimezone()
    config.FEEDBACK_DIR.mkdir(parents=True, exist_ok=True)
    path = config.FEEDBACK_DIR / f"{now:%Y-%m}.jsonl"
    line = json.dumps({"ts": now.isoformat(), **record}, ensure_ascii=False)
    with _lock:
        with path.open("a", encoding="utf-8") as fp:
            fp.write(line + "\n")


def log_contract_review(record: dict) -> None:
    """근로계약서 진단 결과를 남깁니다. **기본은 저장하지 않습니다.**

    계약서에는 이름·주소·사업장명이 들어 있어 대화 로그와 위험도가 다릅니다.
    켤 때(`SAVE_CONTRACT_LOG=1`)도 계약서 본문과 원문 인용은 남기지 않고,
    판정 코드와 계산 근거만 남깁니다 — 규칙을 고칠 때 필요한 것은 그것뿐입니다.
    """
    if not config.SAVE_CONTRACT_LOG:
        return
    now = datetime.now(timezone.utc).astimezone()
    config.CONTRACT_LOG_DIR.mkdir(parents=True, exist_ok=True)
    path = config.CONTRACT_LOG_DIR / f"{now:%Y-%m}.jsonl"
    line = json.dumps({"ts": now.isoformat(), **record}, ensure_ascii=False)
    with _lock:
        with path.open("a", encoding="utf-8") as fp:
            fp.write(line + "\n")


def save_eval(name: str, rows: list[dict]) -> str:
    """프롬프트 배치 평가 결과를 outputs/eval/ 아래에 남깁니다."""
    now = datetime.now(timezone.utc).astimezone()
    config.EVAL_DIR.mkdir(parents=True, exist_ok=True)
    path = config.EVAL_DIR / f"{now:%Y%m%d-%H%M%S}_{name}.jsonl"
    with path.open("w", encoding="utf-8") as fp:
        for row in rows:
            fp.write(json.dumps(row, ensure_ascii=False) + "\n")
    return str(path)
