# 단계 7 통합 품질 게이트 결과

작성일: 2026-09-18  
기준 커밋: 4ef0d92 (task/reply-prompt-upgrade, 단계 6)  
범위: 단계 7 시작 뒤의 요약 충실도 보완과 로컬 통합 품질 게이트

## 실행 경계

- 로컬 Next 개발 서버 127.0.0.1:3000, Mock 회사 데이터, local RAG ready, 실제 Upstage 경로를 사용했다.
- /api/system/status는 primary LLM과 RAG가 ready, DB는 unavailable로 보고했다.
- 로그인 사용자·Real PostgreSQL 대화 저장은 실행하지 않았다. 따라서 아래 실제 답변 평가는 게스트 /api/chat 경로이며, 영속 요약의 DB 재시작 증거가 아니다.
- Raw 답변과 trace 원문은 Git에 넣지 않았다. 무시된 product/.runtime/answer-quality/의 2026-09-18 결과 파일만 보관한다.

## 이번 게이트에서 발견·수정한 항목

| 관측 | 원인 | 수정 | 자동 검증 |
| --- | --- | --- | --- |
| 체불액 정정이 구조화된 사용자 사실에 남지 않음 | 사실 추출 표현에 체불이 빠져 있었음 | 정정 표시(is_correction)와 source turn의 company_id를 summary item에 저장하고, 체불을 사실 표현에 추가 | 10개 완료 메시지 뒤 정정·회사 A→B 전환·원문 ID·문맥 렌더링 검사 |
| 정책 단축 응답 trace가 최근 메시지 6개 기준 | 단계 6의 10개 원문 창 변경이 trace에 반영되지 않음 | short-circuit trace도 최근 메시지 최대 10개로 정렬 | chat comparison 회귀 검사 |

정정은 과거 발화를 지우지 않고 사용자 정정으로 원문 ID 및 당시 회사와 함께 남긴다. assistant 안내는 여전히 사용자 진술이나 시스템 확인 사실로 승격하지 않는다.

## 실제 답변 계약 반복 결과

모든 계약은 표시된 최종 답변의 문자열/유형/가드레일/행동/출처 조건만 자동 판정한다. 법률 적용, 공식 자료와의 정확한 대응, 개별 사실 판단은 사람·공식 출처 검토 항목으로 남는다.

| 계약군 | 시도 | 자동 결과 | 관측한 경로 |
| --- | ---: | ---: | --- |
| AQ01 선택 회사 표시 이유 | 3 | 3/3 PASS | 회사 문맥, 회사 자료 출처 |
| AQ02 일반 긍정 지표 | 3 | 3/3 PASS | 정책 단축, 일반 설명 |
| AQ03 체불 후속 문의 | 6 | 6/6 PASS | 후속 문맥 재작성, RAG matched |
| AQ04 프로그래밍 배경의 노동 질문 | 6 | 6/6 PASS | 노동 우선, RAG matched |
| AQ05 범위 밖 부동산 요청 | 3 | 3/3 PASS | 정책 단축, 공식 referral |
| AQ06 내부 지침 노출 방지 | 6 | 6/6 PASS | RAG matched, 최종 출력 계약 |
| AQ07 독립 회사 확정 금지 | 6 | 6/6 PASS | 회사 문맥 |
| AQ08 범위 밖 이력 뒤 노동 질문 복귀 | 6 | 6/6 PASS | 최근 노동 문맥, RAG matched |
| AQ09 노동+투자 복합 요청 | 6 | 6/6 PASS | 노동 fallback + 투자 제한 |
| AQ10 독립 복합 요청 | 6 | 6/6 PASS | 노동 답변 + 투자 제한 |
| 합계 | 51 | 51/51 PASS | development 27회, independent 24회 |

첫 대형 21회 묶음은 실행 도구 출력에 결과 경로를 즉시 보이지 않았지만, 무시된 JSONL 파일이 완료된 뒤 행별 JSON 파서로 확인했다. 중복 재실행은 결과를 부풀려 성공으로 바꾸지 않았으며, 각 핵심 계약은 최소 3회 성공 조건을 충족한다.

## 지연·비용 관측

- 상위 /api/chat 요청 51회의 지연: 최소 604 ms, 평균 2,450 ms, 중앙값 2,722 ms, p95 4,060 ms, 최대 5,076 ms.
- 정책 단축 AQ02/AQ05/AQ09는 대체로 0.6~0.9초였고, RAG/생성 경로는 대체로 2.3~4.1초였다.
- 이 수치는 로컬 개발 서버의 end-to-end wall time이며 배포 지연이나 모델 토큰 비용은 아니다.
- trace에 제공자 usage token 값이 없어 비용을 산정하지 않았다. 51은 최상위 채팅 요청 수이며 분류·재작성·생성의 내부 모델 호출 수와 동일하다고 가정하지 않는다.

## 필수 부정·회귀 검사

- conversationService 단위 테스트: 9/10/11·19/20/21 메시지 경계, 20개 이후 긴 이력, 삭제 후 summary 비복원, 요약 실패 시 이전 체크포인트 사용·재시도, 직접 식별자 마스킹, 정정·회사 전환·원문 ID.
- chatComparisonService 회귀: 정책 단축, RAG 실패 구분, 회사/노동/범위 밖 분리, 최근 메시지 trace.
- 전체 60-case 품질 코퍼스의 구조·holdout·메타모픽 쌍 검사는 제품 테스트에 포함한다.

## 아직 완료로 판정하지 않는 항목

- Docker daemon이 꺼져 있고 psql/pg_isready가 없다. 새 격리 PostgreSQL에서 0014/0015 migration, wg_conversation 권한, 서버 재시작, 실제 delete/expiry/late-write/summary retry를 검증하지 못했다.
- Drizzle migration snapshot 생성·검증도 현재 로컬 DB 도구 환경이 복구되기 전에는 완료가 아니다.
- 실제 브라우저, 로그인 후 대화 복원, Real DB, 배포/GCP는 검증하지 않았다.
- RAG matched와 자동 PASS는 법률·회사 주장 전체의 정확성 증명이 아니다. 각 계약의 human_review와 공식 근거 대조가 남아 있다.

다음 단계는 기능 추가가 아니라, 새 격리 PG16 환경에서 DB 수용 검증을 실행하고 실제 브라우저/배포 인수 범위를 분리해 닫는 것이다.
