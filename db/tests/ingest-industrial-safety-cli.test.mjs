import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(DB_ROOT, "scripts/ingest-industrial-safety.sh");

describe("industrial safety loader CLI", () => {
  it("deployment artifact root overrides are forwarded to validate-only", () => {
    const root = mkdtempSync(join(tmpdir(), "industrial-loader-cli-"));
    const fakePython = join(root, "python");
    writeFileSync(
      fakePython,
      "#!/usr/bin/env bash\n"
        + "if [[ \"${1:-}\" == '-I' ]]; then shift; fi\n"
        + "if [[ \"${1:-}\" == '-' ]]; then\n"
        + "  cat >/dev/null\n"
        + "  printf 'python=3.12.13;numpy=2.5.2;pandas=3.0.5;pyarrow=25.0.0\\n'\n"
        + "else\n"
        + "  printf '%s ' \"$@\"\n"
        + "fi\n",
    );
    chmodSync(fakePython, 0o700);
    try {
      const result = spawnSync(
        "bash",
        [
          SCRIPT,
          "--validate-only",
          "--scope",
          "existing-firms",
          "--python",
          fakePython,
          "--v2-root",
          "/srv/donworry/v2",
          "--extension-root",
          "/srv/donworry/extension",
        ],
        { cwd: DB_ROOT, encoding: "utf8" },
      );

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /--v2-root \/srv\/donworry\/v2/);
      assert.match(result.stdout, /--extension-root \/srv\/donworry\/extension/);
      assert.match(result.stdout, /--scope existing-firms --validate-only/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("existing-firms prepare and verify receive only the sealed staged roots", () => {
    const root = mkdtempSync(join(tmpdir(), "industrial-loader-stage-cli-"));
    const fakeBin = join(root, "bin");
    const fakePython = join(fakeBin, "industrial-python");
    const fakePsql = join(fakeBin, "psql");
    const envFile = join(root, "db.env");
    const stageParent = join(root, "stage");
    const invocationLog = join(root, "loader-invocations.log");
    mkdirSync(fakeBin, { mode: 0o700 });
    mkdirSync(stageParent, { mode: 0o700 });
    writeFileSync(
      fakePython,
      "#!/usr/bin/env bash\n"
        + "if [[ \"${1:-}\" == '-I' ]]; then shift; fi\n"
        + "if [[ \"${1:-}\" == '-' ]]; then\n"
        + "  cat >/dev/null\n"
        + "  printf 'python=3.12.13;numpy=2.5.2;pandas=3.0.5;pyarrow=25.0.0\\n'\n"
        + "  exit 0\n"
        + "fi\n"
        + "printf '%s\\n' \"$*\" >>\"$LOADER_INVOCATIONS\"\n"
        + "bundle=''\n"
        + "previous=''\n"
        + "for argument in \"$@\"; do\n"
        + "  if [[ \"$previous\" == '--stage-source-bundle' ]]; then bundle=\"$argument\"; fi\n"
        + "  previous=\"$argument\"\n"
        + "done\n"
        + "if [[ -n \"$bundle\" ]]; then\n"
        + "  mkdir -p \"$bundle/config\" \"$bundle/v2\" \"$bundle/extension\"\n"
        + "  : >\"$bundle/config/industrial_safety_sources.v1.json\"\n"
        + "  : >\"$bundle/source_bundle_manifest.json\"\n"
        + "fi\n",
    );
    writeFileSync(
      fakePsql,
      "#!/usr/bin/env bash\n"
        + "case \"$*\" in\n"
        + "  *'select current_database()'*) printf 'wageguard_is_test_staged\\n' ;;\n"
        + "  *\"to_regnamespace('industrial_safety')\"*) printf 't\\n' ;;\n"
        + "  *\"to_regclass('industrial_safety.firm_risk_results')\"*) printf 't\\n' ;;\n"
        + "  *'\\copy (select firm_id'*) printf 'firm_id,name,biz_no,sido,industry\\n' >firms_snapshot.csv ;;\n"
        + "esac\n",
    );
    chmodSync(fakePython, 0o700);
    chmodSync(fakePsql, 0o700);
    writeFileSync(
      envFile,
      "DB_HOST=127.0.0.1\n"
        + "DB_PORT=55433\n"
        + "DB_NAME=wageguard_is_test_staged\n"
        + "DB_USER=loader\n"
        + "DB_PASSWORD=test-only\n",
      { mode: 0o600 },
    );
    chmodSync(envFile, 0o600);

    try {
      const result = spawnSync(
        "bash",
        [
          SCRIPT,
          "--rollback",
          "--scope",
          "existing-firms",
          "--python",
          fakePython,
          "--env-file",
          envFile,
          "--database",
          "wageguard_is_test_staged",
          "--expected-system-identifier",
          "777",
          "--expected-database-oid",
          "16384",
          "--canonical-timestamp",
          "2026-08-14T15:02:34.715Z",
          "--sample-per-source",
          "1",
          "--stage-parent",
          stageParent,
          "--v2-root",
          "/original/v2",
          "--extension-root",
          "/original/extension",
        ],
        {
          cwd: DB_ROOT,
          encoding: "utf8",
          env: {
            ...process.env,
            LOADER_INVOCATIONS: invocationLog,
            PATH: `${fakeBin}:${process.env.PATH}`,
          },
        },
      );

      assert.equal(result.status, 0, result.stderr);
      const invocations = readFileSync(invocationLog, "utf8").trim().split("\n");
      assert.equal(invocations.length, 3, invocations.join("\n"));
      assert.match(invocations[0], /--stage-source-bundle .*\/source-bundle/);
      assert.match(invocations[0], /--v2-root \/original\/v2/);
      for (const invocation of invocations.slice(1)) {
        assert.match(
          invocation,
          /--config .*\/source-bundle\/config\/industrial_safety_sources\.v1\.json/,
        );
        assert.match(invocation, /--v2-root .*\/source-bundle\/v2/);
        assert.match(invocation, /--extension-root .*\/source-bundle\/extension/);
        assert.match(
          invocation,
          /--source-bundle-manifest .*\/source-bundle\/source_bundle_manifest\.json/,
        );
        assert.doesNotMatch(invocation, /\/original\/(?:v2|extension)/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects mutation mode without the exact canonical rebuild timestamp", () => {
    for (const timestamp of [undefined, "2026-08-14T15:02:34Z"]) {
      const args = [SCRIPT, "--rollback", "--scope", "existing-firms"];
      if (timestamp !== undefined) args.push("--canonical-timestamp", timestamp);
      const result = spawnSync("bash", args, { cwd: DB_ROOT, encoding: "utf8" });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /--canonical-timestamp/);
    }
  });
});
