import type { DriftCheckRecord } from "@/domain/batch";

/*
 * 운영 DB 스키마 드리프트(migration 정합성) 검사의 **최근 결과를 사람이 적어 두는 곳**.
 *
 * 결정 41번(옵션 C): 화면에서 검사를 실시간으로 돌리지 않는다(A는 운영 DB에 부담·위험,
 * B는 검사 로그 테이블·인프라 작업이 필요). 배포 스크립트가 매번 돌리는
 * `cd db && npm run check:migration-drift` 결과를 운영자가 여기에 옮겨 적고 배포한다.
 *
 * 갱신 방법
 *  1. 서버에서 `npm run check:migration-drift` 출력의 `상태:`, `로컬 journal`, `DB ledger`,
 *     `적용 대기`, 후조건 충족 수를 확인한다.
 *  2. 아래 값을 바꾸고 `checked_at`·`recorded_by`·`notes` 를 갱신한다.
 *  3. 모르는 값은 null 로 둔다. 화면은 null 을 "미기록"으로 보여 주고 추정하지 않는다.
 *
 * 경고·검사 불가 건수 정의(정의서 §4 "정상 옆에 항상 경고 N건·검사 불가 N건")
 *  - 경고: 검사기가 DEPLOY BLOCKED 로 막지는 않았지만 확인이 필요한 항목.
 *    migration 검사기에는 별도 경고 등급이 없으므로 "적용 대기(pending) migration 수"를 적는다.
 *  - 검사 불가: 후조건이 없어 실물 객체를 확인하지 못하는 migration 수.
 *    0000~0005 여섯 개는 후조건이 없다(db/docs/DRIFT_CHECK_COVERAGE.md). "⚪를 ✅로 세지 않는다".
 */
export const LATEST_DRIFT_CHECK: DriftCheckRecord = {
  source: "manual",
  checked_at: "2026-09-29",
  target: "운영 서버 DB",
  command: "cd db && npm run check:migration-drift",
  result: "aligned",
  migrations_applied: 22,
  migrations_expected: 22,
  last_migration: "0021_ops_console",
  postconditions_passed: 129,
  postconditions_total: 129,
  warning_count: 0,
  unverifiable_count: 6,
  unrecorded_migrations: ["0022_current_sido_names"],
  recorded_by: "운영 담당(수동 기입)",
  notes: [
    "경고 0건 = 적용 대기 migration 0건(검사기에는 별도 경고 등급이 없음).",
    "검사 불가 6건 = 후조건이 없는 0000~0005 migration. 원장 hash 는 일치하지만 실물 객체는 확인하지 않는다.",
    "이 기록 이후 0022_current_sido_names(#146, 2026-09-30 병합)가 운영에 적용됐는지는 기록되지 않았다. 적용 후 재검사 전까지 현재 정합성은 미확인이다.",
  ],
};
