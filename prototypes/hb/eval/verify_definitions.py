"""
1-1c. 정의 조문 재색인(reindex_definitions.py) 결과 검증.

원문 제2조의 호 목록과 DB에 들어있는 split chunk를 대조해서
  - 빠진 호가 있는지
  - 호번호↔정의 용어 매핑이 맞는지(오분류)
  - 각 호의 본문이 원문과 일치하는지
  - 호에 딸리지 않은 머리말/항이 유실되지 않았는지
를 확인한다.

실행: cd webapp && PYTHONPATH="$PWD/pylibs:$PYTHONPATH" python3 eval/verify_definitions.py
"""
import os
import re
import sys

import chromadb

from verify_laws import LAW_MST, fetch_law, norm, strip_citation_prefix, TEXT_TAGS

DB_PATH = (os.environ.get("DONWORRY_DB_PATH") or "").strip() \
    or "/data/shared-SeD/hb/persona_test/labor_law_db"
COLLECTION = (os.environ.get("DONWORRY_COLLECTION") or "").strip() or "labor_law"

TARGETS = ["근로기준법", "임금채권보장법", "근로자퇴직급여 보장법"]

# 원문 호 텍스트에서 정의 용어를 뽑는다. '1. "평균임금"이란 …'
CONCEPT_RE = re.compile(r'^\s*(\d+)\.\s*[“"”]([^”"]+)[”"]\s*(?:이)?란')


def source_definition(root):
    """원문 제2조를 {'head':…, 'hos':{번호: (용어, 텍스트)}, 'tail':[…]} 로 분해."""
    for jo in root.find("조문").findall("조문단위"):
        if jo.findtext("조문여부") == "전문":
            continue
        if (jo.findtext("조문번호") or "").strip() != "2":
            continue
        if (jo.findtext("조문가지번호") or "").strip():
            continue

        head, hos, tail = [], {}, []
        for hang in jo.iter("항"):
            hang_no = (hang.findtext("항번호") or "").strip()
            hang_text = (hang.findtext("항내용") or "").strip()
            ho_list = hang.findall("호")
            if ho_list:
                if hang_text:
                    head.append(hang_text)
                for ho in ho_list:
                    txt = "".join(el.text or "" for el in ho.iter() if el.tag in TEXT_TAGS)
                    m = CONCEPT_RE.match(txt)
                    if m:
                        hos[int(m.group(1))] = (m.group(2).strip(), norm(txt))
                    else:
                        tail.append(("호(용어패턴 아님)", norm(txt)))
            elif hang_text:
                tail.append((f"항 {hang_no}", norm(hang_text)))

        # 항 자체가 없고 조문내용 아래 호가 바로 달린 형태
        if not hos:
            for ho in jo.iter("호"):
                txt = "".join(el.text or "" for el in ho.iter() if el.tag in TEXT_TAGS)
                m = CONCEPT_RE.match(txt)
                if m:
                    hos[int(m.group(1))] = (m.group(2).strip(), norm(txt))
        jomun = (jo.findtext("조문내용") or "").strip()
        if jomun and not head:
            head.append(jomun)
        return {"head": norm("".join(head)), "hos": hos, "tail": tail}
    return None


def main():
    col = chromadb.PersistentClient(path=DB_PATH).get_collection(COLLECTION)
    data = col.get(include=["documents", "metadatas"])

    problems = 0
    for law in TARGETS:
        chunks = [(i, d, m) for i, d, m in zip(data["ids"], data["documents"], data["metadatas"])
                  if m.get("law") == law and m.get("article_id") == "제2조" and m.get("clause")]
        print("=" * 78)
        print(f"■ {law} 제2조 - DB split chunk {len(chunks)}개")

        src = source_definition(fetch_law(LAW_MST[law]))
        if src is None:
            print("  [!] 원문에서 제2조를 찾지 못했습니다")
            problems += 1
            continue
        print(f"  원문 호 {len(src['hos'])}개 / 머리말 {len(src['head'])}자 / "
              f"호 밖 항 {len(src['tail'])}개")

        db_by_ho = {}
        for cid, doc, meta in chunks:
            m = re.search(r"제(\d+)호", meta.get("clause", ""))
            if m:
                db_by_ho[int(m.group(1))] = (cid, doc, meta)

        # 1) 호 누락 / 초과
        miss = sorted(set(src["hos"]) - set(db_by_ho))
        over = sorted(set(db_by_ho) - set(src["hos"]))
        if miss:
            problems += 1
            print(f"  [!] DB에 없는 호: {miss}")
        if over:
            problems += 1
            print(f"  [!] 원문에 없는 호: {over}")
        if not miss and not over:
            print(f"  OK 호 번호 집합 일치 ({sorted(src['hos'])})")

        # 2) 용어 매핑 + 본문 일치
        bad_concept, bad_text = [], []
        for ho in sorted(set(src["hos"]) & set(db_by_ho)):
            want_concept, want_text = src["hos"][ho]
            _cid, doc, meta = db_by_ho[ho]
            if (meta.get("concept") or "").strip() != want_concept:
                bad_concept.append((ho, want_concept, meta.get("concept")))
            got_text = norm(strip_citation_prefix(doc, meta))
            if got_text != want_text:
                bad_text.append((ho, want_text, got_text))

        print(f"  용어 매핑 불일치 {len(bad_concept)}개 / 본문 불일치 {len(bad_text)}개")
        for ho, want, got in bad_concept:
            problems += 1
            print(f"     [!] 제{ho}호: 원문 '{want}' vs DB concept '{got}'")
        for ho, want, got in bad_text[:3]:
            problems += 1
            print(f"     [!] 제{ho}호 본문 다름\n        원문 …{want[:90]}…\n        DB   …{got[:90]}…")

        # 3) 호 밖 텍스트(머리말 / 독립 항) 유실 여부
        all_db = norm("".join(d for _i, d, _m in chunks))
        if src["head"]:
            kept = src["head"][:40] in all_db
            print(f"  머리말 보존: {'OK' if kept else '[!] 유실'}  «{src['head'][:60]}…»")
            if not kept:
                problems += 1
        for label, text in src["tail"]:
            kept = text[:40] in all_db
            print(f"  {label} 보존: {'OK' if kept else '[!] 유실'}  «{text[:60]}…»")
            if not kept:
                problems += 1
        print()

    print("=" * 78)
    print(f"검사 종료 - 문제 항목 {problems}건")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
