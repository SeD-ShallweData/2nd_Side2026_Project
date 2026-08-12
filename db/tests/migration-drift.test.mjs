import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  POSTCONDITION_KEYS,
  analyzeMigrationState,
} from "../scripts/migration-drift-core.mjs";

function migrations(count = 9) {
  const tags = [
    "0000_init",
    "0001_extensions",
    "0002_bot_views",
    "0003_target_month",
    "0004_industrial_safety",
    "0005_existing_firms_projection",
    "0006_risk_tier",
    "0007_current_batch_views",
    "0008_deterministic_current_batch",
  ];
  return tags.slice(0, count).map((tag, idx) => ({
    idx,
    tag,
    when: 1_786_000_000_000 + idx,
    hash: `hash-${idx}`,
  }));
}

function ledger(local, count = local.length) {
  return local.slice(0, count).map((migration, index) => ({
    id: index + 1,
    hash: migration.hash,
    created_at: migration.when,
  }));
}

function checkValues(tag, value) {
  return Object.fromEntries(POSTCONDITION_KEYS[tag].map((key) => [key, value]));
}

function postconditions(value) {
  return Object.fromEntries(
    Object.keys(POSTCONDITION_KEYS).map((tag) => [tag, checkValues(tag, value)]),
  );
}

describe("migration drift predeploy 판정", () => {
  it("journal·ledger·적용 후조건이 모두 일치할 때만 배포를 허용한다", () => {
    const local = migrations();
    const result = analyzeMigrationState({
      localMigrations: local,
      ledgerExists: true,
      ledgerRows: ledger(local),
      postconditions: postconditions(true),
    });

    assert.equal(result.status, "aligned");
    assert.equal(result.blocked, false);
  });

  it("정상 prefix 뒤의 미적용 migration은 pending으로 차단한다", () => {
    const local = migrations();
    const result = analyzeMigrationState({
      localMigrations: local,
      ledgerExists: true,
      ledgerRows: ledger(local, 6),
      postconditions: postconditions(false),
    });

    assert.equal(result.status, "pending_migrations");
    assert.deepEqual(result.pending, [
      "0006_risk_tier",
      "0007_current_batch_views",
      "0008_deterministic_current_batch",
    ]);
    assert.equal(result.blocked, true);
  });

  it("현재 운영 DB처럼 ledger는 6행인데 0006/0007 객체가 있으면 schema-ahead로 설명한다", () => {
    const local = migrations();
    const result = analyzeMigrationState({
      localMigrations: local,
      ledgerExists: true,
      ledgerRows: ledger(local, 6),
      postconditions: {
        "0006_risk_tier": checkValues("0006_risk_tier", true),
        "0007_current_batch_views": checkValues("0007_current_batch_views", true),
        "0008_deterministic_current_batch": checkValues(
          "0008_deterministic_current_batch",
          false,
        ),
      },
    });

    assert.equal(result.status, "schema_ahead_of_ledger");
    assert.deepEqual(result.schemaAhead.map((entry) => entry.tag), [
      "0006_risk_tier",
      "0007_current_batch_views",
    ]);
    assert.match(result.summary, /npm run migrate/);
    assert.equal(result.blocked, true);
  });

  it("pending migration의 후조건 일부만 존재하면 부분 적용으로 차단한다", () => {
    const local = migrations();
    const partial = checkValues("0006_risk_tier", false);
    partial[POSTCONDITION_KEYS["0006_risk_tier"][0]] = true;
    const result = analyzeMigrationState({
      localMigrations: local,
      ledgerExists: true,
      ledgerRows: ledger(local, 6),
      postconditions: {
        "0006_risk_tier": partial,
        "0007_current_batch_views": checkValues("0007_current_batch_views", false),
        "0008_deterministic_current_batch": checkValues(
          "0008_deterministic_current_batch",
          false,
        ),
      },
    });

    assert.equal(result.status, "partial_schema_application");
    assert.equal(result.partialSchema[0].tag, "0006_risk_tier");
  });

  it("적용 migration의 hash가 바뀌면 첫 불일치에서 차단한다", () => {
    const local = migrations();
    const rows = ledger(local);
    rows[3] = { ...rows[3], hash: "unexpected-hash" };
    const result = analyzeMigrationState({
      localMigrations: local,
      ledgerExists: true,
      ledgerRows: rows,
    });

    assert.equal(result.status, "ledger_diverged");
    assert.equal(result.mismatch.index, 3);
    assert.equal(result.mismatch.sameHash, false);
  });

  it("ledger에는 적용됐지만 알려진 schema 후조건이 깨졌으면 차단한다", () => {
    const local = migrations();
    const broken = checkValues("0007_current_batch_views", true);
    broken["view:public.v_current_safe"] = false;
    const result = analyzeMigrationState({
      localMigrations: local,
      ledgerExists: true,
      ledgerRows: ledger(local),
      postconditions: {
        ...postconditions(true),
        "0007_current_batch_views": broken,
      },
    });

    assert.equal(result.status, "applied_schema_mismatch");
    assert.equal(result.appliedSchemaMismatch[0].tag, "0007_current_batch_views");
    assert.equal(result.blocked, true);
  });

  it("DB ledger가 로컬보다 길거나 ledger 자체가 없으면 차단한다", () => {
    const local = migrations(6);
    const ahead = [...ledger(local), { id: 7, hash: "unknown", created_at: 1_900_000_000_000 }];

    assert.equal(
      analyzeMigrationState({
        localMigrations: local,
        ledgerExists: true,
        ledgerRows: ahead,
      }).status,
      "database_ahead",
    );
    assert.equal(
      analyzeMigrationState({
        localMigrations: local,
        ledgerExists: false,
        ledgerRows: [],
      }).status,
      "ledger_missing",
    );
  });
});
