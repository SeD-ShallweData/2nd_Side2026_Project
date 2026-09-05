"""추출 스키마 — 모델과 규칙 엔진 사이의 계약.

모델이 계약서에서 뽑아야 할 **사실**만 정의합니다. 판정 단어(위반·부당·위법)는
여기 들어가지 않습니다. 판정은 rules.py가 합니다.

`normalize()`가 모델 출력을 이 모양으로 강제합니다. LLM은 문자열/숫자/불리언을
제멋대로 섞어 내므로, 규칙 엔진이 그것을 감당하게 두지 않습니다.
값을 모르면 반드시 None 입니다 — **0 이나 False 로 채우지 않습니다.**
None(모름)과 False(없다고 적혀 있음)를 섞으면 "확인 필요"가 "위반"으로 둔갑합니다.
"""

import json
import re

# 독소조항 후보 코드. 모델은 이 목록 밖의 코드를 만들지 않습니다.
# rules.py의 규칙 id와 짝을 이룹니다.
CLAUSE_CODES = {
    "penalty_predetermined": "위약금·손해배상액을 미리 정한 조항",
    "damages_actual": "실제 발생한 손해를 배상한다는 조항 (금액 미예정)",
    "wage_offset": "손해·대여금을 임금에서 공제·상계하는 조항",
    "forced_saving": "급여 일부를 회사가 적립·관리하는 조항",
    "severance_waived": "퇴직금을 지급하지 않거나 월급에 포함한다는 조항",
    "at_will_dismissal": "회사 판단으로 언제든 해고할 수 있다는 조항",
    "marriage_retirement": "혼인·임신·출산 시 퇴직을 예정한 조항",
    "no_annual_leave": "연차휴가를 부여하지 않는다는 조항",
    "no_weekly_holiday": "주휴일·주휴수당을 주지 않는다는 조항",
    "noncompete": "퇴직 후 경업금지 조항",
    "confidentiality_penalty": "비밀유지 위반 시 배상 조항",
    "duty_change_broad": "업무·근무지를 회사가 임의로 변경할 수 있다는 조항",
    "unpaid_training": "교육·대기 시간을 근로시간에서 제외한다는 조항",
    "other": "위 어디에도 없지만 근로자에게 불리해 보이는 조항",
}

# 제17조 필수 서면 명시 항목
REQUIRED_ITEMS = {
    "wage_components": "임금의 구성항목",
    "wage_calculation": "임금의 계산방법",
    "wage_payment": "임금의 지급방법",
    "scheduled_hours": "소정근로시간",
    "weekly_holiday": "주휴일",
    "annual_leave": "연차유급휴가",
    "work_place_and_duty": "취업장소와 종사할 업무",
}

# 프롬프트에 그대로 박아 넣는 JSON 스키마.
# 두 API 모두 구조화 출력(response_format)을 보장하지 않아 프롬프트로 강제하고
# normalize()로 방어합니다.
EXTRACTION_SCHEMA = {
    "employer_name": "string|null — 사업주/회사명",
    "worker_name": "string|null — 근로자명",
    "headcount": "number|null — 상시 근로자 수. 계약서에 적혀 있을 때만. 추측 금지",
    "job_title": "string|null — 종사할 업무",
    "work_place": "string|null — 취업 장소",
    "contract_type": "'permanent'|'fixed_term'|null — 계약 종료일이 적혀 있으면 fixed_term, 기간의 정함이 없으면 permanent",
    "term_start": "string|null — YYYY-MM-DD",
    "term_end": "string|null — YYYY-MM-DD. 기간의 정함이 없으면 null",
    "wage": {
        "type": "'monthly'|'hourly'|'daily'|'annual'|null",
        "amount": "number|null — 위 단위의 총액 (원)",
        "base_amount": "number|null — 기본급. 따로 적혀 있을 때만",
        "fixed_ot_amount": "number|null — 고정연장/고정OT 수당액",
        "fixed_ot_hours": "number|null — 고정연장수당이 몇 시간분인지",
        "bonus_monthly": "number|null — 매월 지급되는 상여금",
        "welfare_monthly": "number|null — 매월 지급되는 식대·교통비 등",
        "inclusive": "boolean|null — 포괄임금(연장수당 포함) 약정 여부",
        "pay_day": "string|null — 지급일 (예: 매월 25일)",
        "pay_method": "string|null — 지급 방법 (예: 근로자 명의 계좌 이체)",
        "components_itemized": "boolean|null — 임금이 항목별로 나뉘어 적혀 있는가",
    },
    "hours": {
        "daily_hours": "number|null — 1일 소정근로시간 (휴게 제외)",
        "weekly_hours": "number|null — 1주 소정근로시간 (휴게·연장 제외)",
        "weekly_overtime_hours": "number|null — 계약서가 정한 1주 연장근로시간",
        "break_minutes": "number|null — 1일 휴게시간(분)",
        "start_time": "string|null — HH:MM",
        "end_time": "string|null — HH:MM",
        "workdays_per_week": "number|null — 주 소정근로일 수",
        "night_work": "boolean|null — 22시~06시 근로가 예정되어 있는가",
    },
    "holiday": {
        "weekly_holiday_paid": "boolean|null — 주휴일이 유급으로 명시되었는가",
        "public_holiday_paid": "boolean|null — 관공서 공휴일이 유급인가",
        "annual_leave_granted": "boolean|null — 연차유급휴가 조항이 있는가",
    },
    "probation": {
        "exists": "boolean|null",
        "months": "number|null — 수습기간(개월)",
        "wage_rate": "number|null — 수습기간 임금 비율. 70% 면 0.7",
    },
    "severance": {
        "provided": "boolean|null — 퇴직금 지급 조항이 있는가",
        "included_in_wage": "boolean|null — 퇴직금을 월급에 포함한다고 적혀 있는가",
    },
    "insurance": {
        "employment": "boolean|null", "health": "boolean|null",
        "pension": "boolean|null", "accident": "boolean|null",
    },
    "required_items": {k: "boolean|null — 계약서에 적혀 있는가" for k in REQUIRED_ITEMS},
    "clauses": [
        {
            "code": f"위 목록 중 하나: {', '.join(CLAUSE_CODES)}",
            "quote": "string — 계약서 원문 그대로. 요약·의역 금지",
            "note": "string|null — 왜 이 코드로 봤는지 한 줄",
        }
    ],
    "copy_given": "boolean|null — 계약서를 근로자에게 교부한다는 문구가 있는가",
    "signed_date": "string|null — YYYY-MM-DD",
}


# ── 정규화 ────────────────────────────────────────────────────────────
_NUM = re.compile(r"-?\d[\d,]*(\.\d+)?")


def _num(value) -> float | None:
    """'2,400,000원', '월 2400000', 2400000 → 2400000.0 · 못 읽으면 None."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    match = _NUM.search(str(value))
    if not match:
        return None
    try:
        return float(match.group(0).replace(",", ""))
    except ValueError:
        return None


def _int(value) -> int | None:
    got = _num(value)
    return int(round(got)) if got is not None else None


def _bool(value) -> bool | None:
    """모름(None)을 False로 뭉개지 않습니다. 이 구분이 판정 수위를 가릅니다."""
    if isinstance(value, bool):
        return value
    if value is None:
        return None
    text = str(value).strip().lower()
    if text in ("true", "yes", "y", "1", "있음", "예", "o", "유"):
        return True
    if text in ("false", "no", "n", "0", "없음", "아니오", "x", "무"):
        return False
    return None


def _str(value) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.lower() in ("null", "none", "n/a", "-", "미기재", "없음"):
        return None
    return text


def _rate(value) -> float | None:
    """0.7 · '70%' · 70 → 0.7. 1보다 크면 백분율로 봅니다."""
    got = _num(value)
    if got is None:
        return None
    return round(got / 100, 4) if got > 1 else round(got, 4)


_DATE = re.compile(r"(\d{4})\D{1,3}(\d{1,2})\D{1,3}(\d{1,2})")


def _date(value) -> str | None:
    """'2026년 3월 2일', '2026-03-02', '2026.3.2' → '2026-03-02'."""
    text = _str(value)
    if not text:
        return None
    match = _DATE.search(text)
    if not match:
        return None
    y, m, d = (int(g) for g in match.groups())
    if not (1 <= m <= 12 and 1 <= d <= 31):
        return None
    return f"{y:04d}-{m:02d}-{d:02d}"


def _section(raw, key) -> dict:
    got = raw.get(key)
    return got if isinstance(got, dict) else {}


def normalize(raw: dict | str) -> dict:
    """모델 출력을 규칙 엔진이 믿고 쓸 수 있는 모양으로 강제합니다."""
    if isinstance(raw, str):
        raw = parse_json(raw) or {}
    if not isinstance(raw, dict):
        raw = {}

    wage, hours = _section(raw, "wage"), _section(raw, "hours")
    holiday, probation = _section(raw, "holiday"), _section(raw, "probation")
    severance, insurance = _section(raw, "severance"), _section(raw, "insurance")
    required = _section(raw, "required_items")

    contract_type = _str(raw.get("contract_type"))
    if contract_type not in ("permanent", "fixed_term"):
        contract_type = None

    wage_type = _str(wage.get("type"))
    if wage_type not in ("monthly", "hourly", "daily", "annual"):
        wage_type = None

    clauses = []
    for item in raw.get("clauses") or []:
        if not isinstance(item, dict):
            continue
        quote = _str(item.get("quote"))
        if not quote:
            continue          # 원문 인용이 없는 지적은 버립니다. 근거 없이 띄우지 않습니다.
        code = _str(item.get("code")) or "other"
        clauses.append({
            "code": code if code in CLAUSE_CODES else "other",
            "quote": quote[:400],
            "note": _str(item.get("note")),
        })

    return {
        "employer_name": _str(raw.get("employer_name")),
        "worker_name": _str(raw.get("worker_name")),
        "headcount": _int(raw.get("headcount")),
        "job_title": _str(raw.get("job_title")),
        "work_place": _str(raw.get("work_place")),
        "contract_type": contract_type,
        "term_start": _date(raw.get("term_start")),
        "term_end": _date(raw.get("term_end")),
        "wage": {
            "type": wage_type,
            "amount": _int(wage.get("amount")),
            "base_amount": _int(wage.get("base_amount")),
            "fixed_ot_amount": _int(wage.get("fixed_ot_amount")),
            "fixed_ot_hours": _num(wage.get("fixed_ot_hours")),
            "bonus_monthly": _int(wage.get("bonus_monthly")),
            "welfare_monthly": _int(wage.get("welfare_monthly")),
            "inclusive": _bool(wage.get("inclusive")),
            "pay_day": _str(wage.get("pay_day")),
            "pay_method": _str(wage.get("pay_method")),
            "components_itemized": _bool(wage.get("components_itemized")),
        },
        "hours": {
            "daily_hours": _num(hours.get("daily_hours")),
            "weekly_hours": _num(hours.get("weekly_hours")),
            "weekly_overtime_hours": _num(hours.get("weekly_overtime_hours")),
            "break_minutes": _num(hours.get("break_minutes")),
            "start_time": _str(hours.get("start_time")),
            "end_time": _str(hours.get("end_time")),
            "workdays_per_week": _num(hours.get("workdays_per_week")),
            "night_work": _bool(hours.get("night_work")),
        },
        "holiday": {
            "weekly_holiday_paid": _bool(holiday.get("weekly_holiday_paid")),
            "public_holiday_paid": _bool(holiday.get("public_holiday_paid")),
            "annual_leave_granted": _bool(holiday.get("annual_leave_granted")),
        },
        "probation": {
            "exists": _bool(probation.get("exists")),
            "months": _num(probation.get("months")),
            "wage_rate": _rate(probation.get("wage_rate")),
        },
        "severance": {
            "provided": _bool(severance.get("provided")),
            "included_in_wage": _bool(severance.get("included_in_wage")),
        },
        "insurance": {k: _bool(insurance.get(k))
                      for k in ("employment", "health", "pension", "accident")},
        "required_items": {k: _bool(required.get(k)) for k in REQUIRED_ITEMS},
        "clauses": clauses,
        "copy_given": _bool(raw.get("copy_given")),
        "signed_date": _date(raw.get("signed_date")),
    }


# ── 모델 출력에서 JSON 꺼내기 ─────────────────────────────────────────
_FENCE = re.compile(r"```(?:json)?\s*(.+?)```", re.S)


def parse_json(text: str) -> dict | None:
    """코드펜스·머리말이 섞인 응답에서 JSON 객체를 꺼냅니다.

    두 모델 모두 "다음과 같습니다:" 같은 머리말을 붙이거나 ```json 으로 감싸며,
    solar-pro3는 추론 흔적을 앞에 흘리기도 합니다. 세 단계로 시도합니다.
    """
    if not text:
        return None

    for candidate in (text, *(m.group(1) for m in _FENCE.finditer(text))):
        try:
            got = json.loads(candidate.strip())
        except (json.JSONDecodeError, AttributeError):
            continue
        if isinstance(got, dict):
            return got

    # 마지막 수단 — 중괄호 균형을 세어 가장 바깥 객체를 잘라냅니다.
    start = text.find("{")
    if start < 0:
        return None
    depth, in_str, escaped = 0, False, False
    for i, ch in enumerate(text[start:], start):
        if in_str:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    got = json.loads(text[start:i + 1])
                except json.JSONDecodeError:
                    return None
                return got if isinstance(got, dict) else None
    return None


# ── 인용문 대조 ───────────────────────────────────────────────────────
# 2026-08-08 실호출에서 발견 — 모델이 조항 코드 표를 **체크리스트로 착각해**
# 해당 없는 코드까지 전부 나열하고, quote 에 계약서 원문 대신 프롬프트의
# 표 설명문("손해액·대여금을 임금에서 공제·상계한다는 조항")을 복사했습니다.
# 정상 계약서가 위반 투성이로 판정되는 최악의 오탐입니다.
#
# 프롬프트로도 막지만, **원문에 없는 인용은 코드가 버립니다.**
# 조항 판정의 근거는 계약서에 실제로 적힌 문장뿐입니다.

_NOT_APPLICABLE = re.compile(r"^\s*(해당\s*없음|없음|없습니다|N/?A|-)\s*$", re.I)

# 코드별 요건 — 인용문이 그 코드로 볼 만한 내용을 담고 있는가.
#
# 인용 대조만으로는 부족했습니다. 2026-08-08 실호출에서 모델이 **원문에 있는 문장에
# 엉뚱한 코드**를 붙였습니다. "이 계약에 정함이 없는 사항은 근로기준법령에 따른다"에
# at_will_dismissal · marriage_retirement · no_annual_leave 를 동시에 달았고,
# "퇴직급여제도를 설정한다"(정상 조항)에 severance_waived 를 붙였습니다.
# 인용은 진짜라 대조를 통과하고 그대로 🔴 위반이 됩니다.
#
# 그래서 **코드도 코드로 검증합니다.** 요건을 못 맞추면 그 지적은 버립니다.
# 놓치는 것보다 멀쩡한 조항을 위반이라고 말하는 쪽이 훨씬 나쁩니다.
_AMOUNT = r"\d[\d,]*\s*(원|만원|천만원)"

CLAUSE_SIGNATURES: dict[str, tuple[re.Pattern, ...]] = {
    # 배상 문언 + 미리 정해진 금액이 함께 있어야 위약 예정입니다.
    "penalty_predetermined": (re.compile(r"위약|배상|변상|물어"), re.compile(_AMOUNT)),
    "damages_actual": (re.compile(r"손해"), re.compile(r"배상|변상")),
    "wage_offset": (re.compile(r"공제|상계|차감"), re.compile(r"임금|급여|월급|보수")),
    "forced_saving": (re.compile(r"적립|저축|예치|보관"), re.compile(r"임금|급여|월급")),
    "severance_waived": (re.compile(r"퇴직금|퇴직급여"),
                         re.compile(r"지급하지|주지\s*않|청구할\s*수\s*없|포함하여\s*지급"
                                    r"|포함해\s*지급|없는\s*것으로|포기")),
    "at_will_dismissal": (re.compile(r"해고|해지|퇴사시|계약을\s*종료"),
                          re.compile(r"언제든|예고\s*없이|필요하다고\s*인정|임의로|즉시")),
    "marriage_retirement": (re.compile(r"혼인|결혼|임신|출산|육아"), re.compile(r"퇴직|퇴사|사직")),
    "no_annual_leave": (re.compile(r"연차|유급휴가"),
                        re.compile(r"부여하지|주지\s*않|없\b|없다|없음|아니한다|아니하며|제외")),
    "no_weekly_holiday": (re.compile(r"주휴"),
                          re.compile(r"지급하지|주지\s*않|포함된\s*것|별도로|없\b|아니한다")),
    "unpaid_training": (re.compile(r"교육|대기|조회|인수인계|준비|청소"),
                        re.compile(r"근로시간|포함하지|제외|무급")),
    "noncompete": (re.compile(r"경업|동종|경쟁"), re.compile(r"취업|영업|종사|근무")),
    "confidentiality_penalty": (re.compile(r"비밀|기밀|영업비밀"), re.compile(r"배상|손해|위약")),
    "duty_change_broad": (re.compile(r"업무|직무|근무\s*장소|근무지|배치|전보"),
                          re.compile(r"변경|전환|이동|명할\s*수|지정")),
}

# `other` 로 들어온 표준 조항. 어느 계약서에나 있는 문구라 지적할 것이 없습니다.
# 이걸 걸러내지 않으면 정상 계약서에도 🟡 이 하나씩 붙습니다.
_BOILERPLATE = re.compile(
    r"정함이\s*없는\s*사항|근로기준법령에\s*따른다|취업규칙에\s*따른다"
    r"|상시\s*근로자\s*수는|각\s*1부씩\s*보관|성실히\s*이행|본\s*계약을\s*증명")

# 대조 전에 지울 것 — 공백, 문서기호, 줄바꿈. Document Parse 출력과 모델 인용이
# 이 정도는 어긋납니다(①/(1), 전각/반각 공백, 마크다운 강조 등).
_LOOSE = re.compile(r"[\s  ·•*_`~\-—–()（）\[\]{}“”\"'’‘:：;,，.。]+")


def _loose(text: str) -> str:
    return _LOOSE.sub("", text or "")


def verify_quotes(contract: dict, source: str) -> tuple[dict, list[dict]]:
    """`clauses[].quote` 가 계약서 본문에 실제로 있는지 대조합니다.

    반환: (인용이 확인된 조항만 남긴 contract, 버려진 조항 목록)

    판정 기준 — 하나라도 못 넘으면 버립니다
      ① note 가 "해당 없음" 류면 버립니다 — 모델이 표를 훑고 있다는 신호입니다
      ② 인용문이 계약서 본문에 실제로 있어야 합니다 (공백·기호는 무시하고 대조)
      ③ 인용 내용이 그 코드의 요건(CLAUSE_SIGNATURES)을 만족해야 합니다
      ④ `other` 는 표준 조항 문구가 아니어야 합니다

    근거 없는 지적을 띄우느니 놓치는 편이 낫습니다.
    놓친 조항은 사용자가 다른 경로로 확인할 수 있지만,
    멀쩡한 조항을 위반이라고 말하면 회사와 다투게 만듭니다.
    """
    haystack = _loose(source)
    kept, dropped = [], []

    for clause in contract.get("clauses") or []:
        quote = clause.get("quote") or ""
        note = clause.get("note") or ""
        code = clause.get("code") or "other"
        needle = _loose(quote)

        if _NOT_APPLICABLE.match(note):
            dropped.append({**clause, "reason": "note가 '해당 없음' — 표를 훑은 결과"})
            continue
        if len(needle) < 6:
            dropped.append({**clause, "reason": "인용이 너무 짧아 대조할 수 없음"})
            continue

        # ② 원문 대조. 모델이 조항을 이어 붙이거나 줄이기도 해 양 끝으로도 봅니다.
        if not (needle in haystack or needle[:20] in haystack or needle[-20:] in haystack):
            dropped.append({**clause, "reason": "계약서 본문에서 찾지 못한 인용"})
            continue

        # ③ 코드 요건. 인용이 진짜라도 코드가 엉뚱하면 위반이 되어서는 안 됩니다.
        required = CLAUSE_SIGNATURES.get(code)
        if required and not all(pattern.search(quote) for pattern in required):
            dropped.append({**clause, "reason": f"인용 내용이 '{code}' 요건과 맞지 않음"})
            continue

        # ④ 표준 조항을 `other` 로 올린 경우
        if code == "other" and _BOILERPLATE.search(quote):
            dropped.append({**clause, "reason": "어느 계약서에나 있는 표준 조항"})
            continue

        kept.append(clause)

    return {**contract, "clauses": kept}, dropped


# ── 파생값 ────────────────────────────────────────────────────────────
def term_months(contract: dict) -> float | None:
    """계약기간(개월). 기간의 정함이 없으면 무기계약이므로 큰 값으로 봅니다."""
    if contract.get("contract_type") == "permanent" and not contract.get("term_end"):
        return float("inf")
    start, end = contract.get("term_start"), contract.get("term_end")
    if not (start and end):
        return None
    ys, ms, ds = (int(x) for x in start.split("-"))
    ye, me, de = (int(x) for x in end.split("-"))
    return round((ye - ys) * 12 + (me - ms) + (de - ds) / 30.0, 2)


def weekly_hours(contract: dict) -> float | None:
    """1주 소정근로시간. 없으면 일 단위 × 주 근로일로 채웁니다."""
    hours = contract["hours"]
    if hours["weekly_hours"]:
        return hours["weekly_hours"]
    if hours["daily_hours"] and hours["workdays_per_week"]:
        return round(hours["daily_hours"] * hours["workdays_per_week"], 2)
    return None
