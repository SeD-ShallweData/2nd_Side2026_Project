"""
법령 벡터DB(labor_law_db, collection=labor_law)에 기본 법령 4개를 조문 단위로 추가한다.

원문은 law.go.kr 공개 Open API(OC=test)로 XML을 받아 파싱한다.
- 조문여부="전문" 인 항목은 장/절 제목(chapter 컨텍스트)으로만 쓰고 저장하지 않는다.
- 조문제목이 없는 항목(삭제된 조문 등)은 건너뛴다.
- 항/호/목 구조는 줄바꿈으로 이어붙여, 기존 근로기준법 조문과 같은 형태의 본문 텍스트를 만든다.
"""
import re
import xml.etree.ElementTree as ET

import requests

import bot

LAWS = [
    {"name": "임금채권보장법", "mst": "279735"},
    {"name": "최저임금법", "mst": "218303"},
    {"name": "근로기준법 시행령", "mst": "270551"},
    {"name": "근로자퇴직급여 보장법", "mst": "284455"},
]

API_URL = "https://www.law.go.kr/DRF/lawService.do"


def fetch_law_xml(mst):
    resp = requests.get(
        API_URL,
        params={"OC": "test", "target": "law", "MST": mst, "type": "XML"},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.content


def strip_trailing_annotation(text):
    return re.sub(r"\s*<[^>]*>\s*$", "", text).strip()


def strip_header_prefix(text, title):
    pattern = r"^제\d+조(?:의\d+)?\s*\(" + re.escape(title) + r"\)\s*"
    return re.sub(pattern, "", text).strip()


def normalize_spaces(text):
    return re.sub(r"[ \t]{2,}", " ", text).strip()


def parse_law(xml_bytes, law_name):
    root = ET.fromstring(xml_bytes)
    info = root.find("기본정보")
    law_no = info.findtext("공포번호") if info is not None else None

    articles = []
    seen_ids = set()
    current_chapter = None

    jomun_root = root.find("조문")
    if jomun_root is None:
        return articles

    for jo in jomun_root.findall("조문단위"):
        raw_content = (jo.findtext("조문내용") or "").strip()

        if jo.findtext("조문여부") == "전문":
            chapter = strip_trailing_annotation(raw_content)
            if chapter:
                current_chapter = chapter
            continue

        title = jo.findtext("조문제목")
        if not title:
            # 삭제된 조문 등 실질 내용이 없는 항목
            continue

        article_no = jo.findtext("조문번호")
        branch_no = (jo.findtext("조문가지번호") or "").strip()
        article_id = f"제{article_no}조" + (f"의{branch_no}" if branch_no else "")

        if article_id in seen_ids:
            continue
        seen_ids.add(article_id)

        enforce_raw = (jo.findtext("조문시행일자") or "").strip()
        enforcement_date = (
            f"{enforce_raw[0:4]}-{enforce_raw[4:6]}-{enforce_raw[6:8]}"
            if len(enforce_raw) == 8 else ""
        )

        body_parts = []

        # <조문내용>에는 '제N조(제목)' 머리말만 들어있는 경우도 있지만, 항이 하나뿐인
        # 조문에서는 본문 문장("…란 다음 각 호의 사항을 말한다")까지 여기에 들어온다.
        # 항이 있다고 해서 조문내용을 통째로 버리면 그 문장이 사라진다.
        lead = normalize_spaces(strip_header_prefix(raw_content, title))
        if lead:
            body_parts.append(lead)

        def collect_ho_mok(parent):
            # <목>은 <호>의 자식으로 올 때도 있고 <항>의 직속 자식으로 올 때도 있다.
            # 중첩 구조를 가정하지 말고 문서 순서대로 훑는다.
            for child in parent:
                if child.tag not in ("호", "목"):
                    continue
                text = normalize_spaces(child.findtext(f"{child.tag}내용") or "")
                if text:
                    body_parts.append(text)
                for mok in child.findall("목"):
                    mok_text = normalize_spaces(mok.findtext("목내용") or "")
                    if mok_text:
                        body_parts.append(mok_text)

        hangs = jo.findall("항")
        for hang in hangs:
            hang_text = normalize_spaces(hang.findtext("항내용") or "")
            if hang_text:
                body_parts.append(hang_text)
            collect_ho_mok(hang)
        if not hangs:
            collect_ho_mok(jo)  # 항 없이 호가 조문단위에 바로 달린 형태

        if not body_parts:
            continue

        doc_text = f"{article_id}({title}) " + body_parts[0]
        for part in body_parts[1:]:
            doc_text += "\n" + part

        articles.append({
            "article_id": article_id,
            "title": title,
            "chapter": current_chapter or "",
            "law": law_name,
            "law_no": law_no or "",
            "enforcement_date": enforcement_date,
            "doc": doc_text,
        })

    return articles


def main():
    existing_laws = {m.get("law") for m in bot.collection.get()["metadatas"]}
    print(f"기존 DB에 있는 법령: {sorted(existing_laws)}")

    all_articles = []
    per_law_counts = []
    for law in LAWS:
        if law["name"] in existing_laws:
            print(f"  [건너뜀] {law['name']} - 이미 DB에 존재")
            continue
        articles = parse_law(fetch_law_xml(law["mst"]), law["name"])
        print(f"  {law['name']}: {len(articles)}개 조문 파싱")
        per_law_counts.append((law["name"], len(articles)))
        all_articles.extend(articles)

    if not all_articles:
        print("추가할 조문이 없습니다.")
        return

    existing_count = bot.collection.count()
    print(f"\n기존 총 조문 수: {existing_count}")

    docs = [a["doc"] for a in all_articles]
    metadatas = [
        {
            "article_id": a["article_id"],
            "title": a["title"],
            "chapter": a["chapter"],
            "law": a["law"],
            "law_no": a["law_no"],
            "enforcement_date": a["enforcement_date"],
        }
        for a in all_articles
    ]
    ids = [f"labor_law_{existing_count + i}" for i in range(len(all_articles))]

    print("임베딩 계산 중...")
    embeddings = bot.embed_model.encode(docs, normalize_embeddings=True, show_progress_bar=False)

    bot.collection.add(
        ids=ids,
        embeddings=embeddings.tolist(),
        documents=docs,
        metadatas=metadatas,
    )

    print("\n=== 추가 결과 ===")
    for name, cnt in per_law_counts:
        print(f"  {name}: {cnt}개")
    print(f"\n전체 조문 수(collection.count()): {bot.collection.count()}")


if __name__ == "__main__":
    main()
