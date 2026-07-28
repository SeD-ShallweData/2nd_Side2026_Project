#!/bin/bash
set -e
cd "$(dirname "$0")"
export PYTHONPATH="$(pwd)/pylibs:$PYTHONPATH"
export HF_HOME="$(pwd)/hf_cache"
export TRANSFORMERS_CACHE="$(pwd)/hf_cache"
exec python3 -u app.py
