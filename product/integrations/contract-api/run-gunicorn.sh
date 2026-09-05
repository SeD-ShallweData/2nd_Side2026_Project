#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$SCRIPT_DIR"

GUNICORN="$SCRIPT_DIR/.venv/bin/gunicorn"
PYTHON="$SCRIPT_DIR/.venv/bin/python"
if [[ ! -x "$GUNICORN" ]]; then
  echo "계약서 분석 Gunicorn 실행 파일이 없습니다. .venv에 requirements.lock을 설치하세요." >&2
  exit 1
fi
if [[ ! -x "$PYTHON" ]]; then
  echo "계약서 분석 Python 실행 파일이 없습니다." >&2
  exit 1
fi

threads="${CONTRACT_GUNICORN_THREADS:-2}"
timeout="${CONTRACT_GUNICORN_TIMEOUT:-300}"
if [[ ! "$threads" =~ ^[1-9][0-9]*$ ]] || (( threads > 16 )); then
  echo "CONTRACT_GUNICORN_THREADS는 1~16의 정수여야 합니다." >&2
  exit 1
fi
if [[ ! "$timeout" =~ ^[1-9][0-9]*$ ]] || (( timeout > 900 )); then
  echo "CONTRACT_GUNICORN_TIMEOUT은 1~900초의 정수여야 합니다." >&2
  exit 1
fi

# Production privacy defaults are intentionally not overridable from the
# shared environment file. Contract/chat source text must not be persisted.
export HOST=127.0.0.1
export PORT=8000
export DEBUG=0
export SAVE_CHAT_LOG=0
export SAVE_CONTRACT_LOG=0
export CONTRACT_CACHE_ENABLED=0

# Local-only and dependency-free. Never launch from a missing, malformed, or
# altered prompt/knowledge tree, even when invoked outside systemd.
"$PYTHON" "$SCRIPT_DIR/verify_contract_assets.py" >/dev/null

exec "$PYTHON" -m gunicorn \
  --name moneyworry-contract \
  --bind 127.0.0.1:8000 \
  --workers 1 \
  --worker-class gthread \
  --threads "$threads" \
  --timeout "$timeout" \
  --graceful-timeout 60 \
  --keep-alive 5 \
  --access-logfile - \
  --error-logfile - \
  app.main:app
