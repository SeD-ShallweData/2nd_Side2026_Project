#!/bin/bash
# 개발 서버 실행. 프로젝트 루트에서 ./run.sh
set -e
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
  echo "venv가 없습니다. 먼저 실행하세요:"
  echo "  python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
  exit 1
fi

exec .venv/bin/python -m app.main
