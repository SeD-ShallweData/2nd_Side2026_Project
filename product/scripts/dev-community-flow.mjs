/*
 * 개발용 커뮤니티 흐름 테스트.
 *
 * 로그인 화면이 아직 없어서 브라우저로는 로그인할 수 없다.
 * 그동안 API 호출만으로 로그인 → 글쓰기 → 수정 → 삭제를 확인하는 도구다.
 *
 * 실행:
 *   cd product
 *   npm run dev            (다른 터미널에서 서버를 먼저 띄운다)
 *   node scripts/dev-community-flow.mjs
 *
 * 계정은 .env.local 의 MOCK_AUTH_* 값을 읽는다(임시 저장소 모드 전용).
 * 실제 DB 모드로 확인하려면 아래처럼 계정을 직접 넘긴다.
 *   node scripts/dev-community-flow.mjs --email a@b.com --password 비밀번호
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.DEV_FLOW_BASE ?? "http://localhost:3000";
const PRODUCT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readEnvLocal() {
  const values = {};
  try {
    const text = readFileSync(resolve(PRODUCT_DIR, ".env.local"), "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const separator = line.indexOf("=");
      if (separator > 0) values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
  } catch {
    console.log("(.env.local 을 읽지 못했습니다 — 계정을 직접 넘겨주세요)");
  }
  return values;
}

function readArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i]?.replace(/^--/, "");
    if (key) args[key] = process.argv[i + 1];
  }
  return args;
}

const env = readEnvLocal();
const args = readArgs();
const EMAIL = args.email ?? "user@mock.donworry.local";
const PASSWORD = args.password ?? env.MOCK_AUTH_USER_PASSWORD;

let cookie = "";
let stepNumber = 0;

function step(title) {
  stepNumber += 1;
  console.log(`\n${"─".repeat(60)}\n[${stepNumber}] ${title}\n${"─".repeat(60)}`);
}

function show(label, value) {
  console.log(`   ${label.padEnd(14)} ${value}`);
}

async function api(method, path, body) {
  const headers = { origin: BASE };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;

  const response = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const setCookie = response.headers.get("set-cookie");
  if (setCookie?.includes("donworry_session=")) {
    const value = setCookie.split(";", 1)[0] ?? "";
    // 로그아웃 시 빈 값이 내려오면 쿠키를 버린다.
    cookie = value.endsWith("=") ? "" : value;
  }

  let payload = null;
  try { payload = await response.json(); } catch { /* 본문 없음 */ }

  console.log(`   ${method} ${path}  →  HTTP ${response.status}`);
  return { status: response.status, body: payload };
}

function fail(message, result) {
  console.log(`\n❌ ${message}`);
  console.log(JSON.stringify(result.body, null, 2));
  process.exit(1);
}

/* ────────────────────────────────────────────────────────────── */

console.log(`서버: ${BASE}`);
console.log(`계정: ${EMAIL}`);

if (!PASSWORD) {
  console.log("\n❌ 비밀번호를 찾지 못했습니다.");
  console.log("   .env.local 의 MOCK_AUTH_USER_PASSWORD 를 채우거나");
  console.log("   node scripts/dev-community-flow.mjs --email .. --password .. 로 넘겨주세요.");
  process.exit(1);
}

step("로그인 전 상태 확인");
const before = await api("GET", "/api/auth/session");
show("로그인 여부", before.body?.authenticated);
const listBefore = await api("GET", "/api/community/posts?limit=5");
show("데이터 출처", listBefore.body?.source);
show("현재 글 수", `${listBefore.body?.total}건`);

step("로그인");
const login = await api("POST", "/api/auth/login", { email: EMAIL, password: PASSWORD });
if (login.status !== 200) fail("로그인에 실패했습니다.", login);
show("이름", login.body?.user?.display_name);
show("권한 등급", login.body?.user?.role);
show("만료 시각", login.body?.expires_at);

step("글쓰기");
const created = await api("POST", "/api/community/posts", {
  category: "wage",
  title: "테스트 글 " + new Date().toLocaleTimeString("ko-KR"),
  body: "API 호출로 작성한 글입니다. 수정과 삭제까지 확인합니다.",
  anonymous: true,
});
if (created.status !== 201) fail("글쓰기에 실패했습니다.", created);
const postId = created.body.post_id;
show("글 번호", postId);
show("제목", created.body.title);
show("분류", created.body.category_label);
show("익명", created.body.anonymous);
show("수정 가능", created.body.viewer_permissions?.can_edit);
show("삭제 가능", created.body.viewer_permissions?.can_delete);

step("목록에 나오는지 확인");
const listAfter = await api("GET", "/api/community/posts?limit=5");
show("글 수", `${listBefore.body?.total}건 → ${listAfter.body?.total}건`);
show("맨 위 글", listAfter.body?.items?.[0]?.title);

step("수정");
const updated = await api("PATCH", `/api/community/posts/${postId}`, {
  title: "수정된 제목",
  body: "본문도 함께 바꿔서 수정이 반영되는지 확인합니다.",
});
if (updated.status !== 200) fail("수정에 실패했습니다.", updated);
show("제목", `${created.body.title}  →  ${updated.body.title}`);
show("수정 시각", `${created.body.updated_at !== updated.body.updated_at ? "갱신됨" : "그대로"}`);

step("수정 결과 다시 조회");
const reread = await api("GET", `/api/community/posts/${postId}`);
show("제목", reread.body?.title);
show("본문", reread.body?.body);

step("삭제");
const deleted = await api("DELETE", `/api/community/posts/${postId}`);
if (deleted.status !== 200) fail("삭제에 실패했습니다.", deleted);
show("삭제됨", deleted.body?.deleted);

step("삭제 확인 — 조회와 목록에서 사라졌는가");
const gone = await api("GET", `/api/community/posts/${postId}`);
show("상세 조회", `HTTP ${gone.status} (404 면 정상)`);
show("오류 코드", gone.body?.error?.code);
const listFinal = await api("GET", "/api/community/posts?limit=5");
show("글 수", `${listAfter.body?.total}건 → ${listFinal.body?.total}건`);

step("로그아웃");
await api("POST", "/api/auth/logout");
const after = await api("GET", "/api/auth/session");
show("로그인 여부", after.body?.authenticated);

console.log(`\n${"─".repeat(60)}`);
console.log("✅ 로그인 → 글쓰기 → 수정 → 삭제 → 로그아웃 전부 확인했습니다.");
console.log(`${"─".repeat(60)}`);
