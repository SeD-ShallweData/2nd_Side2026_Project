#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  POSTCONDITION_KEYS,
  analyzeMigrationState,
} from "./migration-drift-core.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_ENV_FILE = resolve(DB_ROOT, ".env.local");
const JOURNAL_FILE = resolve(DB_ROOT, "migrations/meta/_journal.json");

function usage() {
  return `Usage: node scripts/check-migration-drift.mjs [options]

Options:
  --env-file <path>  DB 접속값을 읽을 env 파일 (기본: db/.env.local)
  --json             사람이 읽는 보고서 대신 JSON 출력
  --help             도움말 출력

환경변수 MIGRATION_DATABASE_URL 또는 DATABASE_URL이 env 파일보다 우선합니다.
이 검사는 SELECT만 실행하고 PostgreSQL 세션도 default_transaction_read_only=on으로 강제합니다.`;
}

function parseArgs(argv) {
  const options = {
    envFile: process.env.MIGRATION_ENV_FILE
      ? resolve(process.env.MIGRATION_ENV_FILE)
      : DEFAULT_ENV_FILE,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--help") options.help = true;
    else if (argument === "--env-file") {
      const value = argv[index + 1];
      if (!value) throw new Error("--env-file 뒤에 경로가 필요합니다.");
      options.envFile = resolve(value);
      index += 1;
    } else {
      throw new Error(`지원하지 않는 인자입니다: ${argument}`);
    }
  }
  return options;
}

function parseEnvText(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trimStart() : line;
    const separator = normalized.indexOf("=");
    if (separator < 1) continue;
    const key = normalized.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = normalized.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function readConnectionValues(envFile) {
  const fileValues = existsSync(envFile)
    ? parseEnvText(readFileSync(envFile, "utf8"))
    : {};
  return { ...fileValues, ...process.env };
}

function requiredPort(value) {
  const port = Number(value ?? 5432);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("DB_PORT가 1~65535 범위의 정수가 아닙니다.");
  }
  return String(port);
}

function connectionFromUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("MIGRATION_DATABASE_URL/DATABASE_URL이 유효한 URL이 아닙니다.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("migration drift 검사는 PostgreSQL URL만 지원합니다.");
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!url.hostname || !url.username || !database) {
    throw new Error("PostgreSQL URL에는 host, user, database가 필요합니다.");
  }
  return {
    host: url.hostname,
    port: requiredPort(url.port || 5432),
    user: decodeURIComponent(url.username),
    password: url.password ? decodeURIComponent(url.password) : undefined,
    database,
    sslmode: url.searchParams.get("sslmode") ?? undefined,
  };
}

function resolveConnection(values) {
  const directUrl = values.MIGRATION_DATABASE_URL?.trim() || values.DATABASE_URL?.trim();
  if (directUrl) return connectionFromUrl(directUrl);

  const user = values.DB_USER?.trim();
  const database = values.DB_NAME?.trim();
  if (!user || !database) {
    throw new Error(
      "DB 접속 설정이 없습니다. --env-file 또는 MIGRATION_DATABASE_URL을 지정하세요.",
    );
  }
  return {
    host: values.DB_HOST?.trim() || "127.0.0.1",
    port: requiredPort(values.DB_PORT),
    user,
    password: values.DB_PASSWORD,
    database,
    sslmode: values.PGSSLMODE?.trim() || undefined,
  };
}

function psqlJson(connection, sql) {
  const args = [
    "-X",
    "--no-psqlrc",
    "--no-password",
    "--quiet",
    "--host",
    connection.host,
    "--port",
    connection.port,
    "--username",
    connection.user,
    "--dbname",
    connection.database,
    "--tuples-only",
    "--no-align",
    "--set",
    "ON_ERROR_STOP=1",
    "--command",
    sql,
  ];
  const pgOptions = [
    process.env.PGOPTIONS,
    "-c default_transaction_read_only=on",
    "-c statement_timeout=10000",
    "-c lock_timeout=1000",
  ]
    .filter(Boolean)
    .join(" ");
  const child = spawnSync("psql", args, {
    encoding: "utf8",
    env: {
      ...process.env,
      PGOPTIONS: pgOptions,
      ...(connection.password ? { PGPASSWORD: connection.password } : {}),
      ...(connection.sslmode ? { PGSSLMODE: connection.sslmode } : {}),
    },
    timeout: 15_000,
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    const message = child.stderr.trim().replace(/\s+/g, " ");
    throw new Error(`읽기 전용 DB 검사 실패: ${message || `psql exit ${child.status}`}`);
  }
  const output = child.stdout.trim();
  try {
    return JSON.parse(output);
  } catch {
    throw new Error("DB 검사 결과를 JSON으로 해석하지 못했습니다.");
  }
}

function loadLocalMigrations() {
  const journal = JSON.parse(readFileSync(JOURNAL_FILE, "utf8"));
  if (!Array.isArray(journal.entries)) {
    throw new Error("migration journal의 entries가 배열이 아닙니다.");
  }
  return journal.entries.map((entry, index) => {
    if (entry.idx !== index || typeof entry.tag !== "string" || !/^\d{4}_[a-z0-9_]+$/i.test(entry.tag)) {
      throw new Error(`migration journal ${index}번 항목이 올바르지 않습니다.`);
    }
    const migrationFile = resolve(DB_ROOT, "migrations", `${entry.tag}.sql`);
    if (!existsSync(migrationFile)) {
      throw new Error(`migration SQL이 없습니다: ${entry.tag}.sql`);
    }
    const contents = readFileSync(migrationFile);
    return {
      idx: entry.idx,
      tag: entry.tag,
      when: Number(entry.when),
      hash: createHash("sha256").update(contents).digest("hex"),
    };
  });
}

const LEDGER_EXISTS_SQL = `
BEGIN TRANSACTION READ ONLY;
SELECT json_build_object(
  'exists', to_regclass('drizzle.__drizzle_migrations') IS NOT NULL
)::text;
COMMIT;
`;

const LEDGER_ROWS_SQL = `
BEGIN TRANSACTION READ ONLY;
SELECT COALESCE(
  json_agg(json_build_object(
    'id', ledger.id,
    'hash', ledger.hash,
    'created_at', ledger.created_at
  ) ORDER BY ledger.created_at, ledger.id),
  '[]'::json
)::text
FROM drizzle.__drizzle_migrations AS ledger;
COMMIT;
`;

const POSTCONDITIONS_SQL = `
BEGIN TRANSACTION READ ONLY;
SELECT json_build_object(
  '0006_risk_tier', json_build_object(
    'column:public.scored_active.risk_tier', EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='scored_active' AND column_name='risk_tier'
    ),
    'column:public.inspector_queue.queue_priority', EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='inspector_queue' AND column_name='queue_priority'
    ),
    'column_absent:public.inspector_queue.grade', NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='inspector_queue' AND column_name='grade'
    ),
    'column:public.batches.model_sha', EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='batches' AND column_name='model_sha'
    ),
    'table:public.risk_tier_meta', EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname='risk_tier_meta' AND c.relkind IN ('r','p')
    ),
    'index:public.scored_batch_tier_idx', EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname='scored_batch_tier_idx' AND c.relkind IN ('i','I')
    ),
    'index:public.queue_batch_priority_idx', EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname='queue_batch_priority_idx' AND c.relkind IN ('i','I')
    )
  ),
  '0007_current_batch_views', json_build_object(
    'view:public.v_current_batch', EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname='v_current_batch' AND c.relkind='v'
    ),
    'view:public.v_current_scored', EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname='v_current_scored' AND c.relkind='v'
    ),
    'view:public.v_current_queue', EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname='v_current_queue' AND c.relkind='v'
    ),
    'view:public.v_current_safe', EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname='v_current_safe' AND c.relkind='v'
    ),
    'view:public.v_risk_history', EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname='v_risk_history' AND c.relkind='v'
    ),
    'index:public.scored_firm_batch_idx', EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname='scored_firm_batch_idx' AND c.relkind IN ('i','I')
    ),
    'view_definition:public.v_current_batch_uses_as_of_date', COALESCE((
      SELECT definition ~* 'as_of_date[[:space:]]+IS[[:space:]]+NOT[[:space:]]+NULL'
         AND definition ~* 'ORDER[[:space:]]+BY[[:space:]]+([^[:space:]]+\\.)?as_of_date[[:space:]]+DESC'
      FROM (
        SELECT pg_get_viewdef(to_regclass('public.v_current_batch'), true) AS definition
      ) AS current_batch_definition
    ), false)
  ),
  '0008_deterministic_current_batch', json_build_object(
    'view_definition:public.v_current_batch_uses_deterministic_tiebreakers', COALESCE((
      SELECT definition ~* 'ORDER[[:space:]]+BY[[:space:]]+([^[:space:],]+\\.)?as_of_date[[:space:]]+DESC,[[:space:]]*([^[:space:],]+\\.)?ingested_at[[:space:]]+DESC,[[:space:]]*([^[:space:],]+\\.)?id[[:space:]]+DESC'
      FROM (
        SELECT pg_get_viewdef(to_regclass('public.v_current_batch'), true) AS definition
      ) AS deterministic_current_batch_definition
    ), false)
  )
)::text;
COMMIT;
`;

function inspectDatabase(connection) {
  const ledgerMeta = psqlJson(connection, LEDGER_EXISTS_SQL);
  const ledgerExists = ledgerMeta.exists === true;
  const ledgerRows = ledgerExists ? psqlJson(connection, LEDGER_ROWS_SQL) : [];
  const postconditions = psqlJson(connection, POSTCONDITIONS_SQL);
  return { ledgerExists, ledgerRows, postconditions };
}

function safeTarget(connection) {
  return `${connection.host}:${connection.port}/${connection.database} (user=${connection.user})`;
}

function printCheck(check, prefix = "  ") {
  console.log(`${prefix}${check.tag}: ${check.passedCount}/${check.totalCount} 후조건 충족`);
  for (const key of check.failed) console.log(`${prefix}  - 누락: ${key}`);
}

function printHuman(result, connection) {
  console.log("Migration drift predeploy check (READ ONLY)");
  console.log(`대상: ${safeTarget(connection)}`);
  console.log(`상태: ${result.status}${result.blocked ? " — DEPLOY BLOCKED" : ""}`);
  console.log(`로컬 journal: ${result.localCount}개`);
  console.log(`DB ledger: ${result.ledgerCount}개 (일치 prefix ${result.matchedCount}개)`);
  console.log(`마지막 기록: ${result.lastApplied ?? "없음"}`);
  console.log(`적용 대기: ${result.pending.length > 0 ? result.pending.join(", ") : "없음"}`);
  console.log(result.summary);

  if (result.schemaAhead.length > 0) {
    console.log("ledger보다 앞선 schema:");
    for (const check of result.schemaAhead) printCheck(check);
  }
  if (result.partialSchema.length > 0) {
    console.log("부분 적용 schema:");
    for (const check of result.partialSchema) printCheck(check);
  }
  if (result.appliedSchemaMismatch.length > 0) {
    console.log("적용 기록과 불일치하는 schema:");
    for (const check of result.appliedSchemaMismatch) printCheck(check);
  }
  if (result.mismatch) {
    console.log(`불일치 위치: index ${result.mismatch.index}`);
    console.log(`기대 migration: ${result.mismatch.expected?.tag ?? "없음"}`);
    console.log(`hash 일치: ${result.mismatch.sameHash}`);
    console.log(`created_at 일치: ${result.mismatch.sameCreatedAt}`);
  }
  if (result.blocked) {
    console.log("조치: DB dump와 schema 검증 없이 npm run migrate 또는 ledger 수정을 실행하지 마세요.");
  }
}

function assertPostconditionContract(postconditions) {
  for (const [tag, keys] of Object.entries(POSTCONDITION_KEYS)) {
    const actual = postconditions?.[tag];
    if (!actual || typeof actual !== "object") {
      throw new Error(`DB 후조건 결과에 ${tag}가 없습니다.`);
    }
    for (const key of keys) {
      if (typeof actual[key] !== "boolean") {
        throw new Error(`DB 후조건 결과가 누락됐습니다: ${tag} / ${key}`);
      }
    }
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }
  const localMigrations = loadLocalMigrations();
  const values = readConnectionValues(options.envFile);
  const connection = resolveConnection(values);
  const inspected = inspectDatabase(connection);
  assertPostconditionContract(inspected.postconditions);
  const result = analyzeMigrationState({ localMigrations, ...inspected });
  if (options.json) {
    console.log(JSON.stringify({ target: safeTarget(connection), ...result }, null, 2));
  } else {
    printHuman(result, connection);
  }
  return result.blocked ? 2 : 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`Migration drift 검사 오류: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
