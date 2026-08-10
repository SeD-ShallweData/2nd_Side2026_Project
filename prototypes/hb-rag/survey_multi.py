import re
from collections import defaultdict
import bot

docs = bot.collection.get()
rows = list(zip(docs["ids"], docs["documents"], docs["metadatas"]))
print(f"총 chunk: {len(rows)}\n")

# 항(①②③) / 호(1. 2. 3.) 개수 세기
CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮"

def count_hangs(doc):
    return sum(1 for ch in CIRCLED if ch in doc)

def count_hos(doc):
    return len(re.findall(r"^\s*\d+\.\s", doc, re.M))

def has_definition_pattern(doc):
    # "~란 ... 말한다" / "~라 함은" 형태가 여러 번 나오면 다개념 정의 조항
    return len(re.findall(r'[“"”\'][^”"\']{1,20}[”"\'](?:이|가)?\s*란|라\s*함은', doc))

print("=== 다개념 의심 조문 (정의 패턴 2개 이상 OR 호 6개 이상) ===")
suspects = []
for _id, doc, m in rows:
    ndef = has_definition_pattern(doc)
    nho = count_hos(doc)
    nhang = count_hangs(doc)
    if ndef >= 2 or nho >= 6:
        suspects.append((ndef, nho, nhang, len(doc), m, doc))

suspects.sort(key=lambda x: (-x[0], -x[1]))
for ndef, nho, nhang, ln, m, doc in suspects:
    print(f"  정의패턴={ndef:2d} 호={nho:2d} 항={nhang:2d} 길이={ln:5d}  [{m['law']}] {m['article_id']}({m['title']})")

print(f"\n의심 조문 총 {len(suspects)}개")
