"""Production WSGI entrypoint for the labor-law RAG service."""

import os

import retriever
from app import app as application


if os.getenv("RAG_PRELOAD", "1") == "1":
    # Run inside the single Gunicorn worker. A failed model/collection load must
    # fail worker boot instead of advertising a permanently unready service.
    retriever.warmup()
