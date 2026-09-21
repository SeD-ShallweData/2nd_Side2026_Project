import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  POSTCONDITION_KEYS,
  analyzeMigrationState,
} from "../scripts/migration-drift-core.mjs";

const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

const ALL_TAGS = [
  "0000_init",
  "0001_extensions",
  "0002_bot_views",
  "0003_target_month",
  "0004_industrial_safety",
  "0005_existing_firms_projection",
  "0006_risk_tier",
  "0007_current_batch_views",
  "0008_deterministic_current_batch",
  "0009_busy_puck",
  "0010_crazy_talos",
  "0011_lumpy_proteus",
  "0012_v_region_industry_signal",
  "0013_illegal_sir_ram",
  "0014_conversation_memory",
  "0015_conversation_summaries",
];

function migrations(count = ALL_TAGS.length) {
  const tags = ALL_TAGS;
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
      "0009_busy_puck",
      "0010_crazy_talos",
      "0011_lumpy_proteus",
      "0012_v_region_industry_signal",
      "0013_illegal_sir_ram",
      "0014_conversation_memory",
      "0015_conversation_summaries",
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

  it("0011의 컬럼 부재 후조건이 깨지면 차단한다", () => {
    // 덤프를 복원하면 users.role·firm_id 가 되살아난다. 원장은 0011 이 적용됐다고
    // 기록하고 있으므로, 이 부재 검사가 유일한 탐지 수단이다.
    const local = migrations();
    const restored = checkValues("0011_lumpy_proteus", true);
    restored["column_absent:public.users.role"] = false;

    const result = analyzeMigrationState({
      localMigrations: local,
      ledgerExists: true,
      ledgerRows: ledger(local),
      postconditions: { ...postconditions(true), "0011_lumpy_proteus": restored },
    });

    assert.equal(result.status, "applied_schema_mismatch");
    assert.equal(result.appliedSchemaMismatch[0].tag, "0011_lumpy_proteus");
    assert.deepEqual(result.appliedSchemaMismatch[0].failed, [
      "column_absent:public.users.role",
    ]);
    assert.equal(result.blocked, true);
  });

  it("0013의 K5 분류 제약이 예전 고정값으로 돌아가면 차단한다", () => {
    const local = migrations();
    const broken = checkValues("0013_illegal_sir_ram", true);
    broken["constraint_definition:public.worksite_tips.worksite_tips_category_ck"] = false;

    const result = analyzeMigrationState({
      localMigrations: local,
      ledgerExists: true,
      ledgerRows: ledger(local),
      postconditions: { ...postconditions(true), "0013_illegal_sir_ram": broken },
    });

    assert.equal(result.status, "applied_schema_mismatch");
    assert.equal(result.appliedSchemaMismatch[0].tag, "0013_illegal_sir_ram");
    assert.equal(result.blocked, true);
  });
});

describe("후조건 등록 자체의 무결성", () => {
  it("journal timestamps are strictly increasing and lease SQL never recreates existing tables", () => {
    const journal = JSON.parse(readFileSync(join(DB_DIR, "migrations/meta/_journal.json"), "utf8"));
    for (let i = 1; i < journal.entries.length; i++) assert.ok(journal.entries[i].when > journal.entries[i - 1].when);
    const sql = readFileSync(join(DB_DIR, "migrations/0019_conversation_summary_leases.sql"), "utf8");
    assert.doesNotMatch(sql, /CREATE\s+TABLE/i);
    assert.equal((sql.match(/ALTER TABLE/g) ?? []).length, 2);
    const prior = JSON.parse(readFileSync(join(DB_DIR, "migrations/meta/0018_snapshot.json"), "utf8"));
    const next = JSON.parse(readFileSync(join(DB_DIR, "migrations/meta/0019_snapshot.json"), "utf8"));
    assert.equal(next.prevId, prior.id);
    assert.equal(Object.keys(prior.tables).filter((key) => key.startsWith("public.conversation_")).length, 7);
    assert.equal(prior.tables["public.conversation_summaries"].columns.lease_token, undefined);
    assert.equal(next.tables["public.conversation_summaries"].columns.lease_token.type, "uuid");
  });
  // 키를 한쪽에만 적으면 검사가 조용히 통과하거나 모든 배포가 막힌다.
  // 두 파일을 사람이 대조하지 않아도 되게 여기서 고정한다.
  function sqlKeysByTag() {
    const source = readFileSync(join(DB_DIR, "scripts", "check-migration-drift.mjs"), "utf8");
    const block = source.slice(
      source.indexOf("const POSTCONDITIONS_SQL"),
      source.indexOf("function inspectDatabase"),
    );
    const tags = Object.keys(POSTCONDITION_KEYS);
    const positions = tags
      .map((tag) => ({ tag, at: block.indexOf(`'${tag}', json_build_object`) }))
      .sort((a, b) => a.at - b.at);

    return Object.fromEntries(
      positions.map(({ tag, at }, index) => {
        const end = positions[index + 1]?.at ?? block.length;
        const keys = [...block.slice(at, end).matchAll(/'([a-z_]+:[A-Za-z0-9_.]+)'\s*,/g)];
        return [tag, keys.map((match) => match[1])];
      }),
    );
  }

  it("POSTCONDITION_KEYS와 POSTCONDITIONS_SQL의 키가 정확히 같다", () => {
    const fromSql = sqlKeysByTag();
    for (const [tag, keys] of Object.entries(POSTCONDITION_KEYS)) {
      assert.ok(fromSql[tag], `${tag}의 SQL 블록이 없습니다.`);
      assert.deepEqual(
        [...fromSql[tag]].sort(),
        [...keys].sort(),
        `${tag}의 키가 두 파일에서 다릅니다.`,
      );
    }
  });

  it("journal의 모든 migration이 등록 여부를 명시적으로 갖는다", () => {
    const journal = JSON.parse(
      readFileSync(join(DB_DIR, "migrations", "meta", "_journal.json"), "utf8"),
    );
    // 0000~0005는 후조건을 애초에 적지 않았다(db/docs/DRIFT_CHECK_COVERAGE.md).
    // 그 뒤로 추가되는 migration은 반드시 같은 PR에서 키를 등록해야 한다.
    const FIRST_COVERED_INDEX = 6; // 0006_risk_tier 부터
    const unregistered = journal.entries
      .map((entry) => entry.tag)
      .filter(
        (tag) => Number(tag.slice(0, 4)) >= FIRST_COVERED_INDEX && !POSTCONDITION_KEYS[tag],
      );

    assert.deepEqual(
      unregistered,
      [],
      `후조건 미등록 migration이 있습니다: ${unregistered.join(", ")}. ` +
        "미등록 migration은 드리프트 검사에서 조용히 빠집니다.",
    );
  });

  it("0012의 부재 후조건은 뷰 존재와 함께 건다", () => {
    // NOT EXISTS 만 쓰면 뷰 자체가 없을 때도 참이 되어, 아직 적용하지 않은
    // migration이 "부분 적용"으로 보인다. 2026-09-13 운영 DB에서 실제로
    // 0/11이어야 할 것이 3/11로 나와 멀쩡한 DB를 DEPLOY BLOCKED로 읽게 했다.
    const source = readFileSync(
      join(DB_DIR, "scripts", "check-migration-drift.mjs"),
      "utf8",
    );
    const start = source.indexOf("'0012_v_region_industry_signal', json_build_object");
    assert.ok(start > 0, "0012 SQL 블록을 찾지 못했습니다.");
    const block = source.slice(start, source.indexOf(")::text;", start));

    for (const key of POSTCONDITION_KEYS["0012_v_region_industry_signal"]) {
      if (!key.startsWith("view_column_absent:")) continue;
      const at = block.indexOf(`'${key}'`);
      assert.ok(at > 0, `${key}의 SQL이 없습니다.`);
      const clause = block.slice(at, block.indexOf("\n    ),", at));
      assert.match(
        clause,
        /EXISTS \(\s*\n\s*SELECT 1 FROM pg_class/,
        `${key}는 뷰 존재 확인 없이 NOT EXISTS만 겁니다 — ` +
          "미적용 상태가 부분 적용으로 보입니다.",
      );
      assert.match(clause, /AND NOT EXISTS/, `${key}에 부재 확인이 없습니다.`);
    }
  });
});
