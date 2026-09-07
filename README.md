# Co끼리

일하기 전에도, 일하는 중에도 미리 대비하는 노동정보 서비스. AI Rookie · 창의종합설계 경진대회 팀 프로젝트 저장소.

사업장 검색 → 임금체불·산업재해 신호 카드 → 노동법 상담(RAG + LLM) → 근로계약서 진단 → 커뮤니티·현장 제보로 이어지는 흐름을 하나의 Next.js 서비스로 제공한다. 챗봇 이름은 「돈워리」.

## 지금 어디에 무엇이 있나

| 경로 | 역할 | 주 담당 |
| --- | --- | --- |
| [`product/`](product/) | 통합 제품 (Next.js 웹·API, RAG·계약서 분석 통합) | 프론트 수현·지유, API 민규·창의, 프롬프트 성현 |
| [`db/`](db/) | PostgreSQL 스키마·migration(0000~0011)·ML 결과 적재·Path B 재구축 | 나연(사용자 DB), 승석(ML·DB 검토), 팀장(적재·게이트) |
| [`docs/`](docs/) | 팀 공용 문서 — 결정 기록·데이터 계약·프롬프트·MLOps·QA·페르소나·시연 | 전원 |
| [`infra/`](infra/) | GCP VM 배포·systemd·환경 검증·공개 진입점 | 팀장 |
| [`prototypes/`](prototypes/) | 8월 프로토타입 보존(수정하지 않음) | — |

## 먼저 읽을 문서

| 알고 싶은 것 | 문서 |
| --- | --- |
| 최근 결정 사항 | [`docs/decisions/`](docs/decisions/) — 날짜별. 다른 문서와 어긋나면 결정 기록이 우선 |
| 화면 문구·배지·금지 표현 | [`product/docs/service-policy.md`](product/docs/service-policy.md) |
| API 요청·응답 형태 | [`product/docs/api-contract.md`](product/docs/api-contract.md) |
| DB 값의 의미(판정·등급·피처) | [`docs/data-contract/`](docs/data-contract/) |
| 프롬프트에 무엇이 들어 있나 | [`docs/prompt/CONTENTS.md`](docs/prompt/CONTENTS.md) |
| ML 결과를 DB에 넣는 규격·배치 운영 | [`docs/mlops/`](docs/mlops/) |
| DB 변경(migration)·복구·드리프트 검사 | [`db/docs/MIGRATION_OPERATIONS.md`](db/docs/MIGRATION_OPERATIONS.md) · [`db/docs/DRIFT_CHECK_COVERAGE.md`](db/docs/DRIFT_CHECK_COVERAGE.md) |
| 서버 배포·롤백·접속 | [`infra/OPERATIONS.md`](infra/OPERATIONS.md) · 공개 진입점 문서 |
| QA 항목·페르소나·시연 대본 | [`docs/qa/`](docs/qa/) · [`docs/persona/`](docs/persona/) · [`docs/demo/`](docs/demo/) |

## 시연 서버

- 주소: 팀 공유 문서 참조(Basic Auth). 매일 07:00~다음 날 01:00(KST) 가동.
- 상태 확인: `/api/health/live`, `/api/health/ready`(인증 불필요), `/api/system/status`(인증 필요).
- 배포는 [`infra/scripts/deploy-from-git.sh`](infra/scripts/) 로만. migration은 배포와 분리해 적용한다.

## 개발 흐름

1. 최신 `main`에서 `task/<주제>` 브랜치를 만든다.
2. 자기 담당 경로만 수정한다. 공통 파일(`product/src/server/**`, `db/migrations/**`, `infra/**`)은 담당자와 먼저 맞춘다.
3. `cd product && npm run check`(웹) 또는 `cd db && npm test`(DB)를 통과시킨다.
4. PR을 올리고 팀장이 병합한다. 셀프 머지·`main` 직접 push·force push는 하지 않는다.
5. 브랜치는 오래 두지 않는다. 오래 두면 병합이 아니라 재적용이 된다(8월 프롬프트 브랜치 사례).
6. 새 migration을 만들면 드리프트 검사 후조건 등록을 같은 PR에서 한다.

## 보안과 데이터

- API 키, `.env*`, 원본 계약서, 개인정보, 실존 사업장 식별정보는 Git에 넣지 않는다. 저장소는 공개다.
- 웹 프로세스는 읽기 전용 DB 계정(`wg_bot`)과 기능별 최소권한 계정(`wg_auth`·`wg_community`·`wg_tip`)만 쓴다.
- ML 산출물 원본과 대용량 데이터는 저장소 밖에 두고 복원 절차만 문서화한다.
- 팀원 실명 대신 역할명으로 문서를 쓴다.

## 프로토타입

8월 개인 작업본은 [`prototypes/`](prototypes/)에 원형대로 보존한다(jcu·csh·hb·hss·shyun_64). 실행법은 각 폴더 README 참조. 운영 코드로 간주하지 않는다.
