# 단계 8 실제 화면·운영 인수 결과

작성일: 2026-09-18  
대상 브랜치: `task/reply-prompt-upgrade`  
코드 기준: 단계 6 커밋 `4ef0d92` + 아직 커밋하지 않은 단계 7 통합 품질 게이트 보완

## 판정

로컬 API와 실제 모델 경로 일부는 확인했지만, 단계 8의 브라우저·Real PostgreSQL·배포 인수는 현재 환경에서 완료 판정을 내릴 수 없다. 확인한 사실과 차단 사유를 분리한다.

## 확인한 로컬 런타임

| 항목 | 결과 | 의미와 한계 |
| --- | --- | --- |
| `GET /chat` | `200`, HTML | 로컬 채팅 화면 route가 렌더링된다. 실제 클릭 E2E는 아니다. |
| `GET /companies` | `200`, HTML | 회사 화면 route가 렌더링된다. 실제 카드 선택 E2E는 아니다. |
| `GET /api/system/status` | `200` | Mock 회사·계약 모드, `dual_api`, RAG ready, primary LLM ready를 보고했다. |
| `GET /api/health/live` | `200` | Next 프로세스 생존을 확인했다. |
| `GET /api/health/ready` | `503` | `database=false`, `contract_analysis=false`이므로 운영 준비 완료가 아니다. |
| `GET /api/conversations` | `401` | 비로그인 접근은 차단된다. 로그인 사용자 복원은 미검증이다. |
| 실제 Upstage 답변 계약 | 단계 7에서 `51/51` 자동 PASS | 게스트 `/api/chat` 경로의 계약 결과이며 DB·브라우저 증거는 아니다. |

상태 API의 관측값은 `database unavailable`, `rag ready`, `contract analysis configured_unreachable`, `active chat LLM ready`였다. 따라서 DB가 필요 없는 게스트 답변 경로와 운영 readiness를 혼동하지 않는다.

## 화면 인수: 차단

computer-use 표면에는 사용할 수 있는 브라우저·앱이 없었고, 로컬 Chrome 세션 생성도 `Browser is not available`로 실패했다. 따라서 다음 클릭 확인은 수행하지 못했다.

- 질문 입력, 답변 카드, 회사 선택·변경, 출처와 후속 행동 버튼
- 로그인, 상담 목록, 새로고침·재로그인 뒤 이어하기
- 대화 삭제 뒤 목록·상세·요약이 사라지는지
- 회사 전환 뒤 이전 회사 카드가 남지 않는지
- 계약서 업로드 결과와 RAG 실패 조합

HTTP `200`은 위 화면 동작을 대체하지 않는다. 브라우저가 제공되는 다음 환경에서 게스트와 로그인 사용자를 분리해 이 순서대로 실제 클릭을 검증한다.

## Real PostgreSQL·운영 인수: 차단

- Docker daemon에 연결할 수 없었고 `psql`, `pg_isready`, `gcloud` CLI도 현재 환경에 없다.
- 따라서 `0014_conversation_memory`와 `0015_conversation_summaries`를 적용하지 않았고 Drizzle snapshot 생성·검증도 하지 않았다.
- 새 격리 PG16 DB, `wg_conversation` 최소 권한, 실제 idempotency·소유권 격리·삭제·만료·late-write·summary retry·서버 재시작을 검증하지 못했다.
- `origin`은 GitHub remote로만 확인했다. 배포 SHA, GCP 환경 변수, systemd worker, 만료 스케줄러, 배포 전후 QA를 확인하거나 배포하지 않았다.

기존 복원 DB나 GCP DB에는 실험 migration을 적용하지 않는다. 운영 복구·schema 자동 롤백도 사용자 승인 없이는 수행하지 않는다.

## 재개 가능한 인수 순서

1. Docker 또는 별도 PG16으로 새 로컬 DB를 만들고 기존·복원·GCP DB와 포트·볼륨·권한을 분리한다.
2. migration ledger와 `0014`/`0015` Drizzle snapshot을 검증한 뒤 새 DB에만 적용한다.
3. `wg_conversation` 권한과 로그인 사용자의 소유권 격리, 중복 쓰기, 삭제, 만료, late-write, 요약 재시도를 실제 DB와 서버 재시작으로 확인한다.
4. 브라우저 화면에서 게스트·로그인 분리, 카드·회사 전환·출처·목록·삭제를 클릭 검증한다.
5. 명시적인 배포 권한과 GCP 접근이 제공될 때만 배포 SHA, 프롬프트/RAG 버전, worker, readiness, 배포 전후 답변 QA를 별도로 확인한다.

이 문서는 배포 준비 상태와 운영 인수 완료를 구분하는 기록이다. 현재 단계 8의 운영 인수는 미완료다.

