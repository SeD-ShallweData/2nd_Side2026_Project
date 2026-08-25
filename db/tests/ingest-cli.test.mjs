import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const DB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(DB_ROOT, "scripts/ingest.sh");
const BOT_ROLE_SCRIPT = resolve(DB_ROOT, "scripts/create-bot-role.sh");

describe("wage bundle ingest CLI", () => {
  it("reads only allowed DB keys and forwards host and SSL mode to psql", () => {
    const root = mkdtempSync(join(tmpdir(), "wageguard-ingest-cli-"));
    try {
      const binDir = join(root, "bin");
      const outputsDir = join(root, "bundle", "outputs");
      const envFile = join(root, "database.env");
      const psqlLog = join(root, "psql.log");
      const forbiddenMarker = join(root, "must-not-exist");
      mkdirSync(binDir);
      mkdirSync(outputsDir, { recursive: true });

      for (const name of [
        "scored_active_full.csv",
        "감독관_위험큐_full.csv",
        "safe_recommendation_full.csv",
      ]) {
        writeFileSync(join(outputsDir, name), "header\n");
      }

      writeFileSync(
        envFile,
        [
          "DB_HOST=db.internal",
          "DB_PORT=6543",
          "DB_NAME=wageguard",
          "DB_USER=loader",
          "DB_PASSWORD=secret-value",
          "PGSSLMODE=require",
          `IGNORED_KEY=$(touch ${forbiddenMarker})`,
          "",
        ].join("\n"),
        { mode: 0o600 },
      );

      const fakePsql = join(binDir, "psql");
      writeFileSync(
        fakePsql,
        "#!/usr/bin/env bash\n" +
          "printf 'PGSSLMODE=%s ARGS=%s\\n' \"${PGSSLMODE:-}\" \"$*\" >> \"$PSQL_ARGS_LOG\"\n" +
          "if [[ \"$*\" == *server_version_num* ]]; then printf 'wageguard\\t16\\t777\\t16384\\n'; else cat >/dev/null; fi\n",
      );
      chmodSync(fakePsql, 0o700);

      const result = spawnSync(
        "bash",
        [
          SCRIPT,
          "--env-file",
          envFile,
          "--expected-database",
          "wageguard",
          "--expected-system-identifier",
          "777",
          "--expected-database-oid",
          "16384",
          "--canonical-timestamp",
          "2026-08-14T15:02:34.715Z",
          "--bundle",
          join(root, "bundle"),
          "--model-version",
          "door1-voting-39f-v1",
          "--as-of",
          "2026-06",
          "--expect-rows",
          "1,1,1",
        ],
        {
          cwd: DB_ROOT,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH ?? ""}`,
            PSQL_ARGS_LOG: psqlLog,
          },
        },
      );

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /target\(t\)\s+: 2026-12/);
      const calls = readFileSync(psqlLog, "utf8");
      assert.match(calls, /PGSSLMODE=require/);
      assert.match(calls, /-h db\.internal -p 6543 -U loader -d wageguard/);
      assert.match(calls, /canonical_timestamp=2026-08-14T15:02:34\.715Z/);
      assert.equal(existsSync(forbiddenMarker), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the reproducibility month is omitted", () => {
    const result = spawnSync(
      "bash",
      [SCRIPT, "--model-version", "door1-voting-39f-v1"],
      { cwd: DB_ROOT, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--as-of 형식은 YYYY-MM/);
  });

  it("rejects a SQL-shaped model version before opening an env file", () => {
    const result = spawnSync(
      "bash",
      [
        SCRIPT,
        "--model-version",
        "x';DROP_TABLE_batches;--",
        "--as-of",
        "2026-06",
      ],
      { cwd: DB_ROOT, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--model-version 형식이 안전하지 않습니다/);
  });

  it("requires an exact canonical rebuild timestamp before opening an env file", () => {
    for (const timestamp of [undefined, "2026-08-14T15:02:34Z", "2026-08-14 15:02:34.715+00"]) {
      const args = [
        SCRIPT,
        "--model-version", "door1-voting-39f-v1",
        "--as-of", "2026-06",
        "--expected-database", "wageguard",
        "--expected-system-identifier", "777",
        "--expected-database-oid", "16384",
      ];
      if (timestamp !== undefined) args.push("--canonical-timestamp", timestamp);
      const result = spawnSync("bash", args, { cwd: DB_ROOT, encoding: "utf8" });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /--canonical-timestamp/);
    }
  });

  it("rejects quote or backslash CSV paths before invoking psql", () => {
    const root = mkdtempSync(join(tmpdir(), "wageguard-ingest-path-"));
    try {
      const envFile = join(root, "database.env");
      const psqlMarker = join(root, "psql-was-called");
      const binDir = join(root, "bin");
      mkdirSync(binDir);
      writeFileSync(
        envFile,
        [
          "DB_HOST=127.0.0.1",
          "DB_PORT=5433",
          "DB_NAME=wageguard",
          "DB_USER=loader",
          "DB_PASSWORD=secret-value",
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      const fakePsql = join(binDir, "psql");
      writeFileSync(fakePsql, `#!/usr/bin/env bash\ntouch '${psqlMarker}'\n`);
      chmodSync(fakePsql, 0o700);

      for (const unsafePath of [join(root, "bad'path"), join(root, "bad\\path")]) {
        const result = spawnSync(
          "bash",
          [
            SCRIPT,
            "--env-file",
            envFile,
            "--expected-database",
            "wageguard",
            "--expected-system-identifier",
            "777",
            "--expected-database-oid",
            "16384",
            "--canonical-timestamp",
            "2026-08-14T15:02:34.715Z",
            "--outputs",
            unsafePath,
            "--model-version",
            "door1-voting-39f-v1",
            "--as-of",
            "2026-06",
          ],
          {
            cwd: DB_ROOT,
            encoding: "utf8",
            env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
          },
        );
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /CSV 경로에는 quote, backslash/);
      }
      assert.equal(existsSync(psqlMarker), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("bot role CLI", () => {
  it("uses the selected env file without executing unknown keys", () => {
    const root = mkdtempSync(join(tmpdir(), "wageguard-bot-role-cli-"));
    try {
      const binDir = join(root, "bin");
      const envFile = join(root, "database.env");
      const psqlLog = join(root, "psql.log");
      const forbiddenMarker = join(root, "must-not-exist");
      mkdirSync(binDir);
      writeFileSync(
        envFile,
        [
          "DB_HOST=db.internal",
          "DB_PORT=6543",
          "DB_NAME=wageguard",
          "DB_USER=owner",
          "DB_PASSWORD=owner-secret",
          "PGSSLMODE=verify-full",
          "BOT_USER=wg_bot",
          "BOT_PASSWORD=bot-secret",
          `IGNORED_KEY=$(touch ${forbiddenMarker})`,
          "",
        ].join("\n"),
        { mode: 0o600 },
      );

      const fakePsql = join(binDir, "psql");
      writeFileSync(
        fakePsql,
        "#!/usr/bin/env bash\n" +
          "printf 'PGSSLMODE=%s ARGS=%s\\n' \"${PGSSLMODE:-}\" \"$*\" >> \"$PSQL_ARGS_LOG\"\n" +
          "cat >/dev/null\n",
      );
      chmodSync(fakePsql, 0o700);

      const result = spawnSync(
        "bash",
        [BOT_ROLE_SCRIPT, "--env-file", envFile],
        {
          cwd: DB_ROOT,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH ?? ""}`,
            PSQL_ARGS_LOG: psqlLog,
          },
        },
      );

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /psql -h db\.internal -p 6543 -U wg_bot -d wageguard/);
      const calls = readFileSync(psqlLog, "utf8");
      assert.match(calls, /PGSSLMODE=verify-full/);
      assert.match(calls, /-h db\.internal -p 6543 -U owner -d wageguard/);
      assert.match(calls, /configure-path-b-release-bot\.sql/);
      assert.doesNotMatch(calls, /bot-secret/);
      assert.equal(existsSync(forbiddenMarker), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
