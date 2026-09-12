# 돈워리 종료 전 보존·배포·운영 런북

이 문서는 현재 팀 서버가 종료되기 전에 무엇을 Git으로 보존하고, 무엇을 별도 백업해야 하는지 구분한다.
GitHub는 코드와 작은 재현 가능 파일의 보관소이지 실행 중인 서버나 PostgreSQL 데이터 자체가 아니다.

## 1. 보존 대상 구분

| 자산 | GitHub만으로 보존 가능 | 별도 조치 |
| --- | --- | --- |
| Next/TypeScript/Python 소스, migration, 문서, CI | 가능 | feature branch를 `main`에 PR로 병합하고 tag 생성 |
| PostgreSQL 운영 데이터 | 불가능 | `pg_dump` custom dump, checksum, 별도 비공개 저장소 |
| 현장 제보 사진 원본·검사관용 사본 | 불가능 | `/srv/moneyworry/worksite-tip-media` archive와 checksum을 DB dump와 같은 세대로 보관 |
| `product/integrations/rag-api/data/labor_law_db` | 현재 5개 파일이 Git에 추적됨 | 실행 시점 archive와 checksum도 별도 보관해 Git 객체 손상·누락에 대비 |
| API 키·DB 비밀번호 | Git 저장 금지 | 새 배포 환경의 secret store에 이름별 재등록 후 기존 키 회전 |
| Python `.venv`, Node `node_modules`, 모델 cache | 보존 불필요 | lockfile/requirements로 재설치; BGE-M3 모델 확보 경로만 기록 |
| 실행 로그·계약서 원문 | 기본 보존 대상 아님 | 법적·업무상 필요성과 개인정보 정책을 먼저 결정 |

## 2. 서버 종료 전 체크리스트

1. 모든 작업을 기능 브랜치에 commit하고 최신 `origin/main`을 rebase/merge한 뒤 CI를 통과시킨다.
2. branch를 GitHub에 push하고 PR로 `main`에 합친다. 종료 시점 commit에 annotated tag를 만든다.
3. 앱 쓰기를 잠시 멈추거나 팀과 백업 시점을 합의한 뒤 PostgreSQL logical dump를 만든다.
4. 현장 제보 real 저장을 사용 중이면 같은 쓰기 중단 구간에 사진 저장소 archive도 만든다.
5. dump, 현장 제보 archive, RAG archive에 SHA-256 checksum을 만들고, 원본 서버 밖의 비공개 저장소에 각각 2개 이상 둔다.
6. 빈 PostgreSQL 16 인스턴스에 restore하고 행 수·최신 batch·핵심 view를 확인한다.
7. 새 환경의 secret store에 필요한 변수를 등록하고 `/api/system/status`와 smoke test를 통과시킨다.
8. DNS/URL을 전환한 뒤 기존 서버는 읽기 전용으로 두고 최종 증분 백업을 한 번 더 만든다.

예시 명령은 실제 관리자용 DB URL을 셸 history에 직접 적지 않고 환경에서 주입한다.

```bash
pg_dump --format=custom --no-owner --no-acl \
  --file=moneyworry-YYYYMMDD.dump "$BACKUP_DATABASE_URL"
sha256sum moneyworry-YYYYMMDD.dump > moneyworry-YYYYMMDD.dump.sha256

tar --create --gzip --file=labor-law-db-YYYYMMDD.tar.gz \
  -C product/integrations/rag-api/data labor_law_db
sha256sum labor-law-db-YYYYMMDD.tar.gz > labor-law-db-YYYYMMDD.tar.gz.sha256

tar --create --gzip --file=worksite-tip-media-YYYYMMDD.tar.gz \
  -C /srv/moneyworry worksite-tip-media
sha256sum worksite-tip-media-YYYYMMDD.tar.gz \
  > worksite-tip-media-YYYYMMDD.tar.gz.sha256
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

논리적으로 필요한 값:

- `DATABASE_URL` 또는 `BOT_DATABASE_URL` — 앱은 읽기 전용 계정 사용
- `RAG_API_URL`, `CONTRACT_ANALYSIS_URL`
- `CHAT_EXECUTION_MODE=dual_api|openai_responses`
- dual: `UPSTAGE_API_KEY`, `SKT_API_KEY`
- Responses: `OPENAI_API_KEY`, `OPENAI_RESPONSES_MODEL`
- 외부 시연: `DEMO_BASIC_AUTH_USER`, `DEMO_BASIC_AUTH_PASSWORD`
- serverless: `SAVE_COMPARISON_FEEDBACK=false`

클라우드에는 `/data/shared-SeD/*.env`가 없으므로 각 값을 배포 secret store에 직접 등록한다. 단일 VM
systemd 배포에서는 이 목록을 하나의 공용 파일로 합치지 않는다. DB 관리자/Compose 값, read-only bot과
웹 값, RAG 비-secret 값, 계약 분석 API 값을 각각 `/etc/moneyworry/{db,web,rag,contract}.env`로
분리하고 서비스별 UID/GID도 분리한다. 상세 권한과 installer gate는 [`README.md`](README.md)를 따른다.
앱 값은 읽지 않고 권한만 검사하려면 `cd product && npm run check:env-permissions`를 사용한다.

## 5. 배포·rollback 순서

1. `npm ci && npm run check`
2. DB dump와 migration drift 검사
3. RAG·계약 서비스 health 확인
4. Next 배포, `GET /api/system/status`
5. 실제 DB 기준 최신 배치와 사업장 검색/위험 조회 smoke test
6. `CHAT_EXECUTION_MODE=openai_responses`를 켤 때 fake wire E2E 후 실제 OpenAI 키로 제한된 live smoke
7. 장애 시 코드 rollback 전에 `CHAT_EXECUTION_MODE=dual_api`로 즉시 기존 흐름 복원

배포와 migration은 분리한다. 앱 시작 명령에 자동 migration을 섞지 않고, drift가 있으면 배포를 중단한다.

## 6. 현장 제보 GCP 저장 전환

현장 제보 한 건은 PostgreSQL의 `worksite_tips`·`worksite_tip_attachments` 행과
`/srv/moneyworry/worksite-tip-media`의 사진 파일로 나뉜다. 따라서 DB dump와 media archive는
항상 같은 전환 시각의 한 쌍으로 취급한다. 둘 중 하나만 복구하면 DB가 가리키는 파일이 없거나,
소유자를 잃은 원본 파일이 남는다.

### 전환 전 gate

다음 순서는 sudo와 DB 운영 권한이 있는 운영자가 수행한다. 일반 OS Login 계정이 우회해서
`/etc/moneyworry`, systemd, Docker 또는 데이터 디스크의 소유권을 바꾸면 안 된다.

1. 배포할 commit의 CI와 복원 리허설이 통과했는지 확인한다.
2. `check:migration-drift`를 읽기 전용으로 실행하고, `0010`의 현장 제보 두 테이블과 최신 migration
   원장이 모두 적용된 상태인지 확인한다. migration은 앱 배포와 분리해 적용한다.
3. `wg_tip`에 `firms` SELECT, 현장 제보 두 테이블 SELECT·INSERT만 있는지 확인한다. 롤 준비
   스크립트를 다시 실행할 때는 다른 앱 롤의 기존 grant를 함께 점검한다.
4. 웹을 중지해 새 제보 쓰기를 막은 상태에서 custom-format DB dump와 media archive를 만들고,
   두 파일의 SHA-256과 생성 시각을 한 manifest에 기록한다. 0바이트가 아닌지와 archive 목록도 확인한다.
5. dump와 archive를 VM 밖의 비공개 저장소로 복사한다. DB까지 중지한 뒤 GCE
   `moneyworry-data` Persistent Disk snapshot을 추가로 만들면 PostgreSQL과 media의 동일 시점
   재해복구 지점을 얻을 수 있다. snapshot 완료 후 DB만 먼저 다시 시작한다.

전환용 `web.env`는 root 전용 임시 파일에서 완성한 뒤 원자적으로 교체한다. 실제 비밀번호를 명령행,
셸 history, 로그에 쓰지 않는다. 아래 네 값이 함께 있어야 한다.

- `WORKSITE_TIP_DATA_MODE=real`
- 전용 `wg_tip`의 loopback `TIP_DATABASE_URL`
- `WORKSITE_TIP_STORAGE_ROOT=/srv/moneyworry/worksite-tip-media`
- 기존 auth/community를 포함한 나머지 필수 production 값

그 다음 `validate-service-envs.py`를 통과시키고 `install-systemd-units.sh --force`를 실행한다.
설치기는 media root를 웹 서비스 계정 소유 `0700`으로 준비하고, systemd에는 그 경로 하나만
`ReadWritePaths`로 연다. unit과 env 검증이 끝난 뒤 웹을 시작한다.

### 전환 확인

1. loopback readiness가 HTTP 200인지 확인한다.
2. 승인된 시험 사용자로 사진이 포함된 제보 한 건을 저장한다.
3. `wg_tip` 읽기 경로에서 제보·첨부 메타데이터, `storage_key`, SHA-256이 생성됐는지 확인한다.
4. media root에 원본과 검사관용 사본이 모두 있고, 디렉터리 `0700`, 파일 `0600`, 웹 계정 소유인지 확인한다.
5. 검사관 계정으로 목록·상세·사진 다운로드를 확인하고, 다운로드 사본에 EXIF 위치·시간·기기 정보가
   없는지 검사한다. 일반 사용자와 비로그인 요청은 검사관 API에서 403이어야 한다.
6. 웹을 한 번 재시작한 뒤 같은 제보와 사진을 다시 조회한다. 이 단계까지 통과하기 전에는 전환 완료로
   공지하지 않는다.

### rollback

시험 제보 외의 real 쓰기를 아직 받지 않았다면 웹을 중지하고 이전 release와 이전 `web.env`를
원자적으로 복원한 뒤, 이전 unit을 다시 설치하고 웹을 시작한다. 실패한 real 저장소는 조사용으로
보존하며 임의로 파일이나 DB 행을 지우지 않는다.

real 쓰기를 받은 뒤에는 단순히 mode만 mock으로 되돌리지 않는다. 먼저 웹을 중지하고 현재 DB와 media를
새로운 incident 세대로 한 번 더 백업한다. 이후 팀의 데이터 보존 결정을 받아 다음 중 하나를 택한다.

- 코드만 이전 release로 돌려도 real 저장 계약을 유지할 수 있으면 DB와 media는 그대로 둔다.
- 전환 전 상태로 되돌려야 하면 같은 세대의 DB dump와 media archive를 함께 복원한다. 이 복원은 전환 뒤
  생성된 인증·커뮤니티·제보 데이터를 잃을 수 있으므로 영향 행을 먼저 추출하고 명시적 데이터 손실 승인을
  받은 뒤 수행한다.
- 파일시스템이나 PostgreSQL 자체가 손상됐으면 웹과 DB를 중지하고 검증된 GCE snapshot으로 새 디스크를
  만든 뒤 교체한다. 기존 디스크는 삭제하지 말고 조사·재복구용으로 보존한다.

복구 후에는 DB dump checksum, media archive checksum, migration drift, DB의 모든 `storage_key`에 대응하는
검사관용 파일 존재 여부, 재시작 후 조회를 다시 확인한다. DB와 media 중 한쪽만 성공한 상태에서는 웹을
열지 않는다.
