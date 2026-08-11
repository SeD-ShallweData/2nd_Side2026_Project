import os
import re
from pathlib import Path

from dotenv import load_dotenv
from sentence_transformers import SentenceTransformer
import chromadb
from openai import OpenAI

# =========================================================
# 설정값
# =========================================================
# 벡터DB 경로는 환경마다 다르므로 코드에 박지 않는다. 아래 DB_PATH 블록 참고.
# 기본값은 두 단계로 찾는다.
#   1) 저장소에 같이 들어있는 data/labor_law_db  (클론만 하면 바로 돌아간다)
#   2) 없으면 개발 서버의 공용 경로
# 둘 다 DONWORRY_DB_PATH 환경변수로 덮어쓸 수 있다.
_BUNDLED_DB = Path(__file__).resolve().parent / "data" / "labor_law_db"
_SHARED_DB = Path("/data/shared-SeD/hb/persona_test/labor_law_db")
DEFAULT_DB_PATH = str(_BUNDLED_DB if _BUNDLED_DB.is_dir() else _SHARED_DB)
DEFAULT_COLLECTION = "labor_law"


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

# 벡터DB 경로도 API 키와 같은 방식으로 환경에서 읽는다.
# 우선순위: 환경변수 DONWORRY_DB_PATH > .env의 DONWORRY_DB_PATH > DEFAULT_DB_PATH
# 로컬에서 돌릴 때는 .env에 아래 한 줄만 넣으면 된다.
#   DONWORRY_DB_PATH=/your/path/labor_law_db
DB_PATH = (os.environ.get("DONWORRY_DB_PATH") or "").strip() or DEFAULT_DB_PATH
COLLECTION_NAME = (os.environ.get("DONWORRY_COLLECTION") or "").strip() or DEFAULT_COLLECTION

if not Path(DB_PATH).is_dir():
    raise RuntimeError(
        f"벡터DB 경로를 찾을 수 없습니다: {DB_PATH}\n"
        f"  - 확인한 .env 파일: {ENV_FILE or '(없음)'}\n"
        "  - 해결: .env(또는 api_key.env)에 DONWORRY_DB_PATH=/your/path/labor_law_db 를 넣거나,\n"
        "          환경변수 DONWORRY_DB_PATH를 설정하세요."
    )

# =========================================================
# 임베딩 모델 + 벡터DB 로드 (프로세스당 한 번만)
# =========================================================
print("임베딩 모델 로딩 중...")
embed_model = SentenceTransformer('BAAI/bge-m3', device='cpu')

client_db = chromadb.PersistentClient(path=DB_PATH)
collection = client_db.get_collection(COLLECTION_NAME)
print(f"DB 연결 완료({DB_PATH}). 저장된 조문 수: {collection.count()}\n")

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
   사용자가 이번 질문에서 실제로 말한 상황만 짚어 짧게 인정합니다.

   ★ 다음 정형구로 문장을 시작하면 안 됩니다. 사무적으로 읽혀서 상대를 더 위축시킵니다.
     "~상황을 이해합니다" / "~상황을 확인했습니다" / "~상황으로 보입니다" /
     "~라는 말씀이시군요" / "~에 대해 문의하셨습니다" / "~에 해당합니다"
     민원 접수 확인 문장이 아니라, 사람이 건네는 첫마디로 쓰세요.

   위로할 상황인지 아닌지는 매 요청마다 [이번 답변 지시]로 따로 알려줍니다.
   그 지시를 그대로 따르세요.

   위로하라는 지시를 받았다면, 이렇게 씁니다.
   ① 사용자가 이번 질문에서 쓴 말 중 가장 곤란했을 지점 하나를 고릅니다.
      (예: 통보가 갑작스러웠던 점 / 밀린 기간이 길다는 점 / 회사가 아무 조치도
       안 했다는 점 / 당장 생계가 걸린 점 — 상황마다 다릅니다)
   ② 그 지점 하나만 짚어 한 문장으로 말합니다. 상황이 다르면 문장도 달라야 합니다.
      매번 같은 문장을 돌려쓰면 안 됩니다. 특히 아래 표현은 이미 남용되었으니 쓰지 마세요.
      "혼자 감당하실 일은 아니에요" / "차근차근 정리해 보겠습니다" /
      "하나씩 정리해 보겠습니다" / "많이 당황스러우셨을 것 같습니다"
   ③ 최대 2문장입니다. 길어지면 정작 필요한 안내가 묻힙니다.

   지키세요.
   - 사용자가 말하지 않은 사실(기간·금액·통보 방식·피해)을 지어내서 공감하면 절대 안 됩니다.
     "3년이나 일하셨는데" 같은 말은 사용자가 직접 그렇게 말했을 때만 쓸 수 있습니다.
   - "정말 안타깝습니다", "얼마나 힘드셨을지 상상도 되지 않습니다" 같은
     과장된 감정 표현이나 사과는 쓰지 마세요. 오히려 가볍게 들립니다.

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
- [직전 대화]는 맥락 참고용이지 이번 질문의 사실관계가 아닙니다. 사용자가 이번 질문에서 말하지 않은 사실(통보 방식, 근속기간, 금액, 업종 등)을 직전 대화에서 가져와 이번 답변의 전제로 삼지 마세요. 이번 질문이 앞과 다른 상황을 말하고 있다면, 앞 답변은 잊고 이번 질문 문장만 보고 답하세요.
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
4. 첫 문단에서 불안한 마음을 짧게 인정해 주세요. "~상황을 이해합니다" 같은
   사무적인 확인 문장 말고, 걱정되는 게 당연하다고 말해주는 문장으로 시작하세요.
5. 핵심 문단은 '입사 전에 무엇을 어떻게 확인하면 되는지'를 순서대로 알려주는 내용으로 채우세요.""" + FORMAT_RULES,

    "근로자": """당신은 '돈워리' 서비스의 챗봇입니다. 지금 대화 상대는 현재 재직 중이거나 퇴직 직후인 '근로자'로, 실제로 문제(임금체불, 부당대우 등)를 겪고 있을 수 있습니다.

반드시 지켜야 할 규칙:
1. 아래 [참고 조항]에 실제로 나온 내용만 근거로 답변하세요. 참고 조항이 질문 주제를 직접 다루고 있지 않다면, 아는 지식으로 채우지 말고 "확인이 어렵다"고 답하세요.
2. 사용자가 겪는 개별 상황이 '위법이다/합법이다'라고 단정하지 마세요. 법이 정한 요건을 알려주고 최종 판단은 전문가·관할 기관에 맡기세요. 이 규칙이 가장 중요합니다.
3. 힘든 일을 겪고 물어보는 사람입니다. 첫 문단은 법이 아니라 사람으로 시작하세요.
   그 상황에서 어떤 마음이었을지를 먼저 짚어주고, 그다음에 법 이야기로 넘어가세요.
   접수 확인하듯 상황을 요약해서 되돌려주는 문장으로 시작하면 안 됩니다.
   다만 감정을 증폭시키거나 회사를 대신 비난하지는 마세요.
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


def user_turns(history):
    """히스토리에서 사용자 발화만 순서대로 뽑는다."""
    return [(m.get("text") or "").strip()
            for m in (history or []) if m.get("role") == "user" and (m.get("text") or "").strip()]


def ask_donworry_auto(question, n_results=5, history=None):
    # 페르소나는 대화의 첫 질문으로 한 번만 정하고 그대로 유지한다.
    # 매 턴 다시 분류하면 "어떤 준비를 하는게 좋을까요?" 같은 짧은 후속 질문이
    # 엉뚱하게 분류돼(예: 구직자) 상담 맥락이 중간에 뒤집힌다.
    turns = user_turns(history)
    basis = turns[0] if turns else question
    persona = classify_persona(basis)
    if turns:
        print(f"[페르소나 유지] {persona} (첫 질문 기준: {basis!r})")
    else:
        print(f"[분류된 페르소나] {persona} ← {question!r}")
    return ask_donworry(question, persona, n_results=n_results, history=history)


CITATION_IN_ANSWER_RE = re.compile(r"[가-힣]{2,20}법(?:\s*시행령)?\s*제\d+조(?:의\d+)?")


def digest_bot_turn(text, max_chars=140):
    """챗봇의 지난 답변을 한 줄로 줄인다.

    답변 전문을 히스토리에 넣으면 다음 턴에서 모델이 그것을 그대로 베껴 쓴다.
    실측: "해고 통보를 문자로만 받았는데 효력이 있나요?" 다음에 "사장이 담주까지만
    나오래"를 물었더니, 검색은 제26조(해고의 예고)를 새로 찾았는데도 답변은 앞선
    '문자 통보' 답변과 8문장이 글자까지 같았다. 프롬프트로 "베끼지 마라"라고
    지시해도 소용없었다. 베낄 원본을 아예 주지 않는 쪽이 확실하다.

    다음 턴에 필요한 정보는 '무엇을 이미 다뤘는가'뿐이므로 근거 조문과
    핵심 문장 하나만 남긴다.
    """
    flat = " ".join((text or "").split())
    if not flat:
        return ""

    sentences = [s for s in re.split(r"(?<=[.!?])\s+", flat) if s]
    # 첫 문장은 공감 문장이라 내용이 없다. 조문을 언급한 첫 문장을 우선 고른다.
    core = next((s for s in sentences if CITATION_IN_ANSWER_RE.search(s)),
                sentences[0] if sentences else flat)
    if len(core) > max_chars:
        core = core[:max_chars] + "…"

    cites = []
    for c in CITATION_IN_ANSWER_RE.findall(flat):
        c = " ".join(c.split())
        if c not in cites:
            cites.append(c)
    if cites:
        return f"{core} [이 턴에서 안내한 근거: {', '.join(cites[:6])}]"
    return core


def cited_articles_in_history(history):
    """직전 답변에서 이미 근거로 든 조문 집합. '법령명제N조' 형태로 정규화한다."""
    seen = set()
    for m in history or []:
        if m.get("role") == "user":
            continue
        for c in CITATION_IN_ANSWER_RE.findall(m.get("text") or ""):
            seen.add(c.replace(" ", ""))
    return seen


# =========================================================
# 위로 문단을 켤지 끌지
# =========================================================
# 프롬프트에 "정보 질문에는 위로하지 마세요"라고 써두어도 모델은 예시로 준 위로
# 문장을 습관처럼 붙인다. 실제로 "육아휴직은 얼마나 쓸수있나요"에 "갑작스러운
# 통보에 많이 당황하셨을 것 같습니다"라는, 질문에 있지도 않은 상황을 지어낸
# 위로가 나왔다. 판단을 모델에게 맡기지 않고 코드에서 끊는다.
#
# 두 조건을 모두 만족해야 위로한다.
#   (1) 곤란한 일을 가리키는 말이 있는가
#   (2) 그 일이 '나에게 일어났다'는 서술인가
# (2)를 함께 보는 이유: "해고하려면 며칠 전에 알려줘야 하나요?"는 해고를 말하지만
# 겪은 사람의 질문이 아니라 제도를 묻는 질문이라 위로하면 어색하다.
DISTRESS_MARKERS = [
    "밀렸", "안 줘", "안줘", "안 줍", "안줍", "못 받", "못받", "떼먹", "체불",
    "해고", "짤렸", "잘렸", "그만두라", "나오지 말", "나오지말", "나오래", "나가라",
    "괴롭힘", "폭언", "욕설", "성희롱", "따돌림", "강요", "협박",
    "억울", "막막", "힘들", "속상", "불안", "당했", "당하고", "겪었", "겪고",
]

EXPERIENCE_MARKERS = [
    "제가", "저는", "저희", "내가", "나는", "우리 회사",
    "사장", "회사가", "회사에서", "대표가", "팀장", "상사",
    "받았", "당했", "겪었", "겪고", "했어요", "했는데", "됐어요", "됐는데",
    "밀렸", "안 줘", "안줘", "못 받", "못받", "래요", "말래", "나오래",
    "시켰", "라고 해", "라고 했",
]


def needs_empathy(question):
    """이번 질문이 '겪은 일'을 말하고 있는지. 애매하면 위로하지 않는다."""
    return (any(k in question for k in DISTRESS_MARKERS)
            and any(k in question for k in EXPERIENCE_MARKERS))


# 직전 답변이 틀렸다고 사용자가 지적하는 말. 앞 대화가 있을 때만 본다.
# ("그게 아니라" 같은 말은 첫 질문에 나올 수 없다)
# 사용자가 자기 상황을 정정하는 말("밀린 게 아니라 아예 못 받았어요")까지
# 사과로 받으면 어색하므로, 답변·이해를 직접 겨냥한 표현만 넣는다.
CORRECTION_MARKERS = [
    "그게 아니라", "그게아니라", "그거 말고", "그거말고", "그건 아니고",
    "그건 위에", "위에 얘기", "위에 질문", "다른 얘기", "다른 질문",
    "제가 물은", "제가 물어본", "내가 물어본", "제 질문은", "내 질문은",
    "잘못 이해", "잘못이해", "잘못 알", "잘못 답", "잘못됐", "잘못 됐",
    "엉뚱", "동문서답", "이해를 못", "못 알아", "알아듣", "말귀",
    "다시 답변", "다시 알려", "다시 안내",
    "그 얘기 아니", "그런 뜻이 아니", "그런 뜻 아니", "틀렸", "틀린 답",
]


def is_correction(question, history):
    """사용자가 직전 답변을 잘못됐다고 지적하는 턴인지."""
    if not user_turns(history):
        return False
    return any(k in question for k in CORRECTION_MARKERS)


def format_history(history, max_turns=6):
    """직전 대화를 프롬프트에 넣을 텍스트로 변환. 검색·게이트에는 쓰지 않는다.

    사용자 발화는 그대로 두되(후속 질문 해석에 필요) 챗봇 답변은 요약해서 넣는다.
    """
    if not history:
        return ""
    lines = []
    for m in history[-max_turns:]:
        text = " ".join((m.get("text") or "").split())
        if m.get("role") == "user":
            if len(text) > 400:
                text = text[:400] + "…"
            lines.append(f"사용자: {text}")
        else:
            digest = digest_bot_turn(text)
            if digest:
                lines.append(f"챗봇(요약): {digest}")
    return "\n".join(lines)


# 특수한 대상·상황에만 적용되는 조항 - 질문이 그 맥락을 직접 언급하지 않는 한
# 우선순위를 낮춘다. 조문 제목뿐 아니라 장·절 이름(chapter)도 함께 본다.
#
# 고용보험법은 자영업자·예술인·노무제공자 특례가 별도 장·절로 17개 조문이나 있어서,
# 일반 근로자의 실업급여 질문에 이들이 계속 끼어들었다. 실제로 "실업급여 받으려면?"
# 질문에 노무제공자 기준(24개월 중 12개월)이 답변에 섞여 나오는 오답이 있었다.
NARROW_RULES = [
    {
        "article_keywords": ["도급", "하도급", "수급인", "건설업", "건설산업"],
        "trigger_keywords": ["도급", "하도급", "수급", "건설", "하청", "원청"],
    },
    {
        "article_keywords": ["자영업자"],
        "trigger_keywords": ["자영업", "사업자", "개인사업", "폐업", "가게", "장사"],
    },
    {
        "article_keywords": ["예술인"],
        "trigger_keywords": ["예술인", "예술", "공연", "creator"],
    },
    {
        "article_keywords": ["노무제공자", "노무제공플랫폼"],
        "trigger_keywords": ["노무제공", "플랫폼", "배달", "대리운전", "프리랜서", "특수고용"],
    },
]


def _is_narrow_article(title, chapter=""):
    """이 조문이 '특수 맥락 전용'인지. 조문 제목과 장·절 이름을 함께 본다."""
    text = f"{title} {chapter}"
    return any(any(k in text for k in rule["article_keywords"]) for rule in NARROW_RULES)


def _narrow_allowed(question):
    """질문이 특수 맥락을 직접 언급했는지."""
    return any(any(k in question for k in rule["trigger_keywords"]) for rule in NARROW_RULES)


# 사용자가 쓰는 말과 법령 용어가 다르면 임베딩이 조문을 못 찾는다.
# 대표적으로 사용자는 "실업급여"라고 하지만 고용보험법 본문은 "구직급여"라고 쓴다
# (142개 조문 중 '실업급여'라는 단어를 쓰는 건 제37조 정도뿐이다).
# 그 결과 "실업급여 며칠 받나요?" 같은 질문이 제50조가 아니라 제44조(실업의 인정)로 갔다.
# 검색 질의에만 법령 용어를 덧붙이고, 답변 프롬프트에는 원문 질문을 그대로 쓴다.
# 확장은 '용어가 실제로 다른' 경우에만 둔다. 이미 법령 본문에 그대로 나오는 말
# (퇴직금·육아휴직 등)까지 확장했더니 오히려 다른 법의 정답률이 떨어졌다.
#
# 용어 차이만이 아니라 '말투' 때문에도 같은 일이 생긴다. 조문은 "해고"라고만 쓰는데
# 사용자는 "사장님이 다음주까지만 나오래요"라고 쓴다. 실측 거리 0.493으로 게이트
# (0.42)에 막혔고, "해고"라는 단어만 넣으면 0.373으로 통과했다. 순위는 대체로
# 맞는데(제26조가 top-5 안) 거리만 멀어서 잘리는 형태라 확장으로 메울 수 있다.
#
# exclude는 트리거가 엉뚱한 질문까지 끌어당기는 걸 막는다. "일찍 나오라고 하세요"는
# 출근 시각 문제지 해고가 아니다.
QUERY_EXPANSION_RULES = [
    {
        "name": "실업급여",
        "triggers": ["실업급여", "실업 급여"],
        "exclude": [],
        "expansion": "구직급여 수급 요건 소정급여일수",
    },
    {
        "name": "해고(구어체)",
        # 한글은 음절 단위로 비교되므로 '나오지마'는 '나오지말래요'에 걸리지 않는다
        # (마 ≠ 말). 어미 변화형을 각각 다 적어야 한다.
        "triggers": ["나오지 마", "나오지마", "나오지 말", "나오지말",
                     "나오래", "나오라고", "나오라는",
                     "그만두라", "그만 나오", "그만나오", "관두라",
                     "나가라", "나가래", "짤렸", "잘렸", "짤린", "잘린"],
        "exclude": ["일찍", "늦게", "몇 시", "일찍이"],
        "expansion": "해고 통보 해고의 예고 서면통지",
    },
    {
        # 조문 제목은 '연차 유급휴가'인데 사용자는 '연차'까지만 쓴다. "연차는 몇 개나
        # 생기나요?"가 0.503으로 막혔다. '일수'·'며칠' 같은 말까지 붙이면 수치가 적힌
        # 다른 조문으로 쏠려서, 조문 제목에 있는 말만 최소한으로 덧붙인다.
        "name": "연차",
        "triggers": ["연차"],
        "exclude": [],
        "expansion": "연차 유급휴가",
    },
]


def expand_query(question):
    """검색용 질의에 법령 용어를 덧붙인다. 해당 없으면 원문 그대로."""
    extra = []
    for rule in QUERY_EXPANSION_RULES:
        if any(k in question for k in rule["exclude"]):
            continue
        if any(k in question for k in rule["triggers"]):
            extra.append(rule["expansion"])
    return question + " " + " ".join(extra) if extra else question


def retrieve_context(question, n_results=3, candidate_pool=20):
    # 후보 풀은 n_results보다 넉넉해야 한다. 특례 조항을 걸러낸 뒤에도 채울 게
    # 남아 있어야 하기 때문이다. 12로는 부족해서 걸러낸 조항이 도로 채워지곤 했다.
    q_emb = embed_model.encode([expand_query(question)], normalize_embeddings=True)
    results = collection.query(query_embeddings=q_emb.tolist(), n_results=candidate_pool)

    candidates = list(zip(
        results["documents"][0],
        results["metadatas"][0],
        results["distances"][0],
    ))

    # 필터링 전, 가장 가까운 원본 검색 결과와의 거리 - "DB에 애초에 관련 내용이
    # 있는지"를 판단하는 기준이 된다 (narrow-article 필터로 밀려나기 전 값).
    raw_top1_distance = candidates[0][2] if candidates else None

    narrow_ok = _narrow_allowed(question)

    def pick(allow_narrow):
        seen = set()
        picked = []
        for doc, meta, dist in candidates:
            aid = meta["article_id"]
            if aid in seen:
                continue
            if not allow_narrow and _is_narrow_article(meta["title"], meta.get("chapter", "")):
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


# raw top-1 distance가 이 값보다 크면 DB에 그 주제를 다루는 조항이 사실상 없다고
# 보고, 모델 호출 없이 바로 "확인이 어렵다"로 응답한다.
#
# 이력
#   0.47 - 근로기준법 143개 조문만 있던 시절, 페르소나 예상 질문 36개로 잡은 값.
#   0.42 - 법령 5개로 늘어난 뒤 eval/ 질문셋(positive 61 / negative 18)의 거리 분포로
#          재산출. 0.47에서는 범위 밖 질문 18개 중 9개가 게이트를 통과해 엉뚱한 조항으로
#          답변이 생성됐다. rebuild_db.py로 데이터를 다시 쌓은 뒤(370 chunk) 재측정해도
#          0.42가 그대로 최적이었다. 이 값에서 정상 질문 59/61 통과, 범위 밖 16/18 차단.
#          재튜닝: eval/run_eval.py → eval/tune_threshold.py
#
# 한계: positive와 negative의 거리 분포가 0.353~0.545 구간에서 겹친다. 거리 하나로는
# 완전히 가를 수 없고, 특히 "회사가 망했는데 밀린 월급을 나라에서 대신 받을 수
# 있나요?"(임금채권보장법 제7조, 거리 0.459)처럼 조문은 정확히 찾았는데 거리가 멀어
# 막히는 질문이 있다. 게이트 신호를 거리 단독이 아닌 다른 지표로 바꾸는 게 다음 과제.
NO_MATCH_DISTANCE_THRESHOLD = 0.42

NO_MATCH_MESSAGES = {
    "구직자": "이 질문은 지금 참고할 수 있는 조항 범위 밖이라 정확히 확인해드리기 어려워요. 회사나 채용 담당자에게 직접 확인해보시는 걸 추천드려요.",
    "근로자": "이 질문은 지금 참고할 수 있는 조항 범위 밖이라 정확히 확인해드리기 어려워요. 고용노동부 **1350** 상담센터에 문의해보시는 게 가장 정확해요.",
    "사업주": "이 질문은 지금 참고할 수 있는 조항 범위 밖이라 정확히 확인해드리기 어려워요. 고용노동부 **1350** 상담센터나 노무사 상담을 통해 확인해보세요.",
}

# 대화 도중 막힌 경우. 첫 질문용 문구("회사나 채용 담당자에게 확인해보세요" 등)를
# 그대로 쓰면 이미 상담 중인 맥락과 어긋나므로 따로 둔다.
NO_MATCH_FOLLOWUP = (
    "그 부분은 지금 참고할 수 있는 법령 범위를 벗어나서 정확히 안내해드리기 어려워요. "
    "고용노동부 **1350** 상담센터에서 확인해보시는 게 가장 정확합니다."
)

# 후속 질문이라 판단해 직전 조항을 물려받을 때, 몇 턴까지 거슬러 올라갈지.
FOLLOWUP_LOOKBACK_TURNS = 3

# =========================================================
# 범위 밖 주제 차단
# =========================================================
# DB에 없는 주제인데도 '의미상 가까운' 조문이 잡혀 게이트를 통과하면, 모델이
# 엉뚱한 조문에 자기 지식을 섞어 오답을 만든다. 실제로 "육아휴직은 얼마나 쓸 수
# 있나요?"가 거리 0.346으로 통과해 육아휴직을 출산전후휴가와 뒤섞고 DB에 없는
# 법률까지 인용했다. 거리만으로는 못 거르므로 주제 자체를 먼저 걸러낸다.
#
# 해당 법령을 DB에 넣으면 이 목록에서 빼면 된다.
OUT_OF_SCOPE_TOPICS = [
    {
        "name": "산업재해·산업안전",
        # 근로기준법 제78~84조의 '재해보상'은 답할 수 있으므로 좁은 키워드만 쓴다.
        "keywords": ["산재보험", "산업재해보상", "근로복지공단", "산업안전보건", "중대재해", "산재 신청", "산재신청"],
        "law": "「산업재해보상보험법」·「산업안전보건법」",
        "where": "근로복지공단 **1588-0075**",
    },
    {
        "name": "4대보험",
        "keywords": ["4대보험", "사대보험", "국민연금", "건강보험", "장기요양보험"],
        "law": "각 보험 관계 법령",
        "where": "국민연금공단·건강보험공단",
    },
    {
        "name": "노동조합",
        # 근로기준법 제96조(단체협약의 준수)가 있어 '단체협약' 단독은 넣지 않는다.
        "keywords": ["노동조합", "노조 설립", "노조를", "단체교섭", "쟁의행위", "파업"],
        "law": "「노동조합 및 노동관계조정법」",
        "where": "고용노동부 **1350**",
    },
    {
        "name": "파견·기간제",
        "keywords": ["파견근로", "파견직", "파견업체", "기간제", "정규직 전환"],
        "law": "「파견근로자 보호 등에 관한 법률」·「기간제 및 단시간근로자 보호 등에 관한 법률」",
        "where": "고용노동부 **1350**",
    },
]

# 이 거리보다 가까우면 DB에 확실히 관련 조문이 있다고 보고 차단하지 않는다.
# (예: "육아휴직 후 연차는 어떻게 되나요?"는 근로기준법 제60조로 답할 수 있다)
STRONG_MATCH_DISTANCE = 0.30


def find_out_of_scope(question, distance):
    """질문이 다루지 않는 주제면 해당 항목을 돌려준다. 아니면 None."""
    if distance is not None and distance <= STRONG_MATCH_DISTANCE:
        return None  # 확실히 답할 수 있는 조문이 잡힌 경우는 그대로 진행
    for topic in OUT_OF_SCOPE_TOPICS:
        if any(k in question for k in topic["keywords"]):
            return topic
    return None


def out_of_scope_message(topic):
    return (
        f"{topic['name']}은(는) {topic['law']} 소관이라 지금 참고할 수 있는 법령 범위 밖입니다. "
        f"정확한 내용은 {topic['where']}에서 확인해보세요.\n\n"
        "임금 체불, 근로계약, 해고, 연차, 최저임금, 퇴직금에 대해서는 법령을 근거로 안내해드릴 수 있습니다."
    )


def format_citation(meta):
    """근거 표기용 문자열: '근로기준법 제2조제1항제6호' 형태."""
    clause = meta.get("clause") or ""
    return f"{meta.get('law', '')} {meta['article_id']}{clause}".strip()


def retrieve_from_previous_turn(history, n_results):
    """후속 질문을 위해, 직전에 '근거를 찾았던' 사용자 질문의 조항을 되살린다.

    "어떤 준비를 하는게 좋을까요?" 같은 문맥 의존 질문은 그 자체로는 어떤 조문과도
    맞지 않는다(실측 거리 0.536). 이전 질문과 이어붙여 검색해도 노이즈만 늘 뿐이라
    (0.437, 여전히 차단) 아예 새로 찾지 않고 직전 턴의 조항을 그대로 물려받는다.

    반환: (picked, 근거가 된 질문) 또는 None
    """
    for prev in reversed(user_turns(history)[-FOLLOWUP_LOOKBACK_TURNS:]):
        picked, dist = retrieve_context(prev, n_results=n_results)
        if dist is not None and dist <= NO_MATCH_DISTANCE_THRESHOLD:
            return picked, prev
    return None


def ask_donworry(question, persona, n_results=5, history=None):
    if persona not in SYSTEM_PROMPTS:
        persona = DEFAULT_PERSONA

    # 검색과 게이트 판정은 '이번 사용자 질문'만으로 한다. 히스토리를 섞으면
    # 질문과 무관한 이전 대화 때문에 거리가 흐려져 게이트가 오작동한다.
    # 히스토리는 생성 프롬프트에만 참고용으로 들어간다.
    picked, raw_top1_distance = retrieve_context(question, n_results=n_results)
    carried_from = None

    # 거리로는 통과하더라도 애초에 다루지 않는 주제면 여기서 끊는다.
    topic = find_out_of_scope(question, raw_top1_distance)
    if topic:
        print(f"[범위 밖 주제 - {topic['name']}] top1_distance={raw_top1_distance:.3f} ← {question!r}")
        return out_of_scope_message(topic)

    if raw_top1_distance is None or raw_top1_distance > NO_MATCH_DISTANCE_THRESHOLD:
        # 이번 질문만으로는 근거를 못 찾았다. 대화 중이라면 후속 질문일 수 있으므로
        # 직전 조항을 물려받아 이어서 답한다. 이번 질문과 무관한 조항이면
        # 시스템 프롬프트의 "근거 없으면 확인이 어렵다고 밝혀라" 규칙이 받아낸다.
        fallback = retrieve_from_previous_turn(history, n_results)
        if fallback is None:
            print(f"[검색 실패 - 모델 호출 생략] top1_distance={raw_top1_distance} ← {question!r}")
            if user_turns(history):
                return NO_MATCH_FOLLOWUP
            return NO_MATCH_MESSAGES.get(persona, NO_MATCH_MESSAGES[DEFAULT_PERSONA])
        picked, carried_from = fallback
        print(f"[후속 질문 - 직전 조항 인계] this={raw_top1_distance:.3f} "
              f"기준 질문={carried_from!r} ← {question!r}")

    # 조항을 1개로 좁히지 않고 top-k를 그대로 컨텍스트로 넘긴다.
    # (정답이 1위가 아닌 경우가 잦아 선택 단계에서 오답이 발생했었다.)
    print(f"[참고 조항 {len(picked)}개] " + " | ".join(
        f"{format_citation(m)}({m['title']}) {d:.3f}" for _, m, d in picked
    ) + f" ← {question!r}")

    # 직전 답변에서 이미 근거로 든 조문에는 표시를 붙인다. 표시가 없으면 모델이
    # 이미 설명한 조문을 처음부터 다시 설명하느라, 이번 질문 때문에 새로 검색된
    # 조문이 뒤로 밀린다. 실제로 "사장이 담주까지만 나오래"에서 1위로 잡힌
    # 제26조(해고의 예고)가, 직전 턴에서 다룬 제27조 재설명에 밀려 넷째 문단으로
    # 내려갔다.
    already_cited = cited_articles_in_history(history)
    context_parts = []
    for doc, meta, _dist in picked:
        key = f"{meta.get('law', '')}{meta['article_id']}".replace(" ", "")
        mark = "  ※ 직전 답변에서 이미 안내한 조문" if key in already_cited else ""
        context_parts.append(f"[{format_citation(meta)}({meta['title']})]{mark}\n{doc}")
    context_text = "\n\n".join(context_parts)
    has_repeat = any("이미 안내한 조문" in p for p in context_parts)

    history_text = format_history(history)
    history_block = f"""[직전 대화]
{history_text}

""" if history_text else ""

    # 조항을 직전 턴에서 물려받은 경우, 그 사실을 모델에게 알려 준다.
    # 이번 질문이 그 주제에서 벗어났다면 억지로 답하지 말고 물러서야 하기 때문이다.
    carried_note = f"""
※ 위 참고 조항은 이번 질문이 아니라 앞선 질문("{carried_from}")을 근거로 찾은 것입니다.
이번 질문이 그 주제의 후속 질문이라면 위 조항으로 이어서 답변하세요.
반대로 이번 질문이 위 조항과 다른 주제라면, 답을 지어내지 말고
"제공된 법령 범위에서는 확인이 어렵다"고 밝힌 뒤 관할 창구만 안내하세요.
""" if carried_from else ""

    # 반대 경우. 이번 질문이 자체 근거를 찾았는데도 [직전 대화]가 남아 있으면,
    # 모델이 앞 답변을 거의 그대로 재생하면서 이번 질문에 없던 사실까지 전제로
    # 끌어온다. 실제로 "해고 통보를 문자로만 받았는데 효력이 있나요?" 다음에
    # "사장이 담주까지만 나오래"를 물었을 때, 새로 찾은 조항은 제26조(해고의 예고)
    # 였는데도 답변은 앞선 '문자 통보' 답변의 복사본이었다.
    fresh_note = """
※ 위 참고 조항은 이번 질문만으로 새로 찾은 것입니다. [직전 대화]는 배경 참고용일 뿐,
이번 질문의 사실관계가 아닙니다. 이번 질문 문장에 나오지 않은 사실(통보 방식, 근속기간,
금액, 업종 등)을 직전 대화에서 끌어와 이번 답변의 전제로 삼지 마세요.
앞 답변의 문장을 다시 쓰지 말고, 이번 질문이 묻는 것에 대해 위 조항으로 새로 답하세요.
""" if history_block and not carried_from else ""

    repeat_note = """
※ "이미 안내한 조문" 표시가 붙은 것은 직전 답변에서 설명을 마친 내용입니다.
그 조문의 설명을 처음부터 되풀이하지 말고, 표시가 없는 조문 가운데 이번 질문과
관련된 것을 앞세워 답하세요. 이미 안내한 조문을 꼭 언급해야 한다면
"앞서 말씀드린 대로" 정도로 짧게 지나가세요.
""" if has_repeat else ""

    # 위로 여부는 모델 판단에 맡기지 않는다(needs_empathy 주석 참고).
    # 사업주 페르소나는 위로 문단을 쓰지 않기로 되어 있어 질문 내용과 무관하게 끈다.
    if is_correction(question, history):
        # 앞 답변이 빗나갔다고 사용자가 지적한 경우. 위로보다 사과가 먼저다.
        print(f"[답변 정정 요청] ← {question!r}")
        empathy_note = """
※ 사용자가 직전 답변이 질문과 맞지 않는다고 지적하고 있습니다.
첫 문장은 짧은 사과로 시작하세요. 예: "제가 질문을 잘못 이해했네요. 죄송합니다."
"혼선을 드려 죄송합니다. 다시 안내드릴게요." 정도의 한 문장이면 충분합니다.
왜 그렇게 답했는지 변명하거나 앞 답변을 정당화하지 말고, 사과 다음에는 곧바로
사용자가 실제로 묻는 것에 답하세요. 이 경우 위로·공감 문단은 쓰지 않습니다.
사용자가 무엇을 물었는지 여전히 불분명하다면, 짐작해서 답하지 말고
어떤 부분을 알고 싶은지 한 가지만 되물으세요.
"""
    elif persona != "사업주" and needs_empathy(question):
        empathy_note = """
※ 이번 질문에서 사용자는 자신이 겪은 일을 말했습니다. 첫 문단에 위로를 쓰세요.
단, 사용자가 이번 질문에서 실제로 쓴 말에서 가장 곤란했을 지점 하나만 골라
그 상황에 맞는 문장으로 쓰세요. 다른 질문에도 쓸 수 있는 일반적인 위로 문장이면
잘못 쓴 것입니다. 질문에 없는 사실은 절대 끌어오지 마세요.
"""
    else:
        empathy_note = """
※ 이번 질문은 겪은 일을 말한 것이 아니라 제도·기준·기간을 묻는 정보 질문입니다.
위로·공감 문장을 쓰지 말고 첫 문장부터 곧바로 질문에 답하세요.
"당황하셨을 것 같습니다", "힘드셨겠어요"처럼 겪지도 않은 일을 가정한 위로는
질문을 오해한 답변이 됩니다.
"""

    user_prompt = f"""[참고 조항]
{context_text}
{carried_note}{fresh_note}{repeat_note}
[이번 답변 지시]{empathy_note}
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
