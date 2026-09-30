#!/usr/bin/env python3
"""국가법령정보센터 공식 XML로 노동법 Chroma 번들에 법령을 추가하는 재현 가능한 빌더.

이 스크립트는 운영 서버에서 실행하지 않는다. 자산 교체 release를 만드는 개발자가
다음 순서로 사용한다.

1. ``fetch``: law.go.kr DRF API에서 현행 법령 XML을 내려받아 ``data/law_xml``에 저장하고
   ``data/law_xml/lock.json``에 법령일련번호·공포번호·시행일자·SHA-256을 고정한다.
   (네트워크가 필요한 유일한 단계이며, 저장된 XML은 저장소에 커밋한다.)
2. ``chunks``: 커밋된 XML만 읽어 기존 청크와 같은 형식의 문서/메타데이터를 만든다.
   (lock.json의 SHA-256이 다르면 중단한다. 모델·네트워크 불필요.)
3. ``build``: 기존 sealed DB를 복사한 사본에 새 청크만 추가한다. 임베딩은 runtime
   ``retriever._create_model()``과 같은 BGE-M3 고정 revision, 같은
   ``encode(..., normalize_embeddings=True)`` 경로를 쓴다. 기존 문서의 id·본문·메타데이터·
   임베딩이 한 비트라도 달라지면 실패한다.

추가 대상과 시행령 조문 선택 근거는 README의 "법령 코퍼스 재구성" 절에 둔다.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent
XML_DIR = ROOT / "data" / "law_xml"
LOCK_PATH = XML_DIR / "lock.json"
BASE_DB = ROOT / "data" / "labor_law_db"
COLLECTION_NAME = "labor_law"
BASE_DOCUMENT_COUNT = 583
# 새 법령을 얹는 기준 번들: 583건 sealed DB(origin/main 3f7e499, manifest f67ceeb8…)의
# chroma.sqlite3. 현재 data/labor_law_db는 이 스크립트의 결과물이므로 build의 기준이 될 수 없다.
#   git archive 3f7e499 product/integrations/rag-api/data/labor_law_db | tar -x -C <dir>
BASE_SQLITE_SHA256 = "4e2f39e7be02ca55f79ddaf6b790cb9a2210f3bcf282daf7705dc86e54b33741"
DRF_SERVICE = "https://www.law.go.kr/DRF/lawService.do"
EMBED_BATCH_SIZE = 16


@dataclass(frozen=True)
class LawSource:
    key: str
    prefix: str
    law: str
    mst: str
    # None이면 삭제되지 않은 모든 조문을 수록한다. 시행령은 상담에 필요한 위임 조문만 둔다.
    articles: tuple[str, ...] | None = None


LAW_SOURCES = (
    LawSource(key="iaci", prefix="iaci", law="산업재해보상보험법", mst="283459"),
    LawSource(
        key="iaci_enf",
        prefix="iacie",
        law="산업재해보상보험법 시행령",
        mst="287491",
        articles=(
            # 법 제6조 단서: 적용 제외 사업(법인 아닌 농업·임업·어업 5명 미만 등)과 그 인원 산정
            "제2조", "제2조의2",
            # 법 제36조제2항: 보험급여 청구·결정 통지 절차
            "제21조",
            # 법 제37조제5항: 업무상의 재해의 구체적인 인정 기준(제3장 제2절)
            "제27조", "제28조", "제30조", "제31조", "제32조", "제33조", "제34조",
            "제35조", "제35조의2", "제36조",
        ),
    ),
    LawSource(key="fem", prefix="fem", law="외국인근로자의 고용 등에 관한 법률", mst="276857"),
    LawSource(
        key="fem_enf",
        prefix="feme",
        law="외국인근로자의 고용 등에 관한 법률 시행령",
        mst="244037",
        articles=(
            # 법 제3조제2항: 법이 적용되지 않는 외국인근로자
            "제2조",
            # 법 제13조·제15조: 출국만기보험·귀국비용보험의 가입 기한·금액·지급
            "제21조", "제22조",
            # 법 제20조제1항제4호: 추가 고용 제한 사유
            "제25조",
            # 법 제23조: 보증보험·상해보험 가입 대상과 방법
            "제27조", "제28조",
            # 법 제25조: 사업장 변경 신청 기간·횟수 산입 제외
            "제30조",
        ),
    ),
)

# 조문이 "별표 N에 따른 …"이라고만 하고 실제 수치가 별표에 있는 경우 그 표를 조문 뒤에 붙인다
# (기존 고용보험법 제50조·제69조의6 청크와 같은 방식). 별표는 XML에 괘선 표로만 들어 있어
# 한 줄 요약으로 옮기되, 옮긴 모든 수치가 같은 XML의 별표내용에 실제로 있는지 build 전에 확인한다.
APPENDIX_TABLES = {
    ("iaci", "제57조"): (
        "0002",
        "[별표 2] 장해급여표 (제57조제2항 관련, 평균임금 기준)\n"
        "장해보상연금: 제1급 329일분, 제2급 291일분, 제3급 257일분, 제4급 224일분, "
        "제5급 193일분, 제6급 164일분, 제7급 138일분\n"
        "장해보상일시금: 제1급 1,474일분, 제2급 1,309일분, 제3급 1,155일분, 제4급 1,012일분, "
        "제5급 869일분, 제6급 737일분, 제7급 616일분, 제8급 495일분, 제9급 385일분, "
        "제10급 297일분, 제11급 220일분, 제12급 154일분, 제13급 99일분, 제14급 55일분",
    ),
    ("iaci", "제62조"): (
        "0003",
        "[별표 3] 유족급여 (제62조제2항 관련)\n"
        "유족보상연금: 기본금액(급여기초연액, 즉 평균임금에 365를 곱한 금액의 100분의 47)과 "
        "가산금액(유족보상연금수급권자 및 생계를 같이 하던 수급자격자 1인당 급여기초연액의 100분의 5, "
        "합산액은 급여기초연액의 100분의 20 한도)을 합한 금액\n"
        "유족보상일시금: 평균임금의 1,300일분",
    ),
}
_APPENDIX_FIGURE = re.compile(r"\d[\d,]*일분|100분의 \d+")

_REVISION_TAG = re.compile(r"\s*<(?:개정|신설|전문개정|제목개정|본조신설|종전)[^<>]*>\s*$")
_DELETED_ARTICLE = re.compile(r"^제\d+조(?:의\d+)?\s*삭제")
_ARTICLE_HEAD = re.compile(r"^제(\d+)조(?:의(\d+))?")


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _xml_path(source: LawSource) -> Path:
    return XML_DIR / f"mst_{source.mst}.xml"


def _text(node, tag):
    value = node.findtext(tag)
    return value.strip() if value else ""


def _heading(raw: str) -> str:
    """'제3장 보험급여 <개정 2010.1.27>' 같은 편장절 제목에서 개정 표기를 뗀다."""
    return _REVISION_TAG.sub("", " ".join(raw.split()))


def _article_id(unit) -> str:
    number = _text(unit, "조문번호")
    branch = _text(unit, "조문가지번호")
    return f"제{number}조" + (f"의{branch}" if branch else "")


def _chunk_id(prefix: str, unit) -> str:
    number = _text(unit, "조문번호")
    branch = _text(unit, "조문가지번호")
    return f"{prefix}_a{number}" + (f"_{branch}" if branch else "")


def _body_lines(unit) -> list[str]:
    """조문내용 → 항 → 호 → 목 순서로 공식 원문 줄을 그대로 이어 붙인다."""
    lines = [_text(unit, "조문내용")]
    for paragraph in unit.findall("항"):
        paragraph_text = _text(paragraph, "항내용")
        if paragraph_text:
            lines.append(paragraph_text)
        for item in paragraph.findall("호"):
            item_text = _text(item, "호내용")
            if item_text:
                lines.append(item_text)
            for sub in item.findall("목"):
                sub_text = _text(sub, "목내용")
                if sub_text:
                    # 목 안의 줄바꿈(세목)은 원문 그대로 둔다.
                    lines.extend(line.strip() for line in sub_text.splitlines() if line.strip())
    return [line for line in lines if line]


def _appendix_text(root, number: str) -> str:
    for unit in root.iter("별표단위"):
        if _text(unit, "별표번호") == number and _text(unit, "별표구분") == "별표":
            return re.sub(r"\s+", " ", _text(unit, "별표내용"))
    raise SystemExit(f"별표 {number}를 XML에서 찾을 수 없습니다")


def _checked_appendix(root, source: LawSource, article_id: str) -> str | None:
    entry = APPENDIX_TABLES.get((source.key, article_id))
    if entry is None:
        return None
    number, summary = entry
    original = _appendix_text(root, number)
    for figure in _APPENDIX_FIGURE.findall(summary):
        if figure not in original:
            raise SystemExit(f"{source.law} {article_id} 별표 {number}: {figure!r}가 원문에 없습니다")
    return summary


def parse_law_xml(path: Path, source: LawSource) -> tuple[dict, list[dict]]:
    root = ET.parse(path).getroot()
    info = root.find("기본정보")
    law_name = _text(info, "법령명_한글")
    if law_name != source.law:
        raise SystemExit(f"{path.name}: 법령명 불일치 {law_name!r} != {source.law!r}")
    promulgation_no = str(int(_text(info, "공포번호")))
    enforcement = _text(info, "시행일자")
    enforcement_date = f"{enforcement[:4]}-{enforcement[4:6]}-{enforcement[6:]}"
    header = {
        "law": law_name,
        "mst": source.mst,
        "law_no": promulgation_no,
        "enforcement_date": enforcement_date,
    }

    chapter = ""
    section = ""
    chunks = []
    wanted = set(source.articles) if source.articles is not None else None
    for unit in root.find("조문").findall("조문단위"):
        kind = _text(unit, "조문여부")
        if kind == "전문":
            heading = _heading(_text(unit, "조문내용"))
            if re.match(r"^제\d+(?:장|편)", heading):
                chapter, section = heading, ""
            elif re.match(r"^제\d+절", heading):
                section = heading
            continue
        if kind != "조문":
            continue
        article_id = _article_id(unit)
        head = _text(unit, "조문내용")
        if _DELETED_ARTICLE.match(head):
            continue
        if wanted is not None and article_id not in wanted:
            continue
        title = _text(unit, "조문제목")
        lines = _body_lines(unit)
        # 조문내용이 머리('제N조(제목)')뿐이면 기존 청크처럼 첫 항을 같은 줄에 붙인다.
        if len(lines) > 1 and lines[0] == f"{article_id}({title})":
            lines = [f"{lines[0]} {lines[1]}", *lines[2:]]
        appendix = _checked_appendix(root, source, article_id)
        if appendix:
            lines.append(appendix)
        document = "\n".join(lines)
        if not document.startswith(f"{article_id}({title})"):
            raise SystemExit(f"{source.law} {article_id}: 본문 머리가 예상과 다릅니다: {document[:40]!r}")
        chunks.append({
            "id": _chunk_id(source.prefix, unit),
            "document": document,
            "metadata": {
                "law": law_name,
                "law_no": promulgation_no,
                "enforcement_date": enforcement_date,
                # 기존 시행령 청크(kise_*)는 편장절 없이 수록되어 있어 같은 형식을 따른다.
                "chapter": "" if source.articles is not None else " ".join(filter(None, (chapter, section))),
                "article_id": article_id,
                "title": title,
            },
        })
    attached = {chunk["metadata"]["article_id"] for chunk in chunks if "\n[별표 " in chunk["document"]}
    expected_attached = {article for key, article in APPENDIX_TABLES if key == source.key}
    if attached != expected_attached:
        raise SystemExit(f"{source.law}: 별표 부착 대상 불일치 {sorted(attached)} != {sorted(expected_attached)}")
    if wanted is not None:
        found = {chunk["metadata"]["article_id"] for chunk in chunks}
        missing = sorted(wanted - found)
        if missing:
            raise SystemExit(f"{source.law}: 선택 조문이 없거나 삭제됨: {', '.join(missing)}")
    ids = [chunk["id"] for chunk in chunks]
    if len(ids) != len(set(ids)):
        raise SystemExit(f"{source.law}: 청크 id 중복")
    return header, chunks


def load_lock() -> dict:
    try:
        return json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"{LOCK_PATH} 를 읽을 수 없습니다. 먼저 fetch를 실행하세요.") from error


def all_chunks() -> list[dict]:
    lock = load_lock()
    chunks = []
    for source in LAW_SOURCES:
        path = _xml_path(source)
        entry = lock.get(source.key)
        if not entry or entry.get("mst") != source.mst:
            raise SystemExit(f"lock.json에 {source.key}(MST {source.mst}) 항목이 없습니다.")
        if _sha256(path) != entry["sha256"]:
            raise SystemExit(f"{path.name} SHA-256이 lock.json과 다릅니다.")
        header, law_chunks = parse_law_xml(path, source)
        for key in ("law", "law_no", "enforcement_date"):
            if header[key] != entry[key]:
                raise SystemExit(f"{source.key}: {key}가 lock.json과 다릅니다.")
        chunks.extend(law_chunks)
    return chunks


def command_fetch(_args) -> int:
    XML_DIR.mkdir(parents=True, exist_ok=True)
    lock = {}
    for source in LAW_SOURCES:
        query = urllib.parse.urlencode({"OC": "test", "target": "law", "MST": source.mst, "type": "XML"})
        with urllib.request.urlopen(f"{DRF_SERVICE}?{query}", timeout=60) as response:
            payload = response.read()
        path = _xml_path(source)
        path.write_bytes(payload)
        header, chunks = parse_law_xml(path, source)
        lock[source.key] = {**header, "file": path.name, "sha256": _sha256(path), "chunks": len(chunks)}
        print(f"{source.law}: MST {source.mst} 공포 {header['law_no']} 시행 {header['enforcement_date']} · {len(chunks)} chunks")
    LOCK_PATH.write_text(json.dumps(lock, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0


def command_chunks(args) -> int:
    chunks = all_chunks()
    if args.output:
        with open(args.output, "w", encoding="utf-8") as stream:
            for chunk in chunks:
                stream.write(json.dumps(chunk, ensure_ascii=False) + "\n")
    counts: dict[str, int] = {}
    for chunk in chunks:
        counts[chunk["metadata"]["law"]] = counts.get(chunk["metadata"]["law"], 0) + 1
    print(json.dumps({"total": len(chunks), "per_law": counts}, ensure_ascii=False, indent=2))
    return 0


def _snapshot(collection) -> dict:
    result = collection.get(include=["documents", "metadatas", "embeddings"])
    return {
        identifier: (document, metadata, [float(value) for value in embedding])
        for identifier, document, metadata, embedding in zip(
            result["ids"], result["documents"], result["metadatas"], result["embeddings"]
        )
    }


def _file_contracts(db: Path) -> list[dict]:
    files = []
    for path in sorted(db.rglob("*")):
        if path.is_file():
            relative = path.relative_to(db).as_posix()
            files.append({"path": relative, "size": path.stat().st_size, "sha256": _sha256(path)})
    # manifest 관례: chroma.sqlite3를 먼저 둔다.
    files.sort(key=lambda item: (item["path"] != "chroma.sqlite3", item["path"]))
    return files


def command_build(args) -> int:
    import chromadb
    import retriever  # runtime과 같은 모델 생성·오프라인 계약을 재사용한다.

    base = Path(args.base_db).resolve()
    output = Path(args.output).resolve()
    if output.exists():
        raise SystemExit(f"출력 경로가 이미 있습니다: {output}")
    chunks = all_chunks()
    if _sha256(base / "chroma.sqlite3") != BASE_SQLITE_SHA256:
        raise SystemExit("기준 DB가 583건 sealed 번들(3f7e499)이 아닙니다. 모듈 설명의 git archive 명령으로 꺼내세요.")

    # Chroma는 읽기만 해도 파일을 갱신할 수 있으므로 기준 스냅샷도 복제본에서 읽는다.
    base_copy = Path(args.work_dir) / "base-readonly-copy"
    shutil.copytree(base, base_copy)
    reader = chromadb.PersistentClient(path=str(base_copy))
    before = _snapshot(reader.get_collection(COLLECTION_NAME))
    reader.close()
    if len(before) != args.expected_base_count:
        raise SystemExit(f"기준 DB 문서 수 {len(before)} != {args.expected_base_count}")
    new_ids = [chunk["id"] for chunk in chunks]
    collisions = sorted(set(new_ids) & set(before))
    if collisions:
        raise SystemExit(f"기존 id와 충돌: {collisions[:5]}")

    model = retriever._create_model()
    if model.get_sentence_embedding_dimension() != retriever.PINNED_EMBEDDING_DIMENSION:
        raise SystemExit("임베딩 차원이 고정값과 다릅니다")
    # 모델 경로 확인: 기존 문서를 다시 임베딩하면 저장된 벡터와 사실상 같아야 한다.
    probe_id = retriever.ASSET_MANIFEST.collection.probe.expected_id
    probe_vector = model.encode([before[probe_id][0]], normalize_embeddings=True)[0].tolist()
    stored = before[probe_id][2]
    cosine = sum(a * b for a, b in zip(probe_vector, stored))
    print(f"기존 {probe_id} 재임베딩 cosine={cosine:.8f}")
    if cosine < 0.9999:
        raise SystemExit("모델/정규화 경로가 기존 임베딩과 다릅니다")

    shutil.copytree(base, output)
    writer = chromadb.PersistentClient(path=str(output))
    collection = writer.get_collection(COLLECTION_NAME)
    for start in range(0, len(chunks), EMBED_BATCH_SIZE):
        batch = chunks[start:start + EMBED_BATCH_SIZE]
        embeddings = model.encode(
            [chunk["document"] for chunk in batch], normalize_embeddings=True
        ).tolist()
        collection.add(
            ids=[chunk["id"] for chunk in batch],
            documents=[chunk["document"] for chunk in batch],
            metadatas=[chunk["metadata"] for chunk in batch],
            embeddings=embeddings,
        )
        print(f"embedded {min(start + EMBED_BATCH_SIZE, len(chunks))}/{len(chunks)}", flush=True)
    writer.close()

    for leftover in ("chroma.sqlite3-wal", "chroma.sqlite3-shm"):
        if (output / leftover).exists():
            raise SystemExit(f"닫힌 DB에 {leftover}가 남았습니다")

    verify_copy = Path(args.work_dir) / "verify-copy"
    shutil.copytree(output, verify_copy)
    verifier = chromadb.PersistentClient(path=str(verify_copy))
    after = _snapshot(verifier.get_collection(COLLECTION_NAME))
    verifier.close()
    expected_total = len(before) + len(chunks)
    if len(after) != expected_total:
        raise SystemExit(f"결과 문서 수 {len(after)} != {expected_total}")
    changed = [identifier for identifier, value in before.items() if after.get(identifier) != value]
    if changed:
        raise SystemExit(f"기존 문서가 변경됨: {changed[:5]}")
    for chunk in chunks:
        document, metadata, _ = after[chunk["id"]]
        if document != chunk["document"] or metadata != chunk["metadata"]:
            raise SystemExit(f"새 문서가 기대와 다름: {chunk['id']}")
    report = {
        "document_count": len(after),
        "base_documents_unchanged": len(before),
        "added": len(chunks),
        "files": _file_contracts(output),
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("fetch", help="law.go.kr에서 XML을 받아 lock.json 갱신(네트워크 필요)")
    chunks_parser = sub.add_parser("chunks", help="커밋된 XML로 청크 생성·집계")
    chunks_parser.add_argument("--output", help="JSONL 출력 경로")
    build_parser = sub.add_parser("build", help="기존 DB 사본에 새 청크를 임베딩해 추가")
    build_parser.add_argument("--base-db", default=str(BASE_DB))
    build_parser.add_argument("--expected-base-count", type=int, default=BASE_DOCUMENT_COUNT)
    build_parser.add_argument("--output", required=True, help="새 DB 디렉터리(존재하면 안 됨)")
    build_parser.add_argument("--work-dir", required=True, help="검증용 임시 복제본 위치")
    args = parser.parse_args(argv)
    handlers = {"fetch": command_fetch, "chunks": command_chunks, "build": command_build}
    return handlers[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
