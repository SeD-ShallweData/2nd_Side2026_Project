#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$SCRIPT_DIR"

if [ ! -x .venv/bin/python ]; then
  echo "RAG 가상환경이 없습니다."
  echo "CPython 3.12.13으로 .venv를 만든 뒤 .venv/bin/python -m pip install --require-hashes -r requirements.lock 을 실행하세요."
  exit 1
fi

export HF_HOME="${HF_HOME:-$SCRIPT_DIR/.cache/huggingface}"
export HF_HUB_CACHE="${HF_HUB_CACHE:-$HF_HOME/hub}"
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
RAG_DB_SOURCE="${RAG_DB_SOURCE:-${RAG_DB_PATH:-$SCRIPT_DIR/data/labor_law_db}}"
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

RAG_RUNTIME_ROOT="$(mktemp -d -t moneyworry-rag.XXXXXXXX)"
cleanup() {
  rm -rf -- "$RAG_RUNTIME_ROOT"
}
trap cleanup EXIT HUP INT TERM

.venv/bin/python prepare_rag_assets.py stage-runtime \
  --manifest "$RAG_ASSET_MANIFEST" \
  --hf-home "$HF_HOME" \
  --hub-cache "$HF_HUB_CACHE" \
  --rag-db "$RAG_DB_SOURCE" \
  --runtime-rag-db "$RAG_RUNTIME_ROOT/chroma"
export RAG_DB_PATH="$RAG_RUNTIME_ROOT/chroma"

.venv/bin/python app.py
