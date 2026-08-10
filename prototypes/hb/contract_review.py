import base64
import json

import requests

import standard_contract
from bot import UPSTAGE_API_KEY, client_solar


def _format_history(history, max_turns=6):
    """직전 대화를 프롬프트용 텍스트로. 검색이나 게이트 판정에는 쓰지 않는다."""
    if not history:
        return ""
    lines = []
    for m in history[-max_turns:]:
        who = "사용자" if m.get("role") == "user" else "챗봇"
        text = " ".join((m.get("text") or "").split())
        if len(text) > 400:
            text = text[:400] + "…"
        lines.append(f"{who}: {text}")
    return "\n".join(lines)

IE_ENDPOINT = "https://api.upstage.ai/v1/information-extraction"

# 근로기준법 제17조 ①이 사용자에게 명시하도록 요구하는 항목.
# 1~4호는 조문에 직접 나열되어 있고, 근무장소/업무내용은 5호("그 밖에 대통령령으로
# 정하는 근로조건")를 구체화한 근로기준법 시행령 제8조에 근거한다.
REQUIRED_ITEMS = [
    ("wage", "임금"),
    ("working_hours", "소정근로시간"),
    ("holidays", "휴일"),
    ("annual_leave", "연차 유급휴가"),
    ("work_location", "근무 장소"),
    ("job_description", "업무 내용"),
]

EXTRACTION_SCHEMA = {
    "type": "object",
    "properties": {
        "wage": {
            "type": "string",
            "description": "계약서에 명시된 임금(급여 금액, 구성항목, 계산방법, 지급방법, 지급일 등). 계약서에 없으면 빈 문자열.",
        },
        "working_hours": {
            "type": "string",
            "description": "계약서에 명시된 소정근로시간(출근·퇴근 시각, 근무시간). 계약서에 없으면 빈 문자열.",
        },
        "holidays": {
            "type": "string",
            "description": "계약서에 명시된 휴일(주휴일 등). 계약서에 없으면 빈 문자열.",
        },
        "annual_leave": {
            "type": "string",
            "description": "계약서에 명시된 연차 유급휴가 관련 내용. 계약서에 없으면 빈 문자열.",
        },
        "work_location": {
            "type": "string",
            "description": "계약서에 명시된 근무 장소. 계약서에 없으면 빈 문자열.",
        },
        "job_description": {
            "type": "string",
            "description": "계약서에 명시된 담당 업무 내용. 계약서에 없으면 빈 문자열.",
        },
    },
    "required": [key for key, _ in REQUIRED_ITEMS],
    "additionalProperties": False,
}

CONTRACT_REVIEW_SYSTEM_PROMPT = """당신은 '돈워리' 서비스의 근로계약서 검토 도우미입니다.
근로기준법 제17조는 임금, 소정근로시간, 휴일, 연차 유급휴가를, 같은 법 시행령 제8조는 근무장소와 업무내용을
근로계약서에 명시하도록 정하고 있습니다.

사용자가 올린 계약서에서 빠지거나 불명확한 것으로 확인된 항목과, 각 항목의 고용노동부 표준근로계약서 기재 양식이 함께 주어집니다.

답변은 다음 세 부분을 순서대로 씁니다. 부분 이름("누락 항목", "작성 방법" 등)을 제목으로 적지는 마세요.

첫째, 어떤 항목이 빠졌는지 짚어줍니다. 근거 조항을 괄호로 가볍게 붙이세요.
   예: "휴일과 연차 유급휴가가 계약서에 보이지 않습니다(근로기준법 제17조제1항)."

둘째, 각 항목을 실제로 어떻게 써야 하는지 알려줍니다. 이 부분이 답변의 핵심입니다.
   주어진 표준서식 기재 양식을 인용해 "이렇게 적으면 된다"는 예시 문구를 보여주고,
   빈칸을 어떻게 채우는지 한 문장으로 설명하세요. 항목마다 문단을 나누고, 항목 이름은 반드시 별표 두 개로 감싸 굵게 표시하세요(예: **연차 유급휴가**).

셋째, 확인 창구를 한 줄로 안내하고 마칩니다. 고용노동부 1350, 공인노무사 상담 등 실제 존재하는 창구만 쓰세요.

반드시 지켜야 할 규칙:
1. 개별 계약서를 두고 "이건 위법이다/무효다"라고 단정하지 마세요. "명시 의무 항목인데 빠져 있어 보완이 필요하다" 수준으로만 안내합니다. 이것은 법률 자문이 아닙니다.
2. 주어진 항목을 빠짐없이 전부 다루세요. 일부만 설명하고 나머지를 생략하면 안 됩니다.
3. 표준서식 기재 양식은 주어진 내용을 그대로 활용하세요. 서식에 없는 문구나 금액·일수를 지어내지 마세요.
   단, 같은 양식 문구를 한 답변 안에서 두 번 이상 반복해 쓰지 마세요. 항목당 한 번만 제시하고 설명으로 넘어가세요.
   항목이 하나뿐일 때도 "빠진 사실 → 이렇게 적으면 됩니다(양식) → 빈칸 채우는 방법" 순서를 갖춘 온전한 문장으로 쓰세요. 양식만 덜렁 붙여놓으면 안 됩니다.
4. 소제목(###)이나 번호 매긴 목록은 쓰지 마세요. 문단 사이는 빈 줄로 띄웁니다.
5. [직전 대화]가 주어졌다면 거기서 이미 설명한 항목을 처음부터 다시 설명하지 마세요. 사용자가 이번에 물은 항목과 아직 다루지 않은 내용에만 답하세요.
6. 사용자가 특정 항목만 물었다면(예: "연차 부분 어때요?") 그 항목만 답하고, 묻지 않은 항목은 꺼내지 마세요."""

FOLLOWUP_CLASSIFY_PROMPT = """사용자가 방금 근로계약서 검토 결과를 받았습니다. 그 결과에는 어떤 항목이 빠졌는지/확인됐는지가 담겨 있습니다.

아래 새 메시지가 그 계약서 검토 결과 자체를 가리키는 후속 질문인지, 아니면 계약서 검토와 무관한 새로운 근로기준법 질문인지 판단하세요.

[후속 질문의 예 - "예"]
- 또 어떤 부분을 더 채워야 해?
- 다른 문제는 없어?
- 그거 왜 문제야?
- 이거 심각한 거야?
- 그 항목 어떻게 고치면 돼?
- 이 계약서 이대로 써도 괜찮아?

[무관한 새 질문의 예 - "아니오"]
- 야근수당은 언제부터예요?
- 월급이 두 달 밀렸어요
- 수습기간에도 최저임금 받아요?
- 해고 예고는 며칠 전에 해야 해요?
- 퇴직금 계산은 어떻게 해요?

판단 기준: 방금 나온 계약서 검토 결과(빠진 항목, 확인된 내용)를 가리키거나 더 설명해달라는 것이면 "예"입니다.
계약서와 상관없이 전혀 새로운 근로기준법 주제(임금체불, 야근수당, 최저임금, 해고, 퇴직금 등)를 묻는 것이라면,
근로 관련 질문이라는 이유만으로 "예"라고 하면 안 되고 반드시 "아니오"입니다.

반드시 "예" 또는 "아니오" 한 단어만 출력하세요. 다른 설명은 하지 마세요."""


def extract_contract_fields(file_bytes):
    b64 = base64.b64encode(file_bytes).decode("utf-8")
    data_url = f"data:application/octet-stream;base64,{b64}"

    payload = {
        "model": "information-extract",
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": data_url}}
                ],
            }
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "labor_contract_fields",
                "schema": EXTRACTION_SCHEMA,
            },
        },
    }

    resp = requests.post(
        IE_ENDPOINT,
        headers={
            "Authorization": f"Bearer {UPSTAGE_API_KEY}",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=60,
    )
    resp.raise_for_status()
    content = resp.json()["choices"][0]["message"]["content"]
    return json.loads(content)


def find_missing_items(fields):
    return [label for key, label in REQUIRED_ITEMS if not (fields.get(key) or "").strip()]


def find_missing_keys(fields):
    return [key for key, _ in REQUIRED_ITEMS if not (fields.get(key) or "").strip()]


# 사용자가 특정 항목만 콕 집어 물었을 때 그 항목만 답하기 위한 키워드 표.
# 프롬프트 지시만으로는 다른 항목까지 끌어와 설명하는 일이 잦아 코드에서 좁힌다.
FIELD_KEYWORDS = {
    "wage": ["임금", "월급", "급여", "봉급", "연봉", "상여", "수당", "지급일"],
    "working_hours": ["근로시간", "근무시간", "소정근로", "출퇴근", "휴게"],
    "holidays": ["휴일", "주휴", "근무일"],
    "annual_leave": ["연차", "유급휴가", "휴가"],
    "work_location": ["근무장소", "근무 장소", "근무지", "장소"],
    "job_description": ["업무", "직무", "담당"],
}


def detect_focus_keys(question):
    """질문이 특정 항목을 가리키면 그 key 목록을, 아니면 빈 리스트를 반환."""
    if not question:
        return []
    hits = [
        key for key, words in FIELD_KEYWORDS.items()
        if any(w in question for w in words)
    ]
    # 전 항목을 묻는 포괄 질문("뭐가 빠졌어?")이면 좁히지 않는다.
    return hits if 0 < len(hits) < len(FIELD_KEYWORDS) else []


CONSULT_LINE = "정확한 기준은 고용노동부 **1350** 또는 노무사 상담을 추천합니다."


def _with_consult_line(text):
    """마무리 안내를 코드에서 확정적으로 정리한다.

    모델이 안내를 빼먹거나 "고용노동부 1350"처럼 문장을 끝맺지 못한 채 잘라 쓰는
    경우가 잦다. 마지막 줄이 그런 조각이면 걷어내고 완성된 문장으로 교체한다.
    """
    body = text.rstrip()
    lines = body.split("\n")
    tail = lines[-1].strip() if lines else ""

    # 마지막 줄이 짧으면서 1350/노무사만 언급한 조각이면 버린다.
    if tail and len(tail) < 40 and ("1350" in tail or "노무사" in tail):
        body = "\n".join(lines[:-1]).rstrip()
    elif "1350" in body:
        return body  # 이미 온전한 안내 문장이 들어 있음

    return body + "\n\n" + CONSULT_LINE


def generate_review_message(missing_labels, fields=None, question=None, history=None):
    fields = fields or {}
    missing_keys = find_missing_keys(fields) if fields else []

    if not missing_labels:
        return (
            "확인해보니 근로기준법 제17조와 시행령 제8조가 요구하는 **필수 항목**"
            "(임금, 소정근로시간, 휴일, 연차 유급휴가, 근무장소, 업무내용)이 모두 적혀 있습니다.\n\n"
            + CONSULT_LINE
        )

    # 사용자가 특정 항목만 물었으면 그 항목으로 범위를 좁힌다.
    focus_keys = detect_focus_keys(question)
    label_by_key = dict(REQUIRED_ITEMS)
    if focus_keys:
        target_keys = [k for k in missing_keys if k in focus_keys]
        if target_keys:
            missing_labels = [label_by_key[k] for k in target_keys]
            missing_keys = target_keys
        else:
            # 물어본 항목이 계약서에 이미 적혀 있는 경우
            asked = "、".join(label_by_key[k] for k in focus_keys if k in label_by_key)
            values = "\n".join(
                f"- {label_by_key[k]}: {fields.get(k)}"
                for k in focus_keys if (fields.get(k) or "").strip()
            )
            return (
                f"{asked} 항목은 계약서에 적혀 있어 누락은 아닙니다.\n\n"
                f"{values}\n\n"
                "다만 내용이 충분한지(기간·기준이 특정되어 있는지)는 따로 살펴보시는 게 좋습니다.\n\n"
                + CONSULT_LINE
            )

    items_text = ", ".join(missing_labels)
    guide_text = standard_contract.guide_block(missing_keys) or "(표준서식 참고자료 없음)"

    filled = [
        f"{label}: {fields.get(key)}"
        for key, label in REQUIRED_ITEMS
        if (fields.get(key) or "").strip()
    ]
    filled_text = "\n".join(filled) if filled else "없음"

    history_text = _format_history(history)
    history_block = f"[직전 대화]\n{history_text}\n\n" if history_text else ""
    question_block = f"[사용자 질문]\n{question}\n\n" if question else ""

    user_prompt = f"""[계약서에서 빠진 항목]
{items_text}

[계약서에 이미 적혀 있는 내용]
{filled_text}

[고용노동부 표준근로계약서 기재 양식 - 빠진 항목에 대해서만]
{guide_text}

{history_block}{question_block}빠진 항목을 짚어주고, 위 표준서식 양식을 활용해 각 항목을 어떻게 써야 하는지 안내해주세요."""

    response = client_solar.chat.completions.create(
        model="solar-pro3",
        messages=[
            {"role": "system", "content": CONTRACT_REVIEW_SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        temperature=0.3,
    )
    return _with_consult_line(response.choices[0].message.content)


def is_contract_followup(question):
    response = client_solar.chat.completions.create(
        model="solar-pro3",
        messages=[
            {"role": "system", "content": FOLLOWUP_CLASSIFY_PROMPT},
            {"role": "user", "content": question},
        ],
        temperature=0,
        max_tokens=5,
    )
    raw = response.choices[0].message.content.strip()
    return raw.startswith("예")


def answer_contract_followup(question, missing_labels, extracted_fields=None, history=None):
    extracted_fields = extracted_fields or {}
    label_by_key = dict(REQUIRED_ITEMS)
    missing_keys = find_missing_keys(extracted_fields) if extracted_fields else []

    # 특정 항목만 물었으면 그 항목으로 좁힌다(검토 최초 응답과 동일한 규칙).
    focus_keys = detect_focus_keys(question)
    if focus_keys:
        shown_keys = focus_keys
        narrowed_missing = [label_by_key[k] for k in missing_keys if k in focus_keys]
        guide_keys = [k for k in missing_keys if k in focus_keys]
        if narrowed_missing:
            review_summary = "질문한 항목 중 빠진 것: " + ", ".join(narrowed_missing)
        else:
            review_summary = "질문한 항목은 계약서에 적혀 있어 누락은 아닙니다."
    else:
        shown_keys = [k for k, _ in REQUIRED_ITEMS]
        guide_keys = missing_keys
        review_summary = (
            "빠지거나 불명확한 것으로 확인된 항목: " + ", ".join(missing_labels)
            if missing_labels
            else "확인 결과 근로기준법 제17조가 요구하는 필수 항목이 모두 명시되어 있었습니다."
        )

    filled_parts = [
        f"{label_by_key[k]}: {extracted_fields.get(k)}"
        for k in shown_keys
        if (extracted_fields.get(k) or "").strip()
    ]
    filled_summary = "\n".join(filled_parts) if filled_parts else "없음"

    # 후속 질문에도 작성 가이드를 붙여, "어떻게 써야 하는지"까지 답할 수 있게 한다.
    guide_text = standard_contract.guide_block(guide_keys)
    guide_block = f"[표준근로계약서 기재 양식 - 빠진 항목]\n{guide_text}\n\n" if guide_text else ""

    history_text = _format_history(history)
    history_block = f"[직전 대화]\n{history_text}\n\n" if history_text else ""

    user_prompt = f"""[이전 계약서 검토 결과]
{review_summary}

[계약서에서 실제로 확인된 내용]
{filled_summary}

{guide_block}{history_block}[사용자의 후속 질문]
{question}

위 계약서 검토 결과만 근거로, 새로 검색하지 말고 사용자의 후속 질문에 답변하세요.
사용자가 특정 항목만 물었다면 그 항목만 답하고, 직전 대화에서 이미 설명한 내용은 되풀이하지 마세요."""

    response = client_solar.chat.completions.create(
        model="solar-pro3",
        messages=[
            {"role": "system", "content": CONTRACT_REVIEW_SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        temperature=0.3,
    )
    return _with_consult_line(response.choices[0].message.content)
