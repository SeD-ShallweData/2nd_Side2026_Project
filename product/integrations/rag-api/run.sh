#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
  echo "RAG 가상환경이 없습니다."
  echo "python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
  exit 1
fi

exec .venv/bin/python app.py
