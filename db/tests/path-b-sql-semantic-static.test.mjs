import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = resolve(TEST_DIR, "..");
const emptyGate = readFileSync(
  resolve(DB_ROOT, "scripts/sql/assert-empty-path-b-restore-target.sql"),
  "utf8",
);
const exactGate = readFileSync(
  resolve(DB_ROOT, "scripts/sql/assert-path-b-rebuild.sql"),
  "utf8",
);

test("empty Path B gate covers non-relation dumpable semantic catalogs", () => {
  for (const catalog of [
    "pg_collation",
    "pg_conversion",
    "pg_cast",
    "pg_operator",
    "pg_opclass",
    "pg_opfamily",
    "pg_ts_parser",
    "pg_ts_dict",
    "pg_ts_template",
    "pg_ts_config",
    "pg_transform",
    "pg_statistic_ext",
    "pg_am",
    "pg_language",
  ]) {
    assert.ok(emptyGate.includes(catalog), `empty gate omits ${catalog}`);
  }
  assert.match(emptyGate, /FirstNormalObjectId \(16384\)/);
  assert.match(emptyGate, /unexpected dumpable semantic object/);
});

test("exact gate fingerprints semantic membership and column collations", () => {
  assert.match(exactGate, /Path B semantic catalog fingerprint mismatch/);
  assert.match(exactGate, /semantic_extension\.extname/);
  assert.match(exactGate, /pg_amop/);
  assert.match(exactGate, /pg_amproc/);
  assert.match(exactGate, /pg_ts_config_map/);
  assert.match(exactGate, /attribute\.attcollation/);
  assert.match(
    exactGate,
    /99ae4e103d96a4ad1b340e72936dc3397a8e8e4d5fc2a5316a83dd7ffb2b40f6/,
  );
  assert.match(
    exactGate,
    /0da584af8ed54dd230364b896ddf7ea480486a05f9ad59965d82c9d0f9105da8/,
  );
});

test("exact ACL contracts compare raw tuples and reject every grant option", () => {
  assert.match(exactGate, /acl\.is_grantable/);
  assert.ok(
    (exactGate.match(/SELECT \* FROM actual EXCEPT SELECT \* FROM expected/g) ?? [])
      .length >= 3,
  );
  assert.match(exactGate, /database ACL tuple set is not exact or contains a grant option/);
  assert.match(exactGate, /schema ACL tuple set is not exact or contains a grant option/);
  assert.match(exactGate, /relation ACL tuple set is not exact or contains a grant option/);
  assert.match(exactGate, /unexpected ambient bot ACL tuple or grant option/);
  assert.match(exactGate, /pg_parameter_acl/);
  assert.match(emptyGate, /ACL tuple set is not an allowed exact state/);
});
