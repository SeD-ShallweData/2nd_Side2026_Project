#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
  echo "계약서 분석 가상환경이 없습니다."
  echo "python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
  exit 1
fi

export HOST="${CONTRACT_HOST:-127.0.0.1}"
export PORT="${CONTRACT_PORT:-8000}"
export DEBUG=0
export SAVE_CHAT_LOG=0
export SAVE_CONTRACT_LOG=0
export CONTRACT_CACHE_ENABLED=0

exec .venv/bin/python -m app.main
