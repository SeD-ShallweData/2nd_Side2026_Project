import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/*
 * 저장소 루트의 비밀값 검사기(scripts/scan-secrets.mjs), pre-push 훅(.githooks/pre-push),
 * .gitignore 규칙을 확인한다. CI 에서는 product-ci.yml 이 이 파일들이 바뀔 때도 돈다.
 * 저장소 전체를 검사하는 --all 은 Secret scan 워크플로가 맡는다. 다른 폴더에 오탐이 하나 들어와도
 * product 테스트가 함께 깨지지 않게 여기서는 돌리지 않는다.
 *
 * 가짜 키는 실행 중에 이어 붙여 만든다. 이 파일 자체가 검사기에 걸리지 않게 하기 위해서다.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCANNER = join(REPO_ROOT, "scripts", "scan-secrets.mjs");
const HOOK = join(REPO_ROOT, ".githooks", "pre-push");
const ZERO_SHA = "0".repeat(40);
const SLOW = { timeout: 60_000 };

interface RunResult {
  status: number | null;
  output: string;
}

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "scan-secrets-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

// 이 파일이 띄우는 git·node·sh 는 모두 아래 환경으로 돈다. 임시 저장소는 개발자의 전역 git 설정
// (서명, 전역 훅, 전역 ignore)과 떼어 놓는다. git 훅 안에서 테스트를 돌리면 GIT_DIR·GIT_WORK_TREE·
// GIT_INDEX_FILE 등이 바깥 저장소를 가리키므로 GIT_ 로 시작하는 환경 변수는 물려받지 않는다.
const isolatedConfigDir = makeTempDir();
const isolatedGitConfig = join(isolatedConfigDir, "gitconfig");
writeFileSync(isolatedGitConfig, "");
const inheritedEnv: NodeJS.ProcessEnv = { ...process.env };
for (const name of Object.keys(inheritedEnv)) {
  if (name.startsWith("GIT_")) delete inheritedEnv[name];
}
const ISOLATED_ENV: NodeJS.ProcessEnv = {
  ...inheritedEnv,
  GIT_CONFIG_GLOBAL: isolatedGitConfig,
  GIT_CONFIG_NOSYSTEM: "1",
  // 훅이 부르는 node 가 지금 테스트를 돌리는 node 와 같도록 한다.
  PATH: [dirname(process.execPath), process.env.PATH ?? ""].join(delimiter),
};

function run(command: string, args: string[], cwd: string, input?: string): RunResult {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: ISOLATED_ENV, input });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function scan(args: string[], cwd: string): RunResult {
  return run(process.execPath, [SCANNER, ...args], cwd);
}

function git(args: string[], cwd: string): string {
  const result = run("git", ["-c", "user.name=scan-test", "-c", "user.email=scan-test@example.invalid", ...args], cwd);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} 실패: ${result.output}`);
  return result.output.trim();
}

function writeFiles(root: string, files: Record<string, string | Buffer>): void {
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(root, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
}

const hasGit = run("git", ["rev-parse", "--show-toplevel"], REPO_ROOT).status === 0;
const hasSh = run("sh", ["-c", "exit 0"], REPO_ROOT).status === 0;

// 실제 형식을 흉내 낸 가짜 값.
const FAKE = {
  upstage: "up_" + "A1b2C3d4".repeat(4),
  openai: "sk-proj-" + "Z9y8X7w6".repeat(5),
  google: "AIza" + "Sy1".repeat(11) + "Ab",
  github: "ghp_" + "a1B2".repeat(9),
  githubFineGrained: "github_pat_" + "11ABCDEFG".repeat(4),
  slack: ["xoxb", "1234567890", "abcdefghij"].join("-"),
  discord: "https://discord.com/api/" + "webhooks/123456789012/" + "Ab1_-".repeat(8),
  privateKey: "-----BEGIN " + "RSA PRIVATE KEY-----",
  skt: "skt" + "Q7w".repeat(8),
  internalToken: "f3a9".repeat(10),
  dbPassword: "Str0ng" + "Passw0rd42",
  redisPassword: "R3dis" + "Passw0rd",
  parenPassword: "Str0ng(Pass)" + "word99",
  passphrase: ["correct", "horse", "battery", "staple"].join("-"),
};

describe("scripts/scan-secrets.mjs", () => {
  it("형식이 분명한 키와 이름·URL 로 드러나는 비밀값을 잡고, 값은 앞부분과 길이만 출력한다", () => {
    const dir = makeTempDir();
    writeFiles(dir, {
      "app/leak.env": [
        FAKE.upstage,
        FAKE.openai,
        "GOOGLE=" + FAKE.google,
        "GH=" + FAKE.github,
        "PAT=" + FAKE.githubFineGrained,
        "SLACK=" + FAKE.slack,
        "HOOK=" + FAKE.discord,
        FAKE.privateKey,
        "SKT_API_KEY=" + FAKE.skt,
        "RAG_INTERNAL_TOKEN=\"" + FAKE.internalToken + "\"",
        "BOT_DATABASE_URL=postgresql://wg_bot:" + FAKE.dbPassword + "@127.0.0.1:5433/wageguard",
        "PUBLIC_RATE_LIMIT_REDIS_URL=rediss://:" + FAKE.redisPassword + "@10.0.0.2:6379/0",
      ].join("\n"),
      "app/config.ts": 'export const CONTRACT_INTERNAL_TOKEN = "' + FAKE.internalToken.toUpperCase() + 'x";\n',
      "app/workflow.yml": "env:\n  OPS_PASSWORD: " + FAKE.dbPassword + "Yaml\n",
    });

    const result = scan(["--dir", "."], dir);

    expect(result.status).toBe(1);
    for (const rule of [
      "upstage-api-key",
      "sk-api-key",
      "google-api-key",
      "github-token",
      "github-fine-grained-token",
      "slack-token",
      "discord-webhook",
      "private-key",
      "secret-assignment SKT_API_KEY",
      "secret-assignment RAG_INTERNAL_TOKEN",
      "url-password",
      "secret-assignment CONTRACT_INTERNAL_TOKEN",
      "secret-assignment OPS_PASSWORD",
    ]) {
      expect(result.output).toContain(rule);
    }
    expect(result.output).toContain("app/leak.env:1  upstage-api-key  up_A…(35자)");
    expect(result.output).toContain("비밀값으로 보이는 값 14건");
    for (const value of Object.values(FAKE)) expect(result.output).not.toContain(value);
  });

  it("괄호가 든 비밀번호와, 코드 밖 파일의 소문자·camelCase 이름에 든 비밀값도 잡는다", () => {
    const dir = makeTempDir();
    writeFiles(dir, {
      "app/local.env": [
        "DB_PASSWORD=" + FAKE.parenPassword,
        "skt_api_key=" + FAKE.skt,
        // 코드 밖에서는 소문자 낱말 이음도 비밀번호(암호 문구)일 수 있다.
        "ADMIN_PASSWORD=" + FAKE.passphrase,
      ].join("\n"),
      "app/settings.json": '{ "apiKey": "' + FAKE.internalToken + '" }\n',
      "app/deploy.yaml": "auth:\n  accessToken: " + FAKE.redisPassword + "Yaml\n",
      "docs/setup.md": "`dbPassword: '" + FAKE.dbPassword + "'`\n",
    });

    const result = scan(["--dir", "."], dir);

    expect(result.status).toBe(1);
    for (const finding of [
      "app/local.env:1  secret-assignment DB_PASSWORD",
      "app/local.env:2  secret-assignment skt_api_key",
      "app/local.env:3  secret-assignment ADMIN_PASSWORD",
      "app/settings.json:1  secret-assignment apiKey",
      "app/deploy.yaml:2  secret-assignment accessToken",
      "docs/setup.md:1  secret-assignment dbPassword",
    ]) {
      expect(result.output).toContain(finding);
    }
    expect(result.output).toContain("비밀값으로 보이는 값 6건");
    for (const value of Object.values(FAKE)) expect(result.output).not.toContain(value);
  });

  it("자리표시·참조·코드 식·테스트 고정값·예외 표시는 통과시킨다", () => {
    const dir = makeTempDir();
    writeFiles(dir, {
      "app/placeholders.env": [
        "UPSTAGE_API_KEY=",
        "Upstage_API_KEY=up_" + "x".repeat(24),
        "SKT_API_KEY=<SKT_SECRET>",
        "OPENAI_API_KEY=...",
        "PUBLIC_RATE_LIMIT_PROXY_TOKEN=REPLACE_WITH_SAME_LOCAL_SECRET_AS_WEB_ENV",
        'DEMO_BASIC_AUTH_PASSWORD="충분히 긴 임의 문자열"',
        'CONFIRMATION_TOKEN="PATH_B_REBUILD_FRESH_DATABASE_V1"',
        "BOT_PASSWORD=$(head -c 32 /dev/urandom | base64)",
        "DB_PASSWORD=${DB_PASSWORD:?missing}",
        "DB_PASSWORD=%s",
        "RESET_PASSWORD=1",
        "DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/wageguard_ci",
        "DATABASE_URL=postgresql://wg_bot:<URL_ENCODED_PASSWORD>@127.0.0.1:5433/wageguard",
        "DATABASE_URL=postgresql://${user}:${password}@127.0.0.1:5433/wageguard",
        "DATABASE_URL=postgresql://읽기전용계정:비밀번호@127.0.0.1:5433/wageguard",
        "UPSTAGE_API_KEY: ${{ env.SECRET_CANARY }}-upstage",
        "risk-high task-security-secrets-guard",
        "UPSTAGE_API_KEY=" + FAKE.upstage.slice(0, 3) + "Allowed" + FAKE.upstage.slice(10) + " # scan-secrets: allow",
      ].join("\n"),
      "app/code.ts": [
        "const RAG_INTERNAL_TOKEN = randomBytes(24).toString('hex');",
        "const env = { RAG_INTERNAL_TOKEN: token, UPSTAGE_API_KEY: process.env.UPSTAGE_API_KEY };",
        'const DEMO_BASIC_AUTH_PASSWORD = process.env["DEMO_BASIC_AUTH_PASSWORD"];',
        "if (X_TOKEN === expected) console.log(X_TOKEN);",
        // 코드 속 식별자·헤더 이름
        'export const REFRESH_TOKEN = "refresh_token";',
        'const CSRF_TOKEN = "x-csrf-token";',
        'const errors = { INVALID_TOKEN: "invalid_token_error" };',
      ].join("\n"),
      // 문서 속 코드 예시: 값 전체가 함수 호출이다.
      "docs/setup.md": [
        "RAG_INTERNAL_TOKEN=secrets.token_hex(32)",
        'SKT_API_KEY=os.getenv("SKT_API_KEY")',
        "`OPENAI_API_KEY=getpass()`",
        '{ "apiKey": "<SKT 콘솔에서 발급한 키>", "accessToken": "{{token}}" }',
      ].join("\n"),
      "app/ci.yml": [
        "env:",
        "  POSTGRES_PASSWORD: postgres",
        "  UPSTAGE_API_KEY: ${{ secrets.UPSTAGE_API_KEY }}",
        "  githubToken: ${{ secrets.GITHUB_TOKEN }}",
      ].join("\n"),
      "tests/fixture.env": "DB_PASSWORD=" + FAKE.dbPassword + "\nDATABASE_URL=postgresql://a:" + FAKE.dbPassword + "@h/d\n",
      "app/login.test.ts": 'const MOCK_AUTH_USER_PASSWORD = "' + FAKE.dbPassword + '";\n',
      "app/image.bin": Buffer.concat([Buffer.from([0, 1, 2, 3]), Buffer.from(FAKE.upstage)]),
    });

    const result = scan(["--dir", "."], dir);

    expect(result.output).toContain("비밀값으로 보이는 값 없음");
    expect(result.status).toBe(0);
  });

  it("테스트 경로라도 형식이 분명한 공급자 키는 잡는다", () => {
    const dir = makeTempDir();
    writeFiles(dir, { "tests/fixture.env": "UPSTAGE_API_KEY=" + FAKE.upstage + "\n" });

    const result = scan(["--dir", "."], dir);

    expect(result.status).toBe(1);
    expect(result.output).toContain("tests/fixture.env:1  upstage-api-key");
  });

  it("canary 값이 산출물에 보이면 실패하고, --ext 로 고른 확장자만 보며, 빈 canary 는 설정 오류로 본다", () => {
    const dir = makeTempDir();
    const canary = "ci-canary-" + "7f3e9a1b";
    writeFiles(dir, { "chunks/a.js": 'var x="' + canary + '-rag";\n', "chunks/b.css": "body{}\n" });

    const leaked = scan(["--dir", ".", "--canary", canary], dir);
    expect(leaked.status).toBe(1);
    expect(leaked.output).toContain("chunks/a.js:1  canary  ci-c…(18자)");
    expect(leaked.output).not.toContain(canary);

    expect(scan(["--dir", ".", "--ext", "css", "--canary", canary], dir).status).toBe(0);
    expect(scan(["--dir", ".", "--canary", ""], dir).status).toBe(2);
    expect(scan(["--all", "--dir", "."], dir).status).toBe(2);
  });

  it.skipIf(!hasGit)("--diff 는 커밋마다 새로 넣은 줄을 보므로, 넣었다가 뒤 커밋에서 지운 값도 잡는다", SLOW, () => {
    const dir = makeTempDir();
    git(["init", "-q"], dir);
    // 사용자 설정이 경로 접두사를 바꿔도 경로를 제대로 읽는지 함께 본다.
    git(["config", "diff.noprefix", "true"], dir);
    writeFiles(dir, { "app.env": "APP=1\n" });
    git(["add", "."], dir);
    git(["commit", "-q", "-m", "base"], dir);
    const base = git(["rev-parse", "HEAD"], dir);
    writeFiles(dir, { "app.env": "APP=1\nSKT_API_KEY=" + FAKE.skt + "\n", "docs 문서/메모 파일.md": FAKE.openai + "\n" });
    git(["add", "."], dir);
    git(["commit", "-q", "-m", "leak"], dir);
    writeFiles(dir, { "app.env": "APP=1\n", "docs 문서/메모 파일.md": "정리함\n" });
    git(["commit", "-q", "-am", "cleanup"], dir);

    const result = scan(["--diff", base], dir);

    expect(git(["diff", base, "HEAD", "--", "app.env"], dir)).toBe("");
    expect(result.status).toBe(1);
    expect(result.output).toContain("app.env:2 (커밋 ");
    expect(result.output).toContain("secret-assignment SKT_API_KEY");
    expect(result.output).toContain("docs 문서/메모 파일.md:1 (커밋 ");
    expect(result.output).not.toContain(FAKE.skt);
    // 뒤 커밋에서 고쳐도 계속 걸리므로 앞 커밋을 고치라고 안내한다.
    expect(result.output).toContain("rebase·squash");
    expect(scan(["--diff", "HEAD~1"], dir).status).toBe(0);
    expect(scan(["--diff", "no-such-revision"], dir).status).toBe(2);
  });

  it.skipIf(!hasGit)("--outgoing 은 원격 추적 ref 에 없는 커밋을 병합 커밋까지 하나씩 본다", SLOW, () => {
    const dir = makeTempDir();
    git(["init", "-q"], dir);
    writeFiles(dir, { "app.env": "APP=1\n" });
    git(["add", "."], dir);
    git(["commit", "-q", "-m", "base"], dir);
    git(["update-ref", "refs/remotes/origin/main", "HEAD"], dir);
    // 곁가지를 병합하면서 병합 커밋에서만 비밀값을 넣는다.
    git(["checkout", "-q", "-b", "side"], dir);
    writeFiles(dir, { "side.txt": "side\n" });
    git(["add", "."], dir);
    git(["commit", "-q", "-m", "side"], dir);
    git(["checkout", "-q", "-"], dir);
    git(["merge", "-q", "--no-ff", "--no-commit", "side"], dir);
    writeFiles(dir, { "app.env": "APP=1\nSKT_API_KEY=" + FAKE.skt + "\n" });
    git(["add", "."], dir);
    git(["commit", "-q", "-m", "merge side"], dir);

    const result = scan(["--outgoing", "HEAD"], dir);

    expect(result.status).toBe(1);
    expect(result.output).toContain("app.env:2 (커밋 ");
    expect(result.output).toContain("원격 추적 ref 에 없는 커밋 2개");
    expect(result.output).not.toContain(FAKE.skt);
    // 원격에 이미 있는 커밋은 다시 보지 않는다.
    git(["update-ref", "refs/remotes/origin/main", "HEAD"], dir);
    expect(scan(["--outgoing", "HEAD"], dir).status).toBe(0);
    // 원격 추적 ref 가 없으면 첫 커밋부터 모두 본다.
    git(["update-ref", "-d", "refs/remotes/origin/main"], dir);
    const all = scan(["--outgoing", "HEAD"], dir);
    expect(all.status).toBe(1);
    expect(all.output).toContain("원격 추적 ref 에 없는 커밋 3개");
    expect(scan(["--outgoing", "HEAD", "--all"], dir).status).toBe(2);
  });
});

describe.skipIf(!hasGit || !hasSh)(".githooks/pre-push", () => {
  function hookRepo(): { dir: string; base: string } {
    const dir = makeTempDir();
    git(["init", "-q"], dir);
    mkdirSync(join(dir, "scripts"));
    mkdirSync(join(dir, ".githooks"));
    copyFileSync(SCANNER, join(dir, "scripts", "scan-secrets.mjs"));
    copyFileSync(HOOK, join(dir, ".githooks", "pre-push"));
    writeFiles(dir, { "app.env": "APP=1\n" });
    git(["add", "."], dir);
    git(["commit", "-q", "-m", "base"], dir);
    const base = git(["rev-parse", "HEAD"], dir);
    // 원격 main 이 base 에 있는 상황을 흉내 낸다.
    git(["update-ref", "refs/remotes/origin/main", base], dir);
    return { dir, base };
  }

  function commit(dir: string, content: string, message: string): string {
    writeFiles(dir, { "app.env": content });
    git(["commit", "-q", "-am", message], dir);
    return git(["rev-parse", "HEAD"], dir);
  }

  function prePush(dir: string, lines: string[], remote = "origin", url = "../remote.git"): RunResult {
    return run("sh", [join(dir, ".githooks", "pre-push"), remote, url], dir, lines.join("\n") + "\n");
  }

  it("새 브랜치에 비밀값이 든 커밋이 있으면 push 를 멈춘다", SLOW, () => {
    const { dir } = hookRepo();
    const leak = commit(dir, "APP=1\nSKT_API_KEY=" + FAKE.skt + "\n", "leak");

    const result = prePush(dir, [`refs/heads/feature ${leak} refs/heads/feature ${ZERO_SHA}`]);

    expect(result.status).toBe(1);
    expect(result.output).toContain("secret-assignment SKT_API_KEY");
    expect(result.output).toContain("push 를 멈췄습니다");
    expect(result.output).not.toContain(FAKE.skt);
  });

  it("이미 있는 원격 브랜치에 넣었다가 지운 값도 막는다", SLOW, () => {
    const { dir, base } = hookRepo();
    commit(dir, "APP=1\nRAG_INTERNAL_TOKEN=" + FAKE.internalToken + "\n", "leak");
    const cleaned = commit(dir, "APP=1\n", "cleanup");

    expect(prePush(dir, [`refs/heads/main ${cleaned} refs/heads/main ${base}`]).status).toBe(1);
  });

  it("추적 ref 가 없는 새 원격(포크·미러)이나 URL 로 push 해도 origin 을 기준으로 넣었다가 지운 값을 막는다", SLOW, () => {
    const { dir } = hookRepo();
    commit(dir, "APP=1\nSKT_API_KEY=" + FAKE.skt + "\n", "leak");
    const cleaned = commit(dir, "APP=1\n", "cleanup");
    const lines = [`refs/heads/feature ${cleaned} refs/heads/feature ${ZERO_SHA}`];
    const fork = "https://example.invalid/fork.git";

    const mirror = prePush(dir, lines, "mirror", "https://example.invalid/mirror.git");

    expect(mirror.status).toBe(1);
    expect(mirror.output).toContain("secret-assignment SKT_API_KEY");
    expect(mirror.output).not.toContain(FAKE.skt);
    expect(prePush(dir, lines, fork, fork).status).toBe(1);
  });

  it("원격 추적 ref 가 하나도 없으면 작업 트리가 아니라 push 되는 이력을 본다", SLOW, () => {
    const { dir } = hookRepo();
    git(["update-ref", "-d", "refs/remotes/origin/main"], dir);
    const mirror = ["mirror", "https://example.invalid/mirror.git"] as const;
    const clean = commit(dir, "APP=2\n", "clean");

    expect(prePush(dir, [`refs/heads/main ${clean} refs/heads/main ${ZERO_SHA}`], ...mirror).status).toBe(0);

    commit(dir, "APP=2\nRAG_INTERNAL_TOKEN=" + FAKE.internalToken + "\n", "leak");
    const cleaned = commit(dir, "APP=2\n", "cleanup");
    const result = prePush(dir, [`refs/heads/main ${cleaned} refs/heads/main ${ZERO_SHA}`], ...mirror);

    expect(result.status).toBe(1);
    expect(result.output).toContain("원격 추적 ref 에 없는 커밋을 모두 검사합니다");
    expect(result.output).toContain("secret-assignment RAG_INTERNAL_TOKEN");
  });

  it("깨끗한 push 와 브랜치 삭제는 통과시킨다", SLOW, () => {
    const { dir, base } = hookRepo();
    const clean = commit(dir, "APP=2\n", "clean");

    expect(prePush(dir, [`refs/heads/main ${clean} refs/heads/main ${base}`]).status).toBe(0);
    expect(prePush(dir, [`(delete) ${ZERO_SHA} refs/heads/old ${base}`]).status).toBe(0);
  });
});

describe.skipIf(!hasGit)("루트 .gitignore", () => {
  // 개발자 전역 ignore 가 결과를 바꾸지 않게 빈 파일로 바꾼다.
  const emptyExcludes = join(isolatedConfigDir, "empty-excludes");
  writeFileSync(emptyExcludes, "");

  function ignored(paths: string[]): string[] {
    const result = run("git", ["-c", `core.excludesFile=${emptyExcludes}`, "check-ignore", "--no-index", "--", ...paths], REPO_ROOT);
    return result.output.split("\n").filter(Boolean);
  }

  it("env 변형·편집기 백업·키 파일·실제 게이트웨이 설정은 무시한다", () => {
    const mustIgnore = [
      "product/.env.production",
      "product/.env.development",
      "db/.env.staging",
      "product/.env.local.bak",
      "db/.env.local~",
      "product/..env.local.swp",
      ".env.backup",
      ".env copy",
      "product/.env.example.bak",
      "infra/web.env.bak",
      "infra/web.env~",
      "infra/public-quota/public-gateway.env",
      "infra/public-quota/users.acl",
      "infra/server.pem",
      "infra/server.key",
      "id_rsa",
      "id_rsa.pub",
      "gcp-credentials.json",
      "service-account-prod.json",
      ".pgpass",
      ".npmrc",
      ".git-credentials",
    ];
    expect(ignored(mustIgnore)).toEqual(mustIgnore);
  });

  it("예시 파일과 이름이 비슷한 소스 파일은 계속 추적할 수 있다", () => {
    expect(
      ignored([
        "db/.env.example",
        "product/.env.example",
        "prototypes/hb/.env.example",
        "prototypes/jcu/.env.example",
        "infra/public-quota/public-gateway.env.example",
        "infra/public-quota/users.acl.example",
        "product/integrations/contract-api/config.example.env",
        "prototypes/csh/config.example.env",
        "product/src/server/envText.ts",
        "product/src/server/auth/passwordHash.ts",
        "prototypes/csh/scripts/check_env.py",
        // 이름에 .env. 가 든 소스 코드
        "foo.env.ts",
        "product/src/server/web.env.test.ts",
        "product/src/app/web.env.tsx",
        "product/scripts/load.env.mjs",
        "product/scripts/load.env.cjs",
        "prototypes/csh/scripts/check.env.py",
      ]),
    ).toEqual([]);
  });

  it("추적 중인 파일이 새로 무시 대상이 되지 않는다", () => {
    const result = run("git", ["-c", `core.excludesFile=${emptyExcludes}`, "ls-files", "-ci", "--exclude-standard"], REPO_ROOT);
    // prototypes/csh/CLAUDE.md 는 이번 변경 전부터 CLAUDE.md 규칙에 걸려 있던 파일이다.
    const unexpected = result.output.split("\n").filter((path) => path && path !== "prototypes/csh/CLAUDE.md");
    expect(unexpected).toEqual([]);
  });
});
