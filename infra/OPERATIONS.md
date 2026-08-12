# 돈워리 종료 전 보존·배포·운영 런북

이 문서는 현재 팀 서버가 종료되기 전에 무엇을 Git으로 보존하고, 무엇을 별도 백업해야 하는지 구분한다.
GitHub는 코드와 작은 재현 가능 파일의 보관소이지 실행 중인 서버나 PostgreSQL 데이터 자체가 아니다.

## 1. 보존 대상 구분

| 자산 | GitHub만으로 보존 가능 | 별도 조치 |
| --- | --- | --- |
| Next/TypeScript/Python 소스, migration, 문서, CI | 가능 | feature branch를 `main`에 PR로 병합하고 tag 생성 |
| PostgreSQL 운영 데이터 | 불가능 | `pg_dump` custom dump, checksum, 별도 비공개 저장소 |
| `product/integrations/rag-api/data/labor_law_db` | 현재 5개 파일이 Git에 추적됨 | 실행 시점 archive와 checksum도 별도 보관해 Git 객체 손상·누락에 대비 |
| API 키·DB 비밀번호 | Git 저장 금지 | 새 배포 환경의 secret store에 이름별 재등록 후 기존 키 회전 |
| Python `.venv`, Node `node_modules`, 모델 cache | 보존 불필요 | lockfile/requirements로 재설치; BGE-M3 모델 확보 경로만 기록 |
| 실행 로그·계약서 원문 | 기본 보존 대상 아님 | 법적·업무상 필요성과 개인정보 정책을 먼저 결정 |

## 2. 서버 종료 전 체크리스트

1. 모든 작업을 기능 브랜치에 commit하고 최신 `origin/main`을 rebase/merge한 뒤 CI를 통과시킨다.
2. branch를 GitHub에 push하고 PR로 `main`에 합친다. 종료 시점 commit에 annotated tag를 만든다.
3. 앱 쓰기를 잠시 멈추거나 팀과 백업 시점을 합의한 뒤 PostgreSQL logical dump를 만든다.
4. dump와 RAG archive에 SHA-256 checksum을 만들고, 원본 서버 밖의 비공개 저장소에 각각 2개 이상 둔다.
5. 빈 PostgreSQL 16 인스턴스에 restore하고 행 수·최신 batch·핵심 view를 확인한다.
6. 새 환경의 secret store에 필요한 변수를 등록하고 `/api/system/status`와 smoke test를 통과시킨다.
7. DNS/URL을 전환한 뒤 기존 서버는 읽기 전용으로 두고 최종 증분 백업을 한 번 더 만든다.

예시 명령은 실제 관리자용 DB URL을 셸 history에 직접 적지 않고 환경에서 주입한다.

```bash
pg_dump --format=custom --no-owner --no-acl \
  --file=moneyworry-YYYYMMDD.dump "$BACKUP_DATABASE_URL"
sha256sum moneyworry-YYYYMMDD.dump > moneyworry-YYYYMMDD.dump.sha256

tar --create --gzip --file=labor-law-db-YYYYMMDD.tar.gz \
  -C product/integrations/rag-api/data labor_law_db
sha256sum labor-law-db-YYYYMMDD.tar.gz > labor-law-db-YYYYMMDD.tar.gz.sha256
```

복원 리허설:

```bash
createdb moneyworry_restore_check
pg_restore --exit-on-error --no-owner --no-acl \
  --dbname="$RESTORE_CHECK_DATABASE_URL" moneyworry-YYYYMMDD.dump
```

현재 운영 DB는 migration ledger에 0000~0005만 기록됐지만 0006/0007의 schema 객체가 이미 존재하는
`schema_ahead_of_ledger` 상태다. 0008은 최신 배치 view의 동률 정렬을 고치는 정상 pending migration이다.
이 상태에서 `npm run migrate`를 실행하면 먼저 0006의 비멱등 rename을 재시도해 실패할 수 있다. dump를
만들고 0006/0007 ledger 복구를 검토하기 전에는 migration을 재실행하지 않는다.

## 3. 배포 구성

최소 실행 단위는 네 개다.

```text
브라우저 → Next.js product
                    ├─ PostgreSQL 16 (persistent)
                    ├─ 노동법 RAG Python 서비스 + Chroma (persistent)
                    ├─ 계약분석 Python 서비스
                    └─ 선택한 LLM 공급자 API
```

따라서 GitHub에 push만 하면 코드는 보존되지만 서비스가 실행되지는 않는다. 장기 운영에는 다음 종류의
실행 환경이 각각 필요하다.

- Node 22를 실행하는 웹/컨테이너 환경
- PostgreSQL 16과 자동 backup/point-in-time recovery를 제공하는 persistent DB
- BGE-M3를 메모리에 올릴 수 있고 Chroma volume을 보존하는 Python 컨테이너 또는 VM
- 계약분석 Python 프로세스와 outbound API 접근

현재 RAG와 계약 서비스는 Flask 개발 서버로 실행된다. 장기 배포에서는 WSGI 서버와 process supervisor를
사용하고, BGE-M3 메모리 중복을 피하기 위해 RAG worker는 우선 1개로 시작해 thread/요청량을 관찰한다.
호스팅 제품 선택 전에는 vendor 전용 설정을 저장소에 고정하지 않는다.

## 4. 필수 환경변수

공통:

- `DATABASE_URL` 또는 `BOT_DATABASE_URL` — 앱은 읽기 전용 계정 사용
- `RAG_API_URL`, `CONTRACT_ANALYSIS_URL`
- `CHAT_EXECUTION_MODE=dual_api|openai_responses`
- dual: `UPSTAGE_API_KEY`, `SKT_API_KEY`
- Responses: `OPENAI_API_KEY`, `OPENAI_RESPONSES_MODEL`
- 외부 시연: `DEMO_BASIC_AUTH_USER`, `DEMO_BASIC_AUTH_PASSWORD`
- serverless: `SAVE_COMPARISON_FEEDBACK=false`

클라우드에는 `/data/shared-SeD/*.env`가 없으므로 각 값을 배포 secret store에 직접 등록한다. 파일을 사용하는
VM에서는 env 파일을 `0600`, 같은 팀 그룹 읽기가 필요하면 `0640`으로 둔다. 앱 값은 읽지 않고 권한만
검사하려면 `cd product && npm run check:env-permissions`를 사용한다.

## 5. 배포·rollback 순서

1. `npm ci && npm run check`
2. DB dump와 migration drift 검사
3. RAG·계약 서비스 health 확인
4. Next 배포, `GET /api/system/status`
5. 실제 DB 기준 최신 배치와 사업장 검색/위험 조회 smoke test
6. `CHAT_EXECUTION_MODE=openai_responses`를 켤 때 fake wire E2E 후 실제 OpenAI 키로 제한된 live smoke
7. 장애 시 코드 rollback 전에 `CHAT_EXECUTION_MODE=dual_api`로 즉시 기존 흐름 복원

배포와 migration은 분리한다. 앱 시작 명령에 자동 migration을 섞지 않고, drift가 있으면 배포를 중단한다.
