"""Offline evaluation tokenizer; these counts are NOT Solar billing tokens."""
import json
import sys
from tokenizers import Tokenizer

tokenizer = Tokenizer.from_file(sys.argv[1])
for line in sys.stdin:
    request = json.loads(line)
    count = len(tokenizer.encode(request["text"], add_special_tokens=False).ids)
    print(json.dumps({"id": request["id"], "tokens": count}), flush=True)
