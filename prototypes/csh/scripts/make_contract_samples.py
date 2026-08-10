#!/usr/bin/env python
"""더미 근로계약서 PDF 생성.

    .venv/bin/python scripts/make_contract_samples.py
    .venv/bin/python scripts/make_contract_samples.py --scan      # 스캔본까지 함께

고용노동부 표준근로계약서 서식을 본떠 **정상 / 부당 / 경계** 3종을 만듭니다.
결과는 data/contracts/samples/ (→ /data/shared-SeD/csh/data) 에 PDF와 manifest.json으로 나갑니다.

3종인 이유 — 정상·부당 둘만 두면 🟡 확인 필요 경로가 한 번도 실행되지 않습니다.
모델과 규칙 엔진이 "전부 빨강 아니면 전부 초록"으로 몰아가는 실패를 잡지 못한 채 넘어갑니다.
app/demo.py에 "판단 불가" 케이스를 반드시 넣은 것과 같은 이유입니다.

이름 규칙은 docs/50-더미데이터.md 3절을 따릅니다 — 샘플/데모/예시 접두어, 실존 기업 연상 금지.
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config  # noqa: E402

FONT_FILE = config.FONT_DIR / "NotoSansKR.ttf"
FONT_URL = "https://github.com/google/fonts/raw/main/ofl/notosanskr/NotoSansKR%5Bwght%5D.ttf"
FONT_NAME = "NotoKR"


# ── 계약서 내용 ───────────────────────────────────────────────────────
# 각 문서는 (제목, 머리말, [(조항 제목, [줄, ...]), ...], 맺음말, 서명란) 으로 씁니다.
# 줄이 ("표", [[셀, ...], ...]) 이면 표로 그립니다.

NORMAL = {
    "id": "normal",
    "file": "01-정상-샘플A건설.pdf",
    "label": "정상 근로계약서 — 샘플A건설",
    "summary": "표준근로계약서 서식대로 작성된 계약서. 법정 기준 미달 조항이 없습니다.",
    "expect": "법정 기준 미달 0건",
    "title": "표 준 근 로 계 약 서",
    "subtitle": "(기간의 정함이 없는 경우)",
    "intro": "샘플A건설 주식회사(이하 “사업주”라 함)와 홍길동(이하 “근로자”라 함)은 "
             "다음과 같이 근로계약을 체결한다.",
    "clauses": [
        ("제1조 (근로개시일)", ["2026년 3월 2일부터 근로를 개시한다. 근로계약기간은 정하지 아니한다."]),
        ("제2조 (근무장소 및 업무의 내용)", [
            "① 근무장소 : 인천광역시 서구 가정로 123 샘플A건설 본사 및 배정 현장",
            "② 업무의 내용 : 건축 시공 관리 및 공정 관리 업무",
        ]),
        ("제3조 (소정근로시간)", [
            "① 소정근로시간은 1일 8시간, 1주 40시간으로 한다.",
            "② 근무시간은 09시 00분부터 18시 00분까지로 하며, 휴게시간은 "
            "12시 00분부터 13시 00분까지 60분으로 근로시간 도중에 부여한다.",
            "③ 근무일은 월요일부터 금요일까지 주 5일로 한다.",
        ]),
        ("제4조 (임금)", [
            "① 월 통상임금은 2,400,000원으로 하며, 그 구성항목은 다음과 같다.",
            ("표", [["구성항목", "금액", "산정 기준"],
                    ["기본급", "2,400,000원", "월 소정근로시간 209시간"],
                    ["합계", "2,400,000원", ""]]),
            "② 연장·야간·휴일근로가 발생한 경우에는 근로기준법 제56조에 따라 "
            "통상임금의 100분의 50 이상을 가산하여 별도로 지급한다.",
            "③ 임금은 매월 1일부터 말일까지를 산정기간으로 하여 매월 25일에 "
            "근로자 명의의 예금계좌로 전액 지급한다. 지급일이 휴일인 경우 그 전일에 지급한다.",
            "④ 법령에 정한 것 외에는 임금에서 어떠한 금액도 공제하지 아니한다.",
        ]),
        ("제5조 (휴일)", [
            "① 주휴일은 일요일로 하며 유급으로 한다.",
            "② 관공서의 공휴일에 관한 규정에 따른 공휴일 및 대체공휴일은 유급휴일로 한다.",
        ]),
        ("제6조 (연차유급휴가)", [
            "연차유급휴가는 근로기준법 제60조가 정하는 바에 따라 부여한다. "
            "계속근로기간이 1년 미만인 근로자에게는 1개월 개근 시 1일의 유급휴가를 부여한다.",
        ]),
        ("제7조 (수습기간)", [
            "① 근로개시일부터 3개월을 수습기간으로 한다.",
            "② 수습기간 중의 임금은 제4조 임금의 100분의 90으로 한다. "
            "다만 어떠한 경우에도 최저임금법에 따른 최저임금액에 미달할 수 없다.",
        ]),
        ("제8조 (퇴직급여)", [
            "근로자퇴직급여 보장법에 따라 퇴직급여제도를 설정하며, "
            "계속근로기간 1년에 대하여 30일분 이상의 평균임금을 퇴직금으로 지급한다.",
        ]),
        ("제9조 (사회보험 적용)", [
            "고용보험, 산업재해보상보험, 국민연금, 건강보험에 모두 가입한다.",
        ]),
        ("제10조 (계약의 해지)", [
            "사업주는 근로기준법 제23조에 따라 정당한 이유 없이 근로자를 해고하지 아니하며, "
            "해고하는 경우 같은 법 제26조에 따라 30일 전에 예고하거나 30일분 이상의 "
            "통상임금을 지급한다.",
        ]),
        ("제11조 (근로계약서 교부)", [
            "사업주는 근로기준법 제17조에 따라 본 계약서를 2부 작성하여 "
            "사업주와 근로자가 각 1부씩 보관하며, 근로자에게 교부한다.",
        ]),
        ("제12조 (기타)", [
            "① 이 계약에 정함이 없는 사항은 근로기준법령 및 취업규칙에 따른다.",
            "② 본 사업장의 상시 근로자 수는 42명이다.",
        ]),
    ],
    "closing": "2026년 2월 25일",
}

UNFAIR = {
    "id": "unfair",
    "file": "02-부당-예시C물류.pdf",
    "label": "부당 근로계약서 — 예시C물류",
    "summary": "최저임금 미달·위약금 예정·퇴직금 분할 등 법정 기준 미달 조항이 다수인 계약서.",
    "expect": "법정 기준 미달 다수 (최저임금·수습·근로시간·휴게·연차·주휴·퇴직금·위약금·공제·해고·교부)",
    "title": "근 로 계 약 서",
    "subtitle": "",
    "intro": "예시C물류(이하 “회사”)와 김근로(이하 “사원”)는 아래와 같이 근로계약을 체결한다.",
    "clauses": [
        ("제1조 (계약기간)", [
            "2026년 3월 2일부터 2026년 9월 1일까지 6개월로 한다. "
            "회사가 필요하다고 판단하는 경우 계약을 갱신할 수 있다.",
        ]),
        ("제2조 (근무장소 및 업무)", [
            "① 근무장소 : 회사가 지정하는 물류센터",
            "② 업무 : 상하차 및 분류 등 회사가 지시하는 일체의 업무",
        ]),
        ("제3조 (근무시간)", [
            "① 근무시간은 08시 00분부터 19시 00분까지로 하고, 휴게시간은 30분으로 한다.",
            "② 1일 소정근로시간은 10시간, 1주 소정근로시간은 40시간으로 한다.",
            "③ 사원은 회사의 업무 사정에 따라 1주 20시간의 연장근로에 동의한다.",
        ]),
        ("제4조 (임금)", [
            "① 임금은 월 2,000,000원으로 하며, 위 금액에는 연장·야간·휴일근로수당 "
            "300,000원이 포함된 것으로 본다(포괄임금).",
            "② 위 금액 외에 어떠한 명목의 수당도 별도로 지급하지 아니한다.",
            "③ 주휴수당은 위 임금에 포함된 것으로 보아 별도로 지급하지 아니한다.",
            "④ 임금은 익월 10일에 지급하며, 회사 사정에 따라 지급일을 변경할 수 있다.",
        ]),
        ("제5조 (수습기간)", [
            "① 입사일부터 6개월간을 수습기간으로 한다.",
            "② 수습기간 중의 임금은 제4조 임금의 70%로 한다.",
            "③ 회사는 수습기간 중 언제든지 평가에 따라 근로계약을 해지할 수 있다.",
        ]),
        ("제6조 (휴일 및 휴가)", [
            "① 연차유급휴가는 부여하지 아니한다.",
            "② 공휴일은 무급으로 하며, 근무가 필요한 경우 통상임금으로 지급한다.",
        ]),
        ("제7조 (퇴직금)", [
            "퇴직금은 매월 지급하는 임금에 포함하여 지급하는 것으로 하며, "
            "퇴직 시 별도로 청구할 수 없다.",
        ]),
        ("제8조 (손해배상)", [
            "① 사원이 계약기간을 채우지 못하고 중도 퇴사하는 경우 "
            "교육비 및 채용 비용 명목으로 금 3,000,000원을 회사에 배상한다.",
            "② 사원의 과실로 회사에 손해가 발생한 경우 그 손해액을 "
            "매월 급여에서 공제할 수 있다.",
        ]),
        ("제9조 (계약의 해지)", [
            "회사는 경영상 필요하다고 인정하는 경우 사전 예고 없이 "
            "언제든지 본 계약을 해지할 수 있다.",
        ]),
        ("제10조 (사회보험)", [
            "4대보험은 사원의 요청이 있는 경우에 한하여 가입한다.",
        ]),
        ("제11조 (계약서의 보관)", [
            "본 계약서는 1부를 작성하여 회사가 보관한다.",
        ]),
        ("제12조 (기타)", [
            "본 계약에 정하지 아니한 사항은 회사의 방침에 따른다. "
            "본 사업장의 상시 근로자 수는 28명이다.",
        ]),
    ],
    "closing": "2026년 2월 27일",
}

BORDERLINE = {
    "id": "borderline",
    "file": "03-경계-데모B제조.pdf",
    "label": "경계 근로계약서 — 데모B제조 (상시 4명)",
    "summary": "그 자체로는 위법이 아니지만 실태 확인이 필요한 조항이 모인 계약서. "
               "상시 근로자 4명이라 일부 조문은 적용 제외입니다.",
    "expect": "법정 기준 미달 0건 · 확인 필요 다수 · 적용 제외 1건 이상",
    "title": "근 로 계 약 서",
    "subtitle": "(기간의 정함이 없는 경우)",
    "intro": "데모B제조(이하 “사업주”)와 이성실(이하 “근로자”)은 다음과 같이 근로계약을 체결한다.",
    "clauses": [
        ("제1조 (근로개시일)", ["2026년 4월 1일부터 근로를 개시하며 계약기간은 정하지 아니한다."]),
        ("제2조 (근무장소 및 업무)", [
            "① 근무장소 : 경기도 화성시 향남읍 소재 데모B제조 공장",
            "② 업무의 내용 : 사출 성형기 조작 및 품질 검사",
            "③ 사업주는 업무상 필요가 있는 경우 근로자의 업무 내용과 근무 장소를 변경할 수 있다.",
        ]),
        ("제3조 (소정근로시간 및 교대)", [
            "① 소정근로시간은 1일 8시간, 1주 40시간으로 한다.",
            "② 근무는 2교대로 운영하며 주간조는 08시~17시, 야간조는 20시~익일 05시로 한다.",
            "③ 휴게시간은 1일 60분으로 하며 근로시간 도중에 부여한다.",
            "④ 교대 인수인계를 위한 조회 시간(15분)은 근로시간에 포함하지 아니한다.",
        ]),
        ("제4조 (임금)", [
            "① 월 임금은 2,500,000원으로 하며 구성은 다음과 같다.",
            ("표", [["구성항목", "금액", "비고"],
                    ["기본급", "2,200,000원", ""],
                    ["고정연장근로수당", "300,000원", "연장근로수당을 포함하여 지급"],
                    ["합계", "2,500,000원", ""]]),
            "② 고정연장근로수당은 매월 정액으로 지급하며, 이를 초과하는 연장근로가 "
            "발생한 경우에는 그 초과분을 별도로 정산한다.",
            "③ 임금은 매월 25일에 근로자 명의 계좌로 전액 지급한다.",
        ]),
        ("제5조 (휴일)", [
            "① 주휴일은 일요일로 하고 유급으로 한다.",
            "② 관공서의 공휴일은 무급휴일로 한다.",
        ]),
        ("제6조 (수습기간)", [
            "근로개시일부터 3개월을 수습기간으로 하며, 수습기간 중 임금은 "
            "제4조 임금의 90%로 한다.",
        ]),
        ("제7조 (퇴직급여)", [
            "근로자퇴직급여 보장법에 따라 퇴직급여제도를 설정한다.",
        ]),
        ("제8조 (사회보험)", ["고용보험, 산업재해보상보험, 국민연금, 건강보험에 가입한다."]),
        ("제9조 (비밀유지 및 경업금지)", [
            "① 근로자는 재직 중 및 퇴직 후 회사의 영업비밀을 누설하지 아니한다.",
            "② 근로자는 퇴직일로부터 1년간 동종 업계에 취업하거나 "
            "동종 영업을 하지 아니한다.",
            "③ 근로자가 고의 또는 중대한 과실로 회사에 손해를 입힌 경우 "
            "실제 발생한 손해를 배상한다.",
        ]),
        ("제10조 (계약서 교부)", [
            "본 계약서는 2부를 작성하여 사업주와 근로자가 각 1부씩 보관한다.",
        ]),
        ("제11조 (기타)", [
            "① 이 계약에 정함이 없는 사항은 근로기준법령에 따른다.",
            "② 본 사업장의 상시 근로자 수는 4명이다.",
        ]),
    ],
    "closing": "2026년 3월 20일",
}

SAMPLES = (NORMAL, UNFAIR, BORDERLINE)

SIGNATURE = [
    ["(사업주)", "사업체명 :", "전화 :"],
    ["", "주   소 :", ""],
    ["", "대표자 :", "(서명)"],
    ["(근로자)", "주   소 :", ""],
    ["", "연락처 :", ""],
    ["", "성   명 :", "(서명)"],
]


# ── 렌더링 ────────────────────────────────────────────────────────────
def ensure_font(download: bool) -> None:
    if FONT_FILE.exists():
        return
    if not download:
        print(f"한글 폰트가 없습니다: {FONT_FILE}\n"
              f"  --download-font 를 붙이거나 직접 내려받으세요:\n"
              f"  curl -sSL -o {FONT_FILE} '{FONT_URL}'")
        sys.exit(1)
    import urllib.request
    FONT_FILE.parent.mkdir(parents=True, exist_ok=True)
    print(f"폰트를 내려받는 중… {FONT_URL}")
    urllib.request.urlretrieve(FONT_URL, FONT_FILE)
    print(f"저장 {FONT_FILE} ({FONT_FILE.stat().st_size / 1024 / 1024:.1f}MB)")


def build(sample: dict, out_dir: Path) -> Path:
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import (KeepTogether, Paragraph, SimpleDocTemplate,
                                    Spacer, Table, TableStyle)

    if FONT_NAME not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont(FONT_NAME, str(FONT_FILE)))
        # 가변 폰트라 굵기 축을 따로 뽑을 수 없습니다. 굵게 대신 크기·선으로 구분합니다.
        pdfmetrics.registerFontFamily(FONT_NAME, normal=FONT_NAME, bold=FONT_NAME,
                                      italic=FONT_NAME, boldItalic=FONT_NAME)

    body = ParagraphStyle("body", fontName=FONT_NAME, fontSize=9.5, leading=15.5,
                          spaceAfter=2.5)
    title = ParagraphStyle("title", parent=body, fontSize=17, leading=24,
                           alignment=TA_CENTER, spaceAfter=2)
    subtitle = ParagraphStyle("subtitle", parent=body, fontSize=10, leading=15,
                              alignment=TA_CENTER, textColor=colors.HexColor("#555555"),
                              spaceAfter=14)
    heading = ParagraphStyle("heading", parent=body, fontSize=10.5, leading=17,
                             spaceBefore=9, spaceAfter=3)
    footnote = ParagraphStyle("footnote", parent=body, fontSize=8.5, leading=13,
                              textColor=colors.HexColor("#777777"))
    center = ParagraphStyle("center", parent=body, alignment=TA_CENTER)

    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / sample["file"]

    flow = [Paragraph(sample["title"], title)]
    if sample["subtitle"]:
        flow.append(Paragraph(sample["subtitle"], subtitle))
    else:
        flow.append(Spacer(1, 10))
    flow.append(Paragraph(sample["intro"], body))
    flow.append(Spacer(1, 6))

    for name, lines in sample["clauses"]:
        block = [Paragraph(name, heading)]
        for line in lines:
            if isinstance(line, tuple) and line[0] == "표":
                table = Table(line[1], colWidths=[45 * mm, 40 * mm, 65 * mm], hAlign="LEFT")
                table.setStyle(TableStyle([
                    ("FONTNAME", (0, 0), (-1, -1), FONT_NAME),
                    ("FONTSIZE", (0, 0), (-1, -1), 9),
                    ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#999999")),
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eeeeee")),
                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                    ("TOPPADDING", (0, 0), (-1, -1), 4),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ]))
                block += [Spacer(1, 3), table, Spacer(1, 5)]
            else:
                block.append(Paragraph(line, body))
        flow.append(KeepTogether(block))

    flow += [Spacer(1, 16), Paragraph(sample["closing"], center), Spacer(1, 10)]

    signature = Table(SIGNATURE, colWidths=[25 * mm, 75 * mm, 50 * mm], hAlign="LEFT")
    signature.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), FONT_NAME),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
        ("LINEBELOW", (1, 0), (-1, -1), 0.3, colors.HexColor("#bbbbbb")),
    ]))
    flow.append(signature)
    flow += [Spacer(1, 14),
             Paragraph("※ 이 문서는 돈워리 프로토타입 시연을 위해 만든 <b>가상의 근로계약서</b>입니다. "
                       "실존하는 사업장·개인과 무관합니다.", footnote)]

    SimpleDocTemplate(
        str(path), pagesize=A4,
        leftMargin=22 * mm, rightMargin=22 * mm,
        topMargin=20 * mm, bottomMargin=18 * mm,
        title=sample["label"], author="돈워리 프로토타입 (가상 데이터)",
    ).build(flow)
    return path


def build_scan(pdf_path: Path) -> Path | None:
    """텍스트 레이어를 없앤 스캔본. Document Parse의 OCR 경로를 시연할 때 씁니다.

    pypdfium2 / Pillow 가 있을 때만 만듭니다. 없으면 조용히 건너뜁니다.
    """
    try:
        import pypdfium2
        from PIL import Image, ImageFilter
    except ImportError:
        return None

    out = pdf_path.with_name(pdf_path.stem + "-스캔본.pdf")
    pages = []
    doc = pypdfium2.PdfDocument(str(pdf_path))
    for index in range(len(doc)):
        image = doc[index].render(scale=300 / 72).to_pil().convert("L")
        image = image.rotate(-1.2, resample=Image.BICUBIC, expand=True, fillcolor=245)
        image = image.filter(ImageFilter.GaussianBlur(0.4)).convert("RGB")
        pages.append(image)
    pages[0].save(out, save_all=True, append_images=pages[1:], resolution=300)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="더미 근로계약서 PDF 생성")
    ap.add_argument("--out", type=Path, default=config.CONTRACT_SAMPLE_DIR)
    ap.add_argument("--download-font", action="store_true", help="한글 폰트가 없으면 내려받습니다")
    ap.add_argument("--scan", action="store_true",
                    help="부당 계약서의 스캔본(이미지 PDF)도 만듭니다 — pypdfium2·Pillow 필요")
    args = ap.parse_args()

    ensure_font(args.download_font)

    manifest = []
    for sample in SAMPLES:
        path = build(sample, args.out)
        manifest.append({k: sample[k] for k in ("id", "file", "label", "summary", "expect")})
        print(f"  생성 {path.name}  ({path.stat().st_size / 1024:.0f}KB)")

        if args.scan and sample["id"] == "unfair":
            scan = build_scan(path)
            if scan is None:
                print("  건너뜀 스캔본 — pypdfium2·Pillow 가 없습니다 "
                      "(.venv/bin/pip install pypdfium2 Pillow)")
            else:
                manifest.append({
                    "id": "unfair-scan", "file": scan.name,
                    "label": sample["label"] + " (스캔본)",
                    "summary": "위 계약서를 300dpi 이미지로 만들어 텍스트 레이어를 없앤 파일. "
                               "Document Parse의 OCR 경로를 확인할 때 씁니다.",
                    "expect": sample["expect"],
                })
                print(f"  생성 {scan.name}  ({scan.stat().st_size / 1024:.0f}KB)")

    path = args.out / "manifest.json"
    path.write_text(json.dumps({"samples": manifest,
                                "note": "전부 가상의 근로계약서입니다. 실존 사업장과 무관합니다."},
                               ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n{len(manifest)}건 · {args.out}")
    print("웹에서 확인 — http://localhost:8000/contract")


if __name__ == "__main__":
    main()
