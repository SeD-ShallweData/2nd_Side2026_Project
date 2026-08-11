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

    if (!company && containsAny(message, ["이 회사", "여기", "사업장", "입사", "회사 안전", "왜 추가 확인"])) {
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

      if (containsAny(message, ["임금", "월급", "체불", "퇴직금"])) {
        return {
          answer:
            "임금이 지급되지 않았다면 근로계약서, 급여명세서, 출퇴근 기록, 계좌 내역처럼 근무와 미지급 사실을 확인할 자료를 먼저 정리하세요. 그다음 고용노동부 상담 또는 관할 노동관서의 진정 절차를 확인할 수 있습니다.",
          answer_type: "general_guidance",
          sources: [WAGE_GUIDE_SOURCE],
          suggested_actions: [
            {
              code: "COLLECT_WAGE_RECORDS",
              label: "근무·임금 자료 정리",
              priority: "now",
            },
            CALL_1350,
          ],
          limitations: ["개별 체불 여부와 청구 가능 범위는 공식 상담에서 확인해야 합니다."],
          guardrail_status: "passed",
          conversation_id: id,
        };
      }

      if (containsAny(message, ["산재", "산업재해", "업무상 재해"])) {
        return {
          answer:
            "업무 중 다치거나 질병이 발생했다면 먼저 치료와 안전을 확보하고, 발생 시각·장소·작업 내용·목격자 등 사실관계를 기록해 두세요. 산재 신청에 필요한 구체적인 자료와 절차는 근로복지공단 또는 고용노동부 공식 창구에서 확인하는 것이 좋습니다.",
          answer_type: "general_guidance",
          sources: [SAFETY_GUIDE_SOURCE],
          suggested_actions: [
            {
              code: "RECORD_ACCIDENT",
              label: "발생 경위 기록",
              priority: "now",
            },
            CALL_1350,
          ],
          limitations: ["이 답변은 산재 승인 여부를 판단하지 않습니다."],
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
