import type { CompanyRepository } from "@/domain/company";
import type {
  ChatProvider,
  ChatRequest,
  ChatResponse,
  SuggestedAction,
} from "@/domain/chat";
import type { RiskProvider, SourceReference } from "@/domain/risk";
import { CHAT_COPY } from "@/mocks/chatResponses";
import { ServiceError } from "@/utils/errors";
import { containsAny, normalizeSearchText } from "@/utils/text";

const SEARCH_ACTION: SuggestedAction = {
  code: "SEARCH_COMPANY",
  label: "사업장 검색하기",
  description: "주소와 업종을 확인해 정확한 사업장을 선택하세요.",
  priority: "now",
};

const CALL_1350: SuggestedAction = {
  code: "CALL_1350",
  label: "고용노동부 1350 확인",
  description: "개별 상황의 정확한 기준과 절차를 공식 창구에서 확인하세요.",
  priority: "next",
};

const WAGE_GUIDE_SOURCE: SourceReference = {
  name: "임금체불 진정 및 상담 안내",
  organization: "고용노동부",
  document_id: "MOEL_WAGE_GUIDE",
};

const SAFETY_GUIDE_SOURCE: SourceReference = {
  name: "산업재해보상보험 안내",
  organization: "근로복지공단",
  document_id: "COMWEL_ACCIDENT_GUIDE",
};

function conversationId(value?: string): string {
  return value || `conv_${crypto.randomUUID()}`;
}

/**
 * 회사를 선택하지 않은 상태에서 들어오는 노동 주제.
 *
 * 예전에는 임금과 산재 두 갈래만 알아봤습니다. 그래서 주휴수당·연차·해고·근로계약서
 * 같은 흔한 질문이 전부 "조금 더 구체적으로 알려주세요"로 떨어졌고, RAG가 법령을
 * 제대로 찾아왔더라도 그 근거가 통째로 버려졌습니다. 실사용에 가까운 질문 20건을
 * 태워보니 11건이 여기에 걸렸습니다.
 *
 * 정책 baseline 은 질문에 답하는 층이 아닙니다. 답은 검색된 법령과 모델이 만듭니다.
 * 이 표는 "무엇을 확인하고 어디에 물어야 하는지"라는 골격만 제공하고, 되묻기로
 * 빠지지 않게 하는 역할을 합니다.
 *
 * 주제를 추가할 때는 위에서부터 먼저 맞는 것이 이깁니다. 좁은 표현을 위에 둡니다.
 */
interface LaborTopic {
  code: string;
  keywords: string[];
  answer: string;
  sources: SourceReference[];
  actions: SuggestedAction[];
  limitation: string;
}

const LABOR_TOPICS: LaborTopic[] = [
  {
    code: "WAGE",
    // "못 받", "안 줘" 같은 일반 표현은 넣지 않는다. "근로계약서를 아직 못 받았어요"
    // 처럼 다른 주제의 질문까지 임금으로 끌어와 버린다.
    keywords: [
      "임금", "월급", "급여", "체불", "퇴직금", "주휴", "야근수당", "연장수당",
      "초과근무수당", "시간외수당", "가산수당", "최저임금", "임금명세서", "급여명세서",
      "포괄임금", "상여금",
    ],
    answer:
      "임금이 지급되지 않았다면 근로계약서, 급여명세서, 출퇴근 기록, 계좌 내역처럼 근무와 미지급 사실을 확인할 자료를 먼저 정리하세요. 그다음 고용노동부 상담 또는 관할 노동관서의 진정 절차를 확인할 수 있습니다.",
    sources: [WAGE_GUIDE_SOURCE],
    actions: [
      { code: "COLLECT_WAGE_RECORDS", label: "근무·임금 자료 정리", priority: "now" },
      CALL_1350,
    ],
    limitation: "개별 체불 여부와 청구 가능 범위는 공식 상담에서 확인해야 합니다.",
  },
  {
    code: "SAFETY",
    keywords: ["산재", "산업재해", "업무상 재해", "업무상재해", "다쳐서", "재해보상"],
    answer:
      "업무 중 다치거나 질병이 발생했다면 먼저 치료와 안전을 확보하고, 발생 시각·장소·작업 내용·목격자 등 사실관계를 기록해 두세요. 산재 신청에 필요한 구체적인 자료와 절차는 근로복지공단 또는 고용노동부 공식 창구에서 확인하는 것이 좋습니다.",
    sources: [SAFETY_GUIDE_SOURCE],
    actions: [
      { code: "RECORD_ACCIDENT", label: "발생 경위 기록", priority: "now" },
      CALL_1350,
    ],
    limitation: "이 답변은 산재 승인 여부를 판단하지 않습니다.",
  },
  {
    code: "TERMINATION",
    keywords: [
      "해고", "부당해고", "권고사직", "계약해지", "잘렸", "나오지 말라", "나오지말라",
      "그만두라", "짤렸",
    ],
    answer:
      "해고나 계약 종료를 통보받았다면 통보를 받은 날짜와 방법, 회사가 밝힌 사유를 그대로 기록해 두세요. 문자·메일·녹취처럼 통보 사실을 남기는 자료가 이후 절차의 근거가 됩니다. 구제 신청은 기한이 정해져 있으므로 고용노동부 1350이나 관할 노동위원회에서 본인 사안의 기한과 요건을 먼저 확인하세요.",
    sources: [],
    actions: [
      { code: "RECORD_NOTICE", label: "통보 일자·방법·사유 기록", priority: "now" },
      CALL_1350,
    ],
    limitation: "해고의 정당성 여부와 구제 신청 요건은 개별 사안에 따라 달라 공식 창구에서 확인해야 합니다.",
  },
  {
    code: "CONTRACT",
    keywords: ["근로계약서", "계약서", "근로조건", "수습", "채용 공고", "서면 교부", "교부"],
    answer:
      "근로계약 내용이 문제라면 계약서 사본과 실제 근무 조건이 다른 부분을 먼저 정리하세요. 임금 구성, 소정근로시간, 휴게·휴일, 담당 업무처럼 서면에 적혀 있어야 할 항목을 기준으로 비교하면 확인이 쉽습니다. 계약서를 받지 못했다면 회사에 교부를 요청한 사실도 함께 남겨 두세요.",
    sources: [],
    actions: [
      { code: "COMPARE_CONTRACT", label: "계약서와 실제 근무조건 비교", priority: "now" },
      { code: "REVIEW_CONTRACT", label: "근로계약서 검토", priority: "next" },
    ],
    limitation: "계약 조항의 효력은 전체 맥락에 따라 달라져 이 안내만으로 판단할 수 없습니다.",
  },
  {
    code: "LEAVE",
    keywords: [
      "연차", "휴가", "휴게시간", "휴일", "반차", "출산휴가", "출산전후휴가",
      "육아휴직", "병가", "생리휴가",
    ],
    answer:
      "휴가나 휴게 문제는 실제로 어떻게 운영됐는지가 기준이 됩니다. 근무 기간, 소정근로시간, 신청했는데 거부된 기록, 실제로 쉰 날을 정리해 두세요. 부여 일수와 수당 지급 기준은 근무 형태와 사업장 규모에 따라 달라지므로 고용노동부 1350에서 본인 조건으로 확인하는 것이 정확합니다.",
    sources: [],
    actions: [
      { code: "COLLECT_LEAVE_RECORDS", label: "근무·휴가 기록 정리", priority: "now" },
      CALL_1350,
    ],
    limitation: "부여 일수와 수당 기준은 근무 형태·사업장 규모에 따라 달라집니다.",
  },
  {
    code: "WORKTIME",
    keywords: ["52시간", "근로시간", "연장근로", "야간근로", "교대", "장시간", "초과근무", "야근"],
    answer:
      "근로시간 문제는 실제 일한 시간을 남기는 것이 먼저입니다. 출퇴근 기록, 업무 지시 메시지, 근무표처럼 시간이 확인되는 자료를 모아 두세요. 연장·야간 근로의 한도와 수당 기준은 근무 형태와 합의 내용에 따라 달라지므로 고용노동부 1350에서 확인하시는 것이 좋습니다.",
    sources: [],
    actions: [
      { code: "COLLECT_WORKTIME_RECORDS", label: "출퇴근·근무시간 기록 정리", priority: "now" },
      CALL_1350,
    ],
    limitation: "연장·야간 근로의 한도와 수당 기준은 근무 형태와 합의 내용에 따라 달라집니다.",
  },
  {
    code: "HARASSMENT",
    keywords: ["괴롭힘", "갑질", "폭언", "성희롱", "따돌림", "모욕"],
    answer:
      "직장 내 괴롭힘은 발생 일시, 장소, 행위 내용, 목격자를 사실 그대로 기록해 두는 것이 중요합니다. 회사에 신고한 경우 신고 시점과 회사의 조치도 함께 남기세요. 회사 내부 절차로 해결되지 않으면 고용노동부 1350이나 관할 노동관서에 상담할 수 있습니다.",
    sources: [],
    actions: [
      { code: "RECORD_HARASSMENT", label: "일시·내용·목격자 기록", priority: "now" },
      CALL_1350,
    ],
    limitation: "괴롭힘 해당 여부와 회사의 조치 의무는 개별 사안에 따라 판단이 달라집니다.",
  },
  {
    code: "INSURANCE",
    keywords: ["4대보험", "사대보험", "고용보험", "국민연금", "건강보험", "직장가입", "가입을 안"],
    answer:
      "사회보험 가입 문제는 실제 근무 사실과 임금을 확인할 수 있는 자료가 근거가 됩니다. 근로계약서, 급여 입금 내역, 출퇴근 기록을 정리해 두세요. 가입 대상 여부와 소급 신고 절차는 보험별로 담당 기관이 다르므로 국민연금공단·국민건강보험공단·근로복지공단 또는 고용노동부 1350에서 확인해야 합니다.",
    sources: [],
    actions: [
      { code: "COLLECT_EMPLOYMENT_PROOF", label: "근무·임금 증빙 정리", priority: "now" },
      CALL_1350,
    ],
    limitation: "보험별로 가입 요건과 담당 기관이 달라 이 안내만으로 결론을 내릴 수 없습니다.",
  },
];

function matchLaborTopic(message: string): LaborTopic | undefined {
  return LABOR_TOPICS.find((topic) => containsAny(message, topic.keywords));
}

/**
 * 특정 회사를 가리키는 표현. 노동 주제보다 먼저 본다.
 *
 * "이 회사 임금 어때요?"는 임금 안내가 아니라 사업장 선택이 필요한 질문이다.
 * 예전에는 여기에 맨 `사업장`이 들어 있어 "사업장에서 월급을 못 받았어요" 같은
 * 일반 임금 질문까지 선점했다. 지시 표현만 남긴다.
 *
 * `회사가 안전`·`회사는 안전`도 함께 둔다. 조사 하나 차이로 `회사 안전`에서
 * 빗나가 일반 안내로 새던 자리다.
 */
const COMPANY_REFERENCE = [
  "이 회사", "그 회사", "저 회사", "이 사업장", "이 업체", "여기",
  "회사 안전", "회사가 안전", "회사는 안전", "직장이 안전", "왜 추가 확인",
];

/**
 * 회사를 가리키는 것일 수도 있는 약한 표현. 노동 주제가 없을 때만 본다.
 *
 * "입사하려는데 근로계약서를 못 받았어요"는 계약서 안내가 맞고,
 * "입사해도 괜찮을까요?"는 사업장 선택 안내가 맞다.
 */
const WEAK_COMPANY_REFERENCE = ["입사", "이직"];

function needsCompanySelection(id: string): ChatResponse {
  return {
    answer: CHAT_COPY.noCompany,
    answer_type: "clarification",
    sources: [],
    suggested_actions: [SEARCH_ACTION],
    limitations: ["사업장을 선택하기 전에는 특정 회사의 신호를 설명할 수 없습니다."],
    guardrail_status: "limited",
    conversation_id: id,
  };
}

function evidenceSummary(labels: string[]): string {
  if (labels.length === 0) return "세부 확인 신호가 제공되지 않았습니다.";
  return labels.join(", ");
}

const COMPANY_NAME_PATTERN = /(?:주식회사\s*)?[가-힣A-Za-z0-9㈜()·]{2,30}(?:건설|산업|제조|물류|화학|전기|공사|식자재|디자인|요양|테크|중공업|엔지니어링|회사|기업)/g;

async function findOtherReferencedCompany(
  message: string,
  selectedCompanyId: string,
  companies: CompanyRepository,
) {
  const candidates = [...new Set(message.match(COMPANY_NAME_PATTERN) ?? [])];
  for (const candidate of candidates) {
    const results = await companies.search(candidate, 3);
    const other = results.find((result) => result.company_id !== selectedCompanyId);
    if (other && normalizeSearchText(other.company_name) === normalizeSearchText(candidate)) return other;
  }
  return null;
}

export class PolicyChatProvider implements ChatProvider {
  constructor(
    private readonly companies: CompanyRepository,
    private readonly risks: RiskProvider,
  ) {}

  async sendMessage(request: ChatRequest): Promise<ChatResponse> {
    const message = request.message.trim();
    const id = conversationId(request.conversation_id);

    if (containsAny(message, ["사고 났", "사고났", "다쳤", "화재", "붕괴", "의식이 없", "유해물질 노출"])) {
      return {
        answer: `${CHAT_COPY.emergency}\n\n안전이 확보된 뒤 사고 기록과 신고·산재 절차를 확인하세요.`,
        answer_type: "emergency_guidance",
        sources: [SAFETY_GUIDE_SOURCE],
        suggested_actions: [
          {
            code: "MOVE_TO_SAFETY",
            label: "즉시 안전 확보",
            priority: "now",
          },
          CALL_1350,
        ],
        limitations: ["온라인 상담은 긴급 구조나 현장 대응을 대신할 수 없습니다."],
        guardrail_status: "escalated",
        conversation_id: id,
      };
    }

    const company = request.company_id ? await this.companies.getById(request.company_id) : null;
    if (request.company_id && !company) {
      throw new ServiceError("COMPANY_NOT_FOUND", "선택한 사업장을 찾을 수 없습니다.", 404, false);
    }

    const risk = company ? await this.risks.getCompanyRisk(company.company_id) : null;
    if (company && !risk) {
      throw new ServiceError("RISK_RESULT_NOT_FOUND", "사업장 분석 결과를 찾을 수 없습니다.", 404, false);
    }

    if (company) {
      const otherCompany = await findOtherReferencedCompany(message, company.company_id, this.companies);
      if (otherCompany) {
        return {
          answer: `현재 상담에는 ${company.company_name}만 연결되어 있습니다. ${otherCompany.company_name} 정보를 확인하려면 주소와 업종을 보고 해당 사업장을 다시 선택해 주세요.`,
          answer_type: "clarification",
          sources: [],
          suggested_actions: [SEARCH_ACTION],
          limitations: ["선택되지 않은 사업장의 정보는 현재 회사 응답에 섞지 않습니다."],
          guardrail_status: "limited",
          conversation_id: id,
        };
      }
    }

    if (!company && containsAny(message, COMPANY_REFERENCE)) {
      return needsCompanySelection(id);
    }

    if (!company || !risk) {
      if (containsAny(message, ["해외 본사", "대표 개인재산", "본사 대표", "해외 법인"])) {
        return {
          answer:
            "현재 연결된 공식 문서 범위에서는 해외 본사와 국내 법인, 대표 개인재산 사이의 책임 관계와 집행 가능성을 확인하기 어렵습니다. 근거 없이 결론을 만들지 않고, 계약 당사자와 체불 사실을 정리해 고용노동부 1350 또는 전문가에게 확인하시길 권합니다.",
          answer_type: "insufficient_evidence",
          sources: [],
          suggested_actions: [CALL_1350],
          limitations: ["현재 연결된 공식 문서 검색 범위에서 직접적인 근거를 찾지 못했습니다."],
          guardrail_status: "limited",
          conversation_id: id,
        };
      }

      const topic = matchLaborTopic(message);
      if (!topic && containsAny(message, WEAK_COMPANY_REFERENCE)) {
        return needsCompanySelection(id);
      }
      if (topic) {
        return {
          answer: topic.answer,
          answer_type: "general_guidance",
          sources: topic.sources,
          suggested_actions: topic.actions,
          limitations: [topic.limitation],
          guardrail_status: "passed",
          conversation_id: id,
        };
      }

      return {
        answer:
          "임금체불, 근로계약, 산업재해와 관련해 궁금한 상황을 조금 더 구체적으로 알려주세요. 특정 회사 정보가 필요하면 먼저 사업장을 검색해 정확한 회사를 선택할 수 있습니다.",
        answer_type: "clarification",
        sources: [],
        suggested_actions: [SEARCH_ACTION, CALL_1350],
        limitations: ["현재 답변은 안전정책에 따른 기본 안내입니다."],
        guardrail_status: "passed",
        conversation_id: id,
      };
    }

    const wage = risk.wage_risk;
    const safety = risk.safety_context;
    const baseLimitations = [CHAT_COPY.dataLimitation, CHAT_COPY.safetyScope];

    if (containsAny(message, ["체불할 거", "체불할거", "체불할 것", "임금이 밀릴", "월급이 밀릴"])) {
      return {
        answer: `${company.company_name}에서 향후 임금체불이 발생할지는 현재 정보만으로 확정할 수 없습니다. ${wage.summary} 입사 전에는 근로계약서의 임금 지급일과 지급 방법, 4대보험 가입 시점을 확인하세요.`,
        answer_type: "company_context",
        sources: risk.sources,
        suggested_actions: [
          { code: "CHECK_PAYDAY", label: "임금 지급일 확인", priority: "now" },
          { code: "CHECK_INSURANCE", label: "4대보험 가입 시점 확인", priority: "next" },
        ],
        limitations: baseLimitations,
        guardrail_status: "limited",
        conversation_id: id,
      };
    }

    if (containsAny(message, ["안전", "괜찮은 회사", "입사해도", "결론"])) {
      const safetyDetail =
        safety.level === "unknown"
          ? "산업재해 쪽은 분석 가능한 자료가 부족해 판단할 수 없습니다."
          : `산업재해 카드는 ${safety.region}·${safety.industry} 단위의 맥락을 보여주며, 현재 안내는 “${safety.summary}”입니다.`;
      return {
        answer: `${company.company_name}이 안전한지 또는 입사해도 되는지를 이 정보만으로 확정할 수는 없습니다. ${wage.summary} ${safetyDetail}\n\n근로계약서의 임금 지급일과 4대보험 가입 시점, 실제 현장의 안전교육·보호구·사고 보고 절차를 직접 확인한 뒤 다른 채용 조건과 함께 판단하세요.`,
        answer_type: "company_context",
        sources: risk.sources,
        suggested_actions: [
          { code: "CHECK_CONTRACT", label: "근로계약 조건 확인", priority: "now" },
          { code: "CHECK_SAFETY", label: "현장 안전조치 질문", priority: "next" },
        ],
        limitations: baseLimitations,
        guardrail_status: "limited",
        conversation_id: id,
      };
    }

    if (containsAny(message, ["왜", "이유", "추가 확인"])) {
      const wageLabels = wage.evidence_items.map((item) => item.label);
      const safetyLabels = safety.evidence_items.map((item) => item.label);
      return {
        answer: `${company.company_name}의 임금 지급 관련 카드에서는 ${evidenceSummary(wageLabels)} 항목을 확인할 필요가 있습니다. ${wage.summary}\n\n산업재해 카드는 ${safety.region}·${safety.industry} 단위 정보입니다. ${evidenceSummary(safetyLabels)} ${safety.summary}`,
        answer_type: "company_context",
        sources: risk.sources,
        suggested_actions: [
          { code: "CHECK_PAYDAY", label: "임금 지급일 확인", priority: "now" },
          { code: "CHECK_INSURANCE", label: "4대보험 가입 시점 확인", priority: "next" },
          { code: "CHECK_SAFETY_PROCESS", label: "안전교육·보고 절차 확인", priority: "next" },
        ],
        limitations: baseLimitations,
        guardrail_status: wage.level === "unknown" || safety.level === "unknown" ? "limited" : "passed",
        conversation_id: id,
      };
    }

    if (containsAny(message, ["입사 전", "확인해야", "체크리스트", "무엇을 확인"])) {
      return {
        answer:
          "입사 전에는 근로계약서에 임금 지급일, 기본급·수당 구분, 소정근로시간과 휴게시간이 적혀 있는지 확인하세요. 4대보험 가입 시점과 실제 근무지, 연장·야간·휴일근로 수당 기준도 질문하는 것이 좋습니다. 현장 업무가 있다면 안전교육, 보호구 지급, 사고 보고 절차도 함께 확인하세요.",
        answer_type: "company_context",
        sources: risk.sources,
        suggested_actions: [
          { code: "OPEN_CHECKLIST", label: "입사 전 체크리스트 확인", priority: "now" },
          { code: "REVIEW_CONTRACT", label: "근로계약서 검토", priority: "next" },
        ],
        limitations: baseLimitations,
        guardrail_status: "passed",
        conversation_id: id,
      };
    }

    return {
      answer: `${company.company_name}의 임금 지급 관련 결과는 “${wage.summary}”입니다. 산업재해 정보는 ${safety.region}·${safety.industry} 단위이며 “${safety.summary}”입니다. 어느 부분을 더 확인하고 싶은지 알려주시면 확인 항목 중심으로 설명해 드릴게요.`,
      answer_type: "company_context",
      sources: risk.sources,
      suggested_actions: [
        { code: "ASK_WAGE", label: "임금 신호 자세히 묻기", priority: "optional" },
        { code: "ASK_SAFETY", label: "산업재해 맥락 묻기", priority: "optional" },
      ],
      limitations: baseLimitations,
      guardrail_status: wage.level === "unknown" || safety.level === "unknown" ? "limited" : "passed",
      conversation_id: id,
    };
  }
}
