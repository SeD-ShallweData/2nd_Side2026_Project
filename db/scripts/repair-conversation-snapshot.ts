/** Metadata-only repair. Never connects to a DB or changes journal/old SQL. */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import * as schema from "../schema";

const root = fileURLToPath(new URL("../", import.meta.url));
const snapshotPath = resolve(root, "migrations/meta/0018_snapshot.json");
const generated = generateDrizzleJson(schema);
const conversations = Object.keys(generated.tables).filter((key) => key.startsWith("public.conversation_"));
if (conversations.length !== 7) throw new Error("Expected seven existing conversation tables");
if (process.argv.includes("--repair")) {
  if (existsSync(snapshotPath)) throw new Error("Baseline already exists; review rather than overwrite it");
  const repaired = JSON.parse(execFileSync("git", ["show", "66ba9bd:db/migrations/meta/0018_snapshot.json"], { cwd: root, encoding: "utf8" }));
  for (const key of conversations) repaired.tables[key] = structuredClone(generated.tables[key]);
  // 0018 is the pre-lease baseline, not the future schema.
  delete repaired.tables["public.conversation_summaries"].columns.lease_token;
  delete repaired.tables["public.conversation_summaries"].columns.lease_expires_at;
  // Preserve the merged migration byte-for-byte, including its missing final newline.
  const sqlPath = resolve(root, "migrations/0018_real_hitman.sql");
  if (existsSync(sqlPath)) throw new Error("Merged SQL already exists");
  writeFileSync(sqlPath, execFileSync("git", ["show", "66ba9bd:db/migrations/0018_real_hitman.sql"], { cwd: root }));
  writeFileSync(snapshotPath, JSON.stringify(repaired, null, 2) + "\n");
}
const latest = readdirSync(resolve(root, "migrations/meta")).filter((name) => /^\d+_snapshot\.json$/.test(name)).sort().at(-1)!;
const baseline = JSON.parse(readFileSync(resolve(root, "migrations/meta", latest), "utf8"));
const statements = await generateMigration(baseline, generated);
console.log(JSON.stringify({ conversation_tables: conversations.length, pending_statements: statements.length, statements }, null, 2));
if (statements.length) process.exitCode = 1;
