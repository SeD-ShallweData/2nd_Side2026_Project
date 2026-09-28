# 복원 전 삭제·탈퇴·만료 재적용 게이트

기준: 상담은 마지막 활동부터 30일, 백업은 생성 뒤 최대 30일, 피드백 저장 OFF.
이 문서는 **새 격리 복원 DB**에만 적용한다. 운영 DB나 기존 복원 자산을 대상으로
명령을 실행하지 않는다. 서비스 연결 전까지 앱·worker·timer의 대상 연결을 막는다.

## 현재 증거와 빈 곳

- 코드의 대화 삭제는 `conversation_threads` hard delete와 하위 행 cascade,
  계정 탈퇴는 `users` hard delete와 session·대화 cascade다.
  만료 worker는 한 번에 최대 100개를 삭제한다. 접근 시 `expires_at`도 검사하지만
  실제 물리 삭제에는 backlog 지연이 있을 수 있다.
- `infra/OPERATIONS.md`는 custom `pg_dump`, SHA-256, 별도 DB `pg_restore` 예시다.
  2026-08-28/29의 로컬 복원 기록은 현 schema나 운영 백업의 증거가 아니다.
  Next 빌드 rollback 보관 개수는 DB 백업 TTL이 아니다.
- 현재 제품에는 백업 시점 **이후**의 수동 대화 삭제·계정 탈퇴를 독립적으로
  기록하고 복원에 재적용하는 완전한 삭제 원장이 없다. 만료 cutoff만으로는
  이 둘을 재현하지 못한다. 실제 운영 백업의 위치·형식·주기·TTL·최근 성공·
  복원 가능성과 운영 DB/worker 상태는 운영 담당자 확인 전까지 미확인이다.

## 승인된 최소 원장 정책과 필요한 구현

2026-09-29 사용자 승인: 사용자 UUID, 대화 UUID(대화 삭제일 때만), 삭제 시각만
암호화한 독립 원장에 백업 최장 생존 기간인 **최대 30일** 보관한다. 이메일·원문·
토큰·비밀번호는 원장에 넣지 않는다. 이 승인은 운영 DB/schema/migration 변경이나
배포 승인과 다르다.

최소 구현안은 삭제와 같은 DB 트랜잭션에서 FK 없는 outbox에 이벤트를 기록하고
hard delete를 커밋한 뒤, 별도 권한의 exporter가 이를 DB 백업과 다른 암호화
저장소에 순번대로 내보내는 것이다. 원장 접근은 복원 담당 서비스 계정으로 제한하고
읽기·내보내기·만료 삭제를 감사한다. 원장과 outbox는 30일을 넘기지 않으며
백업 메타데이터에는 생성·만료 시각과 archive SHA-256을 둔다. exporter가 뒤처지거나
순번이 빠지면 복원을 열지 않는다. 삭제가 성공한 뒤 원장 전달이 실패해도 삭제를
되돌리지 않고, outbox가 재전송하도록 한다. 재전송은 이벤트 ID/순번으로 멱등화한다.

이 outbox에는 **새 schema/migration이 필요하다. 현재 작업의 금지 범위라 정의·
코드 적용은 하지 않았다.** 도입 전 백업은 그 뒤의 삭제 기록이 없으므로 기존
live DB의 완전한 삭제 결정과 대조할 독립 증거가 없는 한 연결 복원에 쓰지 않는다.
원장이 현재 존재한다는 의미로 해석하지 않는다.

## 합성 리허설과 복원 게이트

`db/scripts/run-personal09-rehearsal.mjs`는 새 난수 이름의 `personal09` 라벨
PostgreSQL 16 컨테이너를 loopback에 만들고, 기존 0000~0020 migration, 합성
사용자 4명·대화·세션을 삽입한다. custom dump 후 live에서 대화 삭제, 탈퇴,
만료 삭제를 수행하고 **새 `mw_restore_*` DB**로 복원한다. 잘못된 해시·순번·
31일 TTL·이미 만료된 백업, 다른 DB 연결, 30일 초과 만료 설정,
중간 실패 rollback, 재적용, 재실행, cascade,
세션 무효화, 삭제 대화에 대한 늦은 쓰기 FK 거절을 검사한다. 자신의 컨테이너만
라벨·이름을 검사한 뒤 제거한다. 실제 백업은 사용하지 않는다.

```powershell
node db/scripts/run-personal09-rehearsal.mjs
```

운영에서 사용할 별도 복원 대상은 예를 들어 `mw_restore_<승인된_식별자>`처럼
새로 만든 이름이어야 한다. 해시를 **archive 파일 자체**에서 재계산하고, 독립
백업 목록의 값과 대조한다. `restore-deletion-replay.mjs`는 이 파일·기대 해시,
정확한 DB명과 보안 환경 변수의 URL을 요구한다. PostgreSQL major 16, 백업
최대 30일, 원장 범위·연속 순번·각 ID 형식, DB의 다른 연결 0개를 확인한다.
트랜잭션에서 수동 삭제·탈퇴, freeze 시각 만료 삭제, 전체 복원 세션 revoke,
사후 잔여 0건과 생존 대화의 `expires_at <= last_activity_at + 30 days`를
검사한다. 초과 행이 있으면 임의로 기간을 고치지 않고 중단한다. 실패하면
트랜잭션은 롤백된다.

```bash
# 실제 대상·경로·인증은 운영 담당자가 읽기 전용 조사 후 특정한다.
# URL은 보호된 환경에서 주입하고 stdout/history/문서에 기록하지 않는다.
node db/scripts/restore-deletion-replay.mjs \
  --manifest /protected/restore-events.json \
  --archive-file /protected/approved-backup.dump \
  --archive-sha256 <독립_목록에서_확인한_64자리_SHA256> \
  --expected-database mw_restore_<승인된_식별자>
```

manifest v1 예시 필드: `archive_sha256`, `archive_captured_at`,
`archive_expires_at`, `freeze_at`, `coverage.from/through/verified/
first_sequence/last_sequence`, `events[]`. 이벤트는
`sequence`, `kind=conversation_deleted|account_deleted`,
`owner_user_id`, 대화 삭제 때 `conversation_id`, `deleted_at`을 가진다.
`coverage.verified=true`만으로 **독립 원장의 완전성이 증명되지는 않는다.**
운영 담당자는 원장 저장소의 서명/감사 기록·high watermark와 백업 시점부터
쓰기 중단 시점까지의 연속 export를 별도로 대조해야 한다. 범위·출처가 없으면
도구 입력을 만들지 않고 중단한다.

## 운영 적용 및 복구 순서 (아직 실행 미승인)

1. 운영 담당자가 백업 방식(논리 dump/디스크 snapshot 등), 대상 DB, 생성 시각,
   주기, 만료 설정, 최근 성공, 실제 파일·목록 해시, PG major, migration ledger,
   독립 원장 존재/시작 시점과 high watermark를 **읽기 전용**으로 확인한다.
   백업 파일 존재만으로 복원 가능하다고 판정하지 않는다.
2. 대상·개인정보 접근자·격리 위치·폐기 시점·보안 설정·비용·서비스 중단 범위가
   특정된 별도 승인 후, 원본 서비스 쓰기·worker·timer를 중단하고 원장 export
   완료 시각을 freeze한다. 원본 DB는 읽기 전용으로 보존한다. 연결 대상은 바꾸지 않는다.
3. PostgreSQL 16의 **새 격리 DB**와 새 저장소에 승인된 백업을 복원한다.
   archive 해시·백업 TTL, schema/ledger drift, restore exit status, 행 수와
   필수 데이터 무결성을 검증한다. 원장 이벤트 구간이 백업 시각부터 freeze까지
   완전한지 독립 대조한다. 이전에 복원한 이름 비슷한 DB/volume은 사용하지 않는다.
4. 위 게이트를 실행하고 성공 응답의 `after.expired=0`,
   `after.over_retained=0`, `after.active_sessions=0`을 확인한다.
   원장 대상 사용자·대화와
   `expires_at<=freeze_at` 행이 0건인지 별도 읽기 전용 쿼리로 재검사한다.
   늦은 요청·worker 쓰기가 격리 DB에 들어올 통로가 없어야 한다.
5. 서비스 연결 전 smoke: 로그인은 **새 세션**만 허용, 삭제 계정 로그인 거절,
   삭제·만료 대화 조회 거절, 생존 대화 조회 및 새 대화 저장 성공,
   작업 재실행 no-op 확인. 실제 개인정보 원문을 출력하거나 보고서에 옮기지 않는다.
6. 어느 단계든 해시·원장 완전성·drift·게이트·smoke가 실패하면 서비스 전환을
   중단하고 격리 DB를 닫아둔다. 승인 범위에서 원본 서비스/DB를 되돌리되
   freeze 후 사용자 삭제·쓰기의 손실 가능성을 먼저 대조한다. 불확실하면
   원본도 임의 개방하지 않는다. 실패한 격리 자산의 폐기는 별도 승인 범위대로 한다.

실제 백업 리허설과 TTL 변경·백업 폐기·서비스 전환은 이 문서만으로 승인되지 않는다.
