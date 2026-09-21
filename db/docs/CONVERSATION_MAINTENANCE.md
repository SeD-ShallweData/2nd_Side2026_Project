# 대화 보존·요약 worker 운영 준비 (2026-09-21)

이 문서는 **준비 절차**다. 운영 설치·migration·서비스 재시작은 이번 작업에서 수행하지 않았다.
검증 근거와 미확정 정책은 [후속 06](../../docs/qa/2026-09-21-followup-06.md)을 참조한다.

## 배포 전 순서

1. 운영 대상·승인·백업 SHA-256·별도 복원 가능 여부를 확인한다. 기존 사용자/복원 DB에 빈 DB용 acceptance를 연결하지 않는다.
2. [MIGRATION_OPERATIONS.md](MIGRATION_OPERATIONS.md)의 read-only drift 검사로 실제 ledger를 확인한다. 과거 0017 적용 기록은 현재 0018~0020 적용 증거가 아니다. `schema_ahead`, `partial`, `diverged`이면 중단하고 문서의 복구 절차를 따른다.
3. 이미 적용된 SQL/hash/created_at을 바꾸지 않는다. 승인된 migration만 실행한다. 0018은 즐겨찾기, 0019는 요약 lease, 0020은 요청의 2분 processing lease와 fencing 컬럼·제약을 추가한다. **새 앱·worker보다 먼저 0018~0020을 순서대로 적용**한다.
4. 해당 환경의 승인된 role 스크립트를 실행한다. `create-auth-role.sh`: users/sessions CRUD 및 favorites SELECT/INSERT/DELETE; `create-conversation-role.sh`: 기존 7개 conversation 테이블 CRUD만. 신규 테이블 생성 전에는 conversation grant를 실행하지 않는다. 0009 조건부 grant와 달리 이 명시적 스크립트는 해당 테이블 migration 이후 실행한다. 역할 비밀번호는 보호된 로컬 env에만 두며 psql argv에 넣지 않는다(`\getenv`, PG16 client 필요).
5. `npm run check:migration-drift`에서 21개 ledger 및 115개 알려진 후조건이 aligned인지 확인한다. 0000~0005의 모든 의미적 제약을 검사한다는 뜻은 아니다.
6. Node **22** / 잠금 파일 기준 `npm ci` 후 `product`에서 `npm run worker:conversation:build`. 생성물 `.runtime/conversation-worker.mjs`는 Git 제외 서버 번들이다. **배포마다 별도 재빌드**한다. 기존 Next build/자동 배포기가 이 명령을 대신 실행하지 않는다.
7. 기존 systemd 치환 관례에 맞춰 `infra/systemd/moneyworry-conversation-maintenance.service.in`의 `@PROJECT_ROOT@`, `@WEB_SERVICE_USER@`, `@WEB_SERVICE_GROUP@`, `@NODE_BIN@`, `@CONVERSATION_WORKER_ENV_FILE@`을 운영자가 확정한다. 기존 서비스 경로나 사용자 이름을 추정해 설치하지 않는다.
8. worker 전용 EnvironmentFile은 비공개·최소 읽기 권한으로 준비한다. 필요한 값은 `CONVERSATION_DATABASE_URL`(wg_conversation), 환경에 맞는 `DB_SSL`뿐이다. owner URL, AUTH URL, provider 키는 넣지 않는다. 유닛은 `CONVERSATION_DATA_MODE=real`, env/key 파일 자동 탐색 차단을 명시한다.
9. **별도 운영 승인 후에만** 유닛 렌더링·`systemd-analyze verify`·daemon-reload·oneshot 1회 실행·로그 확인·timer enable을 수행한다. migration 경로 변경은 기존 배포 guarded-halt(exit 3) 대상이다. 자동 배포를 우회하지 않는다.

## 실행·장애 의미

- timer: 부팅 2분 후, 이후 30분마다. 한 pass는 만료 대화 최대 100개, 요약 후보 최대 25개. 다음 pass가 잔여 backlog를 처리한다. 30일은 `expires_at` 기준 접근 차단/삭제 자격 시점이며 물리 삭제에는 주기·backlog 지연이 있다. title/company 변경도 기존 `last_activity_at`/expires_at 연장 정책을 따른다.
- 만료 삭제는 `FOR UPDATE SKIP LOCKED`와 FK cascade. 여러 프로세스가 겹쳐도 같은 삭제를 중복 집계하지 않는다. 삭제 전에도 목록·상세·완료 응답 재사용·늦은 저장은 만료를 거부한다.
- 요약 lease: 120초, 정상 작업 heartbeat 30초. DB `now()`를 기준으로 token+expiry+target을 확인하고, 만료된 작업만 원자적으로 회수한다. 예전 nullable lease 없는 pending은 `updated_at + 120초`를 사용한다.
- 이전 token의 complete/fail/renew는 새 작업을 덮지 못한다. claim 후 완료 checkpoint를 다시 읽는다. 삭제된 대화는 재생성하지 않는다. 실패 checkpoint가 있어도 이전 완료 요약은 계속 사용한다.
- 실패 요약은 60초 이후 worker 후보가 되므로 새 대화 입력을 기다리지 않는다. heartbeat가 끊긴 worker는 다음 pass에서 회수 가능하다. 유닛 timeout은 120초이며 timeout 후에도 lease가 영구 잠금으로 남지 않는다.
- 로그는 version/deleted/candidates/summarized/failed 개수만. 본문·사용자/상담 ID·프롬프트·세션/DB 비밀값을 찍지 않는다. DB 장애/요약 실패가 있으면 비정상 종료한다. 원문 응답 저장은 요약 실패와 분리한다.
- `wg_conversation`은 기능 단위 DB role이며 전체 대화 작업을 수행한다. **사용자별 DB RLS라고 주장하지 않는다.** 사용자 소유권은 인증된 서비스/API에서 별도로 검사한다.

## 확인과 복구

- 첫 실행 후 timer 다음 예정 시각, oneshot exit, 삭제/요약 건수, 만료 backlog 및 오래된 pending **개수**를 확인한다. 설정한 DB/DB role도 비밀 없는 이름으로 확인한다. 후보가 계속 상한에 걸리면 처리량·실행 주기를 운영자가 검토한다.
- 실패 시 먼저 worker를 중지하고 DB 연결/권한/0019 적용 여부를 확인한다. 확인 없이 ledger 삽입, pending 전체 초기화, 과거 SQL 수정, 원문 삭제를 하지 않는다.
- 새 버전 worker 재기동은 lease 회수로 재시도한다. rollback 필요 시 worker를 중지하고 이전 앱 버전을 사용한다. 추가 nullable 컬럼은 남겨도 이전 앱과 호환된다. 운영 데이터가 생긴 후 0018 테이블이나 0019 컬럼을 임의 DROP 하지 않는다.
- generation 결과의 5분 save-retry 캐시는 프로세스 메모리다. 앱 crash 전에 생성했으나 저장 못한 답변의 복원은 보장하지 않는다. 완료 ledger 응답은 재시작 후 재사용된다. 아직 pending인 **chat request** 자체의 crash 재실행/만료 정책은 summary lease와 별개이며 이번에 임의 자동 재생성을 도입하지 않았다.

## 재현: 새 로컬 격리 PG16만

Docker Engine을 켜고 `db`에서 실행한다. 기본 `docker compose up`이나 기존 `.env.local`은 사용하지 않는다.

```powershell
npm.cmd ci --ignore-scripts --no-audit --no-fund
npm.cmd exec --yes --package=node@22 -- node scripts/run-conversation-pg16-acceptance.mjs
node node_modules/tsx/dist/cli.mjs scripts/repair-conversation-snapshot.ts
npm.cmd run test:migration-drift
```

acceptance는 새 이름/새 volume, `127.0.0.1:55436`, 고정 PG16 image, 새 랜덤 비밀번호(메모리만)를 사용한다. `.env` 또는 임의 접속 URL을 받지 않으며 대상 이름·버전·빈 public schema를 먼저 확인한다. product 의존성이 필요하다. 앱 HTTP는 `127.0.0.1:3116`에서만 실행한다. 두 포트가 사용 중이면 기존 프로세스를 종료하지 않고 실패한다.

종료 시 자신이 만든 앱·container만 중지한다. 합성 데이터 volume은 재현 증거로 남으므로 정리는 출력된 정확한 이름과 `moneyworry.acceptance=followup06` 라벨을 확인한 뒤 한다. 로컬 비밀번호를 파일로 보존하지 않으므로 재개는 새 실행을 권장한다. 이 실행기는 운영/사용자 데이터 백업 복구 도구가 아니다.
