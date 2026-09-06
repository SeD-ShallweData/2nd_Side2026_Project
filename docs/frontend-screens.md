# 프론트엔드 화면 분석 (사업장 확인 / AI 상담 / 근로감독관)

> 분석 범위: `product/src/app/companies/**`, `product/src/app/chat/**`, `product/src/app/inspector/**`,
> `product/src/components/company/**`, `product/src/components/risk/**`, `product/src/components/chat/**`,
> `product/src/components/inspector/**`, `product/src/components/common/**`, `product/src/app/globals.css`
>
> 데이터 흐름 파악을 위해 `services/**`, `adapters/**`, `domain/**`, `app/api/**`, `mocks/**`, `config/dataMode.ts`도
> 읽기 전용으로 함께 확인했다(수정 없음). 코드에서 직접 확인한 내용만 기록했고, 확인되지 않은 부분은 "확인 필요"로 표기했다.

---

## 1. 화면 목록

| 화면 이름 | URL 경로 | page 파일 경로 | 사용하는 주요 컴포넌트 |
|---|---|---|---|
| 사업장 검색 | `/companies` | [product/src/app/companies/page.tsx](../product/src/app/companies/page.tsx) | `CompanySearch` → `CompanySearchResultCard`, `LoadingSkeleton`/`EmptyState`/`ErrorState`(common) |
| 사업장 상세 | `/companies/[companyId]` | [product/src/app/companies/[companyId]/page.tsx](../product/src/app/companies/%5BcompanyId%5D/page.tsx) | `CompanyDetail` → `RiskInformationCard`(×2, 임금/안전), `DataFreshnessNotice`, `ActionChecklist`, `LimitationNotice`, `LoadingSkeleton`/`ErrorState` |
| AI 노동 상담 | `/chat` | [product/src/app/chat/page.tsx](../product/src/app/chat/page.tsx) | `ChatPanel` → `ProviderAnswerCard`, `ComparisonBlock`, `SafeMarkdown`, `DataSourceList` |
| 근로감독관 대시보드 | `/inspector` | [product/src/app/inspector/page.tsx](../product/src/app/inspector/page.tsx) | `InspectorNav`, `InspectorDashboard` → `QueueTable`, `DetailPanel` |
| 근로감독관 AI 점검 보조 | `/inspector/chat` | [product/src/app/inspector/chat/page.tsx](../product/src/app/inspector/chat/page.tsx) | `InspectorNav`, `InspectorChatPanel` → `DataSourceList` |

공통 레이아웃 컴포넌트(`SiteHeader`, `SiteFooter`/`SiteFooterView`)는 루트 레이아웃에서 전 화면에 공통 적용되는 것으로 보이나,
루트 `layout.tsx`는 이번 분석 대상 경로(`app/companies`, `app/chat`, `app/inspector`, `components/common` 등)에 포함되지 않아
실제 연결 지점은 "확인 필요"로 남긴다. (`components/common/SiteHeader.tsx`, `SiteFooter.tsx` 자체는 분석 대상에 포함되어 아래 표에 기재)

---

## 2. 컴포넌트 표

| 컴포넌트명 | 파일 경로 | 사용 화면 | 받는 props 요약 |
|---|---|---|---|
| `CompanySearch` | [components/company/CompanySearch.tsx](../product/src/components/company/CompanySearch.tsx) | `/companies` | 없음(자체 상태로 검색어·필터·페이지 관리) |
| `CompanySearchResultCard` | [components/company/CompanySearchResultCard.tsx](../product/src/components/company/CompanySearchResultCard.tsx) | `/companies` (검색 결과 목록) | `company: CompanySearchResult`, `onSelect(companyId): void` |
| `CompanyDetail` | [components/company/CompanyDetail.tsx](../product/src/components/company/CompanyDetail.tsx) | `/companies/[companyId]` | `company: Company`, `dataMode: "mock" \| "real"` |
| `RiskInformationCard` | [components/risk/RiskInformationCard.tsx](../product/src/components/risk/RiskInformationCard.tsx) | `/companies/[companyId]` (임금/안전 카드 각 1회) | `kind: "wage" \| "safety"`, `data: WageRiskPublic \| SafetyContextPublic`, `dataAsOf: string \| null`, `sources: SourceReference[]`, `onAsk(question): void` |
| `ChatPanel` | [components/chat/ChatPanel.tsx](../product/src/components/chat/ChatPanel.tsx) | `/chat` | `companyId?`, `companyName?`, `suggestedPrompt?`, `chatMode?: ChatMode`, `executionMode?: ConfiguredChatExecutionMode` |
| `ProviderAnswerCard` (내부 함수) | ChatPanel.tsx 내부 | `/chat` | `result: ProviderComparisonResult` |
| `ComparisonBlock` (내부 함수) | ChatPanel.tsx 내부 | `/chat` | `comparison: ChatComparisonResponse`, `selected?`, `onSelect(selection): void` |
| `InspectorNav` | [components/inspector/InspectorNav.tsx](../product/src/components/inspector/InspectorNav.tsx) | `/inspector`, `/inspector/chat` | `current: "dashboard" \| "chat"` |
| `InspectorDashboard` | [components/inspector/InspectorDashboard.tsx](../product/src/components/inspector/InspectorDashboard.tsx) | `/inspector` | 없음(자체 상태) |
| `QueueTable` (내부 함수) | InspectorDashboard.tsx 내부 | `/inspector` | `items: InspectorQueueItem[]`, `onSelect(id): void` |
| `DetailPanel` (내부 함수) | InspectorDashboard.tsx 내부 | `/inspector` | `detail: InspectorCompanyDetail` |
| `InspectorChatPanel` | [components/inspector/InspectorChatPanel.tsx](../product/src/components/inspector/InspectorChatPanel.tsx) | `/inspector/chat` | `companyId?: string` |
| `LoadingSkeleton` | [components/common/AsyncStates.tsx](../product/src/components/common/AsyncStates.tsx) | `/companies`, `/companies/[companyId]` | `label?: string` |
| `EmptyState` | AsyncStates.tsx | `/companies` | `title`, `description`, `action?` |
| `ErrorState` | AsyncStates.tsx | `/companies`, `/companies/[companyId]` | `message: string`, `onRetry?(): void` |
| `LimitationNotice` | AsyncStates.tsx | `/companies/[companyId]` | `children: ReactNode` |
| `DataFreshnessNotice` | [components/common/DataFreshnessNotice.tsx](../product/src/components/common/DataFreshnessNotice.tsx) | `/companies/[companyId]` | `freshness: Freshness`, `dataAsOf`, `validUntil`, `targetMonth?` |
| `ActionChecklist` | [components/common/ActionChecklist.tsx](../product/src/components/common/ActionChecklist.tsx) | `/companies/[companyId]` | 없음(자체 상태, 브라우저 로컬 체크 상태만 유지) |
| `DataSourceList` | [components/common/DataSourceList.tsx](../product/src/components/common/DataSourceList.tsx) | `/companies/[companyId]`, `/chat`, `/inspector/chat` | `sources: SourceReference[]` |
| `StatusBadge` | [components/common/StatusBadge.tsx](../product/src/components/common/StatusBadge.tsx) | `/companies/[companyId]` (RiskInformationCard 내부) | `level: SignalLevel` |
| `SafeMarkdown` | [components/common/SafeMarkdown.tsx](../product/src/components/common/SafeMarkdown.tsx) | `/chat` (ProviderAnswerCard 내부) | `children: string` |
| `SiteHeader` / `Brand` | [components/common/SiteHeader.tsx](../product/src/components/common/SiteHeader.tsx) | 전역(연결 지점 확인 필요) | 없음 |
| `SiteFooter` | [components/common/SiteFooter.tsx](../product/src/components/common/SiteFooter.tsx) | 전역(연결 지점 확인 필요) | 없음(서버에서 `dataMode` 계산 후 `SiteFooterView`에 전달) |
| `SiteFooterView` | [components/common/SiteFooterView.tsx](../product/src/components/common/SiteFooterView.tsx) | 전역 | `dataMode: "real" \| "mock"` |

---

## 3. 데이터 흐름

### 3-1. 데이터 모드 스위치
[config/dataMode.ts](../product/src/config/dataMode.ts)가 `APP_DATA_MODE`(기본값 `"real"`) / `COMPANY_DATA_MODE` 환경변수로
사업장·리스크 데이터 소스를 결정한다. [services/providers.ts](../product/src/services/providers.ts)가 이 값에 따라
Mock 구현체와 Real(DB) 구현체 중 하나를 반환한다.

```
getCompanyDataMode() === "real"  → RealCompanyRepository / MlRiskProvider (PostgreSQL)
getCompanyDataMode() === "mock"  → MockCompanyRepository / MockRiskProvider (mocks/*.ts)
```

### 3-2. 사업장 검색 (`/companies`)
- 호출 경로: `CompanySearch.tsx` → `fetch("/api/companies/search?...")` → [app/api/companies/search/route.ts](../product/src/app/api/companies/search/route.ts)(확인 필요: 라우트 내부 구현은 이번 분석 대상 밖) → `services/companyService.ts: searchCompanies()` → `services/providers.ts: getCompanyRepository()`
- Mock 사용 시: [mocks/companies.ts](../product/src/mocks/companies.ts)의 `MOCK_COMPANIES` 배열을 [adapters/mock/MockCompanyRepository.ts](../product/src/adapters/mock/MockCompanyRepository.ts)가 이름/별칭 매칭·필터링·페이지네이션 처리.
  - 검색어를 정규화했을 때 `"error"`가 되면 `ServiceError("COMPANY_SOURCE_UNAVAILABLE", 503)`를 강제로 던지는 **데모용 오류 트리거**가 존재한다 (MockCompanyRepository.ts:50-57).
- 필터 옵션: `CompanySearch.tsx`가 `fetch("/api/companies/filters")` 호출 → `companyService.ts: getCompanyFilterOptions()`.
- Mock 모드에서는 `services/companyService.ts`가 `getMockDelayMs()`(기본 250ms, 0~2000ms 클램프)만큼 인위적 지연을 추가한다.

### 3-3. 사업장 상세 (`/companies/[companyId]`)
- page.tsx가 서버 컴포넌트에서 `services/companyService.ts: getCompanyById()`로 회사 기본정보를 먼저 조회(없으면 `notFound()`로 Next.js 404 처리).
- `CompanyDetail.tsx`가 클라이언트에서 `fetch("/api/companies/{id}/risk")` → [app/api/companies/[companyId]/risk/route.ts](../product/src/app/api/companies/%5BcompanyId%5D/risk/route.ts) → `services/riskService.ts: getCompanyRisk()` → `getRiskProvider()`.
- Mock 사용 시: [mocks/risks.ts](../product/src/mocks/risks.ts)의 `MOCK_RISKS` 맵(회사 ID 키)을 [adapters/mock/MockRiskProvider.ts](../product/src/adapters/mock/MockRiskProvider.ts)가 그대로 반환.
  - `companyId === "ERROR_001"`이면 `ServiceError("RISK_SOURCE_UNAVAILABLE", 503)`를 던지는 **데모용 오류 트리거** 존재 (MockRiskProvider.ts:7-13).
- Real 사용 시: [adapters/real/MlRiskProvider.ts](../product/src/adapters/real/MlRiskProvider.ts)가 PostgreSQL(`public.firms`, `public.scored_active`, `public.safe_recommendation`, `industrial_safety.v_llm_firm_safety_context`)을 조회. 이 경로에서는 `valid_until`이 항상 `null`, `freshness`가 항상 `"unknown"`으로 고정된다(MlRiskProvider.ts:323-324) → 실제 DB 연동 모드에서는 신선도 배너가 항상 "확인 필요" 상태로 표시됨.

### 3-4. AI 노동 상담 (`/chat`)
- `ChatPanel.tsx` → `fetch("/api/chat")` → [app/api/chat/route.ts](../product/src/app/api/chat/route.ts) → `services/chatExecutionService.ts: sendConfiguredChatMessage()`.
- 실행 모드(`getChatExecutionMode()`, [server/responses/responsesConfig.ts](../product/src/server/responses/responsesConfig.ts), 분석 대상 밖) 값에 따라
  - `"dual_api"`: `services/chatComparisonService.ts`가 Upstage/SKT 실제 LLM API를 동시 호출(모의 데이터 아님, `adapters/real/DualLlmChatProvider.ts`, `OpenAICompatibleChatClient.ts`)
  - `"openai_responses"`: `services/responsesChatService.ts`(확인 필요: 세부 파일은 이번 분석 범위 밖)가 OpenAI Responses API를 도구 호출과 함께 사용
- `adapters/mock/MockChatProvider.ts`(`PolicyChatProvider`)는 실제 LLM 응답이 아니라 **정책 기반 baseline/폴백 문구**를 생성하는 용도로만 쓰인다(가드레일 대체 답변 등). `mocks/chatResponses.ts`는 코드 검색 결과 실제 서비스 흐름에서 사용되는 지점을 찾지 못했다 — **확인 필요**.
- 피드백 저장: `fetch("/api/chat/feedback")` → [app/api/chat/feedback/route.ts](../product/src/app/api/chat/feedback/route.ts)(분석 대상 밖, 내부 구현 확인 필요).

### 3-5. 근로감독관 대시보드 (`/inspector`)
- `InspectorDashboard.tsx` → `fetch("/api/inspector/overview?...")`, `fetch("/api/inspector/companies/{id}")`, `fetch("/api/inspector/companies/search?...")`.
- `services/inspectorService.ts`가 이 요청들을 처리하며, **Mock/Real 스위치 없이 항상 PostgreSQL을 직접 조회**한다(`public.batches`, `public.inspector_queue`, `public.firms`, `industrial_safety.v_llm_firm_safety_context`). `config/dataMode.ts`의 `getCompanyDataMode()`를 사용하지 않으므로 감독관 화면에는 별도 Mock 데이터 경로가 없다.

### 3-6. 근로감독관 AI 점검 보조 (`/inspector/chat`)
- `InspectorChatPanel.tsx` → `fetch("/api/inspector/companies/{id}")`(컨텍스트 로드) 후 `fetch("/api/inspector/chat")` → `services/inspectorService.ts: sendInspectorChatMessage()`.
- 실제 사업장 DB 컨텍스트(`getInspectorCompanyDetail`)와 `services/ragService.ts: retrieveLaborLawContext()`(공식 근거 검색, 분석 대상 밖 — 확인 필요) 결과를 최소화하여 Upstage/SKT 실제 API에 시스템 프롬프트로 전달한다(`OpenAICompatibleChatClient`).

---

## 4. 상태 처리 현황 표

범례: **O** = 코드에서 구현 확인 / **X** = 해당 화면·컴포넌트에 구현되어 있지 않음(개념상 필요하나 누락) / **N/A** = 해당 화면·컴포넌트 성격상 이 상태 개념이 적용되지 않음(누락으로 보지 않음)

> "빈 값"과 "unknown"은 다른 개념으로 구분했다: 빈 값=목록/결과가 0건, unknown=자료 부족으로 판단 불가(0이나 미충족과 다름을 명시적으로 표시).

| 화면/컴포넌트 | 로딩 중 | 결과 없음(빈 값) | unknown(자료 부족) | 서버 오류 |
|---|---|---|---|---|
| **사업장 검색** `/companies` (CompanySearch.tsx) | **O** — `LoadingSkeleton` 표시 (CompanySearch.tsx:233) | **O** — `EmptyState` "검색 결과가 없습니다" (CompanySearch.tsx:235-240) | N/A | **O** — `ErrorState`+재시도 버튼, mock `"error"` 검색어로 503 재현 가능 (CompanySearch.tsx:234; MockCompanyRepository.ts:50-57) |
| ├ 필터 목록 로드 | **O** — "지역·업종 목록을 불러오는 중입니다." (CompanySearch.tsx:168) | **X** — regions/industries가 빈 배열이어도 별도 안내 없이 "전체 지역/업종" 옵션만 남음 | N/A | **O** — 오류 문구+"다시 시도" (CompanySearch.tsx:169-174) |
| **사업장 상세** `/companies/[companyId]` (CompanyDetail.tsx) | **O** — `LoadingSkeleton` "임금·산업재해 신호를 불러오고 있습니다." (CompanyDetail.tsx:83) | **X** — 로딩 완료 후 `risk`가 없고 `error`도 없는 경우(이론상 도달 어려움) 화면이 빈 채로 남음, 전용 빈 상태 UI 없음 (CompanyDetail.tsx:82-151) | **O** — `RiskInformationCard`의 unknown 패널, `DataFreshnessNotice`의 `freshness==="unknown"` 배너 (RiskInformationCard.tsx:99-104; DataFreshnessNotice.tsx:15-21) | **O** — `ErrorState`+재시도, mock `ERROR_001` ID로 재현 가능 (CompanyDetail.tsx:84; MockRiskProvider.ts:7-13) |
| ├ 사업장 자체를 찾을 수 없음(회사 미존재) | N/A | N/A | N/A | **O**(404) — page.tsx에서 `notFound()` 호출, Next.js 기본 404 처리 (page.tsx:26-28) — 커스텀 안내 문구는 **확인 필요**(not-found.tsx가 분석 범위 밖) |
| **RiskInformationCard** (임금/안전 공용) | N/A(부모가 로딩 처리) | **O**(부분) — evidence_items가 0개면 "추가로 표시할 세부 확인 신호는 없습니다" (RiskInformationCard.tsx:95-97). 단, `availability:"no_data"` 자체를 별도 문구로 구분하지 않고 unknown 패널과 동일하게 처리됨 | **O** — `level==="unknown"`일 때 "결과를 추정하지 않습니다" 전용 패널, 0/미충족과 시각적으로 구분 (RiskInformationCard.tsx:99-104) | **O** — `availability==="unavailable"`일 때 "현재 연결 상태를 확인해 주세요" 패널(공급자 무응답, unknown과 구분) (RiskInformationCard.tsx:75-79) |
| **DataSourceList** | N/A | **O** — "확인 가능한 출처가 없습니다." (DataSourceList.tsx:4-6) | N/A | N/A |
| **AI 노동 상담** `/chat` (ChatPanel.tsx) | **O** — 듀얼/단일 모델별 로딩 문구 (ChatPanel.tsx:452-469) | N/A(항상 답변 또는 오류) | **O**(부분) — RAG 상태 미확인 시 "공식 근거 상태 미확인" 라벨 (ChatPanel.tsx:184-185) | **O** — `chat-error` 문구 (ChatPanel.tsx:479); 프로바이더별 실패는 `ProviderAnswerCard`의 `provider-error` 블록으로 개별 표시 (ChatPanel.tsx:102-107) |
| ├ 피드백 저장 실패 | N/A | N/A | N/A | **O** — 저장 실패 시 화면 반영은 유지하되 별도 안내 문구 표시 (ChatPanel.tsx:386-389) |
| **근로감독관 대시보드** `/inspector` — 상단 통계 | **O** — 개별 값 로드 전 "—" 표시 (InspectorDashboard.tsx:271-274) | **X** — 큐/채점 수가 0이어도 통계 카드 자체는 숫자만 표시, 전용 빈 상태 없음(0 표기와 자료없음 구분 없음) | N/A(통계는 항상 숫자 반환 전제) | **O** — 상단 공용 오류 배너 (InspectorDashboard.tsx:263) |
| ├ 위험큐 테이블 | **O** — 페이지 이동 중 로딩 클래스 적용 (InspectorDashboard.tsx:306,310) | **X** — `top_queue`가 0건이어도 표 헤더만 남고 "결과 없음" 안내 없음 | N/A | 상단 공용 오류 배너에 의존(테이블 자체 전용 오류 UI 없음) |
| ├ 사업장 직접 조회(검색) | **O** — 버튼 라벨 "검색 중" (InspectorDashboard.tsx:287) | **O** — "일치하는 사업장이 없습니다." (InspectorDashboard.tsx:297) | N/A | 상단 공용 오류 배너에 의존 |
| ├ 상세 패널(DetailPanel) | **O** — "사업장 지표를 불러오는 중입니다." (InspectorDashboard.tsx:372) | **O** — 사업장 미선택 시 "사업장을 선택하세요." (InspectorDashboard.tsx:372) | **O** — `model_score===null`을 "채점 불가"+"정보 부족은 0점과 다릅니다"로 명시, `rank===null`을 "상위 3,000 밖"으로, 각 지표 `null`을 "정보 없음"으로 0/false와 구분 (InspectorDashboard.tsx:73-105) | **X** — 상세 조회(`selectCompany`) 실패 시 상단 공용 배너만 표시되고, 패널 자체에는 전용 오류/재시도 UI 없음 |
| **근로감독관 AI 점검 보조** `/inspector/chat` (InspectorChatPanel.tsx) | **O** — 컨텍스트 로딩 "사업장 컨텍스트를 연결하고 있습니다." / 메시지 전송 중 로딩 (InspectorChatPanel.tsx:115; 175) | **O** — `companyId` 없을 때 "분석할 사업장을 먼저 선택해 주세요." (InspectorChatPanel.tsx:104-112) | **O**(부분) — aside의 모델 원점수/순위에 동일한 null-vs-값 구분 표시 (InspectorChatPanel.tsx:126-129) | **O** — `inspector-chat-error` 문구 (InspectorChatPanel.tsx:181); 컨텍스트 로드 실패 시에도 동일 `error` 상태 사용 |

---

## 5. 구현 필요 목록 (위 표에서 X로 표시된 항목)

1. **사업장 검색 – 필터 옵션 빈 목록**: `CompanySearch.tsx`에서 `/api/companies/filters` 응답의 `regions`/`industries`가 빈 배열일 때 안내 문구가 없음. ([CompanySearch.tsx](../product/src/components/company/CompanySearch.tsx) 175-209행)
2. **사업장 상세 – 로딩 완료 후 결과 없음 상태**: `risk`도 `error`도 없는 상태에 대한 전용 빈 화면 UI가 없어 빈 페이지로 보일 수 있음. ([CompanyDetail.tsx](../product/src/components/company/CompanyDetail.tsx) 82-151행)
3. **근로감독관 대시보드 – 상단 통계 카드**: 값이 0인 경우와 아직 로드되지 않은 경우가 시각적으로만 다를 뿐(“—” vs 숫자), 0건 자체에 대한 전용 안내는 없음. ([InspectorDashboard.tsx](../product/src/components/inspector/InspectorDashboard.tsx) 270-275행)
4. **근로감독관 대시보드 – 위험큐 테이블 빈 결과**: `top_queue`가 0건일 때 표 본문이 비어 보이기만 하고 "결과 없음" 안내가 없음. ([InspectorDashboard.tsx](../product/src/components/inspector/InspectorDashboard.tsx) QueueTable, 26-48행)
5. **근로감독관 대시보드 – 상세 패널 전용 오류 처리**: `selectCompany` 실패 시 페이지 상단 공용 배너만 뜨고, 상세 패널(DetailPanel) 자리에는 재시도 버튼 등 전용 오류 UI가 없음. ([InspectorDashboard.tsx](../product/src/components/inspector/InspectorDashboard.tsx) 165-176행, 371-373행)

부가로, **완전히 누락은 아니지만 개선 여지가 있는 항목**(참고용, X는 아님):
- `RiskInformationCard`가 `availability:"no_data"`와 `level:"unknown"`을 같은 UI(unknown 패널)로 처리해, "아직 자료가 적재되지 않음"과 "자료가 부족해 판정 불가"를 화면상 구분하지 못함.

---

## 6. 백엔드에 요청해야 할 데이터 필드 목록

### 6-1. 위험카드(`RiskInformationCard`)에서 이미 화면에 존재하지만 값이 항상 비어 있거나 고정되는 필드
- **`official_listing.as_of`** (임금 명단 공표일): [MlRiskProvider.ts](../product/src/adapters/real/MlRiskProvider.ts) 120-122행 주석에 따르면 "명단 원본의 공표·스냅샷 날짜를 적재하기 전에는 날짜를 추정하지 않는다"며 실서비스(Real) 모드에서 **항상 `null`**로 고정. → 명단 공표일 원본 데이터 연동 필요.
- **`valid_until`** (화면 표시 유효기간): Real 모드에서 **항상 `null`**, 이에 따라 `freshness`도 **항상 `"unknown"`** 고정 (MlRiskProvider.ts:323-324). → 데이터 유효기간 산정 기준 필요.

### 6-2. UI에 "연동 준비 중"으로 명시된 미연결 필드 (임금 카드)
[riskPresentation.ts](../product/src/domain/riskPresentation.ts) 14-18행 `UNCONNECTED_WAGE_OBSERVATION_LABELS`가 정의하고,
[RiskInformationCard.tsx](../product/src/components/risk/RiskInformationCard.tsx) 128-144행이 "확인할 수 없음"으로 하드코딩 렌더링하는 항목:
- **이직률(12개월)**
- **고용 추이**
- **데이터 충실도**

같은 카드 내 문구(RiskInformationCard.tsx:107-110)로 명시된 상태: "공식 명단 1개 확인 / 추가 공개 지표 3개 연동 준비 중" → 위 3개 지표에 대응하는 백엔드 데이터 계약이 필요함을 코드가 직접 표시하고 있음.

### 6-3. `domain/risk.ts` 기준 위험카드 전체 데이터 계약 (참고용 필드 목록)
- `WageRiskPublic`: `availability`, `level`, `summary`, `evidence_codes[]`, `evidence_items[].{code,label,description}`, `confidence`, `official_listing.{status,as_of,source_name}`
- `SafetyContextPublic`: `availability`, `scope`, `level`, `summary`, `region`, `industry`, `target_start`, `target_end`, `evidence_codes[]`, `evidence_items[]`, `confidence`, `disclaimer`
- `CompanyRiskResult` 공통: `data_as_of`, `target_month`, `generated_at`, `valid_until`, `freshness`, `sources[]`
- `SourceReference`: `name`, `category`, `citation`, `organization`, `as_of`, `url`, `document_id`

### 6-4. 근로감독관 상세(`InspectorCompanyDetail`)에서 null 발생이 잦은 필드 (참고용)
`services/inspectorService.ts`의 실제 DB 쿼리 결과 기준, 다음 필드들은 자료가 없으면 `null`을 그대로 반환하며 화면(InspectorDashboard.tsx)이 이를 0과 구분해 "정보 없음"/"채점 불가"로 표시한다: `wage_risk.model_score`, `wage_risk.rank`, `wage_risk.grade`, `wage_risk.arrears_history`, `indicators.observed_months`, `indicators.green_count`, `indicators.green_flags[].value`, `indicators.wage_exclusion`, `indicators.tax_exclusion`. 이 필드들의 null 비율이 높다면 원천 배치 데이터 적재 커버리지 확인이 필요하다 — **확인 필요**(적재 커버리지 수치는 이번 코드 분석 범위 밖).

---

## 건드린 파일 목록

- 생성: `docs/frontend-screens.md` (본 문서)
- 그 외 소스 파일은 읽기만 했으며 수정/생성/삭제하지 않았습니다.
