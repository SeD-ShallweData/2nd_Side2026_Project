import os
from pathlib import Path

from dotenv import load_dotenv
from sentence_transformers import SentenceTransformer
import chromadb
from openai import OpenAI

# =========================================================
# 설정값
# =========================================================
DB_PATH = "/data/shared-SeD/hb/persona_test/labor_law_db"


# API 키는 코드에 두지 않고 .env 파일에서 읽는다.
# DONWORRY_ENV_FILE로 경로를 직접 지정할 수 있고, 지정하지 않으면
# 현재 파일에서 상위 디렉터리로 올라가며 .env / api_key.env를 찾는다.
def _find_env_file():
    explicit = os.environ.get("DONWORRY_ENV_FILE")
    if explicit:
        return Path(explicit)
    for parent in Path(__file__).resolve().parents:
        for name in (".env", "api_key.env"):
            candidate = parent / name
            if candidate.is_file():
                return candidate
    return None


ENV_FILE = _find_env_file()
if ENV_FILE:
    # 이미 설정된 환경변수가 있으면 그쪽을 우선한다(override=False가 기본).
    load_dotenv(ENV_FILE)

UPSTAGE_API_KEY = (
    os.environ.get("UPSTAGE_API_KEY")
    or os.environ.get("Upstage_API_KEY")
    or ""
).strip()

if not UPSTAGE_API_KEY:
    raise RuntimeError(
        "Upstage API 키를 찾을 수 없습니다.\n"
        f"  - 확인한 .env 파일: {ENV_FILE or '(없음)'}\n"
        "  - 해결: .env(또는 api_key.env)에 Upstage_API_KEY=up_... 를 넣거나,\n"
        "          환경변수 UPSTAGE_API_KEY를 설정하세요."
    )

# =========================================================
# 임베딩 모델 + 벡터DB 로드 (프로세스당 한 번만)
# =========================================================
print("임베딩 모델 로딩 중...")
embed_model = SentenceTransformer('BAAI/bge-m3', device='cpu')

client_db = chromadb.PersistentClient(path=DB_PATH)
collection = client_db.get_collection("labor_law")
print(f"DB 연결 완료. 저장된 조문 수: {collection.count()}\n")

client_solar = OpenAI(api_key=UPSTAGE_API_KEY, base_url="https://api.upstage.ai/v1")

# =========================================================
# 페르소나별 시스템 프롬프트
# =========================================================
FORMAT_RULES = """

[답변 구조 - 반드시 이 흐름으로 쓸 것]
당신의 답변은 '법령 해설'이 아니라 '행동 가이드'입니다. 사용자가 읽고 나서 지금 무엇을 해야 할지 알 수 있어야 합니다.
답변은 빈 줄로 구분된 문단 4개로 쓰고, 각 문단의 역할은 아래와 같습니다.

★ 절대 금지: 아래 설명에 나오는 역할 이름은 당신이 참고하는 설계도일 뿐입니다.
"1단계", "2단계", "첫째 문단", "공감", "문제 인식", "대처법", "상담 권유" 같은 표현을 답변에 쓰면 안 됩니다.
답변에는 어떤 제목이나 라벨도 넣지 말고, 곧바로 본문 문장부터 시작하세요.
사용자에게는 그냥 자연스럽게 이어지는 문단 4개로만 읽혀야 합니다.

〔첫 문단의 역할〕 상황 인정 (1~2문장)
   사용자가 이번 질문에서 실제로 말한 상황만 짚어 짧게 인정합니다. 과장이나 미사여구는 쓰지 마세요.
   사용자가 말하지 않은 기간·금액·피해를 임의로 가정해서 공감하면 안 됩니다.
   질문이 사실 확인이나 작성 방법을 묻는 것이라면(예: "어떻게 써야 해?") 위로할 상황이 아니므로 이 문단을 건너뛰세요.
   단, 위 페르소나 규칙에서 공감을 생략하라고 했다면 이 문단은 항상 건너뛰고 둘째 문단 역할부터 시작하세요.

〔둘째 문단의 역할〕 법적 의미 짚기 (1~2문장, 여기서 법령을 씁니다)
   사용자의 상황이 법적으로 어떤 의미인지 짚어줍니다.
   "제N조에 따르면 ~하다"는 식의 조문 해설이 아니라, 사용자의 언어로 번역해서 말하세요.
   조항 번호는 문장 끝에 괄호로 가볍게 붙입니다.
   예시(문체 참고용, 내용을 그대로 쓰지 마세요): "회사가 어려워도 정부가 밀린 임금을 대신 지급하는 제도를 쓸 수 있는 상황입니다(임금채권보장법 제7조)."

〔셋째 문단의 역할〕 지금 할 일 안내 (답변의 핵심, 가장 비중이 큽니다)
   지금부터 해야 할 일을 시간 순서대로 제시합니다. 각 단계에는 '무엇을·어디서·어떻게'가 들어가야 합니다.
   근거 법령은 해당 행동 문장 안에 괄호로 붙이세요. "관련 법령" 같은 별도 문단을 만들면 안 됩니다.
   예시 흐름(임금체불 질문일 때만 해당): 증거 확보 → 노동청 진정 접수 → 체불 확인서 발급 → 대지급금 신청
   질문 주제가 다르면 이 흐름을 쓰지 말고, 그 주제에 맞는 행동 순서를 새로 구성하세요.
   특히 계약서 작성 방법을 묻는 질문에는 진정·대지급금 같은 분쟁 절차를 끌어오면 안 됩니다.

〔넷째 문단의 역할〕 창구 안내 (1~2문장)
   공식 창구 안내로 마무리합니다. 고용노동부 상담 1350, 무료 국선노무사 지원, 대한법률구조공단 132 등
   널리 알려진 공식 창구만 안내하세요. 없는 번호나 제도를 지어내면 안 됩니다.
   "혼자 하기 부담되면 무료 지원을 활용하라"는 톤으로 씁니다.

[내용 규칙 - 반드시 지킬 것]
- [직전 대화]가 주어졌다면, 거기서 이미 지적하거나 설명한 내용을 그대로 반복하지 마세요. 후속 질문에는 사용자가 이번에 물은 부분과 아직 다루지 않은 새로운 정보에만 답하세요. 같은 항목을 다시 언급해야 한다면 "앞서 말씀드린 ○○" 정도로 짧게 지나가고, 설명을 처음부터 되풀이하지 마세요.
- 법령을 답변의 주어로 삼지 마세요. 법령은 '이 행동을 할 수 있는 근거'로만 등장합니다. "관련 법령", "참고 조항" 같은 별도 섹션을 절대 만들지 마세요.
- 근거가 된 조항은 반드시 밝히되, 나열하지 말고 해당 행동·설명 문장 안에 괄호로 붙이세요. 예: "(근로기준법 제36조)".
- 아래 [참고 조항]에는 검색된 여러 조항이 함께 들어 있습니다. 질문과 실제로 관련된 것만 쓰고, 나머지는 아예 언급하지 마세요. 조항에 없는 조항 번호·법률·예외 사유를 지어내지 마세요.
- 참고 조항에 근거가 없으면 4단 구조를 억지로 채우지 마세요. 이 경우에는 "제공된 법령 범위에서는 확인이 어렵다"고 밝히고 관할 창구만 안내하는 짧은 답변으로 줄이세요. 답을 정상적으로 찾은 경우에는 이 문구를 절대 쓰지 마세요.
- 상한액, 소요 기간, 지급 비율처럼 참고 조항에 명시되지 않은 구체적인 숫자는 지어내지 마세요. 확실하지 않으면 "관할 노동청이나 근로복지공단에서 확인"으로 넘기세요.
- 참고 조항에 계산식이 없으면 금액 계산 예시를 만들지 마세요. 조항이 정한 기준(예: "1년에 30일분의 평균임금")을 그대로 설명하는 데 그치세요.
- 서로 다른 개념을 섞지 마세요. 평균임금과 통상임금은 다른 개념이고, 임금체불과 부당해고도 다른 문제입니다. 질문에서 묻지 않은 개념의 조항을 끌어오면 안 됩니다.

[표현 규칙]
- 소제목(###)이나 번호 매긴 목록은 쓰지 마세요. 대처법의 순서는 "먼저", "그다음", "이후에" 같은 말로 자연스럽게 이어가세요.
- 기한, 금액, 제도 이름처럼 정말 핵심적인 단어 1~2개에만 **굵게** 표시를 쓰세요. 남발하지 마세요.
- 문단 사이는 빈 줄로 띄우고, 한 덩어리로 길게 이어붙이지 마세요."""

SYSTEM_PROMPTS = {
    "구직자": """당신은 '돈워리' 서비스의 챗봇입니다. 지금 대화 상대는 아직 입사하지 않은 '구직자'입니다.

구직자는 이 회사에 들어가도 되는지 판단하려고 불안한 상태로 질문합니다.

반드시 지켜야 할 규칙:
1. 아래 [참고 조항]에 실제로 나온 내용만 근거로 답변하세요. 참고 조항이 질문 주제를 직접 다루고 있지 않다면, 아는 지식으로 채우지 말고 "확인이 어렵다"고 답하세요.
2. 특정 회사를 '위험하다'고 판정형으로 단정하지 마세요. 신뢰도·확인필요 등 완곡한 표현을 쓰세요.
3. 위험을 과장해 겁주지 말고, 안심시키되 정확하게 답하세요.
4. 첫 문단에서 불안한 마음을 짧게 인정해 주세요.
5. 핵심 문단은 '입사 전에 무엇을 어떻게 확인하면 되는지'를 순서대로 알려주는 내용으로 채우세요.""" + FORMAT_RULES,

    "근로자": """당신은 '돈워리' 서비스의 챗봇입니다. 지금 대화 상대는 현재 재직 중이거나 퇴직 직후인 '근로자'로, 실제로 문제(임금체불, 부당대우 등)를 겪고 있을 수 있습니다.

반드시 지켜야 할 규칙:
1. 아래 [참고 조항]에 실제로 나온 내용만 근거로 답변하세요. 참고 조항이 질문 주제를 직접 다루고 있지 않다면, 아는 지식으로 채우지 말고 "확인이 어렵다"고 답하세요.
2. 사용자가 겪는 개별 상황이 '위법이다/합법이다'라고 단정하지 마세요. 법이 정한 요건을 알려주고 최종 판단은 전문가·관할 기관에 맡기세요. 이 규칙이 가장 중요합니다.
3. 첫 문단에서 상황의 심각성을 차분하게 인정해 주세요. 감정을 증폭시키지는 마세요.
4. 지금 할 일을 안내하는 문단이 답변의 중심입니다. 당장 할 수 있는 행동을 시간 순서대로 구체적으로 제시하세요.""" + FORMAT_RULES,

    "사업주": """당신은 '돈워리' 서비스의 챗봇입니다. 지금 대화 상대는 소규모 사업장을 운영하는 '사업주'입니다.

반드시 지켜야 할 규칙:
1. 아래 [참고 조항]에 실제로 나온 내용만 근거로 답변하세요. 참고 조항이 질문 주제를 직접 다루고 있지 않다면, 아는 지식으로 채우지 말고 "확인이 어렵다"고 답하세요.
2. 비난하지 않고 개선을 돕는 컨설턴트 톤을 유지하세요. '단속당한다'고 느끼면 방어적으로 돌아서니, 의무를 명확히 알려주되 실행 방법 중심으로 답하세요.
3. 사업주에게는 상황을 위로하는 문단을 생략하세요. 위로 문장으로 시작하지 말고, 곧바로 '무엇이 기준인지'부터 짚어주세요.
4. 답변 흐름은 '기준·의무 → 실무적으로 무엇을 어떻게 하면 되는지 → 확인 창구' 순서로 씁니다.
5. 기한·기준은 정확히 언급하되, 개별 사안에 대한 위법 단정은 피하세요.""" + FORMAT_RULES,
}

DEFAULT_PERSONA = "근로자"

# =========================================================
# 페르소나별 예상 질문 (자동 분류용 few-shot 예시)
# =========================================================
PERSONA_EXAMPLES = {
    "구직자": [
        "이 회사 임금 밀린 적 있어요?",
        "여기 다니는 사람들 얘기 들어보면 어때요?",
        "수습기간에도 최저임금 받아요?",
        "입사 전에 뭘 확인해야 해요?",
        "이 회사 블라인드에 안 좋은 얘기 많던데 진짜예요?",
        "면접 때 뭘 물어봐도 실례가 안 될까요?",
        "근로계약서에서 꼼꼼히 봐야 할 부분이 뭐예요?",
        "포괄임금제라는데 이거 괜찮은 건가요?",
        "수습 3개월 끝나고 정규직 전환 안 해주면 어떡해요?",
        "이 회사 다니다가 그만둔 사람이 많다는데 이유가 뭘까요?",
        "연봉 협상할 때 뭘 확인해야 나중에 손해 안 봐요?",
        "채용공고에 없던 조건을 입사 후에 바꾸면 어떻게 해요?",
    ],
    "근로자": [
        "월급이 두 달 밀렸어요. 어떻게 해요?",
        "사장이 갑자기 나가라는데 이거 부당해고예요?",
        "퇴직금 계산 어떻게 해요?",
        "야근을 밥 먹듯이 하는데 수당을 안 줘요",
        "연차 쓴다고 했더니 눈치를 줘요",
        "4대보험 안 들어줬는데 이거 문제 없나요?",
        "회사에서 갑자기 월급을 깎겠다는데 가능한가요?",
        "퇴사한다고 했는데 한 달 더 다니라고 강요해요",
        "직장 내 괴롭힘을 당하고 있는데 어디에 신고해요?",
        "출산휴가 썼다고 제 자리를 없앴어요",
        "임금명세서를 안 줘요",
        "해고 통보를 문자로만 받았어요, 이거 정당한가요?",
    ],
    "사업주": [
        "월급 언제까지 줘야 해요?",
        "몇 시간부터 야근수당이에요?",
        "근로계약서에 뭘 넣어야 해요?",
        "직원 채용하면 4대보험 꼭 들어야 하나요?",
        "연차는 며칠씩 줘야 하는 거예요?",
        "해고하려면 며칠 전에 알려줘야 해요?",
        "최저임금 위반 안 하려면 뭘 확인해야 해요?",
        "직원이 갑자기 그만두면 퇴직금은 언제까지 줘야 해요?",
        "근로계약서를 안 쓰면 어떻게 되나요?",
        "5인 미만 사업장인데도 지켜야 할 게 있나요?",
        "야근 수당 계산법 좀 알려주세요",
        "직원이 노동청에 신고했다는데 어떻게 대응해야 해요?",
    ],
}

_examples_block = "\n\n".join(
    f"[예시 - {persona}]\n" + "\n".join(f"- {q}" for q in qs)
    for persona, qs in PERSONA_EXAMPLES.items()
)

CLASSIFY_SYSTEM_PROMPT = f"""당신은 '돈워리' 서비스의 질문 분류기입니다.
사용자 질문을 아래 세 페르소나 중 가장 가까운 하나로 분류하세요.

- 구직자: 아직 입사하지 않았고, 이 회사에 들어가도 되는지/입사 전에 무엇을 확인해야 하는지 판단하려는 사람.
- 근로자: 현재 재직 중이거나 퇴직 직후로, 실제로 문제(임금체불, 부당해고, 괴롭힘 등)를 겪고 있거나 자신의 권리를 확인하려는 사람.
- 사업주: 소규모 사업장을 운영하며 법적 의무나 기준을 확인하려는 사람.

{_examples_block}

위 세 페르소나 중 가장 가까운 것 하나만 정확히 출력하세요.
반드시 "구직자", "근로자", "사업주" 중 한 단어만 출력하고, 다른 설명은 절대 하지 마세요."""


def classify_persona(question):
    response = client_solar.chat.completions.create(
        model="solar-pro3",
        messages=[
            {"role": "system", "content": CLASSIFY_SYSTEM_PROMPT},
            {"role": "user", "content": question},
        ],
        temperature=0,
        max_tokens=5,
    )
    raw = response.choices[0].message.content.strip()
    for persona in SYSTEM_PROMPTS:
        if persona in raw:
            return persona
    return DEFAULT_PERSONA


def ask_donworry_auto(question, n_results=5, history=None):
    persona = classify_persona(question)
    print(f"[분류된 페르소나] {persona} ← {question!r}")
    return ask_donworry(question, persona, n_results=n_results, history=history)


def format_history(history, max_turns=6):
    """직전 대화를 프롬프트에 넣을 텍스트로 변환. 검색·게이트에는 쓰지 않는다."""
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


# 도급/건설업처럼 특수한 상황에만 적용되는 조항 - 질문이 그 맥락을 직접 언급하지
# 않는 한, 일반적인 임금체불 상담에서는 우선순위를 낮춘다.
NARROW_ARTICLE_KEYWORDS = ["도급", "하도급", "수급인", "건설업", "건설산업"]
NARROW_TRIGGER_KEYWORDS = ["도급", "하도급", "수급", "건설", "하청", "원청"]


def _is_narrow_article(title):
    return any(k in title for k in NARROW_ARTICLE_KEYWORDS)


def retrieve_context(question, n_results=3, candidate_pool=12):
    q_emb = embed_model.encode([question], normalize_embeddings=True)
    results = collection.query(query_embeddings=q_emb.tolist(), n_results=candidate_pool)

    candidates = list(zip(
        results["documents"][0],
        results["metadatas"][0],
        results["distances"][0],
    ))

    # 필터링 전, 가장 가까운 원본 검색 결과와의 거리 - "DB에 애초에 관련 내용이
    # 있는지"를 판단하는 기준이 된다 (narrow-article 필터로 밀려나기 전 값).
    raw_top1_distance = candidates[0][2] if candidates else None

    narrow_ok = any(k in question for k in NARROW_TRIGGER_KEYWORDS)

    def pick(allow_narrow):
        seen = set()
        picked = []
        for doc, meta, dist in candidates:
            aid = meta["article_id"]
            if aid in seen:
                continue
            if not allow_narrow and _is_narrow_article(meta["title"]):
                continue
            seen.add(aid)
            picked.append((doc, meta, dist))
            if len(picked) >= n_results:
                break
        return picked, seen

    picked, seen = pick(allow_narrow=narrow_ok)
    if len(picked) < n_results:
        # 걸러내고 나니 부족하면, 걸러졌던 조항으로 채운다.
        for doc, meta, dist in candidates:
            aid = meta["article_id"]
            if aid in seen:
                continue
            seen.add(aid)
            picked.append((doc, meta, dist))
            if len(picked) >= n_results:
                break

    return picked, raw_top1_distance


# 근로기준법 143개 조문 대상, 페르소나 예상 질문 36개 + 실제 질문 몇 개로 raw
# top-1 distance 분포를 확인한 결과 잡은 경험적 임계값. 이보다 멀면 DB에 그
# 주제를 다루는 조항이 사실상 없다고 보고(예: 최저임금법, 4대보험, 회사 평판
# 관련 질문), 모델 호출 없이 바로 "확인이 어렵다"로 응답한다.
NO_MATCH_DISTANCE_THRESHOLD = 0.47

NO_MATCH_MESSAGES = {
    "구직자": "이 질문은 지금 참고할 수 있는 조항 범위 밖이라 정확히 확인해드리기 어려워요. 회사나 채용 담당자에게 직접 확인해보시는 걸 추천드려요.",
    "근로자": "이 질문은 지금 참고할 수 있는 조항 범위 밖이라 정확히 확인해드리기 어려워요. 고용노동부 **1350** 상담센터에 문의해보시는 게 가장 정확해요.",
    "사업주": "이 질문은 지금 참고할 수 있는 조항 범위 밖이라 정확히 확인해드리기 어려워요. 고용노동부 **1350** 상담센터나 노무사 상담을 통해 확인해보세요.",
}


def format_citation(meta):
    """근거 표기용 문자열: '근로기준법 제2조제1항제6호' 형태."""
    clause = meta.get("clause") or ""
    return f"{meta.get('law', '')} {meta['article_id']}{clause}".strip()


def ask_donworry(question, persona, n_results=5, history=None):
    if persona not in SYSTEM_PROMPTS:
        persona = DEFAULT_PERSONA

    # 중요: 검색과 게이트 판정은 '이번 사용자 질문'만으로 한다. 히스토리를 섞으면
    # 질문과 무관한 이전 대화 때문에 거리가 흐려져 게이트가 오작동한다.
    # 히스토리는 아래 생성 프롬프트에만 참고용으로 들어간다.
    picked, raw_top1_distance = retrieve_context(question, n_results=n_results)

    if raw_top1_distance is None or raw_top1_distance > NO_MATCH_DISTANCE_THRESHOLD:
        print(f"[검색 실패 - 모델 호출 생략] top1_distance={raw_top1_distance} ← {question!r}")
        return NO_MATCH_MESSAGES.get(persona, NO_MATCH_MESSAGES[DEFAULT_PERSONA])

    # 조항을 1개로 좁히지 않고 top-k를 그대로 컨텍스트로 넘긴다.
    # (정답이 1위가 아닌 경우가 잦아 선택 단계에서 오답이 발생했었다.)
    print(f"[참고 조항 {len(picked)}개] " + " | ".join(
        f"{format_citation(m)}({m['title']}) {d:.3f}" for _, m, d in picked
    ) + f" ← {question!r}")

    context_text = "\n\n".join(
        f"[{format_citation(meta)}({meta['title']})]\n{doc}"
        for doc, meta, _dist in picked
    )

    history_text = format_history(history)
    history_block = f"""[직전 대화]
{history_text}

""" if history_text else ""

    user_prompt = f"""[참고 조항]
{context_text}

{history_block}[사용자 질문]
{question}

위 참고 조항 중 질문과 직접 관련된 것만 근거로 삼아, 법령 해설이 아니라 '지금 무엇을 해야 하는지' 알려주는 행동 가이드로 답변해주세요."""

    response = client_solar.chat.completions.create(
        model="solar-pro3",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPTS[persona]},
            {"role": "user", "content": user_prompt}
        ],
        temperature=0.3,
    )
    return response.choices[0].message.content
