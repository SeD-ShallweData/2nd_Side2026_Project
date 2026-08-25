#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$SCRIPT_DIR"

GUNICORN="$SCRIPT_DIR/.venv/bin/gunicorn"
PYTHON="$SCRIPT_DIR/.venv/bin/python"
if [[ ! -x "$GUNICORN" ]]; then
  echo "RAG Gunicorn 실행 파일이 없습니다. .venv에 requirements.lock을 설치하세요." >&2
  exit 1
fi
if [[ ! -x "$PYTHON" ]]; then
  echo "RAG Python 실행 파일이 없습니다." >&2
  exit 1
fi

threads="${RAG_GUNICORN_THREADS:-2}"
timeout="${RAG_GUNICORN_TIMEOUT:-180}"
if [[ ! "$threads" =~ ^[1-9][0-9]*$ ]] || (( threads > 16 )); then
  echo "RAG_GUNICORN_THREADS는 1~16의 정수여야 합니다." >&2
  exit 1
fi
if [[ ! "$timeout" =~ ^[1-9][0-9]*$ ]] || (( timeout > 900 )); then
  echo "RAG_GUNICORN_TIMEOUT은 1~900초의 정수여야 합니다." >&2
  exit 1
fi

# Production always warms the single worker and keeps the model cache on the
# persistent data disk, regardless of stale values in the shared env file.
export RAG_PRELOAD=1
export HF_HOME=/srv/moneyworry/hf
export HF_HUB_CACHE=/srv/moneyworry/hf/hub
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export RAG_DB_PATH=/run/moneyworry-rag/chroma
export RAG_ASSET_MANIFEST="$SCRIPT_DIR/config/rag_assets.v1.json"
export RAG_EMBEDDING_MODEL=BAAI/bge-m3
export RAG_MODEL_REVISION=5617a9f61b028005a4858fdac845db406aefb181
export RAG_MODEL_LOCAL_ONLY=1
export RAG_REQUIRE_ASSET_SEAL=1
export RAG_COLLECTION=labor_law
export RAG_EXPECTED_DOCUMENT_COUNT=583
export RAG_EXPECTED_EMBEDDING_DIMENSION=1024
export RAG_DISTANCE_THRESHOLD=0.42
export RAG_STRONG_MATCH_DISTANCE=0.30
export TOKENIZERS_PARALLELISM=false

exec "$PYTHON" -m gunicorn \
  --name moneyworry-rag \
  --bind 127.0.0.1:5051 \
  --workers 1 \
  --worker-class gthread \
  --threads "$threads" \
  --timeout "$timeout" \
  --graceful-timeout 60 \
  --keep-alive 5 \
  --access-logfile - \
  --error-logfile - \
  wsgi:application
