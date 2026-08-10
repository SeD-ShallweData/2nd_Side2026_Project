"""
다개념 '정의' 조문을 항·호 단위로 분리해 재색인한다.

대상: 각 호가 서로 독립된 용어를 정의하는 조문(= 한 chunk에 여러 개념이 섞여 있어
검색이 안 되는 케이스). 근로기준법 제2조의 "평균임금"이 대표적으로,
조문 전체가 한 chunk라 "평균임금 계산" 질문에 매칭되지 않았다.

분리하지 않는 것: '보존 대상 서류', '권한의 위임', 과태료 조항처럼 호가 많아도
전체가 하나의 개념을 이루는 열거형 조문. 쪼개면 각 조각이 맥락을 잃는다.
"""
import re

import bot

TARGETS = [
    ("근로기준법", "제2조"),
    ("임금채권보장법", "제2조"),
    ("근로자퇴직급여 보장법", "제2조"),
]

# "1. “평균임금”이란 ..." / '1. "보수"란 ...' 에서 호번호와 정의 용어를 뽑는다.
HO_PATTERN = re.compile(r'^\s*(\d+)\.\s*[“"”]([^”"]+)[”"]\s*(?:이)?란', re.M)


def unwrap(text):
    """원문의 하드 줄바꿈(문장 중간 개행)을 공백으로 합친다."""
    return re.sub(r"\s*\n\s*", " ", text).strip()


def normalize_ho_linebreaks(text):
    """첫 호가 조문 제목과 같은 줄에 붙어 있는 경우(예: '제2조(정의) 1. "근로자"란')
    호 패턴이 줄머리에 오도록 개행을 넣어준다."""
    return re.sub(r'(?<!\n)(\s)(\d+\.\s*[“"”][^”"]+[”"]\s*(?:이)?란)', r"\n\2", text)


def split_definition_article(doc, meta):
    """정의 조문을 호 단위 chunk 리스트로 분리."""
    law = meta["law"]
    article_id = meta["article_id"]
    doc = normalize_ho_linebreaks(doc)

    # ② 이후 별도 항(호에 딸리지 않은 독립 항)을 미리 떼어낸다.
    hang2_match = re.search(r"\n(②.*)$", doc, re.S)
    hang2_text = unwrap(hang2_match.group(1)) if hang2_match else None
    body = doc[: hang2_match.start()] if hang2_match else doc

    matches = list(HO_PATTERN.finditer(body))
    if not matches:
        return []

    # 근로기준법 제2조는 "① ... 다음과 같다" 아래에 호가 달려 제1항제N호,
    # 나머지 두 법은 항 없이 바로 호가 나열되어 제N호.
    has_hang1 = "①" in body

    chunks = []
    for i, m in enumerate(matches):
        ho_no = m.group(1)
        concept = m.group(2).strip()
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(body)
        ho_text = unwrap(body[start:end])

        clause = f"제1항제{ho_no}호" if has_hang1 else f"제{ho_no}호"
        citation = f"{law} {article_id}{clause}"

        chunks.append({
            "doc": f"{citation} (정의 - {concept}) {ho_text}",
            "meta": {
                "law": law,
                "article_id": article_id,
                "clause": clause,
                "concept": concept,
                "title": meta.get("title", "정의"),
                "law_no": meta.get("law_no", ""),
                "chapter": meta.get("chapter", ""),
                "enforcement_date": meta.get("enforcement_date", ""),
            },
        })

    # ②항은 평균임금(제1항제6호)을 보정하는 내용이므로 평균임금 개념으로 붙인다.
    if hang2_text:
        concept = "평균임금" if "평균임금" in hang2_text else meta.get("title", "정의")
        citation = f"{law} {article_id}제2항"
        chunks.append({
            "doc": f"{citation} (정의 - {concept}) {hang2_text}",
            "meta": {
                "law": law,
                "article_id": article_id,
                "clause": "제2항",
                "concept": concept,
                "title": meta.get("title", "정의"),
                "law_no": meta.get("law_no", ""),
                "chapter": meta.get("chapter", ""),
                "enforcement_date": meta.get("enforcement_date", ""),
            },
        })

    return chunks


def main():
    all_docs = bot.collection.get()
    before = bot.collection.count()
    print(f"재색인 전 chunk 수: {before}\n")

    remove_ids = []
    new_chunks = []

    for _id, doc, meta in zip(all_docs["ids"], all_docs["documents"], all_docs["metadatas"]):
        if (meta.get("law"), meta.get("article_id")) in TARGETS and meta.get("title") == "정의":
            if meta.get("clause"):
                continue  # 이미 분리된 chunk (재실행 대비)
            chunks = split_definition_article(doc, meta)
            if not chunks:
                print(f"  [건너뜀] {meta['law']} {meta['article_id']} - 호 패턴 없음")
                continue

            # 원문의 호 번호가 빠짐없이 분리됐는지 검증(첫 호 누락 등 파싱 사고 방지)
            src_hos = {int(n) for n in re.findall(r'(\d+)\.\s*[“"”][^”"]+[”"]\s*(?:이)?란', doc)}
            got_hos = {
                int(re.search(r"제(\d+)호", c["meta"]["clause"]).group(1))
                for c in chunks if "호" in c["meta"]["clause"]
            }
            missing = src_hos - got_hos
            if missing:
                raise SystemExit(
                    f"[중단] {meta['law']} {meta['article_id']}: 호 누락 {sorted(missing)} "
                    f"(원문 {len(src_hos)}개 중 {len(got_hos)}개만 분리)"
                )

            print(f"  {meta['law']} {meta['article_id']}(정의) → {len(chunks)}개로 분리 "
                  f"(원문 호 {len(src_hos)}개 전부 확인)")
            for c in chunks:
                print(f"      {c['meta']['clause']:10s} {c['meta']['concept']}")
            remove_ids.append(_id)
            new_chunks.extend(chunks)

    if not new_chunks:
        print("\n분리할 조문이 없습니다 (이미 재색인됨).")
        return

    docs = [c["doc"] for c in new_chunks]
    metas = [c["meta"] for c in new_chunks]
    ids = [f"labor_law_split_{i}" for i in range(len(new_chunks))]

    print("\n임베딩 계산 중...")
    embeddings = bot.embed_model.encode(docs, normalize_embeddings=True, show_progress_bar=False)

    bot.collection.delete(ids=remove_ids)
    bot.collection.add(ids=ids, embeddings=embeddings.tolist(), documents=docs, metadatas=metas)

    after = bot.collection.count()
    print(f"\n제거된 통합 조문: {len(remove_ids)}개")
    print(f"추가된 분리 chunk: {len(new_chunks)}개")
    print(f"재색인 후 chunk 수: {before} → {after} ({after - before:+d})")


if __name__ == "__main__":
    main()
