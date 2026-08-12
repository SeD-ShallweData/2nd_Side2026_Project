export const POSTCONDITION_KEYS = Object.freeze({
  "0006_risk_tier": Object.freeze([
    "column:public.scored_active.risk_tier",
    "column:public.inspector_queue.queue_priority",
    "column_absent:public.inspector_queue.grade",
    "column:public.batches.model_sha",
    "table:public.risk_tier_meta",
    "index:public.scored_batch_tier_idx",
    "index:public.queue_batch_priority_idx",
  ]),
  "0007_current_batch_views": Object.freeze([
    "view:public.v_current_batch",
    "view:public.v_current_scored",
    "view:public.v_current_queue",
    "view:public.v_current_safe",
    "view:public.v_risk_history",
    "index:public.scored_firm_batch_idx",
    "view_definition:public.v_current_batch_uses_as_of_date",
  ]),
  "0008_deterministic_current_batch": Object.freeze([
    "view_definition:public.v_current_batch_uses_deterministic_tiebreakers",
  ]),
});

function migrationLabel(migration) {
  return migration?.tag ?? "알 수 없는 migration";
}

function evaluatePostconditions(tag, postconditions) {
  const keys = POSTCONDITION_KEYS[tag];
  if (!keys) return null;
  const values = postconditions?.[tag] ?? {};
  const passed = keys.filter((key) => values[key] === true);
  const failed = keys.filter((key) => values[key] !== true);
  return {
    tag,
    passed,
    failed,
    passedCount: passed.length,
    totalCount: keys.length,
    state: passed.length === keys.length ? "complete" : passed.length > 0 ? "partial" : "absent",
  };
}

function summaryFor(status, details) {
  switch (status) {
    case "aligned":
      return "로컬 migration journal과 DB ledger 및 알려진 schema 후조건이 일치합니다.";
    case "ledger_missing":
      return "Drizzle migration ledger가 없습니다. 이 DB에 자동 배포하지 마세요.";
    case "database_ahead":
      return "DB ledger가 로컬 journal보다 앞서 있습니다. 더 최신 소스인지 확인해야 합니다.";
    case "ledger_diverged":
      return `DB ledger가 ${migrationLabel(details.mismatch?.expected)}의 hash/created_at과 다릅니다.`;
    case "applied_schema_mismatch":
      return "적용됐다고 기록된 migration의 schema 후조건이 현재 DB에서 충족되지 않습니다.";
    case "partial_schema_application":
      return "ledger에 없는 migration의 schema 일부만 존재합니다. 부분 적용 상태이므로 자동 migration을 금지합니다.";
    case "schema_ahead_of_ledger":
      return "migration 객체는 DB에 이미 존재하지만 ledger 행이 없습니다. npm run migrate를 실행하면 재적용을 시도하므로 금지합니다.";
    case "pending_migrations":
      return "DB ledger는 로컬 journal의 정상 prefix이지만 적용 대기 migration이 있습니다.";
    default:
      return "migration 상태를 판정할 수 없습니다.";
  }
}

/**
 * DB를 조회하지 않는 순수 판정 함수다. CLI와 node:test가 같은 규칙을 공유한다.
 */
export function analyzeMigrationState({
  localMigrations,
  ledgerExists,
  ledgerRows,
  postconditions = {},
}) {
  if (!Array.isArray(localMigrations) || !Array.isArray(ledgerRows)) {
    throw new TypeError("localMigrations와 ledgerRows는 배열이어야 합니다.");
  }

  const base = {
    blocked: true,
    ledgerExists: Boolean(ledgerExists),
    localCount: localMigrations.length,
    ledgerCount: ledgerRows.length,
    matchedCount: 0,
    lastApplied: null,
    pending: [],
    schemaAhead: [],
    partialSchema: [],
    appliedSchemaMismatch: [],
    mismatch: null,
  };

  if (!ledgerExists) {
    const result = { ...base, status: "ledger_missing" };
    return { ...result, summary: summaryFor(result.status, result) };
  }

  if (ledgerRows.length > localMigrations.length) {
    const result = { ...base, status: "database_ahead" };
    return { ...result, summary: summaryFor(result.status, result) };
  }

  for (let index = 0; index < ledgerRows.length; index += 1) {
    const expected = localMigrations[index];
    const actual = ledgerRows[index];
    const sameHash = actual?.hash === expected?.hash;
    const sameCreatedAt = Number(actual?.created_at) === Number(expected?.when);
    if (!sameHash || !sameCreatedAt) {
      const result = {
        ...base,
        matchedCount: index,
        lastApplied: index > 0 ? localMigrations[index - 1].tag : null,
        mismatch: { index, expected, actual, sameHash, sameCreatedAt },
        status: "ledger_diverged",
      };
      return { ...result, summary: summaryFor(result.status, result) };
    }
  }

  const matchedCount = ledgerRows.length;
  const lastApplied = matchedCount > 0 ? localMigrations[matchedCount - 1].tag : null;
  const pendingMigrations = localMigrations.slice(matchedCount);
  const appliedChecks = localMigrations
    .slice(0, matchedCount)
    .map((migration) => evaluatePostconditions(migration.tag, postconditions))
    .filter(Boolean);
  const pendingChecks = pendingMigrations
    .map((migration) => evaluatePostconditions(migration.tag, postconditions))
    .filter(Boolean);

  const appliedSchemaMismatch = appliedChecks.filter((check) => check.state !== "complete");
  const partialSchema = pendingChecks.filter((check) => check.state === "partial");
  const schemaAhead = pendingChecks.filter((check) => check.state === "complete");
  const details = {
    ...base,
    matchedCount,
    lastApplied,
    pending: pendingMigrations.map((migration) => migration.tag),
    schemaAhead,
    partialSchema,
    appliedSchemaMismatch,
  };

  let status;
  if (appliedSchemaMismatch.length > 0) status = "applied_schema_mismatch";
  else if (partialSchema.length > 0) status = "partial_schema_application";
  else if (schemaAhead.length > 0) status = "schema_ahead_of_ledger";
  else if (pendingMigrations.length > 0) status = "pending_migrations";
  else status = "aligned";

  const result = { ...details, status, blocked: status !== "aligned" };
  return { ...result, summary: summaryFor(status, result) };
}
