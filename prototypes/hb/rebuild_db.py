"""
법령 벡터DB를 law.go.kr 원문에서 통째로 다시 만든다.

add_laws.py가 '없는 법령을 이어붙이는' 스크립트라면, 이쪽은 '처음부터 다시 쌓는' 쪽이다.
아래 문제들이 누적 적재로는 풀리지 않아 재구축이 필요했다.
  - 근로기준법에 부칙 조문이 본칙 조문번호(제1·3~8조)를 차지한 채 섞여 있었음
  - 개정 전/후 조문이 같은 조문번호로 중복 적재돼 있었음(제37조, 제43조의2·3, 제109조)
  - 시행일 메타데이터가 구버전(2025-02-23) 그대로였음
  - 파서가 단일 항 조문의 <조문내용> 본문과 <목>을 누락시켰음(add_laws.py에서 수정됨)

ID는 순번이 아니라 조문에서 결정론적으로 만든다(kis_a43_2 형태).
같은 스크립트를 다시 돌리면 같은 ID가 나오므로 재실행해도 어긋나지 않는다.

실행 (반드시 사본 경로를 지정할 것):
    cd webapp
    export PYTHONPATH="$PWD/pylibs:$PYTHONPATH"
    export DONWORRY_DB_PATH=/data/shared-SeD/hb/persona_test/labor_law_db_fix
    python3 rebuild_db.py
"""
import argparse
import re
import sys

import add_laws
import bot
import reindex_definitions

# 운영 중인 서버가 열어둔 DB. 실수로 여기에 쓰지 않도록 막는다.
LIVE_DB_PATH = "/data/shared-SeD/hb/persona_test/labor_law_db"

LAWS = [
    {"name": "근로기준법", "mst": "265959", "code": "kis"},
    {"name": "근로기준법 시행령", "mst": "270551", "code": "kise"},
    {"name": "최저임금법", "mst": "218303", "code": "min"},
    {"name": "임금채권보장법", "mst": "279735", "code": "wgp"},
    {"name": "근로자퇴직급여 보장법", "mst": "284455", "code": "ret"},
]

# 정의 조문을 호 단위로 쪼갤 대상(reindex_definitions.TARGETS와 같은 기준)
SPLIT_TARGETS = {("근로기준법", "제2조"), ("임금채권보장법", "제2조"),
                 ("근로자퇴직급여 보장법", "제2조")}


def article_key(article_id):
    """'제43조의2' → 'a43_2' 처럼 ID에 쓸 수 있는 형태로 바꾼다."""
    m = re.match(r"제(\d+)조(?:의(\d+))?$", article_id)
    if not m:
        return "a" + re.sub(r"[^0-9]+", "_", article_id).strip("_")
    return f"a{m.group(1)}" + (f"_{m.group(2)}" if m.group(2) else "")


def clause_key(clause):
    """'제1항제6호' → 'h1_n6', '제2항' → 'h2', '제4호' → 'n4'."""
    hang = re.search(r"제(\d+)항", clause or "")
    ho = re.search(r"제(\d+)호", clause or "")
    parts = []
    if hang:
        parts.append(f"h{hang.group(1)}")
    if ho:
        parts.append(f"n{ho.group(1)}")
    return "_".join(parts) or "x"


def build_records():
    """5개 법령을 파싱해 (id, doc, metadata) 목록을 만든다."""
    records = []
    for law in LAWS:
        articles = add_laws.parse_law(add_laws.fetch_law_xml(law["mst"]), law["name"])
        print(f"  {law['name']:<16} {len(articles):>3}개 조문 파싱")
        for a in articles:
            meta = {
                "article_id": a["article_id"],
                "title": a["title"],
                "chapter": a["chapter"],
                "law": a["law"],
                "law_no": a["law_no"],
                "enforcement_date": a["enforcement_date"],
            }
            records.append((f"{law['code']}_{article_key(a['article_id'])}", a["doc"], meta))
    return records


def apply_definition_split(records):
    """정의 조문을 호 단위 chunk로 교체한다."""
    out, split_count = [], 0
    for cid, doc, meta in records:
        if (meta["law"], meta["article_id"]) not in SPLIT_TARGETS or meta["title"] != "정의":
            out.append((cid, doc, meta))
            continue

        chunks = reindex_definitions.split_definition_article(doc, meta)
        if not chunks:
            print(f"  [건너뜀] {meta['law']} {meta['article_id']} - 호 패턴을 찾지 못함")
            out.append((cid, doc, meta))
            continue

        # 원문의 호 번호가 빠짐없이 분리됐는지 확인(파싱 사고 방지)
        src_hos = {int(n) for n in re.findall(r'(\d+)\.\s*[“"”][^”"]+[”"]\s*(?:이)?란', doc)}
        got_hos = {int(re.search(r"제(\d+)호", c["meta"]["clause"]).group(1))
                   for c in chunks if "호" in c["meta"]["clause"]}
        missing = src_hos - got_hos
        if missing:
            raise SystemExit(f"[중단] {meta['law']} {meta['article_id']}: 호 누락 {sorted(missing)}")

        print(f"  {meta['law']} {meta['article_id']}(정의) → {len(chunks)}개로 분리 "
              f"(원문 호 {len(src_hos)}개 전부 확인)")
        for c in chunks:
            out.append((f"{cid}_{clause_key(c['meta']['clause'])}", c["doc"], c["meta"]))
        split_count += 1
    print(f"  정의 조문 {split_count}개 분리 완료")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--allow-live", action="store_true",
                    help="운영 DB에 직접 쓰기(서버를 내린 뒤에만 사용)")
    args = ap.parse_args()

    db_path = bot.DB_PATH
    if db_path.rstrip("/") == LIVE_DB_PATH.rstrip("/") and not args.allow_live:
        print(f"[중단] 운영 DB 경로입니다: {db_path}")
        print("  서버(app.py)가 이 DB를 열어둔 상태라 여기에 쓰면 인덱스가 깨질 수 있습니다.")
        print("  사본 경로를 지정하세요:")
        print("    export DONWORRY_DB_PATH=/data/shared-SeD/hb/persona_test/labor_law_db_fix")
        return 1

    print(f"대상 DB: {db_path} / collection={bot.COLLECTION_NAME}\n")

    print("■ 원문 파싱")
    records = build_records()
    print(f"  소계 {len(records)}개 조문\n")

    print("■ 정의 조문 분리")
    records = apply_definition_split(records)
    print(f"\n■ 최종 chunk {len(records)}개")

    dup = {cid for cid, _, _ in records
           if [c for c, _, _ in records].count(cid) > 1}
    if dup:
        raise SystemExit(f"[중단] ID가 중복됐습니다: {sorted(dup)[:10]}")

    ids = [r[0] for r in records]
    docs = [r[1] for r in records]
    metas = [r[2] for r in records]

    print("\n■ 임베딩 계산 중…")
    embeddings = bot.embed_model.encode(docs, normalize_embeddings=True, show_progress_bar=False)

    print("■ 컬렉션 재생성")
    # bot이 이미 같은 경로로 PersistentClient를 열어뒀으므로 그 핸들을 재사용한다.
    # 같은 프로세스에서 같은 경로로 클라이언트를 또 만들면 설정 충돌이 날 수 있다.
    client = bot.client_db
    try:
        client.delete_collection(bot.COLLECTION_NAME)
        print("  기존 컬렉션 삭제")
    except Exception:
        print("  기존 컬렉션 없음(신규 생성)")
    col = client.create_collection(bot.COLLECTION_NAME, metadata={"hnsw:space": "cosine"})
    col.add(ids=ids, embeddings=embeddings.tolist(), documents=docs, metadatas=metas)

    print(f"\n완료. chunk 수: {col.count()}")
    by_law = {}
    for m in metas:
        by_law[m["law"]] = by_law.get(m["law"], 0) + 1
    for law, n in sorted(by_law.items(), key=lambda kv: -kv[1]):
        print(f"  {law:<16} {n:>3}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
