# Migration 운영·drift 차단 절차

## 목적

`drizzle.__drizzle_migrations`는 DB가 어떤 SQL을 적용했다고 기록하는 영수증이다. 실제 schema와
영수증이 어긋난 상태에서 `drizzle-kit migrate`를 실행하면 이미 존재하는 컬럼을 다시 바꾸거나 view를
재생성하려 할 수 있다.

현재 팀 운영 DB에는 알려진 불일치가 있다.

- 로컬 journal: `0000`~`0008`, 9개
- 운영 DB ledger: `0000`~`0005`, 6행
- 실제 schema: `0006_risk_tier`, `0007_current_batch_views`의 주요 객체가 이미 존재
- `0008_deterministic_current_batch`는 아직 적용되지 않았으며, 같은 기준일의 여러 모델 배치를
  `as_of_date DESC, ingested_at DESC, id DESC`로 결정적으로 고치는 정상 pending migration

특히 `0006`은 `inspector_queue.grade`를 `queue_priority`로 rename한다. 이 상태에서 migration을
재실행하면 비멱등 rename이 실패할 수 있으므로 ledger를 먼저 복구하기 전에는 실행하지 않는다.

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

## 현재 운영 DB에서 기대되는 차단 보고

ledger가 정확히 첫 6개 hash와 일치하고 0006/0007 후조건이 모두 존재하며 0008은 미적용이면 다음 상태가 정상적인
감사 결과다.

```text
상태: schema_ahead_of_ledger — DEPLOY BLOCKED
로컬 journal: 9개
DB ledger: 6개 (일치 prefix 6개)
적용 대기: 0006_risk_tier, 0007_current_batch_views, 0008_deterministic_current_batch
```

이는 DB schema가 망가졌다는 뜻이 아니라 **schema를 적용한 경로와 Drizzle 영수증이 분리됐다**는
뜻이다. 자동 migration은 금지하지만 읽기 전용 제품 서비스 실행을 막는 이유는 아니다.

## 복구 원칙

이 저장소의 검사 스크립트는 자동 복구하지 않는다. 복구는 별도 검토 작업으로 수행한다.

1. 운영 DB를 custom-format dump로 백업한다.
2. 별도 PostgreSQL 16 인스턴스에 복원한다.
3. ledger 첫 6개 hash와 로컬 SQL SHA-256이 일치하는지 확인한다.
4. 0006 후조건을 컬럼·index·table 단위로 전부 확인한다.
5. 0007 후조건과 `v_current_batch` 정의를 확인한다.
6. 0006/0007 SQL이 실제 적용된 결과와 동일하다는 팀 검토를 받는다.
7. 그 후에만 DB 소유자가 별도의 일회성 reconciliation SQL로 0006/0007 ledger를 복구한다.
8. 복원 리허설 DB에서 0008만 적용해 view가 결정적 정렬을 사용하는지 확인한다.
9. 운영 백업 직후 0008을 적용하고 이 검사가 `aligned`를 반환하는지 확인한다.

객체가 있다는 이유만으로 ledger 행을 즉시 삽입하지 않는다. 제약조건, index, view 정의 중 일부가
다를 수 있기 때문이다. 운영 DB에서 `npm run migrate`를 먼저 시도해 오류를 관찰하는 방식도 사용하지
않는다.

## 새 migration 체크리스트

- 적용된 과거 migration SQL은 수정하지 않고 새 번호를 추가한다.
- `_journal.json`과 SQL 파일을 같은 커밋에 넣는다.
- 비멱등 rename/drop/constraint 변경에는 catalog 후조건을 drift 검사에 추가한다.
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

테스트는 정상 일치, 일반 pending, 현재 운영 DB 형태의 schema-ahead, 부분 적용, hash 불일치,
DB-ahead, ledger 누락을 모두 검증한다.
