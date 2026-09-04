/*
 * 개발용 DB 관찰 도구.
 *
 * 브라우저에서 글을 쓰거나 고치거나 지울 때, 실제로 DB 가 어떻게 바뀌는지
 * 옆 창에 띄워 두고 보는 용도다.
 *
 * 실행:
 *   cd product
 *   node scripts/dev-watch-db.mjs          (2초마다 새로고침)
 *   node scripts/dev-watch-db.mjs --once   (한 번만 출력)
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const PRODUCT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ONCE = process.argv.includes("--once");

function readEnvLocal() {
  const values = {};
  const text = readFileSync(resolve(PRODUCT_DIR, ".env.local"), "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator > 0) values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return values;
}

const env = readEnvLocal();
if (!env.COMMUNITY_DATABASE_URL || !env.AUTH_DATABASE_URL) {
  console.log("❌ .env.local 에 AUTH_DATABASE_URL / COMMUNITY_DATABASE_URL 이 필요합니다.");
  process.exit(1);
}

/* 커뮤니티 계정은 회원을 못 보고, 인증 계정은 게시글을 못 본다. 그래서 연결이 둘이다. */
const community = new pg.Pool({ connectionString: env.COMMUNITY_DATABASE_URL, max: 2 });
const auth = new pg.Pool({ connectionString: env.AUTH_DATABASE_URL, max: 2 });

function pad(value, width) {
  const text = String(value ?? "");
  // 한글은 두 칸을 차지한다.
  const visualWidth = [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x1100 ? 2 : 1), 0);
  return text + " ".repeat(Math.max(0, width - visualWidth));
}

function timeOf(value) {
  return value ? new Date(value).toLocaleTimeString("ko-KR") : "-";
}

async function render() {
  const [{ rows: posts }, { rows: reports }, { rows: users }, { rows: sessions }] = await Promise.all([
    community.query(`
      SELECT id, title, category, status, anonymous, created_at, updated_at,
             deleted_at IS NOT NULL AS is_deleted,
             hidden_at IS NOT NULL AS is_hidden
        FROM posts ORDER BY created_at DESC LIMIT 8`),
    community.query(`
      SELECT reason, status, snapshot_title, created_at
        FROM reports ORDER BY created_at DESC LIMIT 5`),
    auth.query(`SELECT email, name, role, auth_role, created_at FROM users ORDER BY created_at DESC LIMIT 5`),
    auth.query(`SELECT count(*) FILTER (WHERE revoked_at IS NULL AND expires_at > now())::int AS live,
                       count(*)::int AS total FROM sessions`),
  ]);

  if (!ONCE) process.stdout.write("\x1Bc");
  console.log(`돈워리 DB 관찰  ·  ${new Date().toLocaleTimeString("ko-KR")}${ONCE ? "" : "  (Ctrl+C 로 종료)"}`);

  console.log(`\n■ 게시글 (posts) — ${posts.length}건 표시`);
  if (posts.length === 0) console.log("   (없음)");
  else {
    console.log(`   ${pad("제목", 28)}${pad("분류", 20)}${pad("상태", 20)}${pad("익명", 8)}${pad("작성", 12)}수정`);
    for (const row of posts) {
      const marks = [row.is_deleted ? "삭제됨" : "", row.is_hidden ? "숨김" : ""].filter(Boolean).join(",");
      console.log(`   ${pad(row.title.slice(0, 12), 28)}${pad(row.category, 20)}${pad(row.status + (marks ? ` (${marks})` : ""), 20)}${pad(row.anonymous ? "예" : "아니오", 8)}${pad(timeOf(row.created_at), 12)}${timeOf(row.updated_at)}`);
    }
  }

  console.log(`\n■ 신고 (reports) — ${reports.length}건 표시`);
  if (reports.length === 0) console.log("   (없음)");
  else {
    for (const row of reports) {
      console.log(`   ${pad(row.reason, 16)}${pad(row.status, 12)}신고당시제목: ${row.snapshot_title.slice(0, 16)}`);
    }
  }

  console.log(`\n■ 회원 (users) — ${users.length}건 표시`);
  for (const row of users) {
    console.log(`   ${pad(row.email, 32)}${pad(row.name, 18)}${pad("직업:" + row.role, 22)}권한:${row.auth_role}`);
  }

  const session = sessions[0];
  console.log(`\n■ 세션 (sessions) — 살아있음 ${session.live}건 / 전체 ${session.total}건 (로그아웃해도 기록은 남는다)`);
}

await render();

if (!ONCE) {
  setInterval(() => {
    render().catch((error) => console.log("조회 실패:", error.message));
  }, 2000);
} else {
  await community.end();
  await auth.end();
}
