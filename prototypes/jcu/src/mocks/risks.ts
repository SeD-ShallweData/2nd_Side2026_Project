import type {
  CompanyRiskResult,
  SafetyContextPublic,
  SourceReference,
  WageRiskPublic,
} from "@/domain/risk";

const WAGE_SOURCE: SourceReference = {
  name: "국민연금 가입 사업장 내역",
  organization: "국민연금공단",
  as_of: "2026-07",
};

const LISTING_SOURCE: SourceReference = {
  name: "체불사업주 명단공개",
  organization: "고용노동부",
  as_of: "2026-07-31",
};

const SAFETY_SOURCE: SourceReference = {
  name: "산업재해 집계 자료",
  organization: "공식 공개자료 기반 데모",
  as_of: "2026-07-31",
};

const UNKNOWN_WAGE: WageRiskPublic = {
  level: "unknown",
  summary: "분석 가능한 자료가 부족합니다.",
  evidence_codes: [],
  evidence_items: [],
  confidence: "unavailable",
  official_listing: {
    status: "unavailable",
    as_of: null,
  },
};

function safetyContext(
  region: string,
  industry: string,
  level: SafetyContextPublic["level"],
  summary: string,
  confidence: SafetyContextPublic["confidence"],
  evidence: SafetyContextPublic["evidence_items"] = [],
): SafetyContextPublic {
  return {
    scope: "region_industry",
    level,
    summary,
    region,
    industry,
    target_start: "2026-08-03",
    target_end: "2026-08-09",
    evidence_codes: evidence.map((item) => item.code),
    evidence_items: evidence,
    confidence,
    disclaimer: "지역·업종 단위 집계 신호이며 개별 사업장의 사고 위험이나 안전 여부를 나타내지 않습니다.",
  };
}

const UNKNOWN_SAFETY = (region: string, industry: string): SafetyContextPublic => ({
  scope: "region_industry",
  level: "unknown",
  summary: "분석 가능한 자료가 부족합니다.",
  region,
  industry,
  evidence_codes: [],
  evidence_items: [],
  confidence: "unavailable",
  disclaimer: "자료 부족은 안전하거나 위험하다는 뜻이 아닙니다.",
});

export const MOCK_RISKS: Record<string, CompanyRiskResult> = {
  COMPANY_DEMO_001: {
    company_id: "COMPANY_DEMO_001",
    company_name: "OO건설",
    data_as_of: "2026-07-31",
    generated_at: "2026-08-01T10:00:00+09:00",
    valid_until: "2026-08-31",
    freshness: "current",
    wage_risk: {
      level: "watch",
      summary: "일부 변동 신호가 관측되어 추가로 확인하는 것이 좋습니다.",
      evidence_codes: ["EMPLOYEE_DECREASE", "HIGH_TURNOVER"],
      evidence_items: [
        {
          code: "EMPLOYEE_DECREASE",
          label: "최근 가입자 수 감소",
          description: "최근 고용 인원 변동을 추가로 확인할 필요가 있습니다.",
        },
        {
          code: "HIGH_TURNOVER",
          label: "최근 이직 변동 관측",
          description: "면접에서 팀의 평균 근속 기간과 최근 충원 사유를 확인해 보세요.",
        },
      ],
      confidence: "sufficient",
      official_listing: {
        status: "not_listed",
        as_of: "2026-07-31",
        source_name: "고용노동부 체불사업주 명단공개",
      },
    },
    safety_context: safetyContext(
      "인천광역시",
      "건설업",
      "review",
      "확인할 필요가 있는 지역·업종 신호가 관측되었습니다. 현장 조건을 구체적으로 확인하세요.",
      "limited",
      [
        {
          code: "REGION_INDUSTRY_ALERT",
          label: "지역·업종 단위 확인 신호",
          description: "현장의 안전교육, 보호구 지급, 사고 보고 절차를 직접 확인해야 합니다.",
        },
      ],
    ),
    sources: [WAGE_SOURCE, LISTING_SOURCE, SAFETY_SOURCE],
  },
  COMPANY_DEMO_002: {
    company_id: "COMPANY_DEMO_002",
    company_name: "다온제조",
    data_as_of: "2026-07-31",
    generated_at: "2026-08-01T10:00:00+09:00",
    valid_until: "2026-08-31",
    freshness: "current",
    wage_risk: {
      level: "normal",
      summary: "현재 확인 가능한 데이터에서는 뚜렷한 이상 신호가 확인되지 않았습니다.",
      evidence_codes: [],
      evidence_items: [],
      confidence: "sufficient",
      official_listing: {
        status: "not_listed",
        as_of: "2026-07-31",
        source_name: "고용노동부 체불사업주 명단공개",
      },
    },
    safety_context: safetyContext(
      "충청남도",
      "제조업",
      "normal",
      "해당 지역·업종 자료에서는 최근 뚜렷한 추가 확인 신호가 나타나지 않았습니다.",
      "sufficient",
    ),
    sources: [WAGE_SOURCE, LISTING_SOURCE, SAFETY_SOURCE],
  },
  UNKNOWN_WAGE_001: {
    company_id: "UNKNOWN_WAGE_001",
    company_name: "새봄서비스",
    data_as_of: "2026-07-31",
    generated_at: "2026-08-01T10:00:00+09:00",
    valid_until: "2026-08-31",
    freshness: "current",
    wage_risk: UNKNOWN_WAGE,
    safety_context: safetyContext(
      "세종특별자치시",
      "사업지원 서비스업",
      "watch",
      "일부 지역·업종 변동 신호가 관측되어 현장 조건을 추가로 확인하는 것이 좋습니다.",
      "limited",
      [
        {
          code: "RECENT_CONTEXT_CHANGE",
          label: "최근 지역·업종 변동",
          description: "개별 사업장 판단이 아니므로 실제 근무 환경을 직접 확인하세요.",
        },
      ],
    ),
    sources: [SAFETY_SOURCE],
  },
  UNKNOWN_SAFETY_001: {
    company_id: "UNKNOWN_SAFETY_001",
    company_name: "푸른건설",
    data_as_of: "2026-07-31",
    generated_at: "2026-08-01T10:00:00+09:00",
    valid_until: "2026-08-31",
    freshness: "current",
    wage_risk: {
      level: "review",
      summary: "확인할 필요가 있는 신호가 관측되었습니다. 임금 지급 조건을 구체적으로 확인하세요.",
      evidence_codes: ["LISTED_HISTORY", "EMPLOYMENT_CHANGE"],
      evidence_items: [
        {
          code: "LISTED_HISTORY",
          label: "공식 공개명단 일치 결과",
          description: "기준일의 공식 원문과 사업장 주소를 함께 확인하세요.",
        },
        {
          code: "EMPLOYMENT_CHANGE",
          label: "고용 인원 변동",
          description: "급여 지급일과 4대보험 처리 시점을 우선 확인하세요.",
        },
      ],
      confidence: "sufficient",
      official_listing: {
        status: "listed",
        as_of: "2026-07-31",
        source_name: "고용노동부 체불사업주 명단공개",
      },
    },
    safety_context: UNKNOWN_SAFETY("경기도", "건설업"),
    sources: [WAGE_SOURCE, LISTING_SOURCE],
  },
  UNKNOWN_001: {
    company_id: "UNKNOWN_001",
    company_name: "미래산업",
    data_as_of: "2026-07-31",
    generated_at: "2026-08-01T10:00:00+09:00",
    valid_until: "2026-08-31",
    freshness: "current",
    wage_risk: UNKNOWN_WAGE,
    safety_context: UNKNOWN_SAFETY("강원특별자치도", "기타 전문 서비스업"),
    sources: [],
  },
  COMPANY_DEMO_006: {
    company_id: "COMPANY_DEMO_006",
    company_name: "OO건설",
    data_as_of: "2026-07-31",
    generated_at: "2026-08-01T10:00:00+09:00",
    valid_until: "2026-08-31",
    freshness: "current",
    wage_risk: {
      level: "watch",
      summary: "일부 변동 신호가 관측되어 추가로 확인하는 것이 좋습니다.",
      evidence_codes: ["SHORT_OBSERVATION"],
      evidence_items: [
        {
          code: "SHORT_OBSERVATION",
          label: "관측 기간이 비교적 짧음",
          description: "입사 전 최근 급여 지급과 4대보험 가입 일정을 확인해 보세요.",
        },
      ],
      confidence: "limited",
      official_listing: {
        status: "not_listed",
        as_of: "2026-07-31",
      },
    },
    safety_context: safetyContext(
      "경기도",
      "전문직별 공사업",
      "normal",
      "해당 지역·업종 자료에서는 최근 뚜렷한 추가 확인 신호가 나타나지 않았습니다.",
      "limited",
    ),
    sources: [WAGE_SOURCE, SAFETY_SOURCE],
  },
  EXPIRED_001: {
    company_id: "EXPIRED_001",
    company_name: "오래된물류",
    data_as_of: "2026-05-31",
    generated_at: "2026-06-02T09:00:00+09:00",
    valid_until: "2026-06-30",
    freshness: "expired",
    wage_risk: {
      level: "watch",
      summary: "일부 변동 신호가 관측됐지만 유효기간이 지나 최신 자료 확인이 필요합니다.",
      evidence_codes: ["EMPLOYEE_DECREASE"],
      evidence_items: [
        {
          code: "EMPLOYEE_DECREASE",
          label: "당시 고용 인원 변동",
          description: "현재 상태가 아니라 과거 기준 결과입니다.",
        },
      ],
      confidence: "limited",
      official_listing: {
        status: "unavailable",
        as_of: null,
      },
    },
    safety_context: safetyContext(
      "부산광역시",
      "운수 및 창고업",
      "review",
      "과거 기준 추가 확인 신호가 있으나 최신 지역·업종 자료를 다시 확인해야 합니다.",
      "limited",
    ),
    sources: [
      { ...WAGE_SOURCE, as_of: "2026-05" },
      { ...SAFETY_SOURCE, as_of: "2026-05-31" },
    ],
  },
  COMPANY_DEMO_008: {
    company_id: "COMPANY_DEMO_008",
    company_name: "한빛테크",
    data_as_of: "2026-07-31",
    generated_at: "2026-08-01T10:00:00+09:00",
    valid_until: "2026-08-31",
    freshness: "current",
    wage_risk: {
      level: "normal",
      summary: "현재 확인 가능한 데이터에서는 뚜렷한 이상 신호가 확인되지 않았습니다.",
      evidence_codes: [],
      evidence_items: [],
      confidence: "sufficient",
      official_listing: {
        status: "not_listed",
        as_of: "2026-07-31",
      },
    },
    safety_context: safetyContext(
      "서울특별시",
      "정보통신업",
      "watch",
      "일부 지역·업종 변동 신호가 관측되어 근무 환경을 추가로 확인하는 것이 좋습니다.",
      "limited",
    ),
    sources: [WAGE_SOURCE, SAFETY_SOURCE],
  },
};
