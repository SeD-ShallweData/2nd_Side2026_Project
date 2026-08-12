# 돈워리 통합 API 계약

- 상태: **Final v2**
- 확정일: 2026-08-11
- 공개 Base path: `/api`
- 공개 API 소유자: `product` Next.js 서버

## 1. 경계와 불변 원칙

브라우저는 PostgreSQL, HB RAG, CSH 계약서 분석, LLM 공급자를 직접 호출하지 않는다. 모든 요청은
Next.js `/api/*`를 통과하고 내부 어댑터가 외부 시스템의 차이를 흡수한다.

```text
Browser → product /api/* → PostgreSQL (read only)
                         → HB /api/retrieve
                         → CSH /api/contract/review
                         → Upstage / SKT
```

DB가 데이터 의미의 기준이다.

- 공개 `company_id`는 DB `firms.firm_id`를 그대로 전달한 값이다.
- `biz_no`와 `corp_key`는 사업장 식별자로 사용하지 않는다.
- 앱 DB 연결은 읽기 전용 계정을 사용하고 세션에도 `default_transaction_read_only=on`을 강제한다.
- `risk_full`은 확률이 아니며 공개 응답에 포함하지 않는다.
- `risk_full IS NULL`은 0이 아니라 채점 불가다.
- 구직자용 임금 신호는 `safe_recommendation."판정"`을 우선한다.
- 감독관 사유는 `inspector_queue`에 실제 존재하는 행에만 제공할 수 있다.
- 산업안전은 `industrial_safety.v_llm_firm_safety_context`만 읽고 연구용 확률은 읽지 않는다.
- DB에 없는 주소·사업장 규모·기준월은 만들어내지 않고 `null`로 반환한다.
- Real 모드의 오류를 Mock 성공 응답으로 자동 전환하지 않는다. Mock은 명시적인 테스트 모드에서만 사용한다.

## 2. 공통 규칙

- JSON 필드명은 `snake_case`다.
- 날짜는 `YYYY-MM-DD`, 시각은 timezone을 포함한 ISO 8601이다.
- 검색 결과 없음과 일부 분석자료 없음은 `200`이다.
- 사업장 자체가 없으면 `404 COMPANY_NOT_FOUND`다.
- 원시 모델 점수, SHAP 값, 비밀키, 시스템 프롬프트, 원시 공급자 오류는 공개하지 않는다.

```ts
interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Array<{ field?: string; reason: string }>;
    retryable: boolean;
    request_id: string;
  };
}
```

## 3. 사업장 검색

### `GET /api/companies/search?q={query}&limit={1..20}&page={1..}`

```ts
interface CompanySearchItem {
  company_id: string;       // DB firms.firm_id
  company_name: string;     // firms.name
  address: string | null;   // 현재 DB에 없으므로 Real 응답은 null
  region: string | null;    // firms.sido
  industry: string | null;  // firms.industry
  size_label: string | null;// 현재 DB에 없으므로 Real 응답은 null
  matched_name: string;
  match_type: "exact" | "normalized" | "partial" | "alias";
}

interface CompanySearchResponse {
  query: string;
  items: CompanySearchItem[];
  total: number;
  has_more: boolean;
  page: number;
  page_size: number;
  total_pages: number;
}
```

동명 사업장은 합치거나 첫 결과를 자동 선택하지 않는다. `total`은 현재 페이지가 아니라 전체 일치 건수이며, 기본값은 페이지당 10개다. 검색 SQL은 parameter binding을 사용한다. `address`, `size_label`은 하위 호환을 위해 nullable 필드로 유지하지만 현재 소비자 UI에서는 기능으로 제공하지 않는다.

## 4. 사업장 공개 신호

### `GET /api/companies/{companyId}/risk`

경로는 호환성을 위해 `/risk`를 유지하지만 응답은 임금과 산업안전을 분리한다.

```ts
type SignalLevel = "normal" | "watch" | "review" | "unknown";
type Confidence = "sufficient" | "limited" | "unavailable";
type SignalAvailability = "ready" | "no_data" | "unavailable";

interface CompanyRiskResponse {
  company_id: string;
  company_name: string;
  data_as_of: string | null;
  target_month?: string | null;
  generated_at: string | null;
  valid_until: string | null;
  freshness: "current" | "expired" | "unknown";
  wage_risk: {
    availability?: SignalAvailability;
    level: SignalLevel;
    summary: string;
    evidence_codes: string[];
    evidence_items: Array<{ code: string; label: string; description: string }>;
    confidence: Confidence;
    official_listing: {
      status: "listed" | "not_listed" | "unavailable";
      as_of: string | null;
      source_name?: string;
    };
  };
  safety_context: {
    availability?: SignalAvailability;
    scope: "region_industry" | "validated_firm_context";
    level: SignalLevel;
    summary: string;
    region: string | null;
    industry: string | null;
    target_start?: string;
    target_end?: string;
    evidence_codes: string[];
    evidence_items: Array<{ code: string; label: string; description: string }>;
    confidence: Confidence;
    disclaimer: string;
  };
  sources: SourceReference[];
}
```

`normal`은 안전 인증이 아니다. 산업안전 priority band는 사고 확률이 아니라 현장 확인 순서를 돕는
공표 구간으로만 설명한다. 공개 API에는 `risk_full`, percentile, rank, SHAP를 포함하지 않는다.

## 5. 공식 노동법 검색과 듀얼 LLM

### 공개: `POST /api/chat`

```ts
interface ChatRequest {
  message: string;                 // 1..2000자
  conversation_id?: string;
  company_id?: string;
  chat_mode: "general" | "wage" | "safety" | "contract";
  recent_messages: Array<{ role: "user" | "assistant"; content: string }>;
}
```

Next 서버는 회사 컨텍스트를 `company_id`로 다시 조회한다. 클라이언트가 보낸 위험 설명은 신뢰하지 않는다.
후속 질문은 서버가 CSH 재작성 규칙으로 독립 질문으로 바꾼 뒤 HB 검색 서비스에서 근거를 **한 번만**
검색하고 같은 문서 배열을 두 LLM에 전달한다. 클라이언트는 `resolved_query`를 지정할 수 없다.

### 내부: `POST {RAG_API_URL}/api/retrieve`

```ts
interface RagRetrieveRequest { query: string; limit: number }
interface RagRetrieveResponse {
  query: string;
  status: "matched" | "no_match";
  threshold: number;
  top1_distance: number | null;
  items: Array<{
    content: string;
    citation: string;
    distance: number;
    source: SourceReference;
  }>;
}
```

`/api/chat` 응답은 Upstage와 SKT 결과를 함께 반환한다. 각 결과에는 답변, 동일한 공식 출처, 다음 행동,
한계, 지연시간, token 사용량, 종료 사유, 가드레일 상태가 포함된다. 성능 지표는 기능에서 제거하지 않되
일반 화면에서는 접힌 상세정보로 제공한다.

RAG `no_match`는 오류가 아니다. `reason=out_of_scope`이면 `topic`을 함께 표시하고, 그 밖에는 직접 관련 근거가 없음을 표시한다. 검색 근거에는 citation·문서 식별자·확인된 원문 URL을 노출하며, 출처를 만들지 않고 공식 확인 창구를 안내한다. 한 LLM 실패는
다른 LLM 결과를 취소하지 않는다. 즉각적 사고·부상 표현은 RAG와 LLM을 기다리지 않고 공통 긴급안내를 반환한다.

## 6. 근로계약서 검토

### 공개: `POST /api/contracts/review`

`multipart/form-data`의 `file`은 PDF/PNG/JPEG, 최대 10MiB다. Mock 시연에서는 허용된 `scenario_id`를
사용할 수 있다. Real 모드에서는 Next 서버가 파일 바이트를 CSH 내부 서비스에 전달한다.

### 내부: `POST {CONTRACT_ANALYSIS_URL}/api/contract/review`

CSH 서비스가 문서 추출 → 구조화 → 결정적 규칙 엔진을 수행한다. LLM은 문서를 읽는 데 사용할 수 있지만
최종 판정 등급은 규칙 엔진이 만든다. Next 어댑터는 결과를 다음 공개 DTO로 변환한다.

```ts
interface ContractReviewResponse {
  analysis_status: "completed" | "partial" | "mocked";
  detected_items: ContractItem[];
  missing_items: ContractItem[];
  review_items: ContractItem[];
  warnings: string[];
  suggested_questions: string[];
  limitations: string[];
  review_id?: string;
  file_name?: string;
}
```

파일 원문은 Next 서버나 Git에 저장하지 않는다. 실제 분석 공급자 실패를 Mock 성공처럼 감추지 않는다.

## 7. 운영 상태

### `GET /api/system/status`

비밀값 없이 계약 버전, 전체 및 기능별 `mock | real`과 통합 상태만 반환한다.
DB·RAG·계약서 분석·LLM은 `ready | configured_unreachable | unavailable`로 표시한다. DB의 `ready`는
읽기 전용 연결에서 `SELECT 1`이 성공했다는 뜻이다. LLM의 `ready`는 키 문자열 존재 여부가 아니라 두
공급자에 대한 최소 실제 요청이 모두 성공했다는 뜻이며 결과는 60초 캐시한다. 이 상태 API는 비밀값이나
질문·답변 원문을 반환하지 않는다.

## 8. 근로감독관 시연용 내부 API

근로감독관 화면은 `/inspector`, AI 점검 보조는 `/inspector/chat`이다. 현재는 역할 기반 계정 시스템이
아닌 팀 시연용 프로토타입이므로 외부 공개 API가 아니다. 시연 서버에서는 `DEMO_BASIC_AUTH_USER`와
`DEMO_BASIC_AUTH_PASSWORD`를 반드시 설정해 페이지와 `/api/inspector/*` 전체를 Basic 인증으로 보호한다.

- `GET /api/inspector/overview`: 최신 배치 요약, 큐 우선순위별 건수, 최상위 큐를 반환한다.
- `GET /api/inspector/companies/search?q=...`: 실제 `firms`에서 동명 사업장을 검색한다.
- `GET /api/inspector/companies/{companyId}`: 최신 `risk_full`, 큐 순위·`grade`, 실제
  `reasons`, G1~G6 지표와 별도 산업안전 공표 구간을 반환한다.
- `POST /api/inspector/chat`: 선택 사업장 내부 컨텍스트와 노동법 RAG를 두 LLM에 동일하게 전달한다.

감독관 응답에서도 `risk_full`은 **모델 원점수**로만 표시하고 확률이나 백분율로 바꾸지 않는다.
`risk_full IS NULL`은 `채점 불가`이며 0점이 아니다. `grade`는 `risk_full` 내림차순 상위 3,000곳
내부의 점검 등급이며 전체 사업장의 별도 위험등급이 아니다. `reasons`는 DB에 실제
저장된 큐 행에만 제공한다. 산업안전 순위는 임금체불 점수와 결합하지 않는다.

내부 챗봇은 외부 모델 전송 전에 화면에서 명시적 확인을 요구한다. 확인 대상은 사업장 기본정보, 배치 시점,
모델 원점수·점검 등급·순위·실제 SHAP 사유, G1~G6 관측지표, 산업안전 참고정보, 해석 한계와 질문에
검색된 노동법 문서다. `firm_id`와 마스킹 사업자번호는 LLM 컨텍스트에서 제외한다.
API도 `confirm_external_context: true`가 없으면 호출을 거부한다. 응답은 조사·위법 판단·행정처분을
대신하지 않는다.

## 9. 아직 공개하지 않는 API

- 커뮤니티 쓰기: 팀원 구현과 인증 계약이 합쳐진 뒤 확정한다. 읽기 계층은 신원이 제거된 `v_posts`,
  `v_comments`, `v_reviews`만 사용한다.

## 10. HTTP 상태

| 상태 | 의미 |
|---|---|
| `200` | 성공, 결과 없음, 일부 자료 없음 |
| `400` | 요청 검증 실패 |
| `404` | 사업장 없음 |
| `413` | 계약서 크기 초과 |
| `415` | 계약서 형식 미지원 |
| `422` | 근로계약서로 확인할 수 없는 문서 |
| `429` | 외부 공급자 요청 제한 |
| `500` | 내부 오류 |
| `502` | 내부 분석 서비스의 잘못된 응답 |
| `503` | DB·RAG·분석 공급자 사용 불가 |
