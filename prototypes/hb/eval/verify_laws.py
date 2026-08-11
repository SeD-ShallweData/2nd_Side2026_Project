"""
1-1. 법령 원문 대조 - law.go.kr 원문 XML과 벡터DB에 적재된 chunk를 1:1로 비교한다.

중요: 비교 기준을 add_laws.parse_law 로 잡으면 파서 버그가 그대로 통과하므로,
이 스크립트는 parse_law 를 쓰지 않고 원문 XML의 텍스트 노드에서 직접 기준값을 만든다.

검사 항목
  A. 최신 버전 여부  - lawSearch로 현행 MST/공포번호를 받아 DB의 law_no와 비교
  B. 조문번호 집합   - 원문에 있는데 DB에 없는 조문 / DB에만 있는 조문
  C. 본문 내용       - 공백·따옴표를 정규화한 뒤 문자 단위로 완전 일치 비교
  D. 시행일          - 원문 조문시행일자와 DB enforcement_date 비교

실행:
    cd webapp && PYTHONPATH="$PWD/pylibs:$PYTHONPATH" python3 eval/verify_laws.py
    (DONWORRY_DB_PATH 환경변수로 DB 경로 지정 가능)
"""
import os
import re
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

import chromadb

SEARCH_URL = "https://www.law.go.kr/DRF/lawSearch.do"
SERVICE_URL = "https://www.law.go.kr/DRF/lawService.do"
OC = "test"

# add_laws.py의 LAWS + 근로기준법(초기 적재분, 스크립트가 리포에 없어 MST를 여기 기록).
# MST는 lawSearch로 조회한 현행 법령 일련번호와 대조된다(검사 A).
LAW_MST = {
    "근로기준법": "265959",
    "근로기준법 시행령": "270551",
    "최저임금법": "218303",
    "임금채권보장법": "279735",
    "근로자퇴직급여 보장법": "284455",
    "고용보험법": "279807",
    "남녀고용평등과 일ㆍ가정 양립 지원에 관한 법률": "276851",
}

DB_PATH = (os.environ.get("DONWORRY_DB_PATH") or "").strip() \
    or "/data/shared-SeD/hb/persona_test/labor_law_db"
COLLECTION = (os.environ.get("DONWORRY_COLLECTION") or "").strip() or "labor_law"


# ---------------------------------------------------------------- 정규화
QUOTES = str.maketrans({"“": '"', "”": '"', "‘": "'", "’": "'"})


def norm(text):
    """공백을 전부 제거하고 따옴표를 통일한다. 줄바꿈 방식 차이를 무시하기 위함."""
    return re.sub(r"\s+", "", (text or "").translate(QUOTES))


def loose(text):
    """표기 차이를 더 걷어낸다 - 개정이력 <…>, 편집주석 […], 마침표.

    같은 조문이라도 적재 소스(Open API / 법제처 웹·PDF)에 따라
    '<개정 2010.6.4>' vs '<개정 2010.6.4.>' 처럼 마침표만 다르거나,
    본문에 편집주석이 더 붙는 경우가 있다. 이런 것만 다르면 '표기 차이'로 분류하고
    그래도 다르면 '실제 내용 차이'로 본다.
    """
    t = re.sub(r"<[^>]*>", "", norm(text))
    t = re.sub(r"\[[^\]]*\]", "", t)
    return t.replace(".", "")


# ---------------------------------------------------------------- 수집
def http_xml(url, params):
    full = url + "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(full, timeout=30) as resp:
        return ET.fromstring(resp.read())


def fetch_current_version(law_name):
    """현행 법령의 MST/공포번호/시행일을 조회한다."""
    root = http_xml(SEARCH_URL, {"OC": OC, "target": "law", "query": law_name,
                                 "type": "XML", "display": "20"})
    for law in root.findall("law"):
        if (law.findtext("법령명한글") or "").strip() == law_name:
            return {
                "mst": law.findtext("법령일련번호"),
                "law_no": law.findtext("공포번호"),
                "promulgated": law.findtext("공포일자"),
                "enforced": law.findtext("시행일자"),
                "kind": law.findtext("제개정구분명"),
            }
    return None


def fetch_law(mst):
    return http_xml(SERVICE_URL, {"OC": OC, "target": "law", "MST": mst, "type": "XML"})


def addenda_text(root):
    """부칙 전체 텍스트(정규화본). DB chunk가 부칙에서 온 것인지 판별하는 데 쓴다."""
    bu = root.find("부칙")
    return norm("".join(bu.itertext())) if bu is not None else ""


# ---------------------------------------------------------------- 원문 파싱(기준값)
TEXT_TAGS = {"조문내용", "항내용", "호내용", "목내용"}


def article_id_of(jo):
    no = (jo.findtext("조문번호") or "").strip()
    branch = (jo.findtext("조문가지번호") or "").strip()
    return f"제{no}조" + (f"의{branch}" if branch else "")


def raw_articles(root):
    """원문 XML을 조문 단위로 훑어 {article_id: {...}} 를 만든다.

    add_laws.parse_law 와 같은 '건너뛰기' 규칙(전문/제목없음)만 재현하고,
    본문 텍스트는 XML 텍스트 노드를 순서대로 이어붙여 독립적으로 만든다.
    """
    out = {}
    skipped_no_title = []
    jomun_root = root.find("조문")
    if jomun_root is None:
        return out, skipped_no_title

    for jo in jomun_root.findall("조문단위"):
        if jo.findtext("조문여부") == "전문":
            continue  # 장/절 제목 - 저장 대상 아님
        aid = article_id_of(jo)
        title = jo.findtext("조문제목")
        if not title:
            skipped_no_title.append((aid, norm(jo.findtext("조문내용"))[:40]))
            continue
        if aid in out:
            continue  # parse_law 와 동일하게 첫 번째만

        # 구조를 가정하지 않고 문서 순서대로 본문 텍스트 노드를 전부 긁는다.
        # (법령 XML은 <목>이 <호>가 아니라 <항>의 직속 자식으로 오는 경우가 있어
        #  중첩을 가정하고 순회하면 목이 통째로 누락된다.)
        parts = [el.text or "" for el in jo.iter() if el.tag in TEXT_TAGS]

        enforce = (jo.findtext("조문시행일자") or "").strip()
        out[aid] = {
            "title": title.strip(),
            "text": norm("".join(parts)),
            "jomun": norm(jo.findtext("조문내용") or ""),
            "enforcement_date": (f"{enforce[0:4]}-{enforce[4:6]}-{enforce[6:8]}"
                                 if len(enforce) == 8 else ""),
        }
    return out, skipped_no_title


# ---------------------------------------------------------------- DB 읽기
def load_db():
    client = chromadb.PersistentClient(path=DB_PATH)
    col = client.get_collection(COLLECTION)
    data = col.get(include=["documents", "metadatas"])

    by_law = defaultdict(lambda: defaultdict(list))
    for doc, meta in zip(data["documents"], data["metadatas"]):
        by_law[meta.get("law", "")][meta.get("article_id", "")].append((doc, meta))
    return by_law, len(data["ids"])


def strip_citation_prefix(doc, meta):
    """split chunk 앞에 붙인 인용 머리말을 떼어낸다.

    머리말은 '근로기준법 제2조제1항제8호 (정의 - 소정(所定)근로시간) ' 형태다.
    용어 자체에 괄호가 들어갈 수 있으므로 정규식으로 괄호를 세지 말고
    메타데이터로 머리말을 그대로 재구성해서 잘라낸다.
    """
    prefix = (f"{meta.get('law', '')} {meta.get('article_id', '')}"
              f"{meta.get('clause', '')} (정의 - {meta.get('concept', '')}) ")
    return doc[len(prefix):] if doc.startswith(prefix) else doc


def db_candidates(chunks):
    """한 조문에 매달린 DB chunk들을 '원문과 비교할 후보 문자열' 목록으로 만든다.

    같은 article_id에 chunk가 여러 개 달릴 수 있는 경우가 두 가지 있다.
      1) 정의 조문이 호 단위로 쪼개진 경우(clause 있음) → 하나로 합쳐 한 후보
      2) 같은 조문번호가 중복 적재된 경우(구버전 잔존, 부칙 혼입 등) → 각각 별도 후보
    후보 중 하나라도 원문과 일치하면 '원문은 들어있다'고 본다.
    """
    clause_chunks = [c for c in chunks if c[1].get("clause")]
    plain_chunks = [c for c in chunks if not c[1].get("clause")]

    candidates = []
    if clause_chunks:
        def sort_key(item):
            clause = item[1].get("clause", "")
            hang = re.search(r"제(\d+)항", clause)
            ho = re.search(r"제(\d+)호", clause)
            return (int(hang.group(1)) if hang else 0, int(ho.group(1)) if ho else 0)

        pieces = []
        for doc, meta in sorted(clause_chunks, key=sort_key):
            pieces.append(norm(strip_citation_prefix(doc, meta)))
        candidates.append(("정의 분리 chunk 합본", "".join(pieces)))

    for doc, meta in plain_chunks:
        candidates.append((meta.get("title", ""), norm(doc)))
    return candidates


# ---------------------------------------------------------------- 리포트
def diff_point(a, b):
    """두 문자열이 처음 갈라지는 지점을 사람이 볼 수 있게 잘라 보여준다."""
    i = 0
    while i < min(len(a), len(b)) and a[i] == b[i]:
        i += 1
    lo = max(0, i - 30)
    return f"\n        원문 …{a[lo:i + 40]}…\n        DB   …{b[lo:i + 40]}…\n        (첫 불일치 위치: {i}자)"


ACCEPTED = "정의 조문 머리말 미보존(설계상 허용)"


def classify_mismatch(aid, info, got, has_clause_chunks=False):
    """본문 불일치의 원인을 추정해 태그를 붙인다."""
    want, jomun = info["text"], info["jomun"]
    header = norm(f"{aid}({info['title']})")

    # 정의 조문은 호 단위로 쪼개면서 '이 법에서 사용하는 용어의 뜻은 다음과 같다'는
    # 머리말이 어느 호에도 속하지 않아 빠진다. 검색 품질에 영향이 없어 그대로 둔다.
    if has_clause_chunks and got and want.endswith(got):
        return ACCEPTED

    # add_laws.parse_law는 <항>이 하나라도 있으면 <조문내용>을 통째로 버리고
    # 합성 머리말 '제N조(제목)'만 붙인다 → 조문 본문 문장이 사라진다.
    if jomun and jomun != header and want.startswith(jomun):
        if got == header + want[len(jomun):]:
            return "조문내용 누락(단일 항 조문에서 본문 문장이 통째로 빠짐)"
    if got.startswith(want) and len(got) > len(want):
        return "뒤에 다른 텍스트가 붙음(인접 조문·삭제조문·편집주석 혼입)"
    if want.startswith(got) and len(want) > len(got):
        return "뒷부분 잘림"
    return "기타(내용 상이 - 구버전 의심)"


def main():
    print(f"DB: {DB_PATH} / collection={COLLECTION}\n")
    by_law, total = load_db()
    print(f"총 chunk 수: {total}\n")

    problems = 0

    for law_name in sorted(by_law):
        db_articles = by_law[law_name]
        db_chunk_count = sum(len(v) for v in db_articles.values())
        print("=" * 78)
        print(f"■ {law_name}  (DB: 조문 {len(db_articles)}개 / chunk {db_chunk_count}개)")

        mst = LAW_MST.get(law_name)
        if not mst:
            print(f"  [!] MST를 모르는 법령입니다. LAW_MST에 추가하세요.")
            problems += 1
            continue

        # --- A. 최신 버전 여부
        current = fetch_current_version(law_name)
        db_law_nos = {m.get("law_no") for v in db_articles.values() for _, m in v}
        db_law_nos.discard("")
        if current:
            tag = "최신" if current["mst"] == mst else f"※ 현행 MST={current['mst']}"
            print(f"  A. 버전  적재 MST={mst} ({tag}) / "
                  f"현행 공포번호={current['law_no']} 공포일={current['promulgated']} "
                  f"시행일={current['enforced']} ({current['kind']})")
            print(f"           DB에 기록된 공포번호: {sorted(db_law_nos)}")
            if current["mst"] != mst:
                print(f"     [!] 적재된 MST가 현행이 아닙니다 → 재적재 필요")
                problems += 1
            elif db_law_nos and current["law_no"] not in db_law_nos:
                print(f"     [!] DB 공포번호가 현행({current['law_no']})과 다릅니다")
                problems += 1
        else:
            print(f"  A. 버전  [!] lawSearch에서 '{law_name}'을 찾지 못했습니다")
            problems += 1

        # --- B/C/D. 원문 대조
        root = fetch_law(mst)
        src, skipped = raw_articles(root)

        missing = sorted(set(src) - set(db_articles), key=article_sort)
        extra = sorted(set(db_articles) - set(src), key=article_sort)
        print(f"  B. 조문   원문 {len(src)}개 / DB {len(db_articles)}개 "
              f"(제목없음으로 원문에서 제외된 조문 {len(skipped)}개)")
        if missing:
            problems += 1
            print(f"     [!] DB에 없는 조문 {len(missing)}개: {', '.join(missing[:15])}"
                  + (" …" if len(missing) > 15 else ""))
        if extra:
            problems += 1
            print(f"     [!] 원문에 없는데 DB에 있는 조문 {len(extra)}개: {', '.join(extra[:15])}"
                  + (" …" if len(extra) > 15 else ""))
        if not missing and not extra:
            print(f"     OK 조문번호 집합 완전 일치")

        # --- C. 본문 내용
        addenda = addenda_text(root)
        exact, cosmetic, content_bad = [], [], []
        stray_addenda, stray_other, title_bad, date_bad = [], [], [], []
        common = sorted(set(src) & set(db_articles), key=article_sort)

        for aid in common:
            chunks = db_articles[aid]
            cands = db_candidates(chunks)
            want, want_loose = src[aid]["text"], loose(src[aid]["text"])

            hit = None
            for i, (_label, text) in enumerate(cands):
                if text == want:
                    hit = ("exact", i)
                    break
                if hit is None and loose(text) == want_loose:
                    hit = ("cosmetic", i)
            if hit is None:
                content_bad.append(aid)
            elif hit[0] == "exact":
                exact.append(aid)
            else:
                cosmetic.append(aid)

            # 원문과 매칭되지 않은 나머지 chunk = 부칙 혼입 / 구버전 잔존 의심
            for i, (label, text) in enumerate(cands):
                if hit is not None and i == hit[1]:
                    continue
                if len(cands) == 1:
                    continue  # 위에서 content_bad로 이미 잡힘
                bucket = stray_addenda if addenda and loose(text)[:60] in loose(addenda) \
                    else stray_other
                bucket.append((aid, label))

            db_titles = {m.get("title", "") for _, m in chunks}
            if src[aid]["title"] not in db_titles:
                title_bad.append((aid, src[aid]["title"], sorted(db_titles)))
            db_dates = {m.get("enforcement_date", "") for _, m in chunks}
            if src[aid]["enforcement_date"] and db_dates != {src[aid]["enforcement_date"]}:
                date_bad.append((aid, src[aid]["enforcement_date"], sorted(db_dates)))

        print(f"  C. 본문   대조 {len(common)}개 → "
              f"완전일치 {len(exact)} / 표기차이만 {len(cosmetic)} / 실제 내용 차이 {len(content_bad)}")
        if cosmetic:
            print(f"     (표기차이 = 개정이력 마침표·편집주석 등만 다름. 내용은 동일: "
                  f"{', '.join(cosmetic[:8])}{' …' if len(cosmetic) > 8 else ''})")
        causes = defaultdict(list)
        for aid in content_bad:
            chunks = db_articles[aid]
            best = max((c[1] for c in db_candidates(chunks)),
                       key=lambda t: len(os.path.commonprefix([t, src[aid]["text"]])), default="")
            has_clause = any(m.get("clause") for _d, m in chunks)
            causes[classify_mismatch(aid, src[aid], best, has_clause)].append(aid)

        real_bad = None
        for cause, aids in sorted(causes.items(), key=lambda kv: -len(kv[1])):
            if cause == ACCEPTED:
                print(f"     (참고) {cause}: {len(aids)}개 - {', '.join(aids)}")
                continue
            problems += 1
            real_bad = real_bad or aids[0]
            print(f"     [!] {cause}: {len(aids)}개")
            print(f"         {', '.join(aids)}")
        if real_bad:
            best = max((c[1] for c in db_candidates(db_articles[real_bad])),
                       key=lambda t: len(os.path.commonprefix([t, src[real_bad]["text"]])), default="")
            print(f"     예시) {real_bad}({src[real_bad]['title']})"
                  + diff_point(src[real_bad]["text"], best))

        if stray_addenda:
            problems += 1
            print(f"  C'. 부칙 혼입  본칙 조문번호를 차지한 부칙 chunk {len(stray_addenda)}개")
            for aid, label in stray_addenda[:12]:
                print(f"     [!] {aid} ← 부칙 '{label}'")
            if len(stray_addenda) > 12:
                print(f"     … 외 {len(stray_addenda) - 12}개")
        if stray_other:
            problems += 1
            print(f"  C''. 중복    같은 조문번호에 원문과 다른 chunk {len(stray_other)}개 (구버전 잔존 의심)")
            for aid, label in stray_other[:12]:
                print(f"     [!] {aid} ← '{label}'")
            if len(stray_other) > 12:
                print(f"     … 외 {len(stray_other) - 12}개")

        if title_bad:
            problems += 1
            print(f"  C'''. 제목 불일치 {len(title_bad)}개")
            for aid, want, got in title_bad[:5]:
                print(f"     [!] {aid}: 원문 '{want}' vs DB {got}")

        print(f"  D. 시행일 불일치 {len(date_bad)}개")
        for aid, want, got in date_bad[:5]:
            print(f"     [!] {aid}: 원문 {want} vs DB {got}")
        if len(date_bad) > 5:
            print(f"     … 외 {len(date_bad) - 5}개")
        if date_bad:
            problems += 1
        print()

    print("=" * 78)
    print(f"검사 종료 - 문제 항목 {problems}건")
    return 1 if problems else 0


def article_sort(aid):
    m = re.match(r"제(\d+)조(?:의(\d+))?", aid)
    return (int(m.group(1)), int(m.group(2) or 0)) if m else (10**9, 0)


if __name__ == "__main__":
    sys.exit(main())
