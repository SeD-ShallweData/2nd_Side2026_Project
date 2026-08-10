#!/bin/bash
set -e
cd "$(dirname "$0")"

# 그냥 python3를 쓰면 셸에 활성화된 venv가 잡혀서, 거기 flask가 없으면 기동에 실패한다.
# (개발 서버에서는 /data/shared-SeD/.venv가 PATH를 가로채 ModuleNotFoundError가 났다)
# 기본은 시스템 파이썬을 쓰고, 다른 인터프리터가 필요하면 PYTHON 환경변수로 지정한다.
#   PYTHON=python3 ./run.sh
PYTHON="${PYTHON:-/usr/bin/python3}"
command -v "$PYTHON" >/dev/null || PYTHON=python3

export PYTHONPATH="$(pwd)/pylibs:$PYTHONPATH"
export HF_HOME="$(pwd)/hf_cache"
export TRANSFORMERS_CACHE="$(pwd)/hf_cache"
exec "$PYTHON" -u app.py
