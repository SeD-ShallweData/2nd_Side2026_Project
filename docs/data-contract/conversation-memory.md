# 상담 메모리·컨텍스트 저장 계약

- 계약 버전: `conversation-memory.v1.0`
- 상태: 인계용 설계 초안 / 이 문서로 DB migration·운영 정책을 확정하지 않음
- 대상: PostgreSQL 16, 제품 상담 백엔드, RAG 연동
- 근거: [`wage-risk.md` 3.4절](wage-risk.md)

## 초안 인계 범위 (2026-09-18)

기존 로컬 초안을 저장소에서 참조할 수 있도록 보존한다. 성현의 담당 범위는 저장 대상과 민감정보 처리 초안 작성까지이며, 전체 기억 시스템·DB·인증·보존 작업의 구현을 맡는다는 뜻이 아니다. 아래 스키마와 보존기간은 구현 완료 상태가 아니라 제안이다.

| 팀에서 확정할 항목 | 현재 초안 | 결정·구현 담당 영역 |
| --- | --- | --- |
| 저장 필드와 민감정보 제거 | 원문·계약서 대신 구조화 요약·파일 참조. 요약에도 개인 식별·민감정보가 남을 수 있으므로 저장 전 제거 규칙 필요 | 제품·DB·상담 담당 |
| 보존기간 | 90일·30일·15분은 제안값, 법정 보존기간 또는 합의 완료값이 아님 | 제품·DB 담당 |
| 삭제·참조 무효화 | 논리 삭제 및 파일/동의 참조 무효화 제안. 실제 삭제·보관 정책 확정 필요 | DB·파일 저장소 담당 |
| 외부 전송 동의 | 감독관 값은 승인 없으면 전송하지 않음. 승인 범위·만료·철회 구현 필요 | 제품·상담 담당 |

기억에 ML 값을 저장하지 않고 company_id로 최신 자료를 재조회한다는 경계는 유지한다. 합의 결과는 이 문서에 별도 날짜·근거를 기록하며, 초안 PR 병합만으로 모든 제안이 확정된 것으로 처리하지 않는다.

## 1. 목적과 범위

### 2026-09-21 구현과 초안의 경계

아래 2~6절은 여전히 미승인 초안이다. 이미 구현된 로그인 상담의 `conversation_threads/turns/messages/sources/company_events/summaries/requests` 7개 테이블을 대체하거나 같은 원문·요약을 두 초안 테이블에 다시 저장하라는 지시가 아니다. 현재 구현은 원문/최종 표시 답변, 서버 소유 요약, 요청 재사용과 활동 기준 30일 보존을 담당한다. 이 사실은 개인정보 정책·외부 전송 동의가 최종 승인됐다는 뜻은 아니다.

PR #115에서 확정된 것은 `user_favorite_firms` 및 wg_auth SELECT/INSERT/DELETE와 후조건이다. 관심 상태 자체는 이 테이블을 기준으로 하고, 교차 기능 이벤트에 관심 이력을 추가로 보존할지는 별도 결정한다. 익명 상담을 로그인 상담으로 가져오는 화면 동의와 `inspector_context_external` 전송 동의도 서로 다르다.

책임 비교, 미확정 보존·철회·탈퇴 범위와 나연에게 보낼 **미전송 문안**은 [후속 06 보고서](../qa/2026-09-21-followup-06.md)에 기록했다. 이번에는 `chat_memory_events/chat_memory_consents`를 구현하지 않았다.

사업장·근로계약서 화면에서 상담으로 넘어갈 때 사용자의 선택, 질문, 파일 작업 이력을
다음 상담의 참고자료로 제공한다. 메모리는 **사업장 위험 결과의 캐시가 아니다.**

이번 단계에서 저장하는 것은 다음 세 가지다.

1. 사용자의 명시적 행동: 사업장 선택·관심 등록·계약서 검토·게시물/댓글 작성
2. 상담에 유용한 구조화 정보: 질문 주제, 해결되지 않은 후속 질문, 사용자가 선택한 `company_id`
3. 파일 참조 메타데이터: 파일 ID·형식·해시·검토 결과 참조. 원본 파일과 전문은 저장하지 않는다.

저장하지 않는 것은 원시 ML 점수·등급·SHAP·피처, 사업장명으로 추정한 식별자, 원본 계약서,
승인 없는 감독관 컨텍스트, 검증되지 않은 RAG 답변이다.

## 2. 저장 스키마 초안

### 2.1 `chat_memory_events`

사용자 행동과 상담에 필요한 최소 사실을 append-only 이벤트로 저장한다.

| 컬럼 | 타입/제약 | 내용 |
| --- | --- | --- |
| `id` | UUID PK | 이벤트 식별자 |
| `user_id` | UUID NOT NULL FK | 로그인 사용자. 익명은 영속 메모리를 만들지 않음 |
| `conversation_id` | UUID NULL | 발생한 상담 세션 |
| `event_type` | TEXT CHECK | `company_selected`, `company_interest`, `chat_topic`, `unresolved_question`, `contract_review`, `file_attached`, `post_created`, `comment_created` |
| `company_id` | TEXT NULL FK `firms.firm_id` | 사업장 연결은 이 값만 사용. 이름·`biz_no` 금지 |
| `memory_payload` | JSONB NOT NULL | 허용된 구조화 값만 저장 |
| `source_ref` | JSONB NULL | `source_type`, `source_id`, `citation` 등 provenance |
| `occurred_at` | TIMESTAMPTZ NOT NULL | 실제 사용자 행동 시각 |
| `expires_at` | TIMESTAMPTZ NULL | 이벤트 종류별 보존 종료 시각 |
| `deleted_at` | TIMESTAMPTZ NULL | 사용자 삭제 요청의 논리 삭제 |
| `created_at` | TIMESTAMPTZ NOT NULL | 적재 시각 |

`memory_payload` 허용 예시는 다음과 같다.

```json
{
  "topic": "wage_arrears",
  "question_summary": "퇴직 후 임금 지급 시기를 확인하고 싶음",
  "document": {
    "file_id": "file_...",
    "media_type": "application/pdf",
    "sha256": "...",
    "size_bytes": 182034,
    "review_status": "completed"
  },
  "user_confirmed": true
}
```

원문 질문은 기본 저장하지 않는다. 제품 요구로 원문 보관이 필요해질 때는 별도 동의,
암호화, 보존기간, 삭제 API를 먼저 확정한다. `memory_payload`에 `risk_full`, `risk_tier`,
`queue_priority`, `rank`, `shap`, `percentile`, `batch_id`, 원시 피처, 감독관 `reasons`를
넣는 것은 금지한다.

### 2.2 `chat_memory_consents`

감독관 컨텍스트를 외부 LLM에 전달할 수 있는지 기록한다.

| 컬럼 | 타입/제약 | 내용 |
| --- | --- | --- |
| `id` | UUID PK | 승인 식별자 |
| `user_id` | UUID NOT NULL FK | 승인 주체 |
| `conversation_id` | UUID NOT NULL | 승인 범위 |
| `scope` | TEXT CHECK | 현재 허용값 `inspector_context_external` |
| `approved_at` | TIMESTAMPTZ NOT NULL | 명시적 승인 시각 |
| `expires_at` | TIMESTAMPTZ NOT NULL | 대화 종료 또는 짧은 TTL |
| `revoked_at` | TIMESTAMPTZ NULL | 철회 시각 |
| `approved_provider` | TEXT NULL | 승인된 외부 LLM 공급자 |

승인 행이 없거나 만료·철회됐으면 감독관 값은 외부 프롬프트에 넣지 않는다. 승인 여부와
전달 범위는 실행 trace에 남기되, 내부 위험 값은 일반 사용자 메모리에 복사하지 않는다.

## 3. 읽기·쓰기 로직

### 상담 시작 전

1. 인증된 `user_id`와 `conversation_id`를 확정한다. 익명 사용자는 현재 요청의 최근 메시지만 사용한다.
2. `chat_memory_events`에서 `deleted_at IS NULL`, `expires_at` 미경과인 이벤트를 조회한다.
3. 현재 대화의 정확한 `company_id`가 있으면 해당 ID의 이벤트만 사업장 연결 기억으로 사용한다.
4. 이벤트의 `company_id`만으로 `firms`, `safe_recommendation`, 산업안전 공개 뷰를 **매번 재조회**한다.
5. RAG는 질문을 새로 검색하고, 이전 검색 결과나 모델 답변을 법적 근거로 재사용하지 않는다.
6. 구조화된 메모리 요약과 최신 조회 결과를 분리해 프롬프트에 넣는다. 메모리 요약이 최신 DB 값을 덮어쓰면 안 된다.
7. `scope=inspector_context_external` 승인 없이는 감독관 테이블 값을 외부 LLM에 전달하지 않는다.

### 상담 종료 후

- 성공한 행동만 이벤트로 기록한다. 요청 수신만으로 `company_interest`를 만들지 않는다.
- 질문은 `topic`, `question_summary`, `unresolved` 같은 최소 구조로 정규화한다.
- 계약서는 `file_id`, 해시, MIME, 크기, 검토 상태만 기록한다. 원본은 별도 보안 저장소와 별도 보존정책을 사용한다.
- ML 조회 결과의 값은 기록하지 않는다. 필요하면 `looked_up_at`, `data_as_of`, `source_status`만 provenance로 남긴다.
- LLM 공급자, 프롬프트 원문, API 키, 원시 응답은 메모리 이벤트에 저장하지 않는다.

## 4. 보존·권한·삭제

| 대상 | 보존 기본값 | 접근 |
| --- | --- | --- |
| `company_selected`, `company_interest` | 90일, 관심 등록은 사용자가 해제할 때까지 | 해당 사용자 + 서버 |
| `chat_topic`, `unresolved_question` | 30일 | 해당 사용자 + 서버 |
| `contract_review`, 파일 메타데이터 | 30일 | 해당 사용자 + 계약 서비스 |
| `post_created`, `comment_created` 참조 | 원 게시물 정책과 동일 | 게시물 권한 + 서버 |
| 외부 컨텍스트 승인 | 대화 종료 또는 15분 중 빠른 시점 | 서버 감사 로그 |

DB 쓰기 계정은 읽기 전용 제품 계정과 분리한다. 사용자는 메모리 조회·삭제를 요청할 수
있어야 하며, 삭제 시 이벤트·동의·파일 참조를 함께 무효화한다. `company_id` FK 삭제 시
연결 이벤트는 보존하지 않고 `deleted_at` 처리한다.

## 5. 누락 방지 시나리오와 합격 조건

| 시나리오 | 합격 조건 |
| --- | --- |
| 회사명만 말하고 ID가 없음 | 회사 컨텍스트·위험 조회·메모리 연결을 하지 않는다 |
| 회사 A에서 회사 B로 이동 | B의 `company_id`만 최신 컨텍스트로 사용하고 A 값을 섞지 않는다 |
| 배치 갱신 후 재상담 | 저장된 ML 값이 없고 최신 `data_as_of`를 재조회한다 |
| 일반 사용자 상담 | `risk_full`, `risk_tier`, SHAP, 순위, 내부 배치가 프롬프트·응답에 없다 |
| 감독관 상담 승인 없음 | 내부 감독관 컨텍스트를 외부 LLM에 보내지 않는다 |
| 감독관 상담 승인 만료 | 승인 만료 후 동일하게 차단하고 재승인을 요구한다 |
| 계약서 재상담 | 원본 파일을 메모리로 보내지 않고 파일 참조·검토 상태만 사용한다 |
| RAG no-match/장애 | 이전 답변을 법령 출처로 재사용하지 않고 제한 상태를 표시한다 |
| 사용자 삭제 | 해당 사용자의 이벤트·동의·파일 참조가 재조회되지 않는다 |
| 익명 사용자 | 세션 밖 영속 메모리를 생성하지 않는다 |

## 6. 구현 순서와 담당 인계

1. 창의: 현재 RAG·상담 파이프라인에 `memory read -> fresh company/RAG lookup -> prompt` 경계를 발표자료 수준으로 공유한다.
2. 프롬프트 담당: 메모리 요약 JSON과 최신 공개 컨텍스트를 구분하는 시스템 프롬프트·가드레일을 정의한다.
3. 나연: 위 두 테이블과 인덱스, 사용자 삭제/보존 job, 쓰기 role을 migration으로 구현한다.
4. 제품 담당: `user_id` 인증 연결, 이벤트 기록 adapter, 메모리 조회 service, 승인 검사와 trace를 구현한다.
5. QA: 위 시나리오를 테스트로 고정하고 `wage-risk.md` 3.4절 위반 필드가 추가되지 않았는지 정적 검사를 둔다.

이번 문서는 설계 계약이다. 실제 테이블·migration을 만들기 전 개인정보 보존기간과 원문 질문
저장 여부를 팀 결정으로 확정해야 한다.
