import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const DB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(resolve(DB_ROOT, relative), "utf8");
const canonical = "2026-08-14T15:02:34.715Z";
const revision = "0B7g-BxntbHDzNXJMeGkvdzhrOWtpV1h0ZmFIN1kyRC9helIwPQ";

const config = JSON.parse(read("config/path_b_canonical_timestamp.v1.json"));
const bootstrap = read("scripts/bootstrap-path-b.sh");
const wage = read("scripts/ingest.sh");
const industrialCli = read("scripts/ingest-industrial-safety.sh");
const reduced = read("scripts/sql/industrial_safety_reduced_loader.sql");
const full = read("scripts/sql/industrial_safety_loader.sql");
const exactGate = read("scripts/sql/assert-path-b-rebuild.sql");

test("canonical rebuild clock is an exact reviewed Drive revision contract", () => {
  assert.deepEqual(Object.keys(config).sort(), [
    "archive_bytes",
    "archive_name",
    "canonical_timestamp",
    "contract_version",
    "drive_file_id",
    "drive_revision",
    "source",
  ]);
  assert.equal(config.contract_version, "path_b_canonical_timestamp.v1.0");
  assert.equal(config.canonical_timestamp, canonical);
  assert.equal(config.source, "approved_archive.modified_time");
  assert.equal(config.archive_name, "shared-SeD-full-20260814.tar.gz");
  assert.equal(config.archive_bytes, 66_580_543_642);
  assert.equal(config.drive_file_id, "1s7r3zt6mEYqI0I89dgRR4EzUh6sn4PQG");
  assert.equal(config.drive_revision, revision);

  assert.match(bootstrap, /path_b_canonical_timestamp\.v1\.json/);
  assert.match(bootstrap, /canonical timestamp Python UTC round trip mismatch/);
  assert.match(bootstrap, /canonical timestamp PostgreSQL UTC round trip mismatch/);
  assert.match(bootstrap, new RegExp(revision));
  assert.match(bootstrap, /"contract": "path_b_bootstrap_provenance\.v1\.1"/);
  assert.match(bootstrap, /"canonical_rebuild_clock": \{/);
  for (const field of [
    "timestamp", "source", "contract_file", "contract_path", "contract_sha256",
    "archive_name", "archive_bytes", "drive_file_id", "drive_revision",
  ]) {
    assert.match(bootstrap, new RegExp(`"${field}"`));
  }
  assert.ok(
    (bootstrap.match(/--canonical-timestamp "\$CANONICAL_TIMESTAMP"/g) ?? []).length >= 3,
    "bootstrap must pass the reviewed clock to every mutation path",
  );
  assert.match(bootstrap, /canonical timestamp and source archive contracts are not the same revision/);
  assert.match(bootstrap, /"modified_time": archive_contract\["archive"\]\["modified_time"\]/);
  assert.match(bootstrap, /"drive_revision": archive_contract\["drive"\]\["revision_after"\]/);
  assert.match(bootstrap, /set\(archive_contract\) != \{"name", "bytes", "sha256", "modified_time"\}/);
  assert.match(bootstrap, /source archive contract not found/);
});

test("all mutation entrypoints require and bind the explicit clock", () => {
  for (const script of [bootstrap, wage, industrialCli]) {
    assert.match(script, /--canonical-timestamp/);
    assert.ok(script.includes("[0-9]{3}Z"));
  }
  assert.match(wage, /-v "canonical_timestamp=\$CANONICAL_TIMESTAMP"/);
  assert.match(wage, /batches .*ingested_at/s);
  assert.match(wage, /stg_path_b_canonical_clock/);
  assert.match(industrialCli, /-v "canonical_timestamp=\$CANONICAL_TIMESTAMP"/);
});

test("reduced and full SQL loaders never use transaction time and preserve ID order", () => {
  for (const sql of [reduced, full]) {
    assert.doesNotMatch(
      sql,
      /\b(?:now|current_timestamp|statement_timestamp|transaction_timestamp|clock_timestamp)\s*\(/i,
    );
    assert.match(sql, /canonical_timestamp is required/);
    assert.match(sql, /canonical timestamp failed exact UTC round trip/);
    assert.match(sql, /ORDER BY staged\.run_code COLLATE "C"/);
    assert.match(sql, /ORDER BY .*source_run_code COLLATE "C", .*dataset_code COLLATE "C"/);
    assert.match(sql, /registered_at[\s\S]*stg_path_b_canonical_clock/);
    assert.match(sql, /validated_at = \(SELECT canonical_timestamp/);
    assert.match(sql, /published_at = \(SELECT canonical_timestamp/);
    assert.match(sql, /canonical_clock_integrity/);
  }
  for (const table of [
    "pipeline_run_dependencies", "cell_label_datasets", "cell_week_predictions",
    "cell_week_labels",
  ]) {
    assert.match(reduced, new RegExp(`industrial_safety\\.${table}`));
    assert.match(full, new RegExp(`industrial_safety\\.${table}`));
  }
  assert.match(reduced, /industrial_safety\.firm_risk_results/);
  for (const table of [
    "workplaces", "workplace_snapshots", "workplace_allocation_cells",
    "workplace_predictions",
  ]) {
    assert.match(full, new RegExp(`industrial_safety\\.${table}`));
  }
});

test("exact Path B gate hard-rejects every non-canonical fingerprint timestamp", () => {
  assert.match(exactGate, new RegExp(canonical.replaceAll(".", "\\.")));
  assert.match(exactGate, /canonical timestamp must be exactly/);
  for (const [table, column] of [
    ["public.batches", "ingested_at"],
    ["industrial_safety.pipeline_runs", "registered_at"],
    ["industrial_safety.pipeline_runs", "validated_at"],
    ["industrial_safety.pipeline_runs", "published_at"],
    ["industrial_safety.pipeline_run_dependencies", "created_at"],
    ["industrial_safety.cell_label_datasets", "created_at"],
    ["industrial_safety.cell_week_predictions", "created_at"],
    ["industrial_safety.cell_week_labels", "created_at"],
    ["industrial_safety.firm_risk_results", "created_at"],
    ["industrial_safety.firm_links", "created_at"],
    ["industrial_safety.workplaces", "created_at"],
    ["industrial_safety.workplace_snapshots", "created_at"],
    ["industrial_safety.workplace_allocation_cells", "created_at"],
    ["industrial_safety.workplace_predictions", "created_at"],
  ]) {
    assert.ok(exactGate.includes(table), `missing exact clock gate for ${table}`);
    assert.ok(exactGate.includes(column), `missing exact clock column ${column}`);
  }
});
