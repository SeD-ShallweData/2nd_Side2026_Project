# Migration 운영·drift 차단 절차

## 목적

`drizzle.__drizzle_migrations`는 DB가 어떤 SQL을 적용했다고 기록하는 영수증이다. 실제 schema와
영수증이 어긋난 상태에서 `drizzle-kit migrate`를 실행하면 이미 존재하는 컬럼을 다시 바꾸거나 view를
재생성하려 할 수 있다.

## 현재 상태 (2026-09-14 기준)

- 로컬 journal: `0000`~`0013`, 14개
- 마지막으로 확인된 운영 DB ledger: `0000`~`0011`, 12개. `0012`·`0013`의 실제 적용 여부는
  배포 직전 읽기 전용 drift 검사로 다시 확인한다.
- DB 계정 4종: `wg_bot`(AI 상담용, Path B 계약 대상) · `wg_auth`(회원·세션) ·
  `wg_community`(게시글·신고·사업장·`v_posts`·댓글 조회·피드백) · `wg_tip`(현장 제보, 신규)
- 위 계정은 모두 DB 소유자 계정(`wageguard`)과 별개의 애플리케이션 전용 계정이다.

새 migration을 추가하거나 팀원이 로컬 DB를 새로 만들 때 이 절차가 깨지지 않도록 아래 순서와
검사를 따른다.

## DB 계정 생성 순서 (중요)

**계정 생성이 먼저, migration 적용이 나중이다.** 순서를 반대로 하면 오류 없이 조용히 실패한다.

`0009_busy_puck.sql` 끝의 권한 부여 블록은 "해당 롤이 이미 존재할 때만" 실행되는 조건부
(`DO $$ ... IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '...') ... END $$`) 로직이다.
롤이 없으면 **오류 없이 그냥 건너뛴다.**

```bash
cd db
./scripts/create-auth-role.sh
./scripts/create-community-role.sh
./scripts/create-tip-role.sh
# wg_bot 은 Path B 세션 identity 가드가 있어 별도 절차(bootstrap:path-b)가 필요하다.
# 로컬 개발에서는 보통 생략한다.

npm run migrate
```

새 로컬 DB를 만들 때 스키마부터 적용하고 롤을 나중에 만드는 것이 자연스러운 순서처럼 보이지만,
그 순서로 하면 `wg_community`의 `v_posts`·`feedback` 권한이 빠진 채로 남는다. 조용히 실패하기
때문에 증상은 한참 뒤에 "비익명 글인데 작성자 이름이 안 나온다"는 식으로만 드러난다.

**이미 스키마를 먼저 적용해버린 경우**: 롤을 만든 뒤 `0009`의 권한 블록만 다시 실행해도 된다.
`DO $$ ... END $$` 블록은 재실행해도 안전하다(멱등).

`0010`~`0013`에는 이런 조건부 권한 부여가 없다 — `wg_tip` 권한은 `create-tip-role.sh` 스크립트
자체가 부여하므로 이 순서 의존성이 없다.

## 배포 전 읽기 전용 검사

Node.js 22와 PostgreSQL `psql`이 필요하다. 검사 계정은 `drizzle.__drizzle_migrations`와 PostgreSQL
catalog를 읽을 수 있어야 한다. `wg_bot`은 migration ledger 권한이 없을 수 있으므로 DB 소유자 계정을
사용하되, 스크립트는 세션을 강제 read-only로 연다.

```bash
cd db
npm run check:migration-drift -- --env-file ./.env.local
```

CI나 배포 환경에서는 파일 대신 별도 읽기 가능한 접속 URL을 사용할 수 있다.

```bash
MIGRATION_DATABASE_URL='postgresql://...' npm run check:migration-drift
```

JSON 출력:

```bash
npm run check:migration-drift -- --env-file /path/to/env --json
```

비밀번호와 URL은 출력하지 않는다. 대상 표시는 host, port, DB명, user만 포함한다.

### 종료 코드

| 코드 | 의미 |
| --- | --- |
| `0` | journal, ledger, 알려진 schema 후조건이 일치 — 배포 진행 가능 |
| `1` | 접속·설정·결과 파싱 오류 |
| `2` | drift 또는 pending migration 발견 — 배포 차단 |

### 판정 상태

| 상태 | 의미 |
| --- | --- |
| `aligned` | ledger가 journal 전체와 일치하고 적용 migration 후조건도 충족 |
| `pending_migrations` | ledger는 정상 prefix지만 아직 적용되지 않은 migration 존재 |
| `schema_ahead_of_ledger` | ledger에 없는 migration 객체가 이미 모두 존재 |
| `partial_schema_application` | ledger에 없는 migration 객체 일부만 존재 |
| `applied_schema_mismatch` | 적용 기록이 있는데 기대 객체가 없거나 이름이 다름 |
| `ledger_diverged` | 같은 순서의 hash 또는 `created_at`이 로컬 journal과 다름 |
| `database_ahead` | DB ledger가 로컬 journal보다 김 |
| `ledger_missing` | Drizzle ledger 자체가 없음 |

검사는 다음 두 안전장치를 함께 사용한다.

1. `psql` 프로세스에 `default_transaction_read_only=on`을 강제한다.
2. ledger·catalog 쿼리를 `BEGIN TRANSACTION READ ONLY` 안에서 실행한다.

이 스크립트에는 migration 적용, ledger 삽입·수정, schema 변경 코드가 없다.

## 정상 `aligned` 결과 예시

`0000`~`0013`이 모두 적용되고 각 migration의 후조건(테이블·컬럼·view·index)이 전부 충족되면
다음과 같은 결과가 정상이다.

```text
상태: aligned
DB ledger: 14개 (일치 prefix 14개)
적용 대기: 없음
로컬 migration journal과 DB ledger 및 알려진 schema 후조건이 일치합니다.
```

`schema_ahead_of_ledger`, `partial_schema_application` 등 다른 상태가 나오면 아래 복구 원칙을
따른다.

## 복구 원칙

이 저장소의 검사 스크립트는 자동 복구하지 않는다. 복구는 별도 검토 작업으로 수행한다. drift가
발견되면(예: ledger가 로컬 journal보다 짧은데 일부 migration의 schema 객체는 이미 존재하는 경우)
다음 순서를 따른다.

1. 대상 DB를 custom-format dump로 백업한다.
2. 별도 PostgreSQL 16 인스턴스에 복원한다.
3. ledger에 이미 기록된 마지막 hash까지 로컬 SQL의 SHA-256과 일치하는지 확인한다.
4. drift가 시작된 migration부터, 뒤이은 각 migration의 후조건을 컬럼·index·table·view 단위로
   전부 확인한다.
5. 확인한 SQL이 실제 적용된 결과와 동일하다는 팀 검토를 받는다.
6. 그 후에만 DB 소유자가 별도의 일회성 reconciliation SQL로 ledger를 복구한다.
7. 복원 리허설 DB에서 아직 미적용인 migration만 적용해 후조건을 확인한다.
8. 대상 DB 백업 직후 미적용 migration을 적용하고 이 검사가 `aligned`를 반환하는지 확인한다.

객체가 있다는 이유만으로 ledger 행을 즉시 삽입하지 않는다. 제약조건, index, view 정의 중 일부가
다를 수 있기 때문이다. 운영 DB에서 `npm run migrate`를 먼저 시도해 오류를 관찰하는 방식도 사용하지
않는다.

## 적용된 migration 은 고치지 않는다

migration 파일은 적용되는 순간 **바이트가 곧 신분증**이다. drizzle 이 파일 원본을 sha256 해서
`drizzle.__drizzle_migrations` 에 남기고(`drizzle-orm/migrator.js`), `check-migration-drift` 가
그 값을 현재 파일 해시와 대조한다. **주석 한 글자만 바뀌어도** 해시가 달라져 `ledger_diverged`
가 나고 그 DB 는 배포 게이트를 통과하지 못한다.

drizzle 자체는 `created_at` 으로 적용 여부를 판단하므로 재적용은 일어나지 않는다. 문제는
**검사기가 막히는 것**이고, 그러면 진짜 드리프트와 구분할 수 없게 된다.

| 고치려는 것 | 어디에 |
| --- | --- |
| 주석·문구 정정 | `db/schema.ts` 등 해시되지 않는 곳 |
| 스키마 변경 | **새 migration** (후조건 등록도 같은 PR 에서) |
| 아직 어디에도 적용 전 | 근거를 PR 에 적고 리뷰어 승인 |

`db/scripts/check-migration-immutability.sh` 가 CI 에서 이것을 강제한다.
원장 해시로 **되돌리는 복구**는 `db/migrations/.immutability-exceptions` 에 경로와
**결과 해시**를 함께 적어 허용한다 — "이 파일은 마음대로 고쳐도 된다"가 아니라
"정확히 이 내용으로만 바뀌어도 된다"가 되게 하기 위함이다.

> 2026-09-11: PR #40 이 `0002`·`0006` 의 `COMMENT` 문구를 다듬었는데 둘 다 이미 운영 DB 에
> 적용된 뒤였다. 고친 값 자체는 옳았지만(재사용 최다 788→950곳, 큐 경계 표기) 자리가 틀렸다.
> 배포 직전 `--dry-run` 에서 발견해 되돌리고 이 검사를 넣었다.

## 새 migration 체크리스트

- 적용된 과거 migration SQL은 수정하지 않고 새 번호를 추가한다.
- `_journal.json`과 SQL 파일을 같은 커밋에 넣는다.
- 비멱등 rename/drop/constraint 변경에는 catalog 후조건을 drift 검사에 추가한다.
- 새 애플리케이션 롤이 필요한 권한 변경은 migration의 조건부 `DO $$ ... END $$` 블록으로
  넣거나(`0009` 방식), 해당 롤의 `create-*-role.sh`에 직접 넣을지(`0010`/`wg_tip` 방식) 결정하고
  문서화한다. 어느 쪽이든 "롤 생성 → migration 적용" 순서를 팀에 공지한다.
- PR CI의 빈 PostgreSQL 16에서 전체 migration을 처음부터 적용한다.
- 운영 배포 전에 이 read-only 검사를 실행한다.
- migration은 앱 프로세스 시작 명령과 분리한다.
- 변경 migration 적용 직전에 DB dump와 복원 가능 여부를 확인한다.

## 검사 단위 테스트

DB 없이 Node.js 기본 test runner만 사용한다.

```bash
cd db
npm run test:migration-drift
```

테스트는 정상 일치, 일반 pending, schema-ahead, 부분 적용, hash 불일치, DB-ahead, ledger 누락을
모두 검증한다.

- 드리프트 검사 공백과 수동 검증: [DRIFT_CHECK_COVERAGE.md](DRIFT_CHECK_COVERAGE.md)
