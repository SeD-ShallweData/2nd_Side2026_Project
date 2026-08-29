#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
  echo "계약서 분석 가상환경이 없습니다."
  echo "CPython 3.12.13으로 .venv를 만든 뒤 .venv/bin/python -m pip install --require-hashes -r requirements.lock 을 실행하세요."
  exit 1
fi

export HOST="${CONTRACT_HOST:-127.0.0.1}"
export PORT="${CONTRACT_PORT:-8000}"
export DEBUG=0
export SAVE_CHAT_LOG=0
export SAVE_CONTRACT_LOG=0
export CONTRACT_CACHE_ENABLED=0

.venv/bin/python verify_contract_assets.py >/dev/null
exec .venv/bin/python -m app.main
