# 돈워리 통합 프로토타입 API 계약

- 문서 상태: Draft v1
- 기준일: 2026-08-04
- Base path: `/api`

## 1. 공통 규칙

### 형식

- JSON 필드명은 `snake_case`를 사용한다.
- 날짜는 `YYYY-MM-DD`, 시각은 타임존이 포함된 ISO 8601 형식을 사용한다.
- 모든 사업장 연동은 `company_id`를 기준으로 한다.
- `company_name`은 표시용이며 조회 키로 사용하지 않는다.
- 사용자용 응답에는 원시 모델 값이 포함되지 않는다.
- 회사가 존재하지만 특정 분석 데이터가 없으면 HTTP 오류가 아니라 `level: "unknown"`으로 표현한다.
- 회사 자체가 존재하지 않으면 `404 COMPANY_NOT_FOUND`를 반환한다.

### 공통 오류 응답

```ts
interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Array<{
      field?: string;
      reason: string;
    }>;
    retryable: boolean;
    request_id: string;
  };
}
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "요청 값을 확인해 주세요.",
    "details": [
      {
        "field": "q",
        "reason": "검색어는 한 글자 이상이어야 합니다."
      }
    ],
    "retryable": false,
    "request_id": "req_01J..."
  }
}
```

### 공통 상태 코드

| 상태 | 의미 |
|---|---|
| `200` | 정상 처리. 검색 결과 없음이나 분석 데이터 일부 부족도 포함 |
| `400` | 요청 형식 또는 유효성 검증 실패 |
| `404` | 지정한 `company_id`가 존재하지 않음 |
| `413` | 계약서 파일 크기 초과 |
| `415` | 지원하지 않는 계약서 파일 형식 |
| `429` | 요청 제한 초과 |
| `500` | 내부 서버 오류 |
| `503` | 외부 공급자 또는 운영 DB 일시 사용 불가 |

## 2. 공통 TypeScript 타입

```ts
type SignalLevel = "normal" | "watch" | "review" | "unknown";
type Confidence = "sufficient" | "limited" | "unavailable";

interface SourceReference {
  name: string;
  organization?: string;
  as_of?: string;
  url?: string;
  document_id?: string;
}

interface EvidenceItem {
  code: string;
  label: string;
  description: string;
}

interface SuggestedAction {
  code: string;
  label: string;
  description?: string;
  url?: string;
  priority: "now" | "next" | "optional";
}
```

## 3. 사업장 검색

### `GET /api/companies/search?q={query}`

#### 목적

사업장명 또는 회사명으로 후보를 검색하고, 사용자가 주소·업종을 확인해 정확한 `company_id`를 선택하게 한다.

#### 요청 파라미터

| 이름 | 위치 | 필수 | 형식 | 설명 |
|---|---|---|---|---|
| `q` | query | 필수 | string, 1~100자 | 사업장명 또는 회사명 |
| `limit` | query | 선택 | integer, 1~20 | 기본값 10 |

검색어 앞뒤 공백은 제거한다. 공백 제거 후 빈 문자열이면 검증 실패다.

#### 성공 응답

```ts
type CompanyMatchType = "exact" | "normalized" | "partial" | "alias";

interface CompanySearchItem {
  company_id: string;
  company_name: string;
  address: string;
  region: string;
  industry: string;
  size_label: string | null;
  matched_name: string;
  match_type: CompanyMatchType;
}

interface CompanySearchResponse {
  query: string;
  items: CompanySearchItem[];
  total: number;
  has_more: boolean;
}
```

```json
{
  "query": "한빛물류",
  "items": [
    {
      "company_id": "COMPANY_DEMO_001",
      "company_name": "한빛물류",
      "address": "인천광역시 서구 샘플로 10",
      "region": "인천광역시",
      "industry": "운수 및 창고업",
      "size_label": "50~99명",
      "matched_name": "한빛물류",
      "match_type": "exact"
    },
    {
      "company_id": "COMPANY_DEMO_002",
      "company_name": "한빛물류",
      "address": "경기도 김포시 예시로 21",
      "region": "경기도",
      "industry": "도매 및 소매업",
      "size_label": "10~49명",
      "matched_name": "한빛물류",
      "match_type": "exact"
    }
  ],
  "total": 2,
  "has_more": false
}
```

#### 데이터 없음 응답

검색 결과 없음은 오류가 아니다.

```json
{
  "query": "존재하지않는회사",
  "items": [],
  "total": 0,
  "has_more": false
}
```

#### 유효성 검증 실패

`400 VALIDATION_ERROR`

#### 서버 오류

- `500 INTERNAL_ERROR`: 예상하지 못한 내부 오류
- `503 COMPANY_SOURCE_UNAVAILABLE`: Real 저장소 연결 실패. Mock 자동 전환 정책이 활성화돼 있으면 `200`과 Mock 응답을 반환하고 서버 로그에 전환 사실을 기록한다.

## 4. 사업장 신호 조회

### `GET /api/companies/{companyId}/risk`

#### 목적

선택한 사업장의 임금체불 관측·예측 결과와 해당 사업장이 속한 지역·업종의 산업재해 신호를 분리해 제공한다.

경로는 통합 프롬프트와의 호환을 위해 `/risk`를 유지하지만 응답의 산업재해 필드는 `safety_context`다. 이는 개별 사업장 사고 위험이 아님을 타입 수준에서 드러내기 위한 결정이다.

#### 요청 파라미터

| 이름 | 위치 | 필수 | 형식 | 설명 |
|---|---|---|---|---|
| `companyId` | path | 필수 | string, 1~64자 | 정확한 내부 사업장 ID |

#### 성공 응답 타입

```ts
interface OfficialListingStatus {
  status: "listed" | "not_listed" | "unavailable";
  as_of: string | null;
  source_name?: string;
}

interface WageRiskPublic {
  level: SignalLevel;
  summary: string;
  evidence_codes: string[];
  evidence_items: EvidenceItem[];
  confidence: Confidence;
  official_listing: OfficialListingStatus;
}

interface SafetyContextPublic {
  scope: "region_industry";
  level: SignalLevel;
  summary: string;
  region: string;
  industry: string;
  target_start?: string;
  target_end?: string;
  evidence_codes: string[];
  evidence_items: EvidenceItem[];
  confidence: Confidence;
  disclaimer: string;
}

interface CompanySignalResponse {
  company_id: string;
  company_name: string;
  data_as_of: string;
  generated_at: string;
  valid_until: string;
  freshness: "current" | "expired";
  wage_risk: WageRiskPublic;
  safety_context: SafetyContextPublic;
  sources: SourceReference[];
}
```

#### 성공 응답 예시

```json
{
  "company_id": "COMPANY_DEMO_001",
  "company_name": "한빛물류",
  "data_as_of": "2026-07-31",
  "generated_at": "2026-08-01T10:00:00+09:00",
  "valid_until": "2026-08-31",
  "freshness": "current",
  "wage_risk": {
    "level": "watch",
    "summary": "최근 고용 변동이 관측되어 임금 지급 조건을 추가로 확인하는 것이 좋습니다.",
    "evidence_codes": [
      "EMPLOYEE_DECREASE",
      "HIGH_TURNOVER"
    ],
    "evidence_items": [
      {
        "code": "EMPLOYEE_DECREASE",
        "label": "최근 가입자 수 감소",
        "description": "최근 고용 인원 변동을 추가로 확인할 필요가 있습니다."
      },
      {
        "code": "HIGH_TURNOVER",
        "label": "최근 이직 변동 관측",
        "description": "면접에서 팀의 평균 근속 기간과 최근 충원 사유를 확인해 보세요."
      }
    ],
    "confidence": "sufficient",
    "official_listing": {
      "status": "not_listed",
      "as_of": "2026-07-31",
      "source_name": "고용노동부 체불사업주 명단공개"
    }
  },
  "safety_context": {
    "scope": "region_industry",
    "level": "review",
    "summary": "같은 지역·업종에서 최근 추가 확인이 필요한 산업재해 신호가 관측됐습니다.",
    "region": "인천광역시",
    "industry": "운수 및 창고업",
    "target_start": "2026-08-03",
    "target_end": "2026-08-09",
    "evidence_codes": [
      "REGION_INDUSTRY_ALERT"
    ],
    "evidence_items": [
      {
        "code": "REGION_INDUSTRY_ALERT",
        "label": "지역·업종 단위 확인 신호",
        "description": "개별 사업장 판정이 아니며 현장의 안전교육과 보호구 지급 여부를 직접 확인해야 합니다."
      }
    ],
    "confidence": "limited",
    "disclaimer": "지역·업종 단위 집계 신호이며 개별 사업장의 사고 위험이나 안전 여부를 나타내지 않습니다."
  },
  "sources": [
    {
      "name": "국민연금 가입 사업장 내역",
      "organization": "국민연금공단",
      "as_of": "2026-07"
    },
    {
      "name": "산업재해 집계 자료",
      "as_of": "2026-07-31"
    }
  ]
}
```

#### 데이터 일부 없음 응답

회사는 존재하지만 산업재해 자료가 부족한 경우에도 `200`을 반환한다. 프론트엔드는 카드를 유지하되 위험 등급이나 근거 목록을 표시하지 않는다.

```json
{
  "company_id": "COMPANY_DEMO_003",
  "company_name": "새봄서비스",
  "data_as_of": "2026-07-31",
  "generated_at": "2026-08-01T10:00:00+09:00",
  "valid_until": "2026-08-31",
  "freshness": "current",
  "wage_risk": {
    "level": "normal",
    "summary": "현재 확인 가능한 데이터에서는 뚜렷한 이상 신호가 확인되지 않았습니다.",
    "evidence_codes": [],
    "evidence_items": [],
    "confidence": "sufficient",
    "official_listing": {
      "status": "not_listed",
      "as_of": "2026-07-31"
    }
  },
  "safety_context": {
    "scope": "region_industry",
    "level": "unknown",
    "summary": "분석 가능한 자료가 부족합니다.",
    "region": "세종특별자치시",
    "industry": "서비스업",
    "evidence_codes": [],
    "evidence_items": [],
    "confidence": "unavailable",
    "disclaimer": "자료 부족은 안전하거나 위험하다는 뜻이 아닙니다."
  },
  "sources": [
    {
      "name": "국민연금 가입 사업장 내역",
      "organization": "국민연금공단",
      "as_of": "2026-07"
    }
  ]
}
```

#### 사업장 없음 응답

`404 COMPANY_NOT_FOUND`

#### 유효성 검증 실패

`400 INVALID_COMPANY_ID`

#### 서버 오류

- `500 INTERNAL_ERROR`
- `503 RISK_SOURCE_UNAVAILABLE`: Real 공급자를 사용할 수 없고 Mock 전환도 비활성화된 경우

#### 내부 타입 분리 예시

다음 값은 서버 내부에서만 사용할 수 있다.

```ts
interface InternalSignalResult {
  company_id: string;
  raw_probability?: number;
  percentile?: number;
  shap_values?: Array<{ feature: string; value: number }>;
  model_version?: string;
  data_version?: string;
  wage_level: SignalLevel;
  safety_level: SignalLevel;
}
```

`InternalSignalResult`를 API 응답으로 직렬화하는 것을 금지한다.

## 5. 챗봇

### `POST /api/chat`

#### 목적

일반 노동 상담 또는 선택한 사업장 컨텍스트 기반 상담을 제공하고, 공식 문서 출처·행동 가이드·한계를 함께 반환한다.

#### 요청 Body

```ts
type ChatMode = "general" | "wage" | "safety" | "contract";

interface RecentMessage {
  role: "user" | "assistant";
  content: string;
}

interface ChatRequest {
  message: string;
  conversation_id?: string;
  company_id?: string;
  resolved_query?: string;
  chat_mode: ChatMode;
  recent_messages: RecentMessage[];
}
```

검증 규칙:

- `message`: 공백 제거 후 1~2,000자
- `conversation_id`: 없으면 서버가 생성
- `company_id`: 선택 사항. 제공되면 서버가 존재 여부와 신호 결과를 다시 조회
- `resolved_query`: 질의 재작성 기능의 결과를 재사용할 때만 선택적으로 사용
- `recent_messages`: 최근 최대 10개, 각 2,000자 이하

클라이언트가 임의로 만든 회사 위험 설명은 요청 Body에 받지 않는다.

#### 성공 응답

```ts
type AnswerType =
  | "general_guidance"
  | "company_context"
  | "clarification"
  | "insufficient_evidence"
  | "refusal"
  | "emergency_guidance";

type GuardrailStatus = "passed" | "limited" | "refused" | "escalated";

interface ChatResponse {
  answer: string;
  answer_type: AnswerType;
  sources: SourceReference[];
  suggested_actions: SuggestedAction[];
  limitations: string[];
  guardrail_status: GuardrailStatus;
  conversation_id: string;
}
```

```json
{
  "answer": "최근 고용 변동이 관측됐지만 이것만으로 임금체불을 단정할 수는 없습니다. 입사 전에는 근로계약서의 임금 지급일과 지급 방법, 4대보험 가입 시점을 확인해 보세요.",
  "answer_type": "company_context",
  "sources": [
    {
      "name": "근로기준법 제17조",
      "organization": "국가법령정보센터",
      "as_of": "2026-08-01",
      "document_id": "LABOR_STANDARDS_ACT_17"
    }
  ],
  "suggested_actions": [
    {
      "code": "CHECK_PAYDAY",
      "label": "임금 지급일 확인",
      "description": "근로계약서에 지급일과 지급 방법이 적혀 있는지 확인하세요.",
      "priority": "now"
    },
    {
      "code": "CALL_1350",
      "label": "고용노동부 1350 확인",
      "priority": "optional"
    }
  ],
  "limitations": [
    "관측 신호는 임금체불 발생 사실이나 미래 발생을 확정하지 않습니다."
  ],
  "guardrail_status": "passed",
  "conversation_id": "conv_01J..."
}
```

#### 근거 없음 응답

근거 부족은 정상적인 제한 응답이다.

```json
{
  "answer": "현재 연결된 공식 문서 범위에서는 해당 내용을 확인하기 어렵습니다. 추측해서 안내하지 않고 고용노동부 1350 등 공식 창구에서 확인하시길 권합니다.",
  "answer_type": "insufficient_evidence",
  "sources": [],
  "suggested_actions": [
    {
      "code": "CALL_1350",
      "label": "고용노동부 1350 확인",
      "priority": "next"
    }
  ],
  "limitations": [
    "현재 RAG 검색 범위에서 직접적인 공식 근거를 찾지 못했습니다."
  ],
  "guardrail_status": "limited",
  "conversation_id": "conv_01J..."
}
```

#### 유효성 검증 실패

`400 VALIDATION_ERROR`

#### 서버 오류

- `500 INTERNAL_ERROR`
- `503 CHAT_PROVIDER_UNAVAILABLE`
- 공급자 실패 후 안전한 정적 행동 가이드를 제공할 수 있으면 `200`, `guardrail_status: "limited"`로 반환한다.

## 6. 근로계약서 검토

### `POST /api/contracts/review`

#### 목적

근로계약서의 기본 명시 항목을 확인하고 누락·추가 검토 항목과 사용자 질문 예시를 제공한다. 결과는 법률 확정 판정이 아니다.

#### 요청 형식 A — `multipart/form-data`

| 이름 | 필수 | 형식 | 설명 |
|---|---|---|---|
| `file` | 조건부 | PDF, PNG, JPG | `text`가 없으면 필수 |
| `text` | 조건부 | string, 최대 20,000자 | `file`이 없으면 필수 |
| `file_name` | 선택 | string | Mock 메타데이터 시나리오에 사용 |
| `scenario_id` | 선택 | string | 허용된 Mock 시나리오 ID |

#### 요청 형식 B — `application/json`

```ts
interface ContractReviewJsonRequest {
  text?: string;
  file_metadata?: {
    file_name: string;
    content_type: "application/pdf" | "image/png" | "image/jpeg";
    size_bytes: number;
  };
  scenario_id?: string;
}
```

실제 파일과 테스트 텍스트가 모두 없고 허용된 `scenario_id`도 없으면 검증 실패다.

#### 성공 응답

```ts
type ContractItemStatus = "detected" | "missing" | "review";

interface ContractItem {
  code: string;
  label: string;
  status: ContractItemStatus;
  description: string;
  legal_basis?: string;
  extracted_text?: string;
}

interface ContractReviewResponse {
  analysis_status: "completed" | "partial" | "mocked";
  detected_items: ContractItem[];
  missing_items: ContractItem[];
  review_items: ContractItem[];
  warnings: string[];
  suggested_questions: string[];
  limitations: string[];
}
```

```json
{
  "analysis_status": "mocked",
  "detected_items": [
    {
      "code": "WAGE",
      "label": "임금",
      "status": "detected",
      "description": "임금 금액과 지급 방법이 확인됐습니다.",
      "legal_basis": "근로기준법 제17조"
    },
    {
      "code": "WORK_LOCATION",
      "label": "근무 장소",
      "status": "detected",
      "description": "근무 장소가 확인됐습니다.",
      "legal_basis": "근로기준법 시행령 제8조"
    }
  ],
  "missing_items": [
    {
      "code": "PAYDAY",
      "label": "임금 지급일",
      "status": "missing",
      "description": "임금을 지급하는 날짜가 명확히 확인되지 않습니다.",
      "legal_basis": "근로기준법 제17조"
    },
    {
      "code": "ANNUAL_LEAVE",
      "label": "연차 유급휴가",
      "status": "missing",
      "description": "연차 유급휴가 항목이 확인되지 않습니다.",
      "legal_basis": "근로기준법 제17조"
    }
  ],
  "review_items": [
    {
      "code": "WORKING_HOURS_DETAIL",
      "label": "소정근로시간 상세",
      "status": "review",
      "description": "시업·종업 시각과 휴게시간이 구체적인지 확인해 보세요."
    }
  ],
  "warnings": [
    "누락으로 표시된 항목은 문서 인식 한계로 실제 문서에 존재할 수 있습니다."
  ],
  "suggested_questions": [
    "임금 지급일을 계약서에 어떻게 적으면 되나요?",
    "연차 유급휴가 항목을 추가하려면 무엇을 확인해야 하나요?"
  ],
  "limitations": [
    "이 결과는 기본 항목 확인을 돕는 정보이며 계약의 유효성이나 위법 여부를 확정하지 않습니다.",
    "정확한 판단은 고용노동부 1350 또는 전문가에게 확인하세요."
  ]
}
```

#### 데이터 없음·부분 분석 응답

문서를 읽었지만 텍스트를 충분히 추출하지 못한 경우 `200`, `analysis_status: "partial"`로 응답한다. 확인하지 못한 항목을 곧바로 `missing`으로 확정하지 않고 `review_items`에 둔다.

#### 유효성 검증 실패

- `400 VALIDATION_ERROR`: 파일·텍스트·Mock 시나리오가 모두 없음
- `413 FILE_TOO_LARGE`: 설정된 파일 크기 초과
- `415 UNSUPPORTED_MEDIA_TYPE`: 지원하지 않는 파일 형식

#### 서버 오류

- `500 CONTRACT_REVIEW_ERROR`
- `503 CONTRACT_PROVIDER_UNAVAILABLE`
- 본선 Mock 전환이 활성화돼 있으면 Real 공급자 오류를 격리하고 `analysis_status: "mocked"` 응답을 반환한다.

## 7. 보안·개인정보 경계

- API 키와 공급자 설정은 서버에서만 관리한다.
- 계약서 원문이나 전체 추출 텍스트를 기본 로그에 남기지 않는다.
- `recent_messages`에 주민등록번호, 계좌번호 등 민감정보가 들어갈 수 있으므로 운영 로그 정책 확정 전에는 장기 저장하지 않는다.
- 사용자가 보낸 `company_id`는 모든 요청에서 서버 저장소를 통해 재검증한다.
- Mock 사업장은 실제 사업장과 혼동되지 않도록 응답 또는 화면에 데모 표시를 둔다.

## 8. 계약 일관성 검사 항목

- 검색 응답의 `company_id`가 신호 조회와 챗봇 요청에 그대로 사용되는가
- 신호 응답에 `wage_risk`와 `safety_context`가 별도로 존재하는가
- `safety_context.scope`가 항상 `region_industry`인가
- `unknown` 응답에 위험 근거가 만들어져 있지 않은가
- `raw_probability`, `percentile`, `shap_value`가 Public DTO에 없는가
- 챗봇 출처가 공식 문서 참조 타입과 일치하는가
- 계약서 Mock과 Real 응답이 동일한 타입을 사용하는가
